/**
 * Sensor conversion functions for 1992 Honda Accord EX (F22A).
 *
 * Forward conversions (voltage → physical): used by serial-bridge
 * Inverse conversions (physical → voltage): used by gen-data
 */

// ── Shared constants ──

export const ECT_PULLUP_KOHM = 6.65; // Honda ECU internal pull-up, derived from 0.25V @ 190°F (87.8°C)

/**
 * ECT resistance-to-temperature table from Honda FSM:
 *   12.0 kΩ → -20°C    0.7 kΩ →  60°C
 *    5.0 kΩ →   0°C    0.4 kΩ →  80°C
 *    2.0 kΩ →  20°C    0.2 kΩ → 100°C
 *    1.2 kΩ →  40°C    0.1 kΩ → 120°C
 *
 * The Mega reads voltage from a voltage divider: V = 5 * R_therm / (R_pullup + R_therm)
 * Conversion: voltage → resistance → temperature (log interpolation on R-T table)
 */
export const ECT_TABLE: [number, number][] = [
  [12.0, -20], [5.0, 0], [2.0, 20], [1.2, 40],
  [0.7, 60], [0.4, 80], [0.2, 100], [0.1, 120],
];

// ── ECT sense circuit ──
//
// The ECU's sensor ground sits a few hundred mV below the Mega's ground (measured
// -0.4 to -0.5V, possibly -0.6V on track), which would clip a hot ECT reading at 0V.
// ECT and ECU ground are therefore each read through an identical biased divider:
//
//   ECU ECT signal  ──[100k]──┬── A8   ──[470k]── Mega 5V
//   ECU sensor gnd  ──[100k]──┬── A13  ──[470k]── Mega 5V
//
// Both pins read: V_pin = GAIN × V_in + BIAS, where V_in is relative to Mega GND.

export const ECT_SENSE_SERIES_KOHM = 100; // tap → pin
export const ECT_SENSE_BIAS_KOHM = 470;   // pin → Mega 5V
export const ECT_SENSE_VREF = 5.0;        // Mega 5V, also the ADC reference
/** (V_A8 − V_A13) with both taps shorted to Mega GND on the bench. Uncalibrated: 0. */
export const ECT_SENSE_ZERO_V = 0;

export interface EctSense {
  /** ECT signal relative to the ECU's sensor ground: what the ECU itself reads. */
  ectV: number;
  /** ECU sensor ground relative to Mega GND, bias removed. Negative = ECU ground is lower. */
  ecuGndDeltaV: number;
}

/** Undo both biased dividers and reference ECT to the ECU's own ground. */
export function ectSense(ectPinV: number, gndPinV: number): EctSense {
  // Divider: V_pin = V_in·R_bias/(R_series+R_bias) + VREF·R_series/(R_series+R_bias)
  const rTotal = ECT_SENSE_SERIES_KOHM + ECT_SENSE_BIAS_KOHM;  // 570k
  const gain = ECT_SENSE_BIAS_KOHM / rTotal;                   // 470/570 = 0.8246
  const bias = ECT_SENSE_VREF * ECT_SENSE_SERIES_KOHM / rTotal; // 5·100/570 = 0.8772 V

  // Invert each divider: V_in = (V_pin − BIAS) / GAIN, relative to Mega GND.
  const ectVsMega = (ectPinV - bias) / gain;
  const gndVsMega = (gndPinV - bias) / gain;

  // ECT as the ECU sees it = ECT vs Mega − ECU ground vs Mega. BIAS cancels here,
  // so this equals (V_A8 − V_A13) / GAIN; the bench zero removes resistor mismatch.
  const ectV = ectVsMega - gndVsMega - ECT_SENSE_ZERO_V / gain;

  return { ectV, ecuGndDeltaV: gndVsMega };
}

// ── Forward conversions (voltage → physical) ──

/** TPS: 0.5V = 0%, 4.5V = 100%. Clamped to 0–100. */
export function tpsToPercent(v: number): number {
  return Math.max(0, Math.min(100, ((v - 0.5) / 4.0) * 100));
}

/** MAP: Honda 1-bar Denso. 0.5V ≈ 20 kPa, 3.0V ≈ 101 kPa. */
export function mapToKpa(v: number): number {
  return (v - 0.5) * 32.4 + 20;
}

/** ECT: voltage → temperature in °C via resistance lookup. */
export function ectToTempC(v: number): number {
  if (v <= 0 || v >= 5.0) return v <= 0 ? 120 : -20;
  const rKohm = ECT_PULLUP_KOHM * v / (5.0 - v);

  if (rKohm >= ECT_TABLE[0][0]) return ECT_TABLE[0][1];
  if (rKohm <= ECT_TABLE[ECT_TABLE.length - 1][0]) return ECT_TABLE[ECT_TABLE.length - 1][1];

  for (let i = 0; i < ECT_TABLE.length - 1; i++) {
    const [r1, t1] = ECT_TABLE[i];
    const [r2, t2] = ECT_TABLE[i + 1];
    if (rKohm <= r1 && rKohm >= r2) {
      const frac = (Math.log(r1) - Math.log(rKohm)) / (Math.log(r1) - Math.log(r2));
      return t1 + frac * (t2 - t1);
    }
  }
  return ECT_TABLE[ECT_TABLE.length - 1][1];
}

// ── Inverse conversions (physical → voltage) ──

/** TPS: throttle % → voltage */
export function tpsToVoltage(pct: number): number {
  return pct * 4.0 / 100 + 0.5;
}

/** MAP: kPa → voltage */
export function mapToVoltage(kpa: number): number {
  return (kpa - 20) / 32.4 + 0.5;
}

/** ECT: temperature °C → voltage */
export function ectToVoltage(tempC: number): number {
  let rKohm: number;
  if (tempC <= ECT_TABLE[0][1]) rKohm = ECT_TABLE[0][0];
  else if (tempC >= ECT_TABLE[ECT_TABLE.length - 1][1]) rKohm = ECT_TABLE[ECT_TABLE.length - 1][0];
  else {
    rKohm = ECT_TABLE[0][0];
    for (let i = 0; i < ECT_TABLE.length - 1; i++) {
      const [r1, t1] = ECT_TABLE[i];
      const [r2, t2] = ECT_TABLE[i + 1];
      if (tempC >= t1 && tempC <= t2) {
        const frac = (tempC - t1) / (t2 - t1);
        rKohm = Math.exp(Math.log(r1) + frac * (Math.log(r2) - Math.log(r1)));
        break;
      }
    }
  }
  return 5 * rKohm / (ECT_PULLUP_KOHM + rKohm);
}
