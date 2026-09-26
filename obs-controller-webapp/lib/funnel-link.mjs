import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Only advertise an enabled public route pointing at this controller. */
export function funnelUrl(config, port = 8787) {
  for (const [host, enabled] of Object.entries(config.AllowFunnel || {})) {
    try {
      const url = new URL(`https://${host}`);
      const proxy = config.Web?.[host]?.Handlers?.["/"]?.Proxy;
      if (enabled === true && url.hostname.endsWith(".ts.net") &&
          !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
          proxy === `http://127.0.0.1:${port}`) return url.href;
    } catch { /* Ignore malformed or unrelated entries. */ }
  }
  return null;
}

export async function readFunnelUrl(port = 8787) {
  try {
    const { stdout } = await exec("tailscale", ["funnel", "status", "--json"], { timeout: 3000, maxBuffer: 128 * 1024 });
    return funnelUrl(JSON.parse(stdout), port);
  } catch { return null; }
}
