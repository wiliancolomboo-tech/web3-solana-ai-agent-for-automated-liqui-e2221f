// keeper/agent.ts

import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { KinetixRebalancer } from "../target/types/kinetix_rebalancer";
import * as fs from "fs";

interface PriceBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class KineticEngine {
  private history: PriceBar[] = [];
  private readonly maxWindow: number = 60; // 60 seconds rolling window

  public pushBar(bar: PriceBar) {
    this.history.push(bar);
    if (this.history.length > this.maxWindow) {
      this.history.shift();
    }
  }

  /**
   * Calculates Parkinson Extreme Value Volatility
   * sigma = sqrt( 1 / (4 * ln(2) * N) * sum( (ln(H_i / L_i))^2 ) )
   */
  public computeParkinsonVolatility(): number {
    const n = this.history.length;
    if (n < 2) return 0.0;

    let sumSquares = 0.0;
    for (const bar of this.history) {
      if (bar.low <= 0 || bar.high <= 0) continue;
      const ratio = Math.log(bar.high / bar.low);
      sumSquares += ratio * ratio;
    }
    const factor = 1.0 / (4.0 * Math.LN2 * n);
    return Math.sqrt(factor * sumSquares);
  }

  /**
   * Calculates Instantaneous Velocity v(t) = d(ln S) / dt
   * and Acceleration a(t) = dv / dt
   */
  public computeKinematics(): { velocity: number; acceleration: number; kineticEnergy: number } {
    const n = this.history.length;
    if (n < 3) return { velocity: 0, acceleration: 0, kineticEnergy: 0 };

    const pCurrent = this.history[n - 1].close;
    const pPrev1 = this.history[n - 2].close;
    const pPrev2 = this.history[n - 3].close;

    const dt = 1.0; // 1 second micro-epochs
    const v1 = (Math.log(pCurrent) - Math.log(pPrev1)) / dt;
    const v0 = (Math.log(pPrev1) - Math.log(pPrev2)) / dt;
    const acceleration = (v1 - v0) / dt;

    // Mass proxy: instantaneous volume * vwap weight
    const mass = Math.max(1.0, Math.sqrt(this.history[n - 1].volume));
    const kineticEnergy = 0.5 * mass * (v1 * v1);

    return { velocity: v1, acceleration, kineticEnergy };
  }

  /**
   * Computes Dynamic Asymmetric Tick Bounds based on Kinetic Indicators
   */
  public computeOptimalTickBands(
    currentTick: number,
    tickSpacing: number
  ): { lowerTick: number; upperTick: number; kineticMetric: number } {
    const { velocity, acceleration, kineticEnergy } = this.computeKinematics();
    const parkinsonVol = this.computeParkinsonVolatility();

    const baseSpanTicks = 60 * tickSpacing; // Default static width
    const kineticMetric = kineticEnergy * 1000 + parkinsonVol * 500;

    // Expansion coefficient based on kinetic energy
    const alpha = 1.8;
    const dynamicSpan = Math.floor(baseSpanTicks * (1 + alpha * kineticMetric));

    // Directional skew factor: If momentum and acceleration align, skew bounds
    const skewFactor = velocity * acceleration > 0 ? Math.sign(velocity) * 0.35 : 0;

    const lowerOffset = Math.floor(dynamicSpan * (0.5 - skewFactor));
    const upperOffset = Math.floor(dynamicSpan * (0.5 + skewFactor));

    let lowerTick = Math.floor((currentTick - lowerOffset) / tickSpacing) * tickSpacing;
    let upperTick = Math.floor((currentTick + upperOffset) / tickSpacing) * tickSpacing;

    if (lowerTick >= upperTick) {
      upperTick = lowerTick + tickSpacing * 10;
    }

    return { lowerTick, upperTick, kineticMetric };
  }
}

// -----------------------------------------------------------------------------
// Autonomous Agent Runner
// -----------------------------------------------------------------------------
async function runKeeperDaemon() {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
    "confirmed"
  );
  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.KEEPER_KEYPAIR_PATH || "keeper-keypair.json", "utf-8"))
  );
  const keeperKeypair = Keypair.fromSecretKey(secretKey);
  const wallet = new Wallet(keeperKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.KinetixRebalancer as Program<KinetixRebalancer>;
  const engine = new KineticEngine();

  console.log(`[KinetiX Agent] Initialized. Keeper: ${keeperKeypair.publicKey.toBase58()}`);

  const poolAddress = new PublicKey(process.env.POOL_ADDRESS!);
  const pythOracleAddress = new PublicKey(process.env.PYTH_ORACLE_FEED!);

  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [registryPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), poolAddress.toBuffer(), keeperKeypair.publicKey.toBuffer()],
    program.programId
  );
  const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_auth"), registryPDA.toBuffer()],
    program.programId
  );

  // Heartbeat Telemetry Loop
  setInterval(async () => {
    try {
      // Simulate/ingest realtime market bar (e.g. from Orca WebSocket / Pyth)
      const mockPrice = 145.2 + (Math.random() - 0.49) * 1.5;
      engine.pushBar({
        timestamp: Date.now(),
        open: mockPrice - 0.1,
        high: mockPrice + 0.3,
        low: mockPrice - 0.3,
        close: mockPrice,
        volume: 125000 + Math.random() * 50000,
      });

      const currentTick = -20480; // Sample tick for SOL/USDC at ~145
      const tickSpacing = 64;
      const { lowerTick, upperTick, kineticMetric } = engine.computeOptimalTickBands(
        currentTick,
        tickSpacing
      );

      console.log(
        `[Kinetic Telemetry] Energy: ${kineticMetric.toFixed(4)} | Targets: [${lowerTick}, ${upperTick}]`
      );

      // Trigger condition: High kinetic metric or bounds breached
      if (kineticMetric > 0.05) {
        console.log(`[ALERT] Kinetic indicator crossed threshold. Executing Rebalance CPI...`);

        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 50_000, // Dynamic high-priority MEV protection
        });
        const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
          units: 200_000,
        });

        const tx = await program.methods
          .executeKineticRebalance({
            newTickLower: lowerTick,
            newTickUpper: upperTick,
            targetSqrtPriceX64: new anchor.BN("18446744073709551616"), // 1.0 in Q64.64
            kineticEnergyRaw: new anchor.BN(Math.floor(kineticMetric * 1000)),
            minTokenAOut: new anchor.BN(100),
            minTokenBOut: new anchor.BN(100),
          })
          .accounts({
            config: configPDA,
            positionRegistry: registryPDA,
            vaultAuthority: vaultAuthorityPDA,
            vaultTokenA: new PublicKey(process.env.VAULT_TOKEN_A!),
            vaultTokenB: new PublicKey(process.env.VAULT_TOKEN_B!),
            pythOraclePriceFeed: pythOracleAddress,
            keeper: keeperKeypair.publicKey,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          })
          .preInstructions([priorityFeeIx, computeLimitIx])
          .transaction();

        const txSig = await sendAndConfirmTransaction(connection, tx, [keeperKeypair]);
        console.log(`[SUCCESS] Rebalance confirmed on-chain! TxSig: ${txSig}`);
      }
    } catch (err: any) {
      console.error(`[Execution Error]: ${err.message}`);
    }
  }, 3000);
}

if (require.main === module) {
  runKeeperDaemon().catch(console.error);
}