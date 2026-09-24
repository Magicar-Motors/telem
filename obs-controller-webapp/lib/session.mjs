export const SESSION_KEY = "scene-deck-session";
export const SESSION_TTL = 12 * 60 * 60 * 1000;

export function clearSession(storage) {
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    /* Storage may be blocked. */
  }
}

export function readSession(storage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(SESSION_KEY) || "null");
    if (!saved) return null;
    const url = new URL(saved.address);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      typeof saved.password !== "string" ||
      !Number.isFinite(saved.expiresAt) ||
      saved.expiresAt <= now ||
      saved.expiresAt > now + SESSION_TTL
    ) {
      clearSession(storage);
      return null;
    }
    return {
      address: saved.address,
      password: saved.password,
      expiresAt: saved.expiresAt,
    };
  } catch {
    clearSession(storage);
    return null;
  }
}

export function saveSession(storage, address, password, now = Date.now()) {
  try {
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({ address, password, expiresAt: now + SESSION_TTL }),
    );
    return true;
  } catch {
    return false;
  }
}
