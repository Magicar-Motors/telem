const REMOTE_URL = ((import.meta.env.VITE_SERVER_URL as string) ?? "http://gearados-nx:4400").replace(/\/$/, "");
const LOCAL_URL = "http://localhost:4400";
const isLocal = new URLSearchParams(window.location.search).has("local");

export const SERVER_URL = isLocal ? LOCAL_URL : REMOTE_URL;

// Live ticks arrive over UDP and are terminated by this laptop's
// udp-client-receiver, not fetched from the car. Everything else — sessions,
// /wal/range, /stats, service control — still talks to the car directly.
// In ?local dev the receiver isn't running, so fall back to the server's own SSE.
const RECEIVER_URL = ((import.meta.env.VITE_RECEIVER_URL as string) ?? "http://localhost:4401").replace(/\/$/, "");

export const LIVE_URL = isLocal ? SERVER_URL : RECEIVER_URL;
