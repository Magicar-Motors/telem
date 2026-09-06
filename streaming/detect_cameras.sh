#!/usr/bin/env bash
# List the connected cameras and print a cameras.conf line for each, keyed on
# the stable by-path name so the mapping survives a re-plug or a reboot.
set -euo pipefail

if ! command -v v4l2-ctl &>/dev/null; then
  echo "v4l2-ctl not found. Install with: sudo apt install v4l-utils"
  exit 1
fi

echo "=== Connected Video Devices ==="
echo
v4l2-ctl --list-devices 2>/dev/null || echo "(no devices found)"
echo

# by-path names the physical USB port; by-id carries the unit's serial. Both
# beat /dev/videoN, which is assigned in enumeration order.
# Some kernels expose a device under two by-path names (a plain `usb-` one and
# a `usbv2-` one); first wins, which alphabetically is the plain form.
declare -A BY_PATH=() BY_ID=()
for link in /dev/v4l/by-path/*; do
  [ -e "$link" ] || continue
  target="$(readlink -f "$link")"
  [ -z "${BY_PATH[$target]:-}" ] && BY_PATH["$target"]="$(basename "$link")"
done
for link in /dev/v4l/by-id/*; do
  [ -e "$link" ] || continue
  target="$(readlink -f "$link")"
  [ -z "${BY_ID[$target]:-}" ] && BY_ID["$target"]="$(basename "$link")"
done

CONF_LINES=()
for dev in /dev/video*; do
  [ -e "$dev" ] || continue
  if ! v4l2-ctl -d "$dev" --all 2>/dev/null | grep -q "Format Video Capture:"; then
    echo "=== $dev (metadata/control — skipped) ==="
    echo
    continue
  fi

  name="$(v4l2-ctl -d "$dev" --info 2>/dev/null | sed -n 's/^\s*Card type\s*:\s*//p' | head -1)"
  echo "=== $dev (capture) — ${name:-unknown} ==="
  echo "  by-path: ${BY_PATH[$dev]:-(none)}"
  echo "  by-id:   ${BY_ID[$dev]:-(none)}"
  v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null || echo "  (cannot open)"
  echo

  # Widest MJPEG size the camera offers, since that's what the pipeline decodes.
  mjpeg="$(v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null | sed -n '/MJPG/,/^\[/p')"
  res="1280x720"
  for candidate in 1920x1080 1280x720 640x480; do
    if grep -q "$candidate" <<< "$mjpeg"; then res="$candidate"; break; fi
  done

  if [ -n "${BY_PATH[$dev]:-}" ]; then
    # Trim the -video-indexN suffix: it too is assigned in enumeration order.
    selector="*${BY_PATH[$dev]%-video-index*}*"
  else
    selector="$dev"
  fi
  CONF_LINES+=("ROLE|PORT|${selector}|${res}|0|1200000|no|")
done

if [ ${#CONF_LINES[@]} -gt 0 ]; then
  echo "=== Paste into cameras.conf ==="
  echo "(fill in ROLE and PORT; 9002 is audio, so video goes 9000, 9001, 9003, ...)"
  echo
  printf '%s\n' "${CONF_LINES[@]}"
fi
