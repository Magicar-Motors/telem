import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { WalEngine } from "./wal.js";
import { createServer } from "./http.js";
import { SessionStore } from "./sessions.js";
import { LapDetector } from "./lap-detector.js";
import { UdpSender } from "./udp-sender.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "../../tracks");

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const PORT = parseInt(process.env.PORT ?? "4400", 10);
const SNAPSHOT_THRESHOLD = parseInt(process.env.SNAPSHOT_THRESHOLD ?? "5000", 10);
const FSYNC_BATCH_SIZE = parseInt(process.env.FSYNC_BATCH_SIZE ?? "100", 10);

async function main(): Promise<void> {
  const wal = new WalEngine({
    dataDir: DATA_DIR,
    snapshotThreshold: SNAPSHOT_THRESHOLD,
    fsyncBatchSize: FSYNC_BATCH_SIZE,
  });

  await wal.init();
  console.log(
    `WAL initialized: seq=${wal.currentSeq} gen=${wal.currentGeneration} entries=${wal.totalEntries}`,
  );

  const sessions = new SessionStore(DATA_DIR);
  const lapDetector = new LapDetector(TRACKS_DIR, sessions, wal);
  const udpSender = new UdpSender(wal);
  const server = createServer(wal, sessions, lapDetector, udpSender);

  // Wire GPS data to lap detector
  let lastLat = 0;
  let lastLon = 0;
  let lastGpsTs = 0;

  wal.on("entry", (entry) => {
    if (entry.channel === "gps_lat") {
      lastLat = entry.value as number;
      lastGpsTs = entry.ts;
    } else if (entry.channel === "gps_lon") {
      lastLon = entry.value as number;
      // trigger detection when we have both lat+lon (they come in the same batch)
      if (lastLat !== 0 && lastLon !== 0 && entry.ts === lastGpsTs) {
        lapDetector.onGps(lastLat, lastLon, entry.ts);
      }
    }
  });

  // Jetson thermal monitoring — ingest system temps every 5s
  const THERMAL_DIR = "/sys/devices/virtual/thermal";
  const THERMAL_INTERVAL = 1000;

  function ingestThermals(): void {
    if (!existsSync(THERMAL_DIR)) return;
    try {
      const zones = readdirSync(THERMAL_DIR).filter((d) => d.startsWith("thermal_zone"));
      const ts = Date.now();
      let sum = 0, count = 0;
      for (const zone of zones) {
        const tempFile = `${THERMAL_DIR}/${zone}/temp`;
        if (!existsSync(tempFile)) continue;
        const tempC = parseInt(readFileSync(tempFile, "utf-8").trim(), 10) / 1000;
        if (!isNaN(tempC)) { sum += tempC; count++; }
      }
      if (count > 0) {
        wal.append({ channel: "jetson_temp", value: Math.round((sum / count) * 10) / 10, ts });
      }
    } catch {}
  }

  ingestThermals();
  const thermalTimer = setInterval(ingestThermals, THERMAL_INTERVAL);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`telemetry server listening on 0.0.0.0:${PORT}`);
  });

  const shutdown = (): void => {
    console.log("shutting down...");
    clearInterval(thermalTimer);
    udpSender.close();
    server.close(() => {
      wal.close();
      console.log("shutdown complete");
      process.exit(0);
    });

    // force exit after 5s if connections don't drain
    setTimeout(() => {
      wal.close();
      process.exit(1);
    }, 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
