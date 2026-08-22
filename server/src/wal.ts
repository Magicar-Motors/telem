import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

/** Per-channel entry — used internally for channel ring buffers + SSE events */
export interface WalEntry {
  seq: number;
  ts: number;
  channel: string;
  value: unknown;
}

/** Primary format — one tick per ingest, all channels merged. Matches disk format. */
export interface WalTick {
  seq: number;
  ts: number;
  d: Record<string, unknown>;
}

/** Disk format — can be single-channel (legacy) or multi-channel (compact) */
interface WalLine {
  seq: number;
  ts: number;
  channel?: string;  // single-channel (legacy)
  value?: unknown;   // single-channel (legacy)
  d?: Record<string, unknown>; // multi-channel (compact)
}

export interface WalConfig {
  dataDir: string;
  snapshotThreshold: number;
  fsyncBatchSize: number;
}

const WAL_DIR = "wal";
const LOCK_FILE = "wal.lock";
const MAX_CHANNEL_ENTRIES = 6000;

function walFileName(gen: number): string {
  return `wal.${String(gen).padStart(6, "0")}.log`;
}

/** Explode a disk line into one or more WalEntry objects */
function explodeLine(line: WalLine): WalEntry[] {
  if (line.d) {
    // Multi-channel compact format
    return Object.entries(line.d).map(([channel, value]) => ({
      seq: line.seq, ts: line.ts, channel, value,
    }));
  }
  if (line.channel !== undefined && line.value !== undefined) {
    // Legacy single-channel format
    return [{ seq: line.seq, ts: line.ts, channel: line.channel, value: line.value }];
  }
  return [];
}

/** Parse a WAL line from disk, returns individual entries */
function parseLine(raw: string): WalEntry[] {
  if (raw.length === 0 || raw.startsWith("#")) return [];
  try {
    return explodeLine(JSON.parse(raw) as WalLine);
  } catch { return []; }
}

/** Parse a WAL line into a WalTick (no explosion) */
function parseTickLine(raw: string): WalTick | null {
  if (raw.length === 0 || raw.startsWith("#")) return null;
  try {
    const line = JSON.parse(raw) as WalLine;
    if (line.d) return { seq: line.seq, ts: line.ts, d: line.d };
    // Legacy single-channel → wrap into d
    if (line.channel !== undefined && line.value !== undefined) {
      return { seq: line.seq, ts: line.ts, d: { [line.channel]: line.value } };
    }
    return null;
  } catch { return null; }
}

interface FileRange {
  file: string;
  minSeq: number;
  maxSeq: number;
}

export class WalEngine extends EventEmitter {
  private config: WalConfig;
  private seq = 0;
  private lastTs = 0;
  private generation = 1;
  private entriesInGeneration = 0;
  private fd: number | null = null;
  private pendingWrites = 0;
  private entryCount = 0;

  private byChannel = new Map<string, WalEntry[]>();

  private walDir: string;
  private maxWriteMs = 0;
  private totalWriteMs = 0;
  private writeSamples = 0;
  private snapshotting = false;
  private _compacting = false;
  private fileRanges: FileRange[] = [];

  constructor(config: WalConfig) {
    super();
    this.config = config;
    this.walDir = path.join(config.dataDir, WAL_DIR);
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.walDir, { recursive: true });

    // Clean up partial compaction / legacy snapshots
    const tmpDir = path.join(this.walDir, "_compact_tmp");
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
    const snapDir = path.join(this.config.dataDir, "snapshots");
    try { await fs.promises.rm(snapDir, { recursive: true, force: true }); } catch {}

    await this.findSeqAndGeneration();
    await this.buildFileRangeIndex();

    // Estimate total entries from file range index
    for (const fr of this.fileRanges) {
      this.entryCount += fr.maxSeq - fr.minSeq + 1;
    }

    this.openGeneration(this.generation);
  }

  /** Build in-memory index of seq ranges per WAL file */
  private async buildFileRangeIndex(): Promise<void> {
    this.fileRanges = [];
    const files = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();
    for (const file of files) {
      const range = await this.readFileRange(path.join(this.walDir, file));
      if (range) {
        this.fileRanges.push({ file, ...range });
      } else {
        // No range footer (active/unfinished file) — scan for min/max seq
        const content = await fs.promises.readFile(path.join(this.walDir, file), "utf-8");
        let minSeq = Infinity, maxSeq = -1;
        for (const raw of content.split("\n")) {
          const tick = parseTickLine(raw);
          if (!tick) continue;
          if (tick.seq < minSeq) minSeq = tick.seq;
          if (tick.seq > maxSeq) maxSeq = tick.seq;
        }
        if (maxSeq >= 0) this.fileRanges.push({ file, minSeq, maxSeq });
      }
    }
  }

  /** Fast startup: find generation from filenames, max seq from last file only */
  private async findSeqAndGeneration(): Promise<void> {
    const files = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();
    if (files.length === 0) return;

    const match = files[files.length - 1].match(/wal\.(\d+)\.log/);
    if (match) this.generation = parseInt(match[1], 10);

    // Only scan last file for max seq
    const lastFile = path.join(this.walDir, files[files.length - 1]);
    const content = await fs.promises.readFile(lastFile, "utf-8");
    let lineCount = 0;
    for (const raw of content.split("\n")) {
      if (raw.length === 0 || raw.startsWith("#")) continue;
      lineCount++;
      const tick = parseTickLine(raw);
      if (tick && tick.seq > this.seq) this.seq = tick.seq;
    }
    this.entriesInGeneration = lineCount;
  }

  // ── Write path (sync for durability) ──

  private openGeneration(gen: number): void {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
    }
    this.generation = gen;
    this.fd = fs.openSync(path.join(this.walDir, walFileName(gen)), "a");
    this.pendingWrites = 0;
  }

  append(...items: Array<{ channel: string; value: unknown; ts?: number }>): WalEntry[] {
    const batchSeq = ++this.seq;
    const ts = items[0]?.ts ?? Date.now();
    const entries: WalEntry[] = [];

    const d: Record<string, unknown> = {};
    for (const item of items) {
      const entry: WalEntry = {
        seq: batchSeq,
        ts: item.ts ?? ts,
        channel: item.channel,
        value: item.value,
      };
      entries.push(entry);
      d[item.channel] = item.value;
      this.indexLive(entry);
      this.entryCount++;
    }

    const line: WalLine = { seq: batchSeq, ts, d };
    const writeStart = Date.now();
    fs.writeSync(this.fd!, Buffer.from(JSON.stringify(line) + "\n"));
    this.entriesInGeneration++;
    this.lastTs = ts;

    // Update in-memory range index for current file
    const curFile = walFileName(this.generation);
    const curRange = this.fileRanges.find((r) => r.file === curFile);
    if (curRange) {
      if (batchSeq > curRange.maxSeq) curRange.maxSeq = batchSeq;
    } else {
      this.fileRanges.push({ file: curFile, minSeq: batchSeq, maxSeq: batchSeq });
    }
    this.pendingWrites++;

    if (this.pendingWrites >= this.config.fsyncBatchSize) {
      fs.fsyncSync(this.fd!);
      this.pendingWrites = 0;
    }

    // writeSync + fsyncSync both block the event loop, so a slow disk stalls SSE
    // delivery for every connected client. Track the worst case to rule it in or out.
    const writeMs = Date.now() - writeStart;
    if (writeMs > this.maxWriteMs) this.maxWriteMs = writeMs;
    this.totalWriteMs += writeMs;
    this.writeSamples++;

    for (const entry of entries) this.emit("entry", entry);

    // The merged form the batch arrived in, and the shape written to disk. The UDP
    // sender takes this rather than the exploded entries — one datagram per tick.
    this.emit("tick", { seq: batchSeq, ts, d } satisfies WalTick);

    if (this.entriesInGeneration >= this.config.snapshotThreshold && !this.snapshotting) {
      this.rotateGeneration();
    }

    return entries;
  }

  private indexLive(entry: WalEntry): void {
    let arr = this.byChannel.get(entry.channel);
    if (!arr) { arr = []; this.byChannel.set(entry.channel, arr); }
    arr.push(entry);
    if (arr.length > MAX_CHANNEL_ENTRIES) arr.shift();
  }

  private rotateGeneration(): void {
    this.snapshotting = true;

    // Write range footer for the completed file and update index
    const curFile = walFileName(this.generation);
    const curRange = this.fileRanges.find((r) => r.file === curFile);
    if (curRange) {
      fs.writeSync(this.fd!, Buffer.from(`#range:${curRange.minSeq},${curRange.maxSeq}\n`));
    }

    fs.fsyncSync(this.fd!);
    this.pendingWrites = 0;
    this.openGeneration(this.generation + 1);
    this.entriesInGeneration = 0;
    this.snapshotting = false;
  }

  // ── Read path (async) ──

  getChannels(): string[] {
    return Array.from(this.byChannel.keys());
  }

  getChannelCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [ch, arr] of this.byChannel) counts[ch] = arr.length;
    return counts;
  }

  queryByChannel(
    channel: string,
    opts: { startTs?: number; endTs?: number; afterSeq?: number; limit?: number } = {},
  ): WalEntry[] {
    const arr = this.byChannel.get(channel);
    if (!arr) return [];
    const limit = opts.limit ?? 10_000;
    let startIdx = 0;
    if (opts.afterSeq != null) startIdx = this.binarySearchAfterSeq(arr, opts.afterSeq);

    const result: WalEntry[] = [];
    for (let i = startIdx; i < arr.length && result.length < limit; i++) {
      const e = arr[i];
      if (opts.startTs != null && e.ts < opts.startTs) continue;
      if (opts.endTs != null && e.ts > opts.endTs) continue;
      result.push(e);
    }
    return result;
  }

  /** Stream raw NDJSON lines in seq range. Zero serialization — pipes disk lines directly. */
  async streamTicksInRange(
    startSeq: number, endSeq: number,
    onLine: (raw: string) => void,
  ): Promise<number> {
    const candidateFiles = this.getCandidateFiles(startSeq, endSeq);
    let count = 0;

    for (const file of candidateFiles) {
      const filePath = path.join(this.walDir, file);
      const content = await fs.promises.readFile(filePath, "utf-8");
      for (const raw of content.split("\n")) {
        if (raw.length === 0 || raw.startsWith("#")) continue;
        // Fast seq extraction without full JSON parse: {"seq":N,...
        const seqEnd = raw.indexOf(",", 7);
        const seq = parseInt(raw.slice(7, seqEnd), 10);
        if (isNaN(seq)) continue;
        if (seq < startSeq) continue;
        if (seq > endSeq) return count;
        onLine(raw);
        count++;
      }
    }
    return count;
  }

  private getCandidateFiles(startSeq: number, endSeq: number): string[] {
    const candidateFiles: string[] = [];
    for (const fr of this.fileRanges) {
      if (fr.maxSeq < startSeq) continue;
      if (fr.minSeq > endSeq) break;
      candidateFiles.push(fr.file);
    }
    return candidateFiles;
  }

  /** Return batched ticks in range — no per-channel explosion, fast for bulk replay */
  async getTicksInRange(startSeq: number, endSeq: number, channels?: Set<string>): Promise<WalTick[]> {
    const result: WalTick[] = [];
    await this.streamTicksInRange(startSeq, endSeq, (line) => {
      const tick = parseTickLine(line);
      if (!tick) return;
      if (channels) {
        const filtered: Record<string, unknown> = {};
        let hasAny = false;
        for (const ch of channels) {
          if (ch in tick.d) { filtered[ch] = tick.d[ch]; hasAny = true; }
        }
        if (hasAny) result.push({ seq: tick.seq, ts: tick.ts, d: filtered });
      } else {
        result.push(tick);
      }
    });
    return result;
  }


  private async readFileRange(filePath: string): Promise<{ minSeq: number; maxSeq: number } | null> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size === 0) return null;
      const readSize = Math.min(200, stat.size);
      const buf = Buffer.alloc(readSize);
      const fh = await fs.promises.open(filePath, "r");
      await fh.read(buf, 0, readSize, stat.size - readSize);
      await fh.close();
      const tail = buf.toString("utf-8");
      for (const line of tail.split("\n").reverse()) {
        if (line.startsWith("#range:")) {
          const parts = line.slice(7).split(",");
          return { minSeq: parseInt(parts[0], 10), maxSeq: parseInt(parts[1], 10) };
        }
        if (line.length > 0 && !line.startsWith("#")) break;
      }
    } catch {}
    return null;
  }

  private binarySearchAfterSeq(arr: WalEntry[], targetSeq: number): number {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].seq <= targetSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get currentSeq(): number { return this.seq; }
  /** ts on the most recent append — how fresh the newest data on disk is. */
  get newestTs(): number { return this.lastTs; }

  /** Blocking disk time per append. Resets each read so /stats shows a fresh window. */
  takeWriteStats(): { maxMs: number; avgMs: number; samples: number } {
    const stats = {
      maxMs: this.maxWriteMs,
      avgMs: this.writeSamples > 0 ? this.totalWriteMs / this.writeSamples : 0,
      samples: this.writeSamples,
    };
    this.maxWriteMs = 0;
    this.totalWriteMs = 0;
    this.writeSamples = 0;
    return stats;
  }
  get currentGeneration(): number { return this.generation; }
  get totalEntries(): number { return this.entryCount; }
  get compacting(): boolean { return this._compacting; }

  // ── Maintenance ──

  async compact(): Promise<{ oldFiles: number; oldEntries: number; newEntries: number; newSeq: number; sessionsRepaired: number }> {
    this._compacting = true;
    this.close(); // releases existing lock
    await this.acquireLock(`compact pid ${process.pid}`);

    let result: { oldFiles: number; oldEntries: number; newEntries: number; newSeq: number; sessionsRepaired: number };
    try {
      result = await this._compact();
    } finally {
      this.releaseLock();
    }

    // Re-init with fresh lock, then repair sessions
    this.byChannel.clear();
    this.seq = 0;
    this.generation = 1;
    this.entriesInGeneration = 0;
    this.entryCount = 0;
    await this.init();

    result.sessionsRepaired = await this.repairSessions();
    this._compacting = false;

    return result;
  }

  private async _compact(): Promise<{ oldFiles: number; oldEntries: number; newEntries: number; newSeq: number; sessionsRepaired: number }> {
    const snapDir = path.join(this.config.dataDir, "snapshots");
    try { await fs.promises.rm(snapDir, { recursive: true, force: true }); } catch {}

    const files = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();
    const oldFileCount = files.length;

    const tmpDir = path.join(this.walDir, "_compact_tmp");
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const maxPerFile = this.config.snapshotThreshold;
    const WRITE_BUF_SIZE = 8192;
    let newSeq = 0, lastTs = -1;
    let gen = 1, lineCount = 0;
    let oldEntryCount = 0, newEntryCount = 0;
    let fileMinSeq = Infinity, fileMaxSeq = -1;
    let fh = await fs.promises.open(path.join(tmpDir, walFileName(gen)), "w");
    let writeBuf = "";

    const tsToSeq = new Map<number, number>();
    const oldToNewSeq = new Map<number, number>();

    async function flushBuf() {
      if (writeBuf.length > 0) { await fh.write(writeBuf); writeBuf = ""; }
    }

    // Accumulator for merging same-ts lines into one compact tick
    let pendingD: Record<string, unknown> = {};
    let pendingTs = -1;
    let pendingSeq = 0;

    const writeTick = async () => {
      if (pendingTs < 0 || Object.keys(pendingD).length === 0) return;
      const compactLine: WalLine = { seq: pendingSeq, ts: pendingTs, d: pendingD };
      writeBuf += JSON.stringify(compactLine) + "\n";
      pendingTs = -1;
      pendingD = {};

      if (pendingSeq < fileMinSeq) fileMinSeq = pendingSeq;
      if (pendingSeq > fileMaxSeq) fileMaxSeq = pendingSeq;
      lineCount++;

      if (writeBuf.length >= WRITE_BUF_SIZE) await flushBuf();

      if (lineCount >= maxPerFile) {
        await flushBuf();
        await fh.write(`#range:${fileMinSeq},${fileMaxSeq}\n`);
        await fh.sync();
        await fh.close();
        gen++;
        fh = await fs.promises.open(path.join(tmpDir, walFileName(gen)), "w");
        lineCount = 0;
        fileMinSeq = Infinity;
        fileMaxSeq = -1;
      }
    };

    let lastLog = Date.now();
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const content = await fs.promises.readFile(path.join(this.walDir, file), "utf-8");
      for (const raw of content.split("\n")) {
        const entries = parseLine(raw);
        if (entries.length === 0) continue;
        oldEntryCount += entries.length;

        if (Date.now() - lastLog > 2000) {
          console.log(`  compacting... file ${fi + 1}/${files.length}, ${oldEntryCount} entries processed`);
          lastLog = Date.now();
        }

        const oldSeq = entries[0].seq;
        const ts = entries[0].ts;

        // Merge lines within 50ms into one tick
        const tsBucket = Math.floor(ts / 50) * 50;
        if (tsBucket !== pendingTs) {
          // Flush previous tick
          await writeTick();
          newSeq++;
          pendingTs = tsBucket;
          pendingSeq = newSeq;
          pendingD = {};
        }

        tsToSeq.set(ts, newSeq);
        oldToNewSeq.set(oldSeq, newSeq);

        // Merge channels into current tick
        for (const e of entries) pendingD[e.channel] = e.value;
        newEntryCount += entries.length;
      }
    }
    // Flush final tick
    await writeTick();

    await flushBuf();
    if (fileMaxSeq >= 0) await fh.write(`#range:${fileMinSeq},${fileMaxSeq}\n`);
    await fh.sync();
    await fh.close();

    // Swap — skip empty trailing files
    for (const file of files) await fs.promises.unlink(path.join(this.walDir, file));
    for (const file of await fs.promises.readdir(tmpDir)) {
      const stat = await fs.promises.stat(path.join(tmpDir, file));
      if (stat.size === 0) { await fs.promises.unlink(path.join(tmpDir, file)); continue; }
      await fs.promises.rename(path.join(tmpDir, file), path.join(this.walDir, file));
    }
    await fs.promises.rmdir(tmpDir);

    return { oldFiles: oldFileCount, oldEntries: oldEntryCount, newEntries: newEntryCount, newSeq, sessionsRepaired: 0 };
  }

  /** Repair session seq pointers by scanning WAL for matching timestamps */
  async repairSessions(): Promise<number> {
    const sessionsDir = path.join(this.config.dataDir, "sessions");
    try { await fs.promises.access(sessionsDir); } catch { return 0; }

    // Build sorted ts→seq index from all WAL files
    console.log("  building timestamp index...");
    const tsIndex: [number, number][] = []; // [ts, seq]
    const walFiles = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();
    for (const file of walFiles) {
      const content = await fs.promises.readFile(path.join(this.walDir, file), "utf-8");
      for (const raw of content.split("\n")) {
        const tick = parseTickLine(raw);
        if (tick) tsIndex.push([tick.ts, tick.seq]);
      }
    }
    tsIndex.sort((a, b) => a[0] - b[0]);

    if (tsIndex.length === 0) { console.log("  no WAL data to index"); return 0; }

    function findSeqForTs(ts: number): number {
      let lo = 0, hi = tsIndex.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (tsIndex[mid][0] < ts) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(tsIndex[lo - 1][0] - ts) < Math.abs(tsIndex[lo][0] - ts)) lo--;
      return tsIndex[lo][1];
    }

    const files = (await fs.promises.readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
    let repaired = 0;

    for (const file of files) {
      const filePath = path.join(sessionsDir, file);
      try {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        const session = JSON.parse(raw);
        let changed = false;

        if (session.lapStartTs) {
          const newSeq = findSeqForTs(session.lapStartTs);
          if (newSeq !== session.lapStartSeq) { session.lapStartSeq = newSeq; changed = true; }
        }

        if (Array.isArray(session.laps)) {
          let lapStart = session.createdAt;
          for (const lap of session.laps) {
            const lapEnd = lapStart + lap.time;
            const newStart = findSeqForTs(lapStart);
            const newEnd = findSeqForTs(lapEnd);
            if (newStart !== lap.startSeq || newEnd !== lap.endSeq) {
              lap.startSeq = newStart;
              lap.endSeq = newEnd;
              changed = true;
            }
            lapStart = lapEnd;
          }
        }

        if (changed) {
          await fs.promises.writeFile(filePath, JSON.stringify(session));
          repaired++;
        }
      } catch {}
    }

    console.log(`  repaired ${repaired}/${files.length} session files`);
    return repaired;
  }

  async nuke(): Promise<void> {
    this.close();
    await fs.promises.rm(this.walDir, { recursive: true, force: true });
    this.byChannel.clear();
    this.seq = 0;
    this.generation = 1;
    this.entriesInGeneration = 0;
    this.entryCount = 0;
    await this.init();
  }

  close(): void {
    if (this.fd !== null) {
      try { fs.fsyncSync(this.fd); fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
    this.releaseLock();
  }

  private get lockPath(): string {
    return path.join(this.config.dataDir, LOCK_FILE);
  }

  private async acquireLock(reason: string): Promise<void> {
    try {
      // O_EXCL fails if file already exists — atomic check-and-create
      const fd = fs.openSync(this.lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeSync(fd, `${reason}\nstarted ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
    } catch (err: any) {
      if (err.code === "EEXIST") {
        let info = "";
        try { info = fs.readFileSync(this.lockPath, "utf-8").trim(); } catch {}
        throw new Error(`WAL is locked (${this.lockPath}). Another process may be running:\n  ${info}\nRemove the lock file manually if this is stale.`);
      }
      throw err;
    }
  }

  private releaseLock(): void {
    try { fs.unlinkSync(this.lockPath); } catch {}
  }
}
