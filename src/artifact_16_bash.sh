cd agent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Start the Kinetic Daemon
python kinetic_agent.py