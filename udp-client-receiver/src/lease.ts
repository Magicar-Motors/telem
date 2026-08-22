/**
 * Keeps a UDP subscription alive on the car.
 *
 * The car only sends to endpoints holding a live lease, so if this laptop
 * disappears the lease lapses and the car stops spending uplink on it. The
 * flip side is that we have to keep renewing, and keep retrying forever when
 * the car is simply off — which is the normal state between sessions.
 */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;

export interface LeaseKeeperOptions {
  jetsonUrl: string;
  udpPort: number;
  ttlMs: number;
}

export class LeaseKeeper {
  private opts: LeaseKeeperOptions;
  private leaseId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RETRY_MIN_MS;
  private stopped = false;

  /** True while we hold a lease the car has acknowledged. */
  ok = false;

  constructor(opts: LeaseKeeperOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    void this.subscribe();
  }

  private schedule(ms: number, fn: () => void): void {
    if (this.stopped) return;
    this.timer = setTimeout(fn, ms);
  }

  private async subscribe(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await fetch(`${this.opts.jetsonUrl}/live/udp/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: this.opts.udpPort, ttlMs: this.opts.ttlMs }),
      });
      if (!res.ok) throw new Error(`subscribe returned ${res.status}`);

      const body = (await res.json()) as { lease: string; addr: string; port: number };
      this.leaseId = body.lease;
      this.ok = true;
      this.retryDelay = RETRY_MIN_MS;
      console.log(`[lease] subscribed — car will send to ${body.addr}:${body.port}`);

      // Renew at a third of the TTL so a couple of lost renewals are survivable.
      this.schedule(this.opts.ttlMs / 3, () => void this.renew());
    } catch (err) {
      this.ok = false;
      console.warn(`[lease] subscribe failed (${(err as Error).message}), retrying in ${this.retryDelay}ms`);
      this.schedule(this.retryDelay, () => void this.subscribe());
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    }
  }

  private async renew(): Promise<void> {
    if (this.stopped || !this.leaseId) return;
    try {
      const res = await fetch(`${this.opts.jetsonUrl}/live/udp/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lease: this.leaseId }),
      });

      // 404 means the car forgot us — it restarted, or we lapsed. Re-subscribe
      // rather than renewing a lease that no longer exists.
      if (res.status === 404) {
        console.warn("[lease] lease unknown to the car, re-subscribing");
        this.leaseId = null;
        this.ok = false;
        void this.subscribe();
        return;
      }
      if (!res.ok) throw new Error(`renew returned ${res.status}`);

      this.ok = true;
      this.schedule(this.opts.ttlMs / 3, () => void this.renew());
    } catch (err) {
      this.ok = false;
      console.warn(`[lease] renew failed (${(err as Error).message}), re-subscribing in ${this.retryDelay}ms`);
      this.schedule(this.retryDelay, () => void this.subscribe());
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    }
  }

  /** Best-effort release so the car stops sending immediately rather than at TTL. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ok = false;
    if (!this.leaseId) return;
    try {
      await fetch(`${this.opts.jetsonUrl}/live/udp/subscribe?lease=${encodeURIComponent(this.leaseId)}`, {
        method: "DELETE",
      });
      console.log("[lease] released");
    } catch {
      // The car will reap it on TTL anyway.
    }
    this.leaseId = null;
  }
}
