/**
 * Pushes merged WAL ticks to ground stations over UDP.
 *
 * Live telemetry used to ride the SSE stream on :4400, which is TCP — so a
 * congested cell uplink turned into an unbounded, non-recovering backlog rather
 * than dropped samples. Stale telemetry has no value, so this path is
 * deliberately lossy: datagrams are fire-and-forget, gaps are permanent, and
 * replay still pulls complete data from the WAL over HTTP.
 *
 * Subscriptions are leased. A ground station that vanishes without
 * unsubscribing stops receiving once its lease lapses, so the car never keeps
 * spending scarce uplink on a laptop that closed its lid.
 */
import * as dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { pack } from "msgpackr";
import type { WalEngine, WalTick } from "./wal.js";

export interface Lease {
  id: string;
  addr: string;
  port: number;
  expiresAt: number;
  createdAt: number;
  sentPackets: number;
  sentBytes: number;
  sendErrors: number;
}

export interface UdpSenderOptions {
  defaultTtlMs?: number;
  maxSubscribers?: number;
}

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_SUBSCRIBERS = 4;
const SWEEP_INTERVAL_MS = 5_000;

/**
 * Fragmented UDP inside WireGuard loses the whole datagram if any fragment
 * drops, so oversized ticks must be loud rather than silently lossy. A
 * 26-channel tick packs to ~400-500 bytes, well under this.
 */
const MTU_WARN_BYTES = 1200;

/** Node reports IPv4 peers as `::ffff:a.b.c.d` on a dual-stack listener. */
export function normalizeAddr(addr: string): string | null {
  if (addr.startsWith("::ffff:")) {
    const v4 = addr.slice(7);
    return v4.includes(":") ? null : v4;
  }
  return addr.includes(":") ? null : addr;
}

export class UdpSender {
  private wal: WalEngine;
  private leases = new Map<string, Lease>();
  private socket: dgram.Socket | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private listening = false;
  private mtuWarned = false;

  readonly defaultTtlMs: number;
  readonly maxSubscribers: number;

  private onTick = (tick: WalTick): void => this.broadcast(tick);

  constructor(wal: WalEngine, opts: UdpSenderOptions = {}) {
    this.wal = wal;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxSubscribers = opts.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
  }

  subscribe(addr: string, port: number, ttlMs?: number): Lease {
    // Re-subscribing from the same endpoint renews in place, so a receiver that
    // restarts doesn't burn a slot and leave its old lease sending into a void.
    const existing = [...this.leases.values()].find((l) => l.addr === addr && l.port === port);
    if (existing) {
      existing.expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
      return existing;
    }

    if (this.leases.size >= this.maxSubscribers) {
      throw new Error(`too many subscribers (max ${this.maxSubscribers})`);
    }

    const now = Date.now();
    const lease: Lease = {
      id: randomUUID(),
      addr,
      port,
      createdAt: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
      sentPackets: 0,
      sentBytes: 0,
      sendErrors: 0,
    };
    this.leases.set(lease.id, lease);
    this.start();
    return lease;
  }

  renew(id: string, ttlMs?: number): Lease | null {
    const lease = this.leases.get(id);
    if (!lease) return null;
    lease.expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    return lease;
  }

  unsubscribe(id: string): boolean {
    const removed = this.leases.delete(id);
    if (removed && this.leases.size === 0) this.stop();
    return removed;
  }

  list(): Lease[] {
    this.sweep();
    return [...this.leases.values()];
  }

  get subscriberCount(): number {
    return this.leases.size;
  }

  /** Subscribe to the WAL and open the socket only while someone is listening. */
  private start(): void {
    if (this.listening) return;
    this.listening = true;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("error", (err) => console.error(`udp-sender socket error: ${err.message}`));
    this.socket.unref(); // never hold the process open on our account
    this.wal.on("tick", this.onTick);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.wal.off("tick", this.onTick);
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        console.log(`udp-sender lease expired: ${lease.addr}:${lease.port}`);
        this.leases.delete(id);
      }
    }
    if (this.leases.size === 0) this.stop();
  }

  private broadcast(tick: WalTick): void {
    this.sweep();
    const socket = this.socket;
    if (!socket || this.leases.size === 0) return;

    // Encode once; UDP has no group send, so each destination needs its own call.
    const buf = pack(tick);

    if (buf.length > MTU_WARN_BYTES && !this.mtuWarned) {
      this.mtuWarned = true;
      console.warn(
        `udp-sender: tick is ${buf.length}B, over the ${MTU_WARN_BYTES}B fragmentation threshold — ` +
          `datagrams will fragment and drop as a unit. Consider splitting channels.`,
      );
    }

    for (const lease of this.leases.values()) {
      socket.send(buf, lease.port, lease.addr, (err) => {
        if (err) {
          // Cellular flaps produce transient send errors constantly; the lease TTL
          // is what reaps a genuinely dead receiver, not a single failed send.
          lease.sendErrors++;
          if (lease.sendErrors % 100 === 1) {
            console.warn(`udp-sender send failed for ${lease.addr}:${lease.port}: ${err.message}`);
          }
          return;
        }
        lease.sentPackets++;
        lease.sentBytes += buf.length;
      });
    }
  }

  close(): void {
    this.leases.clear();
    this.stop();
  }
}
