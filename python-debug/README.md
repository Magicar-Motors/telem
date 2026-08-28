# python-debug — UDP link probe

Measures the raw UDP path between the car (Jetson, `gearados-nx`) and the
ground station over Tailscale: **round-trip time, jitter, and drop rate**, at
the same shape as the telemetry load (1 KB @ 25 Hz ≈ 0.2 Mbit/s).

This is deliberately separate from the telemetry server and SRT — it tells you
whether the *link* is dropping packets before you go blaming the app.

## Files

| file | runs on | what it does |
|---|---|---|
| `udp_probe.py` | Jetson | sends the packets, times the echoes, reports RTT + round-trip loss |
| `udp_echo.py` | ground station | receives + echoes, reports **uplink-only** loss and arrival jitter |
| `udp_common.py` | both | packet format, percentiles |
| `deploy.sh` | here | rsyncs this folder to the Jetson |

## Run it

```bash
./deploy.sh                       # or ./deploy.sh gearados@gearados-nx
python3 udp_echo.py               # terminal 1, here
```

```bash
# terminal 2
ssh gearados@gearados-nx 'python3 ~/python-debug/udp_probe.py --host sudeshs-m1-macbook-pro'
```

Both sides print a line per second and a summary on ctrl-c (or when
`--duration` expires on the probe).

## Reading the output

The two summaries answer different questions, and you need both:

- **`udp_echo.py` → "packets lost"** is the *uplink* only (car → home). This is
  the leg that shares the 5G upload with the video streams, so it's the one
  that usually hurts.
- **`udp_probe.py` → "round-trip loss"** counts a packet dropped in *either*
  direction. Subtract the uplink loss and what's left went missing on the way
  back.

RTT needs no clock sync — the sender's own timestamp rides along in the packet
and comes home again, so it's measured entirely on the Jetson's clock. For
reference, the SRT config is tuned for ~150 ms RTT (see the root `README.md`),
so a p95 well above that is a real finding.

Arrival jitter on the echo side is the deviation from the expected 40 ms
spacing; RTT jitter on the probe side is the RFC 3550-style difference between
consecutive packets.

## Useful flags

```bash
--duration 300          # run 5 min instead of the default 60 s (0 = forever)
--rate 50 --size 1400   # push harder; 1400 B stays under a 1500 B MTU
--echo-size 64          # keep the return leg tiny to isolate uplink congestion
--timeout 5             # count an echo as lost only after 5 s (bad links)
```

`udp_echo.py --rate 50` too, if you change the probe rate — the echo side uses
it to compute expected packet spacing for jitter.

## Gotchas

- **macOS firewall.** If the echo server sees nothing, macOS is likely dropping
  inbound UDP. Allow incoming connections for `python3`, or turn the firewall
  off for the test: System Settings → Network → Firewall.
- **Port 9100** is the default here; 9000–9002 are the SRT streams, don't reuse
  those.
- **Run it while streaming** to see the loss that actually matters. A clean
  result on an idle link tells you very little.
- The Jetson is on Python 3.8, so keep this code 3.8-compatible.
