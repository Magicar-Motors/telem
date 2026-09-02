import "./util-gauge.css";

/** Session traction utilisation, shared by the dashboard and the review page.
 *  Both compute the number differently — live accumulates it, review fits it
 *  over the session's laps — so this only renders. */

const SEGMENTS = 20;

export interface UtilGaugeState {
  meanU: number | null;   // 0-1+, null when there is nothing to show yet
  muY: number;            // g
  muX: number;            // g
  mode: string;           // shown next to the number; the spec asks for this
  sampleCount: number;
  lapsUsed?: number;      // laps that fed the envelope
  lapsTotal?: number;     // laps in the session
  incomplete?: boolean;   // a lap could not be fetched, so coverage is short
}                         // through no choice of ours — worth flagging apart
                          // from a pit lap being correctly left out

export interface UtilGauge {
  el: HTMLElement;
  set(state: UtilGaugeState | null): void;
}

/** Dim below half, accent through the useful band, red as it approaches the
 *  envelope — the same reading as the rest of the gauges. */
function segColor(i: number, total: number): string {
  const f = (i + 1) / total;
  if (f > 0.85) return "#ff4436";
  if (f > 0.6) return "#ff7b45";
  return "#e0b020";
}

export function createUtilGauge(className = ""): UtilGauge {
  const el = document.createElement("div");
  el.className = `util-gauge ${className}`.trim();

  const head = document.createElement("div");
  head.className = "util-gauge-head";
  head.innerHTML =
    `<span class="util-gauge-label">牽引 TRACTION</span>` +
    `<span class="util-gauge-value">--<span class="util-gauge-unit">%</span></span>`;

  const track = document.createElement("div");
  track.className = "util-gauge-track";
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = document.createElement("div");
    seg.className = "util-gauge-seg";
    track.appendChild(seg);
  }

  const foot = document.createElement("div");
  foot.className = "util-gauge-foot";
  foot.textContent = "--";

  el.append(head, track, foot);

  const valueEl = head.querySelector(".util-gauge-value") as HTMLElement;

  function set(state: UtilGaugeState | null): void {
    if (!state || state.meanU === null) {
      valueEl.innerHTML = `--<span class="util-gauge-unit">%</span>`;
      foot.textContent = "--";
      for (const seg of track.children) {
        const s = seg as HTMLElement;
        s.style.background = "";
        s.style.borderColor = "";
        s.style.boxShadow = "";
      }
      return;
    }

    const pct = state.meanU * 100;
    valueEl.innerHTML = `${pct.toFixed(0)}<span class="util-gauge-unit">%</span>`;
    const laps = state.lapsTotal
      ? ` · ${state.lapsUsed ?? 0}/${state.lapsTotal} laps`
      : "";
    foot.textContent =
      `μy ${state.muY.toFixed(2)} μx ${state.muX.toFixed(2)} g · ${state.mode}${laps}`;
    foot.classList.toggle("util-gauge-partial", state.incomplete === true);

    const lit = Math.round(Math.min(1, state.meanU) * SEGMENTS);
    for (let i = 0; i < track.children.length; i++) {
      const s = track.children[i] as HTMLElement;
      if (i < lit) {
        const c = segColor(i, SEGMENTS);
        s.style.background = c;
        s.style.borderColor = c;
        s.style.boxShadow = `0 0 6px ${c}40`;
      } else {
        s.style.background = "";
        s.style.borderColor = "";
        s.style.boxShadow = "";
      }
    }
  }

  return { el, set };
}
