import QRCode from "qrcode";
import { readFunnelUrl } from "../lib/funnel-link.mjs";

export async function printFunnelQr(port = 8787) {
  const url = await readFunnelUrl(port);
  if (!url) {
    console.log("No active Funnel found for this controller. Enable Funnel, then run npm run funnel:qr.");
    return;
  }
  console.log(`\nScan to open Scene Deck on your phone:\n${url}\n`);
  console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  console.log("Link only — enter your OBS password on your phone.\n");
}
