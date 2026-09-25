"use client";

import { useEffect, useRef, useState } from "react";
import OBSWebSocket from "obs-websocket-js";
import QrScanner from "./qr-scanner";
import { request, isVertical } from "../lib/scenes.mjs";
import { verticalState } from "../lib/vertical.mjs";
import {
  broadcastPairs,
  isBroadcastScene,
  switchPair,
} from "../lib/paired.mjs";
import { clearSession, readSession, saveSession } from "../lib/session.mjs";

type Deck = {
  horizontal: string[];
  vertical: { name: string; available: boolean }[];
  h: string;
  v: string;
  streaming: boolean;
  plugin: boolean;
  warning: string;
};
const empty: Deck = {
  horizontal: [],
  vertical: [],
  h: "",
  v: "",
  streaming: false,
  plugin: false,
  warning: "",
};
const demoNames = [
  "BC - Car",
  "BC - Car Alt",
  "BC - Commentary",
  "BC - Paddock",
];
const demo: Deck = {
  horizontal: demoNames,
  vertical: demoNames.map((name) => ({
    name: `${name} (Vertical)`,
    available: true,
  })),
  h: "BC - Car",
  v: "BC - Car (Vertical)",
  streaming: false,
  plugin: true,
  warning: "",
};

export default function Controller() {
  const obs = useRef<OBSWebSocket | null>(null);
  const busy = useRef(false);
  const refreshing = useRef(false);
  const connectionAttempt = useRef(0);
  const [deck, setDeck] = useState<Deck>(empty);
  const [status, setStatus] = useState<
    "offline" | "connecting" | "connected" | "demo"
  >("offline");
  const [settings, setSettings] = useState(true);
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [booting, setBooting] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);

  async function refresh(client = obs.current) {
    if (!client || refreshing.current) return;
    refreshing.current = true;
    try {
      const main = await request(client, "GetSceneList");
      const stream = await request(client, "GetStreamStatus");
      let active = "",
        plugin = false,
        warning = "";
      try {
        const state = await verticalState(client, main.scenes);
        active = state.active;
        warning = state.warning;
        plugin = true;
      } catch (e) {
        warning =
          e instanceof Error ? e.message : "Vertical Output is unavailable.";
      }
      if (obs.current !== client) return;
      const names: string[] = main.scenes
        .map((s: { sceneName: string }) => String(s.sceneName))
        .filter(isBroadcastScene);
      setDeck({
        horizontal: names.filter((n) => !isVertical(n)),
        vertical: names
          .filter(isVertical)
          .map((name) => ({ name, available: plugin })),
        h: main.currentProgramSceneName || "",
        v: active,
        streaming: stream.outputActive,
        plugin,
        warning,
      });
    } finally {
      refreshing.current = false;
    }
  }

  useEffect(() => {
    if (status !== "connected") return;
    const poll = () => {
      void refresh().catch(() =>
        setError(
          "Could not refresh OBS. Reconnect if the connection was interrupted.",
        ),
      );
    };
    const timer = setInterval(poll, 2000);
    const visible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [status]);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    await openConnection(address, password);
  }

  async function openConnection(serverAddress: string, serverPassword: string) {
    if (busy.current) return;
    setScanning(false);
    setError("");
    setMessage("");
    let url: URL;
    try {
      url = new URL(serverAddress);
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      setSettings(true);
      setError(
        "Enter an OBS WebSocket address such as ws://100.100.10.20:4455.",
      );
      return;
    }
    if (location.protocol === "https:" && url.protocol === "ws:") {
      setSettings(true);
      setError(
        "Open this controller over HTTP using your computer’s Tailscale address. An HTTPS website requires a secure wss:// OBS endpoint.",
      );
      return;
    }
    busy.current = true;
    setStatus("connecting");
    setDeck(empty);
    const attempt = ++connectionAttempt.current;
    const previous = obs.current;
    obs.current = null;
    await previous?.disconnect();
    if (attempt !== connectionAttempt.current) return;
    const client = new OBSWebSocket();
    obs.current = client;
    client.on("ConnectionError", () => {});
    client.on("ConnectionClosed", () => {
      if (obs.current !== client) return;
      setStatus("offline");
      setDeck(empty);
      setError("OBS disconnected. Check OBS and Tailscale, then reconnect.");
      setSettings(true);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(url.href, serverPassword || undefined, {
          rpcVersion: 1,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Connection timed out. Check the Tailscale address, OBS WebSocket server, and firewall.",
                ),
              ),
            8000,
          );
        }),
      ]);
      clearTimeout(timeout);
      await refresh(client);
      if (attempt !== connectionAttempt.current || obs.current !== client)
        return;
      try {
        localStorage.setItem("scene-deck-address", url.href);
      } catch {
        /* Storage may be unavailable. */
      }
      let remembered = false;
      try {
        remembered = saveSession(sessionStorage, url.href, serverPassword);
      } catch {
        /* Storage may be blocked. */
      }
      setStatus("connected");
      setSettings(false);
      setMessage("Connected. Tap a BC scene to switch both views.");
      if (!remembered)
        setMessage(
          "Connected. Session storage is blocked, so refreshing will require reconnecting.",
        );
    } catch (e) {
      if (attempt !== connectionAttempt.current) return;
      obs.current = null;
      await client.disconnect();
      setStatus("offline");
      setSettings(true);
      setError(
        e instanceof Error
          ? e.message
          : "Could not connect to OBS. Check the address and password.",
      );
    } finally {
      clearTimeout(timeout);
      if (attempt === connectionAttempt.current) busy.current = false;
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      let saved = null;
      try {
        saved = readSession(sessionStorage);
      } catch {
        /* Storage may be blocked. */
      }
      setCanFullscreen(
        !!document.documentElement.requestFullscreen &&
          document.fullscreenEnabled,
      );
      if (saved) {
        setAddress(saved.address);
        setPassword(saved.password);
        setSettings(false);
        void openConnection(saved.address, saved.password).finally(() =>
          setBooting(false),
        );
      } else {
        try {
          setAddress(
            localStorage.getItem("scene-deck-address") ||
              `ws://${location.hostname}:4455`,
          );
        } catch {
          setAddress(`ws://${location.hostname}:4455`);
        }
        setBooting(false);
      }
    }, 0);
    const changed = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      clearTimeout(timer);
      // Invalidate the latest attempt, not the attempt that existed when mounting.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      connectionAttempt.current++;
      busy.current = false;
      document.removeEventListener("fullscreenchange", changed);
      const client = obs.current;
      obs.current = null;
      void client?.disconnect();
    };
    // Restore once after hydration, using only the stored connection values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function select(name: string) {
    if (locked || busy.current || !["demo", "connected"].includes(status))
      return;
    busy.current = true;
    setPending(name);
    setError("");
    setMessage("");
    try {
      if (status === "demo") {
        setDeck((d) => ({ ...d, h: name, v: `${name} (Vertical)` }));
        setMessage(`Demo: both views switched to ${name}.`);
      } else {
        const client = obs.current;
        if (!client) throw new Error("OBS is disconnected.");
        await switchPair(client, name);
        await refresh(client);
        setMessage(`Both views switched to ${name}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scene switch failed.");
      await refresh().catch(() => {});
    } finally {
      busy.current = false;
      setPending("");
    }
  }

  const online = status === "connected" || status === "demo";
  const pairs = broadcastPairs([
    ...deck.horizontal,
    ...deck.vertical.map((s) => s.name),
  ]);
  const filteredPairs = pairs.filter((p) =>
    p.horizontal.toLowerCase().includes(query.toLowerCase()),
  );
  function disconnect() {
    connectionAttempt.current++;
    try {
      clearSession(sessionStorage);
    } catch {
      /* Storage may be blocked. */
    }
    setPassword("");
    setScanning(false);
    const client = obs.current;
    obs.current = null;
    void client?.disconnect();
    setStatus("offline");
    setDeck(empty);
    setSettings(true);
    setMessage("");
    setError("");
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError(
        "Fullscreen is unavailable in this browser. The controls still fit the phone screen.",
      );
    }
  }
  if (booting)
    return (
      <main className="restore-screen">
        <span className="brand-mark">s↗</span>
        <h1>Scene Deck</h1>
        <p role="status">Restoring your session…</p>
      </main>
    );
  return (
    <main
      className={`${online ? "connected-app" : ""} ${settings ? "settings-open" : ""}`}
    >
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">
            s<span>↗</span>
          </span>
          scene<span className="brand-light">deck</span>
          <span className="remote-label">OBS REMOTE</span>
        </span>
        <button className="quiet" onClick={() => setSettings((s) => !s)}>
          {settings && online
            ? "Back to scenes"
            : online
              ? "Settings"
              : "Connection"}{" "}
          <span className={`dot ${online ? "green" : ""}`} />
        </button>
      </header>
      <div className="workspace">
        <section className="intro">
          <div>
            <p className="eyebrow">YOUR STUDIO, WITHIN REACH</p>
            <h1>Make your next scene.</h1>
            <p className="muted">Two formats. One place to stay in control.</p>
          </div>
          <div className={`connection-pill ${online ? "online" : ""}`}>
            <span className={`dot ${online ? "green" : ""}`} />
            {status === "demo"
              ? "Demo mode"
              : status === "connected"
                ? "Connected to OBS"
                : status === "connecting"
                  ? "Connecting…"
                  : "OBS disconnected"}
          </div>
        </section>
        {settings && (
          <section className="connection-panel">
            <div>
              <h2>Connect your studio</h2>
              <p>
                In OBS, open <strong>Tools → WebSocket Server Settings</strong>{" "}
                and enable the server. Use your OBS computer’s Tailscale IP and
                WebSocket password below.
              </p>
              <small>
                Keep Tailscale connected on both devices. This tab remembers
                your connection for up to 12 hours. Disconnect clears it.
              </small>
            </div>
            <form onSubmit={connect}>
              <label>
                OBS WebSocket address
                <input
                  type="url"
                  required
                  placeholder="ws://100.100.10.20:4455"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  disabled={status === "connecting"}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="OBS WebSocket password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={status === "connecting"}
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="quiet"
                  disabled={status === "connecting" || !!pending}
                  onClick={() => setScanning((s) => !s)}
                >
                  Scan OBS QR code
                </button>
                <button
                  className="primary"
                  disabled={status === "connecting" || !!pending}
                >
                  {status === "connecting" ? "Connecting…" : "Connect to OBS ↗"}
                </button>
                {online ? (
                  <button
                    type="button"
                    className="quiet"
                    disabled={!!pending}
                    onClick={disconnect}
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className="quiet"
                    disabled={status === "connecting"}
                    onClick={() => {
                      setStatus("demo");
                      setDeck(demo);
                      setSettings(false);
                      setError("");
                      setMessage("Demo mode — no commands are sent to OBS.");
                    }}
                  >
                    Try the demo
                  </button>
                )}
              </div>
              {scanning && (
                <QrScanner
                  currentAddress={address}
                  onClose={() => setScanning(false)}
                  onScan={(connection) => {
                    setAddress(connection.address);
                    setPassword(connection.password);
                    setScanning(false);
                    setError("");
                    setMessage(
                      "QR code scanned. Connection details are filled in—tap Connect to OBS.",
                    );
                  }}
                />
              )}
            </form>
          </section>
        )}
        {status === "demo" && (
          <div className="notice demo-notice">
            <span>DEMO</span> Explore the controls. These are sample scenes, and
            OBS is unaffected.
            <button className="text-button" onClick={disconnect}>
              Exit demo
            </button>
          </div>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {deck.warning && <div className="notice">{deck.warning}</div>}
        <section className="outputs" aria-label="Current output scenes">
          {(["horizontal", "vertical"] as const).map((kind, i) => (
            <div className={`output ${kind}`} key={kind}>
              <div className={`format-symbol ${kind}`} />
              <div className="output-info">
                <p className="eyebrow">
                  {kind.toUpperCase()} <span>{i === 0 ? "16:9" : "9:16"}</span>
                </p>
                <h2>{(i === 0 ? deck.h : deck.v) || "No active scene"}</h2>
                <p className="muted">
                  {i === 0 ? "OBS main canvas" : "Restream vertical canvas"}
                </p>
              </div>
              <span
                className={`output-state ${online && (i === 0 ? deck.h : deck.v) ? "active" : ""}`}
              >
                {status === "demo"
                  ? "SAMPLE"
                  : online && (i === 0 ? deck.h : deck.v)
                    ? "PROGRAM"
                    : "OFFLINE"}
              </span>
            </div>
          ))}
        </section>
        <div className="deck-toolbar">
          <div>
            <h2>Scene switcher</h2>
            <span className="muted">
              One tap switches horizontal and portrait together.
            </span>
          </div>
          <div className="toolbar-controls">
            {online && canFullscreen && (
              <button
                type="button"
                className="quiet fullscreen-button"
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? "Exit fullscreen" : "Fullscreen"}
              </button>
            )}
            <label
              className={`search ${pairs.length <= 6 ? "optional-search" : ""}`}
            >
              <span aria-hidden="true">⌕</span>
              <input
                aria-label="Search scenes"
                placeholder="Find a scene…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button
              className={`quiet lock ${locked ? "locked" : ""}`}
              aria-pressed={locked}
              onClick={() => setLocked((l) => !l)}
            >
              {locked ? "Unlock controls" : "Lock controls"}
            </button>
            <button
              className="quiet"
              disabled={!online || !!pending}
              onClick={() => {
                if (status === "demo") {
                  setMessage("Demo scenes are up to date.");
                  return;
                }
                void refresh()
                  .then(() => setMessage("Scenes refreshed."))
                  .catch(() => setError("Could not refresh scenes."));
              }}
            >
              ↻ <span className="refresh-label">Refresh</span>
            </button>
          </div>
        </div>
        {locked && (
          <div className="notice">
            Controls are locked to prevent accidental switches.
          </div>
        )}
        <section className="paired-scenes" aria-label="Linked broadcast scenes">
          <div className="column-heading">
            <h3>BC scenes · horizontal + portrait</h3>
            <span className="count">{pairs.length}</span>
          </div>
          <div className="paired-grid">
            {filteredPairs.length ? (
              filteredPairs.map((pair, index) => {
                const selected =
                  deck.h === pair.horizontal && deck.v === pair.vertical;
                const available = deck.plugin && !!pair.vertical;
                return (
                  <button
                    key={pair.horizontal}
                    className={`scene ${selected ? "selected" : ""}`}
                    disabled={!online || locked || !!pending || !available}
                    onClick={() => void select(pair.horizontal)}
                    aria-pressed={selected}
                  >
                    <span className="scene-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="scene-name">
                      {pair.horizontal}
                      <small>
                        {!pair.vertical
                          ? "Ambiguous (Vertical) scene names"
                          : !deck.plugin
                            ? "Vertical Output unavailable"
                            : pending === pair.horizontal
                              ? "Waiting for both views…"
                              : selected
                                ? "Selected on both outputs"
                                : pair.vertical === pair.horizontal
                                  ? "Portrait: horizontal rotated 90° to fit"
                                  : "Switch horizontal + portrait"}
                      </small>
                    </span>
                    <span className="scene-action">{selected ? "●" : "↗"}</span>
                  </button>
                );
              })
            ) : (
              <div className="empty">
                <h3>
                  {query
                    ? "No matching BC scenes"
                    : online
                      ? "No BC scenes yet"
                      : "Your BC scenes will appear here"}
                </h3>
                <p>
                  {online
                    ? "Use a BC-prefixed scene. A matching (Vertical) version is optional."
                    : "Connect OBS to load your broadcast scenes."}
                </p>
              </div>
            )}
          </div>
        </section>
        <div className="feedback" role="status" aria-live="polite">
          {pending
            ? "Switching scene — waiting for confirmation…"
            : message || "Scene changes are confirmed by OBS."}
        </div>
        <footer>
          <span>
            <span className={`dot ${deck.streaming ? "green" : ""}`} />
            {status === "demo"
              ? "Demo session"
              : !online
                ? "Ready when you are"
                : deck.streaming
                  ? "OBS main stream is live"
                  : "OBS main stream is offline"}
          </span>
          <span>Made for the other side of the camera.</span>
        </footer>
        <details className="help">
          <summary>Setup & vertical scene help</summary>
          <p>
            On your phone, open <code>http://YOUR-OBS-TAILSCALE-IP:5173</code>{" "}
            while this app runs on the OBS computer. Connect to{" "}
            <code>ws://YOUR-OBS-TAILSCALE-IP:4455</code>. Both devices must be
            connected to your tailnet, with access to ports 5173 and 4455
            allowed by your firewall and Tailscale policy.
          </p>
          <p>
            Create one scene named <code>Vertical Output</code> in the Restream
            Vertical dock. Only <code>BC</code>-prefixed scene pairs appear.
            Selecting <code>BC - Car</code>, for example, switches the main
            output to that scene and shows <code>BC - Car (Vertical)</code>{" "}
            inside Vertical Output. Without a (Vertical) counterpart, the
            horizontal scene is rotated 90° clockwise and fitted to the portrait
            canvas. Other overlays are left alone. Adjust its framing in OBS;
            existing transforms are preserved, and newly added portrait sources
            copy the framing of an existing portrait source. Automatic
            horizontal fallbacks are always rotated and fitted to the canvas.
          </p>
          <p>
            Changes made inside OBS update here every two seconds. Both views
            are switched by this controller and confirmed separately; the two
            OBS operations are not frame-atomic. Use the HTTP URL over
            Tailscale; HTTPS hosting requires a secure <code>wss://</code> OBS
            endpoint. Do not forward OBS’s port to the public internet.
          </p>
        </details>
      </div>
    </main>
  );
}
