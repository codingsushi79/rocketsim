//! Six-degree-of-freedom flight of a data-driven vehicle ([`crate::vehicle`]).
//!
//! **Time.** Control runs on a fixed grid of [`CONTROL_DT`] ticks counted from the
//! flight's start epoch. Pilot inputs, SAS, actuator commands and propellant draw are
//! sampled once per tick and held constant across it (zero-order hold). Results so
//! depend only on the per-tick input sequence, never on frame rate or on how a frame's
//! time is chunked.
//!
//! **Translation** is the M3 truth model ([`crate::propagator`]): all gravity,
//! drag and SRP forces, SOI switching, impact. The tick's net thrust is a constant
//! inertial-direction burn whose direction is the mean of the tick's start and end
//! attitudes, with the tick's exact mass flow. Engine, RCS and propellant all act on
//! the centre of mass, which moves as tanks drain.
//!
//! **Rotation**: state is the attitude quaternion q (body → ICRF), the total
//! angular momentum H about the centre of mass in ICRF (body plus wheels), and the
//! wheel momenta hᵢ. Body rate is ω = I⁻¹(qᵀHq − Σ aᵢhᵢ).
//! - Torque-free motion conserves H exactly. Wheels only trade momentum with the body.
//! - Variable mass: dH/dt = q(τ + İω)q*. Expelled propellant carries away its share of
//!   the rigid-body angular momentum. Jet damping (the Coriolis torque of the
//!   exhaust stream) is neglected: about 0.1% of a typical slew torque here (see
//!   docs/spacecraft_v1.md).
//! - External torques: thrusters about the moving centre of mass, gimballed engine,
//!   and gravity gradient τ = 3μ/r⁵ · r_b × (I r_b) (Wie, *Space Vehicle Dynamics and
//!   Control*, 2nd ed., §6.3). Aerodynamic torque is not modelled yet.
//! - Integration: classic RK4 with [`ROTATION_SUBSTEPS`] fixed substeps per tick, with
//!   the inertia tensor varying linearly over the tick.
//!
//! **On rails.** At high time warp with no actuator in use, the vehicle coasts on the
//! trajectory alone with no per-tick work. Attitude is then frozen inertially, or kept
//! on the SAS direction. Body rates are zeroed, as in KSP.

use crate::bodies::BodyId;
use crate::constants::G0;
use crate::earth;
use crate::frames::{IcrfBody, State};
use crate::math::{Quat, V3, fmath};
use crate::orientation;
use crate::propagator::{
    ArcEnd, Ballistic, Burn, BurnDirection, PropagationError, Propagator, ScState, Trajectory,
};
use crate::rcs_alloc::{self, Wrench};
use crate::time::Epoch;
use crate::vehicle::{
    Feed, MassProperties, VehicleConfig, add_m3, inverse_m3, mass_properties, scale_m3, sub_m3, v3,
};
use crate::{atmosphere, frames::BodyOrientation};

/// Control tick, s (50 Hz).
pub const CONTROL_DT: f64 = 0.02;
/// RK4 substeps per tick for the rotational dynamics (5 ms).
pub const ROTATION_SUBSTEPS: usize = 4;
/// Fraction of the braking authority the SAS plans to use, so slews stop without
/// overshoot despite estimation error (the other half is margin).
const BRAKING_MARGIN: f64 = 0.5;
/// Fine-control scale on manual inputs.
const FINE_SCALE: f64 = 0.25;
/// SAS Hold captures the attitude once body rate falls below this, rad/s (0.05°/s).
const HOLD_CAPTURE_RATE: f64 = 0.05 * core::f64::consts::PI / 180.0;
/// Automatic wheel desaturation thresholds (fraction of momentum capacity).
const DESAT_START: f64 = 0.9;
const DESAT_STOP: f64 = 0.05;
/// Desaturation spins a wheel down at this fraction of its torque limit.
const DESAT_TORQUE_FRACTION: f64 = 0.5;
/// Requests larger than any thruster set can deliver; the allocator scales them to
/// the achievable maximum in the same direction.
const SATURATING_REQUEST: f64 = 1e12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SasMode {
    Off,
    /// Kill rotation, then hold the attitude.
    Hold,
    Prograde,
    Retrograde,
    Normal,
    AntiNormal,
    RadialOut,
    RadialIn,
    Target,
    AntiTarget,
    Maneuver,
}

impl SasMode {
    pub fn from_index(i: u32) -> SasMode {
        use SasMode::*;
        [
            Off, Hold, Prograde, Retrograde, Normal, AntiNormal, RadialOut, RadialIn, Target,
            AntiTarget, Maneuver,
        ]
        .get(i as usize)
        .copied()
        .unwrap_or(Off)
    }
}

/// Velocity reference for the direction modes and the speed display.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeedReference {
    /// Inertial velocity relative to the centre body.
    Orbit,
    /// Relative to the rotating surface.
    Surface,
    /// Relative to the selected target body.
    Target,
}

/// Pilot inputs, held for one tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Controls {
    /// Rotation stick, body axes (x roll, y pitch, z yaw), each in [−1, 1].
    pub rotation: V3,
    /// Translation, body axes, each in [−1, 1].
    pub translation: V3,
    /// Main-engine throttle in [0, 1]. Raising it from 0 ignites; 0 shuts down.
    pub throttle: f64,
    pub sas: SasMode,
    pub rcs: bool,
    pub fine: bool,
    pub speed_reference: SpeedReference,
}

impl Default for Controls {
    fn default() -> Controls {
        Controls {
            rotation: V3::ZERO,
            translation: V3::ZERO,
            throttle: 0.0,
            sas: SasMode::Off,
            rcs: true,
            fine: false,
            speed_reference: SpeedReference::Orbit,
        }
    }
}

impl Controls {
    /// True if these inputs need per-tick simulation (no on-rails warp).
    pub fn active(&self) -> bool {
        self.throttle > 0.0 || self.rotation.norm() > 0.0 || self.translation.norm() > 0.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EngineState {
    pub running: bool,
    /// Time since ignition, s.
    pub on_time: f64,
    pub ignitions_left: u32,
    /// Current thrust direction (body), after gimbal.
    pub direction: V3,
    /// Throttle actually applied, and thrust last tick (N).
    pub throttle: f64,
    pub thrust: f64,
    /// Set when the engine stopped for lack of propellant or back-pressure.
    pub flameout: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FlightStatus {
    Flying,
    Impact { body: BodyId, speed: f64 },
    BrokeUp { dynamic_pressure: f64 },
    BurnedUp { heat_flux: f64 },
}

/// A jettisoned stage, handed to the caller to display or propagate.
#[derive(Clone, Debug, PartialEq)]
pub struct Debris {
    pub stage: usize,
    pub state: ScState,
    pub attitude: Quat,
    pub omega_body: V3,
    pub ballistic: Ballistic,
}

/// What the HUD shows. All SI.
#[derive(Clone, Debug, PartialEq)]
pub struct Telemetry {
    pub mass: f64,
    pub com: V3,
    pub omega_body: V3,
    pub tank_mass: Vec<f64>,
    pub wheel_fraction: Vec<f64>,
    pub engines: Vec<EngineState>,
    /// Duty per thruster, per RCS group (last tick).
    pub rcs_duty: Vec<Vec<f64>>,
    pub dynamic_pressure: f64,
    pub heat_flux: f64,
    pub ambient_pressure: f64,
    /// Main-engine Δv left and full-throttle burn time left.
    pub delta_v: f64,
    pub burn_time: f64,
    pub desaturating: bool,
    pub sas_captured: bool,
}

/// Six-degree-of-freedom flight of one vehicle.
#[derive(Clone, Debug)]
pub struct Flight {
    pub config: VehicleConfig,
    /// Epoch of tick 0.
    base: Epoch,
    /// Time of the latest state, and its tick index when on the control grid.
    t_state: Epoch,
    tick: u64,
    on_grid: bool,
    attached: Vec<bool>,
    tank: Vec<f64>,
    q: Quat,
    q_prev: Quat,
    h_inertial: V3,
    wheel_h: Vec<f64>,
    engines: Vec<EngineState>,
    rcs_duty: Vec<Vec<f64>>,
    sas_target: Option<Quat>,
    last_direction: Option<(SasMode, V3)>,
    desat: bool,
    traj: Trajectory,
    status: FlightStatus,
    pending_stage: bool,
    /// Selected target body (Target modes, target speed).
    pub target: Option<BodyId>,
    /// Burn direction of the planned maneuver (ICRF unit vector).
    pub maneuver: Option<V3>,
    /// ∫|F|/m dt over the flight, m/s.
    pub dv_expended: f64,
    /// Last time any thrust acted (the coast prediction is stale after it).
    pub last_thrust: Option<Epoch>,
    last_q_dyn: f64,
    last_heat: f64,
    last_p_amb: f64,
}

/// Environment at the tick start.
struct Environment {
    center: BodyId,
    r: V3,
    v: V3,
    mu: f64,
    /// Body rotation (ICRF), if known.
    omega_center: Option<V3>,
    p_amb: f64,
}

/// What actuators deliver over one tick.
struct Actuation {
    force_body: V3,
    torque_body: V3,
    wheel_torque: Vec<f64>,
    /// Propellant drawn per tank over the tick, kg.
    draw: Vec<f64>,
    rcs_duty: Vec<Vec<f64>>,
}

impl Flight {
    /// Start a flight at `s0` (the mass is taken from the vehicle) with attitude
    /// `q0` (body → ICRF) and zero body rate.
    pub fn new(
        config: VehicleConfig,
        s0: &ScState,
        q0: Quat,
        prop: &Propagator,
    ) -> Result<Flight, PropagationError> {
        config
            .validate()
            .map_err(|e| PropagationError::InvalidState(e.to_string()))?;
        let attached = vec![true; config.stages.len()];
        let tank: Vec<f64> = config
            .tanks
            .iter()
            .map(|t| t.initial.unwrap_or(t.capacity))
            .collect();
        let engines = config
            .engines
            .iter()
            .map(|e| EngineState {
                running: false,
                on_time: 0.0,
                ignitions_left: e.ignitions,
                direction: v3(e.direction).normalized().unwrap_or(V3::X),
                throttle: 0.0,
                thrust: 0.0,
                flameout: false,
            })
            .collect();
        let rcs_duty = config
            .rcs
            .iter()
            .map(|g| vec![0.0; g.thrusters.len()])
            .collect();
        let wheel_h = vec![0.0; config.wheels.len()];
        let mut f = Flight {
            base: s0.epoch,
            t_state: s0.epoch,
            tick: 0,
            on_grid: true,
            attached,
            tank,
            q: q0.normalized().unwrap_or(Quat::IDENTITY),
            q_prev: q0.normalized().unwrap_or(Quat::IDENTITY),
            h_inertial: V3::ZERO,
            wheel_h,
            engines,
            rcs_duty,
            sas_target: None,
            last_direction: None,
            desat: false,
            traj: Trajectory { arcs: Vec::new() },
            status: FlightStatus::Flying,
            pending_stage: false,
            target: None,
            maneuver: None,
            dv_expended: 0.0,
            last_thrust: None,
            last_q_dyn: 0.0,
            last_heat: 0.0,
            last_p_amb: 0.0,
            config,
        };
        let s = ScState {
            mass: f.mass_props().mass,
            ..*s0
        };
        let p = f.propagator(prop, true);
        f.traj = p.propagate(&s, s.epoch, &[])?;
        Ok(f)
    }

    pub fn status(&self) -> FlightStatus {
        self.status
    }

    pub fn epoch(&self) -> Epoch {
        self.t_state
    }

    pub fn trajectory(&self) -> &Trajectory {
        &self.traj
    }

    pub fn attached(&self) -> &[bool] {
        &self.attached
    }

    /// Request stage separation at the next tick.
    pub fn stage(&mut self) {
        self.pending_stage = true;
    }

    /// True if the vehicle must be simulated tick by tick (no on-rails warp).
    pub fn needs_physics(&self, c: &Controls) -> bool {
        self.status == FlightStatus::Flying
            && (c.active()
                || self.pending_stage
                || self.desat
                || self.engines.iter().any(|e| e.running))
    }

    pub fn mass_props(&self) -> MassProperties {
        mass_properties(&self.config, &self.attached, &self.tank)
    }

    /// Translational state at `t` (clamped to the stored trajectory).
    pub fn state_at(&self, t: Epoch) -> Option<ScState> {
        let start = self.traj.start_epoch();
        let end = self.traj.end_epoch();
        let t = if t.seconds_since(start) < 0.0 {
            start
        } else if t.seconds_since(end) > 0.0 {
            end
        } else {
            t
        };
        self.traj.state_at(t)
    }

    /// Attitude at `t`, interpolated across the latest tick for smooth display.
    pub fn attitude_at(&self, t: Epoch) -> Quat {
        if !self.on_grid {
            return self.q;
        }
        let s = 1.0 + t.seconds_since(self.t_state) / CONTROL_DT;
        nlerp(self.q_prev, self.q, s.clamp(0.0, 1.0))
    }

    pub fn omega_body(&self) -> V3 {
        let mp = self.mass_props();
        self.omega_from(&mp, self.q, self.h_inertial, &self.wheel_h)
    }

    fn omega_from(&self, mp: &MassProperties, q: Quat, h_i: V3, wheel_h: &[f64]) -> V3 {
        let Some(inv) = inverse_m3(&mp.inertia) else {
            return V3::ZERO;
        };
        inv.mul_v3(q.conj().rotate(h_i) - self.wheel_vector(wheel_h))
    }

    /// Σ aᵢhᵢ over attached wheels (body axes).
    fn wheel_vector(&self, wheel_h: &[f64]) -> V3 {
        let mut s = V3::ZERO;
        for (w, &h) in self.config.wheels.iter().zip(wheel_h) {
            if self.stage_on(&w.stage) {
                s += v3(w.axis).normalized().unwrap_or(V3::X) * h;
            }
        }
        s
    }

    fn stage_on(&self, id: &str) -> bool {
        self.config
            .stage_index(id)
            .is_some_and(|i| self.attached[i])
    }

    /// Index of the lowest attached stage (whose aero block applies).
    fn lowest_stage(&self) -> usize {
        self.attached.iter().position(|&a| a).unwrap_or(0)
    }

    /// The caller's propagator with this vehicle's aero, SRP and limits.
    fn propagator<'a>(&self, base: &Propagator<'a>, exact: bool) -> Propagator<'a> {
        let aero = &self.config.stages[self.lowest_stage()].aero;
        let mut p = Propagator::new(base.eph, base.reg);
        p.forces = base.forces;
        p.integrator = base.integrator;
        p.center_switching = base.center_switching;
        p.exact_horizon = exact;
        p.ballistic = Ballistic {
            cd: aero.cd,
            drag_area: aero.drag_area,
            cr: aero.cr,
            srp_area: aero.srp_area,
        };
        let attached = self
            .config
            .stages
            .iter()
            .zip(&self.attached)
            .filter(|(_, a)| **a);
        p.forces.max_dynamic_pressure = attached
            .clone()
            .map(|(s, _)| s.aero.max_dynamic_pressure)
            .fold(f64::INFINITY, f64::min);
        p.forces.max_heat_flux = attached
            .map(|(s, _)| s.aero.max_heat_flux)
            .fold(f64::INFINITY, f64::min);
        p.forces.nose_radius = aero.nose_radius;
        p
    }

    /// Advance to `until`. With `physics`, tick by tick with `controls`; otherwise on
    /// rails, extending the trajectory `lookahead` seconds past `until` for display.
    /// Returns stages jettisoned during the call.
    pub fn advance(
        &mut self,
        prop: &Propagator,
        until: Epoch,
        controls: &Controls,
        physics: bool,
        lookahead: f64,
    ) -> Result<Vec<Debris>, PropagationError> {
        let mut debris = Vec::new();
        if self.status != FlightStatus::Flying || until.seconds_since(self.t_state) <= 1e-9 {
            return Ok(debris);
        }
        if !physics {
            self.advance_on_rails(prop, until, controls, lookahead)?;
            return Ok(debris);
        }
        if !self.on_grid {
            // Re-enter the control grid at the first tick at or after the current time.
            let k = fmath_ceil(self.t_state.seconds_since(self.base) / CONTROL_DT).max(0.0);
            self.tick = k as u64;
            let t_k = self.tick_epoch(self.tick);
            if self.traj.end_epoch().seconds_since(t_k) < 0.0 {
                self.prop_extend(prop, t_k, &[])?;
            }
            if self.traj.terminated().is_none() {
                self.traj.truncate_after(t_k);
            }
            self.t_state = t_k;
            self.q_prev = self.q;
            self.on_grid = true;
            self.check_termination();
        }
        // 1 ns slack so an `until` an ulp past a tick boundary doesn't run an extra tick.
        while self.status == FlightStatus::Flying && self.t_state.seconds_since(until) < -1e-9 {
            if let Some(d) = self.step(prop, controls)? {
                debris.push(d);
            }
        }
        Ok(debris)
    }

    fn tick_epoch(&self, k: u64) -> Epoch {
        self.base.add_seconds(k as f64 * CONTROL_DT)
    }

    fn prop_extend(
        &mut self,
        prop: &Propagator,
        until: Epoch,
        burns: &[Burn],
    ) -> Result<(), PropagationError> {
        let p = self.propagator(prop, true);
        p.extend(&mut self.traj, until, burns)
    }

    fn advance_on_rails(
        &mut self,
        prop: &Propagator,
        until: Epoch,
        c: &Controls,
        lookahead: f64,
    ) -> Result<(), PropagationError> {
        // Rates are zeroed; the wheels keep their momentum.
        self.h_inertial = self.q.rotate(self.wheel_vector(&self.wheel_h));
        let p = self.propagator(prop, false);
        if self.traj.end_epoch().seconds_since(until) < lookahead.max(1.0) {
            p.extend(&mut self.traj, until.add_seconds(lookahead.max(1.0)), &[])?;
        }
        self.t_state = until;
        self.on_grid = false;
        self.check_termination();
        if self.status == FlightStatus::Flying
            && c.sas != SasMode::Off
            && c.sas != SasMode::Hold
            && let Some(s) = self.traj.state_at(until)
            && let Some(env) = self.environment(prop, &s)
            && let Some(d) = self.direction(prop, c, &env, until)
        {
            self.q = align_x(self.q, d);
            self.h_inertial = self.q.rotate(self.wheel_vector(&self.wheel_h));
        }
        self.q_prev = self.q;
        Ok(())
    }

    fn check_termination(&mut self) {
        if self.status != FlightStatus::Flying {
            return;
        }
        let Some(end) = self.traj.terminated() else {
            return;
        };
        if self.traj.end_epoch().seconds_since(self.t_state) > 0.0 {
            return; // happens later than the current time
        }
        self.status = match end {
            ArcEnd::Impact { body } => {
                let s = self.traj.end_state();
                let speed = self.surface_speed(body, &s);
                FlightStatus::Impact { body, speed }
            }
            ArcEnd::DynamicPressureLimit { q } => FlightStatus::BrokeUp {
                dynamic_pressure: q,
            },
            ArcEnd::HeatFluxLimit { flux } => FlightStatus::BurnedUp { heat_flux: flux },
            _ => FlightStatus::Flying,
        };
        self.t_state = self.traj.end_epoch();
        self.q_prev = self.q;
        for e in &mut self.engines {
            e.running = false;
            e.thrust = 0.0;
        }
    }

    fn surface_speed(&self, body: BodyId, s: &ScState) -> f64 {
        match body_orientation(body, s.epoch) {
            Some(o) => {
                let w = o.icrf_to_bf.transpose().mul_v3(o.omega_bf);
                (s.state.v - w.cross(s.state.r)).norm()
            }
            None => s.state.v.norm(),
        }
    }

    fn environment(&self, prop: &Propagator, s: &ScState) -> Option<Environment> {
        let center = s.state.frame.center;
        let mu = prop.reg.get(center).map_or(0.0, |b| b.gm);
        let o = body_orientation(center, s.epoch);
        let (omega_center, p_amb) = match &o {
            Some(o) => (
                Some(o.icrf_to_bf.transpose().mul_v3(o.omega_bf)),
                atmosphere::pressure(center, o.icrf_to_bf.mul_v3(s.state.r)),
            ),
            None => (None, 0.0),
        };
        Some(Environment {
            center,
            r: s.state.r,
            v: s.state.v,
            mu,
            omega_center,
            p_amb,
        })
    }

    /// Velocity in the selected speed reference (ICRF axes).
    fn reference_velocity(
        &self,
        prop: &Propagator,
        c: &Controls,
        env: &Environment,
        t: Epoch,
    ) -> V3 {
        match c.speed_reference {
            SpeedReference::Orbit => env.v,
            SpeedReference::Surface => match env.omega_center {
                Some(w) => env.v - w.cross(env.r),
                None => env.v,
            },
            SpeedReference::Target => match self
                .target
                .and_then(|b| prop.eph.state_relative(b, env.center, t).ok())
            {
                Some(ts) => env.v - ts.v,
                None => env.v,
            },
        }
    }

    /// Direction (ICRF unit vector) the SAS points body +X at, for direction modes.
    fn direction(
        &self,
        prop: &Propagator,
        c: &Controls,
        env: &Environment,
        t: Epoch,
    ) -> Option<V3> {
        let v = self.reference_velocity(prop, c, env, t);
        let pro = v.normalized();
        let normal = env.r.cross(v).normalized();
        let radial = match (pro, normal) {
            (Some(p), Some(n)) => p.cross(n).normalized(),
            _ => None,
        };
        let to_target = self
            .target
            .and_then(|b| prop.eph.state_relative(b, env.center, t).ok())
            .and_then(|ts| (ts.r - env.r).normalized());
        match c.sas {
            SasMode::Prograde => pro,
            SasMode::Retrograde => pro.map(|p| -p),
            SasMode::Normal => normal,
            SasMode::AntiNormal => normal.map(|n| -n),
            SasMode::RadialOut => radial,
            SasMode::RadialIn => radial.map(|r| -r),
            SasMode::Target => to_target,
            SasMode::AntiTarget => to_target.map(|d| -d),
            SasMode::Maneuver => self.maneuver.and_then(|m| m.normalized()),
            SasMode::Off | SasMode::Hold => None,
        }
    }

    /// One control tick.
    fn step(
        &mut self,
        prop: &Propagator,
        c: &Controls,
    ) -> Result<Option<Debris>, PropagationError> {
        let t0 = self.t_state;
        let t1 = self.tick_epoch(self.tick + 1);
        let dt = t1.seconds_since(t0);
        let s = self
            .traj
            .state_at(t0)
            .ok_or_else(|| PropagationError::InvalidState("no state at tick".into()))?;

        let mut debris = None;
        if self.pending_stage {
            self.pending_stage = false;
            debris = self.separate(prop, &s)?;
        }
        let s = self.traj.end_state();
        let env = self
            .environment(prop, &s)
            .ok_or_else(|| PropagationError::InvalidState("no environment".into()))?;
        self.last_p_amb = env.p_amb;
        let mp0 = self.mass_props();
        let omega = self.omega_from(&mp0, self.q, self.h_inertial, &self.wheel_h);
        let h_body = self.q.conj().rotate(self.h_inertial);

        // --- Actuators -------------------------------------------------------------
        let columns = self.rcs_columns(&mp0, c.rcs);
        let arm = columns.iter().fold(1.0_f64, |a, (_, _, _, l)| a.max(*l));
        let cols: Vec<Wrench> = columns.iter().map(|(_, _, w, _)| *w).collect();
        let tau_req = self.control(prop, c, &env, t0, &mp0, omega, h_body, &cols, arm, dt);
        let act = self.actuate(c, &env, &mp0, tau_req, &columns, &cols, arm, dt);

        // --- Propellant -------------------------------------------------------------
        let mut drawn = 0.0;
        for (m, d) in self.tank.iter_mut().zip(&act.draw) {
            let take = d.min(*m).max(0.0);
            *m -= take;
            drawn += take;
        }
        let mp1 = self.mass_props();
        self.rcs_duty = act.rcs_duty;

        // --- Rotation ---------------------------------------------------------------
        let r_body = self.q.conj().rotate(env.r);
        let rn = env.r.norm();
        let tau_gg = if env.mu > 0.0 && rn > 0.0 {
            r_body.cross(mp0.inertia.mul_v3(r_body)) * (3.0 * env.mu / (rn * rn * rn * rn * rn))
        } else {
            V3::ZERO
        };
        let tau_ext = act.torque_body + tau_gg;
        let q0 = self.q;
        self.integrate_rotation(&mp0, &mp1, tau_ext, &act.wheel_torque, dt);

        // --- Translation ------------------------------------------------------------
        let f_i = (q0.rotate(act.force_body) + self.q.rotate(act.force_body)) * 0.5;
        let thrust = f_i.norm();
        let mass_flow = drawn / dt;
        let burns = if thrust > 0.0 || mass_flow > 0.0 {
            self.last_thrust = Some(t1);
            let m_mid = 0.5 * (mp0.mass + mp1.mass);
            self.dv_expended += act.force_body.norm() / m_mid * dt;
            vec![Burn {
                start: t0,
                end: t1,
                thrust,
                isp: 1.0,
                direction: BurnDirection::Inertial(f_i.normalized().unwrap_or(V3::X)),
                mass_flow: Some(mass_flow),
            }]
        } else {
            Vec::new()
        };
        self.prop_extend(prop, t1, &burns)?;
        self.q_prev = q0;
        self.tick += 1;
        self.t_state = t1;
        self.update_aero_telemetry(prop);
        self.check_termination();
        Ok(debris)
    }

    fn update_aero_telemetry(&mut self, prop: &Propagator) {
        self.last_q_dyn = 0.0;
        self.last_heat = 0.0;
        let Some(s) = self.traj.state_at(self.t_state) else {
            return;
        };
        let center = s.state.frame.center;
        let Some(o) = body_orientation(center, s.epoch) else {
            return;
        };
        let r_bf = o.icrf_to_bf.mul_v3(s.state.r);
        let Some(rho) = atmosphere::density(center, r_bf, s.epoch, &prop.forces.space_weather)
        else {
            return;
        };
        let w = o.icrf_to_bf.transpose().mul_v3(o.omega_bf);
        let v = (s.state.v - w.cross(s.state.r)).norm();
        self.last_q_dyn = 0.5 * rho * v * v;
        let rn = self.config.stages[self.lowest_stage()].aero.nose_radius;
        self.last_heat = atmosphere::stagnation_heat_flux(center, rho, v, rn).unwrap_or(0.0);
    }

    /// Thruster columns about the current centre of mass: (group, thruster, wrench,
    /// lever arm). Only attached, uninhibited groups with propellant.
    fn rcs_columns(&self, mp: &MassProperties, enabled: bool) -> Vec<(usize, usize, Wrench, f64)> {
        let mut out = Vec::new();
        if !enabled {
            return out;
        }
        for (gi, g) in self.config.rcs.iter().enumerate() {
            if !self.stage_on(&g.stage)
                || g.inhibited_while_attached.iter().any(|s| self.stage_on(s))
                || !self.feed_available(&g.feed)
            {
                continue;
            }
            for (ti, t) in g.thrusters.iter().enumerate() {
                let f = v3(t.direction).normalized().unwrap_or(V3::X) * g.thrust_vac;
                let arm = v3(t.position) - mp.com;
                let tq = arm.cross(f);
                out.push((gi, ti, [f.x, f.y, f.z, tq.x, tq.y, tq.z], arm.norm()));
            }
        }
        out
    }

    fn feed_available(&self, f: &Feed) -> bool {
        let sum = |ids: &[String]| -> f64 {
            ids.iter()
                .filter_map(|id| self.config.tank_index(id))
                .filter(|&i| self.stage_on(&self.config.tanks[i].stage))
                .map(|i| self.tank[i])
                .sum()
        };
        sum(&f.fuel_tanks) > 0.0 && (f.oxidizer_tanks.is_empty() || sum(&f.oxidizer_tanks) > 0.0)
    }

    /// Torque capacity (N·m) about unit axis `e`: wheels + pure-torque RCS + gimbal.
    fn torque_capacity(&self, e: V3, cols: &[Wrench], arm: f64, mp: &MassProperties) -> f64 {
        let mut cap = 0.0;
        for (w, &h) in self.config.wheels.iter().zip(&self.wheel_h) {
            if self.stage_on(&w.stage) && h.abs() < w.max_momentum {
                cap += w.max_torque * v3(w.axis).normalized().unwrap_or(V3::X).dot(e).abs();
            }
        }
        if !cols.is_empty() {
            let req = e * SATURATING_REQUEST;
            let a = rcs_alloc::allocate(cols, [0.0, 0.0, 0.0, req.x, req.y, req.z], arm);
            cap += V3::new(a.achieved[3], a.achieved[4], a.achieved[5])
                .dot(e)
                .max(0.0);
        }
        for (cfg, st) in self.config.engines.iter().zip(&self.engines) {
            if st.running && self.stage_on(&cfg.stage) {
                let l = (v3(cfg.position) - mp.com).norm();
                let axis = v3(cfg.direction).normalized().unwrap_or(V3::X);
                let perp = (e - axis * e.dot(axis)).norm();
                cap += st.thrust * l * fmath::sin(cfg.gimbal_max_deg.to_radians()) * perp;
            }
        }
        cap
    }

    /// SAS / manual control law: the body torque wanted this tick.
    #[allow(clippy::too_many_arguments)]
    fn control(
        &mut self,
        prop: &Propagator,
        c: &Controls,
        env: &Environment,
        t: Epoch,
        mp: &MassProperties,
        omega: V3,
        h_body: V3,
        cols: &[Wrench],
        arm: f64,
        dt: f64,
    ) -> V3 {
        let sas = &self.config.sas;
        let scale = if c.fine { FINE_SCALE } else { 1.0 };
        let stick = clamp_unit_box(c.rotation);
        if c.sas == SasMode::Off {
            self.sas_target = None;
            self.last_direction = None;
            // Direct torque: full authority in the stick direction.
            return match stick.normalized() {
                Some(e) => {
                    e * (self.torque_capacity(e, cols, arm, mp) * stick.norm().min(1.0) * scale)
                }
                None => V3::ZERO,
            };
        }
        let k_att = sas.bandwidth;
        // Critically damped cascade: rate loop 4× faster than the attitude loop.
        let k_rate = 4.0 * k_att;
        let max_rate = sas.max_rate_deg_s.to_radians();
        let omega_cmd = if stick.norm() > 0.0 {
            self.sas_target = None;
            stick * (sas.manual_rate_deg_s.to_radians() * scale)
        } else {
            let (target, ff) = match c.sas {
                SasMode::Hold => {
                    self.last_direction = None;
                    if self.sas_target.is_none() && omega.norm() < HOLD_CAPTURE_RATE {
                        self.sas_target = Some(self.q);
                    }
                    (self.sas_target, V3::ZERO)
                }
                mode => match self.direction(prop, c, env, t) {
                    Some(d) => {
                        // Feed-forward of the direction's own rotation (orbital rate).
                        let ff = match self.last_direction {
                            Some((m, d_prev)) if m == mode => d_prev.cross(d) * (1.0 / dt),
                            _ => V3::ZERO,
                        };
                        self.last_direction = Some((mode, d));
                        self.sas_target = None;
                        (Some(align_x(self.q, d)), self.q.conj().rotate(ff))
                    }
                    None => {
                        // No direction (e.g. no maneuver planned): behave as Hold.
                        self.last_direction = None;
                        if self.sas_target.is_none() && omega.norm() < HOLD_CAPTURE_RATE {
                            self.sas_target = Some(self.q);
                        }
                        (self.sas_target, V3::ZERO)
                    }
                },
            };
            match target {
                None => V3::ZERO, // killing rotation
                Some(qt) => {
                    // Error rotation from the current to the target body frame (body axes).
                    let mut qe = self.q.conj() * qt;
                    if qe.w < 0.0 {
                        qe = Quat::new(-qe.w, -qe.x, -qe.y, -qe.z);
                    }
                    let v = V3::new(qe.x, qe.y, qe.z);
                    let s = v.norm();
                    let theta = 2.0 * fmath::atan2(s, qe.w);
                    match v.normalized() {
                        Some(e) => {
                            let ie = e.dot(mp.inertia.mul_v3(e)).max(f64::MIN_POSITIVE);
                            let alpha = self.torque_capacity(e, cols, arm, mp) / ie;
                            // Rate profile: linear near the target, square-root braking
                            // curve far away (stops within BRAKING_MARGIN of the authority).
                            let w = (k_att * theta)
                                .min(max_rate)
                                .min((2.0 * BRAKING_MARGIN * alpha * theta).sqrt());
                            e * w + ff
                        }
                        None => ff,
                    }
                }
            }
        };
        mp.inertia.mul_v3((omega_cmd - omega) * k_rate) + omega.cross(h_body)
    }

    /// Engines, wheels and RCS for one tick, given the wanted torque.
    #[allow(clippy::too_many_arguments)]
    fn actuate(
        &mut self,
        c: &Controls,
        env: &Environment,
        mp: &MassProperties,
        tau_req: V3,
        columns: &[(usize, usize, Wrench, f64)],
        cols: &[Wrench],
        arm: f64,
        dt: f64,
    ) -> Actuation {
        let mut draw = vec![0.0; self.config.tanks.len()];
        let mut force = V3::ZERO;
        let mut torque = V3::ZERO;

        // Main engines: ignition logic, back-pressure, gimbal trim + steering.
        let n_running = self.engines.iter().filter(|e| e.running).count().max(1) as f64;
        for i in 0..self.engines.len() {
            let cfg = self.config.engines[i].clone();
            if !self.stage_on(&cfg.stage) {
                self.engines[i].running = false;
                self.engines[i].thrust = 0.0;
                continue;
            }
            let want = c.throttle > 0.0;
            let feed_ok = self.feed_available(&cfg.feed);
            let f_vac_min = cfg.thrust_vac * cfg.throttle_min;
            let can_run = feed_ok && f_vac_min - env.p_amb * cfg.exit_area > 0.0;
            let st = &mut self.engines[i];
            if !st.running && want && st.ignitions_left > 0 && can_run {
                st.running = true;
                st.on_time = 0.0;
                st.ignitions_left -= 1;
                st.flameout = false;
            }
            if st.running && !want && st.on_time >= cfg.min_on_time {
                st.running = false;
            }
            if st.running && !can_run {
                st.running = false;
                st.flameout = true;
            }
            if !st.running {
                st.throttle = 0.0;
                st.thrust = 0.0;
                continue;
            }
            st.throttle = c.throttle.clamp(cfg.throttle_min, 1.0);
            let (f, mdot) = engine_thrust(&cfg, st.throttle, env.p_amb);
            // Gimbal: point the thrust line through the CoM, then tilt it to make the
            // perpendicular part of the wanted torque, within range and slew rate.
            let pivot = v3(cfg.position);
            let nominal = v3(cfg.direction).normalized().unwrap_or(V3::X);
            let to_com = mp.com - pivot;
            let lever = to_com.norm();
            let trim = to_com.normalized().unwrap_or(nominal);
            let tilt = if f > 0.0 && lever > 0.0 {
                trim.cross(tau_req * (1.0 / n_running)) * (1.0 / (f * lever))
            } else {
                V3::ZERO
            };
            let desired = clamp_cone(
                (trim + tilt).normalized().unwrap_or(nominal),
                nominal,
                cfg.gimbal_max_deg.to_radians(),
            );
            st.direction = slew_toward(
                st.direction,
                desired,
                cfg.gimbal_rate_deg_s.to_radians() * dt,
            );
            st.thrust = f;
            st.on_time += dt;
            let fv = st.direction * f;
            force += fv;
            torque += (pivot - mp.com).cross(fv);
            Self::draw_feed(
                &self.config,
                &self.tank,
                &self.attached,
                &cfg.feed,
                mdot * dt,
                &mut draw,
            );
        }

        // Reaction wheels take what the engines didn't (projection onto each axis).
        let mut wheel_torque = vec![0.0; self.config.wheels.len()];
        let mut wheel_body = V3::ZERO;
        let max_h = self
            .config
            .wheels
            .iter()
            .zip(&self.wheel_h)
            .filter(|(w, _)| self.stage_on(&w.stage))
            .map(|(w, h)| h.abs() / w.max_momentum)
            .fold(0.0, f64::max);
        if max_h > DESAT_START && c.rcs && c.sas != SasMode::Off {
            self.desat = true;
        }
        if max_h < DESAT_STOP || !c.rcs || c.sas == SasMode::Off {
            self.desat = false;
        }
        let tau_rem = tau_req - torque;
        for (i, w) in self.config.wheels.iter().enumerate() {
            if !self.stage_on(&w.stage) {
                continue;
            }
            let a = v3(w.axis).normalized().unwrap_or(V3::X);
            let h = self.wheel_h[i];
            // Motor torque on the wheel: the body gets −a·t.
            let t = if self.desat {
                -h.signum() * (DESAT_TORQUE_FRACTION * w.max_torque).min(h.abs() / dt)
            } else {
                let t = (-a.dot(tau_rem)).clamp(-w.max_torque, w.max_torque);
                // Stay within the momentum capacity at the end of the tick.
                t.clamp((-w.max_momentum - h) / dt, (w.max_momentum - h) / dt)
            };
            wheel_torque[i] = t;
            wheel_body -= a * t;
        }

        // RCS: the remaining torque plus any commanded translation.
        let mut rcs_duty: Vec<Vec<f64>> = self
            .config
            .rcs
            .iter()
            .map(|g| vec![0.0; g.thrusters.len()])
            .collect();
        if !cols.is_empty() {
            let tau_rcs = tau_req - torque - wheel_body;
            let scale = if c.fine { FINE_SCALE } else { 1.0 };
            let stick = clamp_unit_box(c.translation);
            let f_req = match stick.normalized() {
                Some(e) => {
                    let req = e * SATURATING_REQUEST;
                    let a = rcs_alloc::allocate(cols, [req.x, req.y, req.z, 0.0, 0.0, 0.0], arm);
                    let cap = V3::new(a.achieved[0], a.achieved[1], a.achieved[2])
                        .dot(e)
                        .max(0.0);
                    e * (cap * stick.norm().min(1.0) * scale)
                }
                None => V3::ZERO,
            };
            if tau_rcs.norm() > 0.0 || f_req.norm() > 0.0 {
                let a = rcs_alloc::allocate(
                    cols,
                    [f_req.x, f_req.y, f_req.z, tau_rcs.x, tau_rcs.y, tau_rcs.z],
                    arm,
                );
                for (k, &(gi, ti, w, _)) in columns.iter().enumerate() {
                    let u = a.duty[k];
                    if u <= 0.0 {
                        continue;
                    }
                    rcs_duty[gi][ti] = u;
                    force += V3::new(w[0], w[1], w[2]) * u;
                    torque += V3::new(w[3], w[4], w[5]) * u;
                    let g = &self.config.rcs[gi];
                    let mdot = g.thrust_vac * u / (g.isp_vac * G0);
                    Self::draw_feed(
                        &self.config,
                        &self.tank,
                        &self.attached,
                        &g.feed,
                        mdot * dt,
                        &mut draw,
                    );
                }
            }
        }
        Actuation {
            force_body: force,
            torque_body: torque,
            wheel_torque,
            draw,
            rcs_duty,
        }
    }

    /// Add a feed's draw of `mass` kg (split by mixture ratio, then across the feed's
    /// tanks in proportion to their contents) to `draw`.
    fn draw_feed(
        config: &VehicleConfig,
        tank: &[f64],
        attached: &[bool],
        feed: &Feed,
        mass: f64,
        draw: &mut [f64],
    ) {
        let mr = feed.mixture_ratio;
        let (fuel, ox) = (mass / (1.0 + mr), mass * mr / (1.0 + mr));
        let mut take = |ids: &[String], m: f64| {
            let idx: Vec<usize> = ids
                .iter()
                .filter_map(|id| config.tank_index(id))
                .filter(|&i| {
                    config
                        .stage_index(&config.tanks[i].stage)
                        .is_some_and(|s| attached[s])
                })
                .collect();
            let total: f64 = idx.iter().map(|&i| (tank[i] - draw[i]).max(0.0)).sum();
            if total <= 0.0 {
                return;
            }
            for &i in &idx {
                draw[i] += m * (tank[i] - draw[i]).max(0.0) / total;
            }
        };
        take(&feed.fuel_tanks, fuel);
        if mr > 0.0 {
            take(&feed.oxidizer_tanks, ox);
        }
    }

    /// RK4 over one tick for (q, H, h_wheels), with I varying linearly from mp0 to mp1.
    fn integrate_rotation(
        &mut self,
        mp0: &MassProperties,
        mp1: &MassProperties,
        tau_body: V3,
        wheel_torque: &[f64],
        dt: f64,
    ) {
        let axes: Vec<V3> = self
            .config
            .wheels
            .iter()
            .map(|w| {
                if self.stage_on(&w.stage) {
                    v3(w.axis).normalized().unwrap_or(V3::X)
                } else {
                    V3::ZERO
                }
            })
            .collect();
        let i_dot = scale_m3(&sub_m3(&mp1.inertia, &mp0.inertia), 1.0 / dt);
        let i0 = mp0.inertia;
        let deriv = |s: f64, q: Quat, h_i: V3, wh: &[f64]| -> (Quat, V3, Vec<f64>) {
            let inertia = add_m3(&i0, &scale_m3(&i_dot, s));
            let mut hw = V3::ZERO;
            for (a, &h) in axes.iter().zip(wh) {
                hw += *a * h;
            }
            let omega =
                inverse_m3(&inertia).map_or(V3::ZERO, |inv| inv.mul_v3(q.conj().rotate(h_i) - hw));
            let qd = q * Quat::new(0.0, omega.x, omega.y, omega.z);
            let qd = Quat::new(0.5 * qd.w, 0.5 * qd.x, 0.5 * qd.y, 0.5 * qd.z);
            let hd = q.rotate(tau_body + i_dot.mul_v3(omega));
            (qd, hd, wheel_torque.to_vec())
        };
        let h = dt / ROTATION_SUBSTEPS as f64;
        let mut q = self.q;
        let mut h_i = self.h_inertial;
        let mut wh = self.wheel_h.clone();
        let qadd = |a: Quat, b: Quat, k: f64| {
            Quat::new(a.w + b.w * k, a.x + b.x * k, a.y + b.y * k, a.z + b.z * k)
        };
        let vadd = |a: &[f64], b: &[f64], k: f64| -> Vec<f64> {
            a.iter().zip(b).map(|(x, y)| x + y * k).collect()
        };
        for n in 0..ROTATION_SUBSTEPS {
            let s = n as f64 * h;
            let (q1, h1, w1) = deriv(s, q, h_i, &wh);
            let (q2, h2, w2) = deriv(
                s + 0.5 * h,
                qadd(q, q1, 0.5 * h),
                h_i + h1 * (0.5 * h),
                &vadd(&wh, &w1, 0.5 * h),
            );
            let (q3, h3, w3) = deriv(
                s + 0.5 * h,
                qadd(q, q2, 0.5 * h),
                h_i + h2 * (0.5 * h),
                &vadd(&wh, &w2, 0.5 * h),
            );
            let (q4, h4, w4) = deriv(s + h, qadd(q, q3, h), h_i + h3 * h, &vadd(&wh, &w3, h));
            let k = h / 6.0;
            q = Quat::new(
                q.w + k * (q1.w + 2.0 * q2.w + 2.0 * q3.w + q4.w),
                q.x + k * (q1.x + 2.0 * q2.x + 2.0 * q3.x + q4.x),
                q.y + k * (q1.y + 2.0 * q2.y + 2.0 * q3.y + q4.y),
                q.z + k * (q1.z + 2.0 * q2.z + 2.0 * q3.z + q4.z),
            )
            .normalized()
            .unwrap_or(q);
            h_i += (h1 + h2 * 2.0 + h3 * 2.0 + h4) * k;
            for i in 0..wh.len() {
                wh[i] += k * (w1[i] + 2.0 * w2[i] + 2.0 * w3[i] + w4[i]);
            }
        }
        self.q = q;
        self.h_inertial = h_i;
        self.wheel_h = wh;
    }

    /// Jettison the lowest attached stage (if another remains), conserving momentum.
    fn separate(
        &mut self,
        prop: &Propagator,
        s: &ScState,
    ) -> Result<Option<Debris>, PropagationError> {
        let i = self.lowest_stage();
        if self.attached.iter().filter(|&&a| a).count() < 2 {
            return Ok(None);
        }
        let mp_all = self.mass_props();
        let omega = self.omega_from(&mp_all, self.q, self.h_inertial, &self.wheel_h);
        let mut after = self.attached.clone();
        after[i] = false;
        let mut only = vec![false; self.attached.len()];
        only[i] = true;
        let mp_rem = mass_properties(&self.config, &after, &self.tank);
        let mp_jet = mass_properties(&self.config, &only, &self.tank);
        let w_i = self.q.rotate(omega);
        let x_i = self.q.rotate(V3::X);
        let off_rem = self.q.rotate(mp_rem.com - mp_all.com);
        let off_jet = self.q.rotate(mp_jet.com - mp_all.com);
        let dv = self.config.stages[i].separation_dv;
        let m = mp_all.mass;
        // Rigid-body velocity of each part's CoM plus the separation impulse along +X.
        let v_rem = s.state.v + w_i.cross(off_rem) + x_i * (dv * mp_jet.mass / m);
        let v_jet = s.state.v + w_i.cross(off_jet) - x_i * (dv * mp_rem.mass / m);
        let center = s.state.frame.center;
        let aero = &self.config.stages[i].aero;
        let jet = Debris {
            stage: i,
            state: ScState {
                epoch: s.epoch,
                state: State::new(s.state.r + off_jet, v_jet, IcrfBody { center }),
                mass: mp_jet.mass,
            },
            attitude: self.q,
            omega_body: omega,
            ballistic: Ballistic {
                cd: aero.cd,
                drag_area: aero.drag_area,
                cr: aero.cr,
                srp_area: aero.srp_area,
            },
        };
        self.attached = after;
        for (w, h) in self.config.wheels.iter().zip(self.wheel_h.iter_mut()) {
            let on = self
                .config
                .stage_index(&w.stage)
                .is_some_and(|k| self.attached[k]);
            if !on {
                *h = 0.0;
            }
        }
        self.h_inertial = self
            .q
            .rotate(mp_rem.inertia.mul_v3(omega) + self.wheel_vector(&self.wheel_h));
        let rem = ScState {
            epoch: s.epoch,
            state: State::new(s.state.r + off_rem, v_rem, IcrfBody { center }),
            mass: mp_rem.mass,
        };
        let p = self.propagator(prop, true);
        self.traj = p.propagate(&rem, s.epoch, &[])?;
        self.last_thrust = Some(s.epoch);
        Ok(Some(jet))
    }

    /// Main-engine Δv and full-throttle burn time left (first attached engine).
    pub fn delta_v_remaining(&self) -> (f64, f64) {
        let Some((cfg, _)) = self
            .config
            .engines
            .iter()
            .zip(&self.engines)
            .find(|(e, _)| self.stage_on(&e.stage))
        else {
            return (0.0, 0.0);
        };
        let sum = |ids: &[String]| -> f64 {
            ids.iter()
                .filter_map(|id| self.config.tank_index(id))
                .map(|i| self.tank[i])
                .sum()
        };
        let mr = cfg.feed.mixture_ratio;
        let fuel = sum(&cfg.feed.fuel_tanks);
        let usable = if mr > 0.0 {
            (fuel * (1.0 + mr)).min(sum(&cfg.feed.oxidizer_tanks) * (1.0 + mr) / mr)
        } else {
            fuel
        };
        let m = self.mass_props().mass;
        if usable <= 0.0 || usable >= m {
            return (0.0, 0.0);
        }
        let ve = cfg.isp_vac * G0;
        (
            ve * fmath::ln(m / (m - usable)),
            usable * ve / cfg.thrust_vac,
        )
    }

    pub fn telemetry(&self) -> Telemetry {
        let mp = self.mass_props();
        let (delta_v, burn_time) = self.delta_v_remaining();
        Telemetry {
            mass: mp.mass,
            com: mp.com,
            omega_body: self.omega_from(&mp, self.q, self.h_inertial, &self.wheel_h),
            tank_mass: self.tank.clone(),
            wheel_fraction: self
                .config
                .wheels
                .iter()
                .zip(&self.wheel_h)
                .map(|(w, h)| {
                    if self.stage_on(&w.stage) {
                        h / w.max_momentum
                    } else {
                        0.0
                    }
                })
                .collect(),
            engines: self.engines.clone(),
            rcs_duty: self.rcs_duty.clone(),
            dynamic_pressure: self.last_q_dyn,
            heat_flux: self.last_heat,
            ambient_pressure: self.last_p_amb,
            delta_v,
            burn_time,
            desaturating: self.desat,
            sas_captured: self.sas_target.is_some(),
        }
    }

    /// Set the attitude directly (scenario setup), with zero body rate.
    pub fn set_attitude(&mut self, q: Quat) {
        self.q = q.normalized().unwrap_or(Quat::IDENTITY);
        self.q_prev = self.q;
        self.h_inertial = self.q.rotate(self.wheel_vector(&self.wheel_h));
        self.sas_target = None;
    }

    /// Set the body rate directly (tests and scenarios).
    pub fn set_body_rate(&mut self, omega: V3) {
        let mp = self.mass_props();
        self.h_inertial = self
            .q
            .rotate(mp.inertia.mul_v3(omega) + self.wheel_vector(&self.wheel_h));
    }

    /// Total angular momentum about the CoM (ICRF), N·m·s.
    pub fn angular_momentum(&self) -> V3 {
        self.h_inertial
    }

    pub fn wheel_momentum(&self) -> &[f64] {
        &self.wheel_h
    }

    /// Set wheel momenta directly (tests and scenarios), keeping the body rate.
    pub fn set_wheel_momentum(&mut self, h: &[f64]) {
        let omega = self.omega_body();
        for (w, &v) in self.wheel_h.iter_mut().zip(h) {
            *w = v;
        }
        self.set_body_rate(omega);
    }

    pub fn set_tank_mass(&mut self, i: usize, m: f64) {
        if let Some(t) = self.tank.get_mut(i) {
            *t = m.clamp(0.0, self.config.tanks[i].capacity);
        }
    }
}

/// Thrust (N) and mass flow (kg/s) of `engine` at `throttle` and ambient pressure
/// `p_amb` (Pa). Mass flow is set by the chamber, so it doesn't depend on p_amb;
/// thrust loses p_amb·A_e (Sutton & Biblarz, 9th ed., eq. 3-21), and so does Isp.
/// Thrust is floored at zero; the engine logic shuts the engine down before that.
pub fn engine_thrust(engine: &crate::vehicle::Engine, throttle: f64, p_amb: f64) -> (f64, f64) {
    let f_vac = engine.thrust_vac * throttle;
    (
        (f_vac - p_amb * engine.exit_area).max(0.0),
        f_vac / (engine.isp_vac * G0),
    )
}

fn body_orientation(body: BodyId, t: Epoch) -> Option<BodyOrientation> {
    if body == BodyId::EARTH {
        Some(earth::earth_orientation(t).0)
    } else {
        orientation::iau_body_orientation(body, t)
    }
}

/// Ceiling (exact in IEEE arithmetic; spelled out to keep the tick arithmetic explicit).
fn fmath_ceil(x: f64) -> f64 {
    let t = x.trunc();
    if x > t { t + 1.0 } else { t }
}

fn clamp_unit_box(v: V3) -> V3 {
    V3::new(
        v.x.clamp(-1.0, 1.0),
        v.y.clamp(-1.0, 1.0),
        v.z.clamp(-1.0, 1.0),
    )
}

/// Normalized linear interpolation of unit quaternions (shortest path).
pub fn nlerp(a: Quat, b: Quat, s: f64) -> Quat {
    let d = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
    let b = if d < 0.0 {
        Quat::new(-b.w, -b.x, -b.y, -b.z)
    } else {
        b
    };
    Quat::new(
        a.w + (b.w - a.w) * s,
        a.x + (b.x - a.x) * s,
        a.y + (b.y - a.y) * s,
        a.z + (b.z - a.z) * s,
    )
    .normalized()
    .unwrap_or(a)
}

/// The attitude nearest `q` whose body +X points along `d` (ICRF): `q` rotated by
/// the smallest rotation taking its +X axis onto `d` (roll is kept).
pub fn align_x(q: Quat, d: V3) -> Quat {
    let x = q.rotate(V3::X);
    let axis = x.cross(d);
    let s = axis.norm();
    let c = x.dot(d);
    let r = if s > 1e-12 {
        Quat::from_axis_angle(axis, fmath::atan2(s, c))
    } else if c < 0.0 {
        Quat::from_axis_angle(q.rotate(V3::Y), core::f64::consts::PI)
    } else {
        None
    };
    match r {
        Some(r) => (r * q).normalized().unwrap_or(q),
        None => q,
    }
}

/// Clamp unit vector `d` into the cone of half-angle `max` around unit `axis`.
fn clamp_cone(d: V3, axis: V3, max: f64) -> V3 {
    let ang = fmath::acos(d.dot(axis).clamp(-1.0, 1.0));
    if ang <= max {
        return d;
    }
    let perp = (d - axis * d.dot(axis)).normalized().unwrap_or(V3::ZERO);
    let (s, c) = fmath::sin_cos(max);
    axis * c + perp * s
}

/// Rotate unit vector `from` toward `to` by at most `max` radians.
fn slew_toward(from: V3, to: V3, max: f64) -> V3 {
    let ang = fmath::acos(from.dot(to).clamp(-1.0, 1.0));
    if ang <= max || ang == 0.0 {
        return to;
    }
    let perp = (to - from * from.dot(to)).normalized().unwrap_or(to);
    let (s, c) = fmath::sin_cos(max);
    (from * c + perp * s).normalized().unwrap_or(to)
}
