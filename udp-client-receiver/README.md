# udp-client-receiver

Ground-station receiver for the live telemetry feed. Runs **on your laptop**, not
on the car.

The car pushes merged telemetry ticks over UDP. Browsers can't receive UDP, so
this process terminates the lossy transport locally and re-serves it as SSE over
loopback, where TCP is free and nothing can congest.

```
car :4400 ──UDP msgpack ticks──▶ :4402 udp-client-receiver :4401 ──SSE──▶ browsers
                                        └── lease renewal ──▶ car
```

## Why it exists

Live telemetry used to be SSE over TCP straight from the car. On a lossy 5G link
that meant TCP retransmitting samples that were already obsolete, and Node
buffering writes without bound — telemetry ran **14 seconds behind and never
recovered**. UDP drops stale data instead of queueing it, so the feed degrades
into gaps rather than falling behind. Replay is unaffected: `/wal/range` still
pulls complete data from the car's WAL.

It also collapses fan-out. Every open page used to be its own stream across the
cell link (~5 streams, ~2.6 Mbps). Now the car sends **one** UDP stream per
laptop at ~136 kbps, and every browser on this machine shares it.

## Running

```bash
npm install
npm start
```

Then open the dashboard normally — no `?local` flag. Pages find the receiver at
`http://localhost:4401` by default.

For local development against a server on this machine:

```bash
JETSON_URL=http://localhost:4400 npm start
```

## Every laptop runs its own

Receivers are independent — one per machine, each its own UDP subscriber on the
car. No laptop proxies for another, so a machine that sleeps or crashes takes
only itself down. Cost is ~136 kbps of uplink per laptop; the car caps
subscribers at 4.

## Config

| Env | Default | |
|---|---|---|
| `JETSON_URL` | `http://gearados-nx:4400` | The car |
| `RECEIVER_HTTP_PORT` | `4401` | SSE out to browsers |
| `RECEIVER_UDP_PORT` | `4402` | Ticks in from the car |
| `RECEIVER_HTTP_HOST` | `127.0.0.1` | Loopback only by design |
| `LEASE_TTL_MS` | `15000` | Renewed every TTL/3 |
| `RECEIVER_DELAY_MS` | `1000` | Hold ticks this long before publishing, to match video latency |
| `RECEIVER_TEST_DROP_PCT` | `0` | Dev only — discard N% of datagrams |

## Endpoints

- `GET /stream` — SSE, `event: tick` (`{seq, ts, d}`) plus `event: hb` every 1s
- `GET /stats` — counters: `received`, `lost`, `reordered`, `lossPct`, `leaseOk`
- `GET /health`

## Checking it

```bash
curl -s localhost:4401/stats                    # received climbing, lossPct low
curl -s localhost:4400/live/udp/subscribers     # your lease, on the car
```

Simulate a bad link without touching the network:

```bash
RECEIVER_TEST_DROP_PCT=25 npm start
```

`loss` on the dashboard should read ~25% while `lag` stays near zero — degrading
rather than falling behind is the entire point.

## Troubleshooting

**`received` stays 0 but `leaseOk` is true.** The car thinks it's sending and
nothing arrives — almost always the macOS firewall dropping inbound UDP on 4402.
Allow the `node` binary under System Settings → Network → Firewall.

**`[lease] subscribe failed`, retrying.** The car isn't reachable. Normal between
sessions; it retries forever with backoff and picks up when the car boots.

**Dashboard says DISCONNECTED.** That's the browser↔receiver hop, not the link.
Check this process is up and `curl localhost:4401/health`.

**`EADDRINUSE 0.0.0.0:4402`.** Another receiver is already running.
