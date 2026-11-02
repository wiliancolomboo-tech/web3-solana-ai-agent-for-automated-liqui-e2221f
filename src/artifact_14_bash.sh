# 1. Clone repository & install Anchor/Rust tooling
git clone https://github.com/anti-gravity/solana-kinetic-rebalance.git
cd solana-kinetic-rebalance

# 2. Build on-chain Anchor program
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Run end-to-end integration test suite
anchor test