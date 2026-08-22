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

  it("drops datagrams when the test hook is on", () => {
    const dropping = new UdpReceiver({ testDropPct: 100 });
    for (let seq = 1; seq <= 10; seq++) dropping.handle(tick(seq));
    expect(dropping.stats.received).toBe(0);
  });
});
