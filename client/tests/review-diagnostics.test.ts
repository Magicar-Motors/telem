import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLapDiag, diagLevels, formatDiag, sampleHeld, worstLevel, DIAG_STALE_MS,
} from "../src/review-diagnostics";

const tick = (ts: number, d: Record<string, number>) => ({ ts, d });

test("held samples use the last reading and go missing once it is stale", () => {
  const ticks = [tick(1000, { oil_pressure: 40 }), tick(1100, { rpm: 3000 }), tick(1500, { oil_pressure: 55 })];
  const out = sampleHeld(ticks, "oil_pressure", [900, 1000, 1200, 1500, 1500 + DIAG_STALE_MS, 1501 + DIAG_STALE_MS]);
  assert.deepEqual(out.slice(0, 5), [NaN, 40, 40, 55, 55]);
  assert.ok(Number.isNaN(out[5]));
});

test("temperatures convert from °C to °F; a lap with no sensor is all missing", () => {
  const diag = buildLapDiag([tick(0, { coolant_temp: 100, oil_temp: 110 })], [0, 50]);
  assert.deepEqual(diag.coolantF, [212, 212]);
  assert.deepEqual(diag.oilF, [230, 230]);
  assert.ok(diag.oilPsi.every(Number.isNaN));
});

test("levels follow the dashboard thresholds, including RPM-aware pressure", () => {
  // °C chosen to convert exactly: coolant 212/230/257°F, oil 230/248/266°F.
  const ticks = [
    tick(0, { coolant_temp: 100, oil_temp: 110, oil_pressure: 60 }),
    tick(100, { coolant_temp: 110, oil_temp: 120, oil_pressure: 45 }),
    tick(200, { coolant_temp: 125, oil_temp: 130, oil_pressure: 12 }),
  ];
  const diag = buildLapDiag(ticks, [0, 100, 200]);
  const rpms = [3500, 3500, 3500];
  assert.deepEqual(diagLevels("coolant", diag, rpms), [0, 1, 2]);
  assert.deepEqual(diagLevels("oil_temp", diag, rpms), [0, 1, 2]);
  assert.deepEqual(diagLevels("oil_pressure", diag, rpms), [0, 1, 2]);
  // The same pressures pass at idle: 50 psi applies from 3,000 RPM, 15 psi above 1,500.
  assert.deepEqual(diagLevels("oil_pressure", diag, [800, 800, 800]), [0, 0, 0]);
  assert.equal(formatDiag("oil_pressure", diag, rpms, 1), "45 psi @ 3500 rpm");
});

test("a trail bucket takes its worst sample and ignores gaps", () => {
  assert.equal(worstLevel([0, NaN, 2, 1], 0, 4), 2);
  assert.equal(worstLevel([0, NaN, 0], 0, 3), 0);
  assert.ok(Number.isNaN(worstLevel([NaN, NaN], 0, 2)));
});
