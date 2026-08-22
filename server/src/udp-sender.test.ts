import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { unpack } from "msgpackr";
import { WalEngine } from "./wal.js";
import { UdpSender, normalizeAddr } from "./udp-sender.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "udp-sender-test-"));
}

/** A bound UDP socket plus a promise-based way to await the next N datagrams. */
class TestReceiver {
  socket: dgram.Socket;
  port = 0;
  private received: unknown[] = [];
  private waiters: Array<{ n: number; resolve: (v: unknown[]) => void }> = [];

  private constructor(socket: dgram.Socket) {
    this.socket = socket;
    socket.on("message", (msg) => {
      this.received.push(unpack(msg));
      for (const w of [...this.waiters]) {
        if (this.received.length >= w.n) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(this.received.slice(0, w.n));
        }
      }
    });
  }

  static async bind(): Promise<TestReceiver> {
    const socket = dgram.createSocket("udp4");
    const receiver = new TestReceiver(socket);
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    receiver.port = (socket.address() as AddressInfo).port;
    return receiver;
  }

  /** Resolves with the first n datagrams, or rejects if they don't arrive in time. */
  take(n: number, timeoutMs = 1000): Promise<unknown[]> {
    if (this.received.length >= n) return Promise.resolve(this.received.slice(0, n));
    return new Promise((resolve, reject) => {
      const waiter = { n, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`expected ${n} datagram(s), got ${this.received.length}`));
        }
      }, timeoutMs);
    });
  }

  get count(): number {
    return this.received.length;
  }

  close(): void {
    this.socket.close();
  }
}

/** Datagrams are async; give the event loop a beat to deliver (or not). */
function settle(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("normalizeAddr", () => {
  it("unwraps IPv4-mapped IPv6", () => {
    expect(normalizeAddr("::ffff:100.64.0.1")).toBe("100.64.0.1");
  });

  it("passes plain IPv4 through", () => {
    expect(normalizeAddr("127.0.0.1")).toBe("127.0.0.1");
  });

  it("rejects real IPv6, which the udp4 socket cannot reach", () => {
    expect(normalizeAddr("fd7a:115c:a1e0::1")).toBeNull();
  });
});

describe("UdpSender", () => {
  let dataDir: string;
  let wal: WalEngine;
  let sender: UdpSender;
  let rx: TestReceiver;

  beforeEach(async () => {
    dataDir = tmpDir();
    wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 100 });
    await wal.init();
    sender = new UdpSender(wal);
    rx = await TestReceiver.bind();
  });

  afterEach(() => {
    sender.close();
    rx.close();
    wal.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("sends a merged tick, not one datagram per channel", async () => {
    sender.subscribe("127.0.0.1", rx.port);
    wal.append(
      { channel: "rpm", value: 3500 },
      { channel: "speed", value: 65.4 },
      { channel: "gps_lat", value: 38.161 },
    );

    const [tick] = (await rx.take(1)) as Array<{ seq: number; ts: number; d: Record<string, unknown> }>;
    expect(tick.seq).toBe(1);
    expect(typeof tick.ts).toBe("number");
    expect(tick.d).toEqual({ rpm: 3500, speed: 65.4, gps_lat: 38.161 });
    expect(rx.count).toBe(1);
  });

  it("sends nothing before anyone subscribes", async () => {
    wal.append({ channel: "rpm", value: 1000 });
    await settle();
    expect(rx.count).toBe(0);
  });

  it("stops sending once a lease expires", async () => {
    sender.subscribe("127.0.0.1", rx.port, 50);
    wal.append({ channel: "rpm", value: 1000 });
    await rx.take(1);

    await settle(100); // lease lapses
    wal.append({ channel: "rpm", value: 2000 });
    await settle();

    expect(rx.count).toBe(1);
    expect(sender.list()).toHaveLength(0);
  });

  it("renew extends an otherwise-expiring lease", async () => {
    const lease = sender.subscribe("127.0.0.1", rx.port, 80);
    await settle(50);
    expect(sender.renew(lease.id, 500)).not.toBeNull();

    await settle(80); // past the original expiry
    wal.append({ channel: "rpm", value: 3000 });

    const [tick] = (await rx.take(1)) as Array<{ d: Record<string, unknown> }>;
    expect(tick.d).toEqual({ rpm: 3000 });
  });

  it("renew returns null for an unknown lease", () => {
    expect(sender.renew("nope")).toBeNull();
  });

  it("unsubscribe stops delivery", async () => {
    const lease = sender.subscribe("127.0.0.1", rx.port);
    wal.append({ channel: "rpm", value: 1000 });
    await rx.take(1);

    expect(sender.unsubscribe(lease.id)).toBe(true);
    wal.append({ channel: "rpm", value: 2000 });
    await settle();

    expect(rx.count).toBe(1);
    expect(sender.unsubscribe(lease.id)).toBe(false);
  });

  it("fans one encoded tick out to every subscriber", async () => {
    const rx2 = await TestReceiver.bind();
    try {
      sender.subscribe("127.0.0.1", rx.port);
      sender.subscribe("127.0.0.1", rx2.port);
      wal.append({ channel: "rpm", value: 4200 });

      const [a] = (await rx.take(1)) as Array<{ d: Record<string, unknown> }>;
      const [b] = (await rx2.take(1)) as Array<{ d: Record<string, unknown> }>;
      expect(a.d).toEqual({ rpm: 4200 });
      expect(b.d).toEqual({ rpm: 4200 });
    } finally {
      rx2.close();
    }
  });

  it("re-subscribing from the same endpoint renews rather than burning a slot", () => {
    const first = sender.subscribe("127.0.0.1", rx.port, 100);
    const second = sender.subscribe("127.0.0.1", rx.port, 5000);
    expect(second.id).toBe(first.id);
    expect(sender.list()).toHaveLength(1);
    expect(second.expiresAt).toBeGreaterThan(first.createdAt + 1000);
  });

  it("caps the number of subscribers", () => {
    const capped = new UdpSender(wal, { maxSubscribers: 2 });
    try {
      capped.subscribe("127.0.0.1", 1111);
      capped.subscribe("127.0.0.1", 2222);
      expect(() => capped.subscribe("127.0.0.1", 3333)).toThrow(/too many subscribers/);
    } finally {
      capped.close();
    }
  });

  it("counts bytes and packets per lease", async () => {
    const lease = sender.subscribe("127.0.0.1", rx.port);
    wal.append({ channel: "rpm", value: 1000 });
    await rx.take(1);
    await settle();

    expect(lease.sentPackets).toBe(1);
    expect(lease.sentBytes).toBeGreaterThan(0);
    expect(lease.sendErrors).toBe(0);
  });

  it("detaches from the WAL once the last lease goes away", async () => {
    const lease = sender.subscribe("127.0.0.1", rx.port);
    expect(wal.listenerCount("tick")).toBe(1);
    sender.unsubscribe(lease.id);
    expect(wal.listenerCount("tick")).toBe(0);
  });
});
