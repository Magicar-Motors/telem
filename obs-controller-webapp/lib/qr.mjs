/** Decode OBS's connection QR without retaining the credential-bearing URI. */
export function parseObsQr(text) {
  try {
    const match = /^(obsws|obswss):\/\/([^/\s?#]+)(?:\/(.*))?$/i.exec(
      text.trim(),
    );
    if (!match) throw new Error();
    const url = new URL(
      `${match[1].toLowerCase() === "obswss" ? "wss" : "ws"}://${match[2]}`,
    );
    if (!url.hostname || url.username || url.password || url.search || url.hash)
      throw new Error();
    if (!/:\d+$/.test(match[2])) url.port = "4455";
    return {
      address: url.origin,
      password: decodeURIComponent(match[3] ?? ""),
    };
  } catch {
    throw new Error(
      "This is not a valid OBS connection QR code. Use Show Connect Info in OBS WebSocket Server Settings.",
    );
  }
}

/** @param {{address: string, password: string}} scanned */
export function retainCurrentHost(scanned, currentAddress) {
  try {
    const current = new URL(currentAddress);
    if (!["ws:", "wss:"].includes(current.protocol) || !current.hostname)
      throw new Error();
    const target = new URL(scanned.address);
    target.hostname = current.hostname;
    return { ...scanned, address: target.origin };
  } catch {
    throw new Error(
      "Enter a valid current OBS address first, or uncheck Keep current server host.",
    );
  }
}
