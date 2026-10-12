# RocketSim

A physics-first solar-system spaceflight game: real scale, JPL ephemerides, n-body
propagation, photorealistic planets. It's in early development; see `docs/PROGRESS.md`.

## Play

RocketSim is a desktop application.

- **Windows:** open the repository's **Releases → nightly** and download
  `RocketSim-portable.exe` (just run it) or `RocketSim_…_x64-setup.exe` (installs per
  user, no admin rights). It needs Microsoft Edge WebView2, which ships with Windows 10/11.
- **macOS:** download `RocketSim-macos.zip` from the same release, unzip it, then
  right-click `RocketSim.app` → Open (the build is not signed yet).

Every push to `main` rebuilds the nightly; tagged versions (`v*`) become releases.

**Earth 3D tiles (optional).** Near the surface, RocketSim can stream Google Photorealistic
3D Tiles. Enter your own Map Tiles API key in **Settings → Earth**; it's stored only on your
machine. Without a key the game uses NASA imagery only and never contacts Google.

## Build and run locally

```bash
./scripts/build-wasm.sh                  # physics core → WebAssembly (needs wasm-bindgen-cli 0.2.129)
npm --prefix web ci
npm --prefix desktop ci
npm --prefix desktop run dev             # the desktop app with live reload
npm --prefix desktop run build:mac       # or build:windows: a packaged app
```

Ephemeris files go in `web/public/ephemeris/`. Build them with
`cargo run --release -p ephem-build -- build` after `./scripts/fetch-kernels.sh`, or run
`npm --prefix web run fixtures` for the small test window.

## Develop

```bash
cargo test --workspace                   # physics core tests
cargo run -p sim-cli -- time 2026-11-01T00:00:00Z
npm --prefix web run dev                 # the same game in a browser tab, for quick iteration
PW_CHANNEL=chrome npm --prefix web run test:e2e
```

Conventions: `CLAUDE.md`. Decisions: `docs/decisions.md`. Data sources: `CREDITS.md`.
