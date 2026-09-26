import assert from "node:assert/strict";
import test from "node:test";
import { parseObsQr, retainCurrentHost } from "../lib/qr.mjs";

test("keeps the secure Funnel endpoint when scanning a local OBS QR", () => {
  assert.deepEqual(retainCurrentHost(parseObsQr("obsws://192.168.1.2:4455/secret"), "wss://studio.example/obs"), {
    address: "wss://studio.example/obs", password: "secret",
  });
});

test("parses the OBS QR and percent-decodes its password without leaking it into the address", () => {
  assert.deepEqual(parseObsQr("obsws://192.168.1.2:4455/a%2Fb%23c%25%20d"), {
    address: "ws://192.168.1.2:4455",
    password: "a/b#c% d",
  });
});
test("supports no-password connections, secure endpoints and IPv6", () => {
  assert.deepEqual(parseObsQr("obsws://host:4455"), {
    address: "ws://host:4455",
    password: "",
  });
  assert.equal(
    parseObsQr("obswss://[::1]:4456/secret").address,
    "wss://[::1]:4456",
  );
  assert.equal(parseObsQr("obswss://host:443/secret").address, "wss://host");
});
test("rejects arbitrary QR links, embedded credentials, invalid ports and malformed encoding", () => {
  for (const value of [
    "https://example.com",
    "javascript:alert(1)",
    "obsws://user:secret@host:4455/pass",
    "obsws://host:99999/pass",
    "obsws://host:4455/%ZZ",
  ]) {
    assert.throws(() => parseObsQr(value), /not a valid OBS/);
  }
});
test("keeps the Tailscale host while importing the scanned port and password", () => {
  assert.deepEqual(
    retainCurrentHost(
      parseObsQr("obsws://192.168.1.2:4456/secret"),
      "ws://100.95.142.37:4455",
    ),
    { address: "ws://100.95.142.37:4456", password: "secret" },
  );
});
test("invalid current addresses fail with a credential-free error", () => {
  assert.throws(
    () =>
      retainCurrentHost(
        { address: "ws://host:4455", password: "secret" },
        "invalid",
      ),
    /Enter a valid current OBS address/,
  );
});
