// Temperature bands are provisional dashboard guidance, not Honda limits.
// Pressure reference: Honda Accord 2.2L service test at 176°F oil:
// >=10 psi at idle; >=50 psi at 3,000 RPM. Do not interpolate a factory limit.
export interface OilStatus {
  tone: "neutral" | "normal" | "caution" | "danger";
  text: string;
}

export const OIL_TEMP_GUIDE = "Driving guide: 180–230°F · hot ≥260°F";
export const OIL_PRESSURE_GUIDE = "At 176°F: ≥10 psi idle · ≥50 psi at 3,000 RPM";

export function oilTemperatureStatus(tempF: number | undefined): OilStatus {
  if (tempF == null || !Number.isFinite(tempF)) return { tone: "neutral", text: "No current data" };
  if (tempF < 180) return { tone: "normal", text: "Cool oil" };
  if (tempF <= 230) return { tone: "normal", text: "In driving guide" };
  if (tempF < 260) return { tone: "caution", text: "Elevated" };
  return { tone: "danger", text: "Hot oil" };
}

export function oilPressureStatus(psi: number | undefined, rpm: number | undefined): OilStatus {
  if (psi == null || !Number.isFinite(psi)) return { tone: "neutral", text: "No current data" };
  if (rpm == null || !Number.isFinite(rpm) || rpm < 0) return { tone: "neutral", text: "RPM unavailable" };
  if (rpm === 0) return { tone: "neutral", text: "Engine stopped · expect ~0 psi" };
  if (rpm < 400) return { tone: "neutral", text: "Starting / stopping" };
  if (psi < 10 || (rpm > 1500 && psi < 15)) return { tone: "danger", text: "Low pressure · check now" };
  // This is a reference check, not a validated pressure curve or high-pressure limit.
  if (rpm >= 3000 && psi < 50) return { tone: "caution", text: "Below 3,000 RPM reference" };
  return { tone: "neutral", text: "Pressure varies with RPM / oil temp" };
}
