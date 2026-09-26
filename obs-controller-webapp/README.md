# Scene Deck

A phone-friendly OBS remote built with Node/npm, React and obs-websocket-js. Only BC-prefixed scenes appear as buttons. One tap switches the horizontal scene and its matching `(Vertical)` scene together, with separate current-output indicators, search, accidental-tap lock, and an explicitly labeled demo. OBS state refreshes every two seconds and on returning to the tab.

## Public phone access with Tailscale Funnel

On the OBS computer, enable OBS WebSocket **password authentication**, then run:

```sh
npm install
npm run build:funnel
npm run start:funnel
```

In another terminal:

```sh
tailscale funnel --bg --yes http://127.0.0.1:8787
```

Open the HTTPS URL printed by Tailscale on your phone. The phone does **not** need Tailscale. The secure OBS address is filled automatically; enter your OBS WebSocket password or scan its QR with “Keep current server address” checked. Scanning preserves the complete Funnel endpoint. Refresh restores the same temporary session as local access.

The gateway binds only to loopback, proxies the production app on port 5175, and relays `/obs` to local OBS on port 4455. It preserves OBS's challenge/response authentication, rejects cross-origin browser connections, and refuses connections if OBS authentication is disabled. The page is public; anyone with the OBS password has full OBS WebSocket control, so use a strong unique password and keep the QR private. No OBS credentials are stored on the gateway. Override `OBS_PORT`, `SCENE_DECK_PORT`, or `SCENE_DECK_APP_PORT` if needed (adjust the Funnel command for a different gateway port).

The computer must stay awake with OBS, Tailscale, and `npm run start:funnel` running. Restart that command after reboot; `--bg` persists routing, not the Node process. Stop public access with `tailscale funnel --https=443 off`.

If Tailscale says “Funnel is not enabled on your tailnet,” a tailnet administrator must enable the `funnel` node attribute for this computer in the [tailnet policy](https://tailscale.com/docs/features/tailscale-funnel). Then rerun the command. Do not replace existing policy or expose port 4455 separately.

### Scan the link from your terminal

`npm run start:funnel` prints the active public URL as a QR code using text block characters, supported by Apple Terminal. Scan it with your phone’s Camera app. Keep the terminal wide enough that the code does not wrap.

If you enable Funnel after starting the controller, or want to show the code again without restarting:

```sh
npm run funnel:qr
```

The code contains only the public website URL, never an OBS password. It is shown only when Tailscale reports an active Funnel pointing at this controller’s port. DNS may still take a few minutes to become available after first enabling Funnel.

## Private access over Tailscale

On the OBS computer (Node 22.13+):

```sh
npm install
npm run dev
```

Open `http://<OBS-computer-Tailscale-IP>:5173` on your phone, with both devices connected to Tailscale. Use the actual port printed by the server if different. The app listens on all interfaces for phone access; firewall rules can limit access to Tailscale.

In OBS **Tools → WebSocket Server Settings**, enable the server and authentication. Enter `ws://<OBS-computer-Tailscale-IP>:4455` and the OBS WebSocket password in the app. Use the port configured in OBS if different. No credentials need to be shared in chat. Successful connections are saved in tab-scoped sessionStorage for 12 hours so refreshing reconnects automatically. Disconnect clears the saved credentials and password field. Only the non-secret server address is kept in localStorage. If session storage is blocked or the session has expired, connect manually.

Allow the website port and OBS WebSocket port in your host firewall and Tailscale policy. Use HTTP over Tailscale: the tunnel encrypts device traffic. An HTTPS page cannot connect to an insecure `ws://` endpoint. Do not expose the OBS port through router forwarding. Tailscale Serve in HTTPS mode also needs a matching secure WebSocket proxy; it is not required for the HTTP approach.

## Phone controls

After connecting, the phone layout fills the available viewport with large scene buttons, a compact output status row, and lock/settings controls. The current four scenes fit in a two-by-two grid; larger collections scroll within the scene grid rather than the whole page. Settings opens a separate scrollable view and Back to scenes returns to the controls. A Fullscreen button is available where the browser supports it. Refresh shows a session-restoration screen and reconnects from sessionStorage without switching OBS scenes. After upgrading from a version without session storage, connect once to establish the saved session.

## Scan to connect

Open **Connection → Scan OBS QR code**. In OBS, open **Tools → WebSocket Server Settings → Show Connect Info**. Use **Take photo** or **Choose image** to scan that code, then tap **Connect to OBS**. Images are decoded locally with jsQR and never uploaded. Live camera scanning is also available in secure browser contexts (HTTPS or localhost); use the photo options on the normal Tailscale HTTP URL.

**Keep current server host (Tailscale)** is checked by default: scanning imports the password and port while preserving the host already in the address field. Uncheck it to use the host encoded in OBS's QR. Supports OBS `obsws://` and `obswss://` codes, including percent-encoded passwords. After a successful connection, scanned credentials follow the same temporary sessionStorage policy; passwords are never written to localStorage.

## Vertical scene controls

The [Restream plugin source](https://github.com/restreamio/obs-vertical-canvas/blob/master/vertical-canvas.cpp) retains the `aitum-vertical-canvas` WebSocket vendor. The app calls `get_scenes`, `current_scene`, and `switch_scene` with `{scene: name}` through `CallVendorRequest`. Horizontal switches use `SetCurrentProgramScene`, including when OBS is in Studio Mode.

Create one scene named `Vertical Output` manually in the Restream Vertical dock. Each BC-prefixed horizontal scene appears once as a paired button. For example, `BC - Car` selects that main program scene and enables `BC - Car (Vertical)` inside `Vertical Output`. A matching portrait scene has the same name with `(Vertical)` appended. If none exists, the main horizontal scene is used in the portrait output, rotated 90° clockwise and scaled proportionally to fit (with letterboxing if needed). Ambiguous counterparts still disable the button. Source references are added as needed, and other nested broadcast scenes are disabled. Unrelated overlays and sources are untouched. Main scene contents are never modified.

Both selections are confirmed through OBS. The API operations are sequential, not frame-atomic. Portrait is switched first; a subsequent horizontal failure is reported explicitly and the actual output indicators are refreshed. These links apply to controller buttons, not to scene selections made directly in OBS.

Existing dedicated portrait source transforms are preserved. Horizontal fallbacks are centered, rotated, and fitted on every selection, using the current portrait canvas dimensions. A new dedicated portrait source copies an existing portrait scene's framing; the first source in an empty wrapper is fitted inside the portrait canvas. Adjust framing in OBS as needed, especially if your main scenes contain rotated content. The active button is derived from actual source visibility and the selected dock scene, so changes made directly in OBS are reflected on the phone. Source visibility is restored if a switch fails. The app does not create vertical canvases or dock scenes. Persistence across an OBS restart still needs verification with your plugin installation.

Vertical switches are verified against the current scene because the plugin can acknowledge a request without actually changing scenes. Scene links configured in OBS may cause a switch to affect both canvases; remove those links if you want independent switching. Multiple vertical canvases are not supported: the plugin's switch request broadcasts to its docks, while current scene returns the first matching dock. Use one vertical dock/canvas.

## Validation

```sh
npm test
npm run build
npm run lint
npx tsc --noEmit
```

Protocol tests use a fake OBS client to verify separation of outputs, discovery, vendor errors, and confirmation of asynchronous switches. Live verification requires your running OBS instance and configured vertical scenes.
