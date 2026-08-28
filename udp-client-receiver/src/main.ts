/**
 * Ground-station UDP client receiver.
 *
 * Takes the car's lossy UDP tick feed off the cell link and re-serves it to
 * this laptop's browsers as SSE over loopback. Every laptop runs its own — they
 * are independent subscribers and never proxy for each other.
 *
 * Usage: npm start
 */
import { UdpReceiver } from "./udp.js";
import { LeaseKeeper } from "./lease.js";
import { createServer } from "./server.js";

const JETSON_URL = (process.env.JETSON_URL ?? "http://gearados-nx:4400").replace(/\/$/, "");
const HTTP_PORT = parseInt(process.env.RECEIVER_HTTP_PORT ?? "4401", 10);
const UDP_PORT = parseInt(process.env.RECEIVER_UDP_PORT ?? "4402", 10);
const HTTP_HOST = process.env.RECEIVER_HTTP_HOST ?? "127.0.0.1";
const LEASE_TTL_MS = parseInt(process.env.LEASE_TTL_MS ?? "15000", 10);
const TEST_DROP_PCT = parseFloat(process.env.RECEIVER_TEST_DROP_PCT ?? "0");
// Held here rather than in the browser so every page on this machine shares one
// delay line.
const DELAY_MS = parseInt(process.env.RECEIVER_DELAY_MS ?? "1000", 10);

async function main(): Promise<void> {
  const delayMs = Number.isFinite(DELAY_MS) && DELAY_MS > 0 ? DELAY_MS : 0;
  const receiver = new UdpReceiver({ testDropPct: TEST_DROP_PCT, delayMs });
  await receiver.bind(UDP_PORT);
  console.log(`[udp] listening on 0.0.0.0:${UDP_PORT}`);
  if (TEST_DROP_PCT > 0) {
    console.warn(`[udp] TEST MODE — discarding ${TEST_DROP_PCT}% of datagrams`);
  }
  if (delayMs > 0) {
    // Without this line, the lag the dashboard reports looks like a bad link.
    console.log(`[udp] holding ticks ${delayMs}ms to match video latency`);
  }

  const lease = new LeaseKeeper({ jetsonUrl: JETSON_URL, udpPort: UDP_PORT, ttlMs: LEASE_TTL_MS });
  lease.start();

  const server = createServer({ receiver, lease, port: HTTP_PORT, host: HTTP_HOST });
  server.listen(HTTP_PORT, HTTP_HOST, () => {
    console.log(`[http] serving ticks at http://${HTTP_HOST}:${HTTP_PORT}/stream`);
    console.log(`[http] subscribed to ${JETSON_URL}`);
  });

  // Periodic health line — the useful signal at a track is whether datagrams are
  // still arriving, and how much of the feed is going missing.
  const statusTimer = setInterval(() => {
    const s = receiver.stats;
    if (s.received === 0) {
      console.log(`[status] no datagrams yet (lease ${lease.ok ? "ok" : "down"})`);
      return;
    }
    const ago = ((Date.now() - s.lastRecvAt) / 1000).toFixed(1);
    console.log(
      `[status] seq ${s.lastSeq} · ${s.received} rx · ${s.lost} lost (${s.lossPct}%) · last ${ago}s ago`,
    );
  }, 10_000);
  statusTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("shutting down...");
    clearInterval(statusTimer);
    await lease.stop();
    receiver.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref?.();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
