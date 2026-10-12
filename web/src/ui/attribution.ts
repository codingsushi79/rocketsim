// On-screen attribution for streamed surface data:
// - Google Maps (Map Tiles API policies, read 2026-10-12): the official "Google Maps"
//   logo, unmodified, outlined variant, 18 px (policy 16–19 dp) with clear space and the
//   label "Google Maps"; plus the aggregated per-tile copyrights, never hardcoded.
// - Cesium ion (terms of service): the attributions ion returns for each asset (the ion
//   logo, data providers such as Bing/Maxar), shown as given. They arrive as HTML from
//   api.cesium.com and are sanitised to links, images and text.
// - A disclosure of which parts of the scene are third-party data and which are ours.
// No other logo shares the Google logo's space; the HUD moves up so nothing overlaps.

import { h } from "./dom";

/** Keep only <a href=https>, <img src=https alt>, <span>, <br> and text. */
export function sanitizeAttribution(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const out = document.createDocumentFragment();
  const walk = (src: Node, dst: Node) => {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(n.textContent ?? ""));
        continue;
      }
      if (!(n instanceof Element)) continue;
      const tag = n.tagName.toLowerCase();
      let el: HTMLElement | null = null;
      if (tag === "a") {
        const href = n.getAttribute("href") ?? "";
        el = document.createElement("a");
        if (/^https:\/\//.test(href)) {
          el.setAttribute("href", href);
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
      } else if (tag === "img") {
        const src2 = n.getAttribute("src") ?? "";
        if (!/^https:\/\//.test(src2)) continue;
        el = document.createElement("img");
        el.setAttribute("src", src2);
        el.setAttribute("alt", n.getAttribute("alt") ?? "");
        el.className = "attrib-img";
      } else if (tag === "span" || tag === "div" || tag === "p") {
        el = document.createElement("span");
      } else if (tag === "br") {
        dst.appendChild(document.createTextNode(" "));
        continue;
      }
      if (el) {
        walk(n, el);
        dst.appendChild(el);
      } else {
        walk(n, dst);
      }
    }
  };
  walk(doc.body.firstChild!, out);
  return out;
}

export class SurfaceAttribution {
  readonly root = h(
    "div",
    { class: "google-attrib hidden", id: "google-attrib", role: "contentinfo" },
    h("img", {
      class: "google-logo",
      src: "assets/google/GoogleMaps_Logo_WithDarkOutline.svg",
      alt: "Google Maps",
      "aria-label": "Google Maps",
      height: 18,
      draggable: "false",
    }),
    h("span", { class: "google-data", id: "google-data" }),
    h("span", { class: "ion-data", id: "ion-data" }),
    h("span", { class: "google-hybrid", id: "surface-hybrid" }),
  );
  private logo = this.root.querySelector<HTMLElement>(".google-logo")!;
  private data = this.root.querySelector<HTMLElement>("#google-data")!;
  private ion = this.root.querySelector<HTMLElement>("#ion-data")!;
  private hybrid = this.root.querySelector<HTMLElement>("#surface-hybrid")!;
  private last = "";

  /** Show the attributions while third-party tiles are on screen. */
  update(a: { text: string; html: string[]; google: boolean } | null, hud: HTMLElement): void {
    const on = a !== null && (a.text.length > 0 || a.html.length > 0);
    this.root.classList.toggle("hidden", !on);
    hud.classList.toggle("attrib-on", on);
    if (!a || !on) return;
    const key = `${a.google}|${a.text}|${a.html.join("|")}`;
    if (key === this.last) return;
    this.last = key;
    this.logo.style.display = a.google ? "" : "none";
    this.data.textContent = a.text;
    this.ion.replaceChildren(...a.html.map((x) => h("span", { class: "ion-item" }, sanitizeAttribution(x) as unknown as Node)));
    this.hybrid.textContent = a.google
      ? "3D Earth surface near the camera: Google Maps · spacecraft, orbits, clouds, atmosphere and sky: RocketSim"
      : "Terrain and imagery near the camera: Cesium ion and its data providers · everything else: RocketSim";
  }
}
