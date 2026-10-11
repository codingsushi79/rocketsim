# M3 plan: spacecraft propagation

## Goal
A headless, deterministic, rigorously tested trajectory propagator: n-body gravity on the
M2 ephemeris, gravity harmonics, drag and solar radiation pressure, finite burns with mass
flow, and time warp that cannot change the answer. Plus a CLI that propagates a state and
prints orbital elements.

## Design

### State and integration frame
- The propagated state is position, velocity and mass (7 components). Positions and
  velocities are in **ICRF axes centered on the dominant body** (`StateIcrfBody`).
- **Center switching:** the center is the body whose sphere of influence (Laplace radius
  a·(m/M)^(2/5) relative to its parent) contains the spacecraft, the innermost one if they
  nest. Crossings are detected as integration events: root-found on dense output, the step
  is cut exactly there, the state is recentered with `recenter_icrf_body` (exact
  translation, no approximation), and integration restarts. This is a precision device
  only; the force model is identical on both sides. It is **not** patched conics.

### Force model (each term switchable; all f64; fixed summation order for determinism)
- **Point masses:** every body in the ephemeris tree, via the third-body (indirect) form
  relative to the integration center. Battin's f(q) (Battin 1999, §8.4) avoids
  cancellation in the differences.
  - A planetary system is one point mass at its barycenter (system GM) while the
    spacecraft is outside its SOI × 10.
  - Otherwise it is resolved into the planet (planet-only GM) plus each moon.
- **Spherical harmonics:** fully normalized coefficients, evaluated with the
  Cunningham/Montenbruck–Gill recursion (Montenbruck & Gill 2000, §3.2.4–3.2.5) in the
  body-fixed frame from M2, then rotated back.
  - Earth: **EGM2008**, configurable degree × order (default 8×8; J2–J6 minimum per spec;
    up to 70×70).
  - J2 only for the Moon (GRAIL), Mars (MRO), Jupiter (Juno) and Saturn (Cassini).
    Coefficient sources go in the cited constants / data files.
- **Atmospheric drag:**
  - Earth: US Standard Atmosphere 1976 below 86 km (exact layer equations). Above that,
    NRLMSISE-00 (port of the public-domain C version), with space weather from a config
    (default F10.7 = 150, Ap = 4) until real space-weather data is wired in.
  - Mars, Venus, Titan: documented reference profiles.
  - The atmosphere co-rotates with the body; relative wind uses `body_fixed` velocity.
  - Cannonball Cd·A/m from the spacecraft config.
- **Solar radiation pressure:** cannonball Cr·A/m, flux scaled by 1/r² from 1 AU
  (1361 W/m² solar constant, cited), conical shadow model for umbra/penumbra
  (Montenbruck & Gill §3.4.2) for every body.
- **Thrust:** finite burns with a thrust vector (inertial or attitude-referenced), with
  mass flow ṁ = −F/(Isp·g₀). M5 replaces the command source with the full engine/RCS
  model; the integrator interface stays the same.

### Integrator
- **DOP853** (Hairer, Nørsett & Wanner, *Solving ODEs I*, §II.10), ported from Hairer's
  `dop853.f`. It has embedded 5th- and 3rd-order error estimators, a PI step-size
  controller, and **7th-order dense output**.
- **Warp invariance by construction:** the integrator's step sequence never depends on
  frame rate or warp. Rendering, prediction sampling and the CLI read the trajectory
  through dense output. Only *events* (commands at timestamps, SOI crossings, impacts)
  cut steps, and those are deterministic functions of state and inputs.
- **Trajectory object:** steps plus dense-output coefficients, so any time can be
  evaluated. The predicted trajectory and the "truth" are the same object. A command
  (burn, state edit) truncates it at the command time and re-propagates.
- Optional symplectic or Gauss–Jackson only if benchmarks show DOP853 is too slow for long
  coasts (measured, not assumed).

### Events and termination
- Surface impact: altitude below the reference ellipsoid (terrain comes later).
- Atmospheric destruction: dynamic pressure or heating-rate limits from the config.
- SOI enter/exit.

### Analytics (for tests and the CLI)
- Classical elements ↔ state (Vallado Alg. 9/10), including the equatorial/circular
  special cases.
- Universal-variable Kepler propagation (Vallado Alg. 8 / Curtis §3.7), valid for
  elliptic, parabolic and hyperbolic orbits.
- Hohmann Δv and time of flight. J2 secular rates (Vallado §9.6).

## Tests (spec §6, M3 part)
1. Two-body: specific energy and angular momentum conserved over 1,000 orbits.
2. Integrator vs analytic Kepler for circular, elliptical, parabolic and hyperbolic cases.
3. Kepler solver vs Vallado / Curtis worked examples (cited).
4. J2 nodal precession of a sun-synchronous orbit matches the analytic rate (≈ +0.9856°/day).
5. Hohmann LEO→GEO: analytic Δv and TOF; a simulated transfer with impulsive burns arrives
   within tolerance.
6. Tsiolkovsky: a finite burn's achieved Δv matches Isp·g₀·ln(m₀/m_f).
7. Warp invariance: the same coast sampled at 1× (60 Hz frames) and at 100,000× gives
   bit-identical states.
8. Determinism: two runs give bit-identical results, and native = WASM (canary extended).
9. Center switching: a lunar flyby integrated with switching vs without (Earth-centered
   only, tight tolerance) agree within tolerance.
10. Drag: US76 values vs the standard's tables. NRLMSISE-00 vs the reference test cases
    distributed with the C code.
11. SRP: shadow function vs analytic geometry. Force magnitude at 1 AU.
12. Spherical harmonics: J2-only acceleration vs the closed form; EGM2008 n×n vs a
    reference acceleration at a test point.

## CLI
- `simctl propagate --scenario leo400 --duration 1d [--harmonics 8] [--no-drag] …`
  prints the state and osculating elements at the end and at intervals.
- `simctl elements <state>`.

## Data to fetch (small; recorded in CREDITS.md)
- EGM2008 coefficients (NGA; truncated to degree 70 for the repo).
- Hairer's `dop853.f` (coefficients).
- NRLMSISE-00 C source (public domain, D. Brodowski).
- Moon, Mars, Jupiter and Saturn J2 values from the cited mission gravity papers.

## Open questions
None blocking.
