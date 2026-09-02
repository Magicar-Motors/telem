/** Module 0 — turns sparse WAL ticks into a uniform-rate lap frame.
 *
 *  Everything below this layer works in SI, forward-positive longitudinal,
 *  right-positive lateral, with a centerline distance axis. See
 *  docs/analysis-modules.md. */

const G = 9.80665;

const DEFAULT_DT = 0.05;
const DEFAULT_MAX_GAP_MS = 250;
const DEFAULT_MIN_SATELLITES = 5;

/** Channels without which a lap cannot be framed at all. */
const REQUIRED = ["gps_lat", "gps_lon", "gps_speed", "g_force_x", "g_force_y"] as const;

/** Below this much longitudinal variation there is nothing to correlate, so the
 *  sign check abstains rather than reporting a spurious zero. m/s^2. */
const SIGN_CHECK_MIN_SD = 0.5;

const CONTINUOUS = [
  "gps_lat", "gps_lon", "gps_speed", "gps_altitude",
  "g_force_x", "g_force_y", "throttle_pos", "rpm",
] as const;
const STEPPED = ["brake", "gps_satellites"] as const;

export type LapFlag = "clean" | "yellow" | "pit" | "out" | "in";

export interface Tick {
  seq: number;
  ts: number;
  d: Record<string, number>;
}

export interface LapSample {
  t: number;         // s since lap start
  s: number;         // m along the centerline, from the finish line
  lat: number;
  lon: number;
  v: number;         // m/s
  aLong: number;     // m/s^2, forward positive
  aLat: number;      // m/s^2, right-turn positive, de-biased
  alt: number;       // m
  throttle: number;  // %
  rpm: number;
  brake: number;     // 0/1
  gapMs: number;     // staleness of the oldest channel behind this sample
}

export interface LapQuality {
  minSatellites: number;
  maxGapMs: number;
  aLatBias: number;          // g, in right-positive space
  signCheckR: number | null; // corr(aLong, dv/dt); null when indeterminate
  missing: string[];
  usable: boolean;
  gradeDivergenceRms?: number; // filled by module 2
}

export interface LapFrame {
  lapIdx: number;
  flag: LapFlag;
  dt: number;
  lengthM: number;
  samples: LapSample[];
  quality: LapQuality;
}

export interface IngestOptions {
  dt?: number;
  maxGapMs?: number;
  minSatellites?: number;
  aLatBias?: number;         // g, right-positive; session-scoped
}

// ── Centerline ──

export interface Centerline {
  pts: [number, number][];
  segDists: number[];        // cumulative metres at each point
  totalM: number;
  finishProgress: number;    // 0-1, where the lap starts
}

/** Local flat-earth metres. Longitude compresses with latitude, and ignoring
 *  that skews every distance and nearest-point match east/west. */
function toMetres(lat: number, lon: number, lat0: number): [number, number] {
  const mPerDegLat = 111132.92;
  return [lon * mPerDegLat * Math.cos((lat0 * Math.PI) / 180), lat * mPerDegLat];
}

export function buildCenterline(
  pts: [number, number][],
  finishLine?: [number, number],
): Centerline {
  const lat0 = pts.length ? pts[0][0] : 0;
  const segDists = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = toMetres(pts[i - 1][0], pts[i - 1][1], lat0);
    const [x2, y2] = toMetres(pts[i][0], pts[i][1], lat0);
    total += Math.hypot(x2 - x1, y2 - y1);
    segDists.push(total);
  }
  const c: Centerline = { pts, segDists, totalM: total, finishProgress: 0 };
  if (finishLine) c.finishProgress = rawProgress(c, finishLine[0], finishLine[1]);
  return c;
}

/** Fraction 0-1 from the start of the polyline, ignoring the finish line. */
export function rawProgress(c: Centerline, lat: number, lon: number): number {
  if (c.totalM === 0 || c.pts.length < 2) return 0;
  const lat0 = c.pts[0][0];
  const [px, py] = toMetres(lat, lon, lat0);

  let bestDist = Infinity;
  let best = 0;
  for (let i = 0; i < c.pts.length - 1; i++) {
    const [ax, ay] = toMetres(c.pts[i][0], c.pts[i][1], lat0);
    const [bx, by] = toMetres(c.pts[i + 1][0], c.pts[i + 1][1], lat0);
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = (c.segDists[i] + t * (c.segDists[i + 1] - c.segDists[i])) / c.totalM;
    }
  }
  return best;
}

// ── Per-channel series, resampled onto a shared grid ──

interface Series {
  ts: number[];
  v: number[];
  cursor: number;
}

function collect(ticks: Tick[], channel: string): Series {
  const ts: number[] = [];
  const v: number[] = [];
  for (const tk of ticks) {
    const val = tk.d[channel];
    if (val !== undefined) {
      ts.push(tk.ts);
      v.push(val);
    }
  }
  return { ts, v, cursor: 0 };
}

/** Advances the cursor to the last sample at or before t. Callers must query
 *  with non-decreasing t, which the uniform grid guarantees. */
function seek(s: Series, t: number): number {
  while (s.cursor + 1 < s.ts.length && s.ts[s.cursor + 1] <= t) s.cursor++;
  return s.cursor;
}

function sampleLinear(s: Series, t: number): number {
  if (s.ts.length === 0) return 0;
  const i = seek(s, t);
  if (i + 1 >= s.ts.length) return s.v[i];
  const span = s.ts[i + 1] - s.ts[i];
  if (span <= 0) return s.v[i];
  const f = Math.max(0, Math.min(1, (t - s.ts[i]) / span));
  return s.v[i] + (s.v[i + 1] - s.v[i]) * f;
}

function sampleHold(s: Series, t: number): number {
  if (s.ts.length === 0) return 0;
  return s.v[seek(s, t)];
}

function staleness(s: Series, t: number): number {
  if (s.ts.length === 0) return Infinity;
  return Math.max(0, t - s.ts[seek(s, t)]);
}

// ── Frame ──

export function buildLapFrame(
  ticks: Tick[],
  lapIdx: number,
  flag: LapFlag,
  centerline: Centerline,
  opts: IngestOptions = {},
): LapFrame {
  const dt = opts.dt ?? DEFAULT_DT;
  const maxGapMs = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const minSats = opts.minSatellites ?? DEFAULT_MIN_SATELLITES;
  const bias = opts.aLatBias ?? 0;

  const series: Record<string, Series> = {};
  for (const ch of [...CONTINUOUS, ...STEPPED]) series[ch] = collect(ticks, ch);
  const missing = REQUIRED.filter((ch) => series[ch].ts.length === 0);

  const empty = (): LapFrame => ({
    lapIdx, flag, dt, lengthM: centerline.totalM, samples: [],
    quality: { minSatellites: 0, maxGapMs: Infinity, aLatBias: bias,
               signCheckR: null, missing: [...missing], usable: false },
  });
  if (ticks.length === 0 || missing.length > 0) return empty();

  const t0 = ticks[0].ts;
  const t1 = ticks[ticks.length - 1].ts;
  if (t1 <= t0) return empty();

  const stepMs = dt * 1000;
  const samples: LapSample[] = [];
  let minSatellites = Infinity;
  let maxGap = 0;
  let prevNorm: number | null = null;
  let wraps = 0;

  for (let tMs = t0; tMs <= t1; tMs += stepMs) {
    const lat = sampleLinear(series.gps_lat, tMs);
    const lon = sampleLinear(series.gps_lon, tMs);

    // Unwrap around the finish line so s increases monotonically through the lap.
    const norm = (((rawProgress(centerline, lat, lon) - centerline.finishProgress) % 1) + 1) % 1;
    if (prevNorm !== null && norm - prevNorm < -0.5) wraps++;
    prevNorm = norm;

    let gap = 0;
    for (const ch of REQUIRED) gap = Math.max(gap, staleness(series[ch], tMs));

    const sats = series.gps_satellites.ts.length
      ? sampleHold(series.gps_satellites, tMs)
      : minSats;
    minSatellites = Math.min(minSatellites, sats);
    maxGap = Math.max(maxGap, gap);

    samples.push({
      t: (tMs - t0) / 1000,
      s: (norm + wraps) * centerline.totalM,
      lat,
      lon,
      v: sampleLinear(series.gps_speed, tMs) / 3.6,
      aLong: -sampleLinear(series.g_force_x, tMs) * G,
      aLat: (-sampleLinear(series.g_force_y, tMs) - bias) * G,
      alt: sampleLinear(series.gps_altitude, tMs),
      throttle: sampleLinear(series.throttle_pos, tMs),
      rpm: sampleLinear(series.rpm, tMs),
      brake: sampleHold(series.brake, tMs),
      gapMs: gap,
    });
  }

  const signCheckR = signCheck(samples.map((x) => x.aLong), derivative(samples.map((x) => x.v), dt));

  return {
    lapIdx, flag, dt, lengthM: centerline.totalM, samples,
    quality: {
      minSatellites: Number.isFinite(minSatellites) ? minSatellites : 0,
      maxGapMs: maxGap,
      aLatBias: bias,
      signCheckR,
      missing: [],
      // An indeterminate sign check must not veto: a lap driven at steady
      // speed has nothing to correlate, and that is not a fault.
      usable: samples.length > 1 && maxGap <= maxGapMs
        && minSatellites >= minSats && (signCheckR === null || signCheckR > 0),
    },
  };
}

/** corr(aLong, dv/dt), or null when the lap holds too steady to judge. */
function signCheck(aLong: number[], dvdt: number[]): number | null {
  if (aLong.length < 3) return null;
  const mean = aLong.reduce((a, b) => a + b, 0) / aLong.length;
  const sd = Math.sqrt(aLong.reduce((acc, x) => acc + (x - mean) ** 2, 0) / aLong.length);
  if (sd < SIGN_CHECK_MIN_SD) return null;
  return correlate(aLong, dvdt);
}

// ── Session-scoped calibration ──

const BIAS_STRAIGHT_G = 0.2;
const BIAS_MIN_V = 20;

/** Median lateral g over straight-line, high-speed samples, which should read
 *  zero. Median not mean, so a long banked straight cannot drag it. */
export function estimateLatBias(frames: LapFrame[]): number {
  const straight: number[] = [];
  for (const f of frames) {
    for (const s of f.samples) {
      const g = s.aLat / G;
      if (Math.abs(g) < BIAS_STRAIGHT_G && s.v > BIAS_MIN_V) straight.push(g);
    }
  }
  if (straight.length === 0) return 0;
  straight.sort((a, b) => a - b);
  return straight[Math.floor(straight.length / 2)];
}

export interface LapInput {
  lapIdx: number;
  flag: LapFlag;
  ticks: Tick[];
}

/** Two passes: frame every lap to find the session's lateral bias, then reframe
 *  with it applied. Bias is a session property — one lap is not enough straight
 *  running to estimate it. */
export function buildSessionFrames(
  laps: LapInput[],
  centerline: Centerline,
  opts: IngestOptions = {},
): LapFrame[] {
  const first = laps.map((l) => buildLapFrame(l.ticks, l.lapIdx, l.flag, centerline, opts));
  if (opts.aLatBias !== undefined) return first;

  // Prefer clean laps, but never fall through to a silent zero bias.
  const usable = first.filter((f) => f.quality.usable);
  const pool = usable.length > 0 ? usable : first.filter((f) => f.samples.length > 0);
  const bias = estimateLatBias(pool);
  return laps.map((l) =>
    buildLapFrame(l.ticks, l.lapIdx, l.flag, centerline, { ...opts, aLatBias: bias }));
}

// ── Small numeric helpers ──

/** Central difference; endpoints repeat their neighbour. */
export function derivative(xs: number[], dt: number): number[] {
  const n = xs.length;
  if (n < 3) return new Array(n).fill(0);
  const out = new Array<number>(n);
  for (let i = 1; i < n - 1; i++) out[i] = (xs[i + 1] - xs[i - 1]) / (2 * dt);
  out[0] = out[1];
  out[n - 1] = out[n - 2];
  return out;
}

export function movingAverage(xs: number[], halfWidth: number): number[] {
  if (halfWidth <= 0) return xs.slice();
  const out = new Array<number>(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const lo = Math.max(0, i - halfWidth);
    const hi = Math.min(xs.length, i + halfWidth + 1);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += xs[j];
    out[i] = sum / (hi - lo);
  }
  return out;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function correlate(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
