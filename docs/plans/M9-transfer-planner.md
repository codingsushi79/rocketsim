# M9: Transfer planner

Owner go-ahead: "keep pushing to m10 and finish m10" (2026-10-13).

## Scope
- **Lambert solver:** Izzo (2015) as in pykep: multi-rev, Householder iterations,
  deterministic libm math. Tests: Vallado Ex. 7-5; Kepler round trips (hyperbolic,
  multi-rev).
- **Porkchops** for two geometries:
  - local: the target orbits the spacecraft's centre (LEO → Moon); Lambert from the
    spacecraft's own future position;
  - interplanetary: target and centre share a parent (Earth → Mars); heliocentric Lambert,
    with v∞ turned into a parking-orbit burn (patched conics).
- **n-body correction**, as flown on real missions:
  0. energy match: a 1-D secant on prograde Δv, because finite-burn losses leave the
     patched-conic guess short;
  1. departure in-plane aim (prograde, radial, time) on the B-plane aim point, Δ before
     arrival;
  2. midcourse correction for the 3-D aim (out-of-plane control is singular at a
     ~180° departure);
  3. periapsis trim on the midcourse burn.
  All of it on the full propagator, with finite burns.
- **UI:** a transfer planner in the map view: target, periapsis altitude, porkchop heat-map
  (click to choose), Plan → nodes for the autopilot.
- **Missions:** "Lunar flyby" (RS-1); "Earth → Mars" with the RS-1 + Mars departure stage
  (D5's data-defined kick stage, RL10C-1 class, about 2.5 km/s).

## Not in scope
Gravity assists, multi-leg searches, low thrust, launch windows from the ground.
