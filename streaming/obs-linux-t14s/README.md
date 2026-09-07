# OBS setup — T14s (Linux)

The Linux half of the broadcast config. `../obs` holds the Mac's; this holds
the T14s's, and the two are deliberately separate — a profile pins an encoder
(`apple_h264` on the Mac, x264/VAAPI here) and Flatpak puts OBS's config
somewhere different, so one shared export would break whichever machine
imported it second. The scene collections are the same setup either way.

```bash
./sync.sh export     # live OBS -> here
./sync.sh import     # here -> live OBS  (quit OBS first, it rewrites on exit)
```

The wrapper just points `../obs/sync.sh` at this machine's paths and names:
`OBS_DIR=~/.var/app/com.obsproject.Studio/config/obs-studio`, collection and
profile both `Untitled`. Override any of them inline if yours differ.

Import backs up whatever is already there as `*.bak`, then you pick
**Scene Collection → Untitled** and **Profile → Untitled** in OBS.

## What you still have to do by hand

- **Paste your Twitch stream key.** Never committed — `export` strips it, and
  this machine has no `profile/service.json` yet because nothing has been
  streamed from it.
- **Start the overlays.** The three browser sources load `localhost:5173`, the
  Vite dev server, so `cd client && npm run dev` before going live. The telem
  server does not serve those pages.
- **Check the audio sources.** Anything capturing a local app or the built-in
  mic resolves per-machine.

## Sources

| Source | What it is |
|---|---|
| c1 | SRT caller → `gearados-nx:9000` — C930e, always this port |
| rear view | SRT caller → `gearados-nx:9001` |
| Mic | SRT caller → `gearados-nx:9002` |
| Map / Car Data / lapdata | Browser overlays from the Vite dev server |

## Known gap

`profile/basic.ini` is a stub — `[General] Name=Untitled` and nothing else.
OBS writes profile settings (resolution, encoder, bitrate, recording paths) on
exit, and the export ran while OBS was open, so there was nothing more on disk
to capture. Quit OBS and re-run `./sync.sh export` to fill it in; until then an
import gives you the scenes but leaves output settings at OBS defaults.

See the root README for the Jetson side and the SRT latency units gotcha.
