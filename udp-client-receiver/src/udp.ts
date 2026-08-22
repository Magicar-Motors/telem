/**
 * Receives merged telemetry ticks from the car over UDP and accounts for what
 * went missing on the way.
 *
 * This path is deliberately lossy — a dropped datagram is a permanent gap in the
 * live view, never retransmitted. What matters is that we *notice*: `lossPct`
 * over a rolling window is the number that tells you whether the link is
 * degrading, and it's the thing SSE-over-TCP could never surface because TCP
 * hid loss behind ever-growing latency instead.
 */
import * as dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { unpack } from "msgpackr";

export interface Tick {
  seq: number;
  ts: number;
  d: Record<string, unknown>;
}

export interface ReceiverStats {
  received: number;
  lost: number;
  reordered: number;
  malformed: number;
  /** Loss over the rolling window, 0-100. */
  lossPct: number;
  lastSeq: number;
  lastTs: number;
  lastRecvAt: number;
}

const WINDOW_MS = 10_000;

export interface UdpReceiverOptions {
  /** Dev-only: discard this percentage of datagrams to exercise loss handling. */
  testDropPct?: number;
}

export class UdpReceiver extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private testDropPct: number;

  private received = 0;
  private lost = 0;
  private reordered = 0;
  private malformed = 0;
  private lastSeq = 0;
  private lastTs = 0;
  private lastRecvAt = 0;

  // Rolling window, so lossPct reflects the link now rather than since boot.
  private windowReceived = 0;
  private windowLost = 0;
  private windowStart = Date.now();
  private windowLossPct = 0;

  constructor(opts: UdpReceiverOptions = {}) {
    super();
    this.testDropPct = opts.testDropPct ?? 0;
  }

  async bind(port: number, addr = "0.0.0.0"): Promise<void> {
    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg) => this.handle(msg));

    // A bind failure is fatal and worth a clean message; anything after startup
    // is not. Never re-emit "error" — an EventEmitter with no error listener
    // rethrows, which would turn a transient socket blip into a crash.
    await new Promise<void>((resolve, reject) => {
      const onBindError = (err: Error): void => reject(err);
      socket.once("error", onBindError);
      socket.bind(port, addr, () => {
        socket.off("error", onBindError);
        socket.on("error", (err) => console.error(`[udp] socket error: ${err.message}`));
        resolve();
      });
    });
  }

  /** Exposed for tests — feeds a raw datagram through the same path as the socket. */
  handle(msg: Buffer): void {
    if (this.testDropPct > 0 && Math.random() * 100 < this.testDropPct) return;

    let tick: Tick;
    try {
      tick = unpack(msg) as Tick;
    } catch {
      this.malformed++;
      return;
    }

    if (!tick || typeof tick.seq !== "number" || typeof tick.ts !== "number" || typeof tick.d !== "object") {
      this.malformed++;
      return;
    }

    this.rollWindow();

    // UDP reorders and duplicates. Anything at or behind the high-water mark is
    // stale by definition — dropping it is the whole point of this transport.
    if (this.lastSeq > 0 && tick.seq <= this.lastSeq) {
      this.reordered++;
      return;
    }

    if (this.lastSeq > 0) {
      const gap = tick.seq - this.lastSeq - 1;
      if (gap > 0) {
        this.lost += gap;
        this.windowLost += gap;
      }
    }

    this.lastSeq = tick.seq;
    this.lastTs = tick.ts;
    this.lastRecvAt = Date.now();
    this.received++;
    this.windowReceived++;

    this.emit("tick", tick);
  }

  private rollWindow(): void {
    const now = Date.now();
    if (now - this.windowStart < WINDOW_MS) return;
    const total = this.windowReceived + this.windowLost;
    this.windowLossPct = total > 0 ? (this.windowLost / total) * 100 : 0;
    this.windowReceived = 0;
    this.windowLost = 0;
    this.windowStart = now;
  }

  get stats(): ReceiverStats {
    // Blend the closed window with what's accumulated so far, so a fresh start
    // doesn't read 0% for ten seconds while packets are visibly dropping.
    const total = this.windowReceived + this.windowLost;
    const live = total > 0 ? (this.windowLost / total) * 100 : this.windowLossPct;
    return {
      received: this.received,
      lost: this.lost,
      reordered: this.reordered,
      malformed: this.malformed,
      lossPct: Math.round(live * 10) / 10,
      lastSeq: this.lastSeq,
      lastTs: this.lastTs,
      lastRecvAt: this.lastRecvAt,
    };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
