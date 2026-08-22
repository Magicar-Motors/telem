# OBS setup

The receiving half of the stream: three SRT callers that dial the Jetson's
cameras and mic, plus the browser overlays. Committed so it survives a machine
rebuild and so a second person can run the broadcast without rebuilding scenes
by hand.

```bash
./sync.sh import     # repo -> OBS  (quit OBS first, it rewrites config on exit)
./sync.sh export     # OBS -> repo  (after tweaking scenes; key is stripped)
```

Import backs up whatever is already there as `*.bak`, then you pick
**Scene Collection → telem** and **Profile → telem** in OBS.

A machine still on OBS's default names needs `COLLECTION=Untitled
PROFILE=Untitled ./sync.sh export`, or can just import once to pick up `telem`
alongside what it already has.

## What you still have to do by hand

- **Paste your Twitch stream key.** `profile/service.json` ships with it blank —
  a live key must never land in this repo, and `export` strips it every time.
- **Start the overlays.** The three browser sources load `localhost:5173`, which
  is the Vite dev server, so `cd client && npm run dev` before going live. The
  telem server doesn't serve those pages.
- **Repoint the audio sources.** `Audio Input Capture` grabs the built-in mic and
  `Discord` captures the Discord app; both resolve per-machine.

## Sources

| Source | What it is |
|---|---|
| Camera 1 | SRT caller → `gearados-nx:9000` — C930e, always this port |
| Camera 2 | SRT caller → `gearados-nx:9001` |
| Engine Mic | SRT caller → `gearados-nx:9002`, `mpegts` input format |
| Map / Lap times / Car Data | Browser overlays from the Vite dev server |
| Audio Input Capture / Discord | Local commentary audio |

Stream settings live in `profile/basic.ini`: 1920x1080 base scaled to 720p30,
6 Mbps via `apple_h264`. Recording paths use a `__HOME__` placeholder that
`sync.sh` swaps for the importing machine's home directory.

See the root README for the Jetson side and the SRT latency units gotcha.
