#!/usr/bin/env bash
# Serve the car's cameras + mic from the Jetson over SRT (MPEG-TS). The Jetson
# listens and OBS dials in, so nothing here needs to know the viewer's address.
#
# Which camera lands on which port comes from cameras.conf, keyed on the stable
# /dev/v4l/by-path (or by-id) name rather than USB enumeration order. Audio is
# fixed at 9002.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${CAMERA_CONFIG:-${SCRIPT_DIR}/cameras.conf}"
BIND_ADDR=0.0.0.0
AUDIO_PORT=9002
# SRT recovers loss by retransmission, which costs a full round trip. Trackside
# cellular measures ~160ms median RTT (220ms peaks), so a budget below that
# leaves every retransmit arriving after its deadline — the decoder keeps the
# damaged reference and smears until the next keyframe. Keep this well above
# RTT; Haivision's guidance is 4x.
SRT_LATENCY=800

[ -r "$CONFIG" ] || { echo "No camera config at ${CONFIG}"; exit 1; }

# --- What's actually plugged in -----------------------------------------------

# Video capture devices only; every camera also exposes a metadata node that
# answers to v4l2-ctl but has nothing to stream.
DEVICES=()
for dev in /dev/video*; do
  [ -e "$dev" ] || continue
  if v4l2-ctl -d "$dev" --all 2>/dev/null | grep -q "Format Video Capture:"; then
    DEVICES+=("$dev")
  fi
done

if [ ${#DEVICES[@]} -eq 0 ]; then
  echo "No video capture devices found"
  exit 1
fi

# Every name a device answers to: its by-path and by-id symlinks plus the
# /dev/videoN path itself, so a selector can be any of the three.
declare -A ALIASES=()
for dev in "${DEVICES[@]}"; do
  ALIASES["$dev"]="$dev"
done
for link in /dev/v4l/by-path/* /dev/v4l/by-id/*; do
  [ -e "$link" ] || continue
  target="$(readlink -f "$link")"
  [ -n "${ALIASES[$target]:-}" ] || continue
  ALIASES["$target"]+=" $(basename "$link")"
done

echo "Found ${#DEVICES[@]} capture device(s): ${DEVICES[*]}"

# First unclaimed device answering to $1, into $RESOLVED_DEV (empty if none).
# Claiming keeps two rows with overlapping globs from both grabbing the same
# camera. Returned by variable, not stdout: a command substitution would run
# this in a subshell and throw the claim away.
CLAIMED=()
RESOLVED_DEV=""
resolve_device() {
  local selector="$1" dev alias claimed
  RESOLVED_DEV=""
  for dev in "${DEVICES[@]}"; do
    for claimed in ${CLAIMED[@]+"${CLAIMED[@]}"}; do
      [ "$claimed" = "$dev" ] && continue 2
    done
    for alias in ${ALIASES["$dev"]}; do
      # shellcheck disable=SC2254 # selector is a glob on purpose
      case "$alias" in
        $selector) CLAIMED+=("$dev"); RESOLVED_DEV="$dev"; return ;;
      esac
    done
  done
}

# The camera must offer the requested resolution as MJPEG — that's the only
# format the pipeline below decodes.
has_mjpeg_res() {
  local dev="$1" res="$2"
  v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null \
    | sed -n '/MJPG/,/^\[/p' | grep -q "$res"
}

# --- Read the config ----------------------------------------------------------

ROLES=() PORTS=() SELECTORS=() RESES=() FLIPS=() BITRATES=() OVERLAYS=() CONTROLS=()
while IFS='|' read -r role port selector res flip bitrate overlay controls; do
  case "${role# }" in ''|'#'*) continue ;; esac
  ROLES+=("$role") PORTS+=("$port") SELECTORS+=("$selector") RESES+=("$res")
  FLIPS+=("$flip") BITRATES+=("$bitrate") OVERLAYS+=("$overlay") CONTROLS+=("${controls:-}")
done < "$CONFIG"

[ ${#ROLES[@]} -gt 0 ] || { echo "No camera rows in ${CONFIG}"; exit 1; }

# Resolve every row up front so the mapping can be logged as one table, and so
# a config that matches nothing is caught before any pipeline starts.
RESOLVED=()
MATCHES=0
for i in "${!ROLES[@]}"; do
  resolve_device "${SELECTORS[$i]}"
  RESOLVED+=("$RESOLVED_DEV")
  [ -n "$RESOLVED_DEV" ] && MATCHES=$((MATCHES + 1))
done

# A config whose selectors are all stale would take the whole broadcast down,
# which is the wrong failure at a track. Fall back to enumeration order — the
# old behaviour, wrong-camera-shaped but live — and make the reason obvious.
if [ "$MATCHES" -eq 0 ]; then
  echo "WARNING: no camera in ${CONFIG} matched a connected device."
  echo "WARNING: falling back to /dev/video* enumeration order — the streams may"
  echo "WARNING: be in any order. Fix the selectors with ./detect_cameras.sh."
  RESOLVED=()
  for i in "${!ROLES[@]}"; do
    RESOLVED+=("${DEVICES[$i]:-}")
  done
fi

echo
echo "role       port  device       source"
for i in "${!ROLES[@]}"; do
  dev="${RESOLVED[$i]}"
  if [ -n "$dev" ]; then
    printf '%-10s %-5s %-12s %s\n' "${ROLES[$i]}" "${PORTS[$i]}" "$dev" "${SELECTORS[$i]}"
  else
    printf '%-10s %-5s %-12s %s\n' "${ROLES[$i]}" "${PORTS[$i]}" "(missing)" "${SELECTORS[$i]}"
  fi
done

# Anything plugged in that no row wants is almost always a mis-plug.
for dev in "${DEVICES[@]}"; do
  for claimed in ${RESOLVED[@]+"${RESOLVED[@]}"}; do
    [ "$claimed" = "$dev" ] && continue 2
  done
  echo "WARNING: ${dev} matches no role in ${CONFIG} and will not be streamed"
  echo "WARNING:   aliases: ${ALIASES[$dev]}"
done
echo

# --- Launch -------------------------------------------------------------------

PIDS=()
STARTED=()
for i in "${!ROLES[@]}"; do
  dev="${RESOLVED[$i]}"
  role="${ROLES[$i]}"

  if [ -z "$dev" ]; then
    echo "Skipping ${role}: no device matched '${SELECTORS[$i]}' — port ${PORTS[$i]} stays dark"
    continue
  fi

  res="${RESES[$i]}"
  if ! has_mjpeg_res "$dev" "$res"; then
    echo "Skipping ${role} (${dev}): no MJPEG ${res} — port ${PORTS[$i]} stays dark"
    continue
  fi

  w=${res%x*}
  h=${res#*x}
  bitrate="${BITRATES[$i]}"
  peak=$((bitrate * 5 / 4))

  # An array, so the properties that contain spaces survive as single words.
  overlay=()
  if [ "${OVERLAYS[$i]}" = "yes" ]; then
    overlay=(
      '!' clockoverlay
      'time-format=%Y-%m-%d %H:%M:%S %Z'
      halignment=left valignment=bottom
      'font-desc=monospace 6'
      shaded-background=true
    )
  fi

  echo "Serving ${role} on ${dev} (MJPEG ${res}) → srt://${BIND_ADDR}:${PORTS[$i]} (listener) ..."
  gst-launch-1.0 \
    v4l2src device="${dev}" \
    ! "image/jpeg,width=${w},height=${h},framerate=30/1" \
    ! jpegdec \
    ${overlay[@]+"${overlay[@]}"} \
    ! nvvidconv flip-method="${FLIPS[$i]}" ! 'video/x-raw(memory:NVMM)' \
    ! nvv4l2h264enc maxperf-enable=true ratecontrol-enable=true EnableTwopassCBR=false peak-bitrate=${peak} bitrate=${bitrate} iframeinterval=15 insert-sps-pps=true \
    ! h264parse ! queue max-size-time=200000000 leaky=downstream ! mpegtsmux alignment=7 \
    ! srtsink uri="srt://${BIND_ADDR}:${PORTS[$i]}?mode=listener" latency=${SRT_LATENCY} sync=false &
  PIDS+=($!)
  STARTED+=("$i")
done

if [ ${#STARTED[@]} -eq 0 ]; then
  echo "No camera pipelines started"
  exit 1
fi

# Audio-only stream on fixed port 9002
echo "Serving audio (LavMicro-U) → srt://${BIND_ADDR}:${AUDIO_PORT} (listener) ..."
gst-launch-1.0 \
  alsasrc device=hw:LavMicroU,0 provide-clock=true slave-method=skew buffer-time=40000 latency-time=10000 \
  ! queue max-size-time=200000000 leaky=downstream ! audioconvert ! audioresample \
  ! 'audio/x-raw,rate=48000,channels=1' \
  ! opusenc bitrate=64000 frame-size=10 audio-type=voice \
  ! opusparse ! mpegtsmux alignment=7 \
  ! srtsink uri="srt://${BIND_ADDR}:${AUDIO_PORT}?mode=listener" latency=${SRT_LATENCY} sync=false &
PIDS+=($!)

# v4l2 controls only stick once a pipeline has the device open.
for i in ${STARTED[@]+"${STARTED[@]}"}; do
  [ -n "${CONTROLS[$i]}" ] || continue
  (
    sleep 3
    args=()
    IFS=';' read -ra ctrls <<< "${CONTROLS[$i]}"
    for ctrl in "${ctrls[@]}"; do
      [ -n "$ctrl" ] && args+=("--set-ctrl=${ctrl}")
    done
    if v4l2-ctl -d "${RESOLVED[$i]}" "${args[@]}"; then
      echo "Applied ${ROLES[$i]} controls: ${CONTROLS[$i]}"
    else
      echo "WARNING: failed to apply ${ROLES[$i]} controls"
    fi
  ) &
done

echo "All streams listening, waiting for OBS to connect. PIDs: ${PIDS[*]}"
echo "Press Ctrl+C to stop all."

cleanup() {
  echo "Stopping all streams..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait
}
trap cleanup SIGINT SIGTERM

# Wait for any child to exit — if a pipeline dies, kill everything and fail
while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Process $pid died, shutting down all streams"
      cleanup
      exit 1
    fi
  done
  sleep 1
done
