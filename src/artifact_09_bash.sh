# Set Solana environment
solana config set --url https://api.devnet.solana.com

# Build Anchor Program
anchor build

# Deploy Program
anchor deploy --program-name kinetic_rebalancer \
  --program-keypair target/deploy/kinetic_rebalancer-keypair.json

# Copy the deployed program address into Anchor.toml and agent .env