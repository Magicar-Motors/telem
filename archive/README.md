# archive

Exported telemetry, kept here because the car is the only other copy.

Each `.telem` is a gzipped dump of the review page's IndexedDB store — the same
format `EXPORT` writes and `IMPORT` reads. Restore one by opening
`/review.html` and clicking **IMPORT CACHE**; it writes every key into that
origin's store and reloads. Nothing else reads these files.

## `2026-08-22_23-sonoma-bypass.telem`

Exported 2026-08-28 from the Safari cache on `localhost:5173`. Both August track
days, all on the Sonoma Raceway Bypass layout. 22 MB gzipped, 272 MB raw:
79 keys, 1,009,221 ticks.

Recompressed with `gzip -9` after export — the browser's `CompressionStream`
writes at the default level, and the payload is byte-identical (same SHA-256 on
the decompressed JSON), so `IMPORT CACHE` reads it exactly the same. Worth
repeating on future exports: `gunzip -c in.telem | gzip -9 > out.telem`.

| Session | Laps | Traces cached |
|---|---|---|
| Grace Track D1S1 | 4 | 4 |
| Gordon Track D1S1 | 7 | 7 |
| Grace Track D1S2 | 7 | 7 |
| Gordon Track D1S2 | 8 | 8 |
| Grace Track D1S3 | 8 | 8 |
| Jacky Track D2S1 | 4 | 4 |
| Sudesh Track D2S1 | 6 | 6 |
| Jacky Track D2S2 | 6 | 6 |
| Sudesh Track D2S2 | 6 | 6 |
| Jacky Track D2S3 | 9 | 9 |
| Sudesh Track D2S3 | 9 | **1** |
| **Total** | **74** | **66** |

Lap times, deltas and best laps are complete for all 11 sessions. What's partial
is the per-lap tick data behind the map trace and the speed/throttle/RPM charts:
`Sudesh Track D2S3` is missing 8 of 9. Re-export after syncing that session to
close the gap — see item 5 in [next-run-checklist](../docs/next-run-checklist.md).

Two quirks worth knowing before you trust what you see:

- **The filename lies about scope.** `EXPORT` always dumps the whole store; the
  selected session only names the file. The original name was
  `telem-sonoma_bypass-44ff141a-2026-08-28.telem`, which reads as one session.
- **Day 1 sessions carry their older names inside.** The per-session entries were
  cached as `Grace Track Day 1 Stint 1` etc., before the later rename to
  `Grace Track D1S1`. The session list was cached after, so the sidebar and the
  detail view disagree. Same sessions, same ids.

**Three lap entries in here hold the wrong data**, inherited from the 2026-08-23
seq reset on the car. `Jacky Track D2S1`'s pointers span the reset, so two of its
laps resolve to March entries and one is empty:

```
/lap/7249273-7266182   16910 ticks   8/23 15:26 → 15:32     correct
/lap/7266182-8236          0 ticks                          empty (start > end)
/lap/8236-15501         7266 ticks   1970-01-01 → 3/19      wrong era
/lap/15501-30982       15482 ticks   3/19 → 3/19            wrong era
```

Anything charted from those two laps is March driving mislabelled as August. The
fix is car-side (item 3 of the checklist) and changes the seq pointers, which
changes the cache keys — so after repairing, re-sync that session and re-export,
and these entries become orphans rather than answers.

## Adding to this directory

These are already-compressed binaries, so git stores each one whole — no delta
against the previous export. Every snapshot costs its full size in history,
permanently. That's fine occasionally; if exporting becomes routine, move this
directory to Git LFS or attach the files to a release instead.

Keep them gzip. Measured on this export, `bzip2 -9` and `brotli -q11` reach
~17 MB against gzip -9's 22 MB, but the review page decompresses with
`DecompressionStream("gzip")` — anything else stops being importable without a
manual step, which is a poor trade for 5 MB on a file nobody downloads often.
