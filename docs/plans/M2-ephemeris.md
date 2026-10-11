# M2 plan: ephemeris pipeline

## Goal
Put real body positions, orientations and Earth rotation into the core: JPL kernels
are converted offline into a compact, streamable Chebyshev format, evaluated at
runtime, and validated against JPL Horizons.

## 1. Offline builder (`tools/ephem-build`, native only)
- Reads SPKs with **ANISE 0.10** (pure Rust, MPL-2.0, NASA/ESA-flight-heritage SPK reader;
  build-time only, not shipped). Chosen over CSPICE: no C toolchain, typed API,
  reads DE (type 2/3) and satellite kernels.
- **Re-fits** each body to our own Chebyshev segments, rather than copying SPK records:
  - Center choice for precision. Moons are stored relative to their planet's *body center*;
    planets relative to their system barycenter; barycenters relative to the SSB.
    The spacecraft integrator then never has to difference AU-scale numbers.
  - Per-body search for segment length × degree that minimizes bytes with
    **max position error ≤ 1 m** (velocity ≤ 1 mm/s), checked at 2× oversampled points.
- Output is a list of **chunks** (body, center, start, segment length, count, degree, coefficients).
  Files are split by decade so the browser streams only the years in use. Chunks also allow
  a tiny **test-fixture file** (segments around each Horizons epoch) that is committed for CI.
- Spans (D6): planets, barycenters, Sun and Moon 1950–2100; satellites, Pluto body, Ceres
  and Vesta 2000–2100.

Body tree:
```
SSB ─ Sun, Mercury, Venus, Earth ─ Moon
    ├ Mars bary ─ Mars ─ Phobos, Deimos
    ├ Jupiter bary ─ Jupiter ─ Io, Europa, Ganymede, Callisto
    ├ Saturn bary ─ Saturn ─ Mimas … Iapetus
    ├ Uranus bary (Uranus body = barycenter; see open question)
    ├ Neptune bary ─ Neptune ─ Triton
    ├ Pluto bary ─ Pluto
    └ Ceres, Vesta
```

## 2. Runtime evaluator (`sim-core::ephemeris`)
- Parses the format from bytes (the core does no file I/O), with a version, checksums and
  coverage.
- Clenshaw evaluation of position and its analytic derivative (velocity). Pure arithmetic,
  so it's deterministic.
- `state_ssb(body, t) -> StateIcrfSsb` and `state_relative(target, center, t) -> StateIcrfBody`.
  The second walks the tree to the common ancestor, so Moon-relative-to-Earth never passes
  through the SSB.
- Asteroids and comets later are just more chunks with new NAIF IDs.

## 3. Body orientation (`sim-core::orientation`)
- IAU WGCCRE 2015 models, generated at build time from the committed `pck00011.tpc`
  (pole RA/Dec, prime meridian, nutation-precession angle terms) to `BodyOrientation`.
- **Earth (D4):** GCRS→ITRS = W(xp, yp, s′) · R3(GAST) · NPB, using IAU 2006 precession
  (Fukushima–Williams), IAU 2000B nutation (77 terms, ~1 mas ≈ 3 cm at the surface),
  GMST06 + equation of equinoxes (2000B), and IERS EOP (finals2000A: UT1−UTC, xp, yp).
  Coefficients are ported from ERFA (BSD-3, attributed). Validated against ERFA `c2t06a`.
- EOP is interpolated with 4-point Lagrange **on UT1−TAI** (continuous across leap seconds).
  - Before 1973 there is no EOP data, so xp = yp = 0 and ΔT comes from the Espenak–Meeus polynomial.
  - After the last prediction (~1 year ahead), the last-year UT1 rate is extrapolated linearly,
    the pole is held, and the result is flagged *predicted* for the UI.

## 4. Validation
- Horizons vector tables (ICRF, SSB-centered, TDB, km): Earth, Moon, Mars, Jupiter at
  20 epochs 1950–2100, plus each moon, Pluto, Ceres and Vesta at 5 epochs 2000–2100.
  Fetched once by `tools/fixtures/fetch_horizons.py` and committed with the query and the
  date retrieved.
- Tolerance is **1 km** for the spec bodies. Moons get a per-body tolerance documented after
  measuring, because Horizons may use newer satellite solutions than the NAIF generic kernels.
- Fit-error test (local, needs the kernels): built file vs ANISE at random epochs ≤ 1 m.
- IAU rotation vs SPICE-equivalent values (ANISE PCK evaluation) at sample epochs.
- Earth orientation vs ERFA `c2t06a` with the same EOP: surface-point difference < 0.1 m.

## Demo
`simctl ephem <body> <utc>` prints the state and its difference from Horizons;
`simctl ground <lat> <lon> <utc>` prints the ICRF position of a ground site.

## Open questions (non-blocking)
1. **Uranus body center:** the only kernels with Uranus relative to its barycenter are
   ura111xl-799 (1.0 GB) or ura184 (4 GB). The disk has 11 GB free. Until one is
   approved, the Uranus planet center = barycenter (offset ≈ tens of km, to be measured).
2. **Moon orientation:** the IAU model is ~150 m off the LOLA/LRO "Mean Earth" frame. For M8
   terrain, add DE440's lunar libration (moon_pa_de440 BPC, ~17 MB) plus the PA→ME rotation.
   Deferred to M8.
