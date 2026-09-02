import { TelemetryManager } from "./telemetry";
import {
  REFERENCE_ENVELOPE, growEnvelope, utilization, type Envelope,
} from "../../server/src/analysis/traction";
import {
  createGCircleCanvas,
  drawGCircle,
  emaStep,
  toDisplayAxes,
  G_TRAIL_LEN,
  type GPoint,
} from "./gcircle-renderer";

export interface SessionUtil {
  meanU: number | null;
  envelope: Envelope;
  sampleCount: number;
}

export interface GCirclePanel {
  update: () => void;
  sessionUtil: () => SessionUtil;
  resetSession: () => void;
}

export function createGCircle(
  container: HTMLElement,
  mgr: TelemetryManager,
): GCirclePanel {
  const canvas = createGCircleCanvas(container);
  const trail: GPoint[] = [];
  let ema: GPoint | null = null;

  let envelope: Envelope = REFERENCE_ENVELOPE;
  let uSum = 0;
  let uCount = 0;
  // The render loop runs faster than the 22 Hz data, so accumulate only when
  // the buffer has actually grown or the mean is just a count of frames.
  let lastLen = -1;

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

    if (len > 0 && len !== lastLen) {
      lastLen = len;
      // Raw sample, not the EWMA: smoothing would clip the peaks the envelope
      // is made of.
      const latG = -gy;
      const longG = -gx;   // signed, forward positive — the hull needs both halves
      envelope = growEnvelope(envelope, latG, longG);
      uSum += utilization(Math.abs(latG), Math.max(-longG, 0), envelope);
      uCount++;
    }

    drawGCircle(canvas, ema, trail, envelope);
  }

  return {
    update,
    sessionUtil: () => ({
      meanU: uCount > 0 ? uSum / uCount : null,
      envelope,
      sampleCount: uCount,
    }),
    resetSession: () => { uSum = 0; uCount = 0; envelope = REFERENCE_ENVELOPE; },
  };
}
