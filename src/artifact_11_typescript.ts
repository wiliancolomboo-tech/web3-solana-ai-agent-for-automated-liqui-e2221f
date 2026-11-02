import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import express from "express";
import client from "prom-client";
import dotenv from "dotenv";
import fs from "fs";

import { KineticEngine, CandleStick } from "./kineticEngine";
import { NotificationService } from "./notifications";
import { logger } from "./logger";

dotenv.config();

// Prometheus Metrics Instrumentation
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const rebalanceCounter = new client.Counter({
  name: "kinetic_agent_rebalances_total",
  help: "Total count of successfully executed automated rebalances",
  registers: [register],
});

const kineticScoreGauge = new client.Gauge({
  name: "kinetic_volatility_score",
  help: "Real-time computed kinetic energy score of the pool",
  registers: [register],
});

class KineticAgentRunner {
  private connection: Connection;
  private keypair: Keypair;
  private engine: KineticEngine;
  private notifier: NotificationService;
  private isProcessing: boolean = false;

  private mockCandleWindow: CandleStick[] = [];

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });

    const keyPath = process.env.KEEPER_KEYPAIR_PATH || "./keeper-keypair.json";
    const secretKey = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
    this.keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

    this.engine = new KineticEngine(64, 256, 2048);
    this.notifier = new NotificationService();

    logger.info("Kinetic Agent initialized with Keeper Address", {
      pubkey: this.keypair.publicKey.toBase58(),
    });
  }

  public seedMockCandle(price: number): void {
    const now = Date.now();
    const candle: CandleStick = {
      open: price * 0.9995,
      high: price * 1.002,
      low: price * 0.998,
      close: price,
      timestamp: now,
    };
    this.mockCandleWindow.push(candle);
    if (this.mockCandleWindow.length > 30) {
      this.mockCandleWindow.shift();
    }
  }

  public async evaluateAndRebalance(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Mocked live price tick data for demonstration
      const simulatedPrice = 145.5 + (Math.random() - 0.49) * 2.5;
      this.seedMockCandle(simulatedPrice);

      const currentTick = Math.floor(Math.log(simulatedPrice / 100) / Math.log(1.0001));
      const activeLowerTick = currentTick - 320;
      const activeUpperTick = currentTick + 320;

      const analysis = this.engine.evaluate(
        this.mockCandleWindow,
        currentTick,
        activeLowerTick,
        activeUpperTick
      );

      kineticScoreGauge.set(analysis.kineticEnergyScore);

      logger.info("Tick & Kinetic Analysis Checked", {
        currentTick,
        kineticScore: analysis.kineticEnergyScore,
        halfWidth: analysis.recommendedHalfWidthTicks,
        isBreached: analysis.isBreached,
      });

      // Condition for triggering rebalance
      if (analysis.isBreached || analysis.kineticEnergyScore > 25.0) {
        logger.warn("Rebalance condition triggered. Computing target ticks...");

        const alignedTick = Math.round(currentTick / 64) * 64;
        const newLowerTick = alignedTick - analysis.recommendedHalfWidthTicks;
        const newUpperTick = alignedTick + analysis.recommendedHalfWidthTicks;

        const fakeSignature = "4uEzG4W" + Math.random().toString(36).substring(2, 15) + "KINETIC_MOCK_SIG";
        rebalanceCounter.inc();

        logger.info("Rebalance successfully executed", {
          tx: fakeSignature,
          newLowerTick,
          newUpperTick,
        });

        await this.notifier.broadcastRebalance({
          poolName: "SOL/USDC [Orca Whirlpool 0.04%]",
          signature: fakeSignature,
          oldLowerTick: activeLowerTick,
          oldUpperTick: activeUpperTick,
          newLowerTick,
          newUpperTick,
          kineticScore: analysis.kineticEnergyScore,
          estSlot: await this.connection.getSlot(),
        });
      }
    } catch (err: any) {
      logger.error("Error in kinetic loop execution", { error: err.message });
    } finally {
      this.isProcessing = false;
    }
  }

  public startDaemon(intervalMs: number = 5000): void {
    logger.info(`Starting Kinetic Engine Autonomous Daemon loop (${intervalMs}ms)...`);
    setInterval(() => this.evaluateAndRebalance(), intervalMs);
  }
}

// Microservice HTTP Endpoints for Cloud Probes & Prometheus
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "healthy", timestamp: Date.now() });
});

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

app.listen(PORT, () => {
  logger.info(`Operational and Metrics Server running on port ${PORT}`);
  const runner = new KineticAgentRunner();
  runner.startDaemon(4000);
});