import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { WalEngine } from "./wal.js";
import { UdpSender } from "./udp-sender.js";
import { createServer } from "./http.js";
import { SessionStore } from "./sessions.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "http-test-"));
}

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode!, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      // Content-Length must be explicit: node only turns on chunked encoding by
      // default for POST/PUT/PATCH, so on other methods an unframed body gets
      // parsed as the next request and the server answers a bare 400.
      const payload = Buffer.from(JSON.stringify(body));
      req.setHeader("Content-Type", "application/json");
      req.setHeader("Content-Length", payload.length);
      req.write(payload);
    }
    req.end();
  });
}

function sseRequest(
  port: number,
  urlPath: string,
  maxEvents: number,
  timeoutMs = 2000,
): Promise<Array<{ event: string; data: any }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: any }> = [];
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
    const req = http.request(url, { method: "GET" }, (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        // parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!; // keep incomplete part
        for (const part of parts) {
          if (part.startsWith(":")) continue; // comment/keepalive
          const lines = part.split("\n");
          let event = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (event) {
            try {
              events.push({ event, data: JSON.parse(data) });
            } catch {
              events.push({ event, data });
            }
          }
          if (events.length >= maxEvents) {
            req.destroy();
            resolve(events);
            return;
          }
        }
      });
      res.on("end", () => resolve(events));
    });
    req.on("error", (err) => {
      if ((err as any).code === "ECONNRESET") resolve(events);
      else reject(err);
    });
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

describe("HTTP server", () => {
  let dataDir: string;
  let wal: WalEngine;
  let server: http.Server;
  let port: number;
  let udpSender: UdpSender;

  beforeAll(async () => {
    dataDir = tmpDir();
    wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 100 });
    await wal.init();
    udpSender = new UdpSender(wal);
    server = createServer(wal, new SessionStore(dataDir), undefined, undefined, udpSender);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    udpSender.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wal.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe("/live/udp — subscription lifecycle", () => {
    it("subscribes, defaulting the destination to the caller's address", async () => {
      const res = await request(port, "POST", "/live/udp/subscribe", { port: 45001 });
      expect(res.status).toBe(200);
      expect(res.body.addr).toBe("127.0.0.1");
      expect(res.body.port).toBe(45001);
      expect(typeof res.body.lease).toBe("string");
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());

      await request(port, "DELETE", `/live/udp/subscribe?lease=${res.body.lease}`);
    });

    it("honours an explicit addr override", async () => {
      const res = await request(port, "POST", "/live/udp/subscribe", { port: 45002, addr: "10.1.2.3" });
      expect(res.status).toBe(200);
      expect(res.body.addr).toBe("10.1.2.3");

      await request(port, "DELETE", `/live/udp/subscribe?lease=${res.body.lease}`);
    });

    it("rejects a missing or nonsense port", async () => {
      expect((await request(port, "POST", "/live/udp/subscribe", {})).status).toBe(400);
      expect((await request(port, "POST", "/live/udp/subscribe", { port: 0 })).status).toBe(400);
      expect((await request(port, "POST", "/live/udp/subscribe", { port: 99999 })).status).toBe(400);
    });

    it("lists active subscribers", async () => {
      const sub = await request(port, "POST", "/live/udp/subscribe", { port: 45003 });
      const list = await request(port, "GET", "/live/udp/subscribers");
      expect(list.status).toBe(200);
      expect(list.body.some((l: any) => l.port === 45003)).toBe(true);

      await request(port, "DELETE", `/live/udp/subscribe?lease=${sub.body.lease}`);
      const after = await request(port, "GET", "/live/udp/subscribers");
      expect(after.body.some((l: any) => l.port === 45003)).toBe(false);
    });

    it("renews an existing lease and 404s an unknown one", async () => {
      const sub = await request(port, "POST", "/live/udp/subscribe", { port: 45004 });
      const renewed = await request(port, "POST", "/live/udp/renew", { lease: sub.body.lease });
      expect(renewed.status).toBe(200);
      expect(renewed.body.expiresAt).toBeGreaterThanOrEqual(sub.body.expiresAt);

      expect((await request(port, "POST", "/live/udp/renew", { lease: "bogus" })).status).toBe(404);
      await request(port, "DELETE", `/live/udp/subscribe?lease=${sub.body.lease}`);
    });

    it("404s unsubscribing something that isn't subscribed", async () => {
      expect((await request(port, "DELETE", "/live/udp/subscribe?lease=bogus")).status).toBe(404);
      expect((await request(port, "DELETE", "/live/udp/subscribe")).status).toBe(404);
    });

    it("reports subscriber count on /stats", async () => {
      const sub = await request(port, "POST", "/live/udp/subscribe", { port: 45005 });
      expect((await request(port, "GET", "/stats")).body.udp_subscribers).toBeGreaterThan(0);
      await request(port, "DELETE", `/live/udp/subscribe?lease=${sub.body.lease}`);
    });
  });

  describe("GET /health", () => {
    it("returns ok", async () => {
      const res = await request(port, "GET", "/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("includes CORS headers", async () => {
      const res = await request(port, "GET", "/health");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("OPTIONS preflight", () => {
    it("returns 204 with CORS headers", async () => {
      const res = await request(port, "OPTIONS", "/ingest");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
    });
  });

  describe("POST /ingest", () => {
    it("ingests a single entry", async () => {
      const res = await request(port, "POST", "/ingest", { channel: "speed", value: 142.5 });
      expect(res.status).toBe(200);
      expect(res.body.seq).toBeGreaterThan(0);
    });

    it("ingests a batch", async () => {
      const res = await request(port, "POST", "/ingest", [
        { channel: "rpm", value: 8200 },
        { channel: "speed", value: 145.1 },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      // Batch entries share the same seq
      expect(res.body.seq_start).toBe(res.body.seq_end);
    });

    it("rejects missing channel", async () => {
      const res = await request(port, "POST", "/ingest", { value: 123 });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request(
          new URL("/ingest", `http://127.0.0.1:${port}`),
          { method: "POST" },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () =>
              resolve({
                status: r.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
          },
        );
        req.on("error", reject);
        req.setHeader("Content-Type", "application/json");
        req.write("not json at all");
        req.end();
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid json");
    });

    it("accepts custom timestamp", async () => {
      const res = await request(port, "POST", "/ingest", {
        channel: "speed",
        value: 100,
        ts: 9999999,
      });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /stats", () => {
    it("returns seq, entries, channel counts, generation", async () => {
      const res = await request(port, "GET", "/stats");
      expect(res.status).toBe(200);
      expect(typeof res.body.seq).toBe("number");
      expect(typeof res.body.total_entries).toBe("number");
      expect(typeof res.body.channels).toBe("object");
      expect(typeof res.body.generation).toBe("number");
    });
  });

  describe("GET /stream (SSE)", () => {
    it("receives live events", async () => {
      const eventPromise = sseRequest(port, "/stream?channels=live_test", 2, 2000);

      await new Promise((r) => setTimeout(r, 50));

      await request(port, "POST", "/ingest", { channel: "live_test", value: "hello" });
      await request(port, "POST", "/ingest", { channel: "live_test", value: "world" });

      const events = await eventPromise;
      const liveEntries = events.filter((e) => e.event === "entry");
      expect(liveEntries.length).toBeGreaterThanOrEqual(1);
      expect(liveEntries[0].data.channel).toBe("live_test");
    });

    it("filters by channel", async () => {
      const eventPromise = sseRequest(port, "/stream?channels=filt_a", 2, 2000);
      await new Promise((r) => setTimeout(r, 50));

      await request(port, "POST", "/ingest", [
        { channel: "filt_a", value: 1 },
        { channel: "filt_b", value: 2 },
      ]);

      const events = await eventPromise;
      const entries = events.filter((e) => e.event === "entry");
      expect(entries.every((e) => e.data.channel === "filt_a")).toBe(true);
    });
  });

  describe("404", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await request(port, "GET", "/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});
