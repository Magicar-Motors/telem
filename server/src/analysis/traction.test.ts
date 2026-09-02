import { describe, it, expect } from "vitest";
import { fitEnvelope, analyzeTraction, utilization, type Envelope } from "./traction.js";
import { G_MS2, type LapFrame, type LapSample, type LapFlag } from "./ingest.js";

function frameOf(
  n: number,
  f: (i: number) => Partial<LapSample>,
  over: Partial<LapFrame> = {},
): LapFrame {
  const dt = 0.05;
  const samples: LapSample[] = [];
  for (let i = 0; i < n; i++) {
    samples.push({
      t: i * dt, tsMs: 1_700_000_000_000 + i * dt * 1000,
      s: (i / n) * 4000, lat: 38.16, lon: -122.45,
      v: 30, aLong: 0, aLat: 0, alt: 100,
      throttle: 0, rpm: 4000, gear: 3, brake: 0, gapMs: 45,
      ...f(i),
    });
  }
  return {
    lapIdx: 0, flag: "clean" as LapFlag, dt, lengthM: 4000, samples,
    quality: { minSatellites: 20, maxGapMs: 45, aLatBias: 0,
               signCheckR: 0.9, missing: [], usable: true },
    ...over,
  };
}

const flat = (g: number) => G_MS2 * g;

describe("fitEnvelope", () => {
  it("takes the maximum, by default", () => {
    const f = frameOf(100, (i) => ({ aLat: flat(i === 50 ? 1.4 : 0.9) }));
    const e = fitEnvelope([f]);
    expect(e.mode).toBe("max");
    expect(e.muY).toBeCloseTo(1.4, 3);
  });

  it("keeps a cold lap in — a slow lap cannot lower a maximum", () => {
    const cold = frameOf(100, () => ({ aLat: flat(0.6) }));
    const warm = frameOf(100, () => ({ aLat: flat(1.15) }));
    expect(fitEnvelope([cold, warm]).muY).toBeCloseTo(1.15, 3);
    expect(fitEnvelope([warm]).muY).toBeCloseTo(1.15, 3);
    // Order must not matter either.
    expect(fitEnvelope([warm, cold]).muY).toBeCloseTo(1.15, 3);
  });

  it("takes braking from aLong, ignoring acceleration entirely", () => {
    const f = frameOf(100, (i) => ({ aLong: i < 50 ? flat(-0.8) : flat(2.0) }));
    const e = fitEnvelope([f]);
    expect(e.muX).toBeCloseTo(0.8, 3);   // the braking half
  });

  it("percentile mode rejects a lone spike that max accepts", () => {
    const f = frameOf(1000, (i) => ({ aLat: flat(i === 500 ? 1.9 : 1.0) }));
    expect(fitEnvelope([f], { mode: "max" }).muY).toBeCloseTo(1.9, 3);
    expect(fitEnvelope([f], { mode: "percentile" }).muY).toBeCloseTo(1.0, 3);
  });

  it("fixed mode ignores the data", () => {
    const f = frameOf(100, () => ({ aLat: flat(1.5) }));
    const e = fitEnvelope([f], { mode: "fixed", fixed: { muY: 1.2, muX: 1.0 } });
    expect(e.muY).toBe(1.2);
    expect(e.muX).toBe(1.0);
  });

  it("excludes pit laps, poor fixes, stale samples and inverted laps", () => {
    const good = frameOf(100, () => ({ aLat: flat(1.0) }));
    const pit = frameOf(100, () => ({ aLat: flat(1.8) }), { flag: "pit" });
    const lowSat = frameOf(100, () => ({ aLat: flat(1.7) }), {
      quality: { ...good.quality, minSatellites: 3 },
    });
    const inverted = frameOf(100, () => ({ aLat: flat(1.6) }), {
      quality: { ...good.quality, signCheckR: -0.9 },
    });
    const stale = frameOf(100, () => ({ aLat: flat(1.5), gapMs: 900 }));
    const e = fitEnvelope([good, pit, lowSat, inverted, stale]);
    expect(e.muY).toBeCloseTo(1.0, 3);
    expect(e.lapCount).toBe(2);            // good + stale; stale's samples all skipped
  });

  it("keeps an indeterminate sign check", () => {
    const f = frameOf(100, () => ({ aLat: flat(1.1) }), {
      quality: { minSatellites: 20, maxGapMs: 45, aLatBias: 0,
                 signCheckR: null, missing: [], usable: true },
    });
    expect(fitEnvelope([f]).muY).toBeCloseTo(1.1, 3);
  });

  it("returns a zero envelope rather than NaN when nothing is eligible", () => {
    const e = fitEnvelope([frameOf(10, () => ({}), { flag: "pit" })]);
    expect(e.muY).toBe(0);
    expect(e.muX).toBe(0);
    expect(e.lapCount).toBe(0);
  });
});

describe("utilization", () => {
  const env: Envelope = { muY: 1.0, muX: 1.0, mode: "max", sampleCount: 0, lapCount: 0 };

  it("is 1 at the lateral limit and at the braking limit", () => {
    expect(utilization(1.0, 0, env)).toBeCloseTo(1, 6);
    expect(utilization(0, 1.0, env)).toBeCloseTo(1, 6);
  });

  it("combines the two elliptically", () => {
    // Half of each axis is well inside the circle, not half used.
    expect(utilization(0.5, 0.5, env)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("scales against an asymmetric envelope", () => {
    const asym: Envelope = { ...env, muY: 1.2, muX: 0.8 };
    expect(utilization(1.2, 0, asym)).toBeCloseTo(1, 6);
    expect(utilization(0, 0.8, asym)).toBeCloseTo(1, 6);
  });

  it("is zero for a degenerate envelope rather than infinite", () => {
    expect(utilization(1, 1, { ...env, muY: 0, muX: 0 })).toBe(0);
  });
});

describe("analyzeTraction", () => {
  const env: Envelope = { muY: 1.0, muX: 1.0, mode: "max", sampleCount: 0, lapCount: 0 };

  it("means utilization over the lap", () => {
    const f = frameOf(200, () => ({ aLat: flat(0.5) }));
    expect(analyzeTraction(f, env).meanU).toBeCloseTo(0.5, 3);
  });

  it("bins the distribution and the fractions sum to one", () => {
    const f = frameOf(400, (i) => ({ aLat: flat(i / 400) }));
    const r = analyzeTraction(f, env);
    const total = r.distribution.reduce((a, b) => a + b.fraction, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(r.distribution.map((b) => b.label))
      .toEqual(["0-30%", "30-50%", "50-70%", "70-85%", "85-100%", ">100%"]);
  });

  it("puts over-limit samples in the >100% bin", () => {
    const f = frameOf(100, () => ({ aLat: flat(1.5) }));
    const r = analyzeTraction(f, env);
    expect(r.distribution.at(-1)!.fraction).toBeCloseTo(1, 6);
  });

  it("splits the lap into segments along the distance axis", () => {
    const f = frameOf(400, () => ({ aLat: flat(0.8) }));
    const r = analyzeTraction(f, env);
    expect(r.segments).toHaveLength(20);
    expect(r.segments[0].sFrom).toBe(0);
    expect(r.segments.at(-1)!.sTo).toBeCloseTo(4000, 6);
    for (const s of r.segments) expect(s.sampleCount).toBeGreaterThan(0);
  });

  it("localises a corner to its own segment", () => {
    // High lateral only in the last tenth of the lap.
    const f = frameOf(400, (i) => ({ aLat: flat(i >= 360 ? 1.0 : 0.1) }));
    const r = analyzeTraction(f, env);
    expect(r.segments.at(-1)!.meanU).toBeGreaterThan(0.9);
    expect(r.segments[0].meanU).toBeCloseTo(0.1, 2);
  });

  it("carries v_avg and v_min so a straight is distinguishable from slack", () => {
    // Fast and unloaded is a straight; slow and unloaded is a finding.
    const f = frameOf(400, (i) => ({
      aLat: flat(0.1), v: i < 200 ? 35 : 23,
    }));
    const r = analyzeTraction(f, env);
    expect(r.segments[0].vAvg).toBeCloseTo(35, 1);
    expect(r.segments.at(-1)!.vAvg).toBeCloseTo(23, 1);
    expect(r.segments.at(-1)!.vMin).toBeCloseTo(23, 1);
  });

  it("reports per-segment peaks", () => {
    const f = frameOf(400, (i) => ({
      aLat: flat(i === 10 ? 1.1 : 0.2), aLong: flat(i === 12 ? -0.9 : 0),
    }));
    const r = analyzeTraction(f, env);
    expect(r.segments[0].peakLatG).toBeCloseTo(1.1, 3);
    expect(r.segments[0].peakBrakeG).toBeCloseTo(0.9, 3);
  });

  it("skips stale samples", () => {
    const f = frameOf(200, (i) => ({ aLat: flat(1.0), gapMs: i < 100 ? 45 : 900 }));
    const r = analyzeTraction(f, env);
    const counted = r.segments.reduce((a, s) => a + s.sampleCount, 0);
    expect(counted).toBe(100);
  });

  it("survives an empty frame", () => {
    const r = analyzeTraction(frameOf(0, () => ({})), env);
    expect(r.meanU).toBe(0);
    expect(r.segments).toEqual([]);
  });
});

describe("max mode, same scope", () => {
  it("cannot exceed 100% when the envelope came from these very laps", () => {
    const laps = [
      frameOf(200, (i) => ({ aLat: flat(0.6 + (i % 40) / 100) })),
      frameOf(200, (i) => ({ aLat: flat(0.9 + (i % 25) / 100) })),
    ];
    const env = fitEnvelope(laps);
    for (const f of laps) {
      const r = analyzeTraction(f, env);
      expect(r.distribution.at(-1)!.count).toBe(0);
      for (const s of r.segments) expect(s.meanU).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("does exceed it against a narrower envelope from other laps", () => {
    const older = frameOf(200, () => ({ aLat: flat(0.9) }));
    const breakthrough = frameOf(200, () => ({ aLat: flat(1.2) }));
    const env = fitEnvelope([older]);
    expect(analyzeTraction(breakthrough, env).distribution.at(-1)!.fraction)
      .toBeCloseTo(1, 6);
  });
});
