import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createGateway } from "../lib/funnel-gateway.mjs";

async function fixture(t, authenticated = true) {
  const app = http.createServer((req, res) => res.end("Scene Deck"));
  app.listen(0, "127.0.0.1"); await once(app, "listening");
  const obs = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(obs, "listening");
  const received = [];
  obs.on("connection", (ws) => {
    ws.send(JSON.stringify({ op: 0, d: authenticated ? { authentication: { challenge: "challenge", salt: "salt" } } : {} }));
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()); received.push(message);
      if (message.op === 1 && message.d.authentication === "correct") ws.send(JSON.stringify({ op: 2, d: {} }));
      else if (message.op === 1) ws.close(4009, "Authentication failed");
      else ws.send(data, { binary: false });
    });
  });
  const gateway = createGateway({ appPort: app.address().port, obsPort: obs.address().port });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const host = `127.0.0.1:${gateway.address().port}`;
  const clients = [];
  t.after(() => { clients.forEach((c) => c.terminate()); obs.clients.forEach((c) => c.terminate()); gateway.close(); gateway.closeAllConnections(); app.close(); app.closeAllConnections(); obs.close(); });
  return { received, url: `http://${host}`, connect(origin = `https://${host}`) {
    const client = new WebSocket(`ws://${host}/obs`, "obswebsocket.json", { origin });
    clients.push(client); return client;
  } };
}
test("proxies the app and relays authenticated OBS messages", async (t) => {
  const f = await fixture(t);
  assert.equal(await (await fetch(f.url)).text(), "Scene Deck");
  const client = f.connect();
  assert.equal(JSON.parse((await once(client, "message"))[0]).op, 0);
  client.send(JSON.stringify({ op: 1, d: { authentication: "correct" } }));
  assert.equal(JSON.parse((await once(client, "message"))[0]).op, 2);
  client.send(JSON.stringify({ op: 6, d: { requestType: "GetVersion" } }));
  assert.equal(JSON.parse((await once(client, "message"))[0]).op, 6);
});
test("fails closed if OBS authentication is disabled", async (t) => {
  const f = await fixture(t, false);
  assert.equal((await once(f.connect(), "close"))[0], 1008);
  assert.equal(f.received.length, 0);
});
test("blocks commands before identification", async (t) => {
  const f = await fixture(t); const client = f.connect(); await once(client, "message");
  client.send(JSON.stringify({ op: 6, d: {} }));
  assert.equal((await once(client, "close"))[0], 1008);
  assert.equal(f.received.length, 0);
});
test("preserves OBS authentication failures", async (t) => {
  const f = await fixture(t); const client = f.connect(); await once(client, "message");
  client.send(JSON.stringify({ op: 1, d: { authentication: "wrong" } }));
  assert.equal((await once(client, "close"))[0], 4009);
});
test("rejects cross-origin browser connections", async (t) => {
  const f = await fixture(t); const client = f.connect("https://untrusted.example");
  const [error] = await once(client, "error"); assert.match(error.message, /403/);
});
