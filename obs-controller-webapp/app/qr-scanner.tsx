"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { parseObsQr, retainCurrentHost } from "../lib/qr.mjs";

type Connection = { address: string; password: string };
export default function QrScanner({
  currentAddress,
  onScan,
  onClose,
}: {
  currentAddress: string;
  onScan: (c: Connection) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const [camera, setCamera] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [keepHost, setKeepHost] = useState(true);

  function stop() {
    generation.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  useEffect(() => {
    const hide = () => {
      if (document.hidden) {
        stop();
        setCamera(false);
        setWorking(false);
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);

  function accept(text: string) {
    const scanned = parseObsQr(text);
    const connection = keepHost
      ? retainCurrentHost(scanned, currentAddress)
      : scanned;
    stop();
    onScan(connection);
  }

  function decode(source: CanvasImageSource, width: number, height: number) {
    if (!width || !height) return null;
    const scale = Math.min(1, 1800 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new Error(
        "Your browser could not read the image. Try another browser.",
      );
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return (
      jsQR(pixels.data, pixels.width, pixels.height, {
        inversionAttempts: "attemptBoth",
      })?.data ?? null
    );
  }

  useEffect(() => {
    if (!camera) return;
    const timer = setInterval(() => {
      const source = video.current;
      if (!source || source.readyState < 2) return;
      try {
        const code = decode(source, source.videoWidth, source.videoHeight);
        if (code) accept(code);
      } catch (e) {
        stop();
        setCamera(false);
        setError(
          e instanceof Error ? e.message : "Could not read the QR code.",
        );
      }
    }, 350);
    return () => clearInterval(timer);
  });

  async function startCamera() {
    stop();
    setError("");
    setWorking(true);
    const token = generation.current;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Live scanning needs HTTPS or localhost. On this Tailscale HTTP page, use Take photo or Choose image below.",
        );
      }
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (token !== generation.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      if (!video.current) {
        stop();
        return;
      }
      video.current.srcObject = media;
      await video.current.play();
      if (token === generation.current) setCamera(true);
    } catch (e) {
      if (token === generation.current) {
        stop();
        setCamera(false);
        setError(
          e instanceof DOMException
            ? "Camera unavailable or permission denied. Use Take photo or Choose image instead."
            : e instanceof Error
              ? e.message
              : "Could not open the camera.",
        );
      }
    } finally {
      setWorking(false);
    }
  }

  async function readImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    stop();
    setCamera(false);
    setError("");
    setWorking(true);
    const token = generation.current;
    let objectUrl = "";
    try {
      if (file.size > 25 * 1024 * 1024)
        throw new Error("Choose an image smaller than 25 MB.");
      objectUrl = URL.createObjectURL(file);
      const source = new Image();
      source.src = objectUrl;
      await source.decode();
      if (token !== generation.current) return;
      const code = decode(source, source.naturalWidth, source.naturalHeight);
      if (!code)
        throw new Error(
          "No QR code found. Try a clear, close-up photo showing the whole code.",
        );
      accept(code);
    } catch (e) {
      if (token === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : "Could not read this image. Try a PNG or JPEG.",
        );
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setWorking(false);
    }
  }

  return (
    <section className="qr-panel" aria-label="Scan OBS connection QR">
      <div className="qr-heading">
        <h3>Scan OBS QR code</h3>
        <button type="button" className="quiet" onClick={onClose}>
          Close scanner
        </button>
      </div>
      <p>
        In OBS: Tools → WebSocket Server Settings → Show Connect Info. Scan the
        code to fill your connection details, then tap Connect to OBS.
      </p>
      <label className="qr-host">
        <input
          type="checkbox"
          checked={keepHost}
          onChange={(e) => setKeepHost(e.target.checked)}
        />
        Keep current server host (Tailscale)
      </label>
      <small>
        OBS usually puts a local Wi-Fi address in its QR code. Keep this checked
        to import the password and port while retaining your current host.
      </small>
      <video
        ref={video}
        muted
        playsInline
        className={camera ? "qr-video" : "qr-video qr-inactive"}
        aria-label="QR camera preview"
      />
      <div className="qr-actions">
        <button
          type="button"
          className="quiet"
          disabled={working}
          onClick={() => {
            if (camera) {
              stop();
              setCamera(false);
            } else void startCamera();
          }}
        >
          {camera ? "Stop camera" : "Live camera"}
        </button>
        <label className="quiet qr-file">
          Take photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={working}
            onChange={readImage}
          />
        </label>
        <label className="quiet qr-file">
          Choose image
          <input
            type="file"
            accept="image/*"
            disabled={working}
            onChange={readImage}
          />
        </label>
      </div>
      <small>
        Photos are decoded on this device and are never uploaded. Live camera
        scanning requires HTTPS; photo scanning works over HTTP.
      </small>
      {working && <p role="status">Opening camera or reading image…</p>}
      {error && (
        <p className="qr-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
