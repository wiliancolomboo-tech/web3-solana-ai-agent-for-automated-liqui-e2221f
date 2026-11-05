# 1. Build smart contract artifacts
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2 || true
anchor deploy --program-name kinetic_rebalance --program-keypair target/deploy/kinetic_rebalance-keypair.json

# 3. Synchronize IDL
anchor idl init --filepath target/idl/kinetic_rebalance.json Kinet1cRebaL1qu1d1tyVault11111111111111111