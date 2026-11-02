# 1. Export Environment Configurations
export SOLANA_RPC_URL="http://127.0.0.1:8899"
export AGENT_KEYPAIR_PATH="./id.json"
export CLMM_POOL_ADDRESS="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"

# 2. Run the Autonomous Monitoring Loop
npx ts-node agent/kinetic_agent.ts