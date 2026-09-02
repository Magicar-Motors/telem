# Post-hoc analysis modules

Implementation spec for traction utilization, grade correction, and wheel
power. Written against the channels this car actually logs.

## Status of the stated precondition

The source spec assumes "the shared ingest layer (resampling, distance axis,
lap validity, `ay` de-biasing, sign convention) already exists." **It does
not.** What exists today is a forward-fill loop, written three times:

- `client/src/review.ts` — `selectLap()`, per-tick arrays
- `client/src/review.ts` — `drawAggregateTrails()`, the same loop again
- `client/src/compare.ts` — a third copy

Each walks WAL ticks, carries the last seen value of every channel forward,
and emits one sample per tick that has a GPS fix. That gives non-uniform
timing, no distance axis, no de-biasing, and a sign convention that only
exists implicitly inside `toDisplayAxes()`.

So module 0 below is not optional groundwork — it is the bulk of the work,
and all three modules are blocked on it.

```
┌──────────────────────────────────────────────────────────────┐
│ WAL ticks   { seq, ts, d: { channel: value } }   sparse      │
└───────────────────────────┬──────────────────────────────────┘
                            │
                ┌───────────▼────────────┐
                │  MODULE 0  ingest      │  ← does not exist yet
                │  forward-fill          │
                │  resample 20 Hz        │
                │  distance axis         │
                │  ay de-bias            │
                │  sign convention       │
                │  quality flags         │
                └───────────┬────────────┘
                            │  LapFrame[]
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
│ 1  traction    │  │ 2  grade       │  │ 3  wheel power │
│    envelope    │  │    correction  │  │                │
│                │  │                │◄─┤ needs sin_th   │
│ session-scoped │  │  per sample    │  │ + a_gps        │
└────────────────┘  └────────────────┘  └───────┬────────┘
                                                │
                                        ┌───────▼────────┐
                                        │ coastdown fit  │
                                        │ Cd*A, Crr      │
                                        └────────────────┘
```

## Channel inventory

Confirmed present. Units are as logged, and they are not the units the
equations want.

| Channel | Source | Logged unit | Rate |
|---|---|---|---|
| `gps_lat` / `gps_lon` | RaceBox | deg, 1e-7 | 23.9 Hz |
| `gps_speed` | RaceBox | **km/h** | 23.9 Hz |
| `gps_altitude` | RaceBox | **m**, 0.1 m resolution | 23.9 Hz |
| `gps_heading` | RaceBox | deg | 23.9 Hz |
| `gps_satellites` / `gps_fix` | RaceBox | count / enum | 23.9 Hz |
| `g_force_x` / `_y` / `_z` | RaceBox | **g** | 23.9 Hz |
| `gyro_x` / `_y` / `_z` | RaceBox | deg/s | 23.9 Hz |
| `throttle_pos` | Mega A9 | % | 25 Hz |
| `rpm` | Mega D18 | rpm, EMA α=0.3 | 25 Hz |
| `brake` | Mega A5 | 0/1 | 25 Hz |
| `manifold_pressure` | Mega A10 | kPa | 25 Hz |
| `coolant_temp` / `oil_temp` | Mega A8 / A1 | °C | 25 Hz |
| `oil_pressure` | Mega A0 | psi | 25 Hz |
| `vss_hz` | Mega D19 | Hz | 25 Hz |

**Not available:** ambient temperature and barometric pressure. `rho` falls
back to 1.225 kg/m³, as the source spec allows. Nothing else needs them.

**`gyro_x` is available and unused.** Roll rate is logged but nothing reads
it. See the roll caveat under module 1 — this is the channel that could
partially address it.

### Unit discipline

Two conversions cause every unit bug in this area, so the ingest layer does
them once and everything downstream works in SI:

```
v [m/s]    = gps_speed / 3.6
a [m/s^2]  = g_force_* * 9.80665
```

`LapSample` stores SI. Display converts back at the edge, as `KMH_TO_MPH`
already does.

---

## Module 0 — ingest

`server/src/analysis/ingest.ts`, pure functions, no I/O.

Placement follows the existing precedent: `server/src/gear.ts` is imported by
`client/src/charts.ts` and by `server/scripts/gen-data.ts`. Pure math lives
under `server/src/`, both sides import it, and there is no `shared/`.

### Types

```ts
export interface LapSample {
  t: number;         // s since lap start, uniform step
  s: number;         // m along the track centerline
  lat: number;
  lon: number;
  v: number;         // m/s
  aLong: number;     // m/s^2, forward positive  (see sign convention)
  aLat: number;      // m/s^2, right-turn positive, de-biased
  alt: number;       // m, smoothed
  throttle: number;  // %
  rpm: number;
  brake: number;     // 0/1
  gapMs: number;     // age of the oldest carried-forward channel
}

export interface LapFrame {
  lapIdx: number;
  flag: "clean" | "yellow" | "pit" | "out" | "in";
  dt: number;               // uniform step, s
  lengthM: number;          // centerline length used for the s axis
  samples: LapSample[];
  quality: LapQuality;
}

export interface LapQuality {
  minSatellites: number;
  maxGapMs: number;         // worst forward-fill staleness
  aLatBias: number;         // g, the offset that was removed
  gradeDivergenceRms: number; // m/s^2, |a_gps - a_imu|, module 2
  usable: boolean;
}
```

### Resample rate

**20 Hz (`dt = 0.05`).** Below both source rates, so every output sample is
interpolated down rather than invented. A braking event of 1–3 s still gets
20–60 samples, which is ample for a 99.5th percentile and for segment means.

Make it a parameter, but do not raise it above 23.9 Hz — that upsamples GPS
and puts structure into `aLong` that the sensor never measured.

### Forward-fill and staleness

Carry-forward is unavoidable: channels arrive interleaved, not in step. But
carrying a value forward for 40 ms is different from carrying it for 2 s
after a dropout, and today nothing distinguishes them.

Record `gapMs` per sample as the age of the oldest channel contributing to
it. Samples above a threshold (start at 250 ms) are excluded from envelope
fits and power bins, though they still render on the trail.

### Distance axis

`s` must come from the **track centerline**, not cumulative GPS distance.
Segment binning compares the same corner across laps; a per-lap driven-distance
axis drifts with line choice and the bins stop aligning.

```
s = trackProgress(centerline, lat, lon) * centerlineLength
```

`trackProgress()` in `client/src/track-utils.ts` recomputes cumulative segment
distances on every call, so calling it per sample is O(n·m) — roughly 274
centerline points × ~2200 samples per lap. `server/src/lap-detector.ts` already
precomputes `segDists` once in its constructor. Hoist that shape into the
analysis module: build the segment table once per track, pass it in.

Sonoma's centerline is ~4 km, so 20 bins is ~200 m, matching the source spec.

### `ay` de-bias

Mounting angle puts a constant offset on lateral g. Estimate per session, not
per lap:

```
bias = median( aLat  where |aLat| < 0.2 g and v > 20 m/s )
```

Straight-line, high-speed samples should average zero lateral. Median rather
than mean so a long banked straight does not drag it. Record the value in
`LapQuality.aLatBias` — if it moves between sessions the box was remounted,
and that is worth seeing.

### Sign convention — unresolved, and the source spec is internally inconsistent

This needs settling before any of the three modules is correct.

The existing code establishes that `g_force_x` is **positive under
acceleration**. `client/src/gcircle-renderer.ts`:

```ts
export function toDisplayAxes(gx: number, gy: number): GPoint {
  return { x: -gy, y: -gx };   // braking(+) = up  ⇒  braking ⇒ gx < 0
}
```

The source spec then says two things that cannot both hold:

- Module 1: `mu_x = percentile(ax[ax > 0], 99.5)` — the *braking* limit, so
  `ax > 0` means braking.
- Module 2: `a_imu = -g_force_x - sin_th`, compared against
  `a_gps = dv/dt`, which is positive when speeding up. For that comparison to
  mean anything, `a_imu` must also be forward-positive — which makes
  `-g_force_x` forward-positive, i.e. `g_force_x` braking-positive.

Module 1 wants `ax` braking-positive while module 2 needs `-g_force_x`
forward-positive. Both cannot be true, and one of them contradicts
`toDisplayAxes()`.

**Resolution.** `LapSample.aLong` is **forward positive**, matching
`a_gps = dv/dt` so the two are directly comparable. Module 1's braking term
becomes `max(-aLong, 0)`. Then verify empirically before trusting any output:

> Take one clean lap, plot `aLong` against `dv/dt`. Positive correlation
> means the convention is right. Negative correlation means `g_force_x`
> needs flipping in the ingest layer, in exactly one place.

Add this as an assertion in the ingest layer, not a comment: if the
correlation over a lap is negative, mark `usable: false` and surface it.

---

## Module 1 — traction envelope and utilization

`server/src/analysis/traction.ts`

### Envelope fit

Session-scoped. A single lap has too few limit-adjacent samples.

```
mu_y = percentile(abs(aLat), 99.5)
mu_x = percentile(max(-aLong, 0), 99.5)     braking only
```

Sample eligibility, all required:

- lap `flag === "clean"`
- **not the first clean lap of the session** — cold tires read ~0.99 g against
  ~1.13 g warm; including it drags `mu_y` down and inflates every subsequent
  utilization number. The `flag` field already marks lap 1 as `"out"`, but the
  first *flying* lap is the first `"clean"` one, so this is a separate exclusion
  and easy to miss.
- `gapMs` under threshold
- `minSatellites >= 5`

Percentile, never max. Curb strikes spike past 1.5 g and blow out the ceiling.

### Per-sample utilization

```
u = sqrt( (aLat / mu_y)^2 + (max(-aLong, 0) / mu_x)^2 )
```

Acceleration is deliberately excluded — the car is power-limited on exit
(~0.22 g measured against a ~0.57 g traction ceiling), so including it reports
false slack on every corner exit and buries the real findings.

### Outputs

| Output | Definition |
|---|---|
| Mean utilization | Time-weighted mean of `u` over the lap |
| Distribution | Histogram, bins 0–30 / 30–50 / 50–70 / 70–85 / 85–100 / >100 % |
| Segment map | `u` binned by `s`, 20 bins |
| Per-segment | mean `u`, duration, `v_avg`, `v_min`, peak `abs(aLat)`, peak braking |

Uniform `dt` makes the time-weighted mean a plain mean. That is a large part
of why module 0 resamples.

### Caveats — render these next to the numbers

**A body-mounted IMU reads chassis roll and track banking as lateral g.**
`mu_y` is optimistic by an unknown amount. The error inflates ceiling and
usage together, so the *ratio* is reasonably robust; the absolute number is
not. Label the axis accordingly.

Suspension position sensors would fix this properly. Short of that,
`gyro_x` (roll rate, already logged, currently unread) integrates to a roll
angle estimate that would at least bound the error. Worth a spike before
trusting absolute `mu_y`.

**Low utilization on a straight is not slack.** Always show `u` next to
`v_avg`. 10% at 127 kph is a straight; 24% at 83 kph is a finding. A segment
table that omits `v_avg` will generate false findings on every straight, so
this is a hard UI requirement, not a nicety.

### Cost note

The envelope needs every clean lap in the session, so the client must fetch
all of them. `drawAggregateTrails()` already does exactly this and is the
precedent to follow — same IndexedDB cache, same stale-while-revalidate path.
Compute the envelope once per session and memoize; do not recompute per lap
selection.

---

## Module 2 — grade correction

`server/src/analysis/grade.ts`

Sonoma runs ~170 m of elevation per lap with instantaneous grades to 15%. A
10% grade contributes 0.10 g; measured longitudinal accelerations run
0.08–0.17 g. **The error term is the same size as the signal.** Every
longitudinal number and the whole of module 3 depend on this.

### Grade

```
alt_s  = smooth(gps_altitude, ~0.6 s window)      // 12 samples at 20 Hz
sin_th = d(alt_s) / d(s)                          // clamp to +/- 0.15
```

GPS altitude is much noisier than GPS position and needs a heavier window
than any other channel. Clamp before use — unclamped outliers produce
nonsense at low speed, where `d(s)` approaches zero. Guard that division
explicitly: below ~2 m/s, hold the previous grade rather than dividing.

### Two independent longitudinal accelerations

Compute both. Different sensors; their disagreement is the quality signal.

```
a_gps = d(v) / dt                        // grade-free by construction
a_imu = aLong - g * sin_th               // gravity component removed
```

Both in m/s², both forward-positive per module 0.

Where they diverge, the altitude channel is unreliable in that section.
Expose it as `gradeDivergenceRms` per segment rather than silently preferring
one source. A section with high divergence should visibly de-rate any power
number computed across it.

### Derived channels

`grade_pct`, `a_long_corrected`, `a_long_raw` — computed, not necessarily
user-visible, but available to module 3.

---

## Module 3 — wheel power

`server/src/analysis/power.ts`

Surfaces driveline losses — notably wheelspin on exit, which shows up as a
power shortfall at low speed that is absent at high speed.

### Road load

```
F        = m*a + m*g*sin_th + 0.5*rho*Cd*A*v^2 + Crr*m*g
P_wheel  = F * v
```

Use `a_gps` from module 2. `rho = 1.225` (no ambient sensors).

Strictly the rolling term is `Crr*m*g*cos(th)`; at 15% grade `cos(th)` is
0.989, so the simplification costs ~1%. Below the noise floor here, but note
it so nobody rediscovers it as a bug.

### Configuration — per car, not hardcoded

New `server/src/vehicle.ts`. Today the vehicle constants that exist (tire
circumference, gear ratios, final drive) are buried at the top of
`server/src/gear.ts`; those move here too so there is one place for them.

| Parameter | Source | Status |
|---|---|---|
| `m` | Corner scales, with driver and race fuel | **needed** |
| `Cd * A` | Coastdown | **needed** |
| `Crr` | Coastdown | **needed** |
| `eta` | Driveline efficiency, ~0.85, crank estimate only | assumed |
| `I_wheel`, `r` | Refinement below | later |

Output is highly sensitive to all of these. Ship the config with explicit
`source: "measured" | "assumed"` per field and show it in the UI — a power
number built on assumed mass and assumed `Cd*A` should not look identical to
one built on scale weights and a coastdown fit.

### Sample filter

```
throttle_pos > 85
abs(aLat) < 0.4 g          exclude cornering
valid dt, aLong > -0.5 g
gapMs under threshold
```

### Report

Percentiles p50 and p90, binned by speed: 60–80 / 80–95 / 95–110 / 110–125 /
125–140 kph.

**Always display `n` per bin.** Low-speed bins have far fewer samples and are
correspondingly less trustworthy. A bin under ~50 samples should render
visibly de-rated rather than as a number.

### Coastdown calibration

This is what makes the power number trustworthy. Estimates on assumed `Cd*A`
and mass have swung more than 10 whp on assumption changes alone — the
difference between "engine is healthy" and "engine is down 20%."

**Procedure.** From ~140 kph: clutch in, neutral, hands off, coast to ~50 kph
on the flattest section available. Two runs in opposite directions to cancel
residual grade and wind. Log `gps_speed` and `gps_altitude`.

**Fit:**

```
-a(v) = A + B*v^2

A = Crr * g              ->  Crr
B = 0.5*rho*Cd*A / m     ->  Cd*A
```

Ten minutes of track time, and it removes the largest error source in the
module.

**Implementation.** `server/scripts/coastdown-fit.ts` — takes a WAL seq range,
runs the ingest layer, least-squares fits A and B over the two runs, prints
`Crr` and `Cd*A` with residuals, and writes them into `vehicle.ts` with
`source: "measured"`. A one-off script, not a UI: it runs twice a year.

Note `B` depends on `m`, so `Cd*A` is only as good as the mass figure. Corner
scales first, then coastdown.

### Refinement — effective mass

```
m_eff = m + 4 * I_wheel / r^2
```

Adds ~3–5% during acceleration. Matters at low speed where the inertia term
dominates, negligible at 140 kph where drag does. Do this after coastdown,
not before — it is a smaller correction than the one coastdown removes.

---

## Build order

Each step is independently verifiable, which matters because errors here are
silent — a wrong sign or a stale unit produces plausible numbers, not a crash.

1. **Module 0 ingest**, and settle the sign convention empirically. Port
   `selectLap()` onto it and confirm the review page renders identically.
   That is the regression test: same trail, same seek, same g-circle.
2. **Collapse the other two forward-fill copies** (`drawAggregateTrails`,
   `compare.ts`) onto the ingest layer. Three copies is why this layer was
   assumed to exist.
3. **Module 2 grade** — cheap, no config, and it gates module 3. Validate by
   checking that per-lap elevation gain sums to ~0 around a closed circuit.
4. **Module 1 traction** — needs only module 0. Validate `mu_y` against the
   ~1.13 g warm figure.
5. **Corner scales**, then **coastdown**, then **module 3**. Power before
   calibration is a number nobody should act on.

## Open questions

- **Mass.** Nothing usable until the car is scaled with driver and fuel. Is
  that scheduled? It blocks module 3 and the `Cd*A` fit both.
- **Where does the envelope get computed** — client-side per session like the
  aggregate view, or server-side and cached alongside the session JSON? Client
  matches the offline-first cache design; server avoids refetching every clean
  lap on each page load.
- **Does `gyro_x` roll integration earn its keep** for bounding the roll
  error in `mu_y`, or is the ratio-robustness argument enough to ship on?
- **Is the first-clean-lap exclusion always right?** On a two-lap session it
  discards half the data. Fall back to including it, flagged, or refuse to
  fit an envelope at all below some lap count?
