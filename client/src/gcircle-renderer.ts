/** Shared g-force circle: canvas setup, axis mapping, smoothing, and drawing.
 *  The dashboard feeds it live samples; review feeds it a seek position. */

export const MAX_G = 1.5;
export const RING_STEPS = [0.5, 1.0, 1.5];
export const G_TRAIL_LEN = 200;

const EMA_ALPHA = 0.15;
const PAD = 24;
const AXIS_GAP = 18;
const SIDE_GAP = 16;
const TEXT_INSET = 8;

const GRID_DIM = "rgba(255, 255, 255, 0.06)";
const GRID_LINE = "rgba(255, 255, 255, 0.1)";
const GRID_TEXT = "rgba(255, 255, 255, 0.2)";
const AXIS_LABEL = "rgba(255, 107, 53, 0.5)";
const DOT_COLOR = "#ff6b35";
const TEXT_BRIGHT = "#eee";
const LIMIT_LINE = "rgba(255, 255, 255, 0.17)";

export interface GPoint {
  x: number;
  y: number;
}

/** Lateral and braking limits in g. Braking only — the car is power-limited
 *  on exit, not traction-limited, so the acceleration half is not measured. */
export interface GEnvelope {
  muY: number;
  muX: number;
  /** Convex hull of the sample cloud, in the same axes as `GPoint`. Preferred
   *  over the ellipse: it is the shape the car actually made, flat across the
   *  bottom where acceleration runs out. */
  hull?: [number, number][];
}

export interface GCircleCanvas {
  ctx: CanvasRenderingContext2D;
  readonly w: number;
  readonly h: number;
}

export function createGCircleCanvas(container: HTMLElement): GCircleCanvas {
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d")!;
  let w = 0;
  let h = 0;

  new ResizeObserver((entries) => {
    for (const entry of entries) {
      const r = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }).observe(container);

  return {
    ctx,
    get w() { return w; },
    get h() { return h; },
  };
}

/** Accelerometer axes to screen axes: right turn goes right, braking goes up. */
export function toDisplayAxes(gx: number, gy: number): GPoint {
  return { x: -gy, y: -gx };
}

export function emaStep(prev: GPoint | null, next: GPoint): GPoint {
  if (!prev) return next;
  return {
    x: EMA_ALPHA * next.x + (1 - EMA_ALPHA) * prev.x,
    y: EMA_ALPHA * next.y + (1 - EMA_ALPHA) * prev.y,
  };
}

export function drawGCircle(
  c: GCircleCanvas,
  cur: GPoint,
  trail: readonly GPoint[],
  envelope?: GEnvelope | null,
): void {
  const { ctx, w, h } = c;
  if (w === 0 || h === 0) return;

  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - PAD;
  const scale = radius / MAX_G;

  ctx.lineWidth = 1;
  for (const g of RING_STEPS) {
    ctx.beginPath();
    ctx.arc(cx, cy, g * scale, 0, Math.PI * 2);
    ctx.strokeStyle = GRID_DIM;
    ctx.stroke();
  }

  ctx.strokeStyle = GRID_LINE;
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  for (const g of RING_STEPS) {
    const r = g * scale;
    const tick = 3;
    ctx.beginPath();
    ctx.moveTo(cx + r, cy - tick);
    ctx.lineTo(cx + r, cy + tick);
    ctx.moveTo(cx - r, cy - tick);
    ctx.lineTo(cx - r, cy + tick);
    ctx.moveTo(cx - tick, cy + r);
    ctx.lineTo(cx + tick, cy + r);
    ctx.moveTo(cx - tick, cy - r);
    ctx.lineTo(cx + tick, cy - r);
    ctx.stroke();
  }

  ctx.fillStyle = GRID_TEXT;
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  for (const g of RING_STEPS) {
    ctx.fillText(`${g}g`, cx + 3, cy - g * scale - 2);
  }

  if (envelope) {
    ctx.strokeStyle = LIMIT_LINE;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    if (envelope.hull && envelope.hull.length >= 3) {
      for (let i = 0; i < envelope.hull.length; i++) {
        const [hx, hy] = envelope.hull[i];
        const px = cx + hx * scale;
        const py = cy + hy * scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else if (envelope.muY > 0 && envelope.muX > 0) {
      // No cloud to hull — a fixed envelope, or a session with nothing in it.
      ctx.ellipse(cx, cy, envelope.muY * scale, envelope.muX * scale, 0, 0, 2 * Math.PI);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  ctx.fillStyle = AXIS_LABEL;
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("BRAKE", cx, cy - radius - AXIS_GAP);
  ctx.textBaseline = "bottom";
  ctx.fillText("ACCEL", cx, cy + radius + AXIS_GAP);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("L", cx - radius - SIDE_GAP, cy);
  ctx.textAlign = "right";
  ctx.fillText("R", cx + radius + SIDE_GAP, cy);

  for (let i = 0; i < trail.length; i++) {
    const t = trail[i];
    const alpha = 0.03 + (i / trail.length) * 0.35;
    ctx.beginPath();
    ctx.arc(cx + t.x * scale, cy + t.y * scale, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 107, 53, ${alpha})`;
    ctx.fill();
  }

  const px = cx + cur.x * scale;
  const py = cy + cur.y * scale;

  ctx.beginPath();
  ctx.arc(px, py, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 107, 53, 0.12)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fillStyle = DOT_COLOR;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const mag = Math.sqrt(cur.x * cur.x + cur.y * cur.y);
  ctx.fillStyle = TEXT_BRIGHT;
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(`${mag.toFixed(2)}g`, w - TEXT_INSET, TEXT_INSET);
}
