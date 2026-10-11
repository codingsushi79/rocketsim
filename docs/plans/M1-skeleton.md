# M1 plan: project skeleton

## Goal
Set up a repo where the Rust physics core builds natively and to WASM, CI checks
it, and the conventions for constants, units, time and reference frames are fixed
in code and enforced by tests.

## Layout
```
crates/sim-core   physics core (no rendering, DOM or browser deps; std only)
crates/sim-cli    headless CLI (`simctl`) for tests, Monte Carlo runs and replay
crates/sim-wasm   wasm-bindgen bindings: a thin layer with no logic
web/              Vite + TypeScript + three.js app
data/             versioned source datasets (each one listed in CREDITS.md)
tools/            offline pipelines and fixture generators (not shipped)
scripts/          build helpers
docs/             plans, progress, decisions
```

## Scope
1. Cargo workspace with a pinned toolchain (`rust-toolchain.toml`) so the
   "same build" requirement has a concrete meaning.
2. `sim-core` modules:
   - `math`: f64 `V3`, `M3`, `Quat`, plus `fmath`, a wrapper around `libm` for
     every transcendental function. Clippy `disallowed-methods` bans the
     `std` float methods in the core.
   - `constants`: SI values from DE440 (`gm_de440.tpc`) and IAU WGCCRE 2015
     (`pck00011.tpc`), each with a citation. A test parses the committed
     kernels and checks every constant against them.
   - `bodies`: `BodyId` uses NAIF integer IDs, so SPK asteroids and comets can be
     added later as data. Runtime registry of body properties.
   - `time`: `Epoch` stores TDB seconds past J2000 in two parts
     (`i64` seconds + `f64` fraction, like Orekit's `AbsoluteDate`). Includes the
     UTC→TAI→TT→TDB chain and back, the leap-second table generated at build
     time from `data/time/Leap_Second.dat`, and the provisional flag.
   - `frames`: typed `Pos<F>`, `Vel<F>`, `Vec<F>` and `State<F>` for frames
     `IcrfSsb`, `IcrfBody`, `BodyFixed`, `Lvlh` and `ScBody`. Every conversion
     is a named function with tests.
   - `determinism`: a canary hash over a fixed workload.
3. `sim-cli`: `simctl time <utc>`, `simctl bodies`, `simctl canary`.
4. `sim-wasm` + `web/`: the page loads the WASM core, shows the UTC/TDB clocks,
   the canary hash and the body table, and draws a minimal three.js scene to
   prove the stack.
5. CI (GitHub Actions): fmt, clippy `-D warnings`, tests, WASM build, a
   native-vs-WASM canary comparison in Node, and the web typecheck and build.
6. `CLAUDE.md`, `CREDITS.md`, `docs/PROGRESS.md`.

## Frame design note
The frame *kind* is part of the type, so mixing ICRF and LVLH is a compile error.
The frame *center* (which body) is a runtime `BodyId` stored inside the frame
value, and conversions check it. Type-level bodies (`PosBodyFixed<Earth>`)
can't work, because the body list is loaded from data (SPK asteroids). This is
the closest approach that still works with a data-driven body list.

## Conventions fixed in M1
- **LVLH:** NASA/CCSDS LVLH (the one ISS uses). +z points to nadir (−r̂),
  +y = −ĥ, +x = y × z (≈ velocity direction on a circular orbit).
- **Quaternions:** Hamilton convention, scalar first. `q_body_to_icrf` rotates
  body-frame vectors into ICRF: v_I = q v_B q*.
- **Body-fixed:** R = Rz(W)·Rx(90°−δ₀)·Rz(90°+α₀), per Archinal et al. 2018 §2.
  The IAU coefficient tables for each body come in M2.

## Acceptance
- `cargo test --workspace` passes. This covers the constants-vs-kernel checks,
  time round-trips and ERFA `dtdb` fixtures, leap-second edges, and frame
  conversion round-trips and analytic cases.
- `cargo clippy --workspace -- -D warnings` is clean, including the
  float-method ban.
- The native canary hash equals the WASM canary hash.
- The web app builds and shows clocks and the canary hash in the browser.
- CI is green on GitHub.

## Open questions
None blocking.
