# 1. Environment Configuration
cp .env.example .env
# Edit .env with your high-speed RPC and alert webhooks:
# SOLANA_RPC_URL=https://your-dedicated-solana-rpc.com
# RESEND_API_KEY=re_xxxxxxxxxxxx
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# 2. Build and Test Smart Contract Program
anchor build
anchor test

# 3. Deploy Smart Contract to Solana Devnet / Mainnet
anchor deploy --provider.cluster devnet --program-keypair target/deploy/kinetic_rebalancer-keypair.json

# 4. Launch Autonomous Agent Container Cluster
docker-compose up -d --build

# 5. Inspect Health Endpoint
curl -s http://localhost:8080/healthz | jq .