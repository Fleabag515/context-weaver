#!/bin/bash
# install.sh — install context-weaver as a systemd service
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
NODE_BIN="$(which node)"

echo "Installing context-weaver from $INSTALL_DIR"
echo "Running as user: $SERVICE_USER"
echo "Node: $NODE_BIN"

# Install dependencies
cd "$INSTALL_DIR"
npm install

# Write systemd unit
cat > /etc/systemd/system/context-weaver.service << UNIT
[Unit]
Description=Context Weaver — LLM context rotation proxy
After=network.target llama-qwen-v2.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/src/proxy.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=context-weaver

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable context-weaver.service
systemctl restart context-weaver.service
systemctl status context-weaver.service --no-pager

echo ""
echo "Done. context-weaver is running on port $(node -e "console.log(require('$INSTALL_DIR/config.json').proxy.port)")"
echo "Point OpenClaw's llamaserver baseUrl to: http://127.0.0.1:$(node -e "console.log(require('$INSTALL_DIR/config.json').proxy.port)")/v1"
