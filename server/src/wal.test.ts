import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WalEngine, WalEntry } from "./wal.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wal-test-"));
}

describe("WalEngine", () => {
  let dataDir: string;
  let wal: WalEngine;

  beforeEach(async () => {
    dataDir = tmpDir();
    wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
    await wal.init();
  });

  afterEach(() => {
    wal.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe("append", () => {
    it("assigns incrementing seq numbers", () => {
      const [a] = wal.append({ channel: "speed", value: 100 });
      const [b] = wal.append({ channel: "speed", value: 200 });
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
    });

    it("uses provided ts or defaults to now", () => {
      const [a] = wal.append({ channel: "speed", value: 100, ts: 1234567890 });
      expect(a.ts).toBe(1234567890);

      const before = Date.now();
      const [b] = wal.append({ channel: "speed", value: 200 });
      expect(b.ts).toBeGreaterThanOrEqual(before);
      expect(b.ts).toBeLessThanOrEqual(Date.now());
    });

    it("stores value of any type", () => {
      wal.append({ channel: "gps", value: { lat: 37.7, lon: -122.4 } });
      wal.append({ channel: "flag", value: true });
      wal.append({ channel: "label", value: "pit-in" });

      expect(wal.queryByChannel("gps")[0].value).toEqual({ lat: 37.7, lon: -122.4 });
      expect(wal.queryByChannel("flag")[0].value).toBe(true);
      expect(wal.queryByChannel("label")[0].value).toBe("pit-in");
    });

    it("emits entry event on append", () => {
      const received: WalEntry[] = [];
      wal.on("entry", (e: WalEntry) => received.push(e));

      wal.append({ channel: "speed", value: 100 });
      wal.append({ channel: "rpm", value: 8000 });

      expect(received).toHaveLength(2);
      expect(received[0].channel).toBe("speed");
      expect(received[1].channel).toBe("rpm");
    });

    it("updates currentSeq and totalEntries", () => {
      expect(wal.currentSeq).toBe(0);
      expect(wal.totalEntries).toBe(0);

      wal.append({ channel: "speed", value: 1 });
      wal.append({ channel: "speed", value: 2 });

      expect(wal.currentSeq).toBe(2);
      expect(wal.totalEntries).toBe(2);
    });
  });

  describe("appendBatch", () => {
    it("appends multiple entries with shared batch seq", () => {
      const entries = wal.append(
        { channel: "speed", value: 100 },
        { channel: "rpm", value: 8000 },
        { channel: "speed", value: 105 },
      );

      expect(entries).toHaveLength(3);
      // All entries in a batch share the same seq
      expect(entries[0].seq).toBe(1);
      expect(entries[1].seq).toBe(1);
      expect(entries[2].seq).toBe(1);
      expect(wal.currentSeq).toBe(1);
    });

    it("emits entry events for each item in batch", () => {
      const received: WalEntry[] = [];
      wal.on("entry", (e: WalEntry) => received.push(e));

      wal.append(
        { channel: "a", value: 1 },
        { channel: "b", value: 2 },
      );

      expect(received).toHaveLength(2);
    });
  });

  describe("WAL file persistence", () => {
    it("writes compact JSON lines to wal file", () => {
      wal.append({ channel: "speed", value: 100 });
      wal.append({ channel: "rpm", value: 8000 });
      wal.close();

      const walFile = path.join(dataDir, "wal", "wal.000001.log");
      const content = fs.readFileSync(walFile, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.seq).toBe(1);
      expect(parsed.d.speed).toBe(100);
    });

    it("batch append writes one multi-channel line on disk", () => {
      wal.append(
        { channel: "speed", value: 100 },
        { channel: "rpm", value: 8000 },
        { channel: "throttle", value: 42 },
      );
      wal.close();

      const walFile = path.join(dataDir, "wal", "wal.000001.log");
      const content = fs.readFileSync(walFile, "utf-8");
      const lines = content.trim().split("\n");

      // Single batch → single line on disk
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.seq).toBe(1);
      expect(parsed.d).toEqual({ speed: 100, rpm: 8000, throttle: 42 });
    });

    it("batch append round-trips as one merged tick via getTicksInRange", async () => {
      wal.append(
        { channel: "gps_lat", value: 38.16 },
        { channel: "gps_lon", value: -122.45 },
        { channel: "gps_speed", value: 100 },
      );
      wal.append(
        { channel: "gps_lat", value: 38.17 },
        { channel: "gps_lon", value: -122.44 },
      );

      const ticks = await wal.getTicksInRange(1, 2);
      expect(ticks).toHaveLength(2);

      // First tick has all 3 channels merged
      expect(ticks[0].seq).toBe(1);
      expect(ticks[0].d).toEqual({ gps_lat: 38.16, gps_lon: -122.45, gps_speed: 100 });

      // Second tick has 2 channels
      expect(ticks[1].seq).toBe(2);
      expect(ticks[1].d).toEqual({ gps_lat: 38.17, gps_lon: -122.44 });
    });

    it("batch append recovers merged ticks after restart", async () => {
      wal.append(
        { channel: "speed", value: 100 },
        { channel: "rpm", value: 8000 },
      );
      wal.append(
        { channel: "speed", value: 110 },
        { channel: "rpm", value: 8500 },
      );
      wal.close();

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();

      const ticks = await wal2.getTicksInRange(1, 2);
      expect(ticks).toHaveLength(2);
      expect(ticks[0].d).toEqual({ speed: 100, rpm: 8000 });
      expect(ticks[1].d).toEqual({ speed: 110, rpm: 8500 });

      wal2.close();
    });
  });

  describe("recovery", () => {
    it("recovers seq on restart", async () => {
      wal.append({ channel: "speed", value: 100 });
      wal.append({ channel: "rpm", value: 8000 });
      wal.append({ channel: "speed", value: 110 });
      wal.close();

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();

      expect(wal2.currentSeq).toBe(3);

      // Data is on disk, queryable via getTicksInRange
      const ticks = await wal2.getTicksInRange(1, 3);
      expect(ticks).toHaveLength(3);

      // byChannel is empty on cold start (no replay)
      expect(wal2.getChannels()).toEqual([]);

      wal2.close();
    });

    it("continues seq numbering after restart", async () => {
      wal.append({ channel: "speed", value: 100 });
      wal.close();

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();
      const [entry] = wal2.append({ channel: "speed", value: 200 });

      expect(entry.seq).toBe(2);
      wal2.close();
    });

    it("keeps numbering monotonic when the newest generation is empty", async () => {
      // What a roll-then-restart looks like on disk: the previous generation
      // holds the high-water mark, the current one has nothing to scan yet.
      // Restarting numbering here is what reset seq to 0 under generation 1466
      // on 2026-08-23 — every ground station then rejected the feed as stale.
      wal.append({ channel: "speed", value: 100 });
      wal.append({ channel: "speed", value: 110 });
      wal.close();

      fs.writeFileSync(path.join(dataDir, "wal", "wal.000002.log"), "");

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();

      expect(wal2.currentSeq).toBe(2);
      const [entry] = wal2.append({ channel: "speed", value: 120 });
      expect(entry.seq).toBe(3);
      wal2.close();
    });

    it("keeps numbering monotonic when the newest generation is truncated", async () => {
      wal.append({ channel: "speed", value: 100 });
      wal.append({ channel: "speed", value: 110 });
      wal.close();

      // An unclean shutdown can leave the newest file with nothing parseable.
      fs.writeFileSync(path.join(dataDir, "wal", "wal.000002.log"), "{ partial lin");

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();

      expect(wal2.currentSeq).toBe(2);
      wal2.close();
    });

    it("handles corrupt WAL lines gracefully", async () => {
      wal.append({ channel: "speed", value: 100 });
      wal.close();

      // inject corrupt line
      const walFile = path.join(dataDir, "wal", "wal.000001.log");
      fs.appendFileSync(walFile, "NOT VALID JSON\n");
      fs.appendFileSync(walFile, JSON.stringify({ seq: 2, ts: Date.now(), d: { rpm: 5000 } }) + "\n");

      const wal2 = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal2.init();

      expect(wal2.currentSeq).toBe(2);
      wal2.close();
    });
  });

  describe("generation rotation", () => {
    it("rotates WAL generation at threshold", async () => {
      const smallWal = new WalEngine({ dataDir: tmpDir(), snapshotThreshold: 5, fsyncBatchSize: 100 });
      const smallDir = (smallWal as any).config.dataDir;
      await smallWal.init();

      for (let i = 0; i < 6; i++) {
        smallWal.append({ channel: "ch", value: i });
      }

      expect(smallWal.currentGeneration).toBe(2);

      const walFiles = fs.readdirSync(path.join(smallDir, "wal")).sort();
      expect(walFiles).toContain("wal.000001.log");
      expect(walFiles).toContain("wal.000002.log");

      smallWal.close();
      fs.rmSync(smallDir, { recursive: true, force: true });
    });

    it("recovers correctly from snapshot + WAL replay", async () => {
      const dir = tmpDir();
      const w1 = new WalEngine({ dataDir: dir, snapshotThreshold: 3, fsyncBatchSize: 100 });
      await w1.init();

      // 5 entries: snapshot after 3, gen2 gets entries 4-5
      for (let i = 1; i <= 5; i++) {
        w1.append({ channel: "ch", value: i * 10 });
      }
      w1.close();

      // recover
      const w2 = new WalEngine({ dataDir: dir, snapshotThreshold: 3, fsyncBatchSize: 100 });
      await w2.init();

      expect(w2.currentSeq).toBe(5);

      const ticks = await w2.getTicksInRange(1, 5);
      expect(ticks).toHaveLength(5);

      w2.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("queries", () => {
    beforeEach(() => {
      wal.append({ channel: "speed", value: 100, ts: 1000 });
      wal.append({ channel: "rpm", value: 8000, ts: 1001 });
      wal.append({ channel: "speed", value: 110, ts: 1002 });
      wal.append({ channel: "rpm", value: 8500, ts: 1003 });
      wal.append({ channel: "speed", value: 120, ts: 1004 });
      wal.append({ channel: "gps", value: { lat: 1 }, ts: 1005 });
    });

    it("getChannels returns all known channels", () => {
      expect(wal.getChannels().sort()).toEqual(["gps", "rpm", "speed"]);
    });

    it("getChannelCounts returns per-channel counts", () => {
      expect(wal.getChannelCounts()).toEqual({ speed: 3, rpm: 2, gps: 1 });
    });

    it("queryByChannel returns all entries for a channel", () => {
      const results = wal.queryByChannel("speed");
      expect(results).toHaveLength(3);
      expect(results.map((e) => e.value)).toEqual([100, 110, 120]);
    });

    it("queryByChannel filters by startTs and endTs", () => {
      const results = wal.queryByChannel("speed", { startTs: 1001, endTs: 1003 });
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe(110);
    });

    it("queryByChannel respects afterSeq with binary search", () => {
      const results = wal.queryByChannel("speed", { afterSeq: 3 });
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe(120);
      expect(results[0].seq).toBe(5);
    });

    it("queryByChannel respects limit", () => {
      const results = wal.queryByChannel("speed", { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("queryByChannel returns empty for unknown channel", () => {
      expect(wal.queryByChannel("nonexistent")).toEqual([]);
    });

    it("getTicksInRange returns ticks in seq range", async () => {
      const ticks = await wal.getTicksInRange(2, 4);
      expect(ticks).toHaveLength(3);
      expect(ticks[0].seq).toBe(2);
      expect(ticks[2].seq).toBe(4);
    });

    it("getTicksInRange filters by channel", async () => {
      const ticks = await wal.getTicksInRange(1, 6, new Set(["rpm"]));
      expect(ticks.length).toBeGreaterThan(0);
      for (const t of ticks) expect("rpm" in t.d).toBe(true);
    });
  });

  describe("nuke", () => {
    it("clears all data and resets state", async () => {
      wal.append({ channel: "speed", value: 100 });
      wal.append({ channel: "rpm", value: 8000 });
      expect(wal.currentSeq).toBe(2);
      expect(wal.totalEntries).toBe(2);

      await wal.nuke();

      expect(wal.currentSeq).toBe(0);
      expect(wal.totalEntries).toBe(0);
      expect(wal.getChannels()).toEqual([]);
    });

    it("allows new appends after nuke", async () => {
      wal.append({ channel: "speed", value: 100 });
      await wal.nuke();

      const [entry] = wal.append({ channel: "rpm", value: 5000 });
      expect(entry.seq).toBe(1);
      expect(wal.totalEntries).toBe(1);
    });

    it("removes WAL files", async () => {
      wal.append({ channel: "speed", value: 100 });
      wal.close();

      const walFiles = fs.readdirSync(path.join(dataDir, "wal"));
      expect(walFiles.length).toBeGreaterThan(0);

      wal = new WalEngine({ dataDir, snapshotThreshold: 50_000, fsyncBatchSize: 10 });
      await wal.init();
      await wal.nuke();

      // fresh WAL file created by init, but no old data
      expect(wal.totalEntries).toBe(0);
    });
  });

  describe("compact", () => {
    it("merges single-channel lines with same timestamp into one tick", async () => {
      const ts = 1000000;
      // Simulate old per-channel ingestion (separate appends, same ts)
      wal.append({ channel: "gps_lat", value: 38.16, ts });
      wal.append({ channel: "gps_lon", value: -122.45, ts });
      wal.append({ channel: "gps_speed", value: 100, ts });

      await wal.compact();

      const ticks = await wal.getTicksInRange(1, 100);
      expect(ticks).toHaveLength(1);
      expect(ticks[0].d).toEqual({ gps_lat: 38.16, gps_lon: -122.45, gps_speed: 100 });
    });

    it("merges lines within 50ms into one tick", async () => {
      wal.append({ channel: "gps_lat", value: 38.16, ts: 1000000 });
      wal.append({ channel: "rpm", value: 3000, ts: 1000030 }); // +30ms, same bucket
      wal.append({ channel: "speed", value: 80, ts: 1000100 });  // +100ms, different bucket

      await wal.compact();

      const ticks = await wal.getTicksInRange(1, 100);
      expect(ticks).toHaveLength(2);
      expect(ticks[0].d).toEqual({ gps_lat: 38.16, rpm: 3000 });
      expect(ticks[1].d).toEqual({ speed: 80 });
    });

    it("reassigns sequential seq numbers", async () => {
      wal.append({ channel: "a", value: 1, ts: 1000 });
      wal.append({ channel: "b", value: 2, ts: 1000 });
      wal.append({ channel: "c", value: 3, ts: 2000 });

      await wal.compact();

      const ticks = await wal.getTicksInRange(1, 100);
      expect(ticks).toHaveLength(2);
      expect(ticks[0].seq).toBe(1);
      expect(ticks[1].seq).toBe(2);
    });

    it("splits output files at snapshotThreshold", async () => {
      wal.close();
      fs.rmSync(dataDir, { recursive: true, force: true });

      dataDir = tmpDir();
      wal = new WalEngine({ dataDir, snapshotThreshold: 3, fsyncBatchSize: 10 });
      await wal.init();

      // 5 distinct timestamps → 5 ticks → should split into 2 files (3 + 2)
      for (let i = 0; i < 5; i++) {
        wal.append({ channel: "ch", value: i, ts: (i + 1) * 1000 });
      }

      await wal.compact();

      const walFiles = fs.readdirSync(path.join(dataDir, "wal")).filter((f) => f.startsWith("wal."));
      expect(walFiles.length).toBe(2);

      const ticks = await wal.getTicksInRange(1, 10);
      expect(ticks).toHaveLength(5);
    });

    it("writes range footers on each file", async () => {
      wal.close();
      fs.rmSync(dataDir, { recursive: true, force: true });

      dataDir = tmpDir();
      wal = new WalEngine({ dataDir, snapshotThreshold: 2, fsyncBatchSize: 10 });
      await wal.init();

      for (let i = 0; i < 4; i++) {
        wal.append({ channel: "ch", value: i, ts: (i + 1) * 1000 });
      }

      await wal.compact();

      const walDir = path.join(dataDir, "wal");
      const files = fs.readdirSync(walDir).filter((f) => f.startsWith("wal.")).sort();
      for (const file of files) {
        const content = fs.readFileSync(path.join(walDir, file), "utf-8");
        const lines = content.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        expect(lastLine).toMatch(/^#range:\d+,\d+$/);
      }
    });

    it("later-channel values win on merge", async () => {
      // If same channel appears twice in the same 50ms bucket, last write wins
      wal.append({ channel: "speed", value: 50, ts: 1000000 });
      wal.append({ channel: "speed", value: 75, ts: 1000010 });

      await wal.compact();

      const ticks = await wal.getTicksInRange(1, 100);
      expect(ticks).toHaveLength(1);
      expect(ticks[0].d.speed).toBe(75);
    });

    it("preserves data across multiple generations", async () => {
      wal.close();
      fs.rmSync(dataDir, { recursive: true, force: true });

      dataDir = tmpDir();
      wal = new WalEngine({ dataDir, snapshotThreshold: 3, fsyncBatchSize: 10 });
      await wal.init();

      // Write enough to trigger rotation, with mergeable timestamps
      for (let i = 0; i < 10; i++) {
        wal.append({ channel: "ch", value: i, ts: (i + 1) * 1000 });
      }

      await wal.compact();

      const ticks = await wal.getTicksInRange(1, 20);
      expect(ticks).toHaveLength(10);
      expect(ticks[0].d.ch).toBe(0);
      expect(ticks[9].d.ch).toBe(9);
    });
  });
});
