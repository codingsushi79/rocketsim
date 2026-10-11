//! RocketSim physics core.
//!
//! Hard rules (see CLAUDE.md):
//! - No rendering, DOM, or browser dependencies. Runs headless everywhere.
//! - f64 everywhere; SI units; frames explicit in types ([`frames`]).
//! - Deterministic: transcendental math only via [`math::fmath`] (libm).
//! - Physical constants only from [`constants`], with citations.

pub mod bodies;
pub mod constants;
pub mod determinism;
pub mod frames;
pub mod math;
pub mod time;

/// Crate version, shown in the UI and embedded in save files.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
