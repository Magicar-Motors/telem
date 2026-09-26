import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { funnelUrl } from "../lib/funnel-link.mjs";

function config(host = "studio.tail123.ts.net:443", port = 8787) {
  return {
    AllowFunnel: { [host]: true },
    Web: { [host]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
  };
}

test("selects the active controller Funnel URL, including alternate HTTPS ports", () => {
  assert.equal(funnelUrl(config()), "https://studio.tail123.ts.net/");
  assert.equal(funnelUrl(config("studio.tail123.ts.net:8443", 9000), 9000), "https://studio.tail123.ts.net:8443/");
});

test("does not advertise disabled, unrelated, or credential-bearing routes", () => {
  const disabled = config(); disabled.AllowFunnel["studio.tail123.ts.net:443"] = false;
  for (const value of [{}, disabled, config("studio.tail123.ts.net:443", 9999), config("secret@studio.tail123.ts.net:443"), config("example.com:443")]) {
    assert.equal(funnelUrl(value), null);
  }
});

test("QR payload decodes to the public URL only and renders as terminal blocks", async () => {
  const url = funnelUrl(config());
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const scale = 6, margin = 4, size = (qr.modules.size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y++) for (let x = 0; x < qr.modules.size; x++) {
    if (!qr.modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
  }
  assert.equal(jsQR(pixels, size, size)?.data, url);
  assert.match(await QRCode.toString(url, { type: "terminal", small: true }), /[▀▄█]/);
});
