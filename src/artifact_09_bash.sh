# 1. Configure CLI for Devnet
solana config set --url https://api.devnet.solana.com

# 2. Airdrop devnet SOL to deployer wallet
solana airdrop 2

# 3. Synchronize Program ID
anchor keys sync

# 4. Build and Deploy
anchor build
anchor deploy --provider.cluster devnet

# 5. Run the Autonomous Off-Chain Kinetic Agent
export KEEPER_KEYPAIR_PATH="./id.json"
export RPC_ENDPOINT="https://api.devnet.solana.com"
python3 agent/kinetic_agent.py