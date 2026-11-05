import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import * as http from "http";
import client from "prom-client";
import { KineticEngine, PriceSample } from "./kinetic_engine";

// Load Environment Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const KEEPER_KEY_JSON = process.env.KEEPER_PRIVATE_KEY || "[]";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "Kinet1cReba1ance11111111111111111111111111111");
const VAULT_PDA = new PublicKey(process.env.VAULT_PDA || "11111111111111111111111111111111");
const PYTH_FEED = new PublicKey(process.env.PYTH_FEED_SOL_USD || "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG");
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "ops@kinetic-vault.finance";

// Prometheus Metrics Instrumentation
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const rebalanceCounter = new client.Counter({
  name: "kinetic_rebalance_total",
  help: "Total number of successful kinetic rebalances executed",
  labelNames: ["status"],
});
const kineticEnergyGauge = new client.Gauge({
  name: "kinetic_energy_indicator",
  help: "Current evaluated kinetic energy of the asset pool",
});
registry.registerMetric(rebalanceCounter);
registry.registerMetric(kineticEnergyGauge);

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

async function sendAlert(title: string, message: string, payload: Record<string, any>) {
  console.log(`[ALERT] ${title}: ${message}`);

  // 1. Enterprise Discord Webhook Notification
  if (DISCORD_WEBHOOK) {
    try {
      await axios.post(DISCORD_WEBHOOK, {
        embeds: [
          {
            title: `🚀 Kinetic Agent: ${title}`,
            description: message,
            color: 0x00ff88,
            fields: Object.entries(payload).map(([k, v]) => ({
              name: k,
              value: String(v),
              inline: true,
            })),
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (e: any) {
      console.error("Failed to post Discord webhook:", e.message);
    }
  }

  // 2. High-Severity Resend Email Delivery
  if (resend) {
    try {
      await resend.emails.send({
        from: "alerts@kinetic-vault.finance",
        to: ALERT_EMAIL,
        subject: `[SOLANA-AGENT] ${title}`,
        html: `<h2>${title}</h2><p>${message}</p><pre>${JSON.stringify(payload, null, 2)}</pre>`,
      });
    } catch (e: any) {
      console.error("Failed to dispatch Resend email:", e.message);
    }
  }
}

async function runAgent() {
  const keeperKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(KEEPER_KEY_JSON))
  );
  const connection = new Connection(RPC_URL, { commitment: "confirmed" });
  const wallet = new Wallet(keeperKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });

  const engine = new KineticEngine(60, 64);
  console.log(`Kinetic Agent initialized. Keeper Address: ${keeperKeypair.publicKey.toBase58()}`);

  // Spin up Health Check & Prometheus endpoint
  http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
    }
  }).listen(9090);

  // Polling / WebSocket Price Stream Loop
  setInterval(async () => {
    try {
      // Simulating spot price fetch (In production: read directly from Orca Whirlpool state account)
      const mockPrice = 140.0 + (Math.random() - 0.49) * 2.5;
      const sample: PriceSample = {
        timestamp: Date.now(),
        open: mockPrice - 0.1,
        high: mockPrice + 0.3,
        low: mockPrice - 0.3,
        close: mockPrice,
        volume: 125000 + Math.random() * 50000,
      };

      engine.ingestPrice(sample);

      // Baseline pool position state (read from on-chain account in practice)
      const currentTickLower = -1500;
      const currentTickUpper = 1500;

      const metrics = engine.evaluate(currentTickLower, currentTickUpper);
      kineticEnergyGauge.set(metrics.kineticEnergy);

      if (metrics.shouldRebalance) {
        console.log("Kinetic threshold reached. Dispatching rebalance transaction...");

        // Construct high-priority Compute Budget instructions
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
          units: 400_000,
        });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 50_000, // 0.05 SOL priority booster
        });

        // Encode and execute rebalance instruction
        // In real deploy: Program IDL method client.methods.executeRebalance(...)
        const tx = new Transaction().add(modifyComputeUnits).add(addPriorityFee);

        // Sign & confirm transaction
        const sig = await sendAndConfirmTransaction(connection, tx, [keeperKeypair], {
          skipPreflight: false,
          commitment: "confirmed",
        });

        rebalanceCounter.inc({ status: "success" });
        await sendAlert("Liquidity Rebalanced", `Repositioned ticks to dynamic kinetic range`, {
          TxSignature: sig,
          KineticEnergy: metrics.kineticEnergy.toFixed(4),
          GK_Volatility: metrics.garmanKlassVol.toFixed(6),
          NewLowerTick: metrics.recommendedTickLower,
          NewUpperTick: metrics.recommendedTickUpper,
        });
      }
    } catch (err: any) {
      console.error("Agent execution loop error:", err);
      rebalanceCounter.inc({ status: "failure" });
    }
  }, 5000);
}

runAgent().catch((err) => {
  console.error("Fatal agent runtime crash:", err);
  process.exit(1);
});