# 1. Build and verify Anchor smart contract
anchor build
anchor test

# 2. Deploy Anchor Program to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name kinetic_vault --program-keypair target/deploy/kinetic_vault-keypair.json

# 3. Create .env configuration
cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
AGENT_PRIVATE_KEY=[...insert uint8 byte array...]
PROGRAM_ID=KineTCJ2R2p1iK9j2LStYj24pE9V8w7V8wG9QnFwQ9w
VAULT_PDA=3zH1oA...
POOL_ADDRESS=whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
RESEND_API_KEY=re_123456789
ALERT_EMAIL_RECIPIENT=risk@aegis-rebalance.io
EOF

# 4. Turnkey Launch with Docker
docker compose up -d --build
docker compose logs -f