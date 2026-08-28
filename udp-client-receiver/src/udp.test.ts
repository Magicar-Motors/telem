import { describe, it, expect, beforeEach } from "vitest";
import { pack } from "msgpackr";
import { UdpReceiver, type Tick } from "./udp.js";

function tick(seq: number, d: Record<string, unknown> = { rpm: 1000 }): Buffer {
  return pack({ seq, ts: 1_700_000_000_000 + seq * 40, d });
}

describe("UdpReceiver", () => {
  let rx: UdpReceiver;
  let emitted: Tick[];

  beforeEach(() => {
    rx = new UdpReceiver();
    emitted = [];
    rx.on("tick", (t: Tick) => emitted.push(t));
  });

  it("passes an in-order run through with no loss", () => {
    for (let seq = 1; seq <= 5; seq++) rx.handle(tick(seq));
    expect(rx.stats.received).toBe(5);
    expect(rx.stats.lost).toBe(0);
    expect(emitted.map((t) => t.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts a gap as loss without stalling the feed", () => {
    rx.handle(tick(1));
    rx.handle(tick(5)); // 2,3,4 never arrived
    expect(rx.stats.lost).toBe(3);
    expect(rx.stats.received).toBe(2);
    // Crucially it delivers seq 5 rather than waiting for the missing ones.
    expect(emitted.map((t) => t.seq)).toEqual([1, 5]);
  });

  it("does not count the first datagram's seq as loss", () => {
    // The car has been running for a while before we subscribe.
    rx.handle(tick(9000));
    expect(rx.stats.lost).toBe(0);
    expect(rx.stats.received).toBe(1);
  });

  it("discards stale and duplicate datagrams", () => {
    rx.handle(tick(10));
    rx.handle(tick(9)); // reordered, arrived late
    rx.handle(tick(10)); // duplicate
    expect(rx.stats.reordered).toBe(2);
    expect(rx.stats.received).toBe(1);
    expect(emitted.map((t) => t.seq)).toEqual([10]);
  });

  it("keeps the high-water mark after a reorder", () => {
    rx.handle(tick(10));
    rx.handle(tick(9));
    rx.handle(tick(11));
    expect(rx.stats.lastSeq).toBe(11);
    expect(rx.stats.lost).toBe(0);
  });

  it("counts malformed payloads without throwing", () => {
    rx.handle(Buffer.from("not msgpack at all"));
    rx.handle(pack({ nope: true }));
    expect(rx.stats.malformed).toBe(2);
    expect(rx.stats.received).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it("reports loss as a percentage of the window", () => {
    rx.handle(tick(1));
    rx.handle(tick(2));
    rx.handle(tick(4)); // one lost
    // 3 received, 1 lost → 25%
    expect(rx.stats.lossPct).toBe(25);
  });

  it("tracks the newest tick's timestamp for staleness checks", () => {
    rx.handle(tick(1));
    rx.handle(tick(2));
    expect(rx.stats.lastTs).toBe(1_700_000_000_000 + 2 * 40);
    expect(rx.stats.lastRecvAt).toBeGreaterThan(0);
  });

  it("re-anchors when the car's seq counter restarts", () => {
    // The car ran to 7.2M, its WAL came up without recovering that mark, and it
    // began numbering from zero again. Without this the feed dies silently:
    // every new datagram reads as stale and lands in `reordered` forever.
    rx.handle(pack({ seq: 7_280_077, ts: 1_800_000_000_000, d: { rpm: 1000 } }));
    rx.handle(pack({ seq: 1, ts: 1_800_000_000_040, d: { rpm: 1100 } }));
    rx.handle(pack({ seq: 2, ts: 1_800_000_000_080, d: { rpm: 1200 } }));

    expect(emitted.map((t) => t.seq)).toEqual([7_280_077, 1, 2]);
    expect(rx.stats.resets).toBe(1);
    expect(rx.stats.lastSeq).toBe(2);
    // Re-anchoring must not book the 7.2M seq drop as loss.
    expect(rx.stats.lost).toBe(0);
  });

  it("still discards a plain reorder rather than treating it as a reset", () => {
    rx.handle(pack({ seq: 500, ts: 1_800_000_000_000, d: { rpm: 1000 } }));
    rx.handle(pack({ seq: 499, ts: 1_800_000_000_040, d: { rpm: 1100 } }));
    expect(rx.stats.reordered).toBe(1);
    expect(rx.stats.resets).toBe(0);
    expect(emitted.map((t) => t.seq)).toEqual([500]);
  });

  it("does not re-anchor on an old datagram arriving very late", () => {
    // Far enough back to clear the gap, but its ts is older — that's a straggler
    // from before, not a restart.
    rx.handle(pack({ seq: 50_000, ts: 1_800_000_000_000, d: { rpm: 1000 } }));
    rx.handle(pack({ seq: 10, ts: 1_799_999_000_000, d: { rpm: 1100 } }));
    expect(rx.stats.resets).toBe(0);
    expect(rx.stats.reordered).toBe(1);
    expect(emitted.map((t) => t.seq)).toEqual([50_000]);
  });

  it("drops datagrams when the test hook is on", () => {
    const dropping = new UdpReceiver({ testDropPct: 100 });
    for (let seq = 1; seq <= 10; seq++) dropping.handle(tick(seq));
    expect(dropping.stats.received).toBe(0);
  });
});
