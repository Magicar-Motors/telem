import * as http from "node:http";
import { execSync } from "node:child_process";
import { pack } from "msgpackr";
import { WalEngine, WalEntry } from "./wal.js";
import { SessionStore, type Lap } from "./sessions.js";
import { LapDetector, type LapEvent } from "./lap-detector.js";
import { UdpSender, normalizeAddr } from "./udp-sender.js";

// Counted explicitly rather than via wal.listenerCount("entry") — the lap
// detector subscribes to the same event, so listener count overreports by one.
let sseClients = 0;

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function createServer(
  wal: WalEngine,
  sessions: SessionStore,
  lapDetector?: LapDetector,
  udpSender?: UdpSender,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Session SSE stream: /sessions/:id/stream
      const streamMatch = pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)\/stream$/);
      if (streamMatch && req.method === "GET" && lapDetector) {
        handleSessionStream(req, res, sessions, lapDetector, streamMatch[1]);
        return;
      }

      // Session routes: /sessions and /sessions/:id
      const sessionMatch = pathname.match(/^\/sessions(?:\/([a-zA-Z0-9_-]+))?$/);
      if (sessionMatch) {
        await handleSessions(req, res, url, wal, sessions, sessionMatch[1] ?? null);
        return;
      }

      // Guard WAL-dependent routes during compaction
      const walRoutes = ["/ingest", "/stream", "/wal/range", "/nuke"];
      if (wal.compacting && walRoutes.some((r) => pathname === r || pathname.startsWith(r))) {
        json(res, 503, { error: "compaction in progress, retry shortly" });
        return;
      }

      if (pathname.startsWith("/live/udp/")) {
        await handleUdpSubscription(req, res, url, udpSender);
      } else if (req.method === "POST" && pathname === "/ingest") {
        await handleIngest(req, res, wal);
      } else if (req.method === "GET" && pathname === "/stream") {
        handleStream(url, req, res, wal);
      } else if (req.method === "GET" && pathname === "/wal/range") {
        await handleWalRange(url, res, wal);
      } else if (req.method === "GET" && pathname === "/stats") {
        // now/newest_ts/seq are the reference point for latency debugging: a client
        // compares them against what it has actually received off the SSE stream.
        // This is a fresh request, so it isn't stuck behind a backlogged stream.
        json(res, 200, {
          seq: wal.currentSeq,
          now: Date.now(),
          newest_ts: wal.newestTs,
          sse_clients: sseClients,
          udp_subscribers: udpSender?.subscriberCount ?? 0,
          write_ms: wal.takeWriteStats(),
          total_entries: wal.totalEntries,
          channels: wal.getChannelCounts(),
          generation: wal.currentGeneration,
        });
      } else if (req.method === "GET" && pathname === "/cam/exposure") {
        json(res, 200, handleCamGetExposure());
      } else if (req.method === "POST" && pathname === "/cam/exposure/up") {
        json(res, 200, handleCamAdjustExposure(1));
      } else if (req.method === "POST" && pathname === "/cam/exposure/down") {
        json(res, 200, handleCamAdjustExposure(-1));
      } else if (req.method === "GET" && pathname === "/mic/gain") {
        json(res, 200, handleMicGetGain());
      } else if (req.method === "POST" && pathname === "/mic/gain/up") {
        json(res, 200, handleMicAdjustGain(1));
      } else if (req.method === "POST" && pathname === "/mic/gain/down") {
        json(res, 200, handleMicAdjustGain(-1));
      } else if (req.method === "GET" && pathname === "/services") {
        json(res, 200, handleServicesStatus());
      } else if (req.method === "GET" && pathname.startsWith("/services/") && pathname.endsWith("/logs")) {
        const svc = pathname.split("/")[2];
        json(res, 200, handleServiceLogs(svc));
      } else if (req.method === "POST" && pathname.startsWith("/services/") && pathname.endsWith("/restart")) {
        const svc = pathname.split("/")[2];
        const raw = await readBody(req);
        let body: any = {};
        try { body = JSON.parse(raw); } catch {}
        json(res, 200, handleServiceRestart(svc, body.password));
      } else if (req.method === "POST" && pathname === "/compact") {
        const result = await wal.compact();
        json(res, 200, result);
      } else if (req.method === "POST" && pathname === "/nuke") {
        await wal.nuke();
        json(res, 200, { ok: true });
      } else if (req.method === "GET" && pathname === "/health") {
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "internal error";
      json(res, 500, { error: msg });
    }
  });

  return server;
}

async function handleIngest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  wal: WalEngine,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "invalid json" });
    return;
  }

  const items: Array<{ channel: string; value: unknown; ts?: number }> = Array.isArray(body) ? body : [body];
  for (const item of items) {
    if (!item || !item.channel) {
      json(res, 400, { error: "each item must have a channel" });
      return;
    }
  }
  const entries = wal.append(...items);
  json(res, 200, { seq: entries[0].seq, count: entries.length });
}

function handleStream(url: URL, req: http.IncomingMessage, res: http.ServerResponse, wal: WalEngine): void {
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const channelsParam = url.searchParams.get("channels");
  const channelFilter = channelsParam ? new Set(channelsParam.split(",")) : null;

  function sendEvent(name: string, data: unknown): void {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // live tail
  const onEntry = (entry: WalEntry): void => {
    if (channelFilter && !channelFilter.has(entry.channel)) return;
    sendEvent("entry", entry);
  };

  wal.on("entry", onEntry);
  sseClients++;

  // Heartbeat doubles as keepalive. `buf`/`sock_buf` are the bytes we've queued
  // but not yet drained to the client — if they climb, the uplink can't carry the
  // stream and Node is absorbing the difference as unbounded latency.
  const BACKPRESSURE_WARN_BYTES = 256 * 1024;
  let warned = false;
  const heartbeat = setInterval(() => {
    const buf = res.writableLength;
    if (buf > BACKPRESSURE_WARN_BYTES && !warned) {
      warned = true;
      console.warn(`sse backpressure: ${(buf / 1024).toFixed(0)}KB queued for ${req.socket?.remoteAddress}`);
    } else if (buf < BACKPRESSURE_WARN_BYTES / 2) {
      warned = false;
    }
    sendEvent("hb", {
      now: Date.now(),
      seq: wal.currentSeq,
      buf,
      sock_buf: res.socket?.writableLength ?? 0,
    });
  }, 1000);

  // cleanup on disconnect — bound to two events, so guard against double-counting
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    sseClients--;
    wal.off("entry", onEntry);
    clearInterval(heartbeat);
  };

  req?.socket?.on("close", cleanup);
  res.on("close", cleanup);
}

async function handleWalRange(url: URL, res: http.ServerResponse, wal: WalEngine): Promise<void> {
  const startSeq = parseInt(url.searchParams.get("start_seq") ?? "", 10);
  const endSeq = parseInt(url.searchParams.get("end_seq") ?? "", 10);
  if (isNaN(startSeq) || isNaN(endSeq)) {
    json(res, 400, { error: "start_seq and end_seq are required" });
    return;
  }
  // Collect ticks and respond as msgpack — ~40% smaller than JSON, faster to encode
  const ticks: Array<{ seq: number; ts: number; d: Record<string, unknown> }> = [];
  await wal.streamTicksInRange(startSeq, endSeq, (line) => {
    try {
      ticks.push(JSON.parse(line));
    } catch {}
  });
  cors(res);
  res.writeHead(200, { "Content-Type": "application/x-msgpack" });
  res.end(pack(ticks));
}

// --- UDP live subscription ---

async function handleUdpSubscription(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  udpSender?: UdpSender,
): Promise<void> {
  const pathname = url.pathname;

  if (!udpSender) {
    json(res, 503, { error: "udp streaming not enabled" });
    return;
  }

  if (req.method === "GET" && pathname === "/live/udp/subscribers") {
    json(res, 200, udpSender.list());
    return;
  }

  // The lease rides the query string on DELETE. Bodies on DELETE are widely
  // mishandled — Node's own http client won't even frame one — so the query
  // param is the reliable form. A body is still accepted if one shows up.
  if (pathname === "/live/udp/subscribe" && req.method === "DELETE") {
    const lease = url.searchParams.get("lease");
    if (!lease || !udpSender.unsubscribe(lease)) {
      json(res, 404, { error: "unknown lease" });
      return;
    }
    json(res, 200, { ok: true });
    return;
  }

  const raw = await readBody(req);
  let body: any = {};
  if (raw.length > 0) {
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: "invalid json" }); return; }
  }

  if (pathname === "/live/udp/subscribe" && req.method === "POST") {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      json(res, 400, { error: "port is required (1-65535)" });
      return;
    }

    // Default to wherever this request came from — over Tailscale that's the
    // ground station's tailnet address. `addr` overrides it for odd setups.
    const remote = req.socket?.remoteAddress ?? "";
    const addr = typeof body.addr === "string" && body.addr.length > 0
      ? body.addr
      : normalizeAddr(remote);
    if (!addr) {
      json(res, 400, {
        error: `cannot derive an IPv4 destination from ${remote || "the request"}; pass "addr" explicitly`,
      });
      return;
    }

    const ttlMs = Number.isFinite(body.ttlMs) ? Number(body.ttlMs) : undefined;
    try {
      const lease = udpSender.subscribe(addr, port, ttlMs);
      console.log(`udp-sender lease ${lease.id.slice(0, 8)} → ${addr}:${port}`);
      json(res, 200, {
        lease: lease.id,
        addr: lease.addr,
        port: lease.port,
        expiresAt: lease.expiresAt,
        ttlMs: ttlMs ?? udpSender.defaultTtlMs,
      });
    } catch (err) {
      json(res, 429, { error: err instanceof Error ? err.message : "subscribe failed" });
    }
    return;
  }

  if (pathname === "/live/udp/renew" && req.method === "POST") {
    const lease = typeof body.lease === "string" ? udpSender.renew(body.lease) : null;
    if (!lease) { json(res, 404, { error: "unknown lease" }); return; }
    json(res, 200, { lease: lease.id, expiresAt: lease.expiresAt });
    return;
  }

  json(res, 404, { error: "not found" });
}

// --- Session SSE stream ---

function handleSessionStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SessionStore,
  detector: LapDetector,
  sessionId: string,
): void {
  const session = store.get(sessionId);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }

  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function sendEvent(name: string, data: unknown): void {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // send current state immediately
  sendEvent("session", store.get(sessionId));

  // forward lap events for this session
  const onLap = (e: LapEvent): void => {
    if (e.sessionId === sessionId) {
      sendEvent("lap", e.lap);
      sendEvent("session", e.session);
    }
  };
  detector.on("lap", onLap);

  // forward session updates (rename, stop, etc.)
  const onUpdate = (s: any): void => {
    if (s.id === sessionId) sendEvent("session", s);
  };
  store.on("update", onUpdate);

  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  const cleanup = (): void => {
    detector.off("lap", onLap);
    store.off("update", onUpdate);
    clearInterval(keepalive);
  };
  req?.socket?.on("close", cleanup);
  res.on("close", cleanup);
}

// --- Session CRUD ---

async function handleSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  wal: WalEngine,
  store: SessionStore,
  id: string | null,
): Promise<void> {
  if (!id) {
    // /sessions
    if (req.method === "GET") {
      const track = url.searchParams.get("track") ?? undefined;
      json(res, 200, store.list(track));
    } else if (req.method === "POST") {
      const raw = await readBody(req);
      let body: any;
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: "invalid json" }); return; }
      if (!body.track) { json(res, 400, { error: "track is required" }); return; }
      json(res, 201, store.create(body.track, wal.currentSeq, body.driver));
    } else {
      json(res, 405, { error: "method not allowed" });
    }
  } else {
    // /sessions/:id
    if (req.method === "GET") {
      const session = store.get(id);
      if (!session) { json(res, 404, { error: "session not found" }); return; }
      json(res, 200, session);
    } else if (req.method === "PATCH") {
      const raw = await readBody(req);
      let body: any;
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: "invalid json" }); return; }

      // When stopping a session, record the in-progress lap as "in" lap
      if (body.running === false) {
        const current = store.get(id);
        if (current?.running) {
          const now = Date.now();
          const elapsed = now - current.lapStartTs;
          if (elapsed > 5000) {
            // Record the incomplete lap as an in-lap
            const inLap: Lap = {
              lap: current.laps.length + 1,
              time: elapsed,
              flag: "in",
              track: current.track,
              startSeq: current.lapStartSeq,
              endSeq: wal.currentSeq,
            };
            current.laps.push(inLap);
          }
          body.laps = current.laps;
        }
      }

      const session = store.update(id, body);
      if (!session) { json(res, 404, { error: "session not found" }); return; }
      json(res, 200, session);
    } else if (req.method === "DELETE") {
      if (!store.delete(id)) { json(res, 404, { error: "session not found" }); return; }
      json(res, 200, { ok: true });
    } else {
      json(res, 405, { error: "method not allowed" });
    }
  }
}

// --- Systemctl service management ---

const MANAGED_SERVICES = [
  "racebox-connect",
  "telem-server",
  "racebox-bridge",
  "serial-bridge",
  "video-streaming",
];

function handleServicesStatus(): Record<string, unknown>[] {
  return MANAGED_SERVICES.map((svc) => {
    try {
      const raw = execSync(`systemctl is-active ${svc} 2>/dev/null`, { encoding: "utf-8" }).trim();
      return { name: svc, status: raw };
    } catch {
      return { name: svc, status: "unknown" };
    }
  });
}

function handleServiceLogs(svc: string): Record<string, unknown> {
  if (!MANAGED_SERVICES.includes(svc)) return { error: "unknown service" };
  try {
    const logs = execSync(`journalctl -u ${svc} -n 50 --no-pager --output=short-iso 2>/dev/null`, { encoding: "utf-8" });
    return { name: svc, logs };
  } catch (err: any) {
    return { name: svc, logs: "", error: err.message };
  }
}

function handleServiceRestart(svc: string, password?: string): Record<string, unknown> {
  if (!MANAGED_SERVICES.includes(svc)) return { error: "unknown service" };
  try {
    if (password) {
      execSync(`echo ${JSON.stringify(password)} | sudo -S systemctl restart ${svc} 2>&1`, { encoding: "utf-8" });
    } else {
      execSync(`sudo systemctl restart ${svc} 2>&1`, { encoding: "utf-8" });
    }
    return { name: svc, ok: true };
  } catch (err: any) {
    return { name: svc, ok: false, error: err.message };
  }
}

// --- Camera controls (v4l2-ctl) ---

let camDevice: string | null = null;

function findCamDevice(): string | null {
  if (camDevice) return camDevice;
  try {
    const devs = execSync("ls /dev/video* 2>/dev/null", { encoding: "utf-8" }).trim().split("\n");
    for (const dev of devs) {
      try {
        const info = execSync(`v4l2-ctl -d ${dev} --all 2>/dev/null`, { encoding: "utf-8" });
        if (info.includes("C930e")) {
          camDevice = dev;
          return dev;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function getCamCtrl(dev: string, ctrl: string): number {
  const out = execSync(`v4l2-ctl -d ${dev} --get-ctrl=${ctrl}`, { encoding: "utf-8" });
  return parseInt(out.replace(/.*:\s*/, ""), 10);
}

function handleCamGetExposure(): Record<string, unknown> {
  const dev = findCamDevice();
  if (!dev) return { error: "camera not found" };
  try {
    return {
      exposure_auto: getCamCtrl(dev, "exposure_auto"),
      exposure_absolute: getCamCtrl(dev, "exposure_absolute"),
      gain: getCamCtrl(dev, "gain"),
      brightness: getCamCtrl(dev, "brightness"),
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

// Exposure steps: raise/lower exposure_absolute and gain together
// exposure_absolute: 3–2047, gain: 0–255
const EXPOSURE_STEPS = [3, 5, 10, 20, 40, 80, 150, 250, 500, 1000, 2047];
const GAIN_STEPS = [0, 32, 64, 96, 128, 160, 192, 224, 255];

function stepValue(steps: number[], current: number, dir: number): number {
  let closest = 0;
  let minDist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - current);
    if (d < minDist) { minDist = d; closest = i; }
  }
  const next = Math.max(0, Math.min(steps.length - 1, closest + dir));
  return steps[next];
}

function handleCamAdjustExposure(dir: number): Record<string, unknown> {
  const dev = findCamDevice();
  if (!dev) return { error: "camera not found" };
  try {
    const curExp = getCamCtrl(dev, "exposure_absolute");
    const curGain = getCamCtrl(dev, "gain");

    const newExp = stepValue(EXPOSURE_STEPS, curExp, dir);
    const newGain = stepValue(GAIN_STEPS, curGain, dir);

    execSync(`v4l2-ctl -d ${dev} --set-ctrl=exposure_absolute=${newExp}`);
    execSync(`v4l2-ctl -d ${dev} --set-ctrl=gain=${newGain}`);

    return { exposure_absolute: newExp, gain: newGain };
  } catch (err: any) {
    return { error: err.message };
  }
}

// --- Mic controls (amixer) ---

const MIC_CARD = "LavMicroU";
const MIC_GAIN_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

function getMicGain(): number {
  try {
    const out = execSync(`amixer -c ${MIC_CARD} sget Mic 2>/dev/null`, { encoding: "utf-8" });
    const m = out.match(/\[(\d+)%\]/);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

function handleMicGetGain(): Record<string, unknown> {
  const gain = getMicGain();
  if (gain < 0) return { error: "mic not found" };
  return { gain };
}

function handleMicAdjustGain(dir: number): Record<string, unknown> {
  const cur = getMicGain();
  if (cur < 0) return { error: "mic not found" };
  try {
    const next = stepValue(MIC_GAIN_STEPS, cur, dir);
    execSync(`amixer -c ${MIC_CARD} sset Mic ${next}% 2>/dev/null`);
    return { gain: next };
  } catch (err: any) {
    return { error: err.message };
  }
}
