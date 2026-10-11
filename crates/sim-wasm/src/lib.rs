//! Browser bindings. Each export is a thin wrapper over `sim-core`; no physics here.

use sim_core::bodies::BodyRegistry;
use sim_core::time::{self, Epoch, UtcDateTime};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    sim_core::VERSION.to_string()
}

/// Determinism canary as 16 hex digits. Must equal `simctl canary`.
#[wasm_bindgen]
pub fn canary() -> String {
    format!("{:016x}", sim_core::determinism::canary())
}

/// UTC ISO string → TDB seconds past J2000 (f64; display precision).
#[wasm_bindgen(js_name = utcToTdbSeconds)]
pub fn utc_to_tdb_seconds(utc: &str) -> Result<f64, JsError> {
    let u = UtcDateTime::parse_iso(utc)?;
    Ok(time::utc_to_tdb(&u)?.tdb_seconds())
}

/// TDB seconds past J2000 → UTC ISO string with millisecond precision.
#[wasm_bindgen(js_name = tdbToUtcIso)]
pub fn tdb_to_utc_iso(tdb_seconds: f64) -> Result<String, JsError> {
    if !tdb_seconds.is_finite() {
        return Err(JsError::new("TDB seconds must be finite"));
    }
    Ok(time::tdb_to_utc(Epoch::from_tdb_seconds(tdb_seconds))?.to_iso(3))
}

/// True if the UTC string is past the bundled leap-second table's expiry.
#[wasm_bindgen(js_name = isProvisionalUtc)]
pub fn is_provisional_utc(utc: &str) -> Result<bool, JsError> {
    Ok(UtcDateTime::parse_iso(utc)?.is_provisional())
}

/// Built-in bodies as JSON: [{id, name, kind, parent, gm, radii: [a, b, c]}].
#[wasm_bindgen(js_name = bodiesJson)]
pub fn bodies_json() -> String {
    let rows: Vec<String> = BodyRegistry::builtin()
        .iter()
        .map(|b| {
            format!(
                r#"{{"id":{},"name":"{}","kind":"{:?}","parent":{},"gm":{:e},"radii":[{},{},{}]}}"#,
                b.id.0,
                b.name,
                b.kind,
                b.parent.map_or("null".to_string(), |p| p.0.to_string()),
                b.gm,
                b.radii.a,
                b.radii.b,
                b.radii.c
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}

// ---------------------------------------------------------------------------
// Simulation handle for the browser: owns the ephemeris, clock and trajectory.
// ---------------------------------------------------------------------------

use sim_core::bodies::BodyId;
use sim_core::earth;
use sim_core::ephemeris::Ephemeris;
use sim_core::flight::{self, Controls, Debris, Flight, FlightStatus, SasMode, SpeedReference};
use sim_core::frames::{IcrfBody, State};
use sim_core::kepler::Elements;
use sim_core::math::Quat;
use sim_core::math::V3;
use sim_core::orientation;
use sim_core::propagator::{
    Ballistic, ForceConfig, IntegratorConfig, Propagator, ScState, Trajectory, occultation,
};
use sim_core::vehicle::VehicleConfig;

/// Rebuild the coast prediction at most this often (s of sim time) while thrusting.
const PREDICTION_REFRESH: f64 = 0.5;
/// Jettisoned stages are dropped from the scene after this long, s.
const DEBRIS_LIFETIME: f64 = 3_600.0;

/// One simulation: ephemeris, clock (TDB), one spacecraft trajectory.
#[wasm_bindgen]
pub struct Sim {
    eph: Ephemeris,
    reg: BodyRegistry,
    forces: ForceConfig,
    integrator: IntegratorConfig,
    ballistic: Ballistic,
    traj: Option<Trajectory>,
    epoch: Epoch,
    /// Seconds of trajectory kept ahead of the clock (for the predicted path).
    lookahead: f64,
    error: Option<String>,
    vehicle: Option<VehicleConfig>,
    flight: Option<Flight>,
    controls: Controls,
    /// On-rails coasting allowed (the UI sets this from the warp level).
    rails_allowed: bool,
    /// Coast prediction from the flight's state at `pred_start`.
    pred: Option<Trajectory>,
    pred_start: Epoch,
    debris: Vec<(Debris, Trajectory)>,
}

fn js_err(e: impl core::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
impl Sim {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Sim {
        Sim {
            eph: Ephemeris::new(),
            reg: BodyRegistry::builtin(),
            forces: ForceConfig::default(),
            integrator: IntegratorConfig::default(),
            ballistic: Ballistic::default(),
            traj: None,
            epoch: Epoch::J2000,
            lookahead: 6_000.0,
            error: None,
            vehicle: None,
            flight: None,
            controls: Controls::default(),
            rails_allowed: false,
            pred: None,
            pred_start: Epoch::J2000,
            debris: Vec::new(),
        }
    }

    /// Merge a `.rseph` file.
    #[wasm_bindgen(js_name = loadEphemeris)]
    pub fn load_ephemeris(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.eph.load(bytes).map_err(js_err)
    }

    #[wasm_bindgen(js_name = setEpochUtc)]
    pub fn set_epoch_utc(&mut self, iso: &str) -> Result<(), JsError> {
        self.epoch = time::utc_to_tdb(&UtcDateTime::parse_iso(iso)?)?;
        Ok(())
    }

    #[wasm_bindgen(js_name = epochTdb)]
    pub fn epoch_tdb(&self) -> f64 {
        self.epoch.tdb_seconds()
    }

    #[wasm_bindgen(js_name = utcIso)]
    pub fn utc_iso(&self) -> String {
        time::tdb_to_utc(self.epoch)
            .map(|u| u.to_iso(3))
            .unwrap_or_else(|_| "—".into())
    }

    #[wasm_bindgen(js_name = isProvisional)]
    pub fn is_provisional(&self) -> bool {
        time::tdb_to_utc(self.epoch).is_ok_and(|u| u.is_provisional())
    }

    /// Force-model switches (spec: each perturbation switchable).
    #[wasm_bindgen(js_name = setForces)]
    pub fn set_forces(
        &mut self,
        third_body: bool,
        harmonics: bool,
        earth_degree: u32,
        drag: bool,
        srp: bool,
    ) {
        self.forces.third_body = third_body;
        self.forces.harmonics = harmonics;
        self.forces.earth_degree = earth_degree.min(70) as usize;
        self.forces.drag = drag;
        self.forces.srp = srp;
        self.restart_from_now();
    }

    #[wasm_bindgen(js_name = setSpaceWeather)]
    pub fn set_space_weather(&mut self, f107: f64, f107a: f64, ap: f64) {
        self.forces.space_weather = sim_core::atmosphere::SpaceWeather { f107, f107a, ap };
        self.restart_from_now();
    }

    #[wasm_bindgen(js_name = setTolerance)]
    pub fn set_tolerance(&mut self, rtol: f64) {
        self.integrator.rtol = rtol;
        self.integrator.atol = rtol * 1e5;
        self.restart_from_now();
    }

    #[wasm_bindgen(js_name = setLookahead)]
    pub fn set_lookahead(&mut self, seconds: f64) {
        self.lookahead = seconds.max(0.0);
    }

    /// Circular orbit around `center` (NAIF id) at altitude above the mean equatorial
    /// radius, inclination and node in ICRF, starting at the current epoch.
    #[wasm_bindgen(js_name = spawnCircular)]
    pub fn spawn_circular(
        &mut self,
        center: i32,
        alt_m: f64,
        inc_deg: f64,
        raan_deg: f64,
        mass: f64,
    ) -> Result<(), JsError> {
        let c = BodyId(center);
        let body = self
            .reg
            .get(c)
            .ok_or_else(|| JsError::new("unknown center body"))?;
        let r = body.radii.equatorial_mean() + alt_m;
        let el = Elements {
            p: r,
            a: r,
            e: 0.0,
            i: inc_deg.to_radians(),
            raan: raan_deg.to_radians(),
            argp: 0.0,
            nu: 0.0,
        };
        let (rv, vv) = el.to_state(body.gm);
        let s = ScState {
            epoch: self.epoch,
            state: State::new(rv, vv, IcrfBody { center: c }),
            mass,
        };
        self.error = None;
        let traj = self
            .propagator()
            .propagate(&s, self.epoch.add_seconds(self.lookahead), &[])
            .map_err(js_err)?;
        self.traj = Some(traj);
        Ok(())
    }

    /// Advance the clock by `dt` seconds of simulation time and keep the trajectory
    /// `lookahead` seconds ahead. The step sequence never depends on `dt` (warp
    /// invariance), and the clock stops at a terminal event (impact).
    pub fn advance(&mut self, dt: f64) -> Result<(), JsError> {
        if !(dt.is_finite() && dt >= 0.0) {
            return Err(JsError::new("dt must be finite and non-negative"));
        }
        let target = self.epoch.add_seconds(dt);
        if self.flight.is_some() {
            self.advance_flight(target);
            return Ok(());
        }
        if let Some(mut traj) = self.traj.take() {
            let res = {
                let p = self.propagator();
                p.extend(&mut traj, target.add_seconds(self.lookahead), &[])
            };
            if let Err(e) = &res {
                self.error = Some(e.to_string());
            }
            let end = traj.end_epoch();
            self.epoch = if traj.terminated().is_some() && end.seconds_since(target) < 0.0 {
                end
            } else {
                target
            };
            traj.prune_before(self.epoch.add_seconds(-60.0));
            self.traj = Some(traj);
        } else {
            self.epoch = target;
        }
        Ok(())
    }

    /// Spacecraft at the current epoch: [center, x, y, z, vx, vy, vz, mass] (ICRF, m,
    /// m/s, kg), or an empty array if there is none.
    pub fn spacecraft(&self) -> Vec<f64> {
        let Some(s) = self.current_state() else {
            return Vec::new();
        };
        let (r, v) = (s.state.r, s.state.v);
        vec![
            f64::from(s.state.frame.center.0),
            r.x,
            r.y,
            r.z,
            v.x,
            v.y,
            v.z,
            s.mass,
        ]
    }

    /// Sampled future positions relative to the spacecraft's current center:
    /// [x0, y0, z0, x1, …] for `n` points over `span` seconds (clipped to the trajectory).
    #[wasm_bindgen(js_name = predictedPath)]
    pub fn predicted_path(&self, n: u32, span: f64) -> Vec<f64> {
        let traj = if self.flight.is_some() {
            self.pred.as_ref()
        } else {
            self.traj.as_ref()
        };
        let Some(traj) = traj else {
            return Vec::new();
        };
        let Some(now) = traj.state_at(self.epoch) else {
            return Vec::new();
        };
        let center = now.state.frame.center;
        let span = span.min(traj.end_epoch().seconds_since(self.epoch));
        let mut out = Vec::with_capacity(n as usize * 3);
        for k in 0..n {
            let t = self
                .epoch
                .add_seconds(span * f64::from(k) / f64::from(n.max(2) - 1));
            let Some(s) = traj.state_at(t) else { break };
            let r = if s.state.frame.center == center {
                s.state.r
            } else {
                match self.eph.state_relative(s.state.frame.center, center, t) {
                    Ok(off) => s.state.r + off.r,
                    Err(_) => break,
                }
            };
            out.extend([r.x, r.y, r.z]);
        }
        out
    }

    /// Why the trajectory stopped (impact etc.) or the last propagation error; empty if fine.
    pub fn status(&self) -> String {
        if let Some(e) = &self.error {
            return e.clone();
        }
        if let Some(f) = &self.flight {
            return match f.status() {
                FlightStatus::Flying => String::new(),
                FlightStatus::Impact { speed, .. } => format!("Impact at {speed:.1} m/s"),
                FlightStatus::BrokeUp { dynamic_pressure } => format!(
                    "Vehicle broke up: dynamic pressure {:.1} kPa",
                    dynamic_pressure / 1e3
                ),
                FlightStatus::BurnedUp { heat_flux } => {
                    format!("Vehicle burned up: heat flux {:.0} kW/m²", heat_flux / 1e3)
                }
            };
        }
        self.traj
            .as_ref()
            .and_then(|t| t.terminated())
            .map_or_else(String::new, |e| format!("{e:?}"))
    }

    #[wasm_bindgen(js_name = stepCount)]
    pub fn step_count(&self) -> u32 {
        self.traj.as_ref().map_or(0, |t| t.step_count() as u32)
    }

    /// Position and velocity of `target` relative to `center` at the current epoch:
    /// [x, y, z, vx, vy, vz].
    #[wasm_bindgen(js_name = relativeState)]
    pub fn relative_state(&self, target: i32, center: i32) -> Result<Vec<f64>, JsError> {
        let s = self
            .eph
            .state_relative(BodyId(target), BodyId(center), self.epoch)
            .map_err(js_err)?;
        Ok(vec![s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z])
    }

    /// ICRF → body-fixed rotation (row-major 3×3) at the current epoch: Earth from the
    /// precise IERS model, other bodies from IAU WGCCRE. Empty if unknown.
    #[wasm_bindgen(js_name = bodyFrame)]
    pub fn body_frame(&self, body: i32) -> Vec<f64> {
        let o = if body == BodyId::EARTH.0 {
            Some(earth::earth_orientation(self.epoch).0)
        } else {
            orientation::iau_body_orientation(BodyId(body), self.epoch)
        };
        o.map_or_else(Vec::new, |o| {
            o.icrf_to_bf
                .rows
                .iter()
                .flat_map(|r| [r.x, r.y, r.z])
                .collect()
        })
    }

    /// Fraction of the solar disk visible from the spacecraft (eclipses by its center
    /// body and the Moon when near Earth).
    #[wasm_bindgen(js_name = sunVisibility)]
    pub fn sun_visibility(&self) -> f64 {
        let Some(s) = self.current_state() else {
            return 1.0;
        };
        let c = s.state.frame.center;
        if c == BodyId::SUN {
            return 1.0;
        }
        let Ok(sun) = self.eph.state_relative(BodyId::SUN, c, self.epoch) else {
            return 1.0;
        };
        let mut nu = self.reg.get(c).map_or(1.0, |b| {
            occultation(s.state.r, sun.r, V3::ZERO, b.radii.equatorial_mean())
        });
        for other in [BodyId::MOON, BodyId::EARTH] {
            if other == c {
                continue;
            }
            if let (Ok(p), Some(b)) = (
                self.eph.state_relative(other, c, self.epoch),
                self.reg.get(other),
            ) {
                nu = nu.min(occultation(
                    s.state.r,
                    sun.r,
                    p.r,
                    b.radii.equatorial_mean(),
                ));
            }
        }
        nu
    }

    /// Osculating orbit relative to the current center: [a, e, i, raan, argp, nu,
    /// periapsis altitude, apoapsis altitude (NaN if open), period (NaN if open),
    /// altitude, speed], SI units and radians.
    #[wasm_bindgen(js_name = orbitInfo)]
    pub fn orbit_info(&self) -> Vec<f64> {
        let Some(s) = self.current_state() else {
            return Vec::new();
        };
        let Some(body) = self.reg.get(s.state.frame.center) else {
            return Vec::new();
        };
        let el = Elements::from_state(s.state.r, s.state.v, body.gm);
        let r_ref = body.radii.equatorial_mean();
        vec![
            el.a,
            el.e,
            el.i,
            el.raan,
            el.argp,
            el.nu,
            el.periapsis() - r_ref,
            el.apoapsis().map_or(f64::NAN, |x| x - r_ref),
            el.period(body.gm).unwrap_or(f64::NAN),
            s.state.r.norm() - r_ref,
            s.state.v.norm(),
        ]
    }

    /// Altitude above the WGS84 ellipsoid when orbiting Earth (NaN otherwise), m.
    #[wasm_bindgen(js_name = geodeticAltitude)]
    pub fn geodetic_altitude(&self) -> f64 {
        let Some(s) = self.current_state() else {
            return f64::NAN;
        };
        if s.state.frame.center != BodyId::EARTH {
            return f64::NAN;
        }
        let o = earth::earth_orientation(self.epoch).0;
        earth::itrs_to_geodetic(o.icrf_to_bf.mul_v3(s.state.r)).2
    }

    /// The spacecraft's state now: the flight if there is one, else the M3 trajectory.
    fn current_state(&self) -> Option<ScState> {
        match &self.flight {
            Some(f) => f.state_at(self.epoch),
            None => self.traj.as_ref().and_then(|t| t.state_at(self.epoch)),
        }
    }

    fn advance_flight(&mut self, target: Epoch) {
        let Some(mut f) = self.flight.take() else {
            return;
        };
        let physics = !self.rails_allowed || f.needs_physics(&self.controls);
        let lookahead = if physics { 0.0 } else { 1.0 };
        let res = {
            let p = self.propagator();
            f.advance(&p, target, &self.controls, physics, lookahead)
        };
        match res {
            Ok(debris) => {
                for d in debris {
                    let p = self.propagator_with(d.ballistic);
                    match p.propagate(&d.state, d.state.epoch, &[]) {
                        Ok(t) => self.debris.push((d, t)),
                        Err(e) => self.error = Some(e.to_string()),
                    }
                }
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        self.epoch = if f.status() == FlightStatus::Flying {
            target
        } else {
            f.epoch()
        };
        f.prune_before(self.epoch.add_seconds(-60.0));
        self.flight = Some(f);
        self.update_prediction();
        self.update_debris();
    }

    /// Keep the coast prediction current: rebuilt after thrust (rate-limited), else
    /// extended `lookahead` ahead.
    fn update_prediction(&mut self) {
        let Some(f) = &self.flight else { return };
        let stale = match (&self.pred, f.last_thrust) {
            (None, _) => true,
            (Some(_), Some(t)) => {
                t.seconds_since(self.pred_start) > 0.0
                    && self.epoch.seconds_since(self.pred_start) >= PREDICTION_REFRESH
            }
            (Some(_), None) => false,
        };
        let horizon = self.epoch.add_seconds(self.lookahead);
        let res = if stale {
            let Some(s) = f.state_at(self.epoch) else {
                return;
            };
            self.pred_start = self.epoch;
            self.propagator().propagate(&s, horizon, &[]).map(Some)
        } else if let Some(mut t) = self.pred.take() {
            let r = self.propagator().extend(&mut t, horizon, &[]);
            t.prune_before(self.epoch.add_seconds(-60.0));
            r.map(|_| Some(t))
        } else {
            Ok(None)
        };
        match res {
            Ok(t) => self.pred = t,
            Err(e) => self.error = Some(e.to_string()),
        }
    }

    fn update_debris(&mut self) {
        let now = self.epoch;
        self.debris
            .retain(|(d, _)| now.seconds_since(d.state.epoch) < DEBRIS_LIFETIME);
        let mut debris = core::mem::take(&mut self.debris);
        for (d, t) in &mut debris {
            if t.terminated().is_none() && t.end_epoch().seconds_since(now) < 0.0 {
                let p = self.propagator_with(d.ballistic);
                if let Err(e) = p.extend(t, now, &[]) {
                    self.error = Some(e.to_string());
                }
            }
        }
        self.debris = debris;
    }

    fn propagator_with(&self, b: Ballistic) -> Propagator<'_> {
        let mut p = self.propagator();
        p.ballistic = b;
        p
    }

    fn propagator(&self) -> Propagator<'_> {
        let mut p = Propagator::new(&self.eph, &self.reg);
        p.forces = self.forces;
        p.integrator = self.integrator;
        p.ballistic = self.ballistic;
        p
    }

    /// Re-propagate from the current state after a model change (the old prediction
    /// was made with the old model).
    fn restart_from_now(&mut self) {
        let Some(s) = self.current_state() else {
            return;
        };
        match self
            .propagator()
            .propagate(&s, self.epoch.add_seconds(self.lookahead), &[])
        {
            Ok(t) => self.traj = Some(t),
            Err(e) => self.error = Some(e.to_string()),
        }
    }
}

#[wasm_bindgen]
impl Sim {
    /// Parse and validate a vehicle definition (JSON text). Used by `spawnVehicle`.
    #[wasm_bindgen(js_name = loadVehicle)]
    pub fn load_vehicle(&mut self, json: &str) -> Result<(), JsError> {
        self.vehicle = Some(VehicleConfig::from_json(json).map_err(js_err)?);
        Ok(())
    }

    /// Start a 6-DOF flight of the loaded vehicle in a circular orbit (as
    /// `spawnCircular`), attitude prograde with +Z to nadir.
    #[wasm_bindgen(js_name = spawnVehicle)]
    pub fn spawn_vehicle(
        &mut self,
        center: i32,
        alt_m: f64,
        inc_deg: f64,
        raan_deg: f64,
    ) -> Result<(), JsError> {
        let cfg = self
            .vehicle
            .clone()
            .ok_or_else(|| JsError::new("no vehicle loaded"))?;
        self.spawn_circular(center, alt_m, inc_deg, raan_deg, 1.0)?;
        let s = self
            .traj
            .as_ref()
            .and_then(|t| t.state_at(self.epoch))
            .ok_or_else(|| JsError::new("spawn failed"))?;
        let q = flight::orbit_attitude(s.state.r, s.state.v);
        let f = Flight::new(cfg, &s, q, &self.propagator()).map_err(js_err)?;
        self.flight = Some(f);
        self.traj = None;
        self.pred = None;
        self.debris.clear();
        self.controls = Controls {
            sas: SasMode::Hold,
            ..Controls::default()
        };
        self.update_prediction();
        Ok(())
    }

    /// Pilot inputs for the coming ticks. `sas`: 0 off, 1 hold, 2 prograde,
    /// 3 retrograde, 4 normal, 5 anti-normal, 6 radial out, 7 radial in, 8 target,
    /// 9 anti-target, 10 maneuver. `speed_ref`: 0 orbit, 1 surface, 2 target.
    #[wasm_bindgen(js_name = setControls)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_controls(
        &mut self,
        roll: f64,
        pitch: f64,
        yaw: f64,
        tx: f64,
        ty: f64,
        tz: f64,
        throttle: f64,
        sas: u32,
        rcs: bool,
        fine: bool,
        speed_ref: u32,
    ) {
        let finite = |x: f64| if x.is_finite() { x } else { 0.0 };
        self.controls = Controls {
            rotation: V3::new(finite(roll), finite(pitch), finite(yaw)),
            translation: V3::new(finite(tx), finite(ty), finite(tz)),
            throttle: finite(throttle).clamp(0.0, 1.0),
            sas: SasMode::from_index(sas),
            rcs,
            fine,
            speed_reference: match speed_ref {
                1 => SpeedReference::Surface,
                2 => SpeedReference::Target,
                _ => SpeedReference::Orbit,
            },
        };
    }

    /// Allow on-rails coasting when no actuator is in use (high warp).
    #[wasm_bindgen(js_name = setRailsAllowed)]
    pub fn set_rails_allowed(&mut self, allowed: bool) {
        self.rails_allowed = allowed;
    }

    /// True if the vehicle needs step-by-step simulation now (warp must stay low).
    #[wasm_bindgen(js_name = needsPhysics)]
    pub fn needs_physics(&self) -> bool {
        self.flight
            .as_ref()
            .is_some_and(|f| f.needs_physics(&self.controls))
    }

    /// Separate the lowest stage at the next tick.
    pub fn stage(&mut self) {
        if let Some(f) = &mut self.flight {
            f.stage();
        }
    }

    /// Target body (NAIF id), or a negative number for none.
    #[wasm_bindgen(js_name = setTarget)]
    pub fn set_target(&mut self, body: i32) {
        if let Some(f) = &mut self.flight {
            f.target = (body >= 0).then_some(BodyId(body));
        }
    }

    /// Attitude now (body → ICRF): [w, x, y, z]; empty without a flight.
    pub fn attitude(&self) -> Vec<f64> {
        self.flight.as_ref().map_or_else(Vec::new, |f| {
            let q = f.attitude_at(self.epoch);
            vec![q.w, q.x, q.y, q.z]
        })
    }

    /// Indices of the attached stages' flags: [1, 1] for a full stack.
    #[wasm_bindgen(js_name = attachedStages)]
    pub fn attached_stages(&self) -> Vec<u8> {
        self.flight.as_ref().map_or_else(Vec::new, |f| {
            f.attached().iter().map(|&a| u8::from(a)).collect()
        })
    }

    /// Flight telemetry as JSON (SI units), or "" without a flight.
    pub fn telemetry(&self) -> String {
        let Some(f) = &self.flight else {
            return String::new();
        };
        let t = f.telemetry();
        let v3j = |v: V3| format!("[{},{},{}]", v.x, v.y, v.z);
        let list = |xs: &[f64]| {
            format!(
                "[{}]",
                xs.iter()
                    .map(|x| format!("{x}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let engines: Vec<String> = t
            .engines
            .iter()
            .map(|e| {
                format!(
                    r#"{{"running":{},"throttle":{},"thrust":{},"ignitions":{},"flameout":{},"direction":{}}}"#,
                    e.running,
                    e.throttle,
                    e.thrust,
                    e.ignitions_left,
                    e.flameout,
                    v3j(e.direction)
                )
            })
            .collect();
        let rcs: Vec<String> = t.rcs_duty.iter().map(|d| list(d)).collect();
        // Speeds in each reference, for the HUD speed modes.
        let speeds = self.speeds();
        format!(
            r#"{{"mass":{},"com":{},"omega":{},"tanks":{},"wheels":{},"engines":[{}],"rcs":[{}],"q":{},"heat":{},"pAmb":{},"dv":{},"burnTime":{},"desat":{},"captured":{},"dvExpended":{},"speeds":{}}}"#,
            t.mass,
            v3j(t.com),
            v3j(t.omega_body),
            list(&t.tank_mass),
            list(&t.wheel_fraction),
            engines.join(","),
            rcs.join(","),
            t.dynamic_pressure,
            t.heat_flux,
            t.ambient_pressure,
            t.delta_v,
            t.burn_time,
            t.desaturating,
            t.sas_captured,
            f.dv_expended,
            list(&speeds),
        )
    }

    /// Navball reference directions (ICRF unit vectors, in the current speed
    /// reference): [prograde, normal, radial out, target (or zeros)], 12 numbers.
    #[wasm_bindgen(js_name = navVectors)]
    pub fn nav_vectors(&self) -> Vec<f64> {
        let Some(f) = &self.flight else {
            return Vec::new();
        };
        let Some(s) = f.state_at(self.epoch) else {
            return Vec::new();
        };
        let v = self.reference_velocity(&s);
        let pro = v.normalized().unwrap_or(V3::ZERO);
        let nrm = s.state.r.cross(v).normalized().unwrap_or(V3::ZERO);
        let rad = pro.cross(nrm).normalized().unwrap_or(V3::ZERO);
        let tgt = f
            .target
            .and_then(|b| {
                self.eph
                    .state_relative(b, s.state.frame.center, self.epoch)
                    .ok()
            })
            .and_then(|t| (t.r - s.state.r).normalized())
            .unwrap_or(V3::ZERO);
        [pro, nrm, rad, tgt]
            .iter()
            .flat_map(|u| [u.x, u.y, u.z])
            .collect()
    }

    /// Jettisoned stages now: [stage, x, y, z, qw, qx, qy, qz, cx, cy, cz] per object:
    /// CoM position relative to the spacecraft's current center, attitude, and the
    /// stage's CoM in the vehicle body frame.
    pub fn debris(&self) -> Vec<f64> {
        let Some(center) = self.current_state().map(|s| s.state.frame.center) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (d, t) in &self.debris {
            let at = if t.end_epoch().seconds_since(self.epoch) < 0.0 {
                t.end_epoch()
            } else {
                self.epoch
            };
            let Some(s) = t.state_at(at) else { continue };
            let r = if s.state.frame.center == center {
                s.state.r
            } else {
                match self.eph.state_relative(s.state.frame.center, center, at) {
                    Ok(off) => s.state.r + off.r,
                    Err(_) => continue,
                }
            };
            // Constant body rate since separation (display only).
            let dt = at.seconds_since(d.state.epoch);
            let w = d.omega_body;
            let q = Quat::from_axis_angle(w, w.norm() * dt).map_or(d.attitude, |r| d.attitude * r);
            let c = d.com_body;
            out.extend([
                d.stage as f64,
                r.x,
                r.y,
                r.z,
                q.w,
                q.x,
                q.y,
                q.z,
                c.x,
                c.y,
                c.z,
            ]);
        }
        out
    }
}

impl Sim {
    fn reference_velocity(&self, s: &ScState) -> V3 {
        self.reference_velocity_with(s, self.controls.speed_reference)
    }

    fn reference_velocity_with(&self, s: &ScState, r: SpeedReference) -> V3 {
        let c = s.state.frame.center;
        match r {
            SpeedReference::Orbit => s.state.v,
            SpeedReference::Surface => {
                let o = if c == BodyId::EARTH {
                    Some(earth::earth_orientation(self.epoch).0)
                } else {
                    orientation::iau_body_orientation(c, self.epoch)
                };
                match o {
                    Some(o) => {
                        let w = o.icrf_to_bf.transpose().mul_v3(o.omega_bf);
                        s.state.v - w.cross(s.state.r)
                    }
                    None => s.state.v,
                }
            }
            SpeedReference::Target => match self
                .flight
                .as_ref()
                .and_then(|f| f.target)
                .and_then(|b| self.eph.state_relative(b, c, self.epoch).ok())
            {
                Some(t) => s.state.v - t.v,
                None => s.state.v,
            },
        }
    }

    /// Speed in the orbit, surface and target references, m/s.
    fn speeds(&self) -> Vec<f64> {
        let Some(s) = self.current_state() else {
            return Vec::new();
        };
        [
            SpeedReference::Orbit,
            SpeedReference::Surface,
            SpeedReference::Target,
        ]
        .iter()
        .map(|&r| self.reference_velocity_with(&s, r).norm())
        .collect()
    }
}

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}
