import "./compare.css";
import { propagateQueryParams } from "./nav";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import { TRACKS, type TrackDef } from "./track";
import { formatTime, formatDate } from "./format";
import { SERVER_URL } from "./server-url";
import { unpack } from "msgpackr/unpack";
import { buildLapFrame, buildCenterline } from "../../server/src/analysis/ingest";

const TILES_SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_OPTS_SAT: L.TileLayerOptions = { maxZoom: 20 };

const COLOR_A = "#3ddf80";
const COLOR_B = "#5ba8ff";

interface Lap { lap: number; time: number; flag: string; track: string; startSeq: number; endSeq: number; }
interface Session { id: string; track: string; driver: string; createdAt: number; laps: Lap[]; }
interface LapRef { session: Session; lapIdx: number; }

const params = new URLSearchParams(window.location.search);
const trackId = params.get("track") ?? "sonoma";
const trackDef: TrackDef = TRACKS[trackId] ?? TRACKS.sonoma;
const centerline = buildCenterline(trackDef.track, trackDef.finishLine);

// ── State ──
let sessions: Session[] = [];
let slotTarget: "a" | "b" = "a";
let lapA: LapRef | null = null;
let lapB: LapRef | null = null;

// Loaded data
let coordsA: [number, number][] = [];
let coordsB: [number, number][] = [];
let progressA: { norm: number; elapsed: number }[] = [];
let progressB: { norm: number; elapsed: number }[] = [];

// Map lines + position markers
let lineA: L.Polyline | null = null;
let lineB: L.Polyline | null = null;
let markerA: L.CircleMarker | null = null;
let markerB: L.CircleMarker | null = null;

// Cached deltas for scrubbing
let cachedDeltas: { wallTime: number; delta: number; normA: number }[] = [];
let scrubX: number | null = null;

// ── DOM ──
const pickA = document.getElementById("pick-a")!;
const pickB = document.getElementById("pick-b")!;
const treeEl = document.getElementById("session-tree")!;
const statusEl = document.getElementById("compare-status")!;
const searchEl = document.getElementById("tree-search") as HTMLInputElement;
const sortEl = document.getElementById("tree-sort") as HTMLSelectElement;

type SortMode = "lap-asc" | "lap-desc" | "time-asc" | "time-desc";
const deltaCanvas = document.getElementById("delta-canvas") as HTMLCanvasElement;
const deltaCtx = deltaCanvas.getContext("2d")!;

// ── Map ──
const map = L.map("compare-map", {
  zoomControl: false,
  attributionControl: false,
  rotate: true,
  rotateControl: false,
  shiftKeyRotate: false,
  bearing: trackDef.bearing,
} as any).setView(trackDef.center, trackDef.zoom);
L.tileLayer(TILES_SAT, TILE_OPTS_SAT).addTo(map);

// Track outline
L.polyline(trackDef.track as L.LatLngExpression[], {
  color: "rgba(255, 255, 255, 0.15)", weight: 1, dashArray: "4 4",
}).addTo(map);

// Legend
const legendDiv = document.createElement("div");
legendDiv.className = "compare-legend";
legendDiv.innerHTML = `<span class="leg-a">A: --</span><span class="leg-b">B: --</span>`;
document.getElementById("compare-map")!.style.position = "relative";
document.getElementById("compare-map")!.appendChild(legendDiv);

new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById("compare-map")!);

// ── Slot selection ──
pickA.addEventListener("click", () => { slotTarget = "a"; updateSlotDisplay(); });
pickB.addEventListener("click", () => { slotTarget = "b"; updateSlotDisplay(); });

function updateSlotDisplay(): void {
  if (lapA) {
    const l = lapA.session.laps[lapA.lapIdx];
    pickA.textContent = `${lapA.session.driver || "?"} L${l.lap} ${formatTime(l.time)}`;
    pickA.classList.add("filled");
    legendDiv.querySelector(".leg-a")!.textContent = `A: ${lapA.session.driver || "?"} L${l.lap}`;
  } else {
    pickA.textContent = "select lap...";
    pickA.classList.remove("filled");
    legendDiv.querySelector(".leg-a")!.textContent = "A: --";
  }
  if (lapB) {
    const l = lapB.session.laps[lapB.lapIdx];
    pickB.textContent = `${lapB.session.driver || "?"} L${l.lap} ${formatTime(l.time)}`;
    pickB.classList.add("filled");
    legendDiv.querySelector(".leg-b")!.textContent = `B: ${lapB.session.driver || "?"} L${l.lap}`;
  } else {
    pickB.textContent = "select lap...";
    pickB.classList.remove("filled");
    legendDiv.querySelector(".leg-b")!.textContent = "B: --";
  }

  pickA.classList.toggle("active", slotTarget === "a");
  pickB.classList.toggle("active", slotTarget === "b");
}

// ── Session tree ──
function sortedLapIndices(laps: Lap[]): number[] {
  const indices = laps.map((_, i) => i);
  const mode = sortEl.value as SortMode;
  indices.sort((a, b) => {
    switch (mode) {
      case "lap-asc": return laps[a].lap - laps[b].lap;
      case "lap-desc": return laps[b].lap - laps[a].lap;
      case "time-asc": return laps[a].time - laps[b].time;
      case "time-desc": return laps[b].time - laps[a].time;
    }
  });
  return indices;
}

function renderTree(): void {
  treeEl.innerHTML = "";
  updateSlotDisplay();

  const query = searchEl.value.trim().toLowerCase();
  const filtered = query
    ? sessions.filter((s) => (s.driver || "").toLowerCase().includes(query))
    : sessions;

  for (const ses of filtered) {
    const div = document.createElement("div");
    div.className = "tree-session";

    const header = document.createElement("div");
    header.className = "tree-session-header";
    header.innerHTML = `<span>${ses.driver || "UNKNOWN"}</span><span>${formatDate(ses.createdAt)}</span>`;

    const lapsDiv = document.createElement("div");
    lapsDiv.className = "tree-laps";

    // Auto-open if a selected lap belongs to this session, or if searching
    const hasSelected = (lapA?.session.id === ses.id) || (lapB?.session.id === ses.id);
    if (hasSelected || query) lapsDiv.classList.add("open");

    header.addEventListener("click", () => lapsDiv.classList.toggle("open"));

    const sorted = sortedLapIndices(ses.laps);
    for (const i of sorted) {
      const lap = ses.laps[i];
      const row = document.createElement("div");
      row.className = "tree-lap";
      if (lap.flag !== "clean") row.classList.add("flagged");
      if (lapA?.session.id === ses.id && lapA.lapIdx === i) row.classList.add("selected-a");
      if (lapB?.session.id === ses.id && lapB.lapIdx === i) row.classList.add("selected-b");

      row.innerHTML = `<span>L${lap.lap}</span><span>${formatTime(lap.time)}</span>`;
      const idx = i;
      row.addEventListener("click", () => selectLap(ses, idx));
      lapsDiv.appendChild(row);
    }

    div.appendChild(header);
    div.appendChild(lapsDiv);
    treeEl.appendChild(div);
  }
}

searchEl.addEventListener("input", renderTree);
sortEl.addEventListener("change", renderTree);

function selectLap(ses: Session, idx: number): void {
  const ref: LapRef = { session: ses, lapIdx: idx };
  if (slotTarget === "a") {
    lapA = ref;
    // Auto-advance to B only if B is empty
    if (!lapB) slotTarget = "b";
  } else {
    lapB = ref;
  }
  renderTree();
  if (lapA && lapB) loadComparison();
}

// ── IndexedDB cache (shared with review page) ──
const DB_NAME = "telem_review";
const DB_STORE = "cache";
const DB_VERSION = 1;

const dbReady: Promise<IDBDatabase> = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await dbReady;
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const r = tx.objectStore(DB_STORE).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}

// ── Data loading ──
async function fetchLapData(lap: Lap): Promise<{ coords: [number, number][]; progress: { norm: number; elapsed: number }[] }> {
  const cacheKey = `/lap/${lap.startSeq}-${lap.endSeq}`;
  const cached = await cacheGet<{ ticks: Array<{ seq: number; ts: number; d: Record<string, number> }> }>(cacheKey);
  let ticks: Array<{ seq: number; ts: number; d: Record<string, number> }>;

  if (cached) {
    ticks = cached.ticks;
  } else {
    const res = await fetch(`${SERVER_URL}/wal/range?start_seq=${lap.startSeq}&end_seq=${lap.endSeq}`);
    const buf = await res.arrayBuffer();
    ticks = unpack(new Uint8Array(buf)) as typeof ticks;
  }

  const S = buildLapFrame(ticks, 0, "clean", centerline).samples;
  const coords = S.map((x) => [x.lat, x.lon] as [number, number]);
  const progress = S.map((x) => ({ norm: x.s / centerline.totalM, elapsed: x.t * 1000 }));

  return { coords, progress };
}

async function loadComparison(): Promise<void> {
  if (!lapA || !lapB) return;
  statusEl.textContent = "LOADING...";

  try {
    const [dataA, dataB] = await Promise.all([
      fetchLapData(lapA.session.laps[lapA.lapIdx]),
      fetchLapData(lapB.session.laps[lapB.lapIdx]),
    ]);

    coordsA = dataA.coords;
    coordsB = dataB.coords;
    progressA = dataA.progress;
    progressB = dataB.progress;

    drawTrails();
    buildDeltas();
    drawDeltaChart();
    statusEl.textContent = "READY";
  } catch {
    statusEl.textContent = "FETCH FAILED";
  }
}

// ── Map trails ──
function drawTrails(): void {
  if (lineA) { lineA.remove(); lineA = null; }
  if (lineB) { lineB.remove(); lineB = null; }

  if (coordsA.length >= 2) {
    lineA = L.polyline(coordsA as L.LatLngExpression[], { color: COLOR_A, weight: 2.5, opacity: 0.8 }).addTo(map);
  }
  if (coordsB.length >= 2) {
    lineB = L.polyline(coordsB as L.LatLngExpression[], { color: COLOR_B, weight: 2.5, opacity: 0.8 }).addTo(map);
  }

  // Fit bounds to show both
  const all = [...coordsA, ...coordsB];
  if (all.length > 0) {
    map.fitBounds(L.latLngBounds(all as L.LatLngExpression[]).pad(0.1));
  }
}

// ── Delta chart ──
function interpolateElapsed(curve: { norm: number; elapsed: number }[], norm: number): number | null {
  if (curve.length === 0) return null;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (a.norm <= norm && b.norm > norm && b.norm - a.norm < 0.5) {
      const frac = (norm - a.norm) / (b.norm - a.norm);
      return a.elapsed + frac * (b.elapsed - a.elapsed);
    }
  }
  return null;
}

function buildDeltas(): void {
  cachedDeltas = [];
  if (progressA.length < 2 || progressB.length < 2) return;
  for (const pt of progressA) {
    const bElapsed = interpolateElapsed(progressB, pt.norm);
    if (bElapsed !== null) {
      cachedDeltas.push({ wallTime: pt.elapsed, delta: bElapsed - pt.elapsed, normA: pt.norm });
    }
  }
}

function drawDeltaChart(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = deltaCanvas.clientWidth;
  const h = deltaCanvas.clientHeight;
  deltaCanvas.width = w * dpr;
  deltaCanvas.height = h * dpr;
  deltaCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  deltaCtx.clearRect(0, 0, w, h);

  const deltas = cachedDeltas;
  if (deltas.length < 2) return;

  const maxTime = deltas[deltas.length - 1].wallTime;
  let maxDelta = 0;
  for (const d of deltas) {
    const abs = Math.abs(d.delta);
    if (abs > maxDelta) maxDelta = abs;
  }
  maxDelta = Math.max(maxDelta, 500);
  const pad = 20;
  const chartW = w - pad * 2;
  const chartH = h - pad * 2;
  const midY = pad + chartH / 2;

  // Zero line
  deltaCtx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  deltaCtx.lineWidth = 1;
  deltaCtx.beginPath();
  deltaCtx.moveTo(pad, midY);
  deltaCtx.lineTo(pad + chartW, midY);
  deltaCtx.stroke();

  // Grid lines
  deltaCtx.font = "9px monospace";
  deltaCtx.fillStyle = "rgba(255, 255, 255, 0.25)";
  deltaCtx.textAlign = "right";
  deltaCtx.textBaseline = "middle";
  const step = maxDelta > 3000 ? 2000 : maxDelta > 1500 ? 1000 : 500;
  for (let ms = step; ms <= maxDelta; ms += step) {
    const yUp = midY - (ms / maxDelta) * (chartH / 2);
    const yDown = midY + (ms / maxDelta) * (chartH / 2);
    deltaCtx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    deltaCtx.beginPath();
    deltaCtx.moveTo(pad, yUp); deltaCtx.lineTo(pad + chartW, yUp); deltaCtx.stroke();
    deltaCtx.beginPath();
    deltaCtx.moveTo(pad, yDown); deltaCtx.lineTo(pad + chartW, yDown); deltaCtx.stroke();
    deltaCtx.fillText(`+${(ms / 1000).toFixed(1)}s`, pad - 4, yDown);
    deltaCtx.fillText(`-${(ms / 1000).toFixed(1)}s`, pad - 4, yUp);
  }

  // Labels
  deltaCtx.fillStyle = COLOR_A;
  deltaCtx.textAlign = "left";
  deltaCtx.textBaseline = "top";
  deltaCtx.fillText("A FASTER ▲", pad, 2);
  deltaCtx.fillStyle = COLOR_B;
  deltaCtx.textBaseline = "bottom";
  deltaCtx.fillText("B FASTER ▼", pad, h - 2);

  // X-axis labels
  deltaCtx.fillStyle = "rgba(255, 255, 255, 0.25)";
  deltaCtx.textAlign = "center";
  deltaCtx.textBaseline = "bottom";
  const xStep = maxTime > 60000 ? 15000 : maxTime > 30000 ? 10000 : 5000;
  for (let ms = xStep; ms < maxTime; ms += xStep) {
    const x = pad + (ms / maxTime) * chartW;
    deltaCtx.fillText(`${(ms / 1000).toFixed(0)}s`, x, h - 2);
  }

  // Delta line
  deltaCtx.lineWidth = 2;
  for (let i = 1; i < deltas.length; i++) {
    const x0 = pad + (deltas[i - 1].wallTime / maxTime) * chartW;
    const x1 = pad + (deltas[i].wallTime / maxTime) * chartW;
    const y0 = midY + (deltas[i - 1].delta / maxDelta) * (chartH / 2);
    const y1 = midY + (deltas[i].delta / maxDelta) * (chartH / 2);
    deltaCtx.beginPath();
    deltaCtx.moveTo(x0, y0);
    deltaCtx.lineTo(x1, y1);
    deltaCtx.strokeStyle = deltas[i].delta >= 0 ? COLOR_A : COLOR_B;
    deltaCtx.stroke();
  }

  // Final delta readout
  const finalDelta = deltas[deltas.length - 1].delta;
  deltaCtx.font = "bold 12px monospace";
  deltaCtx.textAlign = "right";
  deltaCtx.textBaseline = "top";
  deltaCtx.fillStyle = finalDelta >= 0 ? COLOR_A : COLOR_B;
  const sign = finalDelta >= 0 ? "+" : "";
  deltaCtx.fillText(`Δ ${sign}${(finalDelta / 1000).toFixed(3)}s`, w - pad, 2);

  // Scrub cursor
  if (scrubX !== null) {
    const frac = Math.max(0, Math.min(1, (scrubX - pad) / chartW));
    const idx = Math.round(frac * (deltas.length - 1));
    const d = deltas[Math.max(0, Math.min(idx, deltas.length - 1))];
    const cx = pad + (d.wallTime / maxTime) * chartW;
    const cy = midY + (d.delta / maxDelta) * (chartH / 2);

    // Vertical line
    deltaCtx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    deltaCtx.lineWidth = 1;
    deltaCtx.beginPath();
    deltaCtx.moveTo(cx, pad);
    deltaCtx.lineTo(cx, pad + chartH);
    deltaCtx.stroke();

    // Dot on curve
    deltaCtx.beginPath();
    deltaCtx.arc(cx, cy, 4, 0, Math.PI * 2);
    deltaCtx.fillStyle = d.delta >= 0 ? COLOR_A : COLOR_B;
    deltaCtx.fill();
    deltaCtx.strokeStyle = "#fff";
    deltaCtx.lineWidth = 1.5;
    deltaCtx.stroke();

    // Delta readout at cursor
    deltaCtx.font = "bold 10px monospace";
    deltaCtx.textAlign = "center";
    deltaCtx.textBaseline = "bottom";
    deltaCtx.fillStyle = d.delta >= 0 ? COLOR_A : COLOR_B;
    const ds = d.delta >= 0 ? "+" : "";
    deltaCtx.fillText(`${ds}${(d.delta / 1000).toFixed(3)}s`, cx, cy - 8);

    // Time readout
    deltaCtx.fillStyle = "rgba(255, 255, 255, 0.5)";
    deltaCtx.font = "9px monospace";
    deltaCtx.textBaseline = "top";
    deltaCtx.fillText(`${(d.wallTime / 1000).toFixed(1)}s`, cx, pad + chartH + 2);
  }
}

// ── Scrubbing ──
function nearestCoordAtNorm(coords: [number, number][], progress: { norm: number; elapsed: number }[], norm: number): [number, number] | null {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < progress.length; i++) {
    const d = Math.abs(progress[i].norm - norm);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return coords[best] ?? null;
}

function updateScrubMarkers(norm: number): void {
  const posA = nearestCoordAtNorm(coordsA, progressA, norm);
  const posB = nearestCoordAtNorm(coordsB, progressB, norm);

  if (posA) {
    if (!markerA) {
      markerA = L.circleMarker(posA as L.LatLngExpression, { radius: 5, color: "#fff", fillColor: COLOR_A, fillOpacity: 1, weight: 2 }).addTo(map);
    } else {
      markerA.setLatLng(posA as L.LatLngExpression);
    }
  }
  if (posB) {
    if (!markerB) {
      markerB = L.circleMarker(posB as L.LatLngExpression, { radius: 5, color: "#fff", fillColor: COLOR_B, fillOpacity: 1, weight: 2 }).addTo(map);
    } else {
      markerB.setLatLng(posB as L.LatLngExpression);
    }
  }
}

function clearScrub(): void {
  scrubX = null;
  if (markerA) { markerA.remove(); markerA = null; }
  if (markerB) { markerB.remove(); markerB = null; }
  drawDeltaChart();
}

deltaCanvas.style.cursor = "crosshair";

deltaCanvas.addEventListener("mousemove", (e) => {
  if (cachedDeltas.length < 2) return;
  const rect = deltaCanvas.getBoundingClientRect();
  scrubX = e.clientX - rect.left;
  const pad = 20;
  const chartW = deltaCanvas.clientWidth - pad * 2;
  const frac = Math.max(0, Math.min(1, (scrubX - pad) / chartW));
  const idx = Math.round(frac * (cachedDeltas.length - 1));
  const d = cachedDeltas[Math.max(0, Math.min(idx, cachedDeltas.length - 1))];
  updateScrubMarkers(d.normA);
  drawDeltaChart();
});

deltaCanvas.addEventListener("mouseleave", clearScrub);

// Resize handler
new ResizeObserver(() => {
  if (cachedDeltas.length > 0) drawDeltaChart();
}).observe(document.getElementById("compare-chart")!);

// ── Init ──
async function init(): Promise<void> {
  const cacheKey = `/sessions?track=${trackId}`;
  try {
    const res = await fetch(`${SERVER_URL}/sessions?track=${trackId}`);
    sessions = await res.json();
  } catch {
    sessions = await cacheGet<Session[]>(cacheKey) ?? [];
  }
  renderTree();
}

init();
propagateQueryParams();
