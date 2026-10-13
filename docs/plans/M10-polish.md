# M10: Polish

Owner go-ahead: "keep pushing to m10 and finish m10" (2026-10-13), plus the feedback
rounds during it (Firefly-style entry, lens flare, cockpit windows and controls, SAS on
the navball, map-view lens artefact, ring sheet, night lights and stars).

## Scope
- **Save / load (exact):** the core serialises the whole flight state
  (`FlightSnapshot`: epoch, state, attitude, rates, tanks, engines, stages, plan, SAS
  mode). JSON with `float_roundtrip`, so a restore is bit-identical. Named slots in local
  storage (persist in the desktop app), quicksave/quickload (F5/F9), export/import as
  files.
- **Replay:** a flight recorder (1 s sampling, coarser under warp, bounded memory). The
  core's replay view answers render queries at the replay epoch, so the world draws the
  past without touching the physics state. Play, scrub, speeds 1×–10,000×.
- **Audio (procedural, Web Audio, no sample files):** engine, RCS, entry roar, staging,
  crash, master caution, UI clicks. Physics first: sound needs a medium, so the outside
  view is silent in vacuum unless "vacuum sound" is on. The cockpit hears structure-borne
  sound.
- **D11 settings:** audio volumes (master/effects/ambience/UI), control rebinding,
  display units (SI / imperial). The physics tolerance options already exist (M4).
- **Menus:** Continue, Load Mission (saves list with export/delete/import), pause-menu
  Save / Load / Watch Replay.
- **Performance:** measure at 2560×1440 on the M4; cut the costliest passes.

## Feedback items folded in
- Entry: Firefly-style plasma envelope (hull layers extruded along the flow, sparks),
  incandescence unchanged (Planck × CIE).
- Lens: ghosts as soft polygons from the traced centroid/size/energy; thinner spikes;
  no lens effects in the map view (also fixes a NaN "black hole").
- Rings: the sheet fades out near the ring plane, where the particles take over.
- Cockpit: rounded window openings with matching frames and glass; interactive console
  (buttons, display pages); SAS modes as a ring on the navball.
- Night: city lights on the 3D tiles; near-field earthshine (stars visible in eclipse);
  off-frame veiling glare; the Black Marble base layer removed.
- Clouds were composited over engine plumes: emissive effects get their own pass.

## Not in scope
Multiplayer, mod tooling, career mode.
