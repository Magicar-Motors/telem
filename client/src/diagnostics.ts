import { TelemetryManager } from "./telemetry";
import { OIL_TEMP_GUIDE, OIL_PRESSURE_GUIDE, oilTemperatureStatus, oilPressureStatus } from "./oil-guidance";

export interface DiagPanel {
  update: () => void;
}

const SPARK_POINTS = 3000; // ~2 min at 25Hz

const RED = "rgb(255, 68, 54)";
const ORANGE = "rgb(255, 123, 69)";
const GREEN = "rgb(61, 223, 128)";
const CYAN = "rgb(0, 212, 170)";
const YELLOW = "rgb(255, 211, 32)";

interface DiagCell {
  channel: string;
  label: string;
  unit: string;
  valueEl: HTMLElement;
  cellEl: HTMLElement;
  guide?: string;
  detailsEl?: HTMLElement;
  axisEl?: HTMLElement;
  fillEl?: HTMLElement;
  trackEl?: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  color: string;
  min: number;
  max: number;
  warnAbove?: number;
  warnBelow?: number;
  transform?: (v: number) => number;
}

function drawSparkline(cell: DiagCell, values: number[]): void {
  const { canvas, ctx, color, min, max } = cell;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (values.length < 2) return;

  const start = Math.max(0, values.length - SPARK_POINTS);
  const pts = values.slice(start);
  const range = max - min || 1;

  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = (i / (pts.length - 1)) * w;
    const y = h - ((pts[i] - min) / range) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color.replace(")", ", 0.06)").replace("rgb", "rgba");
  ctx.fill();
}

function createCell(
  parent: HTMLElement,
  channel: string,
  label: string,
  unit: string,
  color: string,
  min: number,
  max: number,
  warnAbove?: number,
  transform?: (v: number) => number,
  warnBelow?: number,
): DiagCell {
  const cell = document.createElement("div");
  cell.className = "diag-cell";
  cell.innerHTML = `
    <div class="diag-cell-header">
      <span class="diag-cell-label">${label}</span>
      <span class="diag-cell-readout">
        <span class="diag-cell-value">--</span>
        <span class="diag-cell-unit">${unit}</span>
      </span>
    </div>
    <canvas class="diag-cell-spark"></canvas>
  `;
  let guide: string | undefined;
  if (channel === "oil_temp" || channel === "oil_pressure") {
    guide = channel === "oil_temp"
      ? `${OIL_TEMP_GUIDE}. Provisional guidance, not a Honda service limit. Oil grade, load and sensor location affect temperature.`
      : `${OIL_PRESSURE_GUIDE}. Service-test minimums, not a normal range at every RPM. Cold oil raises pressure.`;
    const details = document.createElement("div");
    details.className = "diag-oil-details";
    details.id = `diag-details-${channel}`;
    details.hidden = true;
    details.textContent = `No current data. ${guide}`;
    cell.appendChild(details);
    cell.tabIndex = 0;
    cell.setAttribute("role", "button");
    cell.setAttribute("aria-controls", details.id);
    cell.setAttribute("aria-expanded", "false");
    cell.setAttribute("aria-label", `${label}: show guidance`);
    const toggleDetails = () => {
      const open = cell.classList.toggle("details-open");
      details.hidden = !open;
      cell.setAttribute("aria-expanded", String(open));
      cell.setAttribute("aria-label", `${label}: ${open ? "show chart" : "show guidance"}`);
    };
    cell.addEventListener("click", toggleDetails);
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleDetails();
      }
    });
  }
  if (channel === "oil_temp" || channel === "oil_pressure") {
    const plot = document.createElement("div");
    plot.className = "diag-oil-plot";
    plot.innerHTML = `
      <div class="diag-oil-axis ${channel === "oil_temp" ? "diag-oil-axis-temperature" : ""}" role="meter" aria-label="${channel === "oil_temp" ? "Oil temperature toward hot threshold" : "Oil pressure in PSI"}"
           aria-valuemin="${min}" aria-valuemax="${max}" aria-valuetext="No current data">
        <span class="diag-oil-axis-top">${max}${unit}</span>
        <span class="diag-oil-axis-bottom">${min}</span>
        <div class="diag-oil-axis-track"><div class="diag-oil-axis-fill" hidden></div></div>
      </div>`;
    plot.prepend(cell.querySelector("canvas")!);
    cell.appendChild(plot);
  }
  parent.appendChild(cell);

  const canvas = cell.querySelector(".diag-cell-spark") as HTMLCanvasElement;

  return {
    channel, label, unit,
    valueEl: cell.querySelector(".diag-cell-value") as HTMLElement,
    cellEl: cell,
    guide,
    detailsEl: cell.querySelector<HTMLElement>(".diag-oil-details") ?? undefined,
    axisEl: cell.querySelector<HTMLElement>(".diag-oil-axis") ?? undefined,
    fillEl: cell.querySelector<HTMLElement>(".diag-oil-axis-fill") ?? undefined,
    trackEl: cell.querySelector<HTMLElement>(".diag-oil-axis-track") ?? undefined,
    canvas,
    ctx: canvas.getContext("2d")!,
    color, min, max, warnAbove, warnBelow, transform,
  };
}

const toF = (c: number) => c * 9 / 5 + 32;

export function createDiagnostics(
  container: HTMLElement,
  mgr: TelemetryManager,
): DiagPanel {
  container.innerHTML = `<div class="diag-grid"></div>`;
  const grid = container.querySelector(".diag-grid") as HTMLElement;

  const cells: DiagCell[] = [
    createCell(grid, "coolant_temp", "冷却 COOLANT", "\u00B0F", RED, 32, 270, 230, toF),
    createCell(grid, "oil_temp", "油温 OIL TEMP", "\u00B0F", ORANGE, 100, 300, undefined, toF),
    createCell(grid, "oil_pressure", "油圧 OIL PRESS", "PSI", YELLOW, 0, 100),
    createCell(grid, "battery_voltage", "電圧 BATTERY", "V", GREEN, 11, 15),
    createCell(grid, "manifold_pressure", "圧力 MAP", "kPa", ORANGE, 0, 110),
    createCell(grid, "jetson_temp", "基板 JETSON", "\u00B0C", CYAN, 20, 100, 85),
  ];

  function currentValue(channel: string): number | undefined {
    const buf = mgr.getBuffer(channel);
    const timestamp = buf?.timestamps.at(-1);
    const latest = buf?.values.at(-1);
    if (mgr.state !== "live" || timestamp == null || Date.now() / 1000 - timestamp > 5 ||
        latest == null || !Number.isFinite(latest)) return undefined;
    const value = mgr.getSmoothed(channel);
    return value != null && Number.isFinite(value) ? value : undefined;
  }

  function update(): void {
    for (const cell of cells) {
      if (cell.guide) {
        const value = currentValue(cell.channel);
        const status = cell.channel === "oil_temp"
          ? oilTemperatureStatus(value == null ? undefined : toF(value))
          : oilPressureStatus(value, currentValue("rpm"));
        cell.cellEl.dataset.tone = status.tone;
        const displayValue = value == null ? undefined : cell.transform ? cell.transform(value) : value;
        const proximity = cell.channel === "oil_temp" && displayValue != null
          ? displayValue < 260 ? ` ${Math.round(260 - displayValue)}°F below hot threshold.` : " At or above hot threshold."
          : "";
        cell.detailsEl!.textContent = `${status.text}.${proximity} ${cell.guide}`;
        cell.color = status.tone === "danger" ? RED
          : status.tone === "caution" ? "rgb(255, 191, 71)" : "rgb(255, 255, 255)";
        if (cell.trackEl) {
          if (cell.channel === "oil_temp") {
            cell.trackEl.style.background = "linear-gradient(to right, #fff 0% 65%, #ffbf47 65% 80%, #ff4436 80% 100%)";
          } else {
            const rpm = currentValue("rpm");
            const redEnd = rpm != null && rpm >= 400 ? rpm > 1500 ? 15 : 10 : 0;
            const amberEnd = rpm != null && rpm >= 3000 ? 50 : redEnd;
            cell.trackEl.style.background = `linear-gradient(to right, #ff4436 0% ${redEnd}%, #ffbf47 ${redEnd}% ${amberEnd}%, #fff ${amberEnd}% 100%)`;
          }
        }
        if (cell.axisEl && cell.fillEl) {
          cell.fillEl.hidden = displayValue == null;
          if (displayValue == null) {
            cell.axisEl.removeAttribute("aria-valuenow");
            cell.axisEl.setAttribute("aria-valuetext", "No current data");
          } else {
            const clamped = Math.max(cell.min, Math.min(cell.max, displayValue));
            cell.fillEl.style.width = `${(clamped - cell.min) / (cell.max - cell.min) * 100}%`;
            cell.axisEl.setAttribute("aria-valuenow", String(clamped));
            cell.axisEl.setAttribute("aria-valuetext", `${Math.round(displayValue)} ${cell.unit}.${proximity}`);
          }
        }
        if (value == null) {
          cell.valueEl.textContent = "--";
          cell.cellEl.classList.remove("warning");
          continue;
        }
      }
      const buf = mgr.getBuffer(cell.channel);
      if (!buf || buf.values.length === 0) continue;

      let smoothed = mgr.getSmoothed(cell.channel) ?? buf.values[buf.values.length - 1];
      let drawValues = buf.values;

      if (cell.transform) {
        smoothed = cell.transform(smoothed);
        drawValues = buf.values.map(cell.transform);
      }

      cell.valueEl.textContent = cell.channel === "battery_voltage"
        ? smoothed.toFixed(1)
        : String(Math.round(smoothed));
      if (!cell.cellEl.classList.contains("details-open")) drawSparkline(cell, drawValues);

      const warnAbove = cell.warnAbove != null && smoothed > cell.warnAbove;
      // Oil pressure is naturally near zero with the engine off and can be
      // around 10 psi at hot idle. Treat it as dangerous only above idle RPM.
      const belowThresholdApplies =
        cell.channel !== "oil_pressure" || (mgr.getSmoothed("rpm") ?? 0) > 1500;
      const warnBelow =
        cell.warnBelow != null && smoothed < cell.warnBelow && belowThresholdApplies;
      cell.cellEl.classList.toggle("warning", warnAbove || warnBelow);
    }
  }

  return { update };
}
