const REMOTE_URL = ((import.meta.env.VITE_SERVER_URL as string) ?? "http://gearados-nx:4400").replace(/\/$/, "");
const LOCAL_URL = "http://localhost:4400";
const isLocal = new URLSearchParams(window.location.search).has("local");

export const SERVER_URL = isLocal ? LOCAL_URL : REMOTE_URL;
