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
  /** Times the car's seq counter restarted under us. */
  resets: number;
}

const WINDOW_MS = 10_000;

/**
 * A backward seq jump larger than this is a restarted source, not reordering.
 * At the car's ~25-50 ticks/s even a pathological reorder is a handful of seqs;
 * this is tens of seconds of stream.
 */
const RESET_SEQ_GAP = 1000;

export interface UdpReceiverOptions {
  /** Dev-only: discard this percentage of datagrams to exercise loss handling. */
  testDropPct?: number;
  /**
   * Hold every tick this long before publishing it, to line the telemetry up
   * with the video it describes. The video path is a fixed ~800ms of SRT
   * latency plus pipeline cost, while telemetry arrives in tens of ms, so
   * without this the overlay leads the frame it is drawn on. Delaying here
   * rather than in the browser keeps one delay line for every page on this
   * machine, and keeps loss accounting measured on arrival where it belongs.
   */
  delayMs?: number;
}

export class UdpReceiver extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private testDropPct: number;
  private delayMs: number;
  private delayTimers = new Set<ReturnType<typeof setTimeout>>();

  private received = 0;
  private lost = 0;
  private reordered = 0;
  private malformed = 0;
  private lastSeq = 0;
  private lastTs = 0;
  private lastRecvAt = 0;
  private resets = 0;

  // Rolling window, so lossPct reflects the link now rather than since boot.
  private windowReceived = 0;
  private windowLost = 0;
  private windowStart = Date.now();
  private windowLossPct = 0;

  constructor(opts: UdpReceiverOptions = {}) {
    super();
    this.testDropPct = opts.testDropPct ?? 0;
    this.delayMs = Math.max(0, opts.delayMs ?? 0);
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

    // The car's seq counter can restart — its WAL comes up without recovering
    // the previous high-water mark and numbering begins again from zero. Every
    // datagram then reads as stale against our mark and the feed dies silently
    // while the link, the lease and the car all look healthy; that cost 37
    // minutes on 2026-08-23. Corroborate with ts, which is wall clock and keeps
    // climbing across a restart, so a wild reorder can't trigger this.
    if (this.lastSeq > 0 && tick.seq < this.lastSeq - RESET_SEQ_GAP && tick.ts > this.lastTs) {
      console.warn(`[udp] source seq reset: ${this.lastSeq} → ${tick.seq}, re-anchoring`);
      this.lastSeq = 0;
      this.resets++;
    }

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

    this.publish(tick);
  }

  /**
   * Emit now, or after the configured delay. Equal timeouts fire in the order
   * they were set, so the delay line preserves tick order and spacing — it
   * shifts the feed in time without reshaping it.
   */
  private publish(tick: Tick): void {
    if (this.delayMs === 0) {
      this.emit("tick", tick);
      return;
    }
    const timer = setTimeout(() => {
      this.delayTimers.delete(timer);
      this.emit("tick", tick);
    }, this.delayMs);
    // Unref'd so a shutdown isn't held open for the length of the delay line;
    // the HTTP server is what keeps this process alive.
    timer.unref?.();
    this.delayTimers.add(timer);
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
      resets: this.resets,
    };
  }

  close(): void {
    for (const timer of this.delayTimers) clearTimeout(timer);
    this.delayTimers.clear();
    this.socket?.close();
    this.socket = null;
  }
}
