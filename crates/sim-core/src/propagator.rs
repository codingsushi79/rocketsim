//! Spacecraft trajectory propagation: the "truth" model (spec §2.2).
//!
//! - **Frame:** ICRF axes centered on the dominant body (the integration center). The
//!   center switches at sphere-of-influence crossings, with an exact translation of
//!   the state. This is a precision device, not patched conics: the force model is
//!   the same on both sides of the switch.
//! - **Forces** (each switchable): point masses for every body in the ephemeris tree,
//!   central-body spherical harmonics, atmospheric drag, solar radiation pressure
//!   with conical shadows, and finite burns with mass flow.
//! - **Integrator:** DOP853 with dense output. A [`Trajectory`] stores every step, so
//!   any epoch can be sampled without re-integrating. Extending a trajectory continues
//!   from the last natural step end, so chunked propagation is bit-identical to one
//!   run (time-warp invariance).
//! - **Events** are root-found on the dense output: SOI enter/exit, entering or
//!   leaving a planetary system's resolve sphere, impact, and dynamic-pressure limit.
//!   Burn start/stop times are hit exactly.

use crate::atmosphere::{self, SpaceWeather};
use crate::bodies::{BodyId, BodyRegistry};
use crate::constants::{ASTRONOMICAL_UNIT, G0, SOLAR_IRRADIANCE_1AU, SPEED_OF_LIGHT, gm, radii};
use crate::earth;
use crate::ephemeris::{Ephemeris, EphemerisError};
use crate::frames::{BodyOrientation, IcrfBody, State, StateIcrfBody};
use crate::gravity::{self, ShField};
use crate::integrator::{DenseStep, Dop853Options, IntegratorError, StepControl, dop853};
use crate::math::{V3, fmath};
use crate::orientation;
use crate::time::Epoch;
use core::cell::RefCell;

/// Spacecraft state: epoch, center, inertial position/velocity relative to the
/// center, and mass.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScState {
    pub epoch: Epoch,
    pub state: StateIcrfBody,
    pub mass: f64,
}

/// Physical properties the force model needs (cannonball model; M5 replaces this
/// with the data-driven spacecraft definition).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ballistic {
    pub cd: f64,
    /// Drag reference area, m².
    pub drag_area: f64,
    /// Radiation-pressure coefficient (1 = absorbing, 2 = perfect mirror).
    pub cr: f64,
    pub srp_area: f64,
}

impl Default for Ballistic {
    fn default() -> Ballistic {
        Ballistic {
            cd: 2.2,
            drag_area: 10.0,
            cr: 1.3,
            srp_area: 10.0,
        }
    }
}

/// Thrust direction for a burn.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BurnDirection {
    /// Fixed inertial (ICRF) unit vector.
    Inertial(V3),
    /// Along / against the velocity relative to the integration center.
    Prograde,
    Retrograde,
    /// Along / against the orbit normal r × v.
    Normal,
    AntiNormal,
    /// Away from / toward the center.
    RadialOut,
    RadialIn,
    /// Fixed in the rotating orbit frame (prograde v̂, normal (r×v)̂, radial v̂×n̂):
    /// unit components (prograde, normal, radial). A long burn then turns with the arc
    /// it spans instead of holding one inertial vector, which wastes Δv once the burn
    /// covers tens of degrees of orbit (a 13-minute TLI from LEO covers ~50°).
    Orbital(V3),
}

/// A finite burn with constant thrust between `start` and `end`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Burn {
    pub start: Epoch,
    pub end: Epoch,
    /// Thrust, N.
    pub thrust: f64,
    /// Specific impulse, s (mass flow ṁ = −F / (Isp·g₀)).
    pub isp: f64,
    pub direction: BurnDirection,
    /// Mass flow override, kg/s (≥ 0), replacing F/(Isp·g₀). Used when thrusters partly
    /// cancel (RCS couples), so the net thrust doesn't measure the propellant used.
    pub mass_flow: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ForceConfig {
    pub third_body: bool,
    pub harmonics: bool,
    /// EGM2008 degree and order used for Earth (≤ 70).
    pub earth_degree: usize,
    pub drag: bool,
    pub srp: bool,
    pub space_weather: SpaceWeather,
    /// Stop when dynamic pressure exceeds this (Pa). `f64::INFINITY` disables it.
    pub max_dynamic_pressure: f64,
    /// Stop when the stagnation heat flux (Sutton–Graves, [`atmosphere::stagnation_heat_flux`])
    /// exceeds this (W/m²). `f64::INFINITY` disables it.
    pub max_heat_flux: f64,
    /// Effective nose radius for the heat-flux estimate, m.
    pub nose_radius: f64,
}

impl Default for ForceConfig {
    fn default() -> ForceConfig {
        ForceConfig {
            third_body: true,
            harmonics: true,
            earth_degree: 8,
            drag: true,
            srp: true,
            space_weather: SpaceWeather::default(),
            max_dynamic_pressure: f64::INFINITY,
            max_heat_flux: f64::INFINITY,
            nose_radius: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntegratorConfig {
    pub rtol: f64,
    /// Absolute tolerance on position (m), velocity (m/s) and mass (kg) components.
    pub atol: f64,
    pub h_max: f64,
}

/// Default tolerances: rtol 1e-12, atol 1e-7 (m, m/s, kg). Measured on an e = 0.68
/// orbit over 3 days: 0.12 m vs the analytic solution (0.8 m at 1e-11, 1.1 cm at 1e-13).
/// See tests/propagation.rs `integrator_converges_to_analytic_solution`.
impl Default for IntegratorConfig {
    fn default() -> IntegratorConfig {
        IntegratorConfig {
            rtol: 1e-12,
            atol: 1e-7,
            h_max: 86_400.0 * 2.0,
        }
    }
}

/// Why an arc ended.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ArcEnd {
    /// Reached the requested time (the arc continues seamlessly if extended).
    Horizon,
    BurnBoundary,
    SoiChange {
        from: BodyId,
        to: BodyId,
    },
    ResolveChange,
    Impact {
        body: BodyId,
    },
    DynamicPressureLimit {
        q: f64,
    },
    HeatFluxLimit {
        flux: f64,
    },
}

/// One integration arc: constant center and force set.
#[derive(Clone, Debug)]
pub struct Arc {
    pub center: BodyId,
    /// Epoch of local time 0.
    pub base: Epoch,
    /// Local start and end times, s (end ≤ last step end).
    pub t_start: f64,
    pub t_end: f64,
    pub y_start: [f64; 7],
    pub steps: Vec<DenseStep<7>>,
    /// Step size to continue with.
    pub h_next: f64,
    pub end: ArcEnd,
}

impl Arc {
    fn eval(&self, t: f64) -> [f64; 7] {
        if self.steps.is_empty() || t <= self.t_start {
            return self.y_start;
        }
        let i = self
            .steps
            .partition_point(|s| s.t1() < t)
            .min(self.steps.len() - 1);
        self.steps[i].eval(t)
    }
}

/// A propagated trajectory: arcs in time order.
#[derive(Clone, Debug)]
pub struct Trajectory {
    pub arcs: Vec<Arc>,
}

impl Trajectory {
    pub fn start_epoch(&self) -> Epoch {
        self.arcs[0].base.add_seconds(self.arcs[0].t_start)
    }

    pub fn end_epoch(&self) -> Epoch {
        let a = self.arcs.last().expect("non-empty");
        a.base.add_seconds(a.t_end)
    }

    /// State at `t`, or `None` outside the trajectory.
    pub fn state_at(&self, t: Epoch) -> Option<ScState> {
        let arc = self
            .arcs
            .iter()
            .find(|a| t.seconds_since(a.base) <= a.t_end)?;
        let local = t.seconds_since(arc.base);
        if local < arc.t_start {
            return None;
        }
        Some(to_state(t, arc.center, &arc.eval(local)))
    }

    pub fn end_state(&self) -> ScState {
        let a = self.arcs.last().expect("non-empty");
        to_state(a.base.add_seconds(a.t_end), a.center, &a.eval(a.t_end))
    }

    /// True if the trajectory ended at a terminal event (impact or breakup).
    pub fn terminated(&self) -> Option<ArcEnd> {
        match self.arcs.last()?.end {
            e @ (ArcEnd::Impact { .. }
            | ArcEnd::DynamicPressureLimit { .. }
            | ArcEnd::HeatFluxLimit { .. }) => Some(e),
            _ => None,
        }
    }

    /// Cut the trajectory at `t` (which must lie inside it). The next `extend` starts a
    /// new arc from the interpolated state at `t`. Used when switching from on-rails
    /// prediction to step-by-step flight.
    pub fn truncate_after(&mut self, t: Epoch) {
        while self.arcs.len() > 1
            && self
                .arcs
                .last()
                .is_some_and(|a| t.seconds_since(a.base.add_seconds(a.t_start)) < 0.0)
        {
            self.arcs.pop();
        }
        let a = self.arcs.last_mut().expect("non-empty");
        let local = t
            .seconds_since(a.base)
            .clamp(a.t_start, a.t_end.max(a.t_start));
        let keep = a.steps.partition_point(|s| s.t0 < local);
        a.steps.truncate(keep.max(1).min(a.steps.len()));
        a.t_end = local;
        a.end = ArcEnd::BurnBoundary;
    }

    pub fn step_count(&self) -> usize {
        self.arcs.iter().map(|a| a.steps.len()).sum()
    }

    /// Drop history before `t` (keeps the step containing `t`, and always the last
    /// step, so extension stays bit-identical). Bounds memory during long runs.
    pub fn prune_before(&mut self, t: Epoch) {
        // Whole arcs that ended before t (never the last one).
        while self.arcs.len() > 1
            && self.arcs[0]
                .base
                .add_seconds(self.arcs[0].t_end)
                .seconds_since(t)
                < 0.0
        {
            self.arcs.remove(0);
        }
        let a = &mut self.arcs[0];
        let local = t.seconds_since(a.base);
        let keep_from = a
            .steps
            .partition_point(|s| s.t1() < local)
            .min(a.steps.len().saturating_sub(1));
        if keep_from > 0 {
            a.steps.drain(..keep_from);
            let first = &a.steps[0];
            a.t_start = first.t0;
            a.y_start = first.eval(first.t0);
        }
    }
}

fn to_state(epoch: Epoch, center: BodyId, y: &[f64; 7]) -> ScState {
    ScState {
        epoch,
        state: State::new(
            V3::new(y[0], y[1], y[2]),
            V3::new(y[3], y[4], y[5]),
            IcrfBody { center },
        ),
        mass: y[6],
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PropagationError {
    Ephemeris(EphemerisError),
    Integrator(IntegratorError),
    InvalidState(String),
}

impl core::fmt::Display for PropagationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            PropagationError::Ephemeris(e) => write!(f, "{e}"),
            PropagationError::Integrator(e) => write!(f, "{e}"),
            PropagationError::InvalidState(s) => write!(f, "invalid state: {s}"),
        }
    }
}

impl std::error::Error for PropagationError {}

impl From<EphemerisError> for PropagationError {
    fn from(e: EphemerisError) -> Self {
        PropagationError::Ephemeris(e)
    }
}

// ---------------------------------------------------------------------------
// Body tree helpers
// ---------------------------------------------------------------------------

/// A planetary system: barycenter, planet, and moons modelled individually.
struct System {
    barycenter: BodyId,
    planet: BodyId,
    moons: &'static [BodyId],
    /// GM used at the barycenter when the system is unresolved.
    system_gm: f64,
}

/// Systems treated as one barycentric point mass when far away.
const SYSTEMS: [System; 6] = [
    System {
        barycenter: BodyId(4),
        planet: BodyId::MARS,
        moons: &[BodyId::PHOBOS, BodyId::DEIMOS],
        system_gm: gm::MARS_SYSTEM,
    },
    System {
        barycenter: BodyId(5),
        planet: BodyId::JUPITER,
        moons: &[
            BodyId::IO,
            BodyId::EUROPA,
            BodyId::GANYMEDE,
            BodyId::CALLISTO,
        ],
        system_gm: gm::JUPITER_SYSTEM,
    },
    System {
        barycenter: BodyId(6),
        planet: BodyId::SATURN,
        moons: &[
            BodyId::MIMAS,
            BodyId::ENCELADUS,
            BodyId::TETHYS,
            BodyId::DIONE,
            BodyId::RHEA,
            BodyId::TITAN,
            BodyId::IAPETUS,
        ],
        system_gm: gm::SATURN_SYSTEM,
    },
    // Uranus' moons aren't modelled individually yet; when resolved, the planet
    // carries the system mass (moons ≈ 1e-4 of the total).
    System {
        barycenter: BodyId(7),
        planet: BodyId::URANUS,
        moons: &[],
        system_gm: gm::URANUS_SYSTEM,
    },
    System {
        barycenter: BodyId(8),
        planet: BodyId::NEPTUNE,
        moons: &[BodyId::TRITON],
        system_gm: gm::NEPTUNE_SYSTEM,
    },
    // Charon (12% of the system mass) is not in the v1 body list, so Pluto is always
    // modelled as its system barycenter. Documented limitation.
    System {
        barycenter: BodyId(9),
        planet: BodyId::PLUTO,
        moons: &[],
        system_gm: gm::PLUTO_SYSTEM,
    },
];

/// Planet-only GM for gravity: Uranus carries the system GM, since its moons aren't modelled.
fn body_gm(reg: &BodyRegistry, b: BodyId) -> f64 {
    if b == BodyId::URANUS {
        return gm::URANUS_SYSTEM;
    }
    reg.get(b).map_or(0.0, |i| i.gm)
}

/// Gravitating mass used for SOI ratios (whole system for planets).
fn soi_gm(reg: &BodyRegistry, b: BodyId) -> f64 {
    SYSTEMS
        .iter()
        .find(|s| s.planet == b)
        .map_or_else(|| body_gm(reg, b), |s| s.system_gm)
}

/// Hysteresis factor on SOI exit, so a state exactly on a boundary doesn't flip-flop.
const SOI_EXIT_FACTOR: f64 = 1.02;
/// A system is resolved into planet + moons within this many SOI radii.
const RESOLVE_FACTOR: f64 = 10.0;

/// Context shared by all derivative evaluations of one arc.
struct ArcModel<'a> {
    eph: &'a Ephemeris,
    center: BodyId,
    base: Epoch,
    center_gm: f64,
    field: Option<ShField>,
    /// Third bodies: (id, GM).
    perturbers: Vec<(BodyId, f64)>,
    /// Bodies that can shadow the spacecraft: (id, radius).
    occulters: Vec<(BodyId, f64)>,
    forces: ForceConfig,
    ballistic: Ballistic,
    burn: Option<Burn>,
    /// First error inside a derivative evaluation (the integrator can't return one).
    error: RefCell<Option<EphemerisError>>,
}

impl ArcModel<'_> {
    fn rel(&self, b: BodyId, t: Epoch) -> V3 {
        match self.eph.state_relative(b, self.center, t) {
            Ok(s) => s.r,
            Err(e) => {
                self.error.borrow_mut().get_or_insert(e);
                V3::new(1e30, 1e30, 1e30)
            }
        }
    }

    fn orientation(&self, t: Epoch) -> Option<BodyOrientation> {
        if self.center == BodyId::EARTH {
            Some(earth::earth_orientation(t).0)
        } else {
            orientation::iau_body_orientation(self.center, t)
        }
    }

    fn derivative(&self, tl: f64, y: &[f64; 7]) -> [f64; 7] {
        let t = self.base.add_seconds(tl);
        let r = V3::new(y[0], y[1], y[2]);
        let v = V3::new(y[3], y[4], y[5]);
        let mass = y[6];
        let rn = r.norm();
        let mut a = V3::ZERO;

        // Central body: harmonics in the body-fixed frame, or a point mass.
        let o = if self.field.is_some() || self.forces.drag {
            self.orientation(t)
        } else {
            None
        };
        match (&self.field, &o) {
            (Some(f), Some(o)) => {
                let r_bf = o.icrf_to_bf.mul_v3(r);
                a += o
                    .icrf_to_bf
                    .transpose()
                    .mul_v3(f.acceleration(r_bf, f.n_max, f.n_max));
            }
            _ => a += r * (-self.center_gm / (rn * rn * rn)),
        }

        // Third bodies: Battin's f(q) form (Battin 1999, §8.4), stable when the body is
        // far: a = −GM/|s−r|³ · (r + f(q) s), q = r·(r − 2s)/s², f(q) = (1+q)^{3/2} − 1.
        let mut sun = None;
        for &(b, gmb) in &self.perturbers {
            let s = self.rel(b, t);
            if b == BodyId::SUN {
                sun = Some(s);
            }
            let q = r.dot(r - s * 2.0) / s.norm_squared();
            let opq = 1.0 + q;
            let fq = q * (3.0 + 3.0 * q + q * q) / (1.0 + opq * opq.sqrt());
            let d = s - r;
            let dn = d.norm();
            a += (r + s * fq) * (-gmb / (dn * dn * dn));
        }

        // Atmospheric drag (co-rotating atmosphere).
        if self.forces.drag
            && let Some(o) = &o
        {
            let r_bf = o.icrf_to_bf.mul_v3(r);
            if let Some(rho) = atmosphere::density(self.center, r_bf, t, &self.forces.space_weather)
            {
                let omega_i = o.icrf_to_bf.transpose().mul_v3(o.omega_bf);
                let v_rel = v - omega_i.cross(r);
                let k =
                    -0.5 * rho * self.ballistic.cd * self.ballistic.drag_area / mass * v_rel.norm();
                a += v_rel * k;
            }
        }

        // Solar radiation pressure, cannonball with conical shadows.
        if self.forces.srp && self.center != BodyId::SUN {
            let s_sun = sun.unwrap_or_else(|| self.rel(BodyId::SUN, t));
            let from_sun = r - s_sun;
            let d = from_sun.norm();
            let nu = self.shadow(r, s_sun, t);
            if nu > 0.0 {
                let p = SOLAR_IRRADIANCE_1AU / SPEED_OF_LIGHT
                    * (ASTRONOMICAL_UNIT / d)
                    * (ASTRONOMICAL_UNIT / d);
                a += from_sun * (nu * p * self.ballistic.cr * self.ballistic.srp_area / mass / d);
            }
        }

        // Thrust.
        let mut mdot = 0.0;
        if let Some(b) = &self.burn {
            let dir = match b.direction {
                BurnDirection::Inertial(u) => u.normalized().unwrap_or(V3::ZERO),
                BurnDirection::Prograde => v.normalized().unwrap_or(V3::ZERO),
                BurnDirection::Retrograde => -v.normalized().unwrap_or(V3::ZERO),
                BurnDirection::Normal => r.cross(v).normalized().unwrap_or(V3::ZERO),
                BurnDirection::AntiNormal => -r.cross(v).normalized().unwrap_or(V3::ZERO),
                BurnDirection::RadialOut => r.normalized().unwrap_or(V3::ZERO),
                BurnDirection::RadialIn => -r.normalized().unwrap_or(V3::ZERO),
                BurnDirection::Orbital(c) => orbital_direction(r, v, c),
            };
            a += dir * (b.thrust / mass);
            mdot = match b.mass_flow {
                Some(m) => -m,
                None => -b.thrust / (b.isp * G0),
            };
        }

        [y[3], y[4], y[5], a.x, a.y, a.z, mdot]
    }

    /// Fraction of the solar disk visible (1 = full sun, 0 = umbra). Conical model:
    /// overlap of the apparent solar and occulting disks (Montenbruck & Gill 2000,
    /// §3.4.2, eqs. 3.85–3.89).
    fn shadow(&self, r: V3, s_sun: V3, t: Epoch) -> f64 {
        let mut nu: f64 = 1.0;
        for &(b, radius) in &self.occulters {
            let pos = if b == self.center {
                V3::ZERO
            } else {
                self.rel(b, t)
            };
            nu = nu.min(occultation(r, s_sun, pos, radius));
        }
        nu
    }
}

/// Fraction of the solar disk visible from `r` when one body of `radius` sits at
/// `body` (all positions relative to the same center). Conical model: overlap of the
/// apparent solar and occulting disks (Montenbruck & Gill 2000, §3.4.2, eqs. 3.85–3.89).
/// Returns 1 for full sun and 0 in the umbra.
pub fn occultation(r: V3, s_sun: V3, body: V3, radius: f64) -> f64 {
    let to_sun = s_sun - r;
    let ds = to_sun.norm();
    let to_body = body - r;
    let db = to_body.norm();
    if db >= ds || radius <= 0.0 {
        return 1.0; // farther than the Sun: can't occult
    }
    let a = fmath::asin((radii::SUN.a / ds).min(1.0));
    let bb = fmath::asin((radius / db).min(1.0));
    let c = fmath::acos((to_sun.dot(to_body) / (ds * db)).clamp(-1.0, 1.0));
    if c >= a + bb {
        1.0
    } else if c <= bb - a {
        0.0 // total eclipse (umbra)
    } else if c <= a - bb {
        1.0 - (bb * bb) / (a * a) // annular
    } else {
        let x = (c * c + a * a - bb * bb) / (2.0 * c);
        let y = (a * a - x * x).max(0.0).sqrt();
        let area = a * a * fmath::acos((x / a).clamp(-1.0, 1.0))
            + bb * bb * fmath::acos(((c - x) / bb).clamp(-1.0, 1.0))
            - c * y;
        1.0 - area / (core::f64::consts::PI * a * a)
    }
}

/// Events watched during one arc. g changes sign when the event fires.
#[derive(Clone, Copy, Debug)]
enum Event {
    SoiExit { parent: BodyId, radius_factor: f64 },
    SoiEnter { child: BodyId },
    Resolve { system: usize, resolved: bool },
    Impact,
    DynamicPressure,
    HeatFlux,
}

/// The propagator: ephemeris + body data + configuration.
pub struct Propagator<'a> {
    pub eph: &'a Ephemeris,
    pub reg: &'a BodyRegistry,
    pub forces: ForceConfig,
    pub integrator: IntegratorConfig,
    pub ballistic: Ballistic,
    /// Switch the integration center at SOI crossings (default). When off, the
    /// initial center is kept: useful for validation against single-center solutions.
    pub center_switching: bool,
    /// End every extension exactly at the requested time instead of at the next natural
    /// step end. Step-by-step flight (fixed control ticks) needs this; on-rails coasting
    /// leaves it off so chunked propagation stays bit-identical.
    pub exact_horizon: bool,
    /// Height grids for ground contact; without one, the reference ellipsoid is the ground.
    pub terrain: Option<&'a crate::terrain::Terrain>,
}

impl<'a> Propagator<'a> {
    pub fn new(eph: &'a Ephemeris, reg: &'a BodyRegistry) -> Propagator<'a> {
        Propagator {
            eph,
            reg,
            forces: ForceConfig::default(),
            integrator: IntegratorConfig::default(),
            ballistic: Ballistic::default(),
            center_switching: true,
            exact_horizon: false,
            terrain: None,
        }
    }

    fn parent(&self, b: BodyId) -> Option<BodyId> {
        self.reg.get(b).and_then(|i| i.parent)
    }

    fn children(&self, b: BodyId) -> Vec<BodyId> {
        self.reg
            .iter()
            .filter(|i| i.parent == Some(b))
            .map(|i| i.id)
            .collect()
    }

    /// Laplace sphere-of-influence radius r = d·(m/M)^(2/5) at `t`, where d is the
    /// current distance to the parent.
    pub fn soi_radius(&self, b: BodyId, t: Epoch) -> Result<f64, EphemerisError> {
        self.soi(b, t)
    }

    fn soi(&self, b: BodyId, t: Epoch) -> Result<f64, EphemerisError> {
        let Some(p) = self.parent(b) else {
            return Ok(f64::INFINITY);
        };
        let d = self.eph.state_relative(b, p, t)?.r.norm();
        Ok(d * fmath::pow(soi_gm(self.reg, b) / soi_gm(self.reg, p), 0.4))
    }

    /// The innermost body whose SOI contains the state (given relative to any body).
    pub fn dominant_center(&self, s: &ScState) -> Result<StateIcrfBody, PropagationError> {
        let t = s.epoch;
        // Move to the Sun first, then descend.
        let mut cur = self.recenter(&s.state, BodyId::SUN, t)?;
        loop {
            let mut next = None;
            for c in self.children(cur.frame.center) {
                if self.eph.center_of(c).is_none() {
                    continue;
                }
                let rel = self.recenter(&cur, c, t)?;
                if rel.r.norm() < self.soi(c, t)? {
                    next = Some(rel);
                    break;
                }
            }
            match next {
                Some(n) => cur = n,
                None => return Ok(cur),
            }
        }
    }

    fn recenter(
        &self,
        s: &StateIcrfBody,
        to: BodyId,
        t: Epoch,
    ) -> Result<StateIcrfBody, PropagationError> {
        if s.frame.center == to {
            return Ok(*s);
        }
        let off = self.eph.state_relative(s.frame.center, to, t)?;
        Ok(State::new(
            s.r + off.r,
            s.v + off.v,
            IcrfBody { center: to },
        ))
    }

    /// Systems resolved for an arc centered on `center` at `t` with position `r`.
    fn resolved(&self, center: BodyId, r: V3, t: Epoch) -> Result<Vec<bool>, PropagationError> {
        let mut out = Vec::with_capacity(SYSTEMS.len());
        for sys in &SYSTEMS {
            let in_system = center == sys.planet || sys.moons.contains(&center);
            let res = if in_system {
                true
            } else if sys.barycenter == BodyId(9) || self.eph.center_of(sys.barycenter).is_none() {
                // Pluto is never resolved; systems missing from the loaded ephemeris are skipped.
                false
            } else {
                let d = (self.eph.state_relative(sys.barycenter, center, t)?.r - r).norm();
                d < RESOLVE_FACTOR * self.soi(sys.planet, t)?
            };
            out.push(res);
        }
        Ok(out)
    }

    fn arc_model(
        &self,
        center: BodyId,
        base: Epoch,
        resolved: &[bool],
        burn: Option<Burn>,
    ) -> ArcModel<'a> {
        let reg = self.reg;
        let mut perturbers = Vec::new();
        let mut occulters = Vec::new();
        let mut add = |b: BodyId, g: f64| {
            if b != center && g > 0.0 && self.eph.center_of(b).is_some() {
                perturbers.push((b, g));
            }
        };
        if self.forces.third_body {
            add(BodyId::SUN, gm::SUN);
            add(BodyId::MERCURY, gm::MERCURY);
            add(BodyId::VENUS, gm::VENUS);
            add(BodyId::EARTH, gm::EARTH);
            add(BodyId::MOON, gm::MOON);
            for (sys, &res) in SYSTEMS.iter().zip(resolved) {
                if res {
                    add(sys.planet, body_gm(reg, sys.planet));
                    for &m in sys.moons {
                        add(m, body_gm(reg, m));
                    }
                } else {
                    add(sys.barycenter, sys.system_gm);
                }
            }
            add(BodyId::CERES, gm::CERES);
            add(BodyId::VESTA, gm::VESTA);
        }
        // Occulters: the center and every resolved nearby body with a radius.
        if center != BodyId::SUN {
            occulters.push((
                center,
                reg.get(center).map_or(0.0, |b| b.radii.equatorial_mean()),
            ));
            for &(b, _) in &perturbers {
                if b != BodyId::SUN
                    && let Some(i) = reg.get(b)
                {
                    occulters.push((b, i.radii.equatorial_mean()));
                }
            }
        }
        let field = if self.forces.harmonics {
            gravity::body_field(center, self.forces.earth_degree)
        } else {
            None
        };
        ArcModel {
            eph: self.eph,
            center,
            base,
            center_gm: body_gm(reg, center),
            field,
            perturbers,
            occulters,
            forces: self.forces,
            ballistic: self.ballistic,
            burn,
            error: RefCell::new(None),
        }
    }

    fn events(&self, center: BodyId, resolved: &[bool]) -> Vec<Event> {
        let mut ev = Vec::new();
        if self.center_switching {
            if let Some(p) = self.parent(center) {
                ev.push(Event::SoiExit {
                    parent: p,
                    radius_factor: SOI_EXIT_FACTOR,
                });
            }
            for c in self.children(center) {
                if self.eph.center_of(c).is_some() {
                    ev.push(Event::SoiEnter { child: c });
                }
            }
        }
        for (i, sys) in SYSTEMS.iter().enumerate() {
            let in_system = center == sys.planet || sys.moons.contains(&center);
            if !in_system
                && sys.barycenter != BodyId(9)
                && self.eph.center_of(sys.barycenter).is_some()
            {
                ev.push(Event::Resolve {
                    system: i,
                    resolved: resolved[i],
                });
            }
        }
        if center != BodyId::SUN {
            ev.push(Event::Impact);
        }
        if self.forces.max_dynamic_pressure.is_finite() {
            ev.push(Event::DynamicPressure);
        }
        if self.forces.max_heat_flux.is_finite() {
            ev.push(Event::HeatFlux);
        }
        ev
    }

    /// Event function value at local time `tl` (state `y`) for an arc.
    fn g(&self, m: &ArcModel, e: &Event, tl: f64, y: &[f64; 7]) -> Result<f64, EphemerisError> {
        let t = m.base.add_seconds(tl);
        let r = V3::new(y[0], y[1], y[2]);
        Ok(match *e {
            Event::SoiExit { radius_factor, .. } => {
                r.norm() - radius_factor * self.soi(m.center, t)?
            }
            Event::SoiEnter { child } => {
                self.soi(child, t)? - (r - self.eph.state_relative(child, m.center, t)?.r).norm()
            }
            Event::Resolve { system, resolved } => {
                let sys = &SYSTEMS[system];
                let d = (self.eph.state_relative(sys.barycenter, m.center, t)?.r - r).norm();
                let g = RESOLVE_FACTOR * self.soi(sys.planet, t)? - d; // > 0 inside
                if resolved { -g } else { g }
            }
            Event::Impact => {
                let i = self.reg.get(m.center).map(|b| b.radii);
                // With a height grid: below the terrain surface (reference surface + grid
                // height; geodetic for Earth, radial for the others).
                if let (Some(tr), Some(rad), Some(o)) = (self.terrain, i, m.orientation(t))
                    && tr.get(m.center).is_some()
                {
                    let p = o.icrf_to_bf.mul_v3(r);
                    return Ok(if m.center == BodyId::EARTH {
                        let (lat, lon, h) = earth::itrs_to_geodetic(p);
                        tr.grid_height(m.center, lat, lon) - h
                    } else {
                        let q = V3::new(p.x / rad.a, p.y / rad.b, p.z / rad.c).norm();
                        let rn = p.norm();
                        (rn / q + tr.height_at(m.center, p)) - rn
                    });
                }
                // Inside the reference ellipsoid ⇔ (x² + y²)/a² + z²/c² < 1 (body-fixed).
                match (i, m.orientation(t)) {
                    (Some(rad), Some(o)) => {
                        let p = o.icrf_to_bf.mul_v3(r);
                        let a2 = rad.a * rad.b;
                        1.0 - ((p.x * p.x + p.y * p.y) / a2 + p.z * p.z / (rad.c * rad.c))
                    }
                    (Some(rad), None) => rad.equatorial_mean() - r.norm(),
                    _ => -1.0,
                }
            }
            Event::DynamicPressure => {
                let Some(o) = m.orientation(t) else {
                    return Ok(-1.0);
                };
                let r_bf = o.icrf_to_bf.mul_v3(r);
                let rho = atmosphere::density(m.center, r_bf, t, &self.forces.space_weather)
                    .unwrap_or(0.0);
                let omega_i = o.icrf_to_bf.transpose().mul_v3(o.omega_bf);
                let v_rel = V3::new(y[3], y[4], y[5]) - omega_i.cross(r);
                0.5 * rho * v_rel.norm_squared() - self.forces.max_dynamic_pressure
            }
            Event::HeatFlux => {
                let Some(o) = m.orientation(t) else {
                    return Ok(-1.0);
                };
                let r_bf = o.icrf_to_bf.mul_v3(r);
                let rho = atmosphere::density(m.center, r_bf, t, &self.forces.space_weather)
                    .unwrap_or(0.0);
                let omega_i = o.icrf_to_bf.transpose().mul_v3(o.omega_bf);
                let v_rel = V3::new(y[3], y[4], y[5]) - omega_i.cross(r);
                atmosphere::stagnation_heat_flux(
                    m.center,
                    rho,
                    v_rel.norm(),
                    self.forces.nose_radius,
                )
                .unwrap_or(0.0)
                    - self.forces.max_heat_flux
            }
        })
    }

    /// Propagate from `initial` until `until`, applying `burns`.
    pub fn propagate(
        &self,
        initial: &ScState,
        until: Epoch,
        burns: &[Burn],
    ) -> Result<Trajectory, PropagationError> {
        if initial.mass.is_nan() || initial.mass <= 0.0 {
            return Err(PropagationError::InvalidState(
                "mass must be positive".into(),
            ));
        }
        let state = if self.center_switching {
            self.dominant_center(initial)?
        } else {
            initial.state
        };
        let start = ScState {
            epoch: initial.epoch,
            state,
            mass: initial.mass,
        };
        let mut traj = Trajectory {
            arcs: vec![Arc {
                center: state.frame.center,
                base: initial.epoch,
                t_start: 0.0,
                t_end: 0.0,
                y_start: to_y(&start),
                steps: Vec::new(),
                h_next: 0.0,
                end: ArcEnd::Horizon,
            }],
        };
        self.extend(&mut traj, until, burns)?;
        Ok(traj)
    }

    /// Extend a trajectory to `until`. Continuing an arc that ended at the horizon
    /// keeps the exact step sequence of one long run.
    pub fn extend(
        &self,
        traj: &mut Trajectory,
        until: Epoch,
        burns: &[Burn],
    ) -> Result<(), PropagationError> {
        loop {
            if traj.terminated().is_some() {
                return Ok(());
            }
            let last = traj.arcs.last().expect("non-empty");
            let now = last.base.add_seconds(last.t_end);
            // 1 ns slack: an arc's local end time converted back to an epoch can fall an
            // ulp short of `until`, and re-integrating a zero-length interval never ends.
            if now.seconds_since(until) >= -1e-9 {
                return Ok(());
            }
            // Burn active now, and the next burn boundary.
            let active = burns
                .iter()
                .find(|b| now.seconds_since(b.start) >= 0.0 && now.seconds_since(b.end) < 0.0)
                .copied();
            let mut boundary = until;
            let mut hits_burn = false;
            for b in burns {
                for e in [b.start, b.end] {
                    if e.seconds_since(now) > 0.0 && e.seconds_since(boundary) <= 0.0 {
                        // `<=`: a requested end exactly on a burn boundary must be hit
                        // exactly too, or the next extension would skip into the burn.
                        boundary = e;
                        hits_burn = true;
                    }
                }
            }
            // Continue the current arc only if nothing about its model changed.
            let y0 = last.eval(last.t_end);
            let cont = matches!(last.end, ArcEnd::Horizon)
                && !last.steps.is_empty()
                && last_burn_matches(last, active.as_ref(), burns);
            let (center, base, t0, h0) = if cont {
                (last.center, last.base, last.t_end, last.h_next)
            } else {
                (last.center, now, 0.0, 0.0)
            };
            let r0 = V3::new(y0[0], y0[1], y0[2]);
            let resolved = self.resolved(center, r0, now)?;
            let model = self.arc_model(center, base, &resolved, active);
            let events = self.events(center, &resolved);
            let opts = Dop853Options {
                rtol: self.integrator.rtol,
                atol: self.integrator.atol,
                h_max: self.integrator.h_max,
                max_steps: 50_000_000,
                // Burn boundaries must be hit exactly; horizons may overshoot.
                overshoot: !hits_burn && !self.exact_horizon,
            };
            let t_target = boundary.seconds_since(base);
            let mut steps = Vec::new();
            let mut fired: Option<(f64, Event)> = None;
            let mut g_err = None;
            // Event signs at the start of this arc segment.
            let mut g_prev: Vec<f64> = Vec::with_capacity(events.len());
            for e in &events {
                g_prev.push(self.g(&model, e, t0, &y0)?);
            }
            let mut deriv = |t: f64, y: &[f64; 7]| model.derivative(t, y);
            let result = dop853(
                &mut deriv,
                t0,
                y0,
                t_target,
                h0,
                &opts,
                |step: &DenseStep<7>, _y1| {
                    steps.push(step.clone());
                    // Check events at 4 sub-points per step (catches double crossings in long steps).
                    for k in 1..=4 {
                        let tk = step.t0 + step.h * f64::from(k) / 4.0;
                        let yk = step.eval(tk);
                        for (i, e) in events.iter().enumerate() {
                            let gk = match self.g(&model, e, tk, &yk) {
                                Ok(g) => g,
                                Err(err) => {
                                    g_err = Some(err);
                                    return StepControl::Stop;
                                }
                            };
                            if g_prev[i] < 0.0 && gk >= 0.0 {
                                // Root on the dense output: bisection to 1 µs (deterministic).
                                let (mut lo, mut hi) =
                                    (step.t0 + step.h * f64::from(k - 1) / 4.0, tk);
                                for _ in 0..64 {
                                    if (hi - lo).abs() < 1e-6 {
                                        break;
                                    }
                                    let mid = 0.5 * (lo + hi);
                                    match self.g(&model, e, mid, &step.eval(mid)) {
                                        Ok(gm) if gm >= 0.0 => hi = mid,
                                        Ok(_) => lo = mid,
                                        Err(err) => {
                                            g_err = Some(err);
                                            return StepControl::Stop;
                                        }
                                    }
                                }
                                if fired.is_none_or(|(tf, _)| hi < tf) {
                                    fired = Some((hi, *e));
                                }
                            }
                            g_prev[i] = gk;
                        }
                        if fired.is_some() {
                            return StepControl::Stop;
                        }
                    }
                    StepControl::Continue
                },
            );
            if let Some(e) = model.error.borrow_mut().take() {
                return Err(e.into());
            }
            if let Some(e) = g_err {
                return Err(e.into());
            }
            let result = result.map_err(PropagationError::Integrator)?;

            let (t_end, end) = match fired {
                Some((tf, e)) => (tf, self.event_end(&model, &e, tf, &steps)?),
                None if hits_burn => (t_target, ArcEnd::BurnBoundary),
                // t + (t_end − t) can miss t_end by an ulp; an exact horizon must land on it.
                None if self.exact_horizon => (t_target, ArcEnd::Horizon),
                None => (result.t, ArcEnd::Horizon),
            };
            // Append to the current arc when continuing, else start a new one.
            if cont {
                let last = traj.arcs.last_mut().expect("non-empty");
                last.steps.extend(steps);
                last.t_end = t_end;
                last.h_next = result.h_next;
                last.end = end;
            } else {
                traj.arcs.push(Arc {
                    center,
                    base,
                    t_start: t0,
                    t_end,
                    y_start: y0,
                    steps,
                    h_next: result.h_next,
                    end,
                });
            }
            // Apply center changes for the next arc.
            if let ArcEnd::SoiChange { to, .. } = end {
                let last = traj.arcs.last().expect("non-empty");
                let y = last.eval(last.t_end);
                let s = to_state(last.base.add_seconds(last.t_end), last.center, &y);
                let moved = self.recenter(&s.state, to, s.epoch)?;
                traj.arcs.push(Arc {
                    center: to,
                    base: s.epoch,
                    t_start: 0.0,
                    t_end: 0.0,
                    y_start: [
                        moved.r.x, moved.r.y, moved.r.z, moved.v.x, moved.v.y, moved.v.z, y[6],
                    ],
                    steps: Vec::new(),
                    h_next: 0.0,
                    end: ArcEnd::ResolveChange,
                });
            }
        }
    }

    fn event_end(
        &self,
        m: &ArcModel,
        e: &Event,
        tf: f64,
        steps: &[DenseStep<7>],
    ) -> Result<ArcEnd, PropagationError> {
        Ok(match *e {
            Event::SoiExit { parent, .. } => ArcEnd::SoiChange {
                from: m.center,
                to: parent,
            },
            Event::SoiEnter { child } => ArcEnd::SoiChange {
                from: m.center,
                to: child,
            },
            Event::Resolve { .. } => ArcEnd::ResolveChange,
            Event::Impact => ArcEnd::Impact { body: m.center },
            Event::DynamicPressure => {
                let y = steps.last().expect("step").eval(tf);
                let g = self.g(m, e, tf, &y)?;
                ArcEnd::DynamicPressureLimit {
                    q: g + self.forces.max_dynamic_pressure,
                }
            }
            Event::HeatFlux => {
                let y = steps.last().expect("step").eval(tf);
                let g = self.g(m, e, tf, &y)?;
                ArcEnd::HeatFluxLimit {
                    flux: g + self.forces.max_heat_flux,
                }
            }
        })
    }
}

fn to_y(s: &ScState) -> [f64; 7] {
    let (r, v) = (s.state.r, s.state.v);
    [r.x, r.y, r.z, v.x, v.y, v.z, s.mass]
}

/// Whether the burn state at the end of `arc` matches `active` (no burn boundary
/// crossed). Continuation requires the same force model.
fn last_burn_matches(arc: &Arc, active: Option<&Burn>, burns: &[Burn]) -> bool {
    let t = arc.base.add_seconds(arc.t_end);
    let was = burns
        .iter()
        .find(|b| t.seconds_since(b.start) > 0.0 && t.seconds_since(b.end) <= 0.0);
    match (was, active) {
        (None, None) => true,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Inertial direction of orbit-frame components `c` = (prograde, normal, radial) for the
/// state (r, v) relative to the centre (same frame as `maneuver::orbit_frame`).
pub fn orbital_direction(r: V3, v: V3, c: V3) -> V3 {
    let (Some(pro), Some(nrm)) = (v.normalized(), r.cross(v).normalized()) else {
        return V3::ZERO;
    };
    let rad = pro.cross(nrm);
    (pro * c.x + nrm * c.y + rad * c.z)
        .normalized()
        .unwrap_or(V3::ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ephemeris::{Chunk, quantize};

    /// Sun at the SSB, Earth fixed 1 au along +x: enough geometry for force unit tests.
    fn static_ephemeris() -> Ephemeris {
        let mut e = Ephemeris::new();
        let fixed = |target: BodyId, center: BodyId, p: V3| Chunk {
            target,
            center,
            start: 0,
            seg_len: 10_000_000_000,
            n_seg: 1,
            n_coef: 1,
            quantum: 1e-3,
            coefs: vec![
                quantize(p.x, 1e-3),
                quantize(p.y, 1e-3),
                quantize(p.z, 1e-3),
            ],
        };
        e.insert(fixed(BodyId::SUN, BodyId::SSB, V3::ZERO)).unwrap();
        e.insert(fixed(
            BodyId::EARTH,
            BodyId::SSB,
            V3::new(ASTRONOMICAL_UNIT, 0.0, 0.0),
        ))
        .unwrap();
        e
    }

    #[test]
    fn conical_shadow_umbra_penumbra_and_sunlight() {
        let (e, reg) = (static_ephemeris(), BodyRegistry::builtin());
        let p = Propagator::new(&e, &reg);
        let m = p.arc_model(BodyId::EARTH, Epoch::J2000, &[false; 6], None);
        let s_sun = V3::new(-ASTRONOMICAL_UNIT, 0.0, 0.0); // Sun as seen from Earth's center
        let t = Epoch::J2000;
        // Directly behind Earth (anti-sun side), 7,000 km: umbra.
        assert_eq!(m.shadow(V3::new(7.0e6, 0.0, 0.0), s_sun, t), 0.0);
        // Sun side: full sunlight.
        assert_eq!(m.shadow(V3::new(-7.0e6, 0.0, 0.0), s_sun, t), 1.0);
        // Beside Earth, well outside the shadow cylinder: sunlight.
        assert_eq!(m.shadow(V3::new(1.0e6, 7.0e6, 0.0), s_sun, t), 1.0);
        // Scan across the shadow edge at 7,000 km behind: ν rises monotonically 0 → 1
        // through the penumbra, which lies between y ≈ R − x(R☉ − R)/D ≈ 6,346 km and
        // R + x(R☉ + R)/D ≈ 6,411 km.
        let mut last = 0.0;
        let mut partial = 0;
        for k in 0..=400 {
            let y = 6.30e6 + f64::from(k) * 500.0;
            let nu = m.shadow(V3::new(7.0e6, y, 0.0), s_sun, t);
            assert!(nu >= last - 1e-12, "non-monotonic at y = {y}");
            if nu > 0.0 && nu < 1.0 {
                partial += 1;
            }
            last = nu;
        }
        assert!(
            partial > 10 && last == 1.0,
            "partial samples {partial}, end ν {last}"
        );
    }

    #[test]
    fn srp_and_drag_accelerations_match_hand_calculation() {
        let (e, reg) = (static_ephemeris(), BodyRegistry::builtin());
        let mut p = Propagator::new(&e, &reg);
        p.ballistic = Ballistic {
            cd: 2.2,
            drag_area: 20.0,
            cr: 1.5,
            srp_area: 30.0,
        };
        let t = Epoch::from_tdb_seconds(8.4e8);
        let mass = 5_000.0;
        // Sunlit, 400 km over the sub-solar side.
        let r = V3::new(-6_778_137.0, 0.0, 0.0);
        let v = V3::new(0.0, 7_668.0, 0.0);
        let y = [r.x, r.y, r.z, v.x, v.y, v.z, mass];
        let eval = |third: bool, drag: bool, srp: bool| {
            let mut q = Propagator::new(&e, &reg);
            q.ballistic = p.ballistic;
            q.forces = ForceConfig {
                third_body: third,
                harmonics: false,
                drag,
                srp,
                ..ForceConfig::default()
            };
            let m = q.arc_model(BodyId::EARTH, t, &[false; 6], None);
            let d = m.derivative(0.0, &y);
            V3::new(d[3], d[4], d[5])
        };
        let base = eval(true, false, false);
        // SRP: P = S/c at 1 au, along Sun → spacecraft (+x here: the Sun is at −x from
        // Earth, the spacecraft on the day side between them); a = P·Cr·A/m.
        let a_srp = eval(true, false, true) - base;
        let d = ASTRONOMICAL_UNIT - 6_778_137.0;
        let expected = SOLAR_IRRADIANCE_1AU / SPEED_OF_LIGHT
            * (ASTRONOMICAL_UNIT / d)
            * (ASTRONOMICAL_UNIT / d)
            * 1.5
            * 30.0
            / mass;
        // Differencing two ~8.7 m/s² totals leaves ~1e-15 m/s² of rounding on a 4e-8 m/s² term.
        assert!(
            (a_srp.norm() / expected - 1.0).abs() < 1e-6,
            "{} vs {expected}",
            a_srp.norm()
        );
        assert!(a_srp.x > 0.0 && a_srp.y.abs() < 1e-14);
        // Drag: −½ ρ |v_rel| v_rel Cd A/m with the co-rotating atmosphere.
        let a_drag = eval(true, true, false) - base;
        let (o, _) = earth::earth_orientation(t);
        let rho = atmosphere::density(
            BodyId::EARTH,
            o.icrf_to_bf.mul_v3(r),
            t,
            &SpaceWeather::default(),
        )
        .unwrap();
        let v_rel = v - o.icrf_to_bf.transpose().mul_v3(o.omega_bf).cross(r);
        let expected = v_rel * (-0.5 * rho * v_rel.norm() * 2.2 * 20.0 / mass);
        assert!(
            (a_drag - expected).norm() < 1e-6 * expected.norm(),
            "{a_drag:?} vs {expected:?}"
        );
        assert!(rho > 1e-13 && rho < 1e-10, "ρ(400 km) = {rho:e}");
    }
}
