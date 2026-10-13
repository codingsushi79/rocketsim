// Collapsible HUD panels: click a panel's title to fold it to its title bar, to see more
// of the view. The state is a per-viewer convenience (local storage, optional).

const KEY = "rocketsim.collapsed.v1";

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function save(s: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // Storage unavailable: the state just isn't remembered.
  }
}

/** Panels (by class) that can be folded. */
const PANELS = ["hud-orbit", "hud-prop", "hud-navball", "map-panel", "transfer-panel"];

function panelOf(el: Element): { el: HTMLElement; key: string } | null {
  for (const k of PANELS) {
    const p = el.closest(`.${k}`);
    if (p instanceof HTMLElement) return { el: p, key: k };
  }
  return null;
}

/** Apply the remembered state to panels under `root` (call after rebuilding them). */
export function applyCollapsed(root: ParentNode): void {
  const s = load();
  for (const k of PANELS) root.querySelectorAll<HTMLElement>(`.${k}`).forEach((p) => setFolded(p, s.has(k)));
}

function setFolded(p: HTMLElement, on: boolean): void {
  p.classList.toggle("collapsed", on);
  p.querySelectorAll(":scope > .fold").forEach((b) => (b.textContent = on ? "+" : "–"));
}

/** Clicks on a panel title (or a .fold button) fold or unfold that panel. */
export function installCollapsible(root: HTMLElement): void {
  root.addEventListener("click", (e) => {
    const t = e.target as Element | null;
    const hit = t?.closest(".panel-title:not(.sub), .fold");
    if (!hit) return;
    const p = panelOf(hit);
    if (!p) return;
    // Only the panel's own (first) title folds it.
    if (hit.classList.contains("panel-title") && p.el.querySelector(".panel-title") !== hit) return;
    const s = load();
    const on = !p.el.classList.contains("collapsed");
    setFolded(p.el, on);
    if (on) s.add(p.key);
    else s.delete(p.key);
    save(s);
    e.stopPropagation();
  });
  applyCollapsed(root);
}
