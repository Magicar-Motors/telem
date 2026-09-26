/**
 * Sensor conversion functions for 1992 Honda Accord EX (F22A).
 *
 * Forward conversions (voltage → physical): used by serial-bridge
 * Inverse conversions (physical → voltage): used by gen-data
 */

// ── Shared constants ──

/**
 * ECT: voltage → temperature. Assumptions, locked in 2026-09-25.
 *
 * Circuit: the ECU pulls its ECT input up to its own 5V reference through an
 * internal resistor R_p; the 2-wire NTC thermistor returns to the ECU's sensor
 * ground. So, with V measured relative to that sensor ground (see ectSense()):
 *   R    = R_p · V / (5 − V)
 *   T[K] = 1 / ( 1/313.15 + (1/B) · ln(R / R_ref) )
 *
 * 1. ECU reference = 5.00V. Not measured. Ratiometric error: a 2% low reference
 *    reads a few °F hot at operating temperature.
 *
 * 2. R_p = 1.5 kΩ. No published value was found online. Cross-check against a
 *    known temperature (2026-09-25, idle 774 rpm, radiator fan cycling, oil
 *    89.4°C / 193°F, coolant taken as 195°F): median corrected ECT 0.551V over
 *    15s, which with this Beta model implies R_p ≈ 1.67k (1.5–1.85k for
 *    ±0.05V or ±5°F). 1.5k is inside that range; against that point it reads
 *    ~202°F instead of 195°F, i.e. up to ~7°F hot near operating temperature.
 *    Settle it by resistor substitution: ignition on, engine off, sensor
 *    unplugged, R_p = R_known · (V_open − V_load) / V_load.
 *    The previous 6.65k was derived from readings taken before the ECU ground
 *    offset was known, so it included that offset, and is discarded.
 *
 * 3. Thermistor Beta model: B = 3881, R_ref = 1.16 kΩ at 40°C, supplied as the
 *    reference curve. It disagrees with the Honda FSM R–T table we used before:
 *        °C    -20    0    20   40   60    80    100   120
 *        FSM   12.0   5.0  2.0  1.2  0.7   0.4   0.2   0.1   kΩ
 *        Beta  21.9   7.1  2.7  1.16 0.55  0.29  0.16  0.09  kΩ
 *    so at the hot end the Beta model reads hotter than the FSM table would for
 *    the same resistance.
 *
 * 4. The 195°F calibration assumes coolant ≈ oil + 2°F at a thermostat-held
 *    idle with the fan cycling. The corrected ECT voltage was noisy over that
 *    window (0.27–0.65V), so the median is the calibration value, not any
 *    single sample.
 */
export const ECT_PULLUP_KOHM = 1.5; // Honda ECU internal pull-up (assumption 2)
export const ECT_ECU_VREF = 5.0;    // ECU reference the pull-up hangs from (assumption 1)

// Thermistor Beta model (assumption 3)
export const ECT_BETA = 3881;
export const ECT_R_REF_KOHM = 1.16;
export const ECT_T_REF_K = 313.15;

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
//
// Assumptions:
// - Resistors are their nominal 100k / 470k. Mismatch between the two dividers
//   shows up as an offset in (V_A8 − V_A13), removed by ECT_SENSE_ZERO_V.
// - Mega 5V = 5.00V. BIAS is ratiometric (bias and ADC reference are the same
//   rail) so it's exact regardless; only GAIN scales: a 4.8V rail reads ECT and
//   the ground delta ~4% high.
// - Source resistance behind each 100k is ignored: ~0 for sensor ground, ≤0.33k
//   hot for the ECT node. The ~9µA the 470k pushes into the ECT node shifts it
//   ~3mV at operating temperature; the ECU reads the same shifted node.
// - ADC pin leakage × 82k source is a few mV and mostly common to both pins.
// - The ECU ground offset stays above −1.06V vs Mega GND (the circuit's floor).
//   Measured −0.4 to −0.5V, seen −0.26 to −0.63V at idle on 2026-09-25.
// - Uncalibrated: ECT_SENSE_ZERO_V = 0 until the bench zero is measured (both
//   taps to Mega GND, record V_A8 − V_A13).

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

/** ECT: voltage (relative to ECU sensor ground) → temperature in °C. NaN outside 0–5V. */
export function ectToTempC(v: number): number {
  if (!(v > 0 && v < ECT_ECU_VREF)) return NaN;
  const rKohm = ECT_PULLUP_KOHM * v / (ECT_ECU_VREF - v);
  const tK = 1 / (1 / ECT_T_REF_K + Math.log(rKohm / ECT_R_REF_KOHM) / ECT_BETA);
  return tK - 273.15;
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

/** ECT: temperature °C → voltage (inverse of ectToTempC) */
export function ectToVoltage(tempC: number): number {
  const tK = tempC + 273.15;
  const rKohm = ECT_R_REF_KOHM * Math.exp(ECT_BETA * (1 / tK - 1 / ECT_T_REF_K));
  return ECT_ECU_VREF * rKohm / (ECT_PULLUP_KOHM + rKohm);
}
