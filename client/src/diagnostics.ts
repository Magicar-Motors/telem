import { TelemetryManager } from "./telemetry";

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
  parent.appendChild(cell);

  const canvas = cell.querySelector(".diag-cell-spark") as HTMLCanvasElement;

  return {
    channel, label, unit,
    valueEl: cell.querySelector(".diag-cell-value") as HTMLElement,
    cellEl: cell,
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
    createCell(grid, "oil_temp", "油温 OIL TEMP", "\u00B0F", ORANGE, 100, 300, 260, toF),
    createCell(grid, "oil_pressure", "油圧 OIL PRESS", "PSI", YELLOW, 0, 100, undefined, undefined, 15),
    createCell(grid, "battery_voltage", "電圧 BATTERY", "V", GREEN, 11, 15),
    createCell(grid, "manifold_pressure", "圧力 MAP", "kPa", ORANGE, 0, 110),
    createCell(grid, "jetson_temp", "基板 JETSON", "\u00B0C", CYAN, 20, 100, 85),
  ];

  function update(): void {
    for (const cell of cells) {
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
      drawSparkline(cell, drawValues);

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
