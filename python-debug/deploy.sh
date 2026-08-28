#!/usr/bin/env bash
# Push this folder to the Jetson. Usage: ./deploy.sh [user@host]
set -euo pipefail

TARGET="${1:-gearados@gearados-nx}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== rsync -> $TARGET:~/python-debug/ ==="
rsync -avz --delete \
  --exclude '__pycache__' \
  "$DIR/" "$TARGET:~/python-debug/"

# The Jetson reaches us over Tailscale, so hand it the tailnet name (lowercase
# MagicDNS), not the local hostname.
ME="$(tailscale status --self --peers=false 2>/dev/null | awk 'NR==1{print $2}')"
ME="${ME:-$(hostname -s | tr '[:upper:]' '[:lower:]')}"

echo ""
echo "done. now, in two terminals:"
echo "  1) here:      python3 $DIR/udp_echo.py"
echo "  2) on jetson: ssh $TARGET 'python3 ~/python-debug/udp_probe.py --host $ME'"
