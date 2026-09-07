#!/usr/bin/env bash
###############################################################################
# The T14s (Linux, Flatpak OBS) half of the OBS setup.
#
# Same script as ../obs, pointed at this machine's paths and names. The Mac and
# the T14s can't share one export: the profile pins an encoder (apple_h264 vs
# the Linux x264/VAAPI) and OBS keeps its config somewhere different under
# Flatpak, so a single file would break whichever machine imported it second.
#
#   ./sync.sh export    live OBS config -> this directory
#   ./sync.sh import    this directory -> live OBS config (OBS must be closed)
###############################################################################
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Flatpak sandboxes OBS's config out of ~/.config.
export OBS_DIR="${OBS_DIR:-$HOME/.var/app/com.obsproject.Studio/config/obs-studio}"
export REPO_DIR="$HERE"
export COLLECTION="${COLLECTION:-Untitled}"
export PROFILE="${PROFILE:-Untitled}"

exec "$HERE/../obs/sync.sh" "$@"
