/**
 * Splits the Jetson→browser delay into the stages that can actually cause it.
 *
 * The status bar's `skew` (browser clock − newest telemetry ts) is the symptom,
 * but it mixes together clock offset, ingest lag on the car, and delivery delay.
 * This probe separates them by polling the car's /stats on a *fresh* request and
 * comparing it against what the live feed has actually delivered.
 *
 * Now that live telemetry is lossy UDP there is no queue to fall behind, so the
 * failure mode has changed shape: congestion shows up as `lossPct`, not as an
 * ever-growing lag. Reading the result:
 *   ingestLagMs high → stale before it ever left the car (bridges, serial, disk)
 *   lossPct high     → the uplink is dropping datagrams; gaps are permanent
 *   lagMs high, loss ~0 → delivery is slow but intact; suspect the car, not the link
 */
import { SERVER_URL } from "./server-url";
import type { TelemetryManager } from "./telemetry";

export interface LatencyBreakdown {
  offsetMs: number; // car clock − our clock, RTT-corrected
  rttMs: number; // round trip of the probe itself
  ingestLagMs: number; // newest WAL entry's age, measured on the car
  lagSeq: number; // seqs the car has that we haven't received
  lagMs: number; // that lag as time, via observed seq rate
  lossPct: number; // datagrams dropped in transit, rolling window
  lostTotal: number; // datagrams dropped since the receiver started
  lastRecvAgoMs: number; // how long since a datagram arrived (-1 = none yet)
  leaseOk: boolean; // is our UDP subscription live on the car
  seqRate: number; // seq/s, for converting lag to time
  udpSubscribers: number; // how many ground stations the car is feeding
  writeMaxMs: number; // worst blocking disk write on the car since last poll
}

interface StatsResponse {
  seq: number;
  now: number;
  newest_ts: number;
  sse_clients: number;
  udp_subscribers?: number;
  write_ms: { maxMs: number; avgMs: number; samples: number };
}

const DEFAULT_SEQ_RATE = 50; // two bridges at 25Hz, until we've measured

export class LatencyProbe {
  private mgr: TelemetryManager;
  private prev: { seq: number; now: number } | null = null;
  private seqRate = DEFAULT_SEQ_RATE;

  latest: LatencyBreakdown | null = null;
  onUpdate: ((b: LatencyBreakdown) => void) | null = null;

  constructor(mgr: TelemetryManager) {
    this.mgr = mgr;
  }

  async sample(): Promise<LatencyBreakdown | null> {
    const t0 = Date.now();
    let stats: StatsResponse;
    try {
      const res = await fetch(`${SERVER_URL}/stats`, { cache: "no-store" });
      if (!res.ok) return null;
      stats = await res.json();
    } catch {
      return null;
    }
    const t1 = Date.now();

    const rttMs = t1 - t0;
    // Assume a symmetric path — the usual NTP-style estimate. Asymmetric uplink
    // congestion biases this, which is itself worth noticing.
    const offsetMs = stats.now - (t0 + rttMs / 2);

    // Track the server's own seq rate so backlog converts to seconds honestly,
    // rather than assuming the nominal 50/s that a stalled bridge wouldn't hit.
    if (this.prev && stats.now > this.prev.now) {
      const rate = ((stats.seq - this.prev.seq) / (stats.now - this.prev.now)) * 1000;
      if (rate > 0) this.seqRate = rate;
    }
    this.prev = { seq: stats.seq, now: stats.now };

    const lagSeq = Math.max(0, stats.seq - this.mgr.lastSeqNum);
    const hb = this.mgr.heartbeat?.hb;

    const breakdown: LatencyBreakdown = {
      offsetMs: Math.round(offsetMs),
      rttMs,
      ingestLagMs: stats.newest_ts > 0 ? stats.now - stats.newest_ts : 0,
      lagSeq,
      lagMs: Math.round((lagSeq / this.seqRate) * 1000),
      lossPct: hb?.lossPct ?? 0,
      lostTotal: hb?.lost ?? 0,
      lastRecvAgoMs: hb?.lastRecvAgoMs ?? -1,
      leaseOk: hb?.leaseOk ?? false,
      seqRate: Math.round(this.seqRate * 10) / 10,
      udpSubscribers: stats.udp_subscribers ?? 0,
      writeMaxMs: stats.write_ms?.maxMs ?? 0,
    };

    this.latest = breakdown;
    this.onUpdate?.(breakdown);
    return breakdown;
  }

  start(periodMs = 2000): () => void {
    void this.sample();
    const timer = setInterval(() => void this.sample(), periodMs);
    return () => clearInterval(timer);
  }
}

/** One-line summary for the console, ordered as the data actually flows. */
export function formatBreakdown(b: LatencyBreakdown): string {
  return [
    `ingest ${b.ingestLagMs}ms`,
    `lag ${b.lagMs}ms (${b.lagSeq} seq @ ${b.seqRate}/s)`,
    `loss ${b.lossPct}% (${b.lostTotal} total)`,
    `lastrx ${b.lastRecvAgoMs}ms`,
    `lease ${b.leaseOk ? "ok" : "DOWN"}`,
    `offset ${b.offsetMs}ms`,
    `rtt ${b.rttMs}ms`,
    `subs ${b.udpSubscribers}`,
    `diskmax ${b.writeMaxMs}ms`,
  ].join("  ");
}
