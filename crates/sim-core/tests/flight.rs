//! M5 spacecraft validation: the RS-1 data file, engine against Tsiolkovsky, SAS
//! settling at full and empty mass, wheel saturation and desaturation, conservation of
//! angular momentum, staging momentum balance, engine operating limits, and
//! determinism under frame chunking.
//!
//! The ephemeris is the committed 2026-10-25 … 2027-02-05 subset (tests/fixtures).

use sim_core::bodies::{BodyId, BodyRegistry};
use sim_core::constants::{ASTRONOMICAL_UNIT, G0, gm};
use sim_core::ephemeris::Ephemeris;
use sim_core::flight::{Controls, Flight, SasMode, engine_thrust};
use sim_core::frames::{IcrfBody, State};
use sim_core::math::{Quat, V3, fmath};
use sim_core::propagator::{ForceConfig, Propagator, ScState};
use sim_core::time::{Epoch, UtcDateTime, utc_to_tdb};
use sim_core::vehicle::VehicleConfig;

const RS1: &str = include_str!("../../../data/vehicles/rs1_corvid.json");

fn eph() -> Ephemeris {
    let mut e = Ephemeris::new();
    e.load(include_bytes!("fixtures/ephem_2026q4.rseph"))
        .unwrap();
    e
}

fn t0() -> Epoch {
    utc_to_tdb(&UtcDateTime::new(2026, 11, 1, 0, 0, 0.0)).unwrap()
}

fn rs1() -> VehicleConfig {
    VehicleConfig::from_json(RS1).unwrap()
}

/// Earth point mass only, fixed center: the vehicle physics in isolation.
fn two_body<'a>(e: &'a Ephemeris, r: &'a BodyRegistry) -> Propagator<'a> {
    let mut p = Propagator::new(e, r);
    p.forces = ForceConfig {
        third_body: false,
        harmonics: false,
        drag: false,
        srp: false,
        ..ForceConfig::default()
    };
    p.center_switching = false;
    p
}

/// 400 km circular equatorial orbit.
fn leo() -> ScState {
    let r = 6_378_137.0 + 400e3;
    ScState {
        epoch: t0(),
        state: State::new(
            V3::new(r, 0.0, 0.0),
            V3::new(0.0, (gm::EARTH / r).sqrt(), 0.0),
            IcrfBody {
                center: BodyId::EARTH,
            },
        ),
        mass: 1.0,
    }
}

/// 1 au from the Sun: gravity-gradient torque is ~1e-13 of LEO's.
fn deep_space() -> ScState {
    let r = ASTRONOMICAL_UNIT;
    ScState {
        epoch: t0(),
        state: State::new(
            V3::new(r, 0.0, 0.0),
            V3::new(0.0, (gm::SUN / r).sqrt(), 0.0),
            IcrfBody {
                center: BodyId::SUN,
            },
        ),
        mass: 1.0,
    }
}

fn run(f: &mut Flight, p: &Propagator, seconds: f64, c: &Controls) {
    let until = f.epoch().add_seconds(seconds);
    f.advance(p, until, c, true, 0.0).unwrap();
}

fn empty_main_tanks(f: &mut Flight) {
    for id in ["mmh_1", "mmh_2", "nto_1", "nto_2"] {
        let i = f.config.tank_index(id).unwrap();
        f.set_tank_mass(i, 0.0);
    }
}

#[test]
fn rs1_has_the_designed_mass_and_delta_v() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let f = Flight::new(rs1(), &leo(), Quat::IDENTITY, &p).unwrap();
    let mp = f.mass_props();
    let (dv, burn) = f.delta_v_remaining();
    eprintln!(
        "RS-1: mass {:.1} kg, CoM x {:.3} m, I = diag({:.0}, {:.0}, {:.0}) kg·m², Δv {:.1} m/s, burn {:.0} s",
        mp.mass,
        mp.com.x,
        mp.inertia.rows[0].x,
        mp.inertia.rows[1].y,
        mp.inertia.rows[2].z,
        dv,
        burn
    );
    assert!((mp.mass - 24_960.0).abs() < 1.0);
    // Decision D5: enough for TLI from LEO (~3.1–3.2 km/s) with margin.
    assert!((3_400.0..3_500.0).contains(&dv), "Δv {dv}");
    // Symmetric layout: CoM on the axis, no products of inertia.
    assert!(mp.com.y.abs() < 1e-9 && mp.com.z.abs() < 1e-9);
    assert!(mp.inertia.rows[0].y.abs() < 1e-6 && mp.inertia.rows[1].z.abs() < 1e-6);
}

#[test]
fn main_engine_burn_matches_tsiolkovsky_and_mass_bookkeeping() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    // Deep space: in LEO the two orbits separate by ~20 km and feel different gravity.
    let mut f = Flight::new(rs1(), &deep_space(), Quat::IDENTITY, &p).unwrap();
    let mut coast = f.clone();
    let m0 = f.mass_props().mass;
    // SAS off and no stick: only the gimbal trim acts, no RCS.
    let c = Controls {
        throttle: 1.0,
        sas: SasMode::Off,
        rcs: false,
        ..Controls::default()
    };
    run(&mut f, &p, 120.0, &c);
    run(&mut coast, &p, 120.0, &Controls::default());
    let m1 = f.mass_props().mass;
    let cfg = &f.config.engines[0];
    let mdot = cfg.thrust_vac / (cfg.isp_vac * G0);
    assert!(
        (m0 - m1 - mdot * 120.0).abs() < 1e-6,
        "propellant {}",
        m0 - m1
    );
    let ideal = cfg.isp_vac * G0 * fmath::ln(m0 / m1);
    assert!(
        (f.dv_expended - ideal).abs() < 1e-6 * ideal,
        "{} vs {ideal}",
        f.dv_expended
    );
    // The trajectory sees the same Δv (relative to a coasting twin, fixed attitude).
    let t = f.epoch();
    let dv = (f.state_at(t).unwrap().state.v - coast.state_at(t).unwrap().state.v).norm();
    eprintln!("burn: Δv {dv:.6} m/s, Tsiolkovsky {ideal:.6} m/s");
    assert!((dv - ideal).abs() < 1e-3 * ideal);
    // The propagator's mass and the tanks agree.
    let traj_mass = f.state_at(t).unwrap().mass;
    assert!((traj_mass - m1).abs() < 1e-6, "{traj_mass} vs {m1}");
}

#[test]
fn engine_thrust_loses_back_pressure_times_exit_area() {
    let cfg = rs1();
    let e = &cfg.engines[0];
    let (f0, m0) = engine_thrust(e, 1.0, 0.0);
    let (f1, m1) = engine_thrust(e, 1.0, 10_000.0);
    assert_eq!(f0, e.thrust_vac);
    assert!((f0 - f1 - 10_000.0 * e.exit_area).abs() < 1e-9);
    assert_eq!(m0, m1);
    // At sea level this vacuum nozzle cannot produce thrust.
    assert_eq!(engine_thrust(e, 1.0, 101_325.0).0, 0.0);
}

#[test]
fn engine_honours_minimum_on_time_and_ignition_count() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mut cfg = rs1();
    cfg.engines[0].ignitions = 1;
    let mut f = Flight::new(cfg, &leo(), Quat::IDENTITY, &p).unwrap();
    let on = Controls {
        throttle: 1.0,
        rcs: false,
        ..Controls::default()
    };
    let off = Controls {
        rcs: false,
        ..Controls::default()
    };
    run(&mut f, &p, 0.02, &on); // one tick
    assert!(f.telemetry().engines[0].running);
    run(&mut f, &p, 0.2, &off);
    assert!(
        f.telemetry().engines[0].running,
        "shut down before min on-time"
    );
    run(&mut f, &p, 0.4, &off);
    assert!(!f.telemetry().engines[0].running);
    run(&mut f, &p, 1.0, &on);
    assert!(
        !f.telemetry().engines[0].running,
        "relit with no ignitions left"
    );
    assert_eq!(f.telemetry().engines[0].ignitions_left, 0);
}

/// Signed error angle (deg) between body +X and `target`, positive on the side the
/// slew started from.
fn signed_error(f: &Flight, target: V3, axis0: V3) -> f64 {
    let x = f.attitude_at(f.epoch()).rotate(V3::X);
    let s = x.cross(target);
    let ang = fmath::atan2(s.norm(), x.dot(target)).to_degrees();
    if s.dot(axis0) >= 0.0 { ang } else { -ang }
}

fn slew_test(empty: bool) {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mut f = Flight::new(rs1(), &deep_space(), Quat::IDENTITY, &p).unwrap();
    if empty {
        empty_main_tanks(&mut f);
    }
    // 30° about an off-axis direction (pitch and yaw, so the inertia isn't diagonal
    // in the slew plane).
    let axis0 = V3::new(0.0, 0.6, 0.8);
    let target = Quat::from_axis_angle(axis0, 30f64.to_radians())
        .unwrap()
        .rotate(V3::X);
    f.maneuver = Some(target);
    let c = Controls {
        sas: SasMode::Maneuver,
        ..Controls::default()
    };
    let mut min_err = f64::INFINITY;
    let mut settled_at = None;
    for k in 0..6000 {
        run(&mut f, &p, 0.1, &c);
        let err = signed_error(&f, target, axis0);
        min_err = min_err.min(err);
        if settled_at.is_none() && err.abs() < 0.05 && f.omega_body().norm().to_degrees() < 0.01 {
            settled_at = Some(f64::from(k) * 0.1);
        }
    }
    let final_err = signed_error(&f, target, axis0);
    let overshoot = (-min_err).max(0.0) / 30.0;
    let used: f64 = ["rcs_mmh", "rcs_nto"]
        .iter()
        .map(|id| {
            let i = f.config.tank_index(id).unwrap();
            f.config.tanks[i].capacity - f.telemetry().tank_mass[i]
        })
        .sum();
    eprintln!(
        "slew 30° ({}): settled at {:?} s, overshoot {:.3}%, final error {final_err:.4}°, RCS used {used:.2} kg",
        if empty { "empty" } else { "full" },
        settled_at,
        overshoot * 100.0
    );
    assert!(overshoot < 0.01, "overshoot {:.3}%", overshoot * 100.0);
    assert!(settled_at.is_some_and(|t| t < 300.0), "did not settle");
    assert!(final_err.abs() < 0.05);
}

#[test]
fn sas_settles_a_30_degree_slew_without_overshoot_at_full_mass() {
    slew_test(false);
}

#[test]
fn sas_settles_a_30_degree_slew_without_overshoot_at_empty_mass() {
    slew_test(true);
}

#[test]
fn torque_free_tumble_conserves_angular_momentum_and_energy() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mut f = Flight::new(rs1(), &deep_space(), Quat::IDENTITY, &p).unwrap();
    f.set_body_rate(V3::new(0.3, 1.0, -0.5) * 1f64.to_radians());
    let h0 = f.angular_momentum();
    let energy = |f: &Flight| {
        let w = f.omega_body();
        0.5 * w.dot(f.mass_props().inertia.mul_v3(w))
    };
    let e0 = energy(&f);
    let c = Controls {
        rcs: false,
        ..Controls::default()
    };
    run(&mut f, &p, 300.0, &c);
    let dh = (f.angular_momentum() - h0).norm() / h0.norm();
    let de = (energy(&f) - e0).abs() / e0;
    eprintln!("torque-free 300 s: |ΔH|/H = {dh:.2e}, ΔE/E = {de:.2e}");
    // Gravity gradient at 1 au (~1e-9 N·m) is the only torque left: ~1e-9 of H over 300 s.
    assert!(dh < 1e-9, "{dh}");
    assert!(de < 1e-9, "{de}");
}

#[test]
fn wheels_trade_momentum_with_the_body_and_saturate() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mut f = Flight::new(rs1(), &deep_space(), Quat::IDENTITY, &p).unwrap();
    // 0.2°/s pitch: |H| ≈ I_yy · ω exceeds the 100 N·m·s wheel.
    f.set_body_rate(V3::new(0.0, 0.2f64.to_radians(), 0.0));
    let h0 = f.angular_momentum();
    let c = Controls {
        sas: SasMode::Hold,
        rcs: false,
        ..Controls::default()
    };
    let mut max_h: f64 = 0.0;
    for _ in 0..200 {
        run(&mut f, &p, 5.0, &c);
        max_h = max_h.max(f.wheel_momentum()[1].abs());
    }
    let wheel = &f.config.wheels[1];
    // Internal torques only: H unchanged.
    assert!((f.angular_momentum() - h0).norm() < 1e-9 * h0.norm());
    assert!(max_h <= wheel.max_momentum + 1e-9);
    assert!(
        (f.wheel_momentum()[1].abs() - wheel.max_momentum).abs() < 1e-6,
        "not saturated"
    );
    // The body still turns, slower: the rest of H is in the body.
    let w = f.omega_body().y;
    assert!(w.abs() > 0.0 && w.abs() < 0.2f64.to_radians());
}

#[test]
fn rcs_desaturates_wheels_while_holding_attitude() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mut f = Flight::new(rs1(), &deep_space(), Quat::IDENTITY, &p).unwrap();
    f.set_wheel_momentum(&[95.0, -95.0, 60.0]);
    let c = Controls {
        sas: SasMode::Hold,
        ..Controls::default()
    };
    let x0 = f.attitude_at(f.epoch()).rotate(V3::X);
    let mut worst: f64 = 0.0;
    let mut desat_seen = false;
    // Spin-down at half the 0.2 N·m wheel torque: 95 N·m·s takes ~950 s.
    for _ in 0..2400 {
        run(&mut f, &p, 0.5, &c);
        desat_seen |= f.telemetry().desaturating;
        let x = f.attitude_at(f.epoch()).rotate(V3::X);
        worst = worst.max(fmath::acos(x.dot(x0).clamp(-1.0, 1.0)).to_degrees());
    }
    let h = f.wheel_momentum();
    eprintln!("desat: wheels {h:?}, worst pointing excursion {worst:.3}°");
    assert!(desat_seen);
    assert!(h.iter().all(|x| x.abs() < 5.0 + 1e-9), "{h:?}");
    assert!(worst < 0.5, "pointing excursion {worst}°");
}

#[test]
fn rcs_translation_is_pure_and_uses_rcs_propellant() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mut f = Flight::new(rs1(), &deep_space(), Quat::IDENTITY, &p).unwrap();
    let mut coast = f.clone();
    let c = Controls {
        translation: V3::new(0.0, 1.0, 0.0),
        sas: SasMode::Hold,
        ..Controls::default()
    };
    run(&mut f, &p, 10.0, &c);
    run(&mut coast, &p, 10.0, &Controls::default());
    let t = f.epoch();
    let dv = f.state_at(t).unwrap().state.v - coast.state_at(t).unwrap().state.v;
    let dv_body = f.attitude_at(t).conj().rotate(dv);
    eprintln!(
        "RCS +Y 10 s: Δv body {dv_body:?}, rate {:?} deg/s",
        f.omega_body() * 57.29578
    );
    assert!(dv_body.y > 0.05, "{dv_body:?}");
    assert!(dv_body.x.abs() < 0.02 * dv_body.y && dv_body.z.abs() < 0.02 * dv_body.y);
    assert!(f.omega_body().norm().to_degrees() < 0.05);
}

#[test]
fn staging_conserves_momentum_and_applies_separation_speed() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mut f = Flight::new(rs1(), &deep_space(), Quat::IDENTITY, &p).unwrap();
    f.set_body_rate(V3::new(0.0, 0.1f64.to_radians(), 0.0));
    let t = f.epoch();
    let before = f.state_at(t).unwrap();
    let m = f.mass_props().mass;
    f.stage();
    let debris = f
        .advance(
            &p,
            t.add_seconds(0.02),
            &Controls {
                rcs: false,
                ..Controls::default()
            },
            true,
            0.0,
        )
        .unwrap();
    assert_eq!(debris.len(), 1);
    let d = &debris[0];
    let rem = f.trajectory().start_epoch();
    let s = f.state_at(rem).unwrap();
    let mr = f.mass_props().mass;
    assert!((mr + d.state.mass - m).abs() < 1e-6);
    let p_before = before.state.v * m;
    let p_after = s.state.v * mr + d.state.state.v * d.state.mass;
    assert!(
        (p_after - p_before).norm() < 1e-9 * p_before.norm(),
        "momentum"
    );
    // Relative speed along +X: separation Δv plus the rigid-body rotation term.
    let rel = f
        .attitude_at(rem)
        .conj()
        .rotate(s.state.v - d.state.state.v);
    assert!(
        (rel.x - f.config.stages[0].separation_dv).abs() < 0.01,
        "{rel:?}"
    );
    assert!(!f.attached()[0] && f.attached()[1]);
    // The capsule's RCS is live now that the SM is gone.
    let c = Controls {
        rotation: V3::new(0.0, 1.0, 0.0),
        ..Controls::default()
    };
    let w0 = f.omega_body().y;
    run(&mut f, &p, 1.0, &c);
    assert!(f.omega_body().y > w0);
}

#[test]
fn identical_inputs_give_bit_identical_results_for_any_frame_chunking() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let base = Flight::new(rs1(), &leo(), Quat::IDENTITY, &p).unwrap();
    // Input schedule by tick index: a burn with SAS prograde and a manual roll.
    let controls_at = |tick: u64| Controls {
        throttle: if tick < 300 { 1.0 } else { 0.0 },
        rotation: if (100..150).contains(&tick) {
            V3::new(1.0, 0.0, 0.0)
        } else {
            V3::ZERO
        },
        sas: SasMode::Prograde,
        ..Controls::default()
    };
    let fly = |chunk: f64| {
        let mut f = base.clone();
        let end = t0().add_seconds(10.0);
        let mut t = t0();
        while end.seconds_since(t) > 1e-9 {
            let next_t = t.add_seconds(chunk.min(end.seconds_since(t)));
            // Advance tick by tick through the chunk so inputs follow the schedule.
            loop {
                let tick = (f.epoch().seconds_since(t0()) / 0.02).round() as u64;
                if f.epoch().seconds_since(next_t) > -1e-9 {
                    break;
                }
                let step_to = f.epoch().add_seconds(0.02).min_by(next_t);
                f.advance(&p, step_to, &controls_at(tick), true, 0.0)
                    .unwrap();
            }
            t = next_t;
        }
        let s = f.state_at(f.epoch()).unwrap();
        let q = f.attitude_at(f.epoch());
        (s.state.r, s.state.v, s.mass, q.w, q.x, q.y, q.z, f.epoch())
    };
    let a = fly(1.0 / 60.0);
    let b = fly(0.25);
    let c = fly(10.0);
    assert_eq!(a, b);
    assert_eq!(a, c);
}

trait MinBy {
    fn min_by(self, o: Epoch) -> Epoch;
}

impl MinBy for Epoch {
    fn min_by(self, o: Epoch) -> Epoch {
        if self.seconds_since(o) <= 0.0 {
            self
        } else {
            o
        }
    }
}

#[test]
fn orbit_attitude_points_prograde_with_nadir_down() {
    let s = leo();
    let q = sim_core::flight::orbit_attitude(s.state.r, s.state.v);
    let v = s.state.v.normalized().unwrap();
    let nadir = -s.state.r.normalized().unwrap();
    assert!(q.rotate(V3::X).max_abs_diff(v) < 1e-14);
    assert!(q.rotate(V3::Z).max_abs_diff(nadir) < 1e-14);
}
