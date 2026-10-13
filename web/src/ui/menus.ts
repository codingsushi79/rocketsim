// Main menu, mission select, credits and pause menu.

import { SCENARIOS, type Scenario } from "../sim/simulation";
import { deleteSave, exportSave, importSave, listSaves, type SaveGame } from "../sim/saves";
import { CREDITS } from "./credits";
import { isDesktop, quitApp } from "../desktop";
import { clear, h } from "./dom";

export interface MenuActions {
  startMission(s: Scenario): void;
  openSettings(back: () => void): void;
  resume(): void;
  toMainMenu(): void;
  /** Save the running game under `name`; returns an error text or null. */
  saveGame(name: string): string | null;
  loadGame(s: SaveGame): Promise<string | null>;
  /** Enter the replay player; false when nothing is recorded yet. */
  replay(): boolean;
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
          listSaves()[0] ? h("button", { id: "btn-continue", onclick: () => void this.load(listSaves()[0]!, () => this.main()) }, "Continue") : null,
          h("button", { id: "btn-load", onclick: () => this.loadList(() => this.main()) }, "Load Mission"),
          h("button", { id: "btn-settings", onclick: () => this.actions.openSettings(() => this.main()) }, "Settings"),
          h("button", { id: "btn-credits", onclick: () => this.credits() }, "Credits"),
          isDesktop() ? h("button", { id: "btn-quit", onclick: () => void quitApp() }, "Quit to Desktop") : null,
        ),
        h("div", { class: "version" }, `sim-core ${this.version} · milestone 10 build${isDesktop() ? " · desktop" : ""}`),
      ),
    );
  }

  missions(): void {
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
          h("button", { id: "btn-save", onclick: () => this.saveDialog() }, "Save Game"),
          h("button", { id: "btn-load-pause", onclick: () => this.loadList(() => this.pause()) }, "Load Game"),
          h("button", { id: "btn-replay", onclick: () => (this.actions.replay() ? undefined : this.message("Nothing recorded yet: fly for a little while first.", () => this.pause())) }, "Watch Replay"),
          h("button", { onclick: () => this.actions.openSettings(() => this.pause()) }, "Settings"),
          h("button", { onclick: () => this.actions.toMainMenu() }, "Main Menu"),
          isDesktop() ? h("button", { onclick: () => void quitApp() }, "Quit to Desktop") : null,
        ),
      ),
    );
  }

  private message(text: string, back: () => void): void {
    this.show(h("div", { class: "menu-panel" }, h("h2", {}, "RocketSim"), h("p", { class: "note" }, text), h("div", { class: "menu-footer" }, h("button", { onclick: back }, "OK"))));
  }

  private async load(s: SaveGame, back: () => void): Promise<void> {
    const err = await this.actions.loadGame(s);
    if (err) this.message(`Could not load “${s.name}”: ${err}`, back);
  }

  saveDialog(): void {
    const def = `Save ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const inp = h("input", { type: "text", class: "key-input", value: def, maxlength: "60", id: "save-name" }) as HTMLInputElement;
    const status = h("p", { class: "note" });
    const doSave = () => {
      const err = this.actions.saveGame(inp.value.trim() || def);
      if (err) status.textContent = err;
      else this.pause();
    };
    inp.addEventListener("keydown", (e) => e.key === "Enter" && doSave());
    this.show(
      h(
        "div",
        { class: "menu-panel" },
        h("h2", {}, "Save game"),
        inp,
        status,
        h("div", { class: "menu-footer" }, h("button", { onclick: () => this.pause() }, "Cancel"), h("button", { class: "primary", id: "btn-save-confirm", onclick: doSave }, "Save")),
      ),
    );
    inp.focus();
    inp.select();
  }

  loadList(back: () => void): void {
    const saves = listSaves();
    const mission = (id: string) => SCENARIOS.find((m) => m.id === id)?.name ?? id;
    this.show(
      h(
        "div",
        { class: "menu-panel wide" },
        h("h2", {}, "Load mission"),
        saves.length === 0 ? h("p", { class: "note" }, "No saved games yet. Press F5 in flight to quicksave, or use Save Game in the pause menu.") : null,
        h(
          "div",
          { class: "mission-list" },
          ...saves.map((s) =>
            h(
              "div",
              { class: "save-row" },
              h("button", { class: "mission", onclick: () => void this.load(s, back) }, h("div", { class: "mission-name" }, s.name), h("div", { class: "mission-desc" }, mission(s.missionId)), h("div", { class: "mission-epoch" }, `${s.utc.replace("T", " ").slice(0, 19)} UTC`)),
              h("div", { class: "save-actions" }, h("button", { title: "Export to a file", onclick: () => exportSave(s) }, "Export"), h("button", { title: "Delete", onclick: () => (deleteSave(s.id), this.loadList(back)) }, "Delete")),
            ),
          ),
        ),
        h(
          "div",
          { class: "menu-footer" },
          h("button", { onclick: async () => {
            const s = await importSave();
            if (s) void this.load(s, back);
          } }, "Import file…"),
          h("button", { onclick: back }, "Back"),
        ),
      ),
    );
  }
}
