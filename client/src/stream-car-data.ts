import "./stream.css";
import { TelemetryManager } from "./telemetry";
import { speedToColor, throttleToColor, rpmToColor } from "./track-utils";
import { SERVER_URL } from "./server-url";
import { STREAM_TRACK_ID } from "./stream-track";

const KMH_TO_MPH = 0.621371;
const MAX_MPH = 120;
const MAX_RPM = 7000;
const MPH_SEGMENTS = 32;
const TPS_SEGMENTS = 20;
const RPM_SEGMENTS = 28;

const mgr = new TelemetryManager();
const trackId = STREAM_TRACK_ID;

interface Session {
  id: string;
  driver: string;
  running: boolean;
  laps: { lap: number }[];
}

let session: Session | null = null;
let sessionEs: EventSource | null = null;

// ── Session awareness ──
function syncSession(): void {}

function subscribeSession(id: string): void {
  if (sessionEs) { sessionEs.close(); sessionEs = null; }
  sessionEs = new EventSource(`${SERVER_URL}/sessions/${id}/stream`);
  sessionEs.addEventListener("session", (e) => {
    const updated: Session = JSON.parse(e.data);
    const wasRunning = session?.running;
    session = updated;
    syncSession();
    // Session stopped — fetch latest session to pick up new one
    if (wasRunning && !updated.running) {
      setTimeout(fetchLatestSession, 2000);
    }
  });
  sessionEs.onerror = () => {
    if (sessionEs) { sessionEs.close(); sessionEs = null; }
    setTimeout(fetchLatestSession, 3000);
  };
}

async function fetchLatestSession(): Promise<void> {
  try {
    const res = await fetch(`${SERVER_URL}/sessions?track=${trackId}`);
    const sessions: Session[] = await res.json();
    if (sessions.length > 0) {
      const latest = sessions[0];
      const changed = !session || latest.id !== session.id;
      session = latest;
      syncSession();
      if (changed || latest.running) subscribeSession(latest.id);
    }
  } catch {}
}

// Initial fetch + subscribe
fetchLatestSession();

// ── Gauges ──
function createSegments(count: number): HTMLElement {
  const track = document.createElement("div");
  track.className = "seg-track";
  for (let i = 0; i < count; i++) {
    const seg = document.createElement("div");
    seg.className = "seg";
    track.appendChild(seg);
  }
  return track;
}

function updateSegments(track: HTMLElement, fraction: number, colorFn?: (i: number, n: number) => string): void {
  const segs = track.children;
  const lit = Math.round(fraction * segs.length);
  for (let i = 0; i < segs.length; i++) {
    const el = segs[i] as HTMLElement;
    const on = i < lit;
    el.classList.toggle("seg-on", on);
    if (on && colorFn) {
      const c = colorFn(i, segs.length);
      el.style.background = c;
      el.style.borderColor = c;
      el.style.boxShadow = `0 0 8px ${c}40, inset 0 0 4px ${c}4d`;
    } else if (!on) {
      el.style.background = "";
      el.style.borderColor = "";
      el.style.boxShadow = "";
    }
  }
}

const speedColorFn = (i: number, n: number) => speedToColor(((i + 1) / n) * MAX_MPH / KMH_TO_MPH);
const throttleColorFn = (i: number, n: number) => throttleToColor(((i + 1) / n) * 100);
const rpmColorFn = (i: number, n: number) => rpmToColor((i + 1) / n);

const container = document.getElementById("gauges")!;
// Append gauges after the driver label
container.insertAdjacentHTML("beforeend", `
  <div class="gauge-telem" id="telem-clock">--:--:--.---</div>
  <div class="gauge">
    <div class="gauge-label">SPEED</div>
    <div class="gauge-header">
      <span class="gauge-value" id="gauge-mph">--</span>
      <span class="gauge-unit">MPH</span>
    </div>
  </div>
  <div class="gauge-divider"></div>
  <div class="gauge">
    <div class="gauge-label">RPM</div>
    <div class="gauge-header">
      <span class="gauge-value" id="gauge-rpm">--</span>
      <span class="gauge-unit">RPM</span>
    </div>
  </div>
  <div class="gauge-divider"></div>
  <div class="gauge">
    <div class="gauge-label">THROTTLE</div>
    <div class="gauge-header">
      <span class="gauge-value" id="gauge-tps">--</span>
      <span class="gauge-unit">%TPS</span>
    </div>
  </div>
  <div class="gauge-divider"></div>
  <div class="gauge-label">BRAKE</div>
  <div class="gauge-brake" id="gauge-brake">${Array(10).fill('<div class="gauge-brake-seg"></div>').join("")}</div>
`);

const gauges = container.querySelectorAll(".gauge");
const mphTrack = createSegments(MPH_SEGMENTS);
gauges[0].appendChild(mphTrack);
const rpmTrack = createSegments(RPM_SEGMENTS);
gauges[1].appendChild(rpmTrack);
const tpsTrack = createSegments(TPS_SEGMENTS);
gauges[2].appendChild(tpsTrack);

const mphVal = document.getElementById("gauge-mph")!;
const rpmVal = document.getElementById("gauge-rpm")!;
const tpsVal = document.getElementById("gauge-tps")!;
const brakeEl = document.getElementById("gauge-brake")!;
const telemClockEl = document.getElementById("telem-clock")!;

// The ts the Jetson stamped on the newest tick, rendered in the same local-time
// convention as the clockoverlay burned into the video (see
// streaming/start_streaming.sh) so the two can be read off the frame directly:
// same source clock, so the gap between them is the telemetry-vs-video path
// difference, not clock drift. Ticks on its own timer rather than the render
// loop, so a stalled feed shows as a frozen clock instead of a stale-but-moving
// one.
const TELEM_CLOCK_PERIOD_MS = 100;

function fmtLocal(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function updateTelemClock(): void {
  const ts = mgr.lastTsNum;
  telemClockEl.textContent = ts === 0 ? "--:--:--.---" : fmtLocal(ts);
}

setInterval(updateTelemClock, TELEM_CLOCK_PERIOD_MS);

function update(): void {
  const speedSmoothed = mgr.getSmoothed("gps_speed") ?? mgr.getSmoothed("speed");
  if (speedSmoothed != null) {
    const mph = speedSmoothed * KMH_TO_MPH;
    mphVal.textContent = String(Math.round(mph));
    updateSegments(mphTrack, Math.min(1, mph / MAX_MPH), speedColorFn);
  }

  const rpmSmoothed = mgr.getSmoothed("rpm");
  if (rpmSmoothed != null) {
    rpmVal.textContent = String(Math.round(rpmSmoothed));
    updateSegments(rpmTrack, Math.min(1, rpmSmoothed / MAX_RPM), rpmColorFn);
  }

  const brakeBuf = mgr.getBuffer("brake");
  if (brakeBuf && brakeBuf.values.length > 0) {
    brakeEl.classList.toggle("active", brakeBuf.values[brakeBuf.values.length - 1] > 0.5);
  }

  const tpsSmoothed = mgr.getSmoothed("throttle_pos");
  if (tpsSmoothed != null) {
    const tps = Math.max(0, Math.min(100, tpsSmoothed));
    tpsVal.textContent = String(Math.round(tps));
    updateSegments(tpsTrack, tps / 100, throttleColorFn);
  }
}

mgr.connect();

function loop() {
  if (mgr.dirty) {
    update();
    mgr.clearDirty();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
