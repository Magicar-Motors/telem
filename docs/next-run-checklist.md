# Next car run — pending actions

**Written 2026-08-28.** Everything here is left over from the 2026-08-23 track day
and needs the car powered on and back on the tailnet. Work top to bottom; item 1
gates item 2.

---

## 1. Restart `telem-server` onto `8a8ce33`

The WAL seq fix is on the car's disk but **not running** — the pull landed on
2026-08-23 while the service was already up, and the car went off the tailnet
before it could be restarted. Until this happens the car can still restart its
seq counter at 0, which is what killed the live feed for 37 minutes that day.

```bash
ssh -t gearados@gearados-nx 'sudo systemctl restart telem-server'   # needs your password
```

Verify:

```bash
ssh gearados@gearados-nx 'cd ~/repos/telem && git log --oneline -1'   # want 8a8ce33 or later
journalctl -u telem-server -n 20 --no-pager | grep -i "wal:"
curl -s http://gearados-nx:4400/stats | python3 -m json.tool | head
```

`seq` must **continue** from where it was, not restart near 0. If the fast path
did come back low you'll see the fix announce itself:

```
wal: recovered seq 0 is behind the index (95062) — resuming at 95062
```

That line is a success, not a failure — but note it, because it means the
newest generation was empty and it's worth knowing how often that happens.

## 2. Stop and trim `JACKY DAY 2`

Session `d4163a30-b9e0-45e4-97f7-7e834c05dd2b`, created **2026-03-22**, still
`running: true`. It has been absorbing every lap driven since, including all of
the August track day — 73 laps and counting, on track `sonoma`. Anything driven
before this is fixed lands in it too, so do this early.

Keep laps 1–19 (the real March 22 session, last one ends `endSeq 3988590` =
`2026-03-22T22:59Z`). Drop 20–73: lap 20 is a 152-day "lap" spanning March to
August, and everything after it belongs to the August running.

**Order matters.** `PATCH {running:false}` rewrites `body.laps` from the live
session and appends an in-lap (`server/src/http.ts`, the stop path), so a trim
sent in the same request is discarded. Stop first, trim second:

```bash
python3 - <<'PY'
import json, urllib.request
BASE, SID = "http://gearados-nx:4400", "d4163a30-b9e0-45e4-97f7-7e834c05dd2b"

def patch(body):
    req = urllib.request.Request(f"{BASE}/sessions/{SID}", method="PATCH",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=8))

s = [x for x in json.load(urllib.request.urlopen(f"{BASE}/sessions", timeout=8))
     if x["id"] == SID][0]
keep = s["laps"][:19]
assert keep[-1]["endSeq"] == 3988590, "lap 19 boundary moved — stop and re-check"

patch({"running": False})       # appends a bogus in-lap; the next call drops it
print("laps after trim:", len(patch({"laps": keep})["laps"]))   # want 19
PY
```

## 3. Repair `Jacky Track Day 2 Stint 1`

That session recorded straight through the 2026-08-23 seq reset, so its lap
pointers are broken:

```
lap 2  seq 7266182..8236    start > end
lap 3  seq 8236..15501      resolves to March/1970 entries
lap 4  seq 15501..30982     same
```

Do this **last**, after items 1 and 2. `repairSessions()` rewrites session JSON
on disk while the running server holds the same sessions in memory, so a live
`telem-server` will clobber the repair on its next save. Stop it first:

```bash
ssh -t gearados@gearados-nx
sudo systemctl stop telem-server
cd ~/repos/telem/server && npx tsx scripts/repair-sessions.ts --data-dir ./data
sudo systemctl start telem-server
```

Then spot-check that laps 3–4 replay as August data, not 1970. The 757 s and
1267 s lap *times* are a separate casualty — the detector lost crossings while
the server was down — and no seq repair recovers those.

## 4. Cleanup

`~/pre-pull-20260823/` on the car holds three files moved aside before the pull
(`udp-sender.ts`, `udp-sender.test.ts`, `wal.ts.bak-*`). All three were verified
byte-identical to what's now in git, so the directory can be deleted.

---

## Ground station, for reference

Nothing pending — just don't forget it when you set up:

```bash
cd udp-client-receiver && RECEIVER_DELAY_MS=1200 npm start
```

1200 ms is what we settled on to match video latency, and it's why the dashboard
reads `skew ≈ +1.2s`. That is the hold, not lag. The committed default is 1000,
so a bare `npm start` gives you 1 s.
