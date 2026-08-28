import "./stream.css";
import { TelemetryManager } from "./telemetry";
import { getTrack } from "./track";
import { STREAM_TRACK_ID } from "./stream-track";
import { trackProgress } from "./track-utils";
import { formatTime, getBestLapTime } from "./format";
import { unpack } from "msgpackr/unpack";

interface Lap {
  lap: number;
  time: number;
  flag: "clean" | "yellow" | "pit" | "out" | "in";
  track: string;
  startSeq: number;
  endSeq: number;
}

interface Session {
  id: string;
  track: string;
  driver: string;
  createdAt: number;
  running: boolean;
  lapStartTs: number;
  laps: Lap[];
}

const mgr = new TelemetryManager();
const serverUrl = mgr.serverUrl;
const trackId = STREAM_TRACK_ID;
const trackDef = getTrack(trackId);
const finishProgress = trackProgress(trackDef.track, trackDef.finishLine[0], trackDef.finishLine[1]);

let session: Session | null = null;
let sessionEs: EventSource | null = null;
let bestLapIdx = -1;
let bestCurve: { norm: number; elapsed: number }[] = [];

// ── DOM ──
const container = document.getElementById("lap-data")!;
container.innerHTML = `
  <div class="stream-driver" id="stream-driver">--</div>
  <div class="stream-lap-count" id="stream-lap-count">--</div>
  <div class="stream-timer" id="stream-timer">0:00.000</div>
  <div class="stream-delta" id="stream-delta"></div>
  <div class="stream-best-row">
    <span class="stream-best-label">BEST</span>
    <span class="stream-best-time" id="stream-best">--</span>
  </div>
  <div class="stream-status" id="stream-status">WAITING FOR SESSION</div>
`;

const driverEl = document.getElementById("stream-driver")!;
const lapCountEl = document.getElementById("stream-lap-count")!;
const timerEl = document.getElementById("stream-timer")!;
const deltaEl = document.getElementById("stream-delta")!;
const bestEl = document.getElementById("stream-best")!;
const statusEl = document.getElementById("stream-status")!;

// ── API ──
async function api(method: string, path: string): Promise<any> {
  const res = await fetch(`${serverUrl}${path}`, { method });
  return res.json();
}

// ── Best lap curve ──
async function loadBestCurve(): Promise<void> {
  if (!session) { bestCurve = []; bestLapIdx = -1; return; }

  const clean = session.laps
    .map((l, i) => ({ ...l, idx: i }))
    .filter((l) => l.flag === "clean");
  if (clean.length === 0) { bestCurve = []; bestLapIdx = -1; return; }

  const best = clean.reduce((a, b) => (a.time < b.time ? a : b));
  if (best.idx === bestLapIdx) return;
  bestLapIdx = best.idx;

  try {
    const res = await fetch(`${serverUrl}/wal/range?start_seq=${best.startSeq}&end_seq=${best.endSeq}`);
    const buf = await res.arrayBuffer();
    const ticks = unpack(new Uint8Array(buf)) as Array<{ ts: number; d: Record<string, number> }>;

    bestCurve = [];
    const startTs = ticks[0]?.ts ?? 0;
    for (const tick of ticks) {
      if (tick.d.gps_lat == null || tick.d.gps_lon == null) continue;
      const p = trackProgress(trackDef.track, tick.d.gps_lat, tick.d.gps_lon);
      const norm = ((p - finishProgress) % 1 + 1) % 1;
      bestCurve.push({ norm, elapsed: tick.ts - startTs });
    }
  } catch {
    bestCurve = [];
    bestLapIdx = -1;
  }
}

function bestTimeAtProgress(norm: number): number | null {
  if (bestCurve.length < 2) return null;
  for (let i = 0; i < bestCurve.length - 1; i++) {
    const a = bestCurve[i];
    const b = bestCurve[i + 1];
    if (a.norm <= norm && b.norm > norm && b.norm - a.norm < 0.5) {
      const frac = (norm - a.norm) / (b.norm - a.norm);
      return a.elapsed + frac * (b.elapsed - a.elapsed);
    }
  }
  return bestCurve[bestCurve.length - 1].elapsed;
}

// ── SSE ──
function subscribe(id: string): void {
  if (sessionEs) { sessionEs.close(); sessionEs = null; }
  sessionEs = new EventSource(`${serverUrl}/sessions/${id}/stream`);
  sessionEs.addEventListener("session", (e) => {
    const updated: Session = JSON.parse(e.data);
    session = updated;
    syncUI();
    loadBestCurve();
  });
}

function syncUI(): void {
  if (!session) {
    driverEl.textContent = "--";
    lapCountEl.textContent = "--";
    timerEl.textContent = "0:00.000";
    deltaEl.textContent = "";
    deltaEl.className = "stream-delta";
    bestEl.textContent = "--";
    statusEl.textContent = "WAITING FOR SESSION";
    return;
  }

  driverEl.textContent = session.driver || "DRIVER";
  lapCountEl.textContent = session.running
    ? `LAP ${session.laps.length + 1} // ${session.laps.length} COMPLETED`
    : `${session.laps.length} LAPS`;
  statusEl.textContent = session.running ? "LIVE" : "SESSION ENDED";

  const best = getBestLapTime(session.laps);
  bestEl.textContent = best !== null ? formatTime(best) : "--";
}

// ── Frame update ──
function update(): void {
  if (!session?.running || !session.lapStartTs) return;

  const currentLap = session.laps.length + 1;
  const elapsed = Date.now() - session.lapStartTs;
  lapCountEl.textContent = `LAP ${currentLap} // ${session.laps.length} COMPLETED`;
  timerEl.textContent = formatTime(elapsed);

  if (bestCurve.length < 2 || currentLap <= 1) {
    deltaEl.textContent = "";
    deltaEl.className = "stream-delta";
    return;
  }

  const latBuf = mgr.getBuffer("gps_lat");
  const lonBuf = mgr.getBuffer("gps_lon");
  if (!latBuf || !lonBuf || latBuf.values.length === 0) return;

  const lat = latBuf.values[latBuf.values.length - 1];
  const lon = lonBuf.values[lonBuf.values.length - 1];
  if (lat === 0 && lon === 0) return;

  const rawP = trackProgress(trackDef.track, lat, lon);
  const norm = ((rawP - finishProgress) % 1 + 1) % 1;
  const bestElapsed = bestTimeAtProgress(norm);
  if (bestElapsed === null) return;

  const delta = elapsed - bestElapsed;
  if (delta <= 0) {
    deltaEl.textContent = `${(delta / 1000).toFixed(3)}`;
    deltaEl.className = "stream-delta ahead";
  } else {
    deltaEl.textContent = `+${(delta / 1000).toFixed(3)}`;
    deltaEl.className = "stream-delta behind";
  }
}

// ── Init ──
async function init() {
  try {
    const sessions: Session[] = await api("GET", `/sessions?track=${trackId}`);
    if (sessions.length > 0) {
      session = sessions[0];
      syncUI();
      await loadBestCurve();
      if (session.running) subscribe(session.id);
    }
  } catch {}
}

init();
mgr.connect();

function loop() {
  if (mgr.dirty) {
    update();
    mgr.clearDirty();
  }
  // still update timer even without new telemetry
  if (session?.running && session.lapStartTs) {
    const elapsed = Date.now() - session.lapStartTs;
    timerEl.textContent = formatTime(elapsed);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
