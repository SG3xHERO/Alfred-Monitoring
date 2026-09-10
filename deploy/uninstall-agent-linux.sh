#!/bin/sh
# Alfred agent uninstaller for Debian — run as root.
# Usage: ./uninstall-agent-linux.sh
set -eu

if [ -x /opt/alfred-agent/alfred-agent ]; then
  systemctl stop alfred-agent 2>/dev/null || true
  /opt/alfred-agent/alfred-agent -service uninstall 2>/dev/null || true
else
  systemctl stop alfred-agent 2>/dev/null || true
fi
systemctl daemon-reload 2>/dev/null || true

rm -rf /opt/alfred-agent /etc/alfred-agent
echo "alfred-agent uninstalled and removed from /opt/alfred-agent and /etc/alfred-agent"
