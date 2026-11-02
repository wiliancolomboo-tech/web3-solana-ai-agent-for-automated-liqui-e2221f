import { PublicKey } from "@solana/web3.js";
import { RebalancerAgent } from "./agent/rebalancer_agent";

async function main() {
  console.log("====================================================");
  console.log("  Solana Kinetic Volatility CLMM Autonomous Agent   ");
  console.log("====================================================");

  const initialPositionMintStr = process.env.INITIAL_POSITION_MINT;
  if (!initialPositionMintStr) {
    throw new Error("Missing INITIAL_POSITION_MINT in environment variables");
  }

  const agent = new RebalancerAgent();
  await agent.initialize(new PublicKey(initialPositionMintStr));

  process.on("SIGINT", () => {
    console.log("\n[Agent] Terminating cleanly...");
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal Agent Loop Error:", err);
    process.exit(1);
  });
}