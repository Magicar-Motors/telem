#!/bin/bash
# Also handle `sh start-all-client.sh` or `zsh start-all-client.sh`.
if [ -z "${BASH_VERSION:-}" ]; then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="telem-client"

if [[ "${1:-}" == "--run" ]]; then
  case "${2:-}" in
    udp-client)
      cd "$ROOT/udp-client-receiver"
      label="Receiver"
      command=(npm start)
      ;;
    client)
      cd "$ROOT/client"
      label="Client"
      command=(npm run dev -- --strictPort)
      ;;
    obs-controller)
      cd "$ROOT/obs-controller-webapp"
      label="OBS controller (Funnel)"
      command=(npm run start:funnel)
      ;;
    *) echo "Unknown service: ${2:-}" >&2; exit 2 ;;
  esac

  if "${command[@]}"; then
    code=0
  else
    code=$?
  fi
  printf '\n%s exited with status %s. Press Enter to close this pane.\n' "$label" "$code"
  read -r || true
  exit "$code"
fi

if ! command -v tmux >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "tmux is missing and Homebrew is unavailable. Install tmux, then rerun this script." >&2
    exit 1
  fi
  echo "Installing tmux with Homebrew..."
  brew install tmux
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to run the client services." >&2
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "The $SESSION tmux session is already running."
  if [[ -t 0 && -t 1 ]]; then
    if [[ -n "${TMUX:-}" ]]; then
      exec tmux switch-client -t "$SESSION"
    fi
    exec tmux attach-session -t "$SESSION"
  fi
  exit 0
fi

# Refresh dependencies even when node_modules exists (for newly added packages).
for app in udp-client-receiver client obs-controller-webapp; do
  echo "Installing $app dependencies..."
  (cd "$ROOT/$app" && npm i)
done

if ! command -v tailscale >/dev/null 2>&1; then
  echo "The tailscale CLI is required for the public OBS controller." >&2
  exit 1
fi

echo "Building the OBS controller for Funnel..."
(cd "$ROOT/obs-controller-webapp" && npm run build:funnel)
tailscale funnel --bg --yes "http://127.0.0.1:${SCENE_DECK_PORT:-8787}"
# Tailscale can exit successfully even when Funnel permission is missing.
if ! (cd "$ROOT/obs-controller-webapp" && node --input-type=module -e '
  import { readFunnelUrl } from "./lib/funnel-link.mjs";
  const url = await readFunnelUrl(Number(process.env.SCENE_DECK_PORT || 8787));
  if (!url) { console.error("Funnel is not active. Enable Funnel and HTTPS in Tailscale, then retry."); process.exit(1); }
  console.log("OBS controller: " + url);
'); then
  exit 1
fi

# Explicit Bash avoids dependence on tmux's configured default shell.
printf -v SCRIPT_COMMAND '/bin/bash %q' "$ROOT/start-all-client.sh"

# Keep each pane open after a process exits so its error remains visible.
tmux new-session -d -s "$SESSION" -n services -c "$ROOT/udp-client-receiver" "$SCRIPT_COMMAND --run udp-client"
tmux split-window -h -t "$SESSION:0" -c "$ROOT/client" "$SCRIPT_COMMAND --run client"

# The controller uses loopback ports 5175/8787; the dashboard keeps 5173.
tmux split-window -v -t "$SESSION:0.1" -c "$ROOT/obs-controller-webapp" "$SCRIPT_COMMAND --run obs-controller"

tmux set-option -t "$SESSION" mouse on
tmux select-pane -t "$SESSION:0.0"

echo "Started $SESSION: udp-client, client, obs-controller"
echo "Dashboard:      http://localhost:5173"
echo "OBS controller QR code: shown in its pane (or run npm run funnel:qr in obs-controller-webapp)"
echo "Attach: tmux attach -t $SESSION"
echo "Detach: Ctrl-B D"
echo "Stop all: tmux kill-session -t $SESSION"
echo "Disable public access: tailscale funnel --https=443 off"

if [[ -t 0 && -t 1 ]]; then
  if [[ -n "${TMUX:-}" ]]; then
    exec tmux switch-client -t "$SESSION"
  fi
  exec tmux attach-session -t "$SESSION"
fi
