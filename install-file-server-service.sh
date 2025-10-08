#!/bin/bash
# Install Usenet File Server as a systemd service
# This script is generic and works on any Linux system with systemd

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Usenet File Server - Systemd Service Installation${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""

# Get current directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Check if Python script exists
if [ ! -f "$SCRIPT_DIR/usenet_file_server.py" ]; then
    echo -e "${RED}Error: usenet_file_server.py not found in $SCRIPT_DIR${NC}"
    exit 1
fi

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${RED}Error: Do not run this script as root. It will ask for sudo when needed.${NC}"
    exit 1
fi

# Get SABnzbd download directory
echo -e "${YELLOW}Enter the directory to serve files from:${NC}"
echo "  (This is usually your SABnzbd complete download directory)"
echo "  Example: /home/user/Downloads/sabnzbd/complete"
read -p "Directory path: " DOWNLOAD_DIR

# Expand tilde to home directory
DOWNLOAD_DIR="${DOWNLOAD_DIR/#\~/$HOME}"

# Validate directory exists
if [ ! -d "$DOWNLOAD_DIR" ]; then
    echo -e "${RED}Error: Directory does not exist: $DOWNLOAD_DIR${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Directory exists: $DOWNLOAD_DIR${NC}"
echo ""

# Get port (default 8081)
echo -e "${YELLOW}Enter port number (default: 8081):${NC}"
echo "  Use 8081 unless you have a conflict"
read -p "Port: " PORT
PORT=${PORT:-8081}

# Get bind address (default 0.0.0.0)
echo -e "${YELLOW}Enter bind address (default: 0.0.0.0):${NC}"
echo "  0.0.0.0 = accessible from any network interface (recommended)"
echo "  127.0.0.1 = only accessible from localhost"
read -p "Bind address: " BIND
BIND=${BIND:-0.0.0.0}

# Get current user
CURRENT_USER=$(whoami)

# Detect Python path
PYTHON_BIN=$(which python3)
if [ -z "$PYTHON_BIN" ]; then
    echo -e "${RED}Error: python3 not found in PATH${NC}"
    exit 1
fi

# Create temporary service file with actual values
TEMP_SERVICE_FILE="/tmp/usenet-file-server.service"
cat > "$TEMP_SERVICE_FILE" << EOF
[Unit]
Description=Usenet File Server for Stremio Streaming
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$PYTHON_BIN $SCRIPT_DIR/usenet_file_server.py "$DOWNLOAD_DIR" --port $PORT --bind $BIND
Restart=always
RestartSec=10

# Security settings
NoNewPrivileges=true
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=usenet-file-server

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo -e "${GREEN}Configuration:${NC}"
echo "  Directory:    $DOWNLOAD_DIR"
echo "  Port:         $PORT"
echo "  Bind address: $BIND"
echo "  User:         $CURRENT_USER"
echo "  Python:       $PYTHON_BIN"
echo "  Script dir:   $SCRIPT_DIR"
echo ""

# Confirm installation
read -p "Install service with this configuration? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    rm "$TEMP_SERVICE_FILE"
    exit 0
fi

echo ""

# Copy service file
echo -e "${YELLOW}Installing service file...${NC}"
sudo cp "$TEMP_SERVICE_FILE" /etc/systemd/system/usenet-file-server.service
rm "$TEMP_SERVICE_FILE"

# Reload systemd
echo -e "${YELLOW}Reloading systemd...${NC}"
sudo systemctl daemon-reload

# Enable service
echo -e "${YELLOW}Enabling service...${NC}"
sudo systemctl enable usenet-file-server.service

# Start service
echo -e "${YELLOW}Starting service...${NC}"
sudo systemctl start usenet-file-server.service

# Check status
sleep 2
if sudo systemctl is-active --quiet usenet-file-server.service; then
    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✓ Service installed and started successfully!${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "Service status:"
    sudo systemctl status usenet-file-server.service --no-pager -l
    echo ""
    echo "Useful commands:"
    echo "  View logs:    sudo journalctl -u usenet-file-server -f"
    echo "  Stop:         sudo systemctl stop usenet-file-server"
    echo "  Start:        sudo systemctl start usenet-file-server"
    echo "  Restart:      sudo systemctl restart usenet-file-server"
    echo "  Disable:      sudo systemctl disable usenet-file-server"
    echo ""
    echo "Set this environment variable in your addon:"
    echo "  export USENET_FILE_SERVER_URL=http://localhost:$PORT"
else
    echo ""
    echo -e "${RED}✗ Service failed to start${NC}"
    echo "Check logs with: sudo journalctl -u usenet-file-server -n 50"
    exit 1
fi
