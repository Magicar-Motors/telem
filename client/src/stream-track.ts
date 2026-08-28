/**
 * Which track the OBS overlays draw and pull sessions for.
 *
 * `?track=<id>` still pins it — that's how you show a track other than the one
 * being driven. Without one, ask the car what is recording right now, so a
 * session started on a different layout doesn't leave the overlays quietly
 * showing the last session on whatever the default happened to be.
 *
 * Resolved with a top-level await, so importing this settles the track before
 * an overlay's module body runs and reads it. Every failure path — car
 * unreachable, slow, no sessions, an id we have no geometry for — falls back to
 * the default rather than leaving a live overlay blank waiting on a fetch.
 */
import { SERVER_URL } from "./server-url";
import { DEFAULT_TRACK, TRACKS } from "./track";

const DISCOVER_TIMEOUT_MS = 2000;

interface SessionSummary {
  track?: string;
  running?: boolean;
}

async function discoverRecordingTrack(): Promise<string> {
  try {
    const res = await fetch(`${SERVER_URL}/sessions`, {
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return DEFAULT_TRACK;
    const sessions = (await res.json()) as SessionSummary[];
    // Newest first, so the running one is the live session; with none running,
    // the newest session is the one whose data the overlays would show anyway.
    const track = (sessions.find((s) => s.running) ?? sessions[0])?.track;
    return track && track in TRACKS ? track : DEFAULT_TRACK;
  } catch {
    return DEFAULT_TRACK;
  }
}

const pinned = new URLSearchParams(window.location.search).get("track");

export const STREAM_TRACK_ID: string = pinned ?? (await discoverRecordingTrack());
