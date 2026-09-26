import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// Fixed loopback targets: callers cannot choose a host or bypass OBS auth.
export function createGateway({ appPort = 5175, obsPort = 4455 } = {}) {
  const server = http.createServer((req, res) => {
    const upstream = http.request({
      hostname: "127.0.0.1", port: appPort, path: req.url,
      method: req.method, headers: req.headers,
    }, (reply) => {
      res.writeHead(reply.statusCode, { ...reply.headers, "referrer-policy": "no-referrer" });
      reply.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Controller unavailable");
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  const sockets = new WebSocketServer({
    noServer: true, maxPayload: 2 * 1024 * 1024,
    handleProtocols: (protocols) => protocols.has("obswebsocket.json") && "obswebsocket.json",
  });
  server.on("upgrade", (req, socket, head) => {
    let sameOrigin = false;
    try {
      const origin = new URL(req.headers.origin);
      sameOrigin = ["http:", "https:"].includes(origin.protocol) && origin.host === req.headers.host;
    } catch { /* A browser Origin is required. */ }
    if (req.url !== "/obs" || !sameOrigin || sockets.clients.size >= 16 ||
        !req.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim()).includes("obswebsocket.json")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (client) => {
      const obs = new WebSocket(`ws://127.0.0.1:${obsPort}`, "obswebsocket.json", { maxPayload: 2 * 1024 * 1024 });
      let challenged = false;
      let identified = false;
      const stop = (code = 1011, reason = "OBS connection unavailable") => {
        clearTimeout(timeout);
        client.close(code, reason);
        if (obs.readyState === WebSocket.CONNECTING) obs.terminate();
        else obs.close();
      };
      const timeout = setTimeout(() => stop(1008, "OBS authentication timed out"), 15000);
      obs.on("message", (data, binary) => {
        try {
          const message = JSON.parse(data.toString());
          if (!challenged) {
            if (binary || message.op !== 0 || !message.d?.authentication?.challenge || !message.d?.authentication?.salt) {
              stop(1008, "Enable password authentication in OBS before using Funnel");
              return;
            }
            challenged = true;
          }
          if (message.op === 2) { identified = true; clearTimeout(timeout); }
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false });
        } catch { stop(1008, "Invalid OBS response"); }
      });
      client.on("message", (data, binary) => {
        try {
          const message = JSON.parse(data.toString());
          if (binary || !challenged || (!identified && (message.op !== 1 || !message.d?.authentication))) {
            stop(1008, "OBS password authentication required");
            return;
          }
          if (obs.readyState === WebSocket.OPEN) obs.send(data, { binary: false });
        } catch { stop(1008, "Invalid request"); }
      });
      obs.on("error", () => stop());
      client.on("error", () => stop());
      obs.on("close", (code) => stop(code >= 4000 && code <= 4999 ? code : 1011, "OBS disconnected"));
      client.on("close", () => { clearTimeout(timeout); obs.terminate(); });
    });
  });
  server.on("close", () => { for (const client of sockets.clients) client.terminate(); sockets.close(); });
  return server;
}
