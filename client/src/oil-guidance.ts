// Temperature bands are provisional dashboard guidance, not Honda limits.
// Pressure reference: Honda Accord 2.2L service test at 176°F oil:
// >=10 psi at idle; >=50 psi at 3,000 RPM. Do not interpolate a factory limit.
export interface OilStatus {
  tone: "neutral" | "normal" | "caution" | "danger";
  text: string;
}

// Amber starts at the caution value; red starts at the hot value.
export const OIL_TEMP_CAUTION_F = 240;
export const OIL_TEMP_HOT_F = 260;
export const COOLANT_TEMP_CAUTION_F = 230;
export const COOLANT_TEMP_HOT_F = 250;

export const OIL_TEMP_GUIDE = `Driving guide: 180–${OIL_TEMP_CAUTION_F}°F · hot ≥${OIL_TEMP_HOT_F}°F`;
export const COOLANT_TEMP_GUIDE = `Normal below ${COOLANT_TEMP_CAUTION_F}°F · hot ≥${COOLANT_TEMP_HOT_F}°F`;
export const OIL_PRESSURE_GUIDE = "At 176°F: ≥10 psi idle · ≥50 psi at 3,000 RPM";

const isValid = (value: number | undefined): value is number => value != null && Number.isFinite(value);

export function oilTemperatureStatus(tempF: number | undefined): OilStatus {
  if (!isValid(tempF)) return { tone: "neutral", text: "No current data" };
  if (tempF < 180) return { tone: "normal", text: "Cool oil" };
  if (tempF < OIL_TEMP_CAUTION_F) return { tone: "normal", text: "In driving guide" };
  if (tempF < OIL_TEMP_HOT_F) return { tone: "caution", text: "Elevated" };
  return { tone: "danger", text: "Hot oil" };
}

export function coolantTemperatureStatus(tempF: number | undefined): OilStatus {
  if (!isValid(tempF)) return { tone: "neutral", text: "No current data" };
  if (tempF < COOLANT_TEMP_CAUTION_F) return { tone: "normal", text: "Normal" };
  if (tempF < COOLANT_TEMP_HOT_F) return { tone: "caution", text: "Elevated" };
  return { tone: "danger", text: "Hot coolant" };
}

export function oilPressureStatus(psi: number | undefined, rpm: number | undefined): OilStatus {
  if (!isValid(psi)) return { tone: "neutral", text: "No current data" };
  if (!isValid(rpm) || rpm < 0) return { tone: "neutral", text: "RPM unavailable" };
  if (rpm === 0) return { tone: "neutral", text: "Engine stopped · expect ~0 psi" };
  if (rpm < 400) return { tone: "neutral", text: "Starting / stopping" };
  if (psi < 10 || (rpm > 1500 && psi < 15)) return { tone: "danger", text: "Low pressure · check now" };
  // This is a reference check, not a validated pressure curve or high-pressure limit.
  if (rpm >= 3000 && psi < 50) return { tone: "caution", text: "Below 3,000 RPM reference" };
  return { tone: "neutral", text: "Pressure varies with RPM / oil temp" };
}
