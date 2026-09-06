#!/usr/bin/env bash
###############################################################################
# test_streams.sh — Quick preview of SRT streams via ffplay (run on the ground
# computer)
#
# This is NOT required for production use. OBS connects directly to the
# Jetson's SRT streams. This script is only for debugging/testing without OBS.
#
# Roles and ports come from cameras.conf, so the window titles say which camera
# you're actually looking at.
#
# Usage: ./test_streams.sh [role ...]     (default: every role in cameras.conf)
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${CAMERA_CONFIG:-${SCRIPT_DIR}/cameras.conf}"

[ -r "$CONFIG" ] || { echo "No camera config at ${CONFIG}"; exit 1; }

ROLES=() PORTS=()
while IFS='|' read -r role port _rest; do
  case "${role# }" in ''|'#'*) continue ;; esac
  if [ $# -gt 0 ]; then
    wanted=0
    for arg in "$@"; do [ "$arg" = "$role" ] && wanted=1; done
    [ "$wanted" = 1 ] || continue
  fi
  ROLES+=("$role") PORTS+=("$port")
done < "$CONFIG"

if [ ${#ROLES[@]} -eq 0 ]; then
  echo "No matching roles in ${CONFIG}"
  exit 1
fi

echo "Starting ${#ROLES[@]} SRT listener(s)..."
echo ""

PIDS=()
for i in "${!ROLES[@]}"; do
  echo "Listening for ${ROLES[$i]} on srt://0.0.0.0:${PORTS[$i]} ..."
  ffplay -window_title "${ROLES[$i]} (port ${PORTS[$i]})" \
    -fflags nobuffer -flags low_delay -framedrop \
    -probesize 32 -analyzeduration 0 \
    -i "srt://0.0.0.0:${PORTS[$i]}?mode=listener" &
  PIDS+=($!)
done

echo ""
echo "All listeners started. PIDs: ${PIDS[*]}"
echo ""
echo "For OBS: add Media Source → uncheck Local File"
echo "  Input: srt://0.0.0.0:PORT?mode=listener"
echo ""
echo "Press Ctrl+C to stop all."

cleanup() {
  echo "Stopping all listeners..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait
}
trap cleanup SIGINT SIGTERM

wait
