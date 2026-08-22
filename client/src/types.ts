export interface TelemetryEntry {
  seq: number;
  ts: number;
  channel: string;
  value: number;
}

export type ConnectionState =
  | "connecting"
  | "replaying"
  | "live"
  | "disconnected"
  | "error";

export interface ChannelBuffer {
  timestamps: number[]; // seconds (uPlot uses seconds)
  values: number[];
}

/** A merged tick — one WAL batch, all its channels together. The live wire format. */
export interface Tick {
  seq: number;
  ts: number;
  d: Record<string, number>;
}

/** Periodic marker from the udp-client-receiver describing link health. */
export interface Heartbeat {
  now: number; // receiver clock at write
  lastSeq: number; // newest tick seq it has seen
  lastTs: number; // newest tick ts (car's clock)
  lastRecvAgoMs: number; // -1 before any datagram arrives
  received: number;
  lost: number;
  reordered: number;
  lossPct: number; // rolling window, 0-100
  leaseOk: boolean; // is the car's subscription live
}
