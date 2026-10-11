# M4 plan: first render + menu and settings shell

(Written alongside the work; the owner asked to continue straight from M3.)

## Scope
- WASM `Sim` API: ephemeris loading, TDB clock, circular-orbit spawn, `advance` (warp
  invariant), spacecraft/body states, body rotation, eclipse factor, orbit info and
  predicted path.
- Renderer (three.js, WebGL2):
  - Floating origin: the camera is always at the render origin. All positions are
    differenced in f64 before going to three.
  - Reversed-Z float depth (EXT_clip_control), logarithmic depth as the fallback.
  - HDR with **one physical radiance unit** (U = E☉(1 au)/π per sr), **pre-exposure**,
    GPU auto-exposure, bloom and AgX tone mapping.
  - Earth: WGS84 ellipsoid oriented by the precise IERS model, Blue Marble day and
    Black Marble night lights.
  - Atmosphere: physically based single-scattering post-pass (Rayleigh, Mie, ozone with
    Bruneton's parameters). Precomputed multiple scattering is deferred to M7.
  - Sky: Hipparcos stars (V ≤ 8, proper motion to the sim epoch, B−V colors, magnitude
    → irradiance) and the NASA SVS Milky Way.
  - Other bodies: Lambert spheres from IAU rotation, plus point sources when below a pixel.
  - Placeholder spacecraft lit by the Sun (with eclipses) and earthshine. Predicted orbit line.
- Camera: free orbit with log zoom (1 m → AU), focus cycling.
- UI (decision D11): main menu, mission select, credits, settings (graphics presets
  Low/Medium/High/Max, simulation, controls, audio, interface; persisted), pause menu,
  HUD (UTC/TDB, warp 1×–10⁷× with a CPU budget, orbit panel, debug overlay).
- Tests (spec §6), Playwright + headless Chromium in CI:
  - depth precision 2 m → 6e11 m in both depth modes, plus a negative control;
  - floating-origin jitter near Saturn;
  - a menu → mission → HUD smoke test;
  - an opt-in perf test at 1440p.
