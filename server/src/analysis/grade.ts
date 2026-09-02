/** Module 2 — road grade, and two independent longitudinal accelerations.
 *
 *  A 13% grade contributes 0.13 g where the measured longitudinal signal is
 *  0.08-0.17 g, so this is not a refinement: uncorrected, the error is the
 *  same size as the thing being measured. See docs/analysis-modules.md. */

import { G_MS2, movingAverage, type LapFrame, type LapSample } from "./ingest.js";

/** GPS altitude is far noisier than GPS position; ~0.6 s at 20 Hz. */
const ALT_SMOOTH_S = 0.6;

/** Measured grade on this circuit peaks at 0.185, so a tighter clamp would
 *  flatten real terrain rather than reject outliers. */
const GRADE_CLAMP = 0.2;

/** gps_speed is logged to 0.1 km/h, which over a 0.1 s central difference is a
 *  0.278 m/s^2 quantisation step — enough to swamp the divergence metric with
 *  sensor noise. Sweeping the window on archive laps puts the minimum at
 *  ~0.3 s: below it quantisation dominates, above it real signal is lost. */
const AGPS_SMOOTH_S = 0.3;

/** Below this the car is barely moving and d(s) collapses toward zero, which
 *  turns the altitude derivative into noise. Hold the last grade instead. */
const MIN_SPEED_FOR_GRADE = 2;

export interface GradeSample {
  gradePct: number;   // 100 * sin(theta), uphill positive
  sinTheta: number;
  aGps: number;       // m/s^2, forward positive, from dv/dt — grade-free
  aImu: number;       // m/s^2, forward positive, gravity removed
  divergence: number; // m/s^2, |aGps - aImu|
}

export interface GradeResult {
  samples: GradeSample[];
  divergenceRms: number;   // m/s^2 over the lap
  clampedFraction: number; // share of samples the clamp bit on
}

export interface GradeOptions {
  altSmoothS?: number;
  aGpsSmoothS?: number;
  clamp?: number;
  minSpeed?: number;
}

export function computeGrade(frame: LapFrame, opts: GradeOptions = {}): GradeResult {
  const clamp = opts.clamp ?? GRADE_CLAMP;
  const minSpeed = opts.minSpeed ?? MIN_SPEED_FOR_GRADE;
  const smoothS = opts.altSmoothS ?? ALT_SMOOTH_S;

  const S: LapSample[] = frame.samples;
  const n = S.length;
  const empty: GradeResult = { samples: [], divergenceRms: 0, clampedFraction: 0 };
  if (n < 3) return empty;

  const halfWidth = Math.max(1, Math.round(smoothS / frame.dt / 2));
  const alt = movingAverage(S.map((x) => x.alt), halfWidth);
  const vSmoothWidth = Math.max(1, Math.round((opts.aGpsSmoothS ?? AGPS_SMOOTH_S) / frame.dt / 2));
  const v = movingAverage(S.map((x) => x.v), vSmoothWidth);

  const samples: GradeSample[] = new Array(n);
  let clamped = 0;
  let sumSq = 0;
  let held = 0;

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWidth);
    const hi = Math.min(n - 1, i + halfWidth);
    const ds = S[hi].s - S[lo].s;

    let sinTheta: number;
    if (ds > minSpeed * frame.dt && S[i].v > minSpeed) {
      sinTheta = (alt[hi] - alt[lo]) / ds;
      if (sinTheta > clamp || sinTheta < -clamp) {
        sinTheta = Math.max(-clamp, Math.min(clamp, sinTheta));
        clamped++;
      }
      held = sinTheta;
    } else {
      sinTheta = held;
    }

    // Independent by construction: one is the derivative of GPS speed, the
    // other is the accelerometer with the gravity component taken out. Where
    // they disagree, the altitude channel is the thing to distrust.
    const aGps = derivativeAt(v, i, frame.dt);
    const aImu = S[i].aLong - G_MS2 * sinTheta;
    const divergence = Math.abs(aGps - aImu);
    sumSq += divergence * divergence;

    samples[i] = { gradePct: sinTheta * 100, sinTheta, aGps, aImu, divergence };
  }

  return {
    samples,
    divergenceRms: Math.sqrt(sumSq / n),
    clampedFraction: clamped / n,
  };
}

function derivativeAt(v: number[], i: number, dt: number): number {
  if (i === 0) return (v[1] - v[0]) / dt;
  if (i === v.length - 1) return (v[i] - v[i - 1]) / dt;
  return (v[i + 1] - v[i - 1]) / (2 * dt);
}

/** Convenience: attach the divergence figure to the frame's quality block. */
export function annotateGrade(frame: LapFrame, opts?: GradeOptions): GradeResult {
  const g = computeGrade(frame, opts);
  frame.quality.gradeDivergenceRms = g.divergenceRms;
  return g;
}
