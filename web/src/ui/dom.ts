// Minimal DOM helpers (no framework).

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Display units (the physics is SI regardless). */
export type Units = "si" | "imperial";
let units: Units = "si";
export function setDisplayUnits(u: Units): void {
  units = u;
}
const FT = 0.3048; // m, exact (international foot)
const NMI = 1852; // m, exact (international nautical mile)

/** Formats a length with sensible units: SI (m, km, Mm) or imperial (ft, nmi); AU beyond
 *  0.1 AU in both. */
export function fmtLength(m: number): string {
  if (!Number.isFinite(m)) return "—";
  const a = Math.abs(m);
  if (units === "imperial" && a < 1.495978707e10) {
    if (a >= NMI) return `${(m / NMI).toFixed(a >= 1e7 ? 0 : 1)} nmi`;
    return `${(m / FT).toFixed(0)} ft`;
  }
  if (a >= 1.495978707e10) return `${(m / 1.495978707e11).toFixed(3)} AU`;
  if (a >= 1e7) return `${(m / 1e6).toFixed(1)} Mm`;
  if (a >= 1e4) return `${(m / 1e3).toFixed(1)} km`;
  if (a >= 1e3) return `${(m / 1e3).toFixed(2)} km`;
  return `${m.toFixed(1)} m`;
}

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return "—";
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${p(hh)}:${p(mm)}:${p(ss)}` : `${p(hh)}:${p(mm)}:${p(ss)}`;
}

export function fmtWarp(w: number): string {
  return w >= 1e6 ? `${w / 1e6}M×` : w >= 1e3 ? `${w / 1e3}k×` : `${w}×`;
}

/** Formats a speed: SI (m/s, km/s) or imperial (ft/s). */
export function fmtSpeed(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return "—";
  if (units === "imperial") return `${(v / FT).toFixed(0)} ft/s`;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(digits)} km/s` : `${v.toFixed(1)} m/s`;
}
