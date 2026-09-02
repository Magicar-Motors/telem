import { describe, it, expect } from "vitest";
import {
  buildCenterline, rawProgress, buildLapFrame, buildSessionFrames,
  estimateLatBias, derivative, percentile, correlate,
  type Tick, type LapInput,
} from "./ingest.js";

const G = 9.80665;

/** A square 400 m to a side, corners at the origin latitude. */
function squareTrack(): [number, number][] {
  const dLat = 400 / 111132.92;
  const dLon = 400 / (111132.92 * Math.cos((38.16 * Math.PI) / 180));
  return [
    [38.16, -122.45],
    [38.16, -122.45 + dLon],
    [38.16 + dLat, -122.45 + dLon],
    [38.16 + dLat, -122.45],
    [38.16, -122.45],
  ];
}

/** Interleaves a 22 Hz GPS/IMU producer with a 24 Hz Mega producer, the way
 *  the two bridges actually land in the WAL. */
function synthTicks(opts: {
  durationMs?: number;
  gpsPeriod?: number;
  megaPeriod?: number;
  speedKph?: (t: number) => number;
  gx?: (t: number) => number;
  gy?: (t: number) => number;
  gpsDropout?: [number, number];
} = {}): Tick[] {
  const dur = opts.durationMs ?? 10_000;
  const gpsP = opts.gpsPeriod ?? 45;
  const megaP = opts.megaPeriod ?? 41;
  const speed = opts.speedKph ?? (() => 100);
  const gx = opts.gx ?? (() => 0);
  const gy = opts.gy ?? (() => 0);
  const events: Tick[] = [];
  let seq = 0;
  const t0 = 1_700_000_000_000;

  for (let t = 0; t <= dur; t += gpsP) {
    if (opts.gpsDropout && t >= opts.gpsDropout[0] && t <= opts.gpsDropout[1]) continue;
    const frac = t / dur;
    events.push({
      seq: seq++, ts: t0 + t,
      d: {
        gps_lat: 38.16 + frac * 0.001,
        gps_lon: -122.45,
        gps_speed: speed(t / 1000),
        gps_altitude: 100 + frac * 20,
        gps_satellites: 18,
        g_force_x: gx(t / 1000),
        g_force_y: gy(t / 1000),
      },
    });
  }
  for (let t = 0; t <= dur; t += megaP) {
    events.push({
      seq: seq++, ts: t0 + t,
      d: { throttle_pos: 50, rpm: 4000, brake: 0 },
    });
  }
  return events.sort((a, b) => a.ts - b.ts);
}

describe("buildCenterline", () => {
  it("measures a 400 m square as 1600 m", () => {
    const c = buildCenterline(squareTrack());
    expect(c.totalM).toBeGreaterThan(1590);
    expect(c.totalM).toBeLessThan(1610);
  });

  it("does not skew east/west — equal lat and lon legs measure equal", () => {
    const c = buildCenterline(squareTrack());
    const legs = c.segDists.slice(1).map((d, i) => d - c.segDists[i]);
    for (const leg of legs) expect(Math.abs(leg - 400)).toBeLessThan(5);
  });

  it("locates the finish line as a progress fraction", () => {
    const pts = squareTrack();
    const c = buildCenterline(pts, pts[2]);
    expect(c.finishProgress).toBeCloseTo(0.5, 2);
  });
});

describe("rawProgress", () => {
  it("returns 0 at the start and ~1 at the end", () => {
    const c = buildCenterline(squareTrack());
    expect(rawProgress(c, 38.16, -122.45)).toBeCloseTo(0, 2);
  });

  it("projects an off-line point onto the nearest segment", () => {
    const c = buildCenterline(squareTrack());
    const onLine = rawProgress(c, 38.16, -122.4485);
    const offLine = rawProgress(c, 38.1601, -122.4485); // ~11 m off
    expect(Math.abs(onLine - offLine)).toBeLessThan(0.02);
  });
});

describe("buildLapFrame", () => {
  const centerline = buildCenterline(squareTrack());

  it("resamples interleaved producers onto one uniform grid", () => {
    const f = buildLapFrame(synthTicks(), 0, "clean", centerline);
    expect(f.samples.length).toBeGreaterThan(190);
    const steps = f.samples.slice(1).map((s, i) => s.t - f.samples[i].t);
    for (const step of steps) expect(step).toBeCloseTo(0.05, 6);
  });

  it("converts km/h to m/s", () => {
    const f = buildLapFrame(synthTicks({ speedKph: () => 108 }), 0, "clean", centerline);
    expect(f.samples[10].v).toBeCloseTo(30, 3);
  });

  it("makes aLong forward positive — braking-positive g_force_x flips sign", () => {
    // g_force_x > 0 is braking, per the archive correlation of r = -0.93.
    const f = buildLapFrame(synthTicks({ gx: () => 0.5 }), 0, "clean", centerline);
    expect(f.samples[10].aLong).toBeCloseTo(-0.5 * G, 3);
  });

  it("makes aLat right-turn positive", () => {
    const f = buildLapFrame(synthTicks({ gy: () => -0.8 }), 0, "clean", centerline);
    expect(f.samples[10].aLat).toBeCloseTo(0.8 * G, 3);
  });

  // Cruise, then brake at 5 m/s^2. Both channels have to vary or there is
  // nothing to correlate.
  const cruiseThenBrake = { speedKph: (t: number) => (t < 5 ? 144 : 144 - 18 * (t - 5)) };

  it("passes the sign check when speed and g_force_x agree", () => {
    const f = buildLapFrame(synthTicks({
      ...cruiseThenBrake,
      gx: (t) => (t < 5 ? 0 : 5 / G),   // braking is positive g_force_x
    }), 0, "clean", centerline);
    expect(f.quality.signCheckR).toBeGreaterThan(0.9);
    expect(f.quality.usable).toBe(true);
  });

  it("fails the sign check and marks unusable when g_force_x is inverted", () => {
    const f = buildLapFrame(synthTicks({
      ...cruiseThenBrake,
      gx: (t) => (t < 5 ? 0 : -5 / G),
    }), 0, "clean", centerline);
    expect(f.quality.signCheckR).toBeLessThan(-0.9);
    expect(f.quality.usable).toBe(false);
  });

  it("abstains rather than failing when the lap holds too steady to judge", () => {
    const f = buildLapFrame(synthTicks({ speedKph: () => 100, gx: () => 0 }), 0, "clean", centerline);
    expect(f.quality.signCheckR).toBeNull();
    expect(f.quality.usable).toBe(true);
  });

  it("reports staleness across a GPS dropout", () => {
    const f = buildLapFrame(synthTicks({ gpsDropout: [3000, 5000] }), 0, "clean", centerline);
    expect(f.quality.maxGapMs).toBeGreaterThan(1900);
    expect(f.quality.usable).toBe(false);
    const stale = f.samples.filter((s) => s.gapMs > 250);
    expect(stale.length).toBeGreaterThan(30);
  });

  it("keeps gapMs near the source period when nothing drops out", () => {
    const f = buildLapFrame(synthTicks(), 0, "clean", centerline);
    expect(f.quality.maxGapMs).toBeLessThan(60);
  });

  it("refuses a lap missing a required channel", () => {
    const ticks: Tick[] = [
      { seq: 0, ts: 1000, d: { throttle_pos: 20 } },
      { seq: 1, ts: 1050, d: { throttle_pos: 25 } },
    ];
    const f = buildLapFrame(ticks, 0, "clean", centerline);
    expect(f.quality.usable).toBe(false);
    expect(f.quality.missing).toContain("gps_lat");
    expect(f.samples).toEqual([]);
  });

  it("survives empty input", () => {
    const f = buildLapFrame([], 0, "clean", centerline);
    expect(f.samples).toEqual([]);
    expect(f.quality.usable).toBe(false);
  });

  it("puts s on a metre axis bounded by the centerline length", () => {
    const f = buildLapFrame(synthTicks(), 0, "clean", centerline);
    for (const s of f.samples) {
      expect(s.s).toBeGreaterThanOrEqual(0);
      expect(s.s).toBeLessThanOrEqual(centerline.totalM * 1.01);
    }
  });
});

describe("estimateLatBias", () => {
  const centerline = buildCenterline(squareTrack());

  it("recovers a constant mounting offset from straight-line running", () => {
    // gy = -0.03 is +0.03 g right-positive; at 100 kph every sample qualifies.
    const frames = [buildLapFrame(synthTicks({ gy: () => -0.03 }), 0, "clean", centerline)];
    expect(estimateLatBias(frames)).toBeCloseTo(0.03, 3);
  });

  it("ignores cornering samples above the straight-line threshold", () => {
    const frames = [buildLapFrame(synthTicks({
      gy: (t) => (t > 5 ? -0.9 : -0.02),
    }), 0, "clean", centerline)];
    expect(estimateLatBias(frames)).toBeCloseTo(0.02, 2);
  });

  it("ignores low-speed samples", () => {
    const frames = [buildLapFrame(synthTicks({
      speedKph: () => 30, gy: () => -0.05,
    }), 0, "clean", centerline)];
    expect(estimateLatBias(frames)).toBe(0);
  });
});

describe("buildSessionFrames", () => {
  const centerline = buildCenterline(squareTrack());

  it("estimates a bias even when no lap passes the sign check", () => {
    // Every frame indeterminate; the old code filtered on usable and silently
    // returned a zero bias.
    const laps: LapInput[] = [{
      lapIdx: 0, flag: "clean",
      ticks: synthTicks({ gy: () => -0.04, gpsDropout: [3000, 5000] }),
    }];
    const frames = buildSessionFrames(laps, centerline);
    expect(frames[0].quality.usable).toBe(false);
    expect(frames[0].quality.aLatBias).toBeCloseTo(0.04, 2);
  });

  it("applies one session-wide bias to every lap", () => {
    const laps: LapInput[] = [0, 1, 2].map((i) => ({
      lapIdx: i, flag: "clean" as const,
      ticks: synthTicks({ gy: () => -0.04 }),
    }));
    const frames = buildSessionFrames(laps, centerline);
    for (const f of frames) {
      expect(f.quality.aLatBias).toBeCloseTo(0.04, 3);
      expect(f.samples[10].aLat).toBeCloseTo(0, 2);
    }
  });

  it("honours an explicitly supplied bias instead of estimating", () => {
    const laps: LapInput[] = [{ lapIdx: 0, flag: "clean", ticks: synthTicks() }];
    const frames = buildSessionFrames(laps, centerline, { aLatBias: 0.1 });
    expect(frames[0].quality.aLatBias).toBe(0.1);
  });
});

describe("numeric helpers", () => {
  it("derivative recovers a known slope", () => {
    const xs = Array.from({ length: 20 }, (_, i) => 3 * i * 0.05);
    for (const d of derivative(xs, 0.05)) expect(d).toBeCloseTo(3, 6);
  });

  it("percentile ignores a lone spike at p99.5 but max does not", () => {
    const xs = [...Array.from({ length: 999 }, () => 1.0), 5.0];
    expect(percentile(xs, 99.5)).toBeCloseTo(1.0, 6);
    expect(Math.max(...xs)).toBe(5.0);
  });

  it("correlate returns +1, -1 and 0", () => {
    const a = [1, 2, 3, 4, 5];
    expect(correlate(a, [2, 4, 6, 8, 10])).toBeCloseTo(1, 6);
    expect(correlate(a, [10, 8, 6, 4, 2])).toBeCloseTo(-1, 6);
    expect(correlate(a, [1, 1, 1, 1, 1])).toBe(0);
  });
});
