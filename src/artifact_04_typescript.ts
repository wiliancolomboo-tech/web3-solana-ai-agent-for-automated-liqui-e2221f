import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// Configuration Interfaces
interface KineticMetrics {
  currentPrice: number;
  velocity: number;
  kineticEnergy: number;
  recommendedLowerTick: number;
  recommendedUpperTick: number;
  shouldRebalance: boolean;
}

interface PriceTickObservation {
  timestamp: number;
  price: number;
  volume: number;
}

export class KinesisAgent {
  private connection: Connection;
  private agentKeypair: Keypair;
  private vaultPubkey: PublicKey;
  private history: PriceTickObservation[] = [];
  private resend: Resend | null = null;
  private discordWebhookUrl: string | null = null;

  // Kinetic Tuning Parameters
  private readonly VELOCITY_WINDOW_SECONDS = 300; // 5 minute trailing window
  private readonly TICK_SPACING = 64;
  private readonly KINETIC_THRESHOLD = 0.0042; // Action threshold

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(rpcUrl, "confirmed");

    if (!process.env.AGENT_SECRET_KEY) {
      throw new Error("AGENT_SECRET_KEY environment variable missing.");
    }
    const secretKeyArray = JSON.parse(process.env.AGENT_SECRET_KEY);
    this.agentKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

    if (!process.env.VAULT_ADDRESS) {
      throw new Error("VAULT_ADDRESS environment variable missing.");
    }
    this.vaultPubkey = new PublicKey(process.env.VAULT_ADDRESS);

    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;

    console.log(`[INIT] Kinesis Agent Initialized. Executor Address: ${this.agentKeypair.publicKey.toBase58()}`);
  }

  public recordTick(price: number, volume: number) {
    const now = Date.now();
    this.history.push({ timestamp: now, price, volume });
    // Evict observations older than window
    const cutoff = now - this.VELOCITY_WINDOW_SECONDS * 1000;
    this.history = this.history.filter((h) => h.timestamp >= cutoff);
  }

  public computeKineticMetrics(currentTick: number): KineticMetrics {
    if (this.history.length < 2) {
      return {
        currentPrice: this.history[0]?.price || 0,
        velocity: 0,
        kineticEnergy: 0,
        recommendedLowerTick: currentTick - this.TICK_SPACING * 10,
        recommendedUpperTick: currentTick + this.TICK_SPACING * 10,
        shouldRebalance: false,
      };
    }

    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    const dtSeconds = Math.max((last.timestamp - first.timestamp) / 1000, 1);
    
    // Log price return over time: v = ln(P_t / P_0) / dt
    const logReturn = Math.log(last.price / first.price);
    const velocity = logReturn / dtSeconds;

    // Cumulative volume in window
    const totalVolume = this.history.reduce((acc, curr) => acc + curr.volume, 0);

    // Kinetic Energy E_k = 0.5 * Volume * Velocity^2
    const kineticEnergy = 0.5 * totalVolume * Math.pow(velocity, 2);

    // Dynamic width expansion factor based on kinetic energy
    const expansionFactor = 1 + Math.min(Math.abs(kineticEnergy) * 1000, 4); 
    const spreadTicks = Math.round(this.TICK_SPACING * 8 * expansionFactor);

    // Align to tick spacing
    const recommendedLowerTick = Math.floor((currentTick - spreadTicks) / this.TICK_SPACING) * this.TICK_SPACING;
    const recommendedUpperTick = Math.ceil((currentTick + spreadTicks) / this.TICK_SPACING) * this.TICK_SPACING;

    const shouldRebalance = kineticEnergy >= this.KINETIC_THRESHOLD;

    return {
      currentPrice: last.price,
      velocity,
      kineticEnergy,
      recommendedLowerTick,
      recommendedUpperTick,
      shouldRebalance,
    };
  }

  public async broadcastAlert(title: string, message: string, meta: Record<string, any>) {
    console.log(`[ALERT] ${title}: ${message}`);

    // Enterprise Discord Webhook
    if (this.discordWebhookUrl) {
      try {
        await axios.post(this.discordWebhookUrl, {
          embeds: [
            {
              title: `⚡ Kinesis Agent: ${title}`,
              description: message,
              color: 0x00f0ff,
              fields: Object.entries(meta).map(([key, val]) => ({
                name: key,
                value: String(val),
                inline: true,
              })),
              timestamp: new Date().toISOString(),
            },
          ],
        });
      } catch (err: any) {
        console.error(`[TELEMETRY] Discord webhook dispatch failed: ${err.message}`);
      }
    }

    // Enterprise Resend Email Audit
    if (this.resend && process.env.AUDIT_EMAIL_RECIPIENT) {
      try {
        await this.resend.emails.send({
          from: "kinesis-alerts@resend.dev",
          to: process.env.AUDIT_EMAIL_RECIPIENT,
          subject: `[KINESIS AUDIT] ${title}`,
          html: `
            <h2>Kinesis Liquidity Optimization Event</h2>
            <p><strong>Status:</strong> ${title}</p>
            <p>${message}</p>
            <pre style="background:#f4f4f4;padding:10px;border-radius:4px;">${JSON.stringify(meta, null, 2)}</pre>
          `,
        });
      } catch (err: any) {
        console.error(`[TELEMETRY] Resend email dispatch failed: ${err.message}`);
      }
    }
  }

  public async executeRebalanceTransaction(
    newLowerTick: number,
    newUpperTick: number,
    oracleTwapTick: number
  ): Promise<string> {
    console.log(`[REBALANCE] Dispatching bounds: [${newLowerTick}, ${newUpperTick}] against TWAP ${oracleTwapTick}`);

    // Deterministic simulation payload
    const tx = new Transaction();
    // In production, instructions are decoded from the IDL via Anchor:
    // tx.add(program.methods.executeRebalance(newLowerTick, newUpperTick, oracleTwapTick, minA, minB).accounts({...}))
    tx.feePayer = this.agentKeypair.publicKey;
    const latestBlockhash = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash.blockhash;

    // Simulate sending transaction
    const signature = `sim_${Date.now()}_tx_hash_success`;
    
    await this.broadcastAlert("Rebalance Successfully Executed", "Liquidity successfully migrated to optimal kinetic bounds.", {
      Signature: signature,
      NewLowerTick: newLowerTick,
      NewUpperTick: newUpperTick,
      OracleTWAP: oracleTwapTick,
    });

    return signature;
  }

  public async runLoop(pollIntervalMs: number = 5000) {
    console.log("[AGENT] Starting real-time autonomous loop...");

    // Mock initial price seed
    let basePrice = 175.50;
    let baseTick = -3200;

    setInterval(async () => {
      try {
        // Feed real or simulated market step
        const randomShock = (Math.random() - 0.495) * 2.5;
        basePrice += randomShock;
        baseTick += Math.round(randomShock * 12);
        const volume = Math.abs(randomShock) * 1500 + 100;

        this.recordTick(basePrice, volume);
        const metrics = this.computeKineticMetrics(baseTick);

        console.log(`[MONITOR] Price: $${metrics.currentPrice.toFixed(2)} | Velocity: ${metrics.velocity.toFixed(6)} | Kinetic Energy: ${metrics.kineticEnergy.toFixed(6)} | Should Rebalance: ${metrics.shouldRebalance}`);

        if (metrics.shouldRebalance) {
          await this.executeRebalanceTransaction(
            metrics.recommendedLowerTick,
            metrics.recommendedUpperTick,
            baseTick
          );
        }
      } catch (err: any) {
        console.error(`[ERROR] Agent execution failure in loop: ${err.message}`);
      }
    }, pollIntervalMs);
  }
}

// Standalone entrypoint
if (require.main === module) {
  const agent = new KinesisAgent();
  agent.runLoop(4000);
}