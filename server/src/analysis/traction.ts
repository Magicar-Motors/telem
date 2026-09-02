/** Module 1 — friction envelope and how much of it the driver is using.
 *
 *  The envelope is the car's theoretical maximum: the best it has ever shown,
 *  over every lap in scope. See docs/analysis-modules.md. */

import { G_MS2, percentile as pct, type LapFrame } from "./ingest.js";

export type EnvelopeMode = "max" | "percentile" | "fixed";

const DEFAULT_PERCENTILE = 99.5;
const DEFAULT_MAX_GAP_MS = 250;
const DEFAULT_MIN_SATELLITES = 5;
const DEFAULT_SEGMENTS = 20;

/** Histogram edges in percent, from the spec. */
const DIST_EDGES = [0, 30, 50, 70, 85, 100, Infinity];

export interface Envelope {
  muY: number;          // g, lateral
  muX: number;          // g, braking
  mode: EnvelopeMode;
  sampleCount: number;  // samples that fed the fit
  lapCount: number;
  /** Convex hull of the sample cloud in display g-space: x is right-positive
   *  lateral, y is forward-positive longitudinal. Counter-clockwise. This is
   *  the real shape of what the car did — squashed at the bottom, because the
   *  car is power-limited on exit rather than traction-limited. */
  hull?: [number, number][];
}

export interface EnvelopeOptions {
  mode?: EnvelopeMode;
  percentile?: number;
  fixed?: { muY: number; muX: number };
  maxGapMs?: number;
  minSatellites?: number;
}

export interface UtilBin {
  label: string;
  from: number;      // percent
  to: number;
  count: number;
  fraction: number;  // of the lap's samples
}

export interface Segment {
  index: number;
  sFrom: number;      // m
  sTo: number;
  meanU: number;      // 0-1+
  durationS: number;
  vAvg: number;       // m/s
  vMin: number;       // m/s
  peakLatG: number;
  peakBrakeG: number;
  sampleCount: number;
}

export interface TractionResult {
  envelope: Envelope;
  meanU: number;
  distribution: UtilBin[];
  segments: Segment[];
}

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Andrew's monotone chain. Counter-clockwise, collinear points dropped. */
export function convexHull(pts: readonly [number, number][]): [number, number][] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const sorted = [...pts].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const build = (src: readonly [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of src) {
      while (out.length >= 2 &&
             cross(out[out.length - 2][0], out[out.length - 2][1],
                   out[out.length - 1][0], out[out.length - 1][1], p[0], p[1]) <= 0) {
        out.pop();
      }
      out.push([p[0], p[1]]);
    }
    out.pop();
    return out;
  };

  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  return lower.concat(upper);
}

/** True when (x, y) lies on or inside a counter-clockwise hull. */
export function insideHull(hull: readonly [number, number][], x: number, y: number): boolean {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (cross(a[0], a[1], b[0], b[1], x, y) < 0) return false;
  }
  return true;
}

/** The best this car has shown: the maximum over the six clean laps in
 *  archive/2026-08-22_23-sonoma-bypass.telem. Live sessions start here rather
 *  than from nothing, since a running max seeded at zero reads 100% for the
 *  first corner of every session. It still grows if the car does better. */
export const REFERENCE_ENVELOPE: Envelope = {
  muY: 1.387, muX: 1.146, mode: "max", sampleCount: 16866, lapCount: 6,
  // Note the flat bottom: braking reaches -1.15 g but acceleration only
  // +0.28 g. That asymmetry is the car being power-limited on exit, and it is
  // why utilisation measures the braking half only.
  hull: [
    [-1.387, 0.134], [-1.300, -0.062], [-0.714, -0.646], [-0.188, -1.058],
    [-0.065, -1.117], [0.001, -1.144], [0.010, -1.146], [1.142, -0.165],
    [1.167, -0.136], [1.219, 0.038], [1.206, 0.053], [1.127, 0.079],
    [-0.200, 0.280], [-0.526, 0.282], [-0.743, 0.267], [-0.812, 0.261],
    [-0.912, 0.242],
  ],
};

/** Widen an envelope to admit a sample that exceeded it. `longG` is signed and
 *  forward-positive; only its braking half feeds muX, but the hull keeps both.
 *
 *  The hull is only recomputed when the point falls outside it, which is rare
 *  after the first corners. hull(hull ∪ p) equals hull(all points), so nothing
 *  is lost by discarding interior samples. */
export function growEnvelope(env: Envelope, latG: number, longG: number): Envelope {
  const muY = Math.max(env.muY, Math.abs(latG));
  const muX = Math.max(env.muX, Math.max(-longG, 0));
  const hull = env.hull ?? [];
  const outside = !insideHull(hull, latG, longG);
  if (muY === env.muY && muX === env.muX && !outside) return env;
  return {
    ...env, muY, muX,
    hull: outside ? convexHull([...hull, [latG, longG]]) : hull,
    sampleCount: env.sampleCount + 1,
  };
}

/** A lap is eligible for the fit on data validity alone. There is deliberately
 *  no cold-tyre exclusion: a cold lap cannot lower a maximum. */
function eligible(f: LapFrame, minSats: number): boolean {
  if (f.flag === "pit") return false;
  if (f.samples.length === 0) return false;
  if (f.quality.minSatellites < minSats) return false;
  // A negative sign check means the longitudinal axis is inverted, so every
  // braking figure from this lap would be an acceleration figure.
  if (f.quality.signCheckR !== null && f.quality.signCheckR <= 0) return false;
  return true;
}

export function fitEnvelope(frames: LapFrame[], opts: EnvelopeOptions = {}): Envelope {
  const mode = opts.mode ?? "max";
  const maxGapMs = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const minSats = opts.minSatellites ?? DEFAULT_MIN_SATELLITES;

  if (mode === "fixed") {
    const f = opts.fixed ?? { muY: 1, muX: 1 };
    return { muY: f.muY, muX: f.muX, mode, sampleCount: 0, lapCount: 0 };
  }

  const lat: number[] = [];
  const brake: number[] = [];
  const cloud: [number, number][] = [];
  let lapCount = 0;

  for (const f of frames) {
    if (!eligible(f, minSats)) continue;
    lapCount++;
    for (const s of f.samples) {
      if (s.gapMs > maxGapMs) continue;
      const latG = s.aLat / G_MS2;
      const longG = s.aLong / G_MS2;
      lat.push(Math.abs(latG));
      brake.push(Math.max(-longG, 0));
      cloud.push([latG, longG]);
    }
  }

  if (lat.length === 0) {
    return { muY: 0, muX: 0, mode, sampleCount: 0, lapCount: 0 };
  }

  const p = opts.percentile ?? DEFAULT_PERCENTILE;
  const muY = mode === "max" ? maxOf(lat) : pct(lat, p);
  const muX = mode === "max" ? maxOf(brake) : pct(brake, p);
  return { muY, muX, mode, sampleCount: lat.length, lapCount, hull: convexHull(cloud) };
}

/** Elliptical against the two fitted limits.
 *
 *  Acceleration is excluded on purpose. The car is power-limited on exit, not
 *  traction-limited — peak measured acceleration is around 0.22 g against a
 *  traction ceiling near 0.57 g — so including it reports false slack on every
 *  corner exit and buries the real findings. */
export function utilization(aLatG: number, brakeG: number, env: Envelope): number {
  // Guard each axis on its own. A scope with no braking in it leaves muX at
  // zero, and that must drop the braking term, not the whole figure.
  const y = env.muY > 0 ? aLatG / env.muY : 0;
  const x = env.muX > 0 ? brakeG / env.muX : 0;
  return Math.sqrt(y * y + x * x);
}

export interface TractionOptions {
  segments?: number;
  maxGapMs?: number;
}

export function analyzeTraction(
  frame: LapFrame,
  envelope: Envelope,
  opts: TractionOptions = {},
): TractionResult {
  const nSeg = opts.segments ?? DEFAULT_SEGMENTS;
  const maxGapMs = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;

  const empty: TractionResult = {
    envelope, meanU: 0,
    distribution: makeBins().map((b) => ({ ...b, count: 0, fraction: 0 })),
    segments: [],
  };
  if (frame.samples.length === 0 || (envelope.muY <= 0 && envelope.muX <= 0)) return empty;

  const bins = makeBins().map((b) => ({ ...b, count: 0, fraction: 0 }));
  const acc = Array.from({ length: nSeg }, () => ({
    sumU: 0, n: 0, sumV: 0, vMin: Infinity, peakLat: 0, peakBrake: 0,
  }));

  let sumU = 0;
  let used = 0;
  const span = frame.lengthM > 0 ? frame.lengthM : 1;

  for (const s of frame.samples) {
    if (s.gapMs > maxGapMs) continue;
    const latG = Math.abs(s.aLat) / G_MS2;
    const brakeG = Math.max(-s.aLong, 0) / G_MS2;
    const u = utilization(latG, brakeG, envelope);

    sumU += u;
    used++;

    // Upper-inclusive, so a sample sitting exactly on the envelope counts as
    // at the limit rather than over it. In max mode at least one sample always
    // does, by construction.
    const pctU = u * 100;
    let bi2 = bins.length - 1;
    for (let i = 0; i < bins.length - 1; i++) {
      if (pctU <= bins[i].to) { bi2 = i; break; }
    }
    bins[bi2].count++;

    const bi = Math.min(nSeg - 1, Math.max(0, Math.floor((s.s / span) * nSeg)));
    const a = acc[bi];
    a.sumU += u; a.n++; a.sumV += s.v;
    if (s.v < a.vMin) a.vMin = s.v;
    if (latG > a.peakLat) a.peakLat = latG;
    if (brakeG > a.peakBrake) a.peakBrake = brakeG;
  }

  for (const b of bins) b.fraction = used > 0 ? b.count / used : 0;

  const segments: Segment[] = acc.map((a, i) => ({
    index: i,
    sFrom: (i / nSeg) * span,
    sTo: ((i + 1) / nSeg) * span,
    // Uniform dt is what makes this a plain mean rather than a weighted one.
    meanU: a.n > 0 ? a.sumU / a.n : 0,
    durationS: a.n * frame.dt,
    vAvg: a.n > 0 ? a.sumV / a.n : 0,
    vMin: Number.isFinite(a.vMin) ? a.vMin : 0,
    peakLatG: a.peakLat,
    peakBrakeG: a.peakBrake,
    sampleCount: a.n,
  }));

  return {
    envelope,
    meanU: used > 0 ? sumU / used : 0,
    distribution: bins,
    segments,
  };
}

/** Math.max(...xs) blows the call stack past a few tens of thousands of
 *  arguments, and a session runs to ~17k samples per six laps. */
function maxOf(xs: number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  return m === -Infinity ? 0 : m;
}

function makeBins(): { label: string; from: number; to: number }[] {
  const out: { label: string; from: number; to: number }[] = [];
  for (let i = 0; i < DIST_EDGES.length - 1; i++) {
    const from = DIST_EDGES[i];
    const to = DIST_EDGES[i + 1];
    out.push({ label: to === Infinity ? `>${from}%` : `${from}-${to}%`, from, to });
  }
  return out;
}
