/**
 * Generates dummy race telemetry and POSTs it to the ingest endpoint.
 *
 * Usage: tsx scripts/gen-data.ts [--url http://localhost:4400] [--hz 25] [--duration 0] [--track sonoma]
 *
 * Speed at every track position is computed from local curvature with
 * forward/backward acceleration passes — no segment classification needed.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { optimalGear, rpmFromSpeedAndGear } from "../src/gear.js";
import { tpsToVoltage, mapToVoltage, ectToVoltage } from "../src/sensors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "../../tracks");

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE_URL = arg("url", "http://localhost:4400");
const HZ = parseInt(arg("hz", "25"), 10);
const DURATION_S = parseInt(arg("duration", "0"), 10);
const TRACK_ID = arg("track", "sonoma");

const trackJson = JSON.parse(readFileSync(resolve(TRACKS_DIR, `${TRACK_ID}.json`), "utf-8"));
const TRACK_POINTS: [number, number][] = trackJson.track;

// cumulative distances (meters)
const segDists: number[] = [0];
let totalDist = 0;
for (let i = 1; i < TRACK_POINTS.length; i++) {
  const [lat1, lon1] = TRACK_POINTS[i - 1];
  const [lat2, lon2] = TRACK_POINTS[i];
  const dlat = (lat2 - lat1) * 111320;
  const dlon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  totalDist += Math.sqrt(dlat * dlat + dlon * dlon);
  segDists.push(totalDist);
}

const N = TRACK_POINTS.length;
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function jitter(v: number, amount: number): number { return v + (Math.random() - 0.5) * 2 * amount; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

// ── GPS helpers ──
const LOOKAHEAD = 15;

function getPosAtDist(d: number): [number, number] {
  const wrapped = ((d % totalDist) + totalDist) % totalDist;
  for (let i = 1; i < segDists.length; i++) {
    if (wrapped <= segDists[i]) {
      const segLen = segDists[i] - segDists[i - 1];
      const frac = segLen > 0 ? (wrapped - segDists[i - 1]) / segLen : 0;
      const [lat1, lon1] = TRACK_POINTS[i - 1];
      const [lat2, lon2] = TRACK_POINTS[i];
      return [lat1 + (lat2 - lat1) * frac, lon1 + (lon2 - lon1) * frac];
    }
  }
  return TRACK_POINTS[0];
}

function getTrackPos(dist: number): { lat: number; lon: number; heading: number } {
  const [lat, lon] = getPosAtDist(dist);
  const [aLat, aLon] = getPosAtDist(dist + LOOKAHEAD);
  const dlat = (aLat - lat) * 111320;
  const dlon = (aLon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
  const heading = ((Math.atan2(dlon, dlat) * 180 / Math.PI) % 360 + 360) % 360;
  return { lat, lon, heading };
}

// ── Build per-point speed + curvature profile ──
const MU = 0.55;     // tire grip
const G = 9.81;
const TOP_SPEED = 145;  // km/h (~90 mph)
const MIN_SPEED = 30;   // km/h (~19 mph)
const MAX_ACCEL = 25;   // km/h/s (accelerating)
const MAX_DECEL = 45;   // km/h/s (braking)
const ENGINE_MAX_RPM = 7000;

// 1. Per-point heading + signed curvature
const headings: number[] = [];
for (let i = 0; i < N - 1; i++) {
  const [lat1, lon1] = TRACK_POINTS[i];
  const [lat2, lon2] = TRACK_POINTS[i + 1];
  const dlat = (lat2 - lat1) * 111320;
  const dlon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  headings.push(Math.atan2(dlon, dlat));
}
headings.push(headings[headings.length - 1]);

const rawCurvatures: number[] = [0];
for (let i = 1; i < N; i++) {
  let dh = headings[i] - headings[i - 1];
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const d = segDists[i] - segDists[i - 1];
  rawCurvatures.push(d > 0 ? dh / d : 0);
}

// Smooth curvature by geographic distance (±15m radius)
const SMOOTH_RADIUS = 15; // meters
const curvature: number[] = [];
for (let i = 0; i < N; i++) {
  let sum = 0, cnt = 0;
  const dc = segDists[i];
  for (let j = i; j >= 0 && dc - segDists[j] <= SMOOTH_RADIUS; j--) { sum += rawCurvatures[j]; cnt++; }
  for (let j = i + 1; j < N && segDists[j] - dc <= SMOOTH_RADIUS; j++) { sum += rawCurvatures[j]; cnt++; }
  curvature.push(cnt > 0 ? sum / cnt : 0);
}

// 2. Max speed from local curvature
const maxSpeed: number[] = [];
for (let i = 0; i < N; i++) {
  const absCurv = Math.abs(curvature[i]);
  if (absCurv < 0.0005) {
    maxSpeed.push(TOP_SPEED);
  } else {
    const radius = 1 / absCurv;
    const vMs = Math.sqrt(MU * G * Math.min(radius, 500));
    maxSpeed.push(clamp(vMs * 3.6, MIN_SPEED, TOP_SPEED));
  }
}

// 3. Forward pass: limit how fast speed can increase
const speedProfile: number[] = [...maxSpeed];
for (let i = 1; i < N; i++) {
  const d = segDists[i] - segDists[i - 1];
  const avgSpd = Math.max((speedProfile[i - 1] + speedProfile[i]) / 2, 10);
  const dt = d / (avgSpd / 3.6);
  speedProfile[i] = Math.min(speedProfile[i], speedProfile[i - 1] + MAX_ACCEL * dt);
}

// 4. Backward pass: limit how fast speed can decrease (braking)
for (let i = N - 2; i >= 0; i--) {
  const d = segDists[i + 1] - segDists[i];
  const avgSpd = Math.max((speedProfile[i] + speedProfile[i + 1]) / 2, 10);
  const dt = d / (avgSpd / 3.6);
  speedProfile[i] = Math.min(speedProfile[i], speedProfile[i + 1] + MAX_DECEL * dt);
}

// 5. Bake in ±8% random variance per point for natural variation
for (let i = 0; i < N; i++) {
  speedProfile[i] = clamp(speedProfile[i] * (0.92 + Math.random() * 0.16), MIN_SPEED, TOP_SPEED);
}

// Also do a wrap-around pass (end→start and start→end for the loop)
{
  const d = segDists[1] - segDists[0]; // approximate
  const avgSpd = Math.max((speedProfile[N - 1] + speedProfile[0]) / 2, 10);
  const dt = d / (avgSpd / 3.6);
  speedProfile[0] = Math.min(speedProfile[0], speedProfile[N - 1] + MAX_DECEL * dt);
  speedProfile[N - 1] = Math.min(speedProfile[N - 1], speedProfile[0] + MAX_DECEL * dt);
}

// 5. Build a lookup: given distance → target speed + curvature
function getTargetAtDist(dist: number): { targetSpeed: number; curv: number } {
  const d = ((dist % totalDist) + totalDist) % totalDist;
  for (let i = 1; i < N; i++) {
    if (d <= segDists[i]) {
      const segLen = segDists[i] - segDists[i - 1];
      const frac = segLen > 0 ? (d - segDists[i - 1]) / segLen : 0;
      const spd = speedProfile[i - 1] + (speedProfile[i] - speedProfile[i - 1]) * frac;
      const crv = curvature[i - 1] + (curvature[i] - curvature[i - 1]) * frac;
      return { targetSpeed: spd, curv: crv };
    }
  }
  return { targetSpeed: speedProfile[0], curv: curvature[0] };
}

// Log speed profile summary
const minSpd = Math.min(...speedProfile);
const maxSpd = Math.max(...speedProfile);
console.log(`track: ${TRACK_ID} (${N} pts, ${Math.round(totalDist)}m)`);
console.log(`speed profile: ${Math.round(minSpd)}-${Math.round(maxSpd)} km/h (${Math.round(minSpd * 0.621)}-${Math.round(maxSpd * 0.621)} mph)`);

// ── Simulation state ──
let speed = 80;
let throttlePos = 0;
let gForceX = 0;
let gForceY = 0;
let coolantTemp = 85;
let oilTempC = 88;
let oilPressurePsi = 50;
let mapKpa = 40;
let trackDist = 0;
let currentGear = 2;
let rpm = 3000;

function step(dt: number): void {
  const { targetSpeed, curv } = getTargetAtDist(trackDist);
  const absCurv = Math.abs(curv);
  const isCorner = absCurv > 0.001;
  const isBraking = targetSpeed < speed - 2;
  const isAccel = targetSpeed > speed + 2;

  if (isBraking) {
    // Brake toward target
    const decelRate = clamp((speed - targetSpeed) * 3, 10, MAX_DECEL);
    speed = Math.max(speed - decelRate * dt, targetSpeed);
    throttlePos = lerp(throttlePos, 0, dt * 12);
    gForceX = lerp(gForceX, jitter(clamp(decelRate / 36, 0.2, 1.0), 0.05), dt * 8);
    mapKpa = lerp(mapKpa, 22, dt * 6);
  } else if (isAccel && !isCorner) {
    // Accelerate hard on straights
    const accelRate = MAX_ACCEL;
    speed = Math.min(speed + accelRate * dt, targetSpeed);
    throttlePos = lerp(throttlePos, clamp(85 + Math.random() * 15, 85, 100), dt * 5);
    gForceX = lerp(gForceX, jitter(-clamp(accelRate / 36, 0.05, 0.35), 0.04), dt * 5);
    mapKpa = lerp(mapKpa, clamp(80 + throttlePos * 0.2, 70, 101), dt * 3);
  } else {
    // Cornering or maintaining speed
    speed = lerp(speed, targetSpeed, dt * 5);
    const tpsTarget = 15 + (targetSpeed / 200) * 50;
    throttlePos = lerp(throttlePos, clamp(tpsTarget, 10, 70), dt * 5);
    gForceX = lerp(gForceX, jitter(0, 0.04), dt * 5);
    mapKpa = lerp(mapKpa, 30 + throttlePos * 0.4, dt * 3);
  }

  // Lateral G from curvature + current speed
  if (isCorner) {
    const radius = 1 / absCurv;
    const vMs = speed / 3.6;
    const latG = clamp((vMs * vMs) / (radius * G), 0, 0.85);
    const signedG = curv >= 0 ? latG : -latG;
    gForceY = lerp(gForceY, jitter(signedG, 0.05), dt * 6);
  } else {
    gForceY = lerp(gForceY, jitter(0, 0.02), dt * 6);
  }

  coolantTemp = lerp(coolantTemp, 92, dt * 0.05);
  coolantTemp = clamp(jitter(coolantTemp, 0.2), 60, 110);
  // Synthetic engine-health channels for exercising the dashboard without
  // the physical AEM senders attached.
  const oilTempTargetC = 107 + (rpm / ENGINE_MAX_RPM) * 14;
  oilTempC = clamp(lerp(oilTempC, oilTempTargetC, dt * 0.02), 38, 140);
  oilPressurePsi = clamp(5 + rpm * 0.015, 10, 100);
  speed = clamp(speed, MIN_SPEED, TOP_SPEED);
  throttlePos = clamp(throttlePos, 0, 100);
  gForceX = clamp(gForceX, -1.5, 1.5);
  gForceY = clamp(gForceY, -1.5, 1.5);
  mapKpa = clamp(mapKpa, 20, 101);

  // Gear + RPM
  currentGear = optimalGear(speed, 2800, 6800);
  rpm = rpmFromSpeedAndGear(speed, currentGear);

  trackDist += (speed / 3.6) * dt;
}


const ADC_NOISE = 0.05;

async function send(batch: unknown[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
      return;
    } catch (err: any) {
      if (err?.cause?.code === "ECONNREFUSED" && attempt < 30) {
        if (attempt === 0) process.stderr.write("waiting for server...");
        else process.stderr.write(".");
        await sleep(1000);
        continue;
      }
      if (attempt > 0) process.stderr.write("\n");
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  const dt = 1 / HZ;
  const tickMs = 1000 / HZ;
  let totalSent = 0;

  console.log(`streaming at ${HZ}Hz ${DURATION_S ? `for ${DURATION_S}s` : "continuously"} → ${BASE_URL}  (ctrl-c to stop)`);

  const startReal = performance.now();
  const maxTicks = DURATION_S ? HZ * DURATION_S : Infinity;

  for (let i = 0; i < maxTicks; i++) {
    step(dt);
    const ts = Date.now();
    const pos = getTrackPos(trackDist);

    const batch = [
      { channel: "gps_lat", value: pos.lat, ts },
      { channel: "gps_lon", value: pos.lon, ts },
      { channel: "gps_speed", value: Math.round(jitter(speed, 2) * 10) / 10, ts },
      { channel: "gps_heading", value: Math.round(pos.heading * 10) / 10, ts },
      { channel: "g_force_x", value: Math.round(jitter(gForceX, 0.06) * 1000) / 1000, ts },
      { channel: "g_force_y", value: Math.round(jitter(gForceY, 0.06) * 1000) / 1000, ts },
      { channel: "speed", value: Math.round(jitter(speed, 3) * 10) / 10, ts },
      { channel: "throttle_pos", value: Math.round(jitter(throttlePos, 2) * 10) / 10, ts },
      { channel: "coolant_temp", value: Math.round(jitter(coolantTemp, 1.5) * 10) / 10, ts },
      { channel: "oil_temp", value: Math.round(jitter(oilTempC, 0.6) * 10) / 10, ts },
      { channel: "oil_pressure", value: Math.round(jitter(oilPressurePsi, 1.5) * 10) / 10, ts },
      { channel: "manifold_pressure", value: Math.round(jitter(mapKpa, 2) * 10) / 10, ts },
      { channel: "rpm", value: Math.round(jitter(rpm, rpm * 0.02)), ts },
      { channel: "gear", value: currentGear, ts },
      { channel: "brake", value: gForceX > 0.15 ? 1 : 0, ts },
      { channel: "battery_voltage", value: Math.round(jitter(13.8, 0.3) * 10) / 10, ts },
      { channel: "vss_hz", value: Math.round(jitter(speed / 3.6 * 4000 / 1000, 5) * 10) / 10, ts },
      { channel: "tps_voltage", value: Math.round(jitter(tpsToVoltage(throttlePos), ADC_NOISE) * 1000) / 1000, ts },
      { channel: "ect_voltage", value: Math.round(jitter(ectToVoltage(coolantTemp), ADC_NOISE) * 1000) / 1000, ts },
      { channel: "map_voltage", value: Math.round(jitter(mapToVoltage(mapKpa), ADC_NOISE) * 1000) / 1000, ts },
    ];

    await send(batch);
    totalSent += batch.length;

    const expected = (i + 1) * tickMs;
    const elapsed = performance.now() - startReal;
    const drift = expected - elapsed;
    if (drift > 1) await sleep(drift);
  }

  console.log(`done — ${totalSent} entries streamed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
