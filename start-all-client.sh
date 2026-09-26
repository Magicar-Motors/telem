#!/usr/bin/env bash
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
      label="OBS controller"
      command=(npm run dev -- --port 5174)
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

# Install only when dependencies are missing; npm ci uses each app's lockfile.
for app in udp-client-receiver client obs-controller-webapp; do
  if [[ ! -d "$ROOT/$app/node_modules" ]]; then
    echo "Installing $app dependencies..."
    (cd "$ROOT/$app" && npm ci)
  fi
done

printf -v SCRIPT_COMMAND '%q' "$ROOT/start-all-client.sh"

# Keep each pane open after a process exits so its error remains visible.
tmux new-session -d -s "$SESSION" -n services -c "$ROOT/udp-client-receiver" "$SCRIPT_COMMAND --run udp-client"
tmux split-window -h -t "$SESSION:0" -c "$ROOT/client" "$SCRIPT_COMMAND --run client"

# The client uses 5173; override the controller's default to avoid a collision.
tmux split-window -v -t "$SESSION:0.1" -c "$ROOT/obs-controller-webapp" "$SCRIPT_COMMAND --run obs-controller"

tmux set-option -t "$SESSION" mouse on
tmux select-pane -t "$SESSION:0.0"

echo "Started $SESSION: udp-client, client, obs-controller"
echo "Dashboard:      http://localhost:5173"
echo "OBS controller: http://localhost:5174"
echo "Attach: tmux attach -t $SESSION"
echo "Detach: Ctrl-B D"
echo "Stop all: tmux kill-session -t $SESSION"

if [[ -t 0 && -t 1 ]]; then
  if [[ -n "${TMUX:-}" ]]; then
    exec tmux switch-client -t "$SESSION"
  fi
  exec tmux attach-session -t "$SESSION"
fi
