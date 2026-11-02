# 1. Clone repository and navigate to project root
git clone https://github.com/solana-bounties/kinetic-liquidity-rebalancer.git
cd kinetic-liquidity-rebalancer

# 2. Install Node dependencies
yarn install

# 3. Setup Python virtual environment for off-chain AI agent
python3 -m venv venv
source venv/bin/activate
pip install -r agent/requirements.txt

# 4. Build Anchor Program
anchor build

# 5. Extract Program Key and synchronize with Anchor.toml & lib.rs
solana address -k target/deploy/kinetic_rebalance-keypair.json
# Ensure the printed public key matches declare_id!() in lib.rs

# 6. Run the complete Mocha / TypeScript Integration Test Suite
anchor test