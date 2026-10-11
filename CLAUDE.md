# RocketSim: conventions for working in this repo

A physics-first solar-system spaceflight **game** (Orbiter / KSP+Principia class, more
rigorous). **Physics correctness is the top priority**, above visuals and above features.
The decisions log is `docs/decisions.md`; any change to a decision needs the owner's sign-off.

## Workflow
- Work milestone by milestone (see `docs/PROGRESS.md`). Before a milestone, write
  `docs/plans/Mn-*.md` and raise open questions. At the end: demo, update PROGRESS.md,
  then **wait for the owner's go-ahead**.
- Small, descriptive commits.
- Prefer established, cited algorithms and rigorous libraries over inventing your own.
  Put a reference comment (paper, textbook section, JPL doc) on any non-obvious physics.
- When something is uncertain, measure it and say so. Don't paper over it.

## Layout
- `crates/sim-core`: physics core. **No rendering/DOM/browser deps.** Headless.
- `crates/sim-cli`: `simctl`, the headless driver.
- `crates/sim-wasm`: thin wasm-bindgen layer with no logic.
- `web/`: Vite + TS + three.js app. Build the core with `npm --prefix web run wasm`.
- `data/`: versioned source datasets. `tools/`: offline pipelines and fixture generators.

## Physics core rules
- **f64 everywhere.** Never store a solar-system-scale position in an f32. Rendering
  converts to f32 only after subtracting the camera's f64 position (floating origin).
- **SI units internally, no exceptions**: m, s, kg, rad. Convert at I/O boundaries only.
- **Time:** the physics clock is `time::Epoch` (TDB, split seconds past J2000 TDB).
  UTC is for display and scenario input only.
- **Frames are explicit in types** (`frames.rs`): `StateIcrfSsb`, `StateIcrfBody`,
  `StateBodyFixed`, `StateLvlh`, `VecScBody`, … Every conversion is a named function
  with tests. Frame centers are runtime `BodyId`s (NAIF IDs) and get checked.
- **No magic numbers.** Physical constants come only from `constants.rs`, with a source
  comment on each. Values copied from kernels are checked by `tests/constants_vs_kernels.rs`.
- **Determinism (D8):** same inputs plus same build give a bit-identical result, native
  and WASM alike.
  - Transcendental math only via `math::fmath` (libm). Clippy bans the std methods.
  - No FMA, no `powi`, no parallel float reductions, no HashMap iteration order in
    physics, no wall-clock time in the core.
  - The canary golden (`determinism.rs`) changes only on purpose. Say why in the commit.
- **Spacecraft are data** (config files). No spacecraft-specific code paths in the core.
- Every physics module ships with tests against analytic results or published
  reference data, with the fixture's source recorded.

## Data and credits
- Every external dataset, texture or model gets a `CREDITS.md` entry: URL, license,
  date retrieved, required attribution.
- Secrets (e.g. the Google Map Tiles API key) come from env vars. Never commit them.
- Google Photorealistic 3D Tiles: stream only; follow the Map Tiles API policies
  (logo, attributions, no caching beyond the policy, no geometry extraction). Read the
  current policy before touching that code.

## Commands
```bash
cargo test --workspace                       # all core tests
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p sim-cli -- time 2026-11-01T00:00:00Z
./scripts/build-wasm.sh && npm --prefix web run dev
```
