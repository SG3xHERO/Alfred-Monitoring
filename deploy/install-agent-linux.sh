#!/bin/sh
# Alfred agent installer for Debian — run as root.
# Self-contained: downloads the agent binary from the Alfred server itself, no
# manual download required. Meant to be piped straight from curl, e.g.:
#   curl -fsSL https://monitor.example.com/agent/install.sh | sudo sh -s -- https://monitor.example.com alf_xxx
#
# <version> is optional: omit it for a normal install, which pulls whatever
# build is currently baked into the frontend image (unversioned, always
# "current" — frontend/Dockerfile cross-compiles the agent on every deploy).
# Pass it to pin a specific admin-published release instead (see
# AGENT_RELEASES_DIR) — used for admin-triggered update pushes, not needed
# for a first install.
# Usage: install-agent-linux.sh <backend_url> <api_key> [version] [bin_source]
#   bin_source: optional local path or URL to the binary, overrides the
#               default download URL.
set -eu

BACKEND_URL="${1:?usage: install-agent-linux.sh <backend_url> <api_key> [version]}"
API_KEY="${2:?usage: install-agent-linux.sh <backend_url> <api_key> [version]}"
VERSION="${3:-}"
if [ -n "${4:-}" ]; then
  BIN_SRC="$4"
elif [ -n "$VERSION" ]; then
  BIN_SRC="${BACKEND_URL%/}/agent/download/${VERSION}/linux"
else
  BIN_SRC="${BACKEND_URL%/}/agent/alfred-agent"
fi

install -d /etc/alfred-agent /opt/alfred-agent
systemctl stop alfred-agent 2>/dev/null || true

case "$BIN_SRC" in
  http://*|https://*)
    echo "Downloading agent${VERSION:+ ${VERSION}} from ${BIN_SRC} ..."
    curl -fsSL -H "X-API-Key: ${API_KEY}" "$BIN_SRC" -o /tmp/alfred-agent
    install -m 755 /tmp/alfred-agent /opt/alfred-agent/alfred-agent
    rm -f /tmp/alfred-agent
    ;;
  *)
    install -m 755 "$BIN_SRC" /opt/alfred-agent/alfred-agent
    ;;
esac

# Always (re)write backend_url/api_key from the values passed to this script.
# This is an explicit "install with these credentials" action - if the config
# already exists (e.g. a previous run partially failed, or you're rotating the
# API key), silently keeping the old file would leave the agent authenticating
# with a stale key and it would never show up as online.
cat > /etc/alfred-agent/config.yaml <<EOF
backend_url: ${BACKEND_URL}
api_key: ${API_KEY}
interval_seconds: 15
checks:
  services: []
  processes: []
EOF
chmod 600 /etc/alfred-agent/config.yaml

/opt/alfred-agent/alfred-agent -service install || true
systemctl daemon-reload
systemctl enable --now alfred-agent
systemctl status alfred-agent --no-pager
echo "alfred-agent installed. Config: /etc/alfred-agent/config.yaml"
