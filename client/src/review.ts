import "./review.css";
import { propagateQueryParams } from "./nav";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import { TRACKS, type TrackDef } from "./track";
import { speedToColor, throttleToColor, rpmToColor } from "./track-utils";
import { createDropdown } from "./dropdown";
import { formatTime, formatDate, getBestLapTime } from "./format";
import { SERVER_URL } from "./server-url";
import { unpack } from "msgpackr/unpack";

const TILES_NOLABELS = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const TILES_SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_OPTS: L.TileLayerOptions = { maxZoom: 20, subdomains: "abcd" };
const TILE_OPTS_SAT: L.TileLayerOptions = { maxZoom: 20 };

interface Lap { lap: number; time: number; flag: "clean" | "yellow" | "pit" | "out" | "in"; track: string; startSeq: number; endSeq: number; }
interface Session { id: string; track: string; driver: string; createdAt: number; running: boolean; laps: Lap[]; }
interface WalTick { seq: number; ts: number; d: Record<string, number>; }

// ── State ──
const params = new URLSearchParams(window.location.search);
const trackId = params.get("track") ?? "sonoma";
let trackDef: TrackDef = TRACKS[trackId] ?? TRACKS.sonoma;

let sessions: Session[] = [];
let session: Session | null = null;
let selectedLapIdx = -1;
let selectLapGen = 0;
const inflightFetches = new Map<string, { background: boolean }>();
const inflightPromises = new Map<string, Promise<{ ticks: any[] }>>();
let lapTicks: WalTick[] = [];
let lapCoords: [number, number][] = [];
let lapSpeeds: number[] = [];
let lapThrottles: number[] = [];
let lapGx: number[] = [];
let lapGy: number[] = [];
let lapRpms: number[] = [];
let lapGears: number[] = [];
let lapBrakes: number[] = [];
let lapOilTempsC: number[] = [];
let lapOilPressures: number[] = [];
let lapTimestamps: number[] = [];
let trailMode: "speed" | "throttle" | "rpm" | "gear" | "brake" = "speed";
let allLapsLines: L.Polyline[] = [];
let trailHitAreas: L.Polyline[] = [];
let aggVisible: Set<number> = new Set();
let aggHighlight = -1; // index of highlighted lap, -1 = auto-best

const KMH_TO_MPH = 0.621371;
const MAX_MPH = 120;
const MAX_RPM = 7000;
const SPEED_SEGS = 24;
const TPS_SEGS = 16;
const RPM_SEGS = 20;

// ── DOM ──
const metaEl = document.getElementById("review-meta")!;
const sessionListEl = document.getElementById("review-session-list")!;
const lapListEl = document.getElementById("review-lap-list")!;
const mapEl = document.getElementById("review-map")!;
const gcircleEl = document.getElementById("review-gcircle")!;
const gaugesEl = document.getElementById("review-gauges")!;
const legendEl = document.getElementById("review-legend")!;
const seekEl = document.getElementById("review-seek") as HTMLInputElement;
const seekTimeEl = document.getElementById("review-seek-time")!;
const seekEpochEl = document.getElementById("review-seek-epoch")!;

const playBtn = document.getElementById("btn-play")!;

const aggControlsEl = document.getElementById("agg-controls")!;

function setAggregateMode(on: boolean): void {
  gcircleEl.style.display = on ? "none" : "";
  gaugesEl.style.display = on ? "none" : "";
  seekEl.style.display = on ? "none" : "";
  seekTimeEl.style.display = on ? "none" : "";
  seekEpochEl.style.display = on ? "none" : "";
  aggControlsEl.style.display = on ? "" : "none";
}

function renderAggControls(): void {
  if (selectedLapIdx !== -2 || !session) {
    aggControlsEl.style.display = "none";
    aggControlsEl.innerHTML = "";
    return;
  }
  aggControlsEl.style.display = "";
  aggControlsEl.innerHTML = "";

  const best = getBestTime();

  const table = document.createElement("table");
  table.className = "agg-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th>VIS</th><th>HL</th><th>LAP</th><th>TIME</th><th>DELTA</th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (let i = 0; i < session.laps.length; i++) {
    const lap = session.laps[i];
    const checked = aggVisible.has(i);
    const highlighted = aggHighlight === i;

    const tr = document.createElement("tr");

    const tdCb = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.addEventListener("change", () => {
      if (cb.checked) aggVisible.add(i); else aggVisible.delete(i);
      drawAggregateTrails();
    });
    tdCb.appendChild(cb);

    const tdRb = document.createElement("td");
    const rb = document.createElement("input");
    rb.type = "radio";
    rb.name = "agg-hl";
    rb.checked = highlighted;
    rb.addEventListener("change", () => {
      aggHighlight = i;
      drawAggregateTrails();
    });
    tdRb.appendChild(rb);

    const tdLap = document.createElement("td");
    tdLap.textContent = `L${lap.lap}`;

    const tdTime = document.createElement("td");
    tdTime.textContent = formatTime(lap.time);

    const tdDelta = document.createElement("td");
    const delta = best !== null && lap.flag === "clean" ? lap.time - best : null;
    if (delta === 0) { tdDelta.textContent = "BEST"; tdDelta.className = "agg-best"; }
    else if (delta !== null && delta > 0) tdDelta.textContent = `+${(delta / 1000).toFixed(3)}`;

    tr.appendChild(tdCb);
    tr.appendChild(tdRb);
    tr.appendChild(tdLap);
    tr.appendChild(tdTime);
    tr.appendChild(tdDelta);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  aggControlsEl.appendChild(table);
}

// ── Trail mode dropdown (opens upward) ──
type TrailMode = "speed" | "throttle" | "rpm" | "gear" | "brake";
const trailModeDropdown = createDropdown("SPEED", "", "up");
trailModeDropdown.setOptions([
  { value: "speed", label: "SPEED" },
  { value: "throttle", label: "THROTTLE" },
  { value: "rpm", label: "RPM" },
  { value: "brake", label: "BRAKE" },
]);
trailModeDropdown.setValue("speed");
trailModeDropdown.onChange = (v) => {
  trailMode = v as TrailMode;
  if (selectedLapIdx === -2) {
    drawAggregateTrails();
  } else {
    drawTrail();
  }
  renderLegend();
};
document.getElementById("review-trail-modes")!.appendChild(trailModeDropdown.el);

// Trail color functions for each mode
const GEAR_COLORS = ["#3498db", "#ffffff", "#f1c40f", "#ff6b35", "#e74c3c"];
function gearToColor(gear: number): string {
  return GEAR_COLORS[Math.max(0, Math.min(gear - 1, GEAR_COLORS.length - 1))] ?? "#999";
}
function rpmToColorByValue(rpm: number): string {
  return rpmToColor(Math.min(1, rpm / MAX_RPM));
}

// ── Map ──
const map = L.map(mapEl, {
  zoomControl: true,
  attributionControl: false,
  rotate: true,
  rotateControl: false,
  shiftKeyRotate: false,
  bearing: trackDef.bearing,
} as any).setView(trackDef.center, trackDef.zoom);
let darkTiles = L.tileLayer(TILES_NOLABELS, TILE_OPTS).addTo(map);
let satTiles = L.tileLayer(TILES_SAT, TILE_OPTS_SAT);
let isSat = false;

const satToggle = document.getElementById("review-sat-toggle")!;
satToggle.addEventListener("click", () => {
  isSat = !isSat;
  satToggle.classList.toggle("active", isSat);
  if (isSat) {
    map.removeLayer(darkTiles);
    satTiles.addTo(map);
  } else {
    map.removeLayer(satTiles);
    darkTiles.addTo(map);
  }
});

new ResizeObserver(() => map.invalidateSize()).observe(mapEl);

let trackOverlays: L.Layer[] = [];
function drawTrackOverlays() {
  for (const l of trackOverlays) map.removeLayer(l);
  trackOverlays = [];
  trackOverlays.push(L.polyline(trackDef.track as L.LatLngExpression[], { color: "rgba(255,255,255,0.3)", weight: 1.2, dashArray: "4 4" }).addTo(map));
  trackOverlays.push(L.marker(trackDef.finishLine, { icon: L.divIcon({ className: "turn-label sf-label", html: "S/F", iconSize: [24, 14], iconAnchor: [12, 7] }), interactive: false }).addTo(map));
  for (const t of trackDef.turns) {
    trackOverlays.push(L.marker(t.pos, { icon: L.divIcon({ className: "turn-label", html: t.label, iconSize: [20, 14], iconAnchor: [10, 7] }), interactive: false }).addTo(map));
  }
}
drawTrackOverlays();

let trailLines: L.Polyline[] = [];
let posMarker: L.Marker | null = null;

// ── G-force canvas ──
const gCanvas = document.createElement("canvas");
gcircleEl.appendChild(gCanvas);
const gCtx = gCanvas.getContext("2d")!;
let gW = 0, gH = 0;

new ResizeObserver((entries) => {
  for (const entry of entries) {
    const r = entry.contentRect;
    const dpr = window.devicePixelRatio || 1;
    gW = r.width; gH = r.height;
    gCanvas.width = gW * dpr; gCanvas.height = gH * dpr;
    gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}).observe(gcircleEl);

const MAX_G = 1.0;
const RING_STEPS = [0.25, 0.5, 0.75, 1.0];
const G_TRAIL_LEN = 200;
const G_EMA_ALPHA = 0.15;

let gTrail: { x: number; y: number }[] = [];
let gEmaX = 0, gEmaY = 0, gEmaInit = false;
let gLastIdx = -1;

function resetGTrail() {
  gTrail = [];
  gEmaInit = false;
  gLastIdx = -1;
}

function drawGCircle(gx: number, gy: number, seekIdx = -1) {
  if (gW === 0 || gH === 0) return;

  const latG = -gy;
  const lonG = -gx;

  // Build trail from EWMA-smoothed points
  if (seekIdx >= 0 && lapGx.length > 0) {
    // If scrubbing backwards or to a different region, rebuild trail
    if (seekIdx < gLastIdx || seekIdx - gLastIdx > G_TRAIL_LEN) {
      gTrail = [];
      gEmaInit = false;
      const start = Math.max(0, seekIdx - G_TRAIL_LEN + 1);
      for (let i = start; i <= seekIdx; i++) {
        const rx = -(lapGy[i] ?? 0);
        const ry = -(lapGx[i] ?? 0);
        if (!gEmaInit) { gEmaX = rx; gEmaY = ry; gEmaInit = true; }
        else { gEmaX = G_EMA_ALPHA * rx + (1 - G_EMA_ALPHA) * gEmaX; gEmaY = G_EMA_ALPHA * ry + (1 - G_EMA_ALPHA) * gEmaY; }
        gTrail.push({ x: gEmaX, y: gEmaY });
      }
    } else {
      // Forward scrub: append new points
      for (let i = gLastIdx + 1; i <= seekIdx; i++) {
        const rx = -(lapGy[i] ?? 0);
        const ry = -(lapGx[i] ?? 0);
        if (!gEmaInit) { gEmaX = rx; gEmaY = ry; gEmaInit = true; }
        else { gEmaX = G_EMA_ALPHA * rx + (1 - G_EMA_ALPHA) * gEmaX; gEmaY = G_EMA_ALPHA * ry + (1 - G_EMA_ALPHA) * gEmaY; }
        gTrail.push({ x: gEmaX, y: gEmaY });
      }
      if (gTrail.length > G_TRAIL_LEN) gTrail.splice(0, gTrail.length - G_TRAIL_LEN);
    }
    gLastIdx = seekIdx;
  }

  gCtx.clearRect(0, 0, gW, gH);

  const cx = gW / 2, cy = gH / 2;
  const radius = Math.min(cx, cy) - 20;
  const scale = radius / MAX_G;

  // rings
  gCtx.lineWidth = 1;
  for (const g of RING_STEPS) {
    gCtx.beginPath();
    gCtx.arc(cx, cy, g * scale, 0, Math.PI * 2);
    gCtx.strokeStyle = "rgba(255,255,255,0.06)";
    gCtx.stroke();
  }

  // crosshair
  gCtx.strokeStyle = "rgba(255,255,255,0.1)";
  gCtx.beginPath();
  gCtx.moveTo(cx - radius, cy); gCtx.lineTo(cx + radius, cy);
  gCtx.moveTo(cx, cy - radius); gCtx.lineTo(cx, cy + radius);
  gCtx.stroke();

  // tick marks
  for (const g of RING_STEPS) {
    const r = g * scale;
    gCtx.beginPath();
    gCtx.moveTo(cx + r, cy - 3); gCtx.lineTo(cx + r, cy + 3);
    gCtx.moveTo(cx - r, cy - 3); gCtx.lineTo(cx - r, cy + 3);
    gCtx.moveTo(cx - 3, cy + r); gCtx.lineTo(cx + 3, cy + r);
    gCtx.moveTo(cx - 3, cy - r); gCtx.lineTo(cx + 3, cy - r);
    gCtx.stroke();
  }

  // labels
  gCtx.fillStyle = "rgba(255,255,255,0.2)";
  gCtx.font = "9px monospace";
  gCtx.textAlign = "left"; gCtx.textBaseline = "bottom";
  for (const g of RING_STEPS) gCtx.fillText(`${g}g`, cx + 3, cy - g * scale - 2);

  gCtx.fillStyle = "rgba(255,107,53,0.5)";
  gCtx.font = "bold 9px monospace";
  gCtx.textAlign = "center";
  gCtx.textBaseline = "top"; gCtx.fillText("BRAKE", cx, cy - radius - 16);
  gCtx.textBaseline = "bottom"; gCtx.fillText("ACCEL", cx, cy + radius + 16);
  gCtx.textAlign = "left"; gCtx.textBaseline = "middle"; gCtx.fillText("L", cx - radius - 14, cy);
  gCtx.textAlign = "right"; gCtx.fillText("R", cx + radius + 14, cy);

  // trail
  for (let i = 0; i < gTrail.length; i++) {
    const t = gTrail[i];
    const alpha = 0.03 + (i / gTrail.length) * 0.35;
    gCtx.beginPath();
    gCtx.arc(cx + t.x * scale, cy + t.y * scale, 1.5, 0, Math.PI * 2);
    gCtx.fillStyle = `rgba(255, 107, 53, ${alpha})`;
    gCtx.fill();
  }

  // current dot
  const curX = gTrail.length > 0 ? gEmaX : latG;
  const curY = gTrail.length > 0 ? gEmaY : lonG;
  const px = cx + curX * scale;
  const py = cy + curY * scale;
  gCtx.beginPath(); gCtx.arc(px, py, 8, 0, Math.PI * 2);
  gCtx.fillStyle = "rgba(255,107,53,0.12)"; gCtx.fill();
  gCtx.beginPath(); gCtx.arc(px, py, 4, 0, Math.PI * 2);
  gCtx.fillStyle = "#ff6b35"; gCtx.fill();
  gCtx.strokeStyle = "#fff"; gCtx.lineWidth = 1.5; gCtx.stroke();

  // magnitude
  const mag = Math.sqrt(curX * curX + curY * curY);
  gCtx.fillStyle = "#eee"; gCtx.font = "bold 11px monospace";
  gCtx.textAlign = "right"; gCtx.textBaseline = "top";
  gCtx.fillText(`${mag.toFixed(2)}g`, gW - 6, 6);
}

// ── Gauges ──
function makeSegTrack(count: number): HTMLElement {
  const track = document.createElement("div");
  track.className = "review-seg-track";
  for (let i = 0; i < count; i++) {
    const seg = document.createElement("div");
    seg.className = "review-seg";
    track.appendChild(seg);
  }
  return track;
}

// Speed gauge
const speedGauge = document.createElement("div");
speedGauge.className = "review-gauge";
speedGauge.innerHTML = `<div class="review-gauge-label">速度 SPEED</div><div class="review-gauge-header"><span class="review-gauge-value" id="rv-speed">--</span><span class="review-gauge-unit">MPH</span></div>`;
const speedSegTrack = makeSegTrack(SPEED_SEGS);
speedGauge.appendChild(speedSegTrack);
gaugesEl.appendChild(speedGauge);
const speedValueEl = speedGauge.querySelector("#rv-speed")!;

// Throttle gauge
const throttleGauge = document.createElement("div");
throttleGauge.className = "review-gauge";
throttleGauge.innerHTML = `<div class="review-gauge-label">開度 THROTTLE</div><div class="review-gauge-header"><span class="review-gauge-value" id="rv-throttle">--</span><span class="review-gauge-unit">%</span></div>`;
const tpsSegTrack = makeSegTrack(TPS_SEGS);
throttleGauge.appendChild(tpsSegTrack);
gaugesEl.appendChild(throttleGauge);
const throttleValueEl = throttleGauge.querySelector("#rv-throttle")!;

// RPM gauge with gear badge
const rpmGauge = document.createElement("div");
rpmGauge.className = "review-gauge";
rpmGauge.innerHTML = `<div class="review-gauge-label">回転 RPM</div><div class="review-gauge-header"><span class="review-gauge-value" id="rv-rpm">--</span><span class="review-gauge-unit">RPM</span></div>`;
const rpmSegTrack = makeSegTrack(RPM_SEGS);
rpmGauge.appendChild(rpmSegTrack);
gaugesEl.appendChild(rpmGauge);
const rpmValueEl = rpmGauge.querySelector("#rv-rpm")!;

// Brake bar
const brakeWrap = document.createElement("div");
brakeWrap.className = "review-gauge";
brakeWrap.innerHTML = `<div class="review-gauge-label">制動 BRAKE</div><div class="review-brake" id="rv-brake">${Array(10).fill('<div class="review-brake-seg"></div>').join("")}</div>`;
gaugesEl.appendChild(brakeWrap);
const brakeEl = brakeWrap.querySelector("#rv-brake")!;

// Engine health readouts
const engineGauges = document.createElement("div");
engineGauges.className = "review-engine-gauges";
engineGauges.innerHTML = `
  <div class="review-gauge review-gauge-compact">
    <div class="review-gauge-label">油温 OIL TEMP</div>
    <div class="review-gauge-header"><span class="review-gauge-value" id="rv-oil-temp">--</span><span class="review-gauge-unit">\u00B0F</span></div>
  </div>
  <div class="review-gauge review-gauge-compact">
    <div class="review-gauge-label">油圧 OIL PRESS</div>
    <div class="review-gauge-header"><span class="review-gauge-value" id="rv-oil-pressure">--</span><span class="review-gauge-unit">PSI</span></div>
  </div>
`;
gaugesEl.appendChild(engineGauges);
const oilTempValueEl = engineGauges.querySelector("#rv-oil-temp")!;
const oilPressureValueEl = engineGauges.querySelector("#rv-oil-pressure")!;


function updateGaugeSegs(track: HTMLElement, fraction: number, colorFn: (idx: number, total: number) => string) {
  const segs = track.children;
  const lit = Math.round(fraction * segs.length);
  for (let i = 0; i < segs.length; i++) {
    const el = segs[i] as HTMLElement;
    if (i < lit) {
      const c = colorFn(i, segs.length);
      el.style.background = c;
      el.style.borderColor = c;
      el.style.boxShadow = `0 0 6px ${c}40`;
    } else {
      el.style.background = "";
      el.style.borderColor = "";
      el.style.boxShadow = "";
    }
  }
}

// ── Legend ──
interface LegendStop { color: string; label: string; }

const SPEED_LEGEND: LegendStop[] = [
  { color: "rgb(255,255,255)", label: "0-40 MPH" },
  { color: "rgb(241,196,15)", label: "40-50 MPH" },
  { color: "rgb(255,107,53)", label: "50-80 MPH" },
  { color: "rgb(231,76,60)", label: "80+ MPH" },
];

const THROTTLE_LEGEND: LegendStop[] = [
  { color: "rgb(46,204,113)", label: "0-10%" },
  { color: "rgb(255,255,255)", label: "10-40%" },
  { color: "rgb(241,196,15)", label: "40-70%" },
  { color: "rgb(255,107,53)", label: "70-90%" },
  { color: "rgb(231,76,60)", label: "90-100%" },
];

const RPM_LEGEND: LegendStop[] = [
  { color: "rgb(255,255,255)", label: "0-4200" },
  { color: "rgb(255,107,53)", label: "4200-5600" },
  { color: "rgb(231,76,60)", label: "5600-7000" },
];

const GEAR_LEGEND: LegendStop[] = [
  { color: "#3498db", label: "1ST" },
  { color: "#ffffff", label: "2ND" },
  { color: "#f1c40f", label: "3RD" },
  { color: "#ff6b35", label: "4TH" },
  { color: "#e74c3c", label: "5TH" },
];

const BRAKE_LEGEND: LegendStop[] = [
  { color: "rgba(255,255,255,0.3)", label: "OFF" },
  { color: "#e74c3c", label: "ON" },
];

const LEGENDS: Record<TrailMode, { title: string; stops: LegendStop[] }> = {
  speed: { title: "SPEED", stops: SPEED_LEGEND },
  throttle: { title: "THROTTLE", stops: THROTTLE_LEGEND },
  rpm: { title: "RPM", stops: RPM_LEGEND },
  gear: { title: "GEAR", stops: GEAR_LEGEND },
  brake: { title: "BRAKE", stops: BRAKE_LEGEND },
};

function renderLegend() {
  const { title, stops } = LEGENDS[trailMode];
  legendEl.innerHTML = `<div class="legend-title">${title}</div>`;
  for (const s of stops) {
    const row = document.createElement("div");
    row.className = "legend-row";
    row.innerHTML = `<span class="legend-swatch" style="background:${s.color}"></span><span class="legend-label">${s.label}</span>`;
    legendEl.appendChild(row);
  }
}
renderLegend();

// ── IndexedDB cache layer ──
const DB_NAME = "telem_review";
const DB_STORE = "cache";
const DB_VERSION = 1;

let dbReady: Promise<IDBDatabase>;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

dbReady = openDB();

async function cacheSet(key: string, data: unknown): Promise<void> {
  try {
    const db = await dbReady;
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(data, key);
  } catch {}
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await dbReady;
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function cacheDelete(key: string): Promise<void> {
  try {
    const db = await dbReady;
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
  } catch {}
}

async function cacheClearPrefix(prefix: string): Promise<void> {
  try {
    const db = await dbReady;
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result) {
        if (typeof key === "string" && key.includes(prefix)) store.delete(key);
      }
    };
  } catch {}
}

// ── Cache export / import ──
async function exportCache(): Promise<void> {
  const btn = document.getElementById("btn-export")!;
  btn.textContent = "SAVING...";
  try {
    const db = await dbReady;
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const keys: IDBValidKey[] = await new Promise((res, rej) => {
      const r = store.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const values: unknown[] = await new Promise((res, rej) => {
      const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const entries = keys.map((k, i) => [k, values[i]]);
    const json = JSON.stringify(entries);
    const encoded = new TextEncoder().encode(json);

    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(encoded);
    writer.close();
    const compressed = await new Response(cs.readable).arrayBuffer();

    const blob = new Blob([compressed], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const tag = session ? `${session.track}-${session.id.slice(0, 8)}` : "all";
    a.download = `telem-${tag}-${new Date().toISOString().slice(0, 10)}.telem`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    btn.textContent = "EXPORT CACHE";
  }
}

async function importCache(): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".telem";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const btn = document.getElementById("btn-import")!;
    btn.textContent = "LOADING...";
    try {
      const compressed = await file.arrayBuffer();
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(compressed));
      writer.close();
      const decompressed = await new Response(ds.readable).arrayBuffer();
      const json = new TextDecoder().decode(decompressed);
      const entries: Array<[string, unknown]> = JSON.parse(json);

      const db = await dbReady;
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      for (const [key, value] of entries) store.put(value, key);
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });

      window.location.reload();
    } finally {
      btn.textContent = "IMPORT CACHE";
    }
  };
  input.click();
}

document.getElementById("btn-export")!.addEventListener("click", exportCache);
document.getElementById("btn-import")!.addEventListener("click", importCache);

const statusEl = document.getElementById("review-status")!;
const sidebarEl = document.getElementById("review-sidebar")!;

function setStatus(text: string, cls: "" | "loading" | "error" = "") {
  statusEl.textContent = text;
  statusEl.className = cls ? `${cls}` : "";
  statusEl.id = "review-status";
  // Sweep animation driven only by inflight fetches
  sidebarEl.classList.toggle("syncing", inflightFetches.size > 0);
}

async function updateSyncStatus(): Promise<void> {
  if (!session || session.laps.length === 0) return;

  let fetching = 0;
  let refreshing = 0;
  let cached = 0;
  for (const lap of session.laps) {
    const key = `/lap/${lap.startSeq}-${lap.endSeq}`;
    const inflight = inflightFetches.get(key);
    if (inflight) {
      if (inflight.background) refreshing++;
      else fetching++;
      continue;
    }
    const hit = await cacheGet(key);
    if (hit) cached++;
  }
  const total = session.laps.length;
  const uncached = total - cached - fetching - refreshing;

  const lines: string[] = [`<span style="color:var(--text-dim)">${total} laps</span>`];
  if (cached > 0) lines.push(`<span style="color:#fff">${cached} cached</span>`);
  if (fetching > 0) lines.push(`<span style="color:var(--accent)">${fetching} fetching</span>`);
  if (refreshing > 0) lines.push(`<span style="color:var(--accent)">${refreshing} refreshing</span>`);
  if (uncached > 0) lines.push(`<span style="color:var(--text-dim)">${uncached} uncached</span>`);

  const loading = fetching > 0 || refreshing > 0;
  statusEl.innerHTML = lines.join("<br>");
  statusEl.className = loading ? "loading" : "";
  statusEl.id = "review-status";
  sidebarEl.classList.toggle("syncing", inflightFetches.size > 0);
}

// Keep old name as alias for callers
const updateLoadingStatus = updateSyncStatus;

async function apiFetch(path: string, method = "GET", body?: unknown, skipCache = false, cacheKeyOverride?: string): Promise<any> {
  const key = cacheKeyOverride ?? path;
  const cached = method === "GET" && !skipCache ? await cacheGet(key) : null;

  if (method === "GET" && cached && !skipCache) {
    // Return cache immediately, eagerly refetch in background
    fetchRemote(path, method, body, key).catch(() => {});
    return cached;
  }

  return fetchRemote(path, method, body, key);
}

/** Fetch msgpack from /wal/range, decode into ticks array. Caches parsed result. */
async function fetchWalRange(
  startSeq: number, endSeq: number, _channels: string,
  cacheKey: string, forceRefresh: boolean, alwaysRefetch = false,
): Promise<{ ticks: Array<{ seq: number; ts: number; d: Record<string, unknown> }> }> {
  const cached = !forceRefresh ? await cacheGet<{ ticks: any[] }>(cacheKey) : null;
  if (cached) {
    if (alwaysRefetch) {
      fetchWalRangeRemote(startSeq, endSeq, cacheKey, true).catch(() => {});
    }
    return cached;
  }
  return fetchWalRangeRemote(startSeq, endSeq, cacheKey, false);
}

async function fetchWalRangeRemote(
  startSeq: number, endSeq: number, cacheKey: string, background: boolean,
): Promise<{ ticks: Array<{ seq: number; ts: number; d: Record<string, unknown> }> }> {
  inflightFetches.set(cacheKey, { background });
  updateSyncStatus();
  try {
    const res = await fetch(`${SERVER_URL}/wal/range?start_seq=${startSeq}&end_seq=${endSeq}`);
    const buf = await res.arrayBuffer();
    const ticks = unpack(new Uint8Array(buf)) as any[];
    const data = { ticks };
    await cacheSet(cacheKey, data);
    return data;
  } catch {
    const cached = await cacheGet<{ ticks: any[] }>(cacheKey);
    if (cached) { setStatus("OFFLINE (CACHED)"); return cached; }
    setStatus("OFFLINE", "error");
    throw new Error("Server unreachable and no cached data");
  } finally {
    inflightFetches.delete(cacheKey);
    updateSyncStatus();
  }
}

async function fetchRemote(path: string, method: string, body?: unknown, cacheKey?: string): Promise<any> {
  setStatus("LOADING...", "loading");
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, opts);
    const data = await res.json();
    if (method === "GET" && cacheKey) await cacheSet(cacheKey, data);
    setStatus("SYNCED");
    return data;
  } catch {
    if (method === "GET" && cacheKey) {
      const cached = await cacheGet(cacheKey);
      if (cached) { setStatus("OFFLINE (CACHED)"); return cached; }
    }
    setStatus("OFFLINE", "error");
    throw new Error(`Server unreachable and no cached data for ${path}`);
  }
}

async function syncFromServer() {
  const btn = document.getElementById("btn-sync")!;
  btn.textContent = "SYNCING...";
  setStatus("SYNCING...", "loading");
  try {
    sessions = await apiFetch(`/sessions?track=${trackId}`, "GET", undefined, true);
    renderSessionList();
    if (session) {
      session = await apiFetch(`/sessions/${session.id}`, "GET", undefined, true);
      renderLapList();
      updateMeta();
      if (selectedLapIdx >= 0 && session?.laps[selectedLapIdx]) {
        await selectLap(selectedLapIdx, true);
      }
    }
    setStatus("SYNCED");
    btn.textContent = "SYNC";
  } catch {
    setStatus("OFFLINE", "error");
    btn.textContent = "SYNC";
  }
}

document.getElementById("btn-sync")!.addEventListener("click", syncFromServer);

async function syncAllLaps() {
  if (!session || session.laps.length === 0) return;
  const btn = document.getElementById("btn-sync-all")!;
  btn.textContent = "SYNCING...";

  const promises: Promise<any>[] = [];
  for (let i = 0; i < session.laps.length; i++) {
    const lap = session.laps[i];
    const cacheKey = `/lap/${lap.startSeq}-${lap.endSeq}`;
    const isLast = i === session.laps.length - 1;

    if (inflightFetches.has(cacheKey)) continue;
    if (!isLast) {
      const cached = await cacheGet(cacheKey);
      if (cached) continue; // skip already cached, except most recent
    }

    promises.push(fetchWalRangeRemote(lap.startSeq, lap.endSeq, cacheKey, !isLast));
  }

  await Promise.allSettled(promises);
  btn.textContent = "SYNC ALL";
  updateSyncStatus();
}

document.getElementById("btn-sync-all")!.addEventListener("click", syncAllLaps);

// ── Sessions ──
async function loadSessions() {
  try {
    sessions = await apiFetch(`/sessions?track=${trackId}`);
  } catch {
    sessions = [];
  }
  renderSessionList();
}

function renderSessionList() {
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = `review-session${session?.id === s.id ? " selected" : ""}`;
    row.innerHTML =
      `<input class="review-session-driver" data-id="${s.id}" value="${s.driver || ""}" placeholder="DRIVER" />` +
      `<span class="review-session-info">${TRACKS[s.track]?.name ?? s.track}</span>` +
      `<span class="review-session-info">${formatDate(s.createdAt)}${s.running ? " // LIVE" : ""} // ${s.laps.length} laps</span>` +
      `<button class="review-session-del" data-id="${s.id}" title="Delete">\u00d7</button>`;
    row.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".review-session-del") || target.closest(".review-session-driver")) return;
      selectSession(s.id);
    });
    sessionListEl.appendChild(row);
  }

  // Driver name rename
  let renameTimer: ReturnType<typeof setTimeout> | null = null;
  sessionListEl.querySelectorAll<HTMLInputElement>(".review-session-driver").forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.dataset.id!;
      const newName = input.value;
      // Update local state
      const s = sessions.find((s) => s.id === id);
      if (s) s.driver = newName;
      if (session?.id === id) { session.driver = newName; updateMeta(); }
      // Debounced save to server
      if (renameTimer) clearTimeout(renameTimer);
      renameTimer = setTimeout(async () => {
        try { await apiFetch(`/sessions/${id}`, "PATCH", { driver: newName }, true); } catch {}
      }, 500);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
  });

  sessionListEl.querySelectorAll(".review-session-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id!;
      if (!confirm("Delete this session?")) return;
      try { await apiFetch(`/sessions/${id}`, "DELETE"); } catch {}
      // Clear cached data for this session
      await cacheClearPrefix(id);
      if (session?.id === id) { session = null; selectedLapIdx = -1; clearLapView(); updateMeta(); }
      await loadSessions();
    });
  });
}

async function selectSession(id: string) {
  session = await apiFetch(`/sessions/${id}`);
  if (!session) return;

  const sesTrack = TRACKS[session.track];
  if (sesTrack && session.track !== trackId) {
    trackDef = sesTrack;
    map.setView(trackDef.center, trackDef.zoom);
    (map as any).setBearing(trackDef.bearing);
    drawTrackOverlays();
  }

  selectedLapIdx = -1;
  clearLapView();
  updateMeta();
  renderSessionList();
  renderLapList();
  updateSyncStatus();
  if (session.laps.length > 0) selectLap(0);
}

function updateMeta() {
  if (!session) { metaEl.textContent = "SELECT A SESSION"; return; }
  const t = TRACKS[session.track];
  metaEl.textContent = `${session.driver || "UNKNOWN"} // ${t?.name ?? session.track} // ${formatDate(session.createdAt)} // ${session.laps.length} LAPS`;
}

function clearLapView() {
  for (const l of trailLines) l.remove();
  trailLines = [];
  if (posMarker) { posMarker.remove(); posMarker = null; }
  lapListEl.innerHTML = "";
  lapCoords = []; lapSpeeds = []; lapThrottles = []; lapGx = []; lapGy = [];
  lapRpms = []; lapGears = []; lapBrakes = []; lapOilTempsC = []; lapOilPressures = [];
  lapTimestamps = []; lapTicks = [];
  seekEl.value = "0"; seekTimeEl.textContent = "0:00.000"; seekEpochEl.textContent = "--";
  speedValueEl.textContent = "--";
  throttleValueEl.textContent = "--";
  rpmValueEl.textContent = "--";
  oilTempValueEl.textContent = "--";
  oilPressureValueEl.textContent = "--";
  brakeEl.classList.remove("active");
  updateGaugeSegs(speedSegTrack, 0, () => "");
  updateGaugeSegs(tpsSegTrack, 0, () => "");
  updateGaugeSegs(rpmSegTrack, 0, () => "");
  resetGTrail();
  drawGCircle(0, 0);
}

// ── Laps ──
function getBestTime(): number | null {
  return session ? getBestLapTime(session.laps) : null;
}

async function allLapsCached(): Promise<boolean> {
  if (!session) return false;
  for (const lap of session.laps) {
    const key = `/lap/${lap.startSeq}-${lap.endSeq}`;
    if (!await cacheGet(key)) return false;
  }
  return true;
}

function renderLapList() {
  lapListEl.innerHTML = "";
  if (!session) return;
  const best = getBestTime();
  const isAgg = selectedLapIdx === -2;

  // "ALL LAPS" aggregate row
  const allRow = document.createElement("div");
  allRow.className = `review-lap${isAgg ? " selected" : ""}`;
  allRow.innerHTML = `<span class="review-lap-num">ALL</span><span class="review-lap-time">SESSION OVERVIEW</span>`;
  allRow.addEventListener("click", () => showAllLaps());
  lapListEl.appendChild(allRow);

  for (let i = 0; i < session.laps.length; i++) {
    const lap = session.laps[i];
    const row = document.createElement("div");
    row.className = `review-lap${lap.flag !== "clean" ? " flagged" : ""}${i === selectedLapIdx ? " selected" : ""}`;

    const delta = best !== null && lap.flag === "clean" ? lap.time - best : null;
    let deltaStr = "", deltaClass = "review-lap-delta";
    if (delta === 0) { deltaStr = "BEST"; deltaClass = "review-lap-delta best"; }
    else if (delta !== null && delta > 0) deltaStr = `+${(delta / 1000).toFixed(3)}`;

    const flagText = lap.flag === "yellow" ? "YEL" : lap.flag === "pit" ? "PIT" : lap.flag === "out" ? "OUT" : lap.flag === "in" ? "IN" : "";
    row.innerHTML =
      `<span class="review-lap-num">L${lap.lap}</span>` +
      `<span class="review-lap-time">${formatTime(lap.time)}</span>` +
      `<span class="${deltaClass}">${deltaStr}</span>` +
      `<span class="review-lap-flag ${lap.flag}">${flagText}</span>`;
    row.addEventListener("click", () => selectLap(i));
    lapListEl.appendChild(row);
  }

  renderAggControls();
}

async function selectLap(idx: number, forceRefresh = false) {
  if (!session || idx < 0 || idx >= session.laps.length) return;
  stopPlayback();
  selectedLapIdx = idx;
  const gen = ++selectLapGen;

  // Clear aggregate view if switching from ALL
  for (const l of allLapsLines) l.remove();
  allLapsLines = [];
  setAggregateMode(false);

  renderLapList();

  const lap = session.laps[idx];
  const channels = "gps_lat,gps_lon,gps_speed,gps_heading,gps_satellites,throttle_pos,g_force_x,g_force_y,rpm,gear,brake,coolant_temp,manifold_pressure,oil_temp,oil_pressure";
  const cacheKey = `/lap/${lap.startSeq}-${lap.endSeq}`;

  let fetchPromise = inflightPromises.get(cacheKey);

  if (!fetchPromise || forceRefresh) {
    // Check cache — if miss, clear display so stale data doesn't linger
    const cached = await cacheGet(cacheKey);
    if (!cached || forceRefresh) {
      lapTicks = []; lapCoords = []; lapSpeeds = []; lapThrottles = [];
      lapGx = []; lapGy = []; lapRpms = []; lapGears = []; lapBrakes = [];
      lapOilTempsC = []; lapOilPressures = []; lapTimestamps = [];
      drawTrail();
      seekEl.max = "0"; seekEl.value = "0";
      updateSeek(0);
    }
    const isLastLap = session!.laps.length > 0 && idx === session!.laps.length - 1;
    fetchPromise = fetchWalRange(lap.startSeq, lap.endSeq, channels, cacheKey, forceRefresh, isLastLap);
    inflightPromises.set(cacheKey, fetchPromise);
    fetchPromise.finally(() => inflightPromises.delete(cacheKey));
  } else {
    // Reusing inflight fetch — clear display and show loading
    lapTicks = []; lapCoords = []; lapSpeeds = []; lapThrottles = [];
    lapGx = []; lapGy = []; lapRpms = []; lapGears = []; lapBrakes = [];
    lapOilTempsC = []; lapOilPressures = []; lapTimestamps = [];
    drawTrail();
    seekEl.max = "0"; seekEl.value = "0";
    updateSeek(0);
    updateLoadingStatus();
  }
  const data = await fetchPromise;
  if (gen !== selectLapGen) return; // user switched laps during fetch
  lapTicks = data.ticks;

  // Ticks are already grouped by timestamp — just carry forward and extract arrays
  const latest: Record<string, number> = {};
  lapCoords = []; lapSpeeds = []; lapThrottles = []; lapGx = []; lapGy = [];
  lapRpms = []; lapGears = []; lapBrakes = []; lapOilTempsC = []; lapOilPressures = [];
  lapTimestamps = [];

  for (const tick of lapTicks) {
    // Merge tick channels into carry-forward state
    for (const [ch, val] of Object.entries(tick.d)) latest[ch] = val as number;

    if (latest.gps_lat !== undefined && latest.gps_lon !== undefined && (latest.gps_satellites ?? 0) >= 5) {
      lapCoords.push([latest.gps_lat, latest.gps_lon]);
      lapSpeeds.push(latest.gps_speed ?? 0);
      lapThrottles.push(latest.throttle_pos ?? 0);
      lapGx.push(latest.g_force_x ?? 0);
      lapGy.push(latest.g_force_y ?? 0);
      lapRpms.push(latest.rpm ?? 0);
      lapGears.push(latest.gear ?? 0);
      lapBrakes.push(latest.brake ?? 0);
      lapOilTempsC.push(latest.oil_temp ?? Number.NaN);
      lapOilPressures.push(latest.oil_pressure ?? Number.NaN);
      lapTimestamps.push(tick.ts);
    }
  }

  drawTrail();
  seekEl.max = String(Math.max(0, lapCoords.length - 1));
  seekEl.value = seekEl.max;
  updateSeek(lapCoords.length - 1);
  updateSyncStatus();
}

async function showAllLaps() {
  if (!session || session.laps.length === 0) return;
  const allCached = await allLapsCached();
  if (!allCached) {
    setStatus("SYNC ALL LAPS FIRST", "error");
    return;
  }

  selectedLapIdx = -2;
  setAggregateMode(true);

  // Initialize: all laps visible, best highlighted
  const best = getBestTime();
  aggVisible = new Set(session.laps.map((_, i) => i));
  aggHighlight = -1; // -1 means auto-best
  for (let i = 0; i < session.laps.length; i++) {
    const lap = session.laps[i];
    if (best !== null && lap.flag === "clean" && lap.time === best) { aggHighlight = i; break; }
  }

  renderLapList();

  // Clear single-lap display
  lapTicks = []; lapCoords = []; lapSpeeds = []; lapThrottles = [];
  lapGx = []; lapGy = []; lapRpms = []; lapGears = []; lapBrakes = []; lapTimestamps = [];
  drawTrail();
  clearSeekDisplay();

  // Parse all lap data from cache
  aggregateLaps = [];
  const cleanLaps = session.laps.filter((l) => l.flag === "clean");
  const worstTime = cleanLaps.length > 0 ? Math.max(...cleanLaps.map((l) => l.time)) : 0;
  const bestTime = best ?? 0;
  const timeRange = worstTime - bestTime || 1;

  for (let i = 0; i < session.laps.length; i++) {
    const lap = session.laps[i];
    const cacheKey = `/lap/${lap.startSeq}-${lap.endSeq}`;
    const data = await cacheGet<{ ticks: any[] }>(cacheKey);
    if (!data) continue;

    const coords: [number, number][] = [];
    const speeds: number[] = [];
    const throttles: number[] = [];
    const rpms: number[] = [];
    const brakes: number[] = [];
    const gears: number[] = [];
    const latest: Record<string, number> = {};

    for (const tick of data.ticks) {
      for (const [ch, val] of Object.entries(tick.d)) latest[ch] = val as number;
      if (latest.gps_lat !== undefined && latest.gps_lon !== undefined && (latest.gps_satellites ?? 0) >= 5) {
        coords.push([latest.gps_lat, latest.gps_lon]);
        speeds.push(latest.gps_speed ?? 0);
        throttles.push(latest.throttle_pos ?? 0);
        rpms.push(latest.rpm ?? 0);
        brakes.push(latest.brake ?? 0);
        gears.push(latest.gear ?? 0);
      }
    }

    const frac = lap.flag === "clean" ? 1 - (lap.time - bestTime) / timeRange : 0;
    const opacity = 0.15 + frac * 0.55;

    aggregateLaps.push({ idx: i, coords, speeds, throttles, rpms, brakes, gears, opacity });
  }

  drawAggregateTrails();
  renderLegend();
  setStatus("ALL LAPS");
}

interface AggregateLap {
  idx: number;
  coords: [number, number][];
  speeds: number[];
  throttles: number[];
  rpms: number[];
  brakes: number[];
  gears: number[];
  opacity: number;
}

let aggregateLaps: AggregateLap[] = [];

const GAP_DIST_DEG = 25 * 0.3048 / 111_320; // 25ft in degrees (~0.0000685°)
const GAP_DIST_SQ = GAP_DIST_DEG * GAP_DIST_DEG;

/** Split coords into continuous segments, breaking when consecutive points are >25ft apart */
function splitAtGaps(coords: [number, number][]): [number, number][][] {
  if (coords.length < 2) return [coords];
  const segments: [number, number][][] = [];
  let seg: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const dlat = coords[i][0] - coords[i - 1][0];
    const dlng = coords[i][1] - coords[i - 1][1];
    if (dlat * dlat + dlng * dlng > GAP_DIST_SQ) {
      if (seg.length >= 2) segments.push(seg);
      seg = [];
    }
    seg.push(coords[i]);
  }
  if (seg.length >= 2) segments.push(seg);
  return segments;
}

function drawAggregateTrails(): void {
  for (const l of allLapsLines) l.remove();
  allLapsLines = [];

  const colorFnMap: Record<TrailMode, (v: number) => string> = {
    speed: speedToColor, throttle: throttleToColor, rpm: rpmToColorByValue,
    gear: gearToColor, brake: (v) => v > 0.5 ? "#e74c3c" : "rgba(255,255,255,0.3)",
  };
  const colorFn = colorFnMap[trailMode];
  const valKey: Record<TrailMode, keyof AggregateLap> = {
    speed: "speeds", throttle: "throttles", rpm: "rpms", gear: "gears", brake: "brakes",
  };
  const key = valKey[trailMode];

  function drawLap(al: AggregateLap, weight: number, opacity: number): void {
    const values = al[key] as number[];
    const segs = splitAtGaps(al.coords);
    for (const seg of segs) {
      const segStart = al.coords.indexOf(seg[0]);
      const bucketSize = Math.max(1, Math.ceil(seg.length / 80));
      for (let b = 0; b < seg.length - 1; b += bucketSize) {
        const end = Math.min(b + bucketSize + 1, seg.length);
        const slice = seg.slice(b, end);
        if (slice.length < 2) continue;
        const gi = segStart + b;
        let sum = 0, cnt = 0;
        for (let j = gi; j < Math.min(gi + bucketSize, values.length); j++) { sum += values[j]; cnt++; }
        const avg = cnt > 0 ? sum / cnt : 0;
        const color = colorFn(avg);
        const line = L.polyline(slice as L.LatLngExpression[], { color, weight, opacity }).addTo(map);
        allLapsLines.push(line);
      }
    }
  }

  // Non-highlighted visible laps first
  for (const al of aggregateLaps) {
    if (!aggVisible.has(al.idx) || al.idx === aggHighlight || al.coords.length < 2) continue;
    drawLap(al, 1.5, al.opacity);
  }

  // Highlighted lap on top
  const hl = aggregateLaps.find((al) => al.idx === aggHighlight);
  if (hl && aggVisible.has(hl.idx) && hl.coords.length >= 2) {
    drawLap(hl, 3, 1);
  }
}

function drawTrail() {
  for (const l of trailLines) l.remove();
  trailLines = [];
  for (const h of trailHitAreas) h.remove();
  trailHitAreas = [];
  if (lapCoords.length < 2) return;

  const valuesMap: Record<TrailMode, number[]> = {
    speed: lapSpeeds, throttle: lapThrottles, rpm: lapRpms, gear: lapGears, brake: lapBrakes,
  };
  const colorFnMap: Record<TrailMode, (v: number) => string> = {
    speed: speedToColor, throttle: throttleToColor, rpm: rpmToColorByValue,
    gear: gearToColor, brake: (v) => v > 0.5 ? "#e74c3c" : "rgba(255,255,255,0.3)",
  };
  const values = valuesMap[trailMode];
  const colorFn = colorFnMap[trailMode];
  const bucketSize = Math.max(1, Math.ceil(lapCoords.length / 80));

  // Split into continuous segments at timestamp gaps
  const segments = splitAtGaps(lapCoords);

  for (const seg of segments) {
    const segStart = lapCoords.indexOf(seg[0]);
    const segBucketSize = Math.max(1, Math.ceil(seg.length / 80));

    for (let b = 0; b < seg.length - 1; b += segBucketSize) {
      const end = Math.min(b + segBucketSize + 1, seg.length);
      const slice = seg.slice(b, end);
      if (slice.length < 2) continue;
      const gi = segStart + b;

      let sum = 0, cnt = 0;
      for (let j = gi; j < Math.min(gi + segBucketSize, values.length); j++) { sum += values[j]; cnt++; }
      const avg = cnt > 0 ? sum / cnt : 0;
      let color: string;
      if (trailMode === "gear") {
        const counts: Record<number, number> = {};
        for (let j = gi; j < Math.min(gi + segBucketSize, values.length); j++) {
          counts[values[j]] = (counts[values[j]] ?? 0) + 1;
        }
        const modeGear = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        color = gearToColor(modeGear ? parseInt(modeGear[0]) : 0);
      } else {
        color = colorFn(avg);
      }

      const line = L.polyline(slice as L.LatLngExpression[], { color, weight: 3, opacity: 0.8, interactive: false }).addTo(map);
      trailLines.push(line);
    }
  }

  // Invisible wide polylines per segment for hover interaction
  const tooltip = L.tooltip({ permanent: false, direction: "top", offset: [0, -10], className: "trail-tooltip" });

  for (const seg of segments) {
    const hitLine = L.polyline(seg as L.LatLngExpression[], {
      color: "transparent", weight: 16, opacity: 0, interactive: true,
    }).addTo(map);
    trailHitAreas.push(hitLine);

    hitLine.on("mousemove", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      let minDist = Infinity;
      let nearIdx = 0;
      for (let i = 0; i < lapCoords.length; i++) {
        const dlat = lapCoords[i][0] - lat;
        const dlng = lapCoords[i][1] - lng;
        const d = dlat * dlat + dlng * dlng;
        if (d < minDist) { minDist = d; nearIdx = i; }
      }
      seekEl.value = String(nearIdx);
      updateSeek(nearIdx);

      const formatMap: Record<TrailMode, (i: number) => string> = {
        speed: (i) => `${Math.round(lapSpeeds[i] * KMH_TO_MPH)} mph`,
        throttle: (i) => `${Math.round(lapThrottles[i])}% tps`,
        rpm: (i) => `${Math.round(lapRpms[i])} rpm`,
        gear: (i) => `gear ${Math.round(lapGears[i])}`,
        brake: (i) => lapBrakes[i] > 0.5 ? "brake ON" : "brake OFF",
      };
      tooltip.setLatLng(e.latlng).setContent(formatMap[trailMode](nearIdx));
      if (!map.hasLayer(tooltip as any)) (tooltip as any).addTo(map);
    });

    hitLine.on("mouseout", () => {
      map.removeLayer(tooltip as any);
    });
  }
}

function clearSeekDisplay() {
  if (posMarker) { posMarker.remove(); posMarker = null; }
  seekTimeEl.textContent = "--";
  seekEpochEl.textContent = "";
  resetGTrail();
  drawGCircle(0, 0);
  speedValueEl.textContent = "--";
  updateGaugeSegs(speedSegTrack, 0, () => "");
  throttleValueEl.textContent = "--";
  updateGaugeSegs(tpsSegTrack, 0, () => "");
  rpmValueEl.textContent = "--";
  updateGaugeSegs(rpmSegTrack, 0, () => "");
  oilTempValueEl.textContent = "--";
  oilPressureValueEl.textContent = "--";
  brakeEl.classList.remove("active");
}

function updateSeek(idx: number) {
  if (lapCoords.length === 0) { clearSeekDisplay(); return; }
  if (idx < 0 || idx >= lapCoords.length) return;

  const [lat, lon] = lapCoords[idx];
  if (!posMarker) {
    posMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #e74c3c;margin:-5px 0 0 -5px;box-shadow:0 0 8px rgba(231,76,60,0.6);"></div>`,
        iconSize: [0, 0],
      }),
      interactive: false,
    }).addTo(map);
  } else {
    posMarker.setLatLng([lat, lon]);
  }

  if (lapTimestamps.length > 0) {
    seekTimeEl.textContent = formatTime(lapTimestamps[idx] - lapTimestamps[0]);
    const d = new Date(lapTimestamps[idx]);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop() ?? "";
    seekEpochEl.textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")} ${tz}`;
  }

  // G-force dial
  drawGCircle(lapGx[idx] ?? 0, lapGy[idx] ?? 0, idx);

  // Speed gauge
  const spdKmh = lapSpeeds[idx] ?? 0;
  const spdMph = Math.round(spdKmh * KMH_TO_MPH);
  speedValueEl.textContent = String(spdMph);
  updateGaugeSegs(speedSegTrack, Math.min(1, spdMph / MAX_MPH), (i, n) => {
    const segMph = ((i + 1) / n) * MAX_MPH;
    return speedToColor(segMph / KMH_TO_MPH);
  });

  // Throttle gauge
  const tps = lapThrottles[idx] ?? 0;
  throttleValueEl.textContent = String(Math.round(tps));
  updateGaugeSegs(tpsSegTrack, Math.min(1, tps / 100), (i, n) => {
    return throttleToColor(((i + 1) / n) * 100);
  });

  // RPM gauge + gear
  const rpmVal = lapRpms[idx] ?? 0;
  rpmValueEl.textContent = String(Math.round(rpmVal));
  updateGaugeSegs(rpmSegTrack, Math.min(1, rpmVal / MAX_RPM), (i, n) => rpmToColor((i + 1) / n));

  const oilTempC = lapOilTempsC[idx];
  const oilPressure = lapOilPressures[idx];
  oilTempValueEl.textContent = Number.isFinite(oilTempC)
    ? String(Math.round(oilTempC * 9 / 5 + 32))
    : "--";
  oilPressureValueEl.textContent = Number.isFinite(oilPressure) ? String(Math.round(oilPressure)) : "--";

  // Brake
  brakeEl.classList.toggle("active", (lapBrakes[idx] ?? 0) > 0.5);
}

seekEl.addEventListener("input", () => {
  stopPlayback();
  updateSeek(parseInt(seekEl.value, 10));
});

// ── Playback ──
let playRaf = 0;
let playStartWall = 0;
let playStartTs = 0;
let playStartIdx = 0;

function stopPlayback() {
  if (playRaf) { cancelAnimationFrame(playRaf); playRaf = 0; }
  playBtn.innerHTML = "&#9654;";
}

function startPlayback() {
  if (lapTimestamps.length < 2) return;
  const curIdx = parseInt(seekEl.value, 10);
  if (curIdx >= lapTimestamps.length - 1) {
    // at end, restart from beginning
    seekEl.value = "0";
    updateSeek(0);
  }
  playStartIdx = parseInt(seekEl.value, 10);
  playStartWall = performance.now();
  playStartTs = lapTimestamps[playStartIdx];
  playBtn.innerHTML = "&#9646;&#9646;";
  playTick();
}

function playTick() {
  const elapsed = performance.now() - playStartWall;
  const targetTs = playStartTs + elapsed;

  // find the tick closest to targetTs
  let idx = playStartIdx;
  while (idx < lapTimestamps.length - 1 && lapTimestamps[idx + 1] <= targetTs) idx++;

  seekEl.value = String(idx);
  updateSeek(idx);

  if (idx >= lapTimestamps.length - 1) { stopPlayback(); return; }
  playRaf = requestAnimationFrame(playTick);
}

playBtn.addEventListener("click", () => {
  if (playRaf) stopPlayback();
  else startPlayback();
});

// ── Init ──
async function init() {
  await loadSessions();
  const requestedId = params.get("session");
  if (requestedId && sessions.find((s) => s.id === requestedId)) await selectSession(requestedId);
  else if (sessions.length > 0) await selectSession(sessions[0].id);
  else updateMeta();
}
init();
propagateQueryParams();
