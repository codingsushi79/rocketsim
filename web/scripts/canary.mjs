// Prints the WASM build's determinism canary. CI compares it with `simctl canary`.
import { readFileSync } from "node:fs";
import { initSync, canary } from "../src/wasm/sim_wasm.js";

const wasmUrl = new URL("../src/wasm/sim_wasm_bg.wasm", import.meta.url);
initSync({ module: readFileSync(wasmUrl) });
console.log(canary());
