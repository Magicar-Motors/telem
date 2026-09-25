import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_KEY,
  SESSION_TTL,
  readSession,
  saveSession,
  clearSession,
} from "../lib/session.mjs";

const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
};
test("connection survives a page reload through session storage", () => {
  const tab = storage();
  saveSession(tab, "ws://100.95.142.37:4455", "secret", 100);
  assert.deepEqual(readSession(tab, 101), {
    address: "ws://100.95.142.37:4455",
    password: "secret",
    expiresAt: 100 + SESSION_TTL,
  });
});
test("expired credentials are removed and not reused", () => {
  const tab = storage();
  saveSession(tab, "ws://host:4455", "secret", 100);
  assert.equal(readSession(tab, 100 + SESSION_TTL), null);
  assert.equal(tab.getItem(SESSION_KEY), null);
});
test("disconnect clears saved credentials", () => {
  const tab = storage();
  saveSession(tab, "ws://host:4455", "secret");
  clearSession(tab);
  assert.equal(readSession(tab), null);
});
test("malformed and invalid sessions are discarded", () => {
  for (const value of [
    "bad json",
    JSON.stringify({
      address: "https://host",
      password: "secret",
      expiresAt: 1000,
    }),
    JSON.stringify({ address: "ws://host", password: 123, expiresAt: 1000 }),
  ]) {
    const tab = storage();
    tab.setItem(SESSION_KEY, value);
    assert.equal(readSession(tab, 100), null);
    assert.equal(tab.getItem(SESSION_KEY), null);
  }
});
test("blocked storage does not prevent manual connection", () => {
  const blocked = {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
    removeItem() {
      throw Error();
    },
  };
  assert.equal(readSession(blocked), null);
  assert.equal(saveSession(blocked, "ws://host", "secret"), false);
  clearSession(blocked);
});
