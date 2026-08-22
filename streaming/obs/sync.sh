#!/usr/bin/env bash
###############################################################################
# sync.sh — move the OBS setup between this repo and a machine's OBS config
#
#   ./sync.sh export    live OBS config -> repo (Twitch key stripped)
#   ./sync.sh import    repo -> live OBS config (OBS must be closed)
###############################################################################
set -euo pipefail

OBS_DIR="${OBS_DIR:-$HOME/Library/Application Support/obs-studio}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTION="${COLLECTION:-telem}"
PROFILE="${PROFILE:-telem}"

usage() { echo "usage: $0 {export|import}" >&2; exit 1; }
[ $# -eq 1 ] || usage

# basic.ini stores recording paths absolute; placeholder them for other machines.
sub_home() { sed "s|$1|$2|g"; }

case "$1" in
  export)
    [ -f "$OBS_DIR/basic/scenes/${COLLECTION}.json" ] || {
      echo "No scene collection '${COLLECTION}' in ${OBS_DIR}" >&2; exit 1; }

    cp "$OBS_DIR/basic/scenes/${COLLECTION}.json" "$REPO_DIR/scene-collection.json"
    sub_home "$HOME" "__HOME__" \
      < "$OBS_DIR/basic/profiles/${PROFILE}/basic.ini" \
      | grep -v '^CookieId=' > "$REPO_DIR/profile/basic.ini"

    python3 - "$OBS_DIR/basic/profiles/${PROFILE}/service.json" "$REPO_DIR/profile/service.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in ("key", "stream_key_link"):
    if k in d.get("settings", {}):
        d["settings"][k] = ""
json.dump(d, open(sys.argv[2], "w"), indent=4)
PY
    echo "Exported to ${REPO_DIR} (stream key stripped)"
    ;;

  import)
    pgrep -x OBS >/dev/null && { echo "Quit OBS first — it overwrites its config on exit" >&2; exit 1; }

    mkdir -p "$OBS_DIR/basic/scenes" "$OBS_DIR/basic/profiles/${PROFILE}"
    for f in "$OBS_DIR/basic/scenes/${COLLECTION}.json" \
             "$OBS_DIR/basic/profiles/${PROFILE}/basic.ini" \
             "$OBS_DIR/basic/profiles/${PROFILE}/service.json"; do
      [ -f "$f" ] && cp "$f" "${f}.bak"
    done

    cp "$REPO_DIR/scene-collection.json" "$OBS_DIR/basic/scenes/${COLLECTION}.json"
    sub_home "__HOME__" "$HOME" \
      < "$REPO_DIR/profile/basic.ini" > "$OBS_DIR/basic/profiles/${PROFILE}/basic.ini"
    cp "$REPO_DIR/profile/service.json" "$OBS_DIR/basic/profiles/${PROFILE}/service.json"

    echo "Imported. Existing config saved as *.bak"
    echo "Open OBS → Scene Collection → ${COLLECTION}, Profile → ${PROFILE}, then paste your Twitch key."
    ;;

  *) usage ;;
esac
