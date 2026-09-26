// Engine diagnostics for the review page: coolant, oil temperature and oil
// pressure, sampled onto a lap's sample times and graded with the same
// thresholds the live dashboard uses.
import {
  COOLANT_TEMP_CAUTION_F, COOLANT_TEMP_HOT_F, OIL_TEMP_CAUTION_F, OIL_TEMP_HOT_F,
  coolantTemperatureStatus, oilTemperatureStatus, oilPressureStatus, type OilStatus,
} from "./oil-guidance";

export type DiagMode = "coolant" | "oil_temp" | "oil_pressure";
export const DIAG_MODES: readonly DiagMode[] = ["coolant", "oil_temp", "oil_pressure"];

export function isDiagMode(mode: string): mode is DiagMode {
  return (DIAG_MODES as readonly string[]).includes(mode);
}

/** One value per lap sample; NaN where the sensor had no recent reading. */
export interface LapDiag {
  coolantF: number[];
  oilF: number[];
  oilPsi: number[];
}

export const EMPTY_DIAG: LapDiag = { coolantF: [], oilF: [], oilPsi: [] };

/** A reading older than this at a sample time counts as missing, so a sensor
 *  that dropped out shows as a gap instead of its last value. */
export const DIAG_STALE_MS = 2000;

const cToF = (c: number): number => c * 9 / 5 + 32;

interface TickLike { ts: number; d: Record<string, unknown> }

/** The last reading of `channel` at or before each time, or NaN if there is
 *  none within DIAG_STALE_MS. Ticks and times must both be in time order. */
export function sampleHeld(
  ticks: TickLike[], channel: string, times: number[], convert: (v: number) => number = (v) => v,
): number[] {
  const out = new Array<number>(times.length);
  let next = 0;
  let last = NaN;
  let lastTs = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    while (next < ticks.length && ticks[next].ts <= t) {
      const v = ticks[next].d[channel];
      if (typeof v === "number" && Number.isFinite(v)) {
        last = v;
        lastTs = ticks[next].ts;
      }
      next++;
    }
    out[i] = t - lastTs <= DIAG_STALE_MS ? convert(last) : NaN;
  }
  return out;
}

/** Coolant and oil temperature arrive in °C; the review shows °F like the dashboard. */
export function buildLapDiag(ticks: TickLike[], times: number[]): LapDiag {
  return {
    coolantF: sampleHeld(ticks, "coolant_temp", times, cToF),
    oilF: sampleHeld(ticks, "oil_temp", times, cToF),
    oilPsi: sampleHeld(ticks, "oil_pressure", times),
  };
}

/** Dashboard status for one sample, or null when that sensor had no reading. */
export function diagStatus(mode: DiagMode, diag: LapDiag, rpms: number[], i: number): OilStatus | null {
  switch (mode) {
    case "coolant": {
      const f = diag.coolantF[i];
      return Number.isFinite(f) ? coolantTemperatureStatus(f) : null;
    }
    case "oil_temp": {
      const f = diag.oilF[i];
      return Number.isFinite(f) ? oilTemperatureStatus(f) : null;
    }
    case "oil_pressure": {
      const psi = diag.oilPsi[i];
      return Number.isFinite(psi) ? oilPressureStatus(psi, rpms[i]) : null;
    }
  }
}

const SEVERITY: Record<OilStatus["tone"], number> = { neutral: 0, normal: 0, caution: 1, danger: 2 };

/** Per-sample severity for trail colouring: 0 fine, 1 caution, 2 danger, NaN no data. */
export function diagLevels(mode: DiagMode, diag: LapDiag, rpms: number[]): number[] {
  const n = mode === "coolant" ? diag.coolantF.length : mode === "oil_temp" ? diag.oilF.length : diag.oilPsi.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const status = diagStatus(mode, diag, rpms, i);
    out[i] = status ? SEVERITY[status.tone] : NaN;
  }
  return out;
}

/** Worst severity in [from, to). A trail bucket takes its worst sample so a
 *  short pressure dip in a corner is not averaged away. NaN if all missing. */
export function worstLevel(levels: number[], from: number, to: number): number {
  let worst = NaN;
  for (let i = from; i < to; i++) {
    const v = levels[i];
    if (Number.isFinite(v) && !(v <= worst)) worst = v;
  }
  return worst;
}

export const TONE_COLORS: Record<OilStatus["tone"], string> = {
  neutral: "#ffffff", normal: "#ffffff", caution: "#ffbf47", danger: "#ff4436",
};
export const NO_DATA_COLOR = "rgba(255,255,255,0.15)";

export function levelColor(level: number): string {
  if (!Number.isFinite(level)) return NO_DATA_COLOR;
  return level >= 2 ? TONE_COLORS.danger : level >= 1 ? TONE_COLORS.caution : TONE_COLORS.normal;
}

export const DIAG_LEGENDS: Record<DiagMode, { title: string; stops: { color: string; label: string }[] }> = {
  coolant: {
    title: "COOLANT",
    stops: [
      { color: TONE_COLORS.normal, label: `<${COOLANT_TEMP_CAUTION_F}°F` },
      { color: TONE_COLORS.caution, label: `${COOLANT_TEMP_CAUTION_F}-${COOLANT_TEMP_HOT_F - 1}°F` },
      { color: TONE_COLORS.danger, label: `${COOLANT_TEMP_HOT_F}°F+` },
      { color: NO_DATA_COLOR, label: "NO DATA" },
    ],
  },
  oil_temp: {
    title: "OIL TEMP",
    stops: [
      { color: TONE_COLORS.normal, label: `<${OIL_TEMP_CAUTION_F}°F` },
      { color: TONE_COLORS.caution, label: `${OIL_TEMP_CAUTION_F}-${OIL_TEMP_HOT_F - 1}°F` },
      { color: TONE_COLORS.danger, label: `${OIL_TEMP_HOT_F}°F+` },
      { color: NO_DATA_COLOR, label: "NO DATA" },
    ],
  },
  oil_pressure: {
    title: "OIL PRESS",
    stops: [
      { color: TONE_COLORS.normal, label: "OK" },
      { color: TONE_COLORS.caution, label: "<50 PSI AT 3K+ RPM" },
      { color: TONE_COLORS.danger, label: "LOW" },
      { color: NO_DATA_COLOR, label: "NO DATA" },
    ],
  },
};

/** Trail hover text for one sample. */
export function formatDiag(mode: DiagMode, diag: LapDiag, rpms: number[], i: number): string {
  switch (mode) {
    case "coolant": {
      const f = diag.coolantF[i];
      return Number.isFinite(f) ? `${Math.round(f)}°F coolant` : "no coolant data";
    }
    case "oil_temp": {
      const f = diag.oilF[i];
      return Number.isFinite(f) ? `${Math.round(f)}°F oil` : "no oil temp data";
    }
    case "oil_pressure": {
      const psi = diag.oilPsi[i];
      return Number.isFinite(psi) ? `${Math.round(psi)} psi @ ${Math.round(rpms[i] ?? 0)} rpm` : "no oil pressure data";
    }
  }
}
