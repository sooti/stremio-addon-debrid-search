#!/bin/bash
# Uninstall Usenet File Server systemd service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Usenet File Server - Service Uninstallation${NC}"
echo -e "${YELLOW}════════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if service exists
if [ ! -f /etc/systemd/system/usenet-file-server.service ]; then
    echo -e "${RED}Service is not installed.${NC}"
    exit 1
fi

# Confirm uninstallation
read -p "Are you sure you want to uninstall the Usenet File Server service? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Uninstallation cancelled."
    exit 0
fi

echo ""

# Stop service if running
if sudo systemctl is-active --quiet usenet-file-server.service; then
    echo -e "${YELLOW}Stopping service...${NC}"
    sudo systemctl stop usenet-file-server.service
fi

# Disable service
echo -e "${YELLOW}Disabling service...${NC}"
sudo systemctl disable usenet-file-server.service

# Remove service file
echo -e "${YELLOW}Removing service file...${NC}"
sudo rm /etc/systemd/system/usenet-file-server.service

# Reload systemd
echo -e "${YELLOW}Reloading systemd...${NC}"
sudo systemctl daemon-reload
sudo systemctl reset-failed

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Service uninstalled successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Note: The Python script and installation files have not been deleted."
echo "If you want to remove them, manually delete the script directory."
