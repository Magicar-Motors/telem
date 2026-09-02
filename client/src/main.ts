import "./style.css";
import { propagateQueryParams } from "./nav";
import { TelemetryManager } from "./telemetry";
import { createPanels, ChartPanel } from "./charts";
import { createMaps, MapPanels } from "./map";
import { createGCircle, GCirclePanel } from "./gcircle";
import { createDiagnostics, DiagPanel } from "./diagnostics";
import { createUtilGauge } from "./util-gauge";
import { createLapTimes, LapTimesPanel } from "./laptimes";
import { ConnectionState } from "./types";
import { createDropdown } from "./dropdown";
import { TRACKS } from "./track";
import { LatencyProbe, formatBreakdown } from "./latency-probe";

const statusEl = document.getElementById("connection-status")!;
const latencyEl = document.getElementById("stat-latency")!;
const latencySpark = document.getElementById("latency-spark") as HTMLCanvasElement;
const latencyCtx = latencySpark.getContext("2d")!;
const seqEl = document.getElementById("stat-seq")!;
const rateEl = document.getElementById("stat-rate")!;
const localUtcEl = document.getElementById("stat-local-utc")!;
const telemUtcEl = document.getElementById("stat-telem-utc")!;
const skewEl = document.getElementById("stat-skew")!;
const lagEl = document.getElementById("stat-lag")!;
const lossEl = document.getElementById("stat-loss")!;
const mgr = new TelemetryManager();
const latencyProbe = new LatencyProbe(mgr);

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "CONNECTING",
  replaying: "REPLAYING",
  live: "LIVE",
  disconnected: "DISCONNECTED",
  error: "ERROR",
};

mgr.onStateChange = (state) => {
  statusEl.textContent = STATE_LABELS[state];
  statusEl.className = state;
};

// latency tracking — debounced per batch
const LATENCY_WINDOW = 60_000;
const latencyHistory: { t: number; ms: number }[] = [];
let lastBatchTime = 0;
let batchDebounce: ReturnType<typeof setTimeout> | null = null;

function onEntry(): void {
  if (batchDebounce) return;
  batchDebounce = setTimeout(() => {
    batchDebounce = null;
    const now = Date.now();
    const ms = lastBatchTime ? now - lastBatchTime : 0;
    lastBatchTime = now;
    latencyHistory.push({ t: now, ms });
    const cutoff = now - LATENCY_WINDOW;
    while (latencyHistory.length > 0 && latencyHistory[0].t < cutoff) latencyHistory.shift();
    const recent = latencyHistory.slice(-10);
    const avg = recent.length > 0 ? Math.round(recent.reduce((s, p) => s + p.ms, 0) / recent.length) : ms;
    latencyEl.textContent = `${avg}ms`;
    drawLatencySpark();
  }, 5);
}

function drawLatencySpark(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = latencySpark.clientWidth;
  const h = latencySpark.clientHeight;
  latencySpark.width = w * dpr;
  latencySpark.height = h * dpr;
  latencyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  latencyCtx.clearRect(0, 0, w, h);
  if (latencyHistory.length < 2) return;

  const vals = latencyHistory.map((p) => p.ms);
  const max = Math.max(...vals, 100);
  latencyCtx.beginPath();
  for (let i = 0; i < vals.length; i++) {
    const x = (i / (vals.length - 1)) * w;
    const y = h - (vals[i] / max) * h;
    if (i === 0) latencyCtx.moveTo(x, y);
    else latencyCtx.lineTo(x, y);
  }
  latencyCtx.strokeStyle = "rgba(255, 107, 53, 0.6)";
  latencyCtx.lineWidth = 1;
  latencyCtx.stroke();
}

// UTC clocks — this browser's wall clock next to the ts stamped on the newest
// entry. Both are Date.now(), taken on different machines: the Jetson stamps at
// ingest, we read at render. The gap is transport delay plus however far the two
// clocks have drifted apart — nothing syncs them, so it isn't purely latency.
const CLOCK_PERIOD_MS = 100;

function fmtUtc(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

function updateClocks(): void {
  const now = Date.now();
  localUtcEl.textContent = fmtUtc(now);

  // Ticks on its own timer, not the render loop, so a stalled feed shows up as a
  // frozen telem clock and a climbing skew rather than three frozen fields.
  const telemTs = mgr.lastTsNum;
  if (telemTs === 0) {
    telemUtcEl.textContent = "--:--:--.---";
    skewEl.textContent = "--";
    return;
  }

  telemUtcEl.textContent = fmtUtc(telemTs);
  const skew = now - telemTs;
  skewEl.textContent = `${skew >= 0 ? "+" : ""}${skew}ms`;
}

// `lag` counts seqs the car has that we don't, so it survives the two machines'
// clocks disagreeing. `loss` is what congestion looks like now that the live
// feed is lossy UDP — it degrades instead of falling behind.
latencyProbe.onUpdate = (b) => {
  lagEl.textContent = b.lagMs >= 1000
    ? `${(b.lagMs / 1000).toFixed(1)}s`
    : `${b.lagMs}ms`;
  lossEl.textContent = b.leaseOk ? `${b.lossPct}%` : "NO LEASE";
  console.log(`[latency] ${formatBreakdown(b)}`);
};

// hook into telemetry manager's ingest
const origConnect = mgr.connect.bind(mgr);
mgr.connect = function () {
  origConnect();
  // patch: listen for dirty flag as a proxy for new entries
};

let panels: ChartPanel[] = [];
let maps: MapPanels;
let gcircle: GCirclePanel;
let utilGauge: ReturnType<typeof createUtilGauge>;
let diag: DiagPanel;
let lapTimes: LapTimesPanel;

function init() {
  // track selector
  const trackSelectContainer = document.getElementById("track-select")!;
  const params = new URLSearchParams(window.location.search);
  const currentTrack = params.get("track") ?? "sonoma";
  const trackDropdown = createDropdown("SELECT TRACK");
  trackDropdown.setOptions(
    Object.entries(TRACKS).map(([id, t]) => ({ value: id, label: t.name })),
  );
  trackDropdown.setValue(currentTrack);
  trackDropdown.onChange = (value) => {
    const url = new URL(window.location.href);
    url.searchParams.set("track", value);
    window.location.href = url.toString();
  };
  trackSelectContainer.appendChild(trackDropdown.el);

  panels = createPanels(mgr);
  maps = createMaps(
    document.getElementById("map-follow")!,
    document.getElementById("map-overview")!,
    mgr,
  );
  const gcircleEl = document.getElementById("gcircle")!;
  gcircle = createGCircle(gcircleEl, mgr);
  utilGauge = createUtilGauge("on-panel");
  gcircleEl.appendChild(utilGauge.el);
  diag = createDiagnostics(document.getElementById("diagnostics")!, mgr);
  lapTimes = createLapTimes(document.getElementById("laptimes")!, mgr);
  mgr.connect();
  updateClocks();
  setInterval(updateClocks, CLOCK_PERIOD_MS);
  latencyProbe.start();
  requestAnimationFrame(loop);
}

// rate tracking
let entryCount = 0;
let lastRateCheck = performance.now();

function loop() {
  if (mgr.dirty) {
    for (const p of panels) p.update();
    maps.update();
    gcircle.update();
    const su = gcircle.sessionUtil();
    utilGauge.set({
      meanU: su.meanU, muY: su.envelope.muY, muX: su.envelope.muX,
      mode: su.envelope.mode, sampleCount: su.sampleCount,
    });
    diag.update();
    lapTimes.update();

    // update stats
    const seq = mgr.lastSeqNum;
    seqEl.textContent = String(seq);

    // latency
    onEntry();

    entryCount++;
    const now = performance.now();
    const elapsed = now - lastRateCheck;
    if (elapsed > 1000) {
      const rate = Math.round((entryCount / elapsed) * 1000);
      rateEl.textContent = `${rate}/s`;
      entryCount = 0;
      lastRateCheck = now;
    }

    mgr.clearDirty();
  }

  requestAnimationFrame(loop);
}

init();
propagateQueryParams();
