# Clone & install dependencies
npm install @orca-so/whirlpools-sdk @orca-so/common-sdk @solana/web3.js @coral-xyz/anchor decimal.js axios dotenv

# Compile TypeScript
npm run build

# Launch Agent under Process Supervisor (PM2 / Systemd)
pm2 start dist/rebalancer_agent.js --name "solana-clmm-agent" --time