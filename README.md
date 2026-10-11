# RocketSim

A physics-first solar-system spaceflight game: real scale, JPL ephemerides, n-body
propagation, photorealistic planets. It's in early development; see `docs/PROGRESS.md`.

```bash
cargo test --workspace                 # physics core tests
cargo run -p sim-cli -- time 2026-11-01T00:00:00Z
./scripts/build-wasm.sh                # needs wasm-bindgen-cli 0.2.129
npm --prefix web ci && npm --prefix web run dev
```

Conventions: `CLAUDE.md`. Decisions: `docs/decisions.md`. Data sources: `CREDITS.md`.
