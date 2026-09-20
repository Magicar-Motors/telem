import assert from "node:assert/strict";
import test from "node:test";
import { oilTemperatureStatus as temperature, oilPressureStatus as pressure } from "../src/oil-guidance";

test("warm-up is not an alarm; temperature bands include their documented boundaries", () => {
  for (const [value, tone] of [[110, "normal"], [179.9, "normal"], [180, "normal"], [230, "normal"], [230.1, "caution"], [259.9, "caution"], [260, "danger"]] as const) {
    assert.equal(temperature(value).tone, tone);
  }
});

test("pressure accounts for stopped, cranking, idle and driving RPM", () => {
  assert.equal(pressure(0, 0).tone, "neutral");
  assert.equal(pressure(0, 200).tone, "neutral");
  assert.equal(pressure(0, 715).tone, "danger");
  assert.equal(pressure(9.9, 715).tone, "danger");
  assert.equal(pressure(10, 715).tone, "neutral");
  assert.equal(pressure(44, 715).tone, "neutral");
  assert.equal(pressure(14, 2000).tone, "danger");
  assert.equal(pressure(39, 3000).tone, "caution");
  assert.equal(pressure(50, 3000).tone, "neutral");
  assert.equal(pressure(75, 3000).tone, "neutral");
});

test("missing or invalid sensors cannot show a reassuring status", () => {
  for (const value of [undefined, NaN, Infinity]) {
    assert.equal(temperature(value).tone, "neutral");
    assert.equal(pressure(value, 3000).tone, "neutral");
    assert.equal(pressure(40, value).tone, "neutral");
  }
});
