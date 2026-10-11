# Progress

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Decisions | ✅ Done (see `docs/decisions.md`) |
| 1 | Project skeleton | ✅ Done |
| 2 | Ephemeris pipeline (DE440 + satellite SPKs, Chebyshev runtime, Horizons tests, IAU rotation, Earth EOP) | ✅ Done, awaiting go-ahead |
| 3 | Spacecraft propagation (n-body, harmonics, DOP853, perturbations, warp, CLI) | ⏳ Next |
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

## M2: ephemeris pipeline (2026-10-10)

**What exists**
- `tools/ephem-build` (ANISE 0.10.6, offline). Re-fits 33 body series from DE440, mar099,
  jup365, sat441, nep097, plu060 and sb441-n16 into `.rseph` Chebyshev chunks:
  - The cheapest segment length × degree is chosen per body.
  - Coefficients are quantized and stored as zigzag-LEB128 integers.
  - Every segment is checked densely after quantization.
  - Commands: `build` (per-decade files), `verify` (vs ANISE), `fixture` (CI subset).
- `sim-core::ephemeris` / `chebyshev`:
  - Loads chunks from bytes into a body tree (moons → planet → barycenter → SSB).
  - `state_ssb` and `state_relative` (via the common ancestor, so Moon-from-Earth never
    touches AU-scale numbers).
- `sim-core::orientation`: IAU WGCCRE 2015 models for all 27 bodies, generated from
  pck00011.tpc at build time, with the exact angular velocity including pole-drift rates.
- `sim-core::earth`: GCRS→ITRS from IAU 2006 precession, 2000B nutation, GMST06+EE and
  polar motion. EOP comes from finals2000A, interpolated with Lagrange on UT1−TAI, with
  quality flags (Observed / Predicted / Extrapolated / Model). Also WGS84 geodetic ↔ ITRS.
- `simctl ephem <body> <UTC> [center]`, `simctl ground <lat> <lon> <h> <UTC>`, `simctl bench`.

**Acceptance results**
- Fit vs ANISE, 3,000 random epochs per body: worst **0.71 m** and **2.1 mm/s** (Io).
- vs JPL Horizons, barycentric, 20 epochs 1950–2092 (spec bodies), planets at 25 epochs:
  - Earth 0.2 m, Moon 9.1 m, Mars 0.4 m, Jupiter 0.2 m (spec: ≤ 1 km).
  - Sun, Mercury, Venus, all barycenters, Saturn, Pluto: ≤ 0.4 m.
  - The Moon's 9 m is DE440 vs Horizons' DE441.
- Moons vs Horizons, planet-relative, 2001–2097: Phobos, Deimos, the Galilean moons and
  the 7 Saturnian moons all ≤ 0.3 m and 3 mm/s.
- Known model differences (not pipeline errors; documented tolerances in the test):
  - **Neptune** ~2,000 km and **Triton** ~709 km planet-relative by 2097. Horizons now uses
    nep098 (NAIF, July 2026, built on DE442), not nep097.
  - **Ceres / Vesta** 283 / 167 km. sb441-n16 holds DE441 perturber integrations; Horizons
    uses newer orbit solutions (JPL#48 / #36).
- IAU rotation vs CSPICE `tisbod`, 27 bodies × 5 epochs: matrices ≤ 5.4e-11 (W rounding
  at ~1e7°), angular velocity ≤ 1.2e-12 relative.
- Earth GCRS→ITRS vs ERFA `eraC2t06a` (full 2000A, CIO-based), 24 epochs 1976–2093:
  worst surface-point difference **14.6 mm**.
- Leap seconds: UT1−TAI continuous across 2016-12-31 (< 10 µs).
- Determinism: the canary now covers ephemeris, IAU rotation and Earth orientation.
  Native = WASM = `75fbc3bb150b774d`.
- Performance (Apple M4, native release): 164 ns per body state (4.4 µs for all 27),
  Earth orientation 1.0 µs, IAU orientation 151 ns.

**Size (D6, measured)**
- 0.9 MB per decade for 1950–1999 (planets only) and 12.8 MB per decade for 2000–2099
  (with moons). Total 132 MB on disk.
- The browser streams only the decade in use. The CI fixture is 122 KB.
- The biggest series are the short-period moons over 100 years: Phobos, Io, Europa,
  Mimas, Enceladus.
- WASM core size: 426 KB, which includes the 240 KB EOP table.

**Open questions for the owner**
1. **Newer JPL ephemerides.** DE442 (Feb 2025, same 114 MB size) and nep098 (Jul 2026)
   supersede DE440 and nep097, and Horizons already uses them. Neptune and Triton differ by
   ~2,000 km and ~700 km over the century. Recommendation: switch to DE442, and to nep098
   part 1 (784 MB, only Neptune's moons) if disk allows. This swaps kernels in the fetch
   script; the code doesn't change.
2. **Uranus body center** (ura111xl-799, 1.0 GB) is still barycenter = body (D13).
3. **Disk is tight: 3.1 GB free.** Kernels take 3.8 GB, `target/` 2.4 GB. A nep098 or Uranus kernel needs free space first: `cargo clean`, or delete kernels after a build, since `fetch-kernels.sh` restores them by checksum.
