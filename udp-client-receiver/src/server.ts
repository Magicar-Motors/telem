/**
 * Re-serves the UDP tick feed to local browsers as SSE.
 *
 * Browsers can't receive UDP, so this is the bridge. It's bound to loopback and
 * everything downstream of here is localhost TCP — free, lossless, and with no
 * cell link to congest.
 */
import * as http from "node:http";
import type { UdpReceiver, Tick } from "./udp.js";
import type { LeaseKeeper } from "./lease.js";

export interface RelayServerOptions {
  receiver: UdpReceiver;
  lease: LeaseKeeper;
  port: number;
  host?: string;
}

export function createServer(opts: RelayServerOptions): http.Server {
  const { receiver, lease } = opts;

  return http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/stream" && req.method === "GET") {
      handleStream(req, res, receiver, lease);
      return;
    }

    if (pathname === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...receiver.stats, leaseOk: lease.ok, now: Date.now() }));
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

function handleStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  receiver: UdpReceiver,
  lease: LeaseKeeper,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function send(name: string, data: unknown): boolean {
    return res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Newest-wins. This is loopback so it should never actually engage, but the
  // whole point of this rewrite was that an unbounded write buffer turns
  // congestion into permanent latency — so don't reintroduce it here.
  let congested = false;
  res.on("drain", () => { congested = false; });

  const onTick = (tick: Tick): void => {
    if (congested) return;
    if (!send("tick", tick)) congested = true;
  };
  receiver.on("tick", onTick);

  const heartbeat = setInterval(() => {
    const s = receiver.stats;
    send("hb", {
      now: Date.now(),
      lastSeq: s.lastSeq,
      lastTs: s.lastTs,
      lastRecvAgoMs: s.lastRecvAt > 0 ? Date.now() - s.lastRecvAt : -1,
      received: s.received,
      lost: s.lost,
      reordered: s.reordered,
      lossPct: s.lossPct,
      leaseOk: lease.ok,
    });
  }, 1000);

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    receiver.off("tick", onTick);
    clearInterval(heartbeat);
  };
  req.socket?.on("close", cleanup);
  res.on("close", cleanup);
}
