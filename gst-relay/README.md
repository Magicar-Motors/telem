# Raw SRT → local/LAN UDP relay

From the repository root:

```bash
brew install gstreamer
./gst-relay/start-relays.py 192.168.1.50
```

Replace the address with the second laptop's LAN IPv4 address. Requires Python
3 and GStreamer's `srtsrc` and `multiudpsink` plugins (bundled by Homebrew).
Only the relay laptop runs this script. It must be connected to Tailscale so
`gearados-nx` resolves and is reachable. The second laptop just needs OBS.

The launcher starts four independent pipelines, each receiving SRT once and
sending the original MPEG-TS payload bytes to both `127.0.0.1` and the supplied
LAN address. There is no MPEG-TS demux/remux or video encode in the relay.
`multiudpsink` sends without clock synchronization (`sync=false`).

| Feed | Jetson SRT port | OBS Media Source Input on either laptop |
|---|---|---|
| Pedal | 9000 | `udp://0.0.0.0:10000` |
| Driver | 9001 | `udp://0.0.0.0:10001` |
| Mic | 9002 | `udp://0.0.0.0:10002` |
| Front | 9003 | `udp://0.0.0.0:10003` |

In OBS, uncheck **Local File**, use Input Format `mpegts`, Buffering **0 MB**,
and Reconnect Delay **1s**. Enable hardware decoding for the video sources.
Allow incoming UDP ports **10000–10003** on the second laptop. Use one receiver
per UDP port on each machine; reuse existing OBS sources across scenes.
Stop the MediaMTX relay / direct Jetson viewers when switching to this relay
to avoid duplicate pulls from the car.

Keep the terminal and relay laptop awake. **Ctrl-C stops every child pipeline**.
Failed pipelines retry independently after two seconds; a missing camera does
not stop the other feeds. GStreamer may also reconnect internally. Logs append
to `gst-relay/logs/{pedal,driver,mic,front}.log`; process startup does not itself
prove that the sender is online. To inspect a feed:

```bash
tail -f gst-relay/logs/front.log
```

Optional overrides and command preview:

```bash
./gst-relay/start-relays.py 192.168.1.50 --source-host gearados-nx
./gst-relay/start-relays.py 192.168.1.50 --latency-ms 100
./gst-relay/start-relays.py 192.168.1.50 --dry-run
```

The receive request defaults to 100 ms. The current Jetson script requests
**800 ms**, so the negotiated SRT delay remains at least 800 ms if that script
is deployed. This relay removes the *second* SRT hop and intermediate media
processing; it cannot override the sender's recovery budget. UDP on the LAN
has no retransmission, so prefer Ethernet when minimizing delay and loss.
Changing the second laptop's IP requires restarting the launcher.

Verified with Homebrew GStreamer 1.28.7: all four synthetic SRT feeds delivered
byte-identical MPEG-TS datagrams to both loopback and this Mac's LAN address,
and Ctrl-C stopped all four relay processes. This verifies local fan-out;
reception through the second laptop's firewall still needs a live check.
