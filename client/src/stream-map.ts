import "./stream.css";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import "leaflet-rotate";
import { TelemetryManager } from "./telemetry";
import { getTrack } from "./track";
import { STREAM_TRACK_ID } from "./stream-track";
import { snapToTrack, buildSpeedTrail } from "./track-utils";

const TRAIL_MAX = 3000;
const TRACK_COLOR = "rgba(255, 255, 255, 0.35)";
const MAP_UPDATE_INTERVAL = 100;

const mgr = new TelemetryManager();
const trackDef = getTrack(STREAM_TRACK_ID);

const mapEl = document.getElementById("map")!;
const map = L.map(mapEl, {
  zoomControl: false,
  attributionControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  touchZoom: false,
  boxZoom: false,
  keyboard: false,
  minZoom: trackDef.zoom,
  maxZoom: trackDef.zoom,
  rotate: true,
  rotateControl: false,
  shiftKeyRotate: false,
  bearing: trackDef.bearing,
} as any).setView(trackDef.center, trackDef.zoom);

// track outline
L.polyline(trackDef.track as L.LatLngExpression[], {
  color: TRACK_COLOR,
  weight: 2,
  dashArray: "6 4",
}).addTo(map);

// S/F marker
L.marker(trackDef.finishLine, {
  icon: L.divIcon({
    className: "turn-label sf-label",
    html: "S/F",
    iconSize: [24, 14],
    iconAnchor: [12, 7],
  }),
  interactive: false,
}).addTo(map);

// turn labels
for (const t of trackDef.turns) {
  L.marker(t.pos, {
    icon: L.divIcon({
      className: "turn-label",
      html: t.label,
      iconSize: [20, 14],
      iconAnchor: [10, 7],
    }),
    interactive: false,
  }).addTo(map);
}

function makeArrowIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: "car-arrow",
    html: `<svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(${heading}deg)">
      <polygon points="10,2 16,16 10,12 4,16" fill="#e74c3c" stroke="#fff" stroke-width="1.5"/>
    </svg>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

let trailSegments: L.Polyline[] = [];
let heading = 0;
const marker = L.marker([0, 0], { icon: makeArrowIcon(0), interactive: false });

let lastLat = 0;
let lastLon = 0;
let lastLen = 0;
let lastUpdate = 0;

function update(): void {
  const latBuf = mgr.getBuffer("gps_lat");
  const lonBuf = mgr.getBuffer("gps_lon");
  if (!latBuf || !lonBuf || latBuf.values.length === 0) return;

  const lat = latBuf.values[latBuf.values.length - 1];
  const lon = lonBuf.values[lonBuf.values.length - 1];
  if (lat === 0 && lon === 0) return;

  const len = Math.min(latBuf.values.length, lonBuf.values.length);
  if (lat === lastLat && lon === lastLon && len === lastLen) return;
  lastLat = lat;
  lastLon = lon;
  lastLen = len;

  const now = performance.now();
  if (now - lastUpdate < MAP_UPDATE_INTERVAL) return;
  lastUpdate = now;

  const speedBuf = mgr.getBuffer("gps_speed") ?? mgr.getBuffer("speed");
  const start = Math.max(0, len - TRAIL_MAX);
  const coords: [number, number][] = [];
  const speeds: number[] = [];
  for (let i = start; i < len; i++) {
    const la = latBuf.values[i];
    const lo = lonBuf.values[i];
    if (la !== 0 || lo !== 0) {
      coords.push([la, lo]);
      speeds.push(speedBuf && i < speedBuf.values.length ? speedBuf.values[i] : 0);
    }
  }

  const hdgBuf = mgr.getBuffer("gps_heading");
  const newHeading = hdgBuf?.values.length ? hdgBuf.values[hdgBuf.values.length - 1] : 0;
  if (newHeading !== heading) {
    heading = newHeading;
    marker.setIcon(makeArrowIcon(heading + trackDef.bearing));
  }

  // snap to track + draw trail
  const snapped = coords.map(([la, lo]) => snapToTrack(trackDef.track, la, lo));
  trailSegments = buildSpeedTrail(map, snapped, speeds, trailSegments);

  const [sLat, sLon] = snapToTrack(trackDef.track, lat, lon);
  marker.setLatLng([sLat, sLon]);
  if (!map.hasLayer(marker)) marker.addTo(map);
}

new ResizeObserver(() => map.invalidateSize()).observe(mapEl);

mgr.connect();

function loop() {
  if (mgr.dirty) {
    update();
    mgr.clearDirty();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
