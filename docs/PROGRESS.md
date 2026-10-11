# Progress

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Decisions | ✅ Done (see `docs/decisions.md`) |
| 1 | Project skeleton | ✅ Done |
| 2 | Ephemeris pipeline (DE440 + satellite SPKs, Chebyshev runtime, Horizons tests, IAU rotation, Earth EOP) | ✅ Done |
| 3 | Spacecraft propagation (n-body, harmonics, DOP853, perturbations, warp, CLI) | ✅ Done |
| 4 | First render + **main menu and settings shell** (D11) | ✅ Done |
| 5 | v1 spacecraft (6-DOF, tanks, engine, RCS, wheels, SAS, HUD, model) | ✅ Done |
| 6 | Map view and maneuver nodes | ✅ Done, awaiting review |
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

## M2 follow-up: kernel upgrade (2026-10-11)
- Neptune and Triton now come from **nep098** (NAIF, July 2026). Triton vs Horizons, Neptune-relative: 709 km → **0.1 m**.
- Uranus body from **ura111xl-799**, a real planet center instead of the barycenter.
- **DE442 was evaluated and reverted** (D14). It differs from Horizons' DE441 by up to 4 km (Mars) and 15 km (Jupiter) over 1950–2092, which fails the spec's 1 km check. The planets stay on DE440 (≤ 0.4 m vs Horizons, Moon 9 m).

## M3: spacecraft propagation (2026-10-11)

**What exists** (all in `sim-core`, headless, deterministic):
- `integrator`: DOP853 (Hairer), 7th-order dense output, exact step-end restart, overshoot mode.
  Chunked propagation is bit-identical to one run.
- `kepler`: elements ↔ state (all special cases), universal-variable Kepler (all conics),
  Hohmann, J2 secular rates.
- `gravity`: spherical harmonics (Montenbruck & Gill recursion).
  - Earth: EGM2008 up to 70×70 (zero-tide C̄₂₀).
  - J2: Moon (GL0660B), Mars (MRO120F), Jupiter (Juno), Saturn (Cassini).
- `atmosphere`: US76 (0–86 km) + **NRLMSISE-00** port of NRL's Fortran (> 86 km, blended);
  Mars, Venus and Titan profiles.
- `propagator`: n-body forces relative to the dominant body.
  - Third bodies use Battin's f(q) form; distant planetary systems are resolved into planet
    + moons within 10 SOI.
  - Central harmonics, co-rotating drag, cannonball SRP with conical shadows, finite burns
    with mass flow.
  - SOI center switching (exact recentering), resolve-sphere, impact and dynamic-pressure
    events, root-found on dense output.
  - Trajectory object, with `state_at` for any epoch and `extend`.
- `simctl propagate`: a headless run printing osculating elements (burn and force toggles).
- Test ephemeris: `ephem-build subset` builds a 100-day window (365 KB) committed for CI.

**Acceptance results** (release build, Apple M4)
| Test (spec §6) | Result |
|---|---|
| Two-body conservation, 1,000 LEO orbits (64 days) | \|ΔE/E\| ≤ 1.7e-11, \|Δh/h\| ≤ 8.4e-12; 0.50 m from analytic Kepler at the end |
| Kepler: circular / elliptical (e = 0.68) / parabolic / hyperbolic | 8e-5 / 0.12 / 7e-4 / 1.4e-4 m (default tolerance); converges to 0.6 mm at rtol 1e-14 |
| Kepler worked examples | Vallado 2-4 (KEPLER), 2-5 (RV2COE), Curtis 4.3 reproduced |
| J2 nodal precession, 800 km SSO | 0.9896°/day vs 0.9853°/day analytic (first-order, mean vs osculating a: 0.44%) |
| Hohmann | Vallado Ex. 6-1 Δv 3.935224 km/s and TOF 5.256713 h reproduced. Simulated LEO→GEO arrives within 1 m of r_GEO; e < 1e-6 after circularization |
| Tsiolkovsky | finite burn Δv = 665.909639 m/s = Isp·g₀·ln(m₀/m_f) to < 1e-7 relative; mass exact |
| Warp invariance | 3 h coast, 60 Hz frame-by-frame vs one call: **bit-identical** states and step count |
| Determinism | two runs bit-identical; canary (now incl. full propagator) native = WASM = `99e74aa0dc0af768` |
| Center switching | lunar flyby (closest approach 12,689 km): switching vs single-center differ by 29 m after 6 days |
| EGM2008 70×70 | vs independent 50-digit direct summation: 3.5e-16 relative |
| NRLMSISE-00 | NRL driver cases 1–10: all densities and temperatures within printed precision |
| US76 | NOAA table densities 0–86 km within 0.2% |
| Shadow / SRP / drag wiring | umbra/penumbra/sunlight geometry, monotonic penumbra; SRP and drag vs hand formulas |
| Impact | suborbital arc stops at h = −0.4 m (event root-found) |

**Performance:** LEO with all forces (EGM2008 8×8, NRLMSISE-00, SRP, all third bodies):
1 day = 792 steps in 94 ms (119 µs/step) natively. WASM core 584 KB.

**Known limitations**
- 3-hour Ap history mode of NRLMSISE-00 isn't ported (daily Ap only). No real space-weather feed yet.
- No Charon (Pluto stays a barycenter) and no Uranian moons (system GM on Uranus).
- Mars/Venus/Titan atmospheres are low-fidelity profiles.
- Solid/ocean tides, relativity (PN terms) and Earth albedo/IR pressure aren't modelled. Each is
  sub-meter-per-day in LEO; they will be added if a validation case needs them.

## M4: first render + menu and settings shell (2026-10-11)

**What exists** (`npm --prefix web run dev` after `./scripts/build-wasm.sh`):
- WASM `Sim` API (ephemeris, TDB clock, spawn, warp-invariant `advance`, states, body
  frames, eclipse factor, orbit info, predicted path, history pruning).
- Renderer:
  - floating origin; reversed-Z float depth with log fallback;
  - HDR in physical units with pre-exposure, GPU auto-exposure, bloom, AgX;
  - Earth on the WGS84 ellipsoid with IERS orientation (Blue Marble day, Black Marble night);
  - single-scattering atmosphere post-pass (Rayleigh/Mie/ozone, depth-aware);
  - Hipparcos starfield (41k stars, proper motion, colors) and Milky Way;
  - planets and moons as lit spheres or point sources;
  - placeholder spacecraft with Sun + eclipse + earthshine lighting; predicted-orbit line.
- Camera: free orbit, log zoom 1 m → AU, focus cycling ([ ]).
- Game shell (D11):
  - main menu, mission select, credits, pause menu;
  - settings (Graphics presets Low → Max, Simulation, Controls, Audio, Interface), persisted;
  - HUD: UTC/TDB, warp 1×–10⁷× with "warp limited" under CPU budget, orbit panel, F3 debug.

**Verification**
- Rendering tests (Playwright, 5 tests):
  - no z-fighting from 2 m to 6e11 m in both reversed-Z and log depth, and the
    standard-depth control fails as expected (proving the test is sensitive);
  - consecutive frames 2 m from the hull near Saturn identical (max diff ≤ 2/255);
  - menu → mission → HUD 400 km / 92-min period, with no console errors.
- Sky orientation: Orion, Aldebaran, Sirius and Antares in the right places (east-left
  view from inside). The Milky Way map's RA convention was verified on the Magellanic
  Clouds.
- Physics hookups:
  - eclipse factor 0 in Earth's umbra on the night side;
  - correct seasonal lighting (Antarctica sunlit in November, subsolar ≈ 14°S, 169°E at 00:45 UTC).
- Performance on Apple M4 integrated GPU, 2560×1440, synchronous timing with GPU sync:

| Preset | Frame time |
|---|---|
| Max | 18.7 ms |
| High | 18.0 ms |
| Medium | 6.4 ms |

  MSAA on fp16 targets dominates on this tile-based GPU. RTX 4070 estimate: ~3 ms at Max
  (to be measured on the owner's machine).
- Rust: 96 tests; canary native = WASM = `99e74aa0dc0af768`.

**Known limitations / next**
- Single scattering only. Bruneton multiple scattering, clouds and ocean glint come in M7.
- Moon and planets have uniform albedo until M8 textures.
- Spacecraft is a placeholder (M5).
- Propagation runs on the main thread with an 8 ms budget; moving it to a Web Worker is in M10.
- Milky Way brightness is a calibration assumption (white = 20 mag/arcsec²).

## M5: v1 spacecraft (2026-10-11)

Plan: `docs/plans/M5-spacecraft.md`. Vehicle rationale and numbers: `docs/spacecraft_v1.md`.

**What exists**
- **RS-1 Corvid**: 3-crew capsule + service module, 24.96 t, 3,447 m/s main-engine Δv
  (TLI from LEO is 3.08 km/s). It is pure data in `data/vehicles/rs1_corvid.json`.
- **Core** (`vehicle.rs`, `rcs_alloc.rs`, `flight.rs`):
  - JSON vehicle model with validation. Mass, CoM and inertia from shape primitives
    (parallel-axis theorem); propellant settles aft as tanks drain.
  - 6-DOF flight on a fixed 50 Hz control grid (zero-order hold):
    - Translation is the M3 truth propagator, with the tick's thrust as an exact-mass-flow burn.
    - Rotation is in angular-momentum form (q, H, wheel momenta) with RK4, time-varying
      inertia and gravity-gradient torque.
  - Main engine:
    - thrust and Isp with back-pressure;
    - 40–100 % throttle, 50 ignitions, 0.4 s minimum on-time;
    - gimbal trim through the moving CoM plus steering, rate-limited.
  - RCS: 16 SM thrusters plus 12 CM thrusters. The CM set is inhibited until separation, as
    on Apollo. Allocation is coupled force/torque FNNLS.
  - Reaction wheels with torque and momentum saturation, and automatic RCS desaturation.
  - SAS:
    - modes Hold, pro/retro, normal/anti, radial in/out, target/anti, maneuver;
    - eigenaxis cascade with a braking-curve rate profile, critically damped;
    - gains scaled by the current inertia.
  - Staging conserves momentum (separation impulse, rigid-body rates), and jettisoned stages
    are propagated as debris.
  - Terminal events: impact, dynamic-pressure limit, Sutton–Graves heat-flux limit.
  - Time warp: per-tick physics up to 10×. Above that the vehicle goes "on rails" if no
    actuator is in use (rates zeroed, as in KSP). While thrusting, the warp is capped.
- **Web**:
  - glTF model generated from the same JSON (CI checks it is current), with gimballing
    engine, plume and RCS puffs driven by telemetry;
  - debris rendering;
  - navball with prograde/normal/radial/target markers on the local horizon;
  - speed modes (orbit, surface, target), SAS mode bar;
  - engine, Δv and burn-time panel, per-tank propellant gauges, wheel saturation, q/heat
    warnings, staging (hold Space);
  - input from keyboard (KSP-like), standard gamepads, and HOTAS with axis mapping in
    Settings → Controls.

**Verification**
- `tests/flight.rs` (13 tests):
  - RS-1 mass and Δv as designed;
  - main-engine burn matches Tsiolkovsky to 1e-6, and tank bookkeeping matches the
    propagator mass;
  - back-pressure thrust law; ignition count and minimum on-time enforced;
  - 30° off-axis slew settles in 16 s with **0.000 % overshoot at both full and empty mass**;
  - torque-free tumble conserves H to 6e-11 (gravity gradient at 1 au is the residual) and
    energy to 2e-11;
  - wheels saturate with H exactly conserved; RCS desaturates 95 → < 5 N·m·s with < 0.5°
    pointing excursion;
  - RCS translation stays pure (cross-axis < 2 %, rate < 0.05°/s);
  - staging conserves linear momentum to 1e-9 and applies the 0.6 m/s separation speed;
  - bit-identical results for 1/60 s, 0.25 s and 10 s frame chunking.
- Unit tests:
  - mass properties against hand calculations; FNNLS allocation (pure torque, pure force,
    saturation keeps direction, no opposed firing);
  - Sutton–Graves and US76 pressure; quaternion-from-matrix round trip.
- Playwright `e2e/flight.spec.ts`: model loads, prograde burn at 66.7 kN, RCS fires on pitch
  input, separation leaves the CM flying and the SM as debris, with no console errors.
- Rust: 123 tests. Canary unchanged, native = WASM = `99e74aa0dc0af768`.
- Screenshots: `docs/screenshots/m5-*.jpg`.

**Fixed along the way**
- `extend` could loop forever when an arc's end time converted back to an epoch fell an ulp
  short of the target. There is now 1 ns slack.
- Auto-exposure counted the Milky Way as "lit" at high pre-exposure, blowing out sunlit
  vehicles. The threshold is now absolute, and metering is centre-weighted.
- MSAA sample extrapolation made the plume shader return NaN, which bloom spread over the
  whole frame. Varyings are now clamped.

**Known limitations / next**
- No attitude-dependent aerodynamics (lift, trim, aero torque) yet, so entry is drag-only.
- No propellant slosh, no ullage requirement, no jet damping (estimated 0.1 % of gimbal
  authority), no power or thermal model.
- Key rebinding is not implemented (the gamepad and HOTAS axes are configurable).
- The physics warp limit (10×) and on-rails behaviour are game-design choices. Please
  confirm them.
- Plume and RCS puffs are a visual aid with a fixed radiance, not a radiometric model.

## M6: map view and maneuver nodes (2026-10-11)

Plan: `docs/plans/M6-map-and-maneuvers.md`.

**What exists**
- **Core** (`maneuver.rs`, `prediction.rs`, autopilot in `flight.rs`):
  - Mission plan data model: legs of nodes with Δv as prograde/normal/radial at the node.
    It is multi-leg-ready for M9 and serialisable for M10.
  - Plan prediction: each node is a finite burn of the real engine, flown by the same n-body
    propagator.
    - Burn time from Tsiolkovsky at the predicted mass; the burn is split so half the Δv
      comes before the node.
    - The node vector is evaluated on the trajectory with the earlier nodes applied.
    - Horizon: 1.05 orbits past the last burn when bound inside the SOI, else 30 days
      (configurable), or until impact.
  - Markers, root-found on the dense output:
    - apoapsis and periapsis per SOI patch, with altitude and time;
    - SOI changes and impact;
    - closest approach to the target;
    - ascending and descending nodes relative to the target's orbital plane, with relative
      inclination.
  - Map geometry: adaptive path sampling in any frame centre, osculating body conics, Laplace
    SOI radii, ground track (WGS84 latitude for Earth).
  - Burn autopilot:
    - holds the node vector, ignites at the planned start;
    - tapers the throttle and cuts off at the target Δv;
    - stops on-rails warp 30 s before ignition.
- **Web**:
  - Map view (M): ecliptic-aligned camera; zoom from LEO to the outer planets.
  - Lines: the coast prediction (blue) and the plan (orange), coloured per SOI patch; body
    orbits sized to the zoom; SOI rings for the centre and the target.
  - Markers with time-to; body labels (click to focus).
  - Click the trajectory to add a node. Drag the six prograde/normal/radial handles (rate
    grows with drag distance, Caps Lock for fine), or type values, or shift the node in time.
  - Node panel: Δv, burn time, burn start, plan total, Δv left after the plan.
  - Execute/abort the autopilot; status and planned-vs-actual report.
  - Ground track (G); distances to nearby bodies; HUD node and autopilot countdown; navball
    maneuver marker. Target cycling (Y) feeds the closest-approach and AN/DN markers.

**Verification**
- `tests/prediction.rs` (6 tests):
  - a zero node leaves the prediction unchanged;
  - the impulsive limit matches **vis-viva to the millimetre** (apoapsis 7,143,590.285 m) and
    the half period to 1 ms;
  - burn time matches Tsiolkovsky to 1e-9 s, and half the Δv comes before the node;
  - apsides on an e = 0.3 orbit match Kepler (radius < 1 cm, time < 1 ms);
  - AN/DN lie on the Moon's orbital plane with the correct direction and relative inclination;
    closest approach is a true distance minimum;
  - the autopilot executes a planned 150 m/s burn: ignition +2 ms, Δv 149.992 m/s, position
    4 m from the plan, **apoapsis 30 m from the plan**.
- In the browser, full force model (EGM2008 8×8, drag, SRP, third bodies): the same burn
  reports periapsis −0.6 m, apoapsis −31 m and closest approach to the Moon +8.6 m vs plan.
- Playwright `e2e/map.spec.ts`: map → markers → node → burn time → execute at warp → warp
  stops at T−30 s → burn → report (Δv within 0.2 m/s, apoapsis within 1 km). The full suite is
  7 tests.
- Rust: 131 tests. Canary unchanged.
- Re-prediction while editing a node: about 25–35 ms in the browser for a multi-day
  translunar plan.
- Screenshots: `docs/screenshots/m6-*.jpg`.

**Fixed along the way**
- Propagator: extending exactly to a burn's start time overshot the boundary, so the start of
  the burn was skipped. The boundary is now hit exactly. Canary unchanged.

**Known limitations / next**
- The autopilot holds the inertial node vector (as the prediction assumes). Closed-loop
  guidance on the remaining Δv vector can come later if long burns need it.
- Burns below the 0.4 s minimum on-time overshoot slightly. RCS-only nodes (capsule after
  separation) are not executable by the autopilot yet.
- The ground track uses texture imagery for Earth only.
- Gravity-assist legs and Lambert targeting are M9. The data model is in place.

