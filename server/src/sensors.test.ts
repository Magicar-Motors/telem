import { describe, it, expect } from "vitest";
import { ectSense, ectToTempC, ectToVoltage } from "./sensors.js";

// Forward model of one biased divider: what the pin reads for an input vs Mega GND.
const pin = (vIn: number) => vIn * (470 / 570) + 5 * (100 / 570);

describe("ectSense", () => {
  it("reads 0.8772 V at both pins when the inputs are at Mega GND", () => {
    expect(pin(0)).toBeCloseTo(0.8772, 4);
    const s = ectSense(pin(0), pin(0));
    expect(s.ectV).toBeCloseTo(0, 6);
    expect(s.ecuGndDeltaV).toBeCloseTo(0, 6);
  });

  for (const offset of [0, -0.4, -0.6]) {
    for (const ect of [0.08, 0.22, 1.35]) {
      it(`recovers ECT ${ect} V with ECU ground at ${offset} V`, () => {
        // ECT signal vs Mega GND = ECT vs ECU ground + ECU ground vs Mega GND.
        const s = ectSense(pin(ect + offset), pin(offset));
        expect(s.ectV).toBeCloseTo(ect, 6);
        expect(s.ecuGndDeltaV).toBeCloseTo(offset, 6);
      });
    }
  }
});

describe("ectToTempC (Beta model)", () => {
  it("reads 40°C when the thermistor is at R_ref (1.16k on a 1.5k pull-up)", () => {
    const v = 5 * 1.16 / (1.5 + 1.16);
    expect(ectToTempC(v)).toBeCloseTo(40, 6);
  });

  it("round-trips through ectToVoltage", () => {
    for (const c of [-20, 0, 40, 90, 120]) {
      expect(ectToTempC(ectToVoltage(c))).toBeCloseTo(c, 6);
    }
  });

  it("returns NaN outside 0–5V", () => {
    expect(ectToTempC(0)).toBeNaN();
    expect(ectToTempC(5)).toBeNaN();
  });
});
