import "./editor.css";
import { propagateQueryParams } from "./nav";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import { TRACKS, type TrackDef } from "./track";
import { createDropdown } from "./dropdown";

const TILES_SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_OPTS_SAT: L.TileLayerOptions = { maxZoom: 20 };

let currentTrackId = "";

type Mode = "track" | "turn" | "finish" | "select";

interface State {
  name: string;
  center: [number, number];
  zoom: number;
  bearing: number;
  finishLine: [number, number] | null;
  turns: { label: string; pos: [number, number] }[];
  track: [number, number][];
  mode: Mode;
}

const state: State = {
  name: "New Track",
  center: [37.765, -122.43],
  zoom: 16,
  bearing: 0,
  finishLine: null,
  turns: [],
  track: [],
  mode: "track",
};

// undo stack
const undoStack: string[] = [];
function pushUndo() {
  undoStack.push(JSON.stringify({ track: state.track, turns: state.turns, finishLine: state.finishLine }));
  if (undoStack.length > 50) undoStack.shift();
}

// DOM refs
const mapContainer = document.getElementById("map-container")!;
const trackLoadContainer = document.getElementById("track-load")!;
const nameInput = document.getElementById("input-name") as HTMLInputElement;
const zoomInput = document.getElementById("input-zoom") as HTMLInputElement;
const bearingInput = document.getElementById("input-bearing") as HTMLInputElement;
const pointCountEl = document.getElementById("point-count")!;
const turnListEl = document.getElementById("turn-list")!;
const finishInfoEl = document.getElementById("finish-info")!;

// Map
const map = L.map(mapContainer, {
  zoomControl: true,
  attributionControl: false,
  rotate: true,
  rotateControl: false,
  shiftKeyRotate: true,
  touchRotate: true,
  bearing: state.bearing,
} as any).setView(state.center, state.zoom);

// Sync bearing input when map is rotated via shift+drag
(map as any).on("rotate", () => {
  const b = Math.round((map as any).getBearing());
  state.bearing = b;
  bearingInput.value = String(b);
  document.getElementById("bearing-value")!.textContent = `${b}°`;
});
L.tileLayer(TILES_SAT, TILE_OPTS_SAT).addTo(map);

// Layers
const trackLine = L.polyline([], { color: "#ff6b35", weight: 2, opacity: 0.8 }).addTo(map);
const trackMarkers: L.Marker[] = [];
const turnMarkers: L.Marker[] = [];
let finishMarker: L.Marker | null = null;
let isDragging = false;

// ── Marker factories ──
function makePointIcon(index: number, total: number): L.DivIcon {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const color = isFirst ? "#2ecc71" : isLast ? "#e74c3c" : "#ff6b35";
  return L.divIcon({
    className: "",
    html: `<div style="width:8px;height:8px;border-radius:50%;background:${color};border:1.5px solid #fff;margin:-4px 0 0 -4px;"></div>`,
    iconSize: [0, 0],
  });
}

function makeTurnIcon(label: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="background:rgba(255,107,53,0.8);color:#fff;font:bold 9px monospace;padding:2px 5px;border-radius:2px;white-space:nowrap;text-align:center;">${label}</div>`,
    iconSize: [20, 14],
    iconAnchor: [10, 7],
  });
}

function makeFinishIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="background:#e74c3c;color:#fff;font:bold 9px monospace;padding:2px 6px;border-radius:2px;white-space:nowrap;text-align:center;">S/F</div>`,
    iconSize: [24, 14],
    iconAnchor: [12, 7],
  });
}

// ── Render functions ──
function renderTrack() {
  // clear old markers
  for (const m of trackMarkers) m.remove();
  trackMarkers.length = 0;

  trackLine.setLatLngs(state.track as L.LatLngExpression[]);

  for (let i = 0; i < state.track.length; i++) {
    const pt = state.track[i];
    const marker = L.marker(pt, {
      icon: makePointIcon(i, state.track.length),
      draggable: true,
    }).addTo(map);

    marker.on("dragstart", () => { isDragging = true; pushUndo(); });
    marker.on("dragend", () => {
      const pos = marker.getLatLng();
      state.track[i] = [pos.lat, pos.lng];
      trackLine.setLatLngs(state.track as L.LatLngExpression[]);
      setTimeout(() => { isDragging = false; }, 50);
    });
    marker.on("contextmenu", (e) => {
      L.DomEvent.preventDefault(e as any);
      pushUndo();
      state.track.splice(i, 1);
      renderTrack();
      updateInfo();
    });
    trackMarkers.push(marker);
  }
  updateInfo();
}

function renderTurns() {
  for (const m of turnMarkers) m.remove();
  turnMarkers.length = 0;

  for (let i = 0; i < state.turns.length; i++) {
    const t = state.turns[i];
    const marker = L.marker(t.pos, {
      icon: makeTurnIcon(t.label),
      draggable: true,
    }).addTo(map);

    marker.on("dragstart", () => { isDragging = true; pushUndo(); });
    marker.on("dragend", () => {
      const pos = marker.getLatLng();
      state.turns[i].pos = [pos.lat, pos.lng];
      setTimeout(() => { isDragging = false; }, 50);
      updateInfo();
    });
    marker.on("contextmenu", (e) => {
      L.DomEvent.preventDefault(e as any);
      pushUndo();
      state.turns.splice(i, 1);
      renderTurns();
      updateInfo();
    });
    turnMarkers.push(marker);
  }
  updateInfo();
}

function renderFinish() {
  if (finishMarker) { finishMarker.remove(); finishMarker = null; }
  if (!state.finishLine) { updateInfo(); return; }

  finishMarker = L.marker(state.finishLine, {
    icon: makeFinishIcon(),
    draggable: true,
  }).addTo(map);

  finishMarker.on("dragstart", () => { isDragging = true; pushUndo(); });
  finishMarker.on("dragend", () => {
    const pos = finishMarker!.getLatLng();
    state.finishLine = [pos.lat, pos.lng];
    setTimeout(() => { isDragging = false; }, 50);
    updateInfo();
  });
  updateInfo();
}

function updateInfo() {
  pointCountEl.textContent = String(state.track.length);

  turnListEl.innerHTML = "";
  for (let i = 0; i < state.turns.length; i++) {
    const t = state.turns[i];
    const row = document.createElement("div");
    row.className = "turn-row";
    row.innerHTML = `<input class="turn-name" data-idx="${i}" value="${t.label}" /><span class="turn-pos">(${t.pos[0].toFixed(5)}, ${t.pos[1].toFixed(5)})</span><button class="turn-del" data-idx="${i}">×</button>`;
    turnListEl.appendChild(row);
  }

  turnListEl.querySelectorAll(".turn-name").forEach((input) => {
    input.addEventListener("change", () => {
      const idx = parseInt((input as HTMLElement).dataset.idx!);
      const newLabel = (input as HTMLInputElement).value.trim();
      if (newLabel) {
        state.turns[idx].label = newLabel;
        renderTurns();
      }
    });
  });

  turnListEl.querySelectorAll(".turn-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!);
      pushUndo();
      state.turns.splice(idx, 1);
      renderTurns();
    });
  });

  finishInfoEl.textContent = state.finishLine
    ? `${state.finishLine[0].toFixed(5)}, ${state.finishLine[1].toFixed(5)}`
    : "--";
}

// ── Find nearest segment for insertion ──
function findInsertIndex(lat: number, lon: number): number {
  if (state.track.length < 2) return state.track.length;
  let bestDist = Infinity;
  let bestIdx = state.track.length;

  for (let i = 0; i < state.track.length - 1; i++) {
    const [aLat, aLon] = state.track[i];
    const [bLat, bLon] = state.track[i + 1];
    const dx = bLon - aLon;
    const dy = bLat - aLat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((lon - aLon) * dx + (lat - aLat) * dy) / lenSq));
    const pLat = aLat + t * dy;
    const pLon = aLon + t * dx;
    const dist = (lat - pLat) ** 2 + (lon - pLon) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
}

// ── Mode buttons (toolbar) ──
// Clicking a tool activates it. Click the map to place. Tool auto-deselects
// after placement for turn/finish (one-shot). Track mode stays active for
// multi-point placement. Select mode is the default (no map click action).
const modeButtons = document.querySelectorAll(".mode-btn");

function setMode(mode: Mode) {
  state.mode = mode;
  modeButtons.forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.mode === mode);
  });
  mapContainer.style.cursor = mode === "select" ? "" : "crosshair";
}

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = (btn as HTMLElement).dataset.mode as Mode;
    // Toggle off if already active (return to select)
    setMode(state.mode === mode ? "select" : mode);
  });
});

// ── Map click handler ──
map.on("click", (e: L.LeafletMouseEvent) => {
  if (isDragging) return;
  const { lat, lng } = e.latlng;

  switch (state.mode) {
    case "track": {
      pushUndo();
      const idx = findInsertIndex(lat, lng);
      state.track.splice(idx, 0, [lat, lng]);
      renderTrack();
      // Stay in track mode for multi-point placement
      break;
    }
    case "turn": {
      pushUndo();
      const label = String(state.turns.length + 1);
      state.turns.push({ label, pos: [lat, lng] });
      renderTurns();
      setMode("select"); // one-shot
      break;
    }
    case "finish": {
      pushUndo();
      state.finishLine = [lat, lng];
      renderFinish();
      setMode("select"); // one-shot
      break;
    }
    case "select":
      break;
  }
});

// ── Sidebar inputs ──
nameInput.addEventListener("input", () => { state.name = nameInput.value; });
zoomInput.addEventListener("input", () => { state.zoom = parseFloat(zoomInput.value); });
const bearingValueEl = document.getElementById("bearing-value")!;
bearingInput.addEventListener("input", () => {
  state.bearing = parseFloat(bearingInput.value);
  bearingValueEl.textContent = `${state.bearing}°`;
  (map as any).setBearing(state.bearing);
});

document.getElementById("btn-set-center")!.addEventListener("click", () => {
  const c = map.getCenter();
  state.center = [c.lat, c.lng];
  alert(`Center set to ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`);
});

// ── Build TrackDef JSON ──
function buildJson(): string {
  const obj: TrackDef = {
    name: state.name,
    center: state.center,
    zoom: state.zoom,
    bearing: state.bearing,
    finishLine: state.finishLine ?? state.track[0] ?? [0, 0],
    turns: state.turns,
    track: state.track,
  };
  return JSON.stringify(obj, null, 2);
}

// ── Download ──
document.getElementById("btn-save")!.addEventListener("click", () => {
  const json = buildJson();
  const id = currentTrackId || state.name.toLowerCase().replace(/\s+/g, "_");
  const blob = new Blob([json + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${id}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Download ──
// ── Clear ──
document.getElementById("btn-clear")!.addEventListener("click", () => {
  if (!confirm("Clear all track data?")) return;
  pushUndo();
  state.track = [];
  state.turns = [];
  state.finishLine = null;
  renderTrack();
  renderTurns();
  renderFinish();
});

// ── Undo ──
function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  const data = JSON.parse(snap);
  state.track = data.track;
  state.turns = data.turns;
  state.finishLine = data.finishLine;
  renderTrack();
  renderTurns();
  renderFinish();
}

document.getElementById("btn-undo")!.addEventListener("click", undo);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
});

// ── Load track list ──
function loadTrackList() {
  const trackDropdown = createDropdown("-- SELECT --");
  trackDropdown.setOptions(
    Object.entries(TRACKS).map(([id, t]) => ({ value: id, label: t.name })),
  );
  trackDropdown.onChange = (id) => {
    if (TRACKS[id]) { currentTrackId = id; loadTrack(TRACKS[id]); }
  };
  trackLoadContainer.appendChild(trackDropdown.el);

  // auto-load from query param
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get("track");
  if (trackId && TRACKS[trackId]) {
    currentTrackId = trackId;
    trackDropdown.setValue(trackId);
    loadTrack(TRACKS[trackId]);
  }
}

function loadTrack(t: TrackDef) {
  state.name = t.name;
  state.center = [...t.center] as [number, number];
  state.zoom = t.zoom;
  state.bearing = t.bearing;
  state.finishLine = t.finishLine ? [...t.finishLine] as [number, number] : null;
  state.turns = t.turns.map((turn) => ({ label: turn.label, pos: [...turn.pos] as [number, number] }));
  state.track = t.track.map((p) => [...p] as [number, number]);

  nameInput.value = state.name;
  zoomInput.value = String(state.zoom);
  bearingInput.value = String(state.bearing);
  document.getElementById("bearing-value")!.textContent = `${state.bearing}°`;

  map.setView(state.center, state.zoom);
  (map as any).setBearing(state.bearing);
  renderTrack();
  renderTurns();
  renderFinish();
  undoStack.length = 0;
}

loadTrackList();
propagateQueryParams();
