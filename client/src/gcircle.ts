import { TelemetryManager } from "./telemetry";
import {
  createGCircleCanvas,
  drawGCircle,
  emaStep,
  toDisplayAxes,
  G_TRAIL_LEN,
  type GPoint,
} from "./gcircle-renderer";

export interface GCirclePanel {
  update: () => void;
}

export function createGCircle(
  container: HTMLElement,
  mgr: TelemetryManager,
): GCirclePanel {
  const canvas = createGCircleCanvas(container);
  const trail: GPoint[] = [];
  let ema: GPoint | null = null;

  function update(): void {
    if (canvas.w === 0 || canvas.h === 0) return;

    const gxBuf = mgr.getBuffer("g_force_x");
    const gyBuf = mgr.getBuffer("g_force_y");

    const len = Math.min(gxBuf?.values.length ?? 0, gyBuf?.values.length ?? 0);
    const gx = len > 0 ? gxBuf!.values[len - 1] : 0;
    const gy = len > 0 ? gyBuf!.values[len - 1] : 0;

    ema = emaStep(ema, toDisplayAxes(gx, gy));
    trail.push(ema);
    if (trail.length > G_TRAIL_LEN) trail.splice(0, trail.length - G_TRAIL_LEN);

    drawGCircle(canvas, ema, trail);
  }

  return { update };
}
