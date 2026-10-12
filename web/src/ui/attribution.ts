// Google Maps attribution for the 3D tiles (Map Tiles API policies, read 2026-10-12):
// - the official "Google Maps" logo, unmodified: the outlined variant for busy imagery,
//   18 px tall (policy: 16–19 dp), with clear space 10 px left/right/top and 5 px below,
//   and the accessibility label "Google Maps";
// - the aggregated `asset.copyright` strings of the displayed tiles, never hardcoded;
// - a disclosure of which parts of the scene are Google data and which are ours.
// No other logo shares this bar, and the HUD moves up so nothing overlaps it.

import { h } from "./dom";

export class GoogleAttribution {
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
    h("span", { class: "google-hybrid" }, "3D Earth surface near the camera: Google Maps · spacecraft, orbits, clouds, atmosphere and sky: RocketSim"),
  );
  private data = this.root.querySelector<HTMLElement>("#google-data")!;
  private last = "";

  /** Show `text` (aggregated tile copyrights) while tiles are on screen. */
  update(text: string, hud: HTMLElement): void {
    const on = text.length > 0;
    this.root.classList.toggle("hidden", !on);
    hud.classList.toggle("attrib-on", on);
    if (text !== this.last) {
      this.data.textContent = text;
      this.last = text;
    }
  }
}
