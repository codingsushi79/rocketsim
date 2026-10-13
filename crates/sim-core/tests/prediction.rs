//! M6: maneuver prediction, trajectory markers and burn execution.
//!
//! Analytic references: vis-viva for impulsive apoapsis raises, Kepler for apsides,
//! Tsiolkovsky for burn time. Ephemeris: the committed 2026q4 subset.

use sim_core::bodies::{BodyId, BodyRegistry};
use sim_core::constants::{G0, gm};
use sim_core::ephemeris::Ephemeris;
use sim_core::flight::{AutopilotPhase, Controls, Flight, SasMode, orbit_attitude};
use sim_core::frames::{IcrfBody, State};
use sim_core::kepler::Elements;
use sim_core::maneuver::ManeuverNode;
use sim_core::math::{V3, fmath};
use sim_core::prediction::{EngineModel, HorizonPolicy, MarkerKind, markers, predict};
use sim_core::propagator::{ForceConfig, Propagator, ScState};
use sim_core::time::{Epoch, UtcDateTime, utc_to_tdb};
use sim_core::vehicle::VehicleConfig;

const RS1: &str = include_str!("../../../data/vehicles/rs1_corvid.json");
const R_EARTH: f64 = 6_378_137.0;

fn eph() -> Ephemeris {
    let mut e = Ephemeris::new();
    e.load(include_bytes!("fixtures/ephem_2026q4.rseph"))
        .unwrap();
    e
}

fn t0() -> Epoch {
    utc_to_tdb(&UtcDateTime::new(2026, 11, 1, 0, 0, 0.0)).unwrap()
}

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

/// Circular orbit of radius r, inclination inc, node on +x.
fn circular(r: f64, inc: f64, mass: f64) -> ScState {
    let v = (gm::EARTH / r).sqrt();
    let (s, c) = fmath::sin_cos(inc);
    ScState {
        epoch: t0(),
        state: State::new(
            V3::new(r, 0.0, 0.0),
            V3::new(0.0, v * c, v * s),
            IcrfBody {
                center: BodyId::EARTH,
            },
        ),
        mass,
    }
}

const RS1_ENGINE: EngineModel = EngineModel {
    thrust: 66_723.0,
    isp: 318.0,
};

#[test]
fn a_zero_node_leaves_the_prediction_unchanged() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let s0 = circular(R_EARTH + 400e3, 0.9, 24_960.0);
    let pol = HorizonPolicy::default();
    let a = predict(&p, &s0, &[], Some(RS1_ENGINE), &pol).unwrap();
    let node = ManeuverNode::new(t0().add_seconds(1000.0), 0.0, 0.0, 0.0);
    let b = predict(&p, &s0, &[node], Some(RS1_ENGINE), &pol).unwrap();
    let t = t0().add_seconds(5000.0);
    let d = (a.traj.state_at(t).unwrap().state.r - b.traj.state_at(t).unwrap().state.r).norm();
    assert!(d < 1e-3, "{d} m");
    assert_eq!(b.burns[0].duration, 0.0);
}

#[test]
fn impulsive_limit_matches_vis_viva() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let r = R_EARTH + 400e3;
    let s0 = circular(r, 0.9, 24_960.0);
    let dv = 100.0;
    // A (fictional) 100 MN engine makes the burn last ~0.1 s: effectively impulsive.
    let engine = EngineModel {
        thrust: 1e8,
        isp: 318.0,
    };
    let t_node = t0().add_seconds(1234.0);
    let pred = predict(
        &p,
        &s0,
        &[ManeuverNode::new(t_node, dv, 0.0, 0.0)],
        Some(engine),
        &HorizonPolicy::default(),
    )
    .unwrap();
    let v1 = (gm::EARTH / r).sqrt() + dv;
    let a = 1.0 / (2.0 / r - v1 * v1 / gm::EARTH);
    let r_apo = 2.0 * a - r;
    let ms = markers(&e, &reg, &pred.traj, t_node, None);
    let apo = ms
        .iter()
        .find(|m| m.kind == MarkerKind::Apoapsis)
        .expect("apoapsis marker");
    let half_period = core::f64::consts::PI * (a * a * a / gm::EARTH).sqrt();
    eprintln!(
        "apoapsis {:.3} m (analytic {:.3}), at node + {:.3} s (analytic {:.3})",
        apo.position.norm(),
        r_apo,
        apo.epoch.seconds_since(t_node),
        half_period
    );
    assert!((apo.position.norm() - r_apo).abs() < 5.0);
    assert!((apo.epoch.seconds_since(t_node) - half_period).abs() < 0.5);
}

#[test]
fn burn_time_follows_tsiolkovsky_and_is_split_around_the_node() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let s0 = circular(R_EARTH + 400e3, 0.9, 24_960.0);
    let dv = 500.0;
    let t_node = t0().add_seconds(3000.0);
    let pred = predict(
        &p,
        &s0,
        &[ManeuverNode::new(t_node, dv, 0.0, 0.0)],
        Some(RS1_ENGINE),
        &HorizonPolicy::default(),
    )
    .unwrap();
    let b = &pred.burns[0];
    let ve = RS1_ENGINE.isp * G0;
    let m0 = 24_960.0;
    let mdot = RS1_ENGINE.thrust / ve;
    let duration = m0 / mdot * (1.0 - fmath::exp(-dv / ve));
    assert!((b.duration - duration).abs() < 1e-9);
    // Half the Δv by the node: ve·ln(m0 / m(t_node)) = dv/2.
    let before = t_node.seconds_since(b.start);
    let m_node = m0 - mdot * before;
    assert!((ve * fmath::ln(m0 / m_node) - dv / 2.0).abs() < 1e-6);
    // Mass at the end of the prediction matches.
    let m_end = pred.traj.end_state().mass;
    assert!((m_end - m0 * fmath::exp(-dv / ve)).abs() < 1e-6, "{m_end}");
}

#[test]
fn apsis_markers_match_kepler_on_an_eccentric_orbit() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    // Start at periapsis of an e = 0.3 orbit.
    let rp = R_EARTH + 500e3;
    let ecc = 0.3;
    let a = rp / (1.0 - ecc);
    let vp = (gm::EARTH * (1.0 + ecc) / rp).sqrt();
    let s0 = ScState {
        epoch: t0(),
        state: State::new(
            V3::new(rp, 0.0, 0.0),
            V3::new(0.0, vp, 0.0),
            IcrfBody {
                center: BodyId::EARTH,
            },
        ),
        mass: 1000.0,
    };
    let pred = predict(&p, &s0, &[], None, &HorizonPolicy::default()).unwrap();
    let period = core::f64::consts::TAU * (a * a * a / gm::EARTH).sqrt();
    let ms = markers(&e, &reg, &pred.traj, t0().add_seconds(1.0), None);
    let apo = ms.iter().find(|m| m.kind == MarkerKind::Apoapsis).unwrap();
    let peri = ms.iter().find(|m| m.kind == MarkerKind::Periapsis).unwrap();
    eprintln!(
        "apo {:.3} m at {:.4} s (Kepler {:.3} m at {:.4}); peri at {:.4} s (Kepler {:.4})",
        apo.position.norm(),
        apo.epoch.seconds_since(t0()),
        a * (1.0 + ecc),
        period / 2.0,
        peri.epoch.seconds_since(t0()),
        period
    );
    assert!((apo.position.norm() - a * (1.0 + ecc)).abs() < 0.01);
    assert!((apo.epoch.seconds_since(t0()) - period / 2.0).abs() < 2e-3);
    assert!((peri.epoch.seconds_since(t0()) - period).abs() < 2e-3);
    assert!(
        (peri.value - 500e3).abs()
            < 0.01 + (R_EARTH - reg.get(BodyId::EARTH).unwrap().radii.equatorial_mean()).abs()
    );
}

#[test]
fn target_markers_lie_on_the_target_plane_and_at_a_distance_minimum() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let s0 = circular(R_EARTH + 400e3, 51.6f64.to_radians(), 1000.0);
    let pred = predict(&p, &s0, &[], None, &HorizonPolicy::default()).unwrap();
    let ms = markers(&e, &reg, &pred.traj, t0(), Some(BodyId::MOON));
    let moon = e.state_relative(BodyId::MOON, BodyId::EARTH, t0()).unwrap();
    let h = moon.r.cross(moon.v).normalized().unwrap();
    let mut nodes = 0;
    for m in &ms {
        if matches!(
            m.kind,
            MarkerKind::AscendingNode | MarkerKind::DescendingNode
        ) {
            nodes += 1;
            assert!(
                m.position.dot(h).abs() < 1e-3 * m.position.norm(),
                "off-plane"
            );
            let s = pred.traj.state_at(m.epoch).unwrap();
            let hs = s.state.r.cross(s.state.v).normalized().unwrap();
            let inc = fmath::acos(hs.dot(h));
            assert!((inc - m.value).abs() < 1e-9);
            // Ascending: moving toward +h.
            let up = s.state.v.dot(h) > 0.0;
            assert_eq!(up, m.kind == MarkerKind::AscendingNode);
        }
    }
    assert_eq!(nodes, 2, "{ms:?}");
    let ca = ms
        .iter()
        .find(|m| m.kind == MarkerKind::ClosestApproach)
        .unwrap();
    let dist = |t: Epoch| {
        let s = pred.traj.state_at(t).unwrap();
        (s.state.r - e.state_relative(BodyId::MOON, BodyId::EARTH, t).unwrap().r).norm()
    };
    let d0 = dist(ca.epoch);
    assert!((d0 - ca.value).abs() < 1.0);
    assert!(dist(ca.epoch.add_seconds(-30.0)) > d0 && dist(ca.epoch.add_seconds(30.0)) > d0);
}

#[test]
fn autopilot_flies_the_planned_burn() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let s0 = circular(R_EARTH + 400e3, 51.6f64.to_radians(), 1.0);
    let cfg = VehicleConfig::from_json(RS1).unwrap();
    let mut f = Flight::new(cfg, &s0, orbit_attitude(s0.state.r, s0.state.v), &p).unwrap();
    let now = f.state_at(f.epoch()).unwrap();
    let dv = 150.0;
    let node = ManeuverNode::new(t0().add_seconds(1800.0), dv, 0.0, 0.0);
    let plan = predict(
        &p,
        &now,
        &[node],
        Some(RS1_ENGINE),
        &HorizonPolicy::default(),
    )
    .unwrap();
    let b = plan.burns[0];
    f.arm_autopilot(b.start, b.direction, b.frame, dv);
    let c = Controls {
        sas: SasMode::Hold,
        ..Controls::default()
    };
    // High warp on rails until the autopilot stops it, then physics through the burn.
    let mut guard = 0;
    while !f.warp_stop && guard < 100 {
        let t = f.epoch().add_seconds(600.0);
        f.advance(&p, t, &c, false, 1.0).unwrap();
        guard += 1;
    }
    assert!(f.warp_stop);
    let lead = b.start.seconds_since(f.epoch());
    assert!(
        (lead - 30.0).abs() < 1e-6,
        "warp stopped {lead} s before ignition"
    );
    while f.autopilot().unwrap().phase != AutopilotPhase::Done {
        let t = f.epoch().add_seconds(1.0);
        f.advance(&p, t, &c, true, 0.0).unwrap();
    }
    let ap = *f.autopilot().unwrap();
    let ign_err = ap.ignition.unwrap().seconds_since(b.start);
    let point =
        fmath::acos(ap.delivered_vector.normalized().unwrap().dot(b.direction)).to_degrees();
    // Compare against the plan a little after the burn.
    let t_check = b.start.add_seconds(b.duration + 60.0);
    f.advance(&p, t_check, &c, true, 0.0).unwrap();
    let actual = f.state_at(t_check).unwrap();
    let planned = plan.traj.state_at(t_check).unwrap();
    let el = |s: &ScState| Elements::from_state(s.state.r, s.state.v, gm::EARTH);
    let (ea, ep) = (el(&actual), el(&planned));
    let apo_err = ea.apoapsis().unwrap() - ep.apoapsis().unwrap();
    eprintln!(
        "autopilot: ignition {ign_err:+.3} s, Δv {:.4} of {dv} m/s (|vector| {:.4}), pointing {point:.4}°, \
         |Δr| {:.1} m, |Δv| {:.4} m/s, apoapsis error {apo_err:+.1} m",
        ap.delivered,
        ap.delivered_vector.norm(),
        (actual.state.r - planned.state.r).norm(),
        (actual.state.v - planned.state.v).norm(),
    );
    assert!(ign_err.abs() <= 0.02 + 1e-9);
    assert!((ap.delivered - dv).abs() < 0.2);
    assert!(apo_err.abs() < 1000.0);
}
