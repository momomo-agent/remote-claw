#!/bin/bash
# RemoteClaw Daemon Installer
# Run on any machine to install and start the daemon

set -e

REPO="https://github.com/momomo-agent/remote-claw.git"
INSTALL_DIR="$HOME/.remoteclaw/daemon"
CONFIG_DIR="$HOME/.remoteclaw"
CONFIG_PATH="$CONFIG_DIR/config.json"

echo "Installing RemoteClaw daemon..."

# Clone or update daemon
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR" && git pull --quiet
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --filter=blob:none --sparse "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  git sparse-checkout set daemon
fi

cd "$INSTALL_DIR/daemon"
npm install --quiet 2>/dev/null

# Create config if missing
if [ ! -f "$CONFIG_PATH" ]; then
  cat > "$CONFIG_PATH" << 'EOF'
{
  "server": "wss://remote.momomo.dev",
  "token": "CHANGE_ME"
}
EOF
  echo "Config created at $CONFIG_PATH — edit the token!"
fi

# Install LaunchAgent
node daemon.js --install-launchagent
PLIST="$HOME/Library/LaunchAgents/dev.momomo.remoteclaw.plist"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Done! Daemon is running."
echo "Check: curl -s https://remote.momomo.dev/devices -H 'Authorization: Bearer YOUR_TOKEN'"
