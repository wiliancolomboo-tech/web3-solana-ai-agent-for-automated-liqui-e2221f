# 1. Build & Test Anchor Program
anchor build
anchor test

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/kinetix_vault-keypair.json \
  target/deploy/kinetix_vault.so \
  --url https://api.devnet.solana.com

# 3. Provision Agent Delegate Wallet
solana-keygen new --outfile agent-wallet.json --no-bip39-passphrase