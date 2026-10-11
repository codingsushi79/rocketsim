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
