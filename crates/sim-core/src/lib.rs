//! RocketSim physics core.
//!
//! Hard rules (see CLAUDE.md):
//! - No rendering, DOM, or browser dependencies. Runs headless everywhere.
//! - f64 everywhere; SI units; frames explicit in types ([`frames`]).
//! - Deterministic: transcendental math only via [`math::fmath`] (libm).
//! - Physical constants only from [`constants`], with citations.

pub mod atmosphere;
pub mod bodies;
pub mod chebyshev;
pub mod constants;
pub mod determinism;
pub mod earth;
pub mod ephemeris;
pub mod flight;
pub mod frames;
pub mod gravity;
pub mod integrator;
pub mod kepler;
pub mod maneuver;
pub mod math;
pub mod naif_text_kernel;
pub mod nrlmsise00;
mod nrlmsise00_data;
pub mod orientation;
pub mod prediction;
pub mod propagator;
pub mod rcs_alloc;
pub mod terrain;
pub mod time;
pub mod vehicle;

/// Crate version, shown in the UI and embedded in save files.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
