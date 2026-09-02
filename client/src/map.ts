import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import { TelemetryManager } from "./telemetry";
import { getActiveTrack } from "./track";
import { snapToTrack, buildSpeedTrail } from "./track-utils";

const TRAIL_MAX = 3000;
const MARKER_COLOR = "#fff";
const TRACK_OUTLINE_COLOR = "rgba(255, 255, 255, 0.3)";

const TILES_SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_OPTS_SAT: L.TileLayerOptions = { maxZoom: 20 };

export interface MapPanels {
  update: () => void;
}

export function createMaps(
  followEl: HTMLElement,
  overviewEl: HTMLElement,
  mgr: TelemetryManager,
): MapPanels {
  const trackDef = getActiveTrack();

  // --- Follow map (current GPS position, rotated to heading) ---
  const followMap = L.map(followEl, {
    zoomControl: false,
    attributionControl: false,
    rotate: true,
    rotateControl: false,
    shiftKeyRotate: false,
  } as any).setView([0, 0], 2);
  L.tileLayer(TILES_SAT, TILE_OPTS_SAT).addTo(followMap);

  let followTrailSegments: L.Polyline[] = [];

  function makeArrowIcon(heading: number): L.DivIcon {
    return L.divIcon({
      className: "car-arrow",
      html: `<svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(${heading}deg)">
        <polygon points="10,2 16,16 10,12 4,16" fill="#e74c3c" stroke="${MARKER_COLOR}" stroke-width="1.5"/>
      </svg>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
  }

  let followHeading = 0;
  let smoothedHeading = 0;
  let headingInit = false;
  const HEADING_ALPHA = 0.15;
  const followMarker = L.marker([0, 0], { icon: makeArrowIcon(0), interactive: false });

  let followHasPos = false;
  let followZoom = 17;

  // --- Overview map (rotated, no road labels) ---
  const overviewMap = L.map(overviewEl, {
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
  L.tileLayer(TILES_SAT, TILE_OPTS_SAT).addTo(overviewMap);

  // track outline
  L.polyline(trackDef.track as L.LatLngExpression[], {
    color: TRACK_OUTLINE_COLOR,
    weight: 1.2,
    dashArray: "4 4",
  }).addTo(overviewMap);

  // start/finish marker
  L.marker(trackDef.finishLine, {
    icon: L.divIcon({
      className: "turn-label sf-label",
      html: "S/F",
      iconSize: [24, 14],
      iconAnchor: [12, 7],
    }),
    interactive: false,
  }).addTo(overviewMap);

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
    }).addTo(overviewMap);
  }

  let overviewTrailSegments: L.Polyline[] = [];

  const overviewMarker = L.marker([0, 0], { icon: makeArrowIcon(0), interactive: false });

  // resize handlers
  new ResizeObserver(() => followMap.invalidateSize()).observe(followEl);
  new ResizeObserver(() => overviewMap.invalidateSize()).observe(overviewEl);

  let lastLat = 0;
  let lastLon = 0;
  let lastLen = 0;
  let lastMapUpdate = 0;
  const MAP_UPDATE_INTERVAL = 100; // ms — throttle map pans to 10Hz

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
    if (now - lastMapUpdate < MAP_UPDATE_INTERVAL) return;
    lastMapUpdate = now;

    // build coordinate + speed arrays
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

    // read heading with EWMA smoothing
    const hdgBuf = mgr.getBuffer("gps_heading");
    const rawHeading = hdgBuf?.values.length ? hdgBuf.values[hdgBuf.values.length - 1] : 0;

    if (!headingInit) { smoothedHeading = rawHeading; headingInit = true; }
    else {
      // Handle wrap-around (e.g. 350° → 10°)
      let delta = rawHeading - smoothedHeading;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      smoothedHeading = ((smoothedHeading + HEADING_ALPHA * delta) % 360 + 360) % 360;
    }

    if (Math.abs(smoothedHeading - followHeading) > 0.5) {
      followHeading = smoothedHeading;
      // Follow map rotates to heading — arrow always points up
      followMarker.setIcon(makeArrowIcon(0));
      (followMap as any).setBearing(-followHeading);
      // Overview arrow still relative to track bearing
      overviewMarker.setIcon(makeArrowIcon(followHeading + trackDef.bearing));
    }

    // --- update follow map ---
    followTrailSegments = buildSpeedTrail(followMap, coords, speeds, followTrailSegments);
    followMarker.setLatLng([lat, lon]);

    if (!followHasPos) {
      followMarker.addTo(followMap);
      followMap.setView([lat, lon], followZoom);
      followHasPos = true;
    } else {
      followMap.panTo([lat, lon], { animate: false });
    }

    // --- update overview map (snap GPS to track centerline) ---
    const snappedCoords = coords.map(([la, lo]) => snapToTrack(trackDef.track, la, lo));
    overviewTrailSegments = buildSpeedTrail(overviewMap, snappedCoords, speeds, overviewTrailSegments);
    const [sLat, sLon] = snapToTrack(trackDef.track, lat, lon);
    overviewMarker.setLatLng([sLat, sLon]);
    if (!overviewMap.hasLayer(overviewMarker)) {
      overviewMarker.addTo(overviewMap);
    }
  }

  return { update };
}
