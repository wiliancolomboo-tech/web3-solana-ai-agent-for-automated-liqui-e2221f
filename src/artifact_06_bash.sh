# 1. Clone repository & install dependencies
git clone https://github.com/sponsor-org/kinesis-rebalancer.git
cd kinesis-rebalancer
npm install

# 2. Build on-chain Anchor program
anchor build

# 3. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 4. Copy generated IDL to agent config
cp target/idl/kinesis_vault.json agent/src/idl/

# 5. Populate production configuration
cp .env.example .env
# Edit .env with your funded Agent Keypair, RPC endpoints, and Webhooks

# 6. Launch autonomous agent worker
npm run agent:start