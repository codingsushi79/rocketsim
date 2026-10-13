//! Data-driven spacecraft definitions and mass properties.
//!
//! A vehicle is a JSON file (`data/vehicles/*.json`, rationale in `docs/spacecraft_v1.md`).
//! There are no vehicle-specific code paths: everything below works for any
//! definition that passes [`VehicleConfig::validate`].
//!
//! **Body frame** ([`crate::frames::ScBody`]): +X points forward along the stack axis
//! (the main engine pushes along +X), and Y and Z complete a right-handed set. The
//! origin is fixed to the structure, so the centre of mass moves as tanks drain and
//! as stages separate. All positions are in metres in this frame.
//!
//! **Mass properties.** Every part and tank is a homogeneous primitive with a mass:
//! solid or thin-shell cylinder or cone, solid sphere, box, or point. Inertia comes
//! from the standard closed forms and is moved to the vehicle centre of mass with the
//! parallel-axis theorem. Propellant is a rigid solid filling its tank to the current
//! fill fraction along the tank axis, from the aft end (axial settling). Slosh is not
//! modelled.

use crate::math::{M3, V3};
use serde::Deserialize;

/// Shape of a part or tank, used for inertia and by the model generator.
///
/// The axis of an axisymmetric shape is `axis` in [`Part`]/[`Tank`]. Cones point
/// from base to apex along it.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Shape {
    /// Solid cylinder, centred on `position`.
    Cylinder { radius: f64, length: f64 },
    /// Thin-walled cylinder with open ends (structure skins), centred on `position`.
    CylinderShell { radius: f64, length: f64 },
    /// Solid cone; `position` is the centre of the base.
    Cone { base_radius: f64, height: f64 },
    /// Thin conical shell without a base (nozzles, capsule skins); `position` is the
    /// centre of the base circle.
    ConeShell { base_radius: f64, height: f64 },
    /// Solid sphere, centred on `position`.
    Sphere { radius: f64 },
    /// Solid box aligned with the body axes, centred on `position`.
    Box { size: [f64; 3] },
    /// Point mass at `position`.
    Point,
}

impl Shape {
    /// Centre of mass along the axis, measured from `position`.
    fn com_offset(self) -> f64 {
        match self {
            // Solid cone: h/4 from the base. Thin conical shell: h/3 from the base.
            Shape::Cone { height, .. } => height / 4.0,
            Shape::ConeShell { height, .. } => height / 3.0,
            _ => 0.0,
        }
    }

    /// (I_axial, I_transverse) about the shape's own centre of mass, for unit mass.
    /// Standard results (e.g. Meriam & Kraige, *Engineering Mechanics: Dynamics*,
    /// Appendix B, Table D/4):
    /// - solid cylinder: ½r², (3r² + L²)/12
    /// - thin cylindrical shell: r², (6r² + L²)/12 = r²/2 + L²/12
    /// - solid cone, about its CoM: 3r²/10, 3r²/20 + 3h²/80
    /// - thin conical shell (lateral surface), about its CoM: r²/2, r²/4 + h²/18
    /// - solid sphere: 2r²/5
    fn unit_inertia_axisymmetric(self) -> Option<(f64, f64)> {
        Some(match self {
            Shape::Cylinder {
                radius: r,
                length: l,
            } => (0.5 * r * r, (3.0 * r * r + l * l) / 12.0),
            Shape::CylinderShell {
                radius: r,
                length: l,
            } => (r * r, 0.5 * r * r + l * l / 12.0),
            Shape::Cone {
                base_radius: r,
                height: h,
            } => (0.3 * r * r, 0.15 * r * r + 0.0375 * h * h),
            Shape::ConeShell {
                base_radius: r,
                height: h,
            } => (0.5 * r * r, 0.25 * r * r + h * h / 18.0),
            Shape::Sphere { radius: r } => (0.4 * r * r, 0.4 * r * r),
            Shape::Point => (0.0, 0.0),
            Shape::Box { .. } => return None,
        })
    }

    fn dims_valid(self) -> bool {
        let pos = |x: f64| x.is_finite() && x > 0.0;
        match self {
            Shape::Cylinder { radius, length } | Shape::CylinderShell { radius, length } => {
                pos(radius) && pos(length)
            }
            Shape::Cone {
                base_radius,
                height,
            }
            | Shape::ConeShell {
                base_radius,
                height,
            } => pos(base_radius) && pos(height),
            Shape::Sphere { radius } => pos(radius),
            Shape::Box { size } => size.iter().all(|&s| pos(s)),
            Shape::Point => true,
        }
    }
}

/// A rigid structural part: dry mass that belongs to one stage.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Part {
    pub id: String,
    pub stage: String,
    /// kg
    pub mass: f64,
    pub shape: Shape,
    pub position: [f64; 3],
    #[serde(default = "default_axis")]
    pub axis: [f64; 3],
    /// What the part is (shown in the UI and used by the model generator).
    #[serde(default)]
    pub kind: String,
}

fn default_axis() -> [f64; 3] {
    [1.0, 0.0, 0.0]
}

/// A propellant tank. Its dry mass is part of the stage structure.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tank {
    pub id: String,
    pub stage: String,
    /// Propellant name, e.g. "MMH", "NTO", "N2H4".
    pub propellant: String,
    /// Usable propellant capacity, kg.
    pub capacity: f64,
    /// Initial load, kg (defaults to full).
    #[serde(default)]
    pub initial: Option<f64>,
    /// Volume the propellant fills (cylinder or sphere).
    pub shape: Shape,
    pub position: [f64; 3],
    #[serde(default = "default_axis")]
    pub axis: [f64; 3],
}

/// Propellant feed of an engine or thruster group: bipropellant (fuel + oxidizer at a
/// mixture ratio) or monopropellant (fuel only).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Feed {
    /// Fuel tank ids (drawn in proportion to their contents).
    pub fuel_tanks: Vec<String>,
    #[serde(default)]
    pub oxidizer_tanks: Vec<String>,
    /// Oxidizer-to-fuel mass ratio (0 for monopropellant).
    #[serde(default)]
    pub mixture_ratio: f64,
}

/// A main engine.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Engine {
    pub id: String,
    pub stage: String,
    /// Gimbal pivot (thrust application point), m.
    pub position: [f64; 3],
    /// Nominal force direction on the vehicle (opposite to the exhaust).
    pub direction: [f64; 3],
    /// Vacuum thrust at full throttle, N.
    pub thrust_vac: f64,
    /// Vacuum specific impulse, s.
    pub isp_vac: f64,
    /// Nozzle exit area, m². Thrust at ambient pressure p is F_vac − p·A_e at constant
    /// mass flow (Sutton & Biblarz, *Rocket Propulsion Elements*, 9th ed., eq. 3-21).
    pub exit_area: f64,
    /// Nozzle exit static pressure (Pa) and exit Mach number at full throttle. Rendering
    /// only (the plume's expansion with ambient pressure); the physics doesn't use them.
    #[serde(default)]
    pub exit_pressure: Option<f64>,
    #[serde(default)]
    pub exit_mach: Option<f64>,
    /// Lowest throttle setting (1 = not throttleable).
    pub throttle_min: f64,
    /// Number of ignitions available.
    pub ignitions: u32,
    /// Minimum burn duration once ignited, s.
    pub min_on_time: f64,
    /// Gimbal range (cone half-angle) and slew rate.
    pub gimbal_max_deg: f64,
    pub gimbal_rate_deg_s: f64,
    pub feed: Feed,
}

/// A group of identical RCS thrusters sharing a feed.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RcsGroup {
    pub id: String,
    pub stage: String,
    pub thrust_vac: f64,
    pub isp_vac: f64,
    pub feed: Feed,
    pub thrusters: Vec<Thruster>,
    /// Stages whose presence inhibits this group (e.g. a capsule's entry RCS stays
    /// sealed until the service module is gone, as on Apollo).
    #[serde(default)]
    pub inhibited_while_attached: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Thruster {
    pub position: [f64; 3],
    /// Force direction on the vehicle (opposite to the exhaust).
    pub direction: [f64; 3],
}

/// A reaction wheel.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wheel {
    pub id: String,
    pub stage: String,
    pub axis: [f64; 3],
    /// Maximum motor torque, N·m.
    pub max_torque: f64,
    /// Momentum capacity, N·m·s.
    pub max_momentum: f64,
}

/// Aerodynamics, radiation pressure and structural limits of one stage. The vehicle
/// uses the aero block of its lowest attached stage (the stack as it then flies), and
/// the most restrictive limits of all attached stages.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageAero {
    pub cd: f64,
    /// Drag reference area, m².
    pub drag_area: f64,
    pub cr: f64,
    pub srp_area: f64,
    /// Effective nose radius for stagnation heating, m.
    pub nose_radius: f64,
    /// Structural dynamic-pressure limit, Pa.
    pub max_dynamic_pressure: f64,
    /// Stagnation-point heat-flux limit, W/m².
    pub max_heat_flux: f64,
    /// Highest surface-relative speed at ground contact the stage survives, m/s
    /// (landing or splashdown); faster is a crash.
    #[serde(default = "default_impact_speed")]
    pub max_impact_speed: f64,
}

fn default_impact_speed() -> f64 {
    // Typical landing-gear design touchdown limit (~3 m/s) when the data gives none.
    3.0
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stage {
    pub id: String,
    pub name: String,
    pub aero: StageAero,
    /// Relative separation speed given by the separation system, m/s.
    #[serde(default)]
    pub separation_dv: f64,
}

/// SAS tuning: closed-loop bandwidth of the attitude loop, rate limit, and manual
/// rate authority.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SasConfig {
    /// Attitude-loop gain k_θ, 1/s (the rate loop runs 4× faster: critical damping).
    pub bandwidth: f64,
    /// Maximum slew rate, deg/s.
    pub max_rate_deg_s: f64,
    /// Rotation rate commanded by full manual stick deflection with SAS on, deg/s.
    pub manual_rate_deg_s: f64,
}

/// A complete vehicle definition.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VehicleConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Path of the 3D model, relative to the web root.
    #[serde(default)]
    pub model: String,
    /// Stages in jettison order: `stages[0]` separates first; the last never does.
    pub stages: Vec<Stage>,
    pub parts: Vec<Part>,
    #[serde(default)]
    pub tanks: Vec<Tank>,
    #[serde(default)]
    pub engines: Vec<Engine>,
    #[serde(default)]
    pub rcs: Vec<RcsGroup>,
    #[serde(default)]
    pub wheels: Vec<Wheel>,
    pub sas: SasConfig,
    /// Renderer-only cockpit layout (eye point, windows, displays). Opaque to the core:
    /// it carries no physics and is passed through unread.
    #[serde(default)]
    pub cabin: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConfigError(pub String);

impl core::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "vehicle config: {}", self.0)
    }
}

impl std::error::Error for ConfigError {}

pub fn v3(a: [f64; 3]) -> V3 {
    V3::new(a[0], a[1], a[2])
}

impl VehicleConfig {
    /// Parse and validate a JSON definition.
    pub fn from_json(text: &str) -> Result<VehicleConfig, ConfigError> {
        let c: VehicleConfig =
            serde_json::from_str(text).map_err(|e| ConfigError(e.to_string()))?;
        c.validate()?;
        Ok(c)
    }

    pub fn stage_index(&self, id: &str) -> Option<usize> {
        self.stages.iter().position(|s| s.id == id)
    }

    pub fn tank_index(&self, id: &str) -> Option<usize> {
        self.tanks.iter().position(|t| t.id == id)
    }

    /// Reject anything the physics can't handle: unknown references, non-physical
    /// numbers, zero vectors.
    // `!(x > 0.0)` is deliberate: unlike `x <= 0.0` it also rejects NaN.
    #[allow(clippy::nonminimal_bool)]
    pub fn validate(&self) -> Result<(), ConfigError> {
        let err = |s: String| Err(ConfigError(s));
        if self.stages.is_empty() {
            return err("at least one stage is required".into());
        }
        let finite_pos = |x: f64| x.is_finite() && x > 0.0;
        let finite_nonneg = |x: f64| x.is_finite() && x >= 0.0;
        let unit = |a: [f64; 3]| v3(a).normalized().is_some();
        let finite3 = |a: [f64; 3]| a.iter().all(|x| x.is_finite());
        let mut ids = std::collections::BTreeSet::new();
        for s in &self.stages {
            if !ids.insert(format!("stage:{}", s.id)) {
                return err(format!("duplicate stage id {}", s.id));
            }
            let a = &s.aero;
            if ![a.cd, a.drag_area, a.cr, a.srp_area, a.nose_radius]
                .iter()
                .all(|&x| finite_nonneg(x))
                || !(a.max_dynamic_pressure > 0.0 && a.max_heat_flux > 0.0)
                || !finite_nonneg(s.separation_dv)
            {
                return err(format!("stage {}: bad aero/limits", s.id));
            }
        }
        let stage_ok = |id: &str| self.stage_index(id).is_some();
        for p in &self.parts {
            if !ids.insert(format!("part:{}", p.id)) {
                return err(format!("duplicate part id {}", p.id));
            }
            if !stage_ok(&p.stage)
                || !finite_pos(p.mass)
                || !p.shape.dims_valid()
                || !finite3(p.position)
                || !unit(p.axis)
            {
                return err(format!("part {}: bad stage, mass, shape or vectors", p.id));
            }
        }
        for t in &self.tanks {
            if !ids.insert(format!("tank:{}", t.id)) {
                return err(format!("duplicate tank id {}", t.id));
            }
            let init = t.initial.unwrap_or(t.capacity);
            if !stage_ok(&t.stage)
                || !finite_pos(t.capacity)
                || !(finite_nonneg(init) && init <= t.capacity)
                || !matches!(t.shape, Shape::Cylinder { .. } | Shape::Sphere { .. })
                || !t.shape.dims_valid()
                || !finite3(t.position)
                || !unit(t.axis)
            {
                return err(format!(
                    "tank {}: bad stage, capacity, load or shape (cylinder/sphere)",
                    t.id
                ));
            }
        }
        let feed_ok = |f: &Feed| {
            let tanks_ok = |list: &[String]| list.iter().all(|id| self.tank_index(id).is_some());
            !f.fuel_tanks.is_empty()
                && tanks_ok(&f.fuel_tanks)
                && tanks_ok(&f.oxidizer_tanks)
                && finite_nonneg(f.mixture_ratio)
                && (f.mixture_ratio == 0.0) == f.oxidizer_tanks.is_empty()
        };
        for e in &self.engines {
            if !ids.insert(format!("engine:{}", e.id)) {
                return err(format!("duplicate engine id {}", e.id));
            }
            if !stage_ok(&e.stage)
                || !finite_pos(e.thrust_vac)
                || !finite_pos(e.isp_vac)
                || !finite_nonneg(e.exit_area)
                || !(e.throttle_min > 0.0 && e.throttle_min <= 1.0)
                || !finite_nonneg(e.min_on_time)
                || !(finite_nonneg(e.gimbal_max_deg) && e.gimbal_max_deg < 45.0)
                || !finite_nonneg(e.gimbal_rate_deg_s)
                || !finite3(e.position)
                || !unit(e.direction)
                || !feed_ok(&e.feed)
            {
                return err(format!("engine {}: bad parameters or feed", e.id));
            }
        }
        for g in &self.rcs {
            if !ids.insert(format!("rcs:{}", g.id)) {
                return err(format!("duplicate rcs group id {}", g.id));
            }
            if !stage_ok(&g.stage)
                || !g.inhibited_while_attached.iter().all(|s| stage_ok(s))
                || !finite_pos(g.thrust_vac)
                || !finite_pos(g.isp_vac)
                || !feed_ok(&g.feed)
                || g.thrusters.is_empty()
                || !g
                    .thrusters
                    .iter()
                    .all(|t| finite3(t.position) && unit(t.direction))
            {
                return err(format!("rcs group {}: bad parameters", g.id));
            }
        }
        for w in &self.wheels {
            if !ids.insert(format!("wheel:{}", w.id)) {
                return err(format!("duplicate wheel id {}", w.id));
            }
            if !stage_ok(&w.stage)
                || !unit(w.axis)
                || !finite_pos(w.max_torque)
                || !finite_pos(w.max_momentum)
            {
                return err(format!("wheel {}: bad parameters", w.id));
            }
        }
        let s = &self.sas;
        if !(finite_pos(s.bandwidth)
            && finite_pos(s.max_rate_deg_s)
            && finite_pos(s.manual_rate_deg_s))
        {
            return err("sas: gains must be positive".into());
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Mass properties
// ---------------------------------------------------------------------------

/// Mass, centre of mass and inertia tensor (about the centre of mass, body axes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MassProperties {
    pub mass: f64,
    pub com: V3,
    pub inertia: M3,
}

/// Accumulates point-mass contributions about the body origin: Σm, Σm·r and the
/// inertia about the origin. The result is moved to the centre of mass at the end.
#[derive(Clone, Copy, Debug)]
struct MassAccumulator {
    mass: f64,
    first_moment: V3,
    inertia_origin: M3,
}

impl MassAccumulator {
    fn new() -> MassAccumulator {
        MassAccumulator {
            mass: 0.0,
            first_moment: V3::ZERO,
            inertia_origin: zero_m3(),
        }
    }

    /// Add a body of mass `m` centred at `c` with inertia `i_cm` about its own centre.
    /// Parallel-axis theorem: I_O = I_cm + m(|c|²·1 − c cᵀ).
    fn add(&mut self, m: f64, c: V3, i_cm: M3) {
        if m <= 0.0 {
            return;
        }
        self.mass += m;
        self.first_moment += c * m;
        self.inertia_origin = add_m3(&add_m3(&self.inertia_origin, &i_cm), &parallel_axis(m, c));
    }

    fn finish(self) -> MassProperties {
        if self.mass <= 0.0 {
            return MassProperties {
                mass: 0.0,
                com: V3::ZERO,
                inertia: zero_m3(),
            };
        }
        let com = self.first_moment * (1.0 / self.mass);
        // Shift back from the origin to the centre of mass.
        let inertia = sub_m3(&self.inertia_origin, &parallel_axis(self.mass, com));
        MassProperties {
            mass: self.mass,
            com,
            inertia,
        }
    }
}

pub fn zero_m3() -> M3 {
    M3::from_rows(V3::ZERO, V3::ZERO, V3::ZERO)
}

pub fn add_m3(a: &M3, b: &M3) -> M3 {
    M3::from_rows(
        a.rows[0] + b.rows[0],
        a.rows[1] + b.rows[1],
        a.rows[2] + b.rows[2],
    )
}

pub fn sub_m3(a: &M3, b: &M3) -> M3 {
    M3::from_rows(
        a.rows[0] - b.rows[0],
        a.rows[1] - b.rows[1],
        a.rows[2] - b.rows[2],
    )
}

pub fn scale_m3(a: &M3, s: f64) -> M3 {
    M3::from_rows(a.rows[0] * s, a.rows[1] * s, a.rows[2] * s)
}

/// m(|d|²·1 − d dᵀ)
fn parallel_axis(m: f64, d: V3) -> M3 {
    let d2 = d.norm_squared();
    M3::from_rows(
        V3::new(d2 - d.x * d.x, -d.x * d.y, -d.x * d.z) * m,
        V3::new(-d.y * d.x, d2 - d.y * d.y, -d.y * d.z) * m,
        V3::new(-d.z * d.x, -d.z * d.y, d2 - d.z * d.z) * m,
    )
}

/// Inertia of an axisymmetric body: I_t·1 + (I_a − I_t)·a aᵀ, for unit axis a.
fn axisymmetric(i_axial: f64, i_trans: f64, a: V3) -> M3 {
    let k = i_axial - i_trans;
    M3::from_rows(
        V3::new(i_trans + k * a.x * a.x, k * a.x * a.y, k * a.x * a.z),
        V3::new(k * a.y * a.x, i_trans + k * a.y * a.y, k * a.y * a.z),
        V3::new(k * a.z * a.x, k * a.z * a.y, i_trans + k * a.z * a.z),
    )
}

/// Centre of mass and inertia (about it) of a shape with mass `m`.
fn shape_mass(shape: Shape, m: f64, position: V3, axis: V3) -> (V3, M3) {
    let a = axis.normalized().unwrap_or(V3::X);
    let c = position + a * shape.com_offset();
    let i = match shape {
        Shape::Box { size: [x, y, z] } => M3::from_rows(
            V3::new(m * (y * y + z * z) / 12.0, 0.0, 0.0),
            V3::new(0.0, m * (x * x + z * z) / 12.0, 0.0),
            V3::new(0.0, 0.0, m * (x * x + y * y) / 12.0),
        ),
        _ => {
            let (ia, it) = shape.unit_inertia_axisymmetric().unwrap_or((0.0, 0.0));
            axisymmetric(m * ia, m * it, a)
        }
    };
    (c, i)
}

/// Propellant of mass `m` in a tank filled to `fill` ∈ [0, 1]: settled at the aft end
/// (−axis) of a cylindrical tank as a shorter solid cylinder. Spheres are treated as
/// a full solid sphere scaled by mass, a documented simplification (the centre of
/// mass of a partly filled sphere moves by at most 3/8 r).
fn propellant_mass(tank: &Tank, m: f64, fill: f64) -> (V3, M3) {
    let pos = v3(tank.position);
    let axis = v3(tank.axis);
    match tank.shape {
        Shape::Cylinder { radius, length } => {
            let l = (length * fill).max(1e-9);
            let a = axis.normalized().unwrap_or(V3::X);
            let centre = pos - a * (0.5 * (length - l));
            shape_mass(Shape::Cylinder { radius, length: l }, m, centre, a)
        }
        s => shape_mass(s, m, pos, axis),
    }
}

/// Mass properties of the attached stages (`attached[i]` for `config.stages[i]`)
/// with tank loads `tank_mass` (kg, per `config.tanks`).
pub fn mass_properties(
    config: &VehicleConfig,
    attached: &[bool],
    tank_mass: &[f64],
) -> MassProperties {
    let on = |stage: &str| {
        config
            .stage_index(stage)
            .is_some_and(|i| attached.get(i).copied().unwrap_or(false))
    };
    let mut acc = MassAccumulator::new();
    for p in config.parts.iter().filter(|p| on(&p.stage)) {
        let (c, i) = shape_mass(p.shape, p.mass, v3(p.position), v3(p.axis));
        acc.add(p.mass, c, i);
    }
    for (t, &m) in config.tanks.iter().zip(tank_mass) {
        if on(&t.stage) && m > 0.0 {
            let (c, i) = propellant_mass(t, m, (m / t.capacity).clamp(0.0, 1.0));
            acc.add(m, c, i);
        }
    }
    acc.finish()
}

/// Inverse of a 3×3 matrix, or `None` if it is singular. With rows a, b, c the
/// inverse's columns are b×c, c×a, a×b divided by det = a·(b×c).
pub fn inverse_m3(m: &M3) -> Option<M3> {
    let [a, b, c] = m.rows;
    let det = a.dot(b.cross(c));
    if !(det.is_finite() && det.abs() > 0.0) {
        return None;
    }
    let cols = M3::from_rows(b.cross(c), c.cross(a), a.cross(b));
    Some(scale_m3(&cols.transpose(), 1.0 / det))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * (1.0 + b.abs())
    }

    fn minimal(parts: &str, tanks: &str) -> VehicleConfig {
        let json = format!(
            r#"{{
              "name": "test",
              "stages": [{{"id": "s", "name": "S", "aero": {{"cd": 2, "drag_area": 1, "cr": 1, "srp_area": 1,
                 "nose_radius": 1, "max_dynamic_pressure": 1e5, "max_heat_flux": 1e6}}}}],
              "parts": [{parts}],
              "tanks": [{tanks}],
              "sas": {{"bandwidth": 0.3, "max_rate_deg_s": 3, "manual_rate_deg_s": 2}}
            }}"#
        );
        VehicleConfig::from_json(&json).unwrap()
    }

    #[test]
    fn two_point_masses_hand_calculation() {
        // 1 kg at x = 0 and 3 kg at x = 4: CoM at 3, I_yy = 1·3² + 3·1² = 12.
        let c = minimal(
            r#"{"id": "a", "stage": "s", "mass": 1, "shape": "point", "position": [0, 0, 0]},
               {"id": "b", "stage": "s", "mass": 3, "shape": "point", "position": [4, 0, 0]}"#,
            "",
        );
        let mp = mass_properties(&c, &[true], &[]);
        assert_eq!(mp.mass, 4.0);
        assert!(close(mp.com.x, 3.0, 1e-15));
        assert!(close(mp.inertia.rows[1].y, 12.0, 1e-14));
        assert!(close(mp.inertia.rows[2].z, 12.0, 1e-14));
        assert!(mp.inertia.rows[0].x.abs() < 1e-14);
    }

    #[test]
    fn solid_cylinder_along_y_matches_closed_form() {
        // m = 10, r = 0.5, L = 2 along Y: I_yy = ½mr² = 1.25, I_xx = I_zz = m(3r²+L²)/12.
        let c = minimal(
            r#"{"id": "c", "stage": "s", "mass": 10,
                "shape": {"cylinder": {"radius": 0.5, "length": 2}},
                "position": [1, 2, 3], "axis": [0, 1, 0]}"#,
            "",
        );
        let mp = mass_properties(&c, &[true], &[]);
        assert!(mp.com.max_abs_diff(V3::new(1.0, 2.0, 3.0)) < 1e-15);
        let it = 10.0 * (3.0 * 0.25 + 4.0) / 12.0;
        assert!(close(mp.inertia.rows[1].y, 1.25, 1e-14));
        assert!(close(mp.inertia.rows[0].x, it, 1e-14));
        assert!(close(mp.inertia.rows[2].z, it, 1e-14));
    }

    #[test]
    fn cone_centre_of_mass_is_a_quarter_height_from_the_base() {
        let c = minimal(
            r#"{"id": "k", "stage": "s", "mass": 2,
                "shape": {"cone": {"base_radius": 1, "height": 4}}, "position": [0, 0, 0]}"#,
            "",
        );
        let mp = mass_properties(&c, &[true], &[]);
        assert!(close(mp.com.x, 1.0, 1e-15));
        assert!(close(mp.inertia.rows[0].x, 0.6, 1e-14)); // 3/10·m·r²
    }

    #[test]
    fn draining_a_cylindrical_tank_moves_its_propellant_aft() {
        // 100 kg tank along +X, 2 m long, centred at the origin.
        let c = minimal(
            r#"{"id": "p", "stage": "s", "mass": 1e-9, "shape": "point", "position": [0, 0, 0]}"#,
            r#"{"id": "t", "stage": "s", "propellant": "X", "capacity": 100,
                "shape": {"cylinder": {"radius": 0.3, "length": 2}}, "position": [0, 0, 0]}"#,
        );
        let full = mass_properties(&c, &[true], &[100.0]);
        let half = mass_properties(&c, &[true], &[50.0]);
        assert!(full.com.x.abs() < 1e-9);
        // Half full: 1 m of liquid in [−1, 0], centroid at −0.5.
        assert!(close(half.com.x, -0.5, 1e-9));
        let empty = mass_properties(&c, &[true], &[0.0]);
        assert!(close(empty.mass, 1e-9, 1e-12));
    }

    #[test]
    fn detached_stages_are_excluded() {
        let c = minimal(
            r#"{"id": "a", "stage": "s", "mass": 5, "shape": "point", "position": [1, 0, 0]}"#,
            "",
        );
        assert_eq!(mass_properties(&c, &[false], &[]).mass, 0.0);
    }

    #[test]
    fn inverse_of_inertia() {
        let m = M3::from_rows(
            V3::new(4.0, 0.5, -0.2),
            V3::new(0.5, 3.0, 0.1),
            V3::new(-0.2, 0.1, 5.0),
        );
        let inv = inverse_m3(&m).unwrap();
        let p = m.mul_m3(&inv);
        for i in 0..3 {
            assert!(p.rows[i].max_abs_diff(M3::IDENTITY.rows[i]) < 1e-15);
        }
    }

    #[test]
    fn validation_rejects_unknown_tank_reference() {
        let json = r#"{"name": "x",
          "stages": [{"id": "s", "name": "S", "aero": {"cd": 2, "drag_area": 1, "cr": 1, "srp_area": 1,
             "nose_radius": 1, "max_dynamic_pressure": 1e5, "max_heat_flux": 1e6}}],
          "parts": [{"id": "a", "stage": "s", "mass": 1, "shape": "point", "position": [0, 0, 0]}],
          "rcs": [{"id": "r", "stage": "s", "thrust_vac": 1, "isp_vac": 200,
                   "feed": {"fuel_tanks": ["nope"]},
                   "thrusters": [{"position": [0, 0, 0], "direction": [1, 0, 0]}]}],
          "sas": {"bandwidth": 0.3, "max_rate_deg_s": 3, "manual_rate_deg_s": 2}}"#;
        assert!(VehicleConfig::from_json(json).is_err());
    }
}
