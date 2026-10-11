# M6 plan: map view and maneuver nodes

Brief §4 (map view, maneuver nodes, readouts) and milestone 6: predicted trajectories, node
editing, and a burn-execution autopilot. The transfer planner (Lambert, porkchop) is M9; the
multi-leg data model is laid down now.

## Core (`sim-core`)
- **`maneuver`**: the plan data model, serde-serialisable for M10 save files.
  - `MissionPlan { legs: Vec<Leg> }`, `Leg { nodes, target }`, `ManeuverNode { epoch, dv }`.
  - Δv is given as (prograde, normal, radial) in the orbit frame at the node, using velocity
    relative to the centre body at that point of the prediction.
  - One leg is used in M6; gravity-assist legs plug in at M9.
- **`prediction`**: the trajectory with all planned nodes as *finite* burns of the actual
  engine, flown by the real propagator.
  - Each node becomes an inertially fixed burn at full thrust along the node vector.
  - Burn time comes from the predicted mass at the node: Δt = m₀vₑ/F · (1 − e^(−Δv/vₑ)).
  - The burn is split so that half the Δv is delivered before the node time.
  - The node vector is evaluated on the trajectory with the earlier nodes applied, so chained
    nodes are consistent.
- **Horizon policy**: 1.05 orbits past the last node when the orbit is bound inside its SOI.
  Otherwise a cap (default 30 days, configurable), or until impact.
- **Markers**, root-found on the dense output (same 1 µs bisection as the propagator events):
  - apoapsis and periapsis per arc and centre, with altitude and time;
  - SOI changes and impact;
  - closest approach to the target body;
  - ascending and descending nodes relative to the target's orbital plane, with relative
    inclination.
- **Map geometry**:
  - path sampling that follows the integrator's adaptive steps, so periapses are dense, in
    any chosen frame centre;
  - body orbits as osculating conics about their parents;
  - Laplace SOI radii.
- **Ground track**: latitude and longitude of the prediction (body-fixed, IERS for Earth).
- **Autopilot** (`flight.rs`), deterministic and tick-based:
  - It points SAS at the node vector and lights the engine at the computed start time.
  - It integrates Δv delivered along the node vector and throttles down near the end.
  - It cuts off at the target Δv.
  - On rails it stops warp in time to settle attitude before ignition.
- **Burn report**: planned vs actual after the burn. It covers Δv magnitude and pointing
  error, the post-burn state difference, and the change in the next periapsis or closest
  approach.

## Tests
- A node with zero Δv leaves the prediction unchanged.
- An impulsive limit (very high thrust) matches a Kepler/Hohmann analytic case: a prograde node
  raises apoapsis as predicted by vis-viva.
- Burn time matches Tsiolkovsky, and the split puts half the Δv before the node.
- Apsis markers on an eccentric orbit match analytic r_p, r_a and times.
- Closest approach and AN/DN against constructed geometry.
- The autopilot executes a LEO prograde node, and the result matches the planned prediction:
  Δv error < 0.2 m/s and post-burn apoapsis within 1 km.
- Determinism: prediction and execution are bit-identical across frame chunking.

## Web
- **Map view** (M to toggle):
  - the same floating-origin engine; camera on any body or the spacecraft; zoom from LEO to
    the outer planets;
  - lines: body orbits, the coast prediction (blue), and the planned trajectory with nodes
    (orange, coloured per SOI patch);
  - planet icons and labels;
  - markers with altitude and time-to.
- **Nodes**:
  - click the trajectory to add one;
  - drag the prograde/normal/radial handles (rate ∝ drag distance), or type values;
  - shift the node in time;
  - the panel shows Δv, burn time, start (T−), remaining Δv after all burns, and the
    execute/abort autopilot control;
  - the trajectory updates live.
- **Readouts**:
  - osculating elements;
  - 2D ground-track panel (G);
  - distances to nearby bodies;
  - a burn report after execution;
  - the navball's maneuver marker and the HUD node countdown in flight view too.

## Open questions
- None blocking. The default prediction cap is 30 days and changeable in settings.
