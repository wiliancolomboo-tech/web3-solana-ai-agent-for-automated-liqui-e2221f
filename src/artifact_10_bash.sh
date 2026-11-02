# Set your environment variables
export RPC_URL="http://127.0.0.1:8899"
export PROGRAM_ID="Kntx111111111111111111111111111111111111111"
export VAULT_PDA="[DERIVED_VAULT_PDA_ADDRESS]"

# Start Worker Daemon
python3 agent/kinetic_agent.py