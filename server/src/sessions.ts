import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface Lap {
  lap: number;
  time: number; // ms
  flag: "clean" | "yellow" | "pit" | "out" | "in";
  track: string;
  startSeq: number; // WAL seq at lap start
  endSeq: number; // WAL seq at lap end (S/F crossing)
}

export interface Session {
  id: string;
  track: string;
  driver: string;
  createdAt: number; // epoch ms
  running: boolean;
  lapStartSeq: number;
  lapStartTs: number;
  laps: Lap[];
}

export class SessionStore extends EventEmitter {
  private dir: string;

  constructor(dataDir: string) {
    super();
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(this.dir, `${safe}.json`);
  }

  list(track?: string): Session[] {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const sessions: Session[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(this.dir, f), "utf-8"),
        );
        if (!track || data.track === track) sessions.push(data);
      } catch {}
    }
    sessions.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return sessions;
  }

  get(id: string): Session | null {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      return null;
    }
  }

  create(track: string, seq: number, driver = ""): Session {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      track,
      driver,
      createdAt: now,
      running: true,
      lapStartSeq: seq,
      lapStartTs: now,
      laps: [],
    };
    fs.writeFileSync(this.filePath(session.id), JSON.stringify(session));
    this.emit("update", session);
    return session;
  }

  update(id: string, patch: Partial<Pick<Session, "running" | "laps" | "lapStartSeq" | "lapStartTs" | "driver" | "track">>): Session | null {
    const session = this.get(id);
    if (!session) return null;
    if (patch.running !== undefined) session.running = patch.running;
    if (patch.laps !== undefined) session.laps = patch.laps;
    if (patch.lapStartSeq !== undefined) session.lapStartSeq = patch.lapStartSeq;
    if (patch.lapStartTs !== undefined) session.lapStartTs = patch.lapStartTs;
    if (patch.driver !== undefined) session.driver = patch.driver;
    if (patch.track !== undefined) {
      // After patch.laps, so laps swapped in by the same call get relabelled too.
      session.track = patch.track;
      for (const lap of session.laps) lap.track = patch.track;
    }
    fs.writeFileSync(this.filePath(id), JSON.stringify(session));
    this.emit("update", session);
    return session;
  }

  delete(id: string): boolean {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }
}
