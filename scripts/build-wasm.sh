#!/usr/bin/env bash
# Build the physics core to WASM and generate JS bindings into web/src/wasm/.
# Requires: rustup target wasm32-unknown-unknown (pinned in rust-toolchain.toml)
#           wasm-bindgen-cli with the exact version pinned in Cargo.toml.
set -euo pipefail
cd "$(dirname "$0")/.."

want=$(sed -n 's/^wasm-bindgen = "=\(.*\)"/\1/p' Cargo.toml)
have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [[ "$want" != "$have" ]]; then
  echo "wasm-bindgen-cli $want required (found '${have:-none}'):" >&2
  echo "  cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi

profile=${1:-release}
cargo build -p sim-wasm --target wasm32-unknown-unknown --profile "$profile"
dir=$([[ "$profile" == dev ]] && echo debug || echo "$profile")
wasm-bindgen --target web --out-dir web/src/wasm --out-name sim_wasm \
  "target/wasm32-unknown-unknown/$dir/sim_wasm.wasm"
ls -l web/src/wasm/sim_wasm_bg.wasm
