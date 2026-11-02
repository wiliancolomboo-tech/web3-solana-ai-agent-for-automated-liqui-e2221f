# 1. Clone & Install Dependencies
npm install -g @coral-xyz/anchor-cli
npm install

# 2. Build Anchor Smart Contracts
anchor build

# 3. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 4. Run Off-Chain Kinetic Rebalancer Agent
npm run start:agent