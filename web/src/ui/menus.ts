// Main menu, mission select, credits and pause menu.

import { SCENARIOS, type Scenario } from "../sim/simulation";
import { CREDITS } from "./credits";
import { isDesktop, quitApp } from "../desktop";
import { clear, h } from "./dom";

export interface MenuActions {
  startMission(s: Scenario): void;
  openSettings(back: () => void): void;
  resume(): void;
  toMainMenu(): void;
}

export class Menus {
  readonly root: HTMLElement;

  constructor(readonly actions: MenuActions, private version: string) {
    this.root = h("div", { class: "menu-root", id: "menu" });
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  private show(...content: HTMLElement[]): void {
    clear(this.root);
    this.root.classList.remove("hidden");
    this.root.append(...content);
  }

  main(): void {
    this.show(
      h(
        "div",
        { class: "menu-panel main" },
        h("div", { class: "title" }, "ROCKETSIM"),
        h("div", { class: "subtitle" }, "Real ephemerides · n-body propagation · real scale"),
        h(
          "nav",
          { class: "menu-buttons" },
          h("button", { class: "primary", id: "btn-new", onclick: () => this.missions() }, "New Mission"),
          h("button", { disabled: true, title: "Save/load arrives in M10" }, "Load Mission"),
          h("button", { id: "btn-settings", onclick: () => this.actions.openSettings(() => this.main()) }, "Settings"),
          h("button", { id: "btn-credits", onclick: () => this.credits() }, "Credits"),
          isDesktop() ? h("button", { id: "btn-quit", onclick: () => void quitApp() }, "Quit to Desktop") : null,
        ),
        h("div", { class: "version" }, `sim-core ${this.version} · milestone 7 build${isDesktop() ? " · desktop" : ""}`),
      ),
    );
  }

  missions(): void {
    const upcoming = [
      { name: "Lunar flyby", note: "Transfer planner arrives in M9" },
      { name: "Earth → Mars", note: "Transfer planner arrives in M9" },
    ];
    this.show(
      h(
        "div",
        { class: "menu-panel wide" },
        h("h2", {}, "Select mission"),
        h(
          "div",
          { class: "mission-list" },
          ...SCENARIOS.map((s) =>
            h(
              "button",
              { class: "mission", id: `mission-${s.id}`, onclick: () => this.actions.startMission(s) },
              h("div", { class: "mission-name" }, s.name),
              h("div", { class: "mission-desc" }, s.description),
              h("div", { class: "mission-epoch" }, `Epoch ${s.epochUtc.replace("T", " ").replace("Z", " UTC")}`),
            ),
          ),
          ...upcoming.map((u) =>
            h("button", { class: "mission", disabled: true }, h("div", { class: "mission-name" }, u.name), h("div", { class: "mission-desc" }, u.note)),
          ),
        ),
        h("div", { class: "menu-footer" }, h("button", { onclick: () => this.main() }, "Back")),
      ),
    );
  }

  credits(): void {
    this.show(
      h(
        "div",
        { class: "menu-panel wide" },
        h("h2", {}, "Credits"),
        h(
          "div",
          { class: "credits" },
          ...CREDITS.map((c) =>
            h("div", { class: "credit" }, h("div", { class: "credit-what" }, c.what), h("div", { class: "credit-who" }, c.who, c.note ? ` · ${c.note}` : "")),
          ),
        ),
        h("div", { class: "menu-footer" }, h("button", { onclick: () => this.main() }, "Back")),
      ),
    );
  }

  pause(): void {
    this.show(
      h(
        "div",
        { class: "menu-panel" },
        h("h2", {}, "Paused"),
        h(
          "nav",
          { class: "menu-buttons" },
          h("button", { class: "primary", id: "btn-resume", onclick: () => this.actions.resume() }, "Resume"),
          h("button", { onclick: () => this.actions.openSettings(() => this.pause()) }, "Settings"),
          h("button", { onclick: () => this.actions.toMainMenu() }, "Main Menu"),
          isDesktop() ? h("button", { onclick: () => void quitApp() }, "Quit to Desktop") : null,
        ),
      ),
    );
  }
}
