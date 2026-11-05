import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl } from "@coral-xyz/anchor";
import axios from "axios";
import { Resend } from "resend";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// Configuration Interface
interface AgentConfig {
  solanaRpcUrl: string;
  jitoBlockEngineUrl: string;
  jitoTipAccount: string;
  vaultProgramId: string;
  resendApiKey: string;
  alertEmailTo: string;
  discordWebhookUrl: string;
  poolAddress: string;
  agentKeypairPath: string;
  minKineticThreshold: number;
}

interface PriceBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class KineticLiquidityAgent {
  private connection: Connection;
  private agentKeypair: Keypair;
  private resend: Resend;
  private config: AgentConfig;
  private priceHistory: PriceBar[] = [];
  private currentLowerTick: number = 0;
  private currentUpperTick: number = 0;

  constructor(config: AgentConfig) {
    this.config = config;
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
    const secretKey = JSON.parse(fs.readFileSync(config.agentKeypairPath, "utf-8"));
    this.agentKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    this.resend = new Resend(config.resendApiKey);
  }

  /**
   * Computes Garman-Klass High-Low Normalized Volatility
   * sigma = sqrt( (1/N) * sum( 0.5 * (ln(H/L))^2 - (2*ln(2) - 1) * (ln(C/O))^2 ) )
   */
  public calculateGarmanKlassVolatility(bars: PriceBar[]): number {
    if (bars.length < 5) return 0.02; // Default fallback: 2%
    let sum = 0;
    const constTerm = 2 * Math.log(2) - 1;

    for (const b of bars) {
      const hl = Math.log(b.high / b.low);
      const co = Math.log(b.close / b.open);
      sum += 0.5 * Math.pow(hl, 2) - constTerm * Math.pow(co, 2);
    }
    return Math.sqrt(sum / bars.length);
  }

  /**
   * Evaluates Price Kinematics:
   * v(t) = d(ln P) / dt (Velocity)
   * a(t) = d(v) / dt    (Acceleration)
   * Kinetic Energy E_k = 0.5 * v^2
   */
  public computeKineticIndicators(bars: PriceBar[]): {
    velocity: number;
    acceleration: number;
    kineticEnergy: number;
    volatility: number;
  } {
    const n = bars.length;
    if (n < 3) {
      return { velocity: 0, acceleration: 0, kineticEnergy: 0, volatility: 0.01 };
    }

    const pCurrent = bars[n - 1].close;
    const pPrev1 = bars[n - 2].close;
    const pPrev2 = bars[n - 3].close;

    const dt = 1.0; // 1-slot or 1-interval standardized unit
    const vCurrent = (Math.log(pCurrent) - Math.log(pPrev1)) / dt;
    const vPrev = (Math.log(pPrev1) - Math.log(pPrev2)) / dt;
    const acceleration = (vCurrent - vPrev) / dt;
    const kineticEnergy = 0.5 * Math.pow(vCurrent, 2) * 1e8; // scaled integer representation
    const volatility = this.calculateGarmanKlassVolatility(bars);

    return {
      velocity: vCurrent,
      acceleration,
      kineticEnergy,
      volatility,
    };
  }

  /**
   * Converts continuous price to concentrated liquidity ticks
   */
  public priceToTick(price: number, tickSpacing: number = 64): number {
    const tick = Math.round(Math.log(price) / Math.log(1.0001));
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }

  /**
   * Evaluates if concentrated bounds need kinetic rebalancing
   */
  public shouldRebalance(
    currentPrice: number,
    kinetics: { velocity: number; acceleration: number; kineticEnergy: number; volatility: number }
  ): { trigger: boolean; targetLower: number; targetUpper: number } {
    const tickSpacing = 64;
    const currentTick = this.priceToTick(currentPrice, tickSpacing);

    const isOutOfRange =
      this.currentLowerTick === 0 ||
      currentTick <= this.currentLowerTick ||
      currentTick >= this.currentUpperTick;

    // Regulate rebalance: Only rebalance when acceleration indicates exhaustion (a <= 0 if upward, a >= 0 if downward)
    const isExhausting =
      (kinetics.velocity > 0 && kinetics.acceleration <= 0) ||
      (kinetics.velocity < 0 && kinetics.acceleration >= 0) ||
      Math.abs(kinetics.velocity) < 0.0005;

    if (isOutOfRange && isExhausting) {
      // Dynamic asymmetric spread based on volatility
      const halfBandPercent = Math.max(0.015, kinetics.volatility * 1.5);
      const lowerPrice = currentPrice * (1 - halfBandPercent);
      const upperPrice = currentPrice * (1 + halfBandPercent);

      const targetLower = this.priceToTick(lowerPrice, tickSpacing);
      const targetUpper = this.priceToTick(upperPrice, tickSpacing);

      return { trigger: true, targetLower, targetUpper };
    }

    return { trigger: false, targetLower: 0, targetUpper: 0 };
  }

  /**
   * Sends Jito-Bundled Rebalance Instruction
   */
  public async executeJitoRebalance(
    vaultPda: PublicKey,
    targetLowerTick: number,
    targetUpperTick: number,
    kineticEnergy: number
  ): Promise<string> {
    const programId = new PublicKey(this.config.vaultProgramId);
    
    // Construct dummy discriminator & instruction data for execute_rebalance
    const layoutBuffer = Buffer.alloc(8 + 4 + 4 + 2 + 8);
    // Anchor sighash for 'global:execute_rebalance'
    const sighash = Buffer.from([226, 94, 219, 134, 18, 169, 194, 188]); 
    sighash.copy(layoutBuffer, 0);
    layoutBuffer.writeInt32LE(targetLowerTick, 8);
    layoutBuffer.writeInt32LE(targetUpperTick, 12);
    layoutBuffer.writeUInt16LE(50, 16); // 50 bps price impact cap
    layoutBuffer.writeBigUInt64LE(BigInt(Math.floor(kineticEnergy)), 18);

    const rebalanceIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: this.agentKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: layoutBuffer,
    });

    // Add Jito tip transfer
    const tipAccount = new PublicKey(this.config.jitoTipAccount);
    const tipIx = new TransactionInstruction({
      programId: new PublicKey("11111111111111111111111111111111"),
      keys: [
        { pubkey: this.agentKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: tipAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([2, 0, 0, 0, 100, 0, 0, 0]), // Transfer lamports (100 lamports minimal demo)
    });

    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: this.agentKeypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [rebalanceIx, tipIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([this.agentKeypair]);

    const serializedTx = Buffer.from(tx.serialize()).toString("base64");

    // Post to Jito Block Engine
    const jitoResponse = await axios.post(
      `${this.config.jitoBlockEngineUrl}/api/v1/bundles`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [[serializedTx]],
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const bundleId = jitoResponse.data.result;

    this.currentLowerTick = targetLowerTick;
    this.currentUpperTick = targetUpperTick;

    // Send notifications to enterprise alerts
    await this.dispatchEnterpriseAlerts(
      bundleId,
      targetLowerTick,
      targetUpperTick,
      kineticEnergy
    );

    return bundleId;
  }

  /**
   * Enterprise Multi-Channel Dispatch (Discord + Resend)
   */
  private async dispatchEnterpriseAlerts(
    bundleId: string,
    lower: number,
    upper: number,
    kineticEnergy: number
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const details = `\n- Bundle ID: ${bundleId}\n- New Tick Range: [${lower}, ${upper}]\n- Kinetic Energy: ${kineticEnergy.toFixed(
      2
    )}\n- Timestamp: ${timestamp}`;

    // 1. Resend Email Dispatch
    try {
      if (this.config.resendApiKey && this.config.alertEmailTo) {
        await this.resend.emails.send({
          from: "kinetix-alerts@solana.enterprise",
          to: this.config.alertEmailTo,
          subject: `[EXECUTION] KinetiX Liquidity Rebalance: Bundle ${bundleId.slice(0, 8)}`,
          text: `Autonomous rebalance event executed on-chain via Jito Block Engine.${details}`,
        });
      }
    } catch (err) {
      console.error("[ALERT] Failed sending Resend email notification:", err);
    }

    // 2. Discord Webhook Dispatch
    try {
      if (this.config.discordWebhookUrl) {
        await axios.post(this.config.discordWebhookUrl, {
          username: "KinetiX Bot Sentinel",
          embeds: [
            {
              title: "⚡ Autonomous Kinetic Rebalance Executed",
              color: 0x14f195, // Solana Green
              fields: [
                { name: "Bundle ID", value: bundleId, inline: false },
                { name: "Lower Tick", value: lower.toString(), inline: true },
                { name: "Upper Tick", value: upper.toString(), inline: true },
                { name: "Kinetic Metric", value: kineticEnergy.toFixed(4), inline: true },
              ],
              footer: { text: "Solana Autonomous Liquidity Rebalancing" },
              timestamp,
            },
          ],
        });
      }
    } catch (err) {
      console.error("[ALERT] Failed posting Discord webhook:", err);
    }
  }

  /**
   * Worker Loop
   */
  public async startWorkerLoop(vaultPda: PublicKey, pollIntervalMs: number = 2000): Promise<void> {
    console.log(`[AGENT] KinetiX Agent listening on pool: ${this.config.poolAddress}`);
    console.log(`[AGENT] Delegate pubkey: ${this.agentKeypair.publicKey.toBase58()}`);

    // Mock price seed for demonstrator loop
    let simulatedPrice = 142.5;

    setInterval(async () => {
      try {
        // Price simulation with stochastic volatility
        const delta = (Math.random() - 0.495) * 0.8;
        simulatedPrice += delta;

        const mockBar: PriceBar = {
          timestamp: Date.now(),
          open: simulatedPrice - 0.2,
          high: simulatedPrice + 0.5,
          low: simulatedPrice - 0.5,
          close: simulatedPrice,
          volume: 12000 + Math.random() * 5000,
        };

        this.priceHistory.push(mockBar);
        if (this.priceHistory.length > 50) this.priceHistory.shift();

        const kinetics = this.computeKineticIndicators(this.priceHistory);
        const decision = this.shouldRebalance(simulatedPrice, kinetics);

        console.log(
          `[TICK] Price: $${simulatedPrice.toFixed(2)} | Vol: ${(
            kinetics.volatility * 100
          ).toFixed(2)}% | E_k: ${kinetics.kineticEnergy.toFixed(2)} | Rebalance: ${decision.trigger}`
        );

        if (decision.trigger) {
          console.log("[AGENT] Kinetic exhaustion triggered. Sending rebalance bundle...");
          const bundle = await this.executeJitoRebalance(
            vaultPda,
            decision.targetLower,
            decision.targetUpper,
            kinetics.kineticEnergy
          );
          console.log(`[AGENT] Successfully relayed bundle: ${bundle}`);
        }
      } catch (loopErr) {
        console.error("[ERROR] Execution loop error:", loopErr);
      }
    }, pollIntervalMs);
  }
}

// Direct Execution CLI Entrypoint
if (require.main === module) {
  const agent = new KineticLiquidityAgent({
    solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    jitoBlockEngineUrl:
      process.env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf",
    jitoTipAccount:
      process.env.JITO_TIP_ACCOUNT || "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    vaultProgramId:
      process.env.VAULT_PROGRAM_ID || "KntxVa1111111111111111111111111111111111111",
    resendApiKey: process.env.RESEND_API_KEY || "re_mock_test_key",
    alertEmailTo: process.env.ALERT_EMAIL || "quant-ops@enterprise.xyz",
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
    poolAddress:
      process.env.TARGET_POOL_ADDRESS || "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    agentKeypairPath: process.env.AGENT_KEYPAIR_PATH || "./keypair.json",
    minKineticThreshold: 1.5,
  });

  const dummyVault = new PublicKey("7n8V4QyV3wL4oM8gV7gVbEwNf7j3c8tYh2m8sWq1p9Rt");
  agent.startWorkerLoop(dummyVault, 3000);
}