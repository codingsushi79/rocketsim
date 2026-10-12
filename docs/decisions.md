# Decisions log

Decisions confirmed with the project owner. Changing any of these needs their sign-off.

## M0 (2026-10-10)

| # | Topic | Decision |
|---|-------|----------|
| D1 | Platform | Web. TypeScript + Vite + three.js app, `3d-tiles-renderer` for tilesets, physics core in Rust built natively (tests, CLI) and to WASM (browser). UE5 + Cesium for Unreal rejected: it can't be built, run and tested headlessly. |
| D2 | Starting scenario | 400 km circular LEO, 51.6° inclination, epoch 2026-11-01T00:00:00 UTC. Launch from the ground comes later. |
| D3 | Units and time | SI internally, no exceptions. Physics clock is TDB, display is UTC. Leap seconds come from the IERS `Leap_Second.dat` table (Bulletin C). Dates past the table's expiry are flagged *provisional*. UTC before 1972 isn't supported. TT→TDB uses the USNO Circular 179 eq. 2.6 series and is checked against ERFA `dtdb`. |
| D4 | Earth orientation | IERS EOP (finals2000A: UT1−UTC, polar motion) plus IAU 2006/2000A precession-nutation. Past the IERS prediction horizon (~1 year), Earth orientation can be off by up to ~100 m. Accepted. |
| D5 | v1 delta-v | The v1 spacecraft must have **enough delta-v for a lunar flyby from LEO on its own** (TLI ≈ 3.1 km/s plus margin) and still be realistic. That means a target of about 3.3–3.6 km/s, so the wet mass may go above the brief's 10–15 t. It is sized in M5 with a rationale in `docs/spacecraft_v1.md`. Mars departure may still need a data-defined kick stage. |
| D6 | Ephemeris span | Planets and the Moon: 1950–2100. Satellite systems and asteroids: 2000–2100. Converted file size is measured and reported in M2. |
| D7 | Surface contact | Google 3D Tiles are drawn only and never used for collision or landing (policy forbids deriving geometry). Contact physics will use a separate DEM. |
| D8 | Determinism | Bit-identical results between native and WASM builds. The core uses the pure-Rust `libm` crate for every transcendental function, no FMA, and no parallel floating-point reductions. Enforced with clippy `disallowed-methods` and a canary hash compared in CI. |
| D9 | Repository | Private GitHub repository. No license chosen yet (all rights reserved by default). |
| D10 | Performance target | Runs very well at **max settings on an RTX 4070-class GPU**: 1440p at ≥ 60 fps with headroom, in the worst case (LEO with Earth tiles streaming). Lower settings scale down for weaker GPUs. Development runs on an Apple M4, so final 4070 numbers have to be measured by the owner. |
| D11 | Game polish | This is a **game**, not only a simulator. It needs a polished main menu (new game / scenario select / load / settings / credits), a full settings screen (graphics presets up to max for D10, per-feature toggles, audio volumes, controls and rebinding, units, physics tolerance options), and **volumetric clouds** (raymarched, lit by the physical atmosphere model) instead of a flat cloud layer. Schedule: the menu and settings shell come in M4 alongside the first render, so every later feature plugs its settings in as it lands. Volumetric clouds come in M7. Audio and menu polish come in M10. |

## M2 (2026-10-10)

| # | Topic | Decision |
|---|-------|----------|
| D12 | Ephemeris fit tolerance | Positions ≤ 1 m, velocities ≤ 1 cm/s, measured after coefficient quantization. Velocity is the analytic derivative of the position fit. A 1 mm/s limit roughly tripled the short-period moon files with no physical benefit, since the kernels' own uncertainty is far larger. |
| D13 | Uranus body center | Uranus relative to its barycenter comes from ura111xl-799 (approved 2026-10-11). It replaced an interim zero-offset chunk. |
| D14 | Planetary ephemeris version | **DE440** for planets, Sun and Moon. The owner approved DE442 on 2026-10-11, but measurement showed DE442 vs Horizons' DE441 differs by up to 4 km (Mars) and 15 km (Jupiter) over 1950–2092. That fails the spec's "≤ 1 km vs Horizons" check, and the brief names DE440/DE441. Kept from the upgrade: **nep098** for Neptune and Triton (fixes a 709 km Triton gap; Triton now matches Horizons to 0.1 m relative to Neptune) and the Uranus kernel. Switching to DE442 is a one-line change in the fetch script and builder if the owner prefers the newer orbits. |

## M3 (2026-10-11)

| # | Topic | Decision |
|---|-------|----------|
| D15 | Integrator tolerance | DOP853 with rtol 1e-12 and atol 1e-7 (m, m/s, kg) by default. Measured: 0.12 m vs the analytic solution over 3 days on an e = 0.68 orbit, and 0.5 m over 1,000 LEO orbits. Error converges ~10× per decade of tolerance. |
| D16 | Gravity GM convention | Monopoles use DE440's TDB-compatible GMs, consistent with the ephemeris and the TDB clock. EGM2008 coefficients are used with zero-tide C̄₂₀ (IERS 2010 eq. 6.14), since solid tides are not modelled. Harmonic degree is capped at 70 by the unnormalized recursion. |
| D17 | Atmosphere scope | Earth: US76 below 86 km, NRLMSISE-00 (thermospheric branch, daily-Ap mode) above, log-linear blend over 86–91 km. Space weather is configurable (default F10.7 = 150, Ap = 4) until a real space-weather feed is added. Mars/Venus/Titan use documented low-fidelity profiles in v1. |
| D18 | Center switching and body resolution | Integration center = innermost SOI (Laplace radius from the current parent distance), 2% exit hysteresis. A planetary system is one barycentric point mass until within 10 SOI radii. Pluto is always a barycenter (Charon is not a v1 body), and Uranus carries its system GM (its moons are not v1 bodies). |

## M4 (2026-10-11)

| # | Topic | Decision |
|---|-------|----------|
| D19 | Radiometry and exposure | One physical radiance unit for everything, U = E☉(1 au)/π per sr: sunlit Lambertian ρ·E·cosθ, solar disk ≈ 46,240 U, stars from V magnitudes, Milky Way calibrated so map white = 20 mag/arcsec² (documented assumption). **Pre-exposure** keeps fp16 buffers in range. GPU auto-exposure meters lit pixels (> 1% of the frame) like a camera, else the dark sky (dark-adapted). Default "Physical" star visibility means stars vanish in sunlit views. Boosts ×1e3/×1e5 are player options. |
| D20 | Depth | Reversed-Z float depth when EXT_clip_control exists, logarithmic depth otherwise. Both are verified 2 m → 6e11 m by automated tests, with a standard-depth negative control. |
| D21 | Rendering tests | Playwright on headless Chromium (SwiftShader) in CI: depth precision, floating-origin jitter near Saturn, UI smoke. Perf is measured separately on a real GPU (`PERF=1`). Final 4070 numbers need the owner's machine. |
| D22 | Desktop packaging | Windows `.exe` via **Tauri v2** (Edge WebView2, Chromium-based like the test browser) built by `.github/workflows/package-windows.yml`. It produces an NSIS per-user installer and a portable exe. The bundle carries the 2020s and 2030s ephemeris decades, rebuilt in CI from checksum-pinned, cached JPL kernels. Owner request, 2026-10-11. |

## M5 (2026-10-11)

| # | Topic | Decision |
|---|-------|----------|
| D23 | Time warp with a 6-DOF vehicle | Step-by-step physics (50 Hz control ticks) up to 10×. Above 10× the vehicle coasts on rails, but only while no actuator is in use: body rates are zeroed and SAS directions are held kinematically (KSP-like). While thrusting, warp is capped at 10×. Approved by the owner 2026-10-11. |

## M7 (2026-10-12)

| # | Topic | Decision |
|---|-------|----------|
| D24 | Map Tiles API key | Packaged builds carry **no key**. The player enters their own in Settings → Earth, and it is stored only in that browser/app's local storage. Development uses `VITE_GOOGLE_MAPS_API_KEY` in `web/.env.local` (gitignored). With no key, tiles are off and nothing is requested from Google. Follows from the brief's "API key from an environment variable, never committed". |
| D25 | How the game ships | **A desktop application** (Tauri v2): Windows portable `.exe` and installer, plus a macOS `.app`. They are published as the rolling "nightly" GitHub pre-release on every push to `main`, and as releases on `v*` tags. The browser build remains only for development and automated tests. Owner request, 2026-10-12. |

