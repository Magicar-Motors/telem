#!/usr/bin/env bash
# Serve all webcams + audio from the Jetson over SRT (MPEG-TS). The Jetson
# listens and OBS dials in, so nothing here needs to know the viewer's address.
# Ports: 9000, 9001 for video (max 2 cameras), 9002 for audio
set -euo pipefail

BIND_ADDR=0.0.0.0
BASE_PORT=9000
AUDIO_PORT=9002
MAX_VIDEO_STREAMS=2
# SRT recovers loss by retransmission, which costs a full round trip. Trackside
# cellular measures ~160ms median RTT (220ms peaks), so a budget below that
# leaves every retransmit arriving after its deadline — the decoder keeps the
# damaged reference and smears until the next keyframe. Keep this well above
# RTT; Haivision's guidance is 4x.
SRT_LATENCY=800

# Find all video capture devices (skip metadata/control nodes)
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

echo "Found ${#DEVICES[@]} camera(s): ${DEVICES[*]}"

# Detect best MJPEG resolution for a device (must be under MJPG section)
detect_res() {
  local dev="$1"
  local formats
  formats=$(v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null)

  # Extract only the MJPG section
  local mjpg_section
  mjpg_section=$(echo "$formats" | sed -n '/MJPG/,/^\[/p')

  if [ -z "$mjpg_section" ]; then
    echo "none"
    return
  fi

  for res in 1920x1080 1280x720 640x480; do
    if echo "$mjpg_section" | grep -q "${res}"; then
      echo "$res"
      return
    fi
  done

  echo "none"
}

# Find C930e device and ensure it's first (always port 9000)
C930E_DEV=""
OTHER_DEVS=()
for dev in "${DEVICES[@]}"; do
  if [ -z "$C930E_DEV" ] && v4l2-ctl -d "$dev" --all 2>/dev/null | grep -q "C930e"; then
    C930E_DEV="$dev"
  else
    OTHER_DEVS+=("$dev")
  fi
done

if [ -n "$C930E_DEV" ]; then
  DEVICES=("$C930E_DEV" "${OTHER_DEVS[@]}")
  echo "C930e at ${C930E_DEV} → pinned to port ${BASE_PORT}"
fi

PIDS=()
STREAM_COUNT=0
for i in "${!DEVICES[@]}"; do
  if [ "$STREAM_COUNT" -ge "$MAX_VIDEO_STREAMS" ]; then
    echo "Reached max video streams ($MAX_VIDEO_STREAMS), skipping remaining cameras"
    break
  fi

  dev="${DEVICES[$i]}"
  port=$((BASE_PORT + STREAM_COUNT))

  res=$(detect_res "$dev")
  if [ "$res" = "none" ]; then
    echo "Skipping ${dev}: no MJPEG support"
    continue
  fi

  # Secondary cameras capped to 720p
  if [ "$STREAM_COUNT" -gt 0 ]; then
    res="1280x720"
  fi

  w=${res%x*}
  h=${res#*x}

  if [ "$STREAM_COUNT" -eq 0 ]; then
    # First stream: video only (with clock overlay)
    echo "Serving ${dev} (MJPEG ${res}) → srt://${BIND_ADDR}:${port} (listener) ..."
    gst-launch-1.0 \
      v4l2src device="${dev}" \
      ! "image/jpeg,width=${w},height=${h},framerate=30/1" \
      ! jpegdec \
      ! clockoverlay time-format="%Y-%m-%d %H:%M:%S %Z" halignment=left valignment=bottom font-desc="monospace 6" shaded-background=true \
      ! nvvidconv ! 'video/x-raw(memory:NVMM)' \
      ! nvv4l2h264enc maxperf-enable=true ratecontrol-enable=true EnableTwopassCBR=false peak-bitrate=3000000 bitrate=2500000 iframeinterval=15 insert-sps-pps=true \
      ! h264parse ! queue max-size-time=200000000 leaky=downstream ! mpegtsmux alignment=7 \
      ! srtsink uri="srt://${BIND_ADDR}:${port}?mode=listener" latency=${SRT_LATENCY} sync=false &
  else
    # Subsequent streams: video only
    echo "Serving ${dev} (MJPEG ${res}) → srt://${BIND_ADDR}:${port} (listener) ..."
    gst-launch-1.0 \
      v4l2src device="${dev}" \
      ! "image/jpeg,width=${w},height=${h},framerate=30/1" \
      ! jpegdec ! nvvidconv flip-method=2 ! 'video/x-raw(memory:NVMM)' \
      ! nvv4l2h264enc maxperf-enable=true ratecontrol-enable=true EnableTwopassCBR=false peak-bitrate=1500000 bitrate=1200000 iframeinterval=15 insert-sps-pps=true \
      ! h264parse ! queue max-size-time=200000000 leaky=downstream ! mpegtsmux alignment=7 \
      ! srtsink uri="srt://${BIND_ADDR}:${port}?mode=listener" latency=${SRT_LATENCY} sync=false &
  fi
  PIDS+=($!)
  STREAM_COUNT=$((STREAM_COUNT + 1))
done

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

# Apply C930e settings after pipelines open the device
if [ -n "$C930E_DEV" ]; then
  (sleep 3 && v4l2-ctl -d "$C930E_DEV" \
    --set-ctrl=zoom_absolute=100 \
    --set-ctrl=exposure_auto=1 \
    --set-ctrl=exposure_absolute=3 \
    --set-ctrl=gain=32 \
    --set-ctrl=backlight_compensation=0 \
    --set-ctrl=brightness=128 \
    && echo "Applied C930e settings") &
fi

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
