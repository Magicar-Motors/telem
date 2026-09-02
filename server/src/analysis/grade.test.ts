import { describe, it, expect } from "vitest";
import { computeGrade, annotateGrade } from "./grade.js";
import { G_MS2, type LapFrame, type LapSample } from "./ingest.js";

/** A frame built directly, so these tests exercise grade alone rather than
 *  re-testing the resampler. */
function frameOf(
  n: number,
  f: (i: number) => Partial<LapSample>,
  dt = 0.05,
): LapFrame {
  const samples: LapSample[] = [];
  for (let i = 0; i < n; i++) {
    samples.push({
      t: i * dt, tsMs: 1_700_000_000_000 + i * dt * 1000,
      s: i * 1.0, lat: 38.16, lon: -122.45,
      v: 20, aLong: 0, aLat: 0, alt: 100,
      throttle: 0, rpm: 3000, gear: 3, brake: 0, gapMs: 45,
      ...f(i),
    });
  }
  return {
    lapIdx: 0, flag: "clean", dt, lengthM: n, samples,
    quality: { minSatellites: 20, maxGapMs: 45, aLatBias: 0,
               signCheckR: 0.9, missing: [], usable: true },
  };
}

describe("computeGrade", () => {
  it("recovers a constant 10% climb", () => {
    // 1 m of travel per sample, 0.1 m of climb per sample.
    const g = computeGrade(frameOf(200, (i) => ({ s: i, alt: 100 + 0.1 * i })));
    const mid = g.samples[100];
    expect(mid.sinTheta).toBeCloseTo(0.1, 3);
    expect(mid.gradePct).toBeCloseTo(10, 2);
  });

  it("recovers a descent as negative grade", () => {
    const g = computeGrade(frameOf(200, (i) => ({ s: i, alt: 100 - 0.08 * i })));
    expect(g.samples[100].sinTheta).toBeCloseTo(-0.08, 3);
  });

  it("reads flat ground as zero", () => {
    const g = computeGrade(frameOf(200, (i) => ({ s: i })));
    expect(g.samples[100].sinTheta).toBeCloseTo(0, 6);
    expect(g.clampedFraction).toBe(0);
  });

  it("clamps at +/- 0.20 and reports how often it bit", () => {
    // 0.5 m of climb per metre travelled is a 50% grade — an altitude spike.
    const g = computeGrade(frameOf(200, (i) => ({ s: i, alt: 100 + 0.5 * i })));
    for (const s of g.samples) expect(Math.abs(s.sinTheta)).toBeLessThanOrEqual(0.2);
    expect(g.clampedFraction).toBeGreaterThan(0.9);
  });

  it("holds the previous grade below the speed floor instead of dividing", () => {
    // Stationary: s never advances, so d(s) is zero and the quotient blows up.
    const g = computeGrade(frameOf(200, () => ({ s: 0, v: 0, alt: 100 })));
    for (const s of g.samples) {
      expect(Number.isFinite(s.sinTheta)).toBe(true);
      expect(s.sinTheta).toBe(0);
    }
  });

  it("smooths altitude noise rather than differentiating it", () => {
    // 0.1 m sawtooth on flat ground — the raw derivative would swing wildly.
    const g = computeGrade(frameOf(400, (i) => ({ s: i, alt: 100 + (i % 2 ? 0.1 : 0) })));
    const mid = g.samples.slice(50, 350);
    for (const s of mid) expect(Math.abs(s.sinTheta)).toBeLessThan(0.02);
  });
});

describe("the two accelerations", () => {
  it("agree on flat ground", () => {
    // Decelerating 2 m/s^2 on the flat: aLong already is the whole story.
    const g = computeGrade(frameOf(200, (i) => ({
      s: i, v: 30 - 2 * (i * 0.05), aLong: -2, alt: 100,
    })));
    const mid = g.samples.slice(20, 180);
    for (const s of mid) {
      expect(s.aGps).toBeCloseTo(-2, 1);
      expect(s.aImu).toBeCloseTo(-2, 1);
      expect(s.divergence).toBeLessThan(0.15);
    }
    expect(g.divergenceRms).toBeLessThan(0.2);
  });

  it("agree on a slope once gravity is removed, and disagree without it", () => {
    // Holding steady speed up a 10% grade: dv/dt is 0, but the accelerometer
    // reads the gravity component, so raw aLong is not zero.
    const sinTheta = 0.1;
    const g = computeGrade(frameOf(200, (i) => ({
      s: i, v: 25, aLong: G_MS2 * sinTheta, alt: 100 + sinTheta * i,
    })));
    const mid = g.samples[100];
    expect(mid.aGps).toBeCloseTo(0, 2);
    expect(mid.aImu).toBeCloseTo(0, 1);           // corrected
    expect(Math.abs(G_MS2 * sinTheta)).toBeCloseTo(0.98, 2); // what was removed
    expect(g.divergenceRms).toBeLessThan(0.2);
  });

  it("surfaces a bad altitude channel as divergence", () => {
    // Altitude says 10% climb; the accelerometer and GPS speed both say flat.
    const g = computeGrade(frameOf(200, (i) => ({
      s: i, v: 25, aLong: 0, alt: 100 + 0.1 * i,
    })));
    expect(g.divergenceRms).toBeGreaterThan(0.9);
    expect(g.samples[100].divergence).toBeCloseTo(G_MS2 * 0.1, 1);
  });
});

describe("aGps smoothing", () => {
  it("rejects speed quantisation that would otherwise read as divergence", () => {
    // Flat ground at a steady 25 m/s, so the true dv/dt is zero and every
    // wobble is the 0.1 km/h logging step. Dither has to be aperiodic — a
    // repeating pattern lines up with some window width and nulls exactly.
    const step = 0.1 / 3.6;
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const dither = Array.from({ length: 600 }, () => (rand() < 0.5 ? 0 : 1));
    const noisy = frameOf(600, (i) => ({
      s: i, v: (Math.round(25 / step) + dither[i]) * step, aLong: 0, alt: 100,
    }));

    // aGps is pure noise here, so wider windows must monotonically quieten it.
    const rms = [0.1, 0.2, 0.3, 0.5].map(
      (w) => computeGrade(noisy, { aGpsSmoothS: w }).divergenceRms);
    for (let i = 1; i < rms.length; i++) expect(rms[i]).toBeLessThan(rms[i - 1]);
    expect(computeGrade(noisy).divergenceRms).toBeLessThan(rms[0]);
  });

  it("still tracks a real acceleration through the smoothing", () => {
    const g = computeGrade(frameOf(300, (i) => ({
      s: i, v: 30 - 2 * (i * 0.05), aLong: -2, alt: 100,
    })));
    expect(g.samples[150].aGps).toBeCloseTo(-2, 1);
  });
});

describe("annotateGrade", () => {
  it("writes the divergence onto the frame quality block", () => {
    const f = frameOf(200, (i) => ({ s: i, v: 25, aLong: 0, alt: 100 + 0.1 * i }));
    expect(f.quality.gradeDivergenceRms).toBeUndefined();
    const g = annotateGrade(f);
    expect(f.quality.gradeDivergenceRms).toBe(g.divergenceRms);
  });
});

describe("edge cases", () => {
  it("returns empty for a frame too short to differentiate", () => {
    expect(computeGrade(frameOf(2, () => ({}))).samples).toEqual([]);
  });

  it("produces no NaN on a degenerate frame", () => {
    const g = computeGrade(frameOf(50, () => ({ s: 0, v: 0, alt: 0, aLong: 0 })));
    for (const s of g.samples) {
      expect(Number.isFinite(s.sinTheta)).toBe(true);
      expect(Number.isFinite(s.aGps)).toBe(true);
      expect(Number.isFinite(s.aImu)).toBe(true);
      expect(Number.isFinite(s.divergence)).toBe(true);
    }
  });
});
