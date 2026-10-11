# Progress

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Decisions | ✅ Done (see `docs/decisions.md`) |
| 1 | Project skeleton | ✅ Done, awaiting go-ahead |
| 2 | Ephemeris pipeline (DE440 + satellite SPKs, Chebyshev runtime, Horizons tests, IAU rotation, Earth EOP) | ⏳ Next |
| 3 | Spacecraft propagation (n-body, harmonics, DOP853, perturbations, warp, CLI) | |
| 4 | First render + **main menu and settings shell** (D11) | |
| 5 | v1 spacecraft (6-DOF, tanks, engine, RCS, wheels, SAS, HUD, model) | |
| 6 | Map view and maneuver nodes | |
| 7 | Earth photorealism (Google 3D Tiles, **volumetric clouds**, night lights) | |
| 8 | Rest of the solar system | |
| 9 | Transfer planner (Lambert, porkchop, n-body correction) | |
| 10 | Polish (save/load/replay, audio, menu polish, performance) | |

## M1: project skeleton (2026-10-10)

**What exists**
- Cargo workspace (pinned Rust 1.96.0): `sim-core`, `sim-cli` (`simctl`), `sim-wasm`.
- `sim-core`:
  - `math`: f64 V3/M3/Quat, plus `fmath` (libm only; std float math banned by clippy).
  - `constants`: SI, cited, checked against the committed DE440/WGCCRE kernels.
  - `bodies`: NAIF-ID registry with the 27 v1 bodies. It's a runtime table, so SPK asteroids can be added later.
  - `time`: two-part TDB `Epoch`; UTC↔TAI↔TT↔TDB; leap-second table generated from the IERS file; leap-second display (23:59:60); provisional flag.
  - `frames`: typed ICRF/SSB, ICRF/body, body-fixed (IAU angles), LVLH (NASA), spacecraft-body frames, with named conversions.
  - `determinism`: canary hash.
- `web/`: Vite + TS + three.js page that loads the WASM core and shows clocks, the canary hash and the body table.
- CI: fmt, clippy, tests (x86_64 Linux, which also checks the canary golden across architectures), WASM build, native-vs-WASM canary equality, web build.

**Acceptance results (local, Apple M4)**
- `cargo test --workspace`: 40 tests pass.
- TDB vs ERFA `eraDtdb` over 25 epochs (1972–2099): worst difference **5.8 µs**, inside the series' quoted ~10 µs accuracy.
- TAI/TT vs ERFA: < 1 ns at every epoch, including the 1998, 2012 and 2016 leap seconds.
- GM and radii vs NAIF kernels: all match to within 4 ulp.
- Canary: native `7b25a8236ee29aca` = WASM (Node) = WASM (browser).
- Clippy `-D warnings`: clean. A planted `x.sin()` or `x.mul_add()` is rejected.

**Known limitations / notes**
- TDB−TT uses the truncated series (~10 µs). If µs-level UTC timing ever matters, swap in the full Fairhead–Bretagnon series behind the same function.
- IAU per-body rotation coefficients and Earth EOP/precession-nutation come in M2. M1 has only the generic IAU-angle transform.
