import { spawn } from "node:child_process";
import { createGateway } from "../lib/funnel-gateway.mjs";
import { printFunnelQr } from "./funnel-qr.mjs";

const appPort = Number(process.env.SCENE_DECK_APP_PORT || 5175);
const port = Number(process.env.SCENE_DECK_PORT || 8787);
const obsPort = Number(process.env.OBS_PORT || 4455);
for (const value of [appPort, port, obsPort]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("Invalid port");
}
const app = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "start", "--hostname", "127.0.0.1", "--port", String(appPort)], {
  stdio: "inherit", env: { ...process.env, NODE_ENV: "production" },
});
const gateway = createGateway({ appPort, obsPort });
gateway.on("error", (error) => { console.error(error.message); app.kill(); process.exitCode = 1; });
gateway.listen(port, "127.0.0.1", () => console.log(`Funnel gateway: http://127.0.0.1:${port} (OBS password required)`));
void printFunnelQr(port).catch(() => console.warn("Could not render QR code. Run npm run funnel:qr to retry."));
app.on("exit", (code) => { gateway.close(); process.exit(code || 0); });
app.on("error", (error) => { console.error(error.message); process.exit(1); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { app.kill(signal); gateway.close(); });
