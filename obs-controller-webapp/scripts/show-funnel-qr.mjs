import { printFunnelQr } from "./funnel-qr.mjs";
await printFunnelQr(Number(process.env.SCENE_DECK_PORT || 8787));
