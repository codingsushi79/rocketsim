//! M9: transfer planning. A LEO → Moon porkchop must find the classic ~3.1 km/s
//! translunar injection, and the n-body correction must put the flyby periapsis where it
//! was asked. Earth → Mars (2026 window) runs when the 2020s decade ephemeris is present.

use sim_core::bodies::{BodyId, BodyRegistry};
use sim_core::constants::gm;
use sim_core::ephemeris::Ephemeris;
use sim_core::frames::{IcrfBody, State};
use sim_core::math::{V3, fmath};
use sim_core::prediction::{EngineModel, HorizonPolicy};
use sim_core::propagator::{Propagator, ScState};
use sim_core::time::{Epoch, UtcDateTime, utc_to_tdb};
use sim_core::transfer::{self, Parking};

fn t0() -> Epoch {
    utc_to_tdb(&UtcDateTime::new(2026, 11, 1, 0, 0, 0.0)).unwrap()
}

/// Circular 400 km orbit in the Moon's orbital plane (the usual TLI geometry).
fn parking_in_moon_plane(e: &Ephemeris) -> Parking {
    let m = e.state_relative(BodyId::MOON, BodyId::EARTH, t0()).unwrap();
    let h = m.r.cross(m.v).normalized().unwrap();
    let x = V3::new(1.0, 0.0, 0.0);
    let u = (x - h * x.dot(h)).normalized().unwrap();
    let w = h.cross(u);
    let r = 6_378_137.0 + 400e3;
    let v = (gm::EARTH / r).sqrt();
    Parking {
        center: BodyId::EARTH,
        epoch: t0(),
        r: u * r,
        v: w * v,
        mu: gm::EARTH,
    }
}

#[test]
fn lunar_porkchop_and_nbody_correction() {
    let mut e = Ephemeris::new();
    e.load(include_bytes!("fixtures/ephem_2026q4.rseph"))
        .unwrap();
    let reg = BodyRegistry::builtin();
    let park = parking_in_moon_plane(&e);
    let period = 2.0 * std::f64::consts::PI * {
        let r = park.r.norm();
        (r * r * r / park.mu).sqrt()
    };
    let pc = transfer::porkchop(
        &e,
        &reg,
        &park,
        BodyId::MOON,
        t0().add_seconds(600.0),
        t0().add_seconds(600.0 + period),
        48,
        3.0 * 86_400.0,
        5.0 * 86_400.0,
        9,
    );
    let (k, dv) = pc
        .dv
        .iter()
        .enumerate()
        .filter(|(_, d)| d.is_finite())
        .min_by(|a, b| a.1.total_cmp(b.1))
        .unwrap();
    eprintln!(
        "best TLI {dv:.1} m/s, tof {:.2} d",
        pc.tof[k % 9] / 86_400.0
    );
    // Hohmann-like TLI from 400 km is ≈ 3.1 km/s (Curtis Ex. 9.x; Apollo ≈ 3.15 km/s from 185 km).
    assert!((3_000.0..3_250.0).contains(dv), "{dv}");

    // First guess, then correct on the full propagator to a 200 km flyby.
    let t_dep = Epoch::from_tdb_seconds(pc.dep[k / 9]);
    let node = transfer::first_guess(&e, &reg, &park, BodyId::MOON, t_dep, pc.tof[k % 9]).unwrap();
    let s0 = ScState {
        epoch: t0(),
        state: State::new(
            park.r,
            park.v,
            IcrfBody {
                center: BodyId::EARTH,
            },
        ),
        mass: 20_000.0,
    };
    let p = Propagator::new(&e, &reg);
    let policy = HorizonPolicy::default();
    // RS-1 main engine (data/vehicles/rs1_corvid.json): a finite burn of ~12 min.
    let eng = Some(EngineModel {
        thrust: 66_723.0,
        isp: 318.0,
    });
    let (ca0, tca) =
        transfer::closest_approach(&p, &e, &reg, &s0, &[node], eng, &policy, BodyId::MOON).unwrap();
    {
        let pred = sim_core::prediction::predict(&p, &s0, &[node], eng, &policy).unwrap();
        eprintln!(
            "node t+{:.0} s dv {:?}; horizon {:.2} d; CA {:.0} km at t+{:.2} d",
            node.epoch().seconds_since(t0()),
            node.dv(),
            pred.horizon.seconds_since(t0()) / 86400.0,
            ca0 / 1000.0,
            tca.seconds_since(t0()) / 86400.0
        );
        for m in sim_core::prediction::markers(&e, &reg, &pred.traj, t0(), Some(BodyId::MOON)) {
            eprintln!(
                "  {:?} t+{:.2} d v {:.0}",
                m.kind,
                m.epoch.seconds_since(t0()) / 86400.0,
                m.value
            );
        }
    }
    let r_target = 1_737_400.0 + 200e3;
    let (plan, miss) = transfer::plan(
        &p,
        &e,
        &reg,
        &s0,
        &park,
        eng,
        &policy,
        BodyId::MOON,
        t_dep,
        pc.tof[k % 9],
        r_target,
    )
    .unwrap();
    let (tli, mcc) = (plan[0], plan[1]);
    eprintln!(
        "patched-conic miss {:.0} km → periapsis error {:.1} km; TLI {:.1} m/s (guess {:.1}), MCC {:.1} m/s",
        (ca0 - r_target) / 1000.0,
        miss / 1000.0,
        tli.dv_magnitude(),
        node.dv_magnitude(),
        mcc.dv_magnitude()
    );
    assert!(miss.abs() < 20e3);
    // Finite-burn losses on the TLI (~12 min burn) are a few %; the midcourse burn is small.
    assert!((tli.dv_magnitude() - node.dv_magnitude()).abs() < 150.0);
    assert!(mcc.dv_magnitude() < 60.0);
    let _ = fmath::cos(0.0);
}

#[test]
fn mars_2026_window() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/public/ephemeris/ephem-2020.rseph"
    );
    let Ok(bytes) = std::fs::read(path) else {
        eprintln!("skipped: {path} not present (built by scripts/ / CI)");
        return;
    };
    let mut e = Ephemeris::new();
    e.load(&bytes).unwrap();
    let reg = BodyRegistry::builtin();
    let r = 6_378_137.0 + 400e3;
    let park = Parking {
        center: BodyId::EARTH,
        epoch: t0(),
        r: V3::new(r, 0.0, 0.0),
        v: V3::new(0.0, (gm::EARTH / r).sqrt(), 0.0),
        mu: gm::EARTH,
    };
    let mars = BodyId::MARS;
    let pc = transfer::porkchop(
        &e,
        &reg,
        &park,
        mars,
        t0().add_seconds(-60.0 * 86_400.0),
        t0().add_seconds(90.0 * 86_400.0),
        31,
        150.0 * 86_400.0,
        330.0 * 86_400.0,
        19,
    );
    let (k, dv) = pc
        .dv
        .iter()
        .enumerate()
        .filter(|(_, d)| d.is_finite())
        .min_by(|a, b| a.1.total_cmp(b.1))
        .unwrap();
    let dep = Epoch::from_tdb_seconds(pc.dep[k / 19]);
    eprintln!(
        "best Mars departure Δv {dv:.0} m/s at {:.1} d from 1 Nov, tof {:.0} d",
        dep.seconds_since(t0()) / 86_400.0,
        pc.tof[k % 19] / 86_400.0
    );
    // Hohmann LEO → Mars ≈ 3.6 km/s; the 2026 opportunity is a little costlier than ideal.
    assert!((3_400.0..4_200.0).contains(dv), "{dv}");
}

#[test]
fn lunar_plan_from_an_inclined_parking_orbit() {
    use sim_core::kepler::Elements;
    use sim_core::prediction::EngineModel;
    let mut e = Ephemeris::new();
    e.load(include_bytes!("fixtures/ephem_2026q4.rseph"))
        .unwrap();
    let reg = BodyRegistry::builtin();
    // As the "Lunar flyby" mission: 400 km, 28.5°, node 200°.
    let r = 6_378_137.0 + 400e3;
    let el = Elements {
        p: r,
        a: r,
        e: 0.0,
        i: 28.5f64.to_radians(),
        raan: 200f64.to_radians(),
        argp: 0.0,
        nu: 0.0,
    };
    let (rv, vv) = el.to_state(gm::EARTH);
    let park = Parking {
        center: BodyId::EARTH,
        epoch: t0(),
        r: rv,
        v: vv,
        mu: gm::EARTH,
    };
    let period = 2.0 * std::f64::consts::PI * (r * r * r / gm::EARTH).sqrt();
    let pc = transfer::porkchop(
        &e,
        &reg,
        &park,
        BodyId::MOON,
        t0().add_seconds(600.0),
        t0().add_seconds(600.0 + period),
        48,
        3.0 * 86_400.0,
        6.0 * 86_400.0,
        24,
    );
    let (k, dv) = pc
        .dv
        .iter()
        .enumerate()
        .filter(|(_, d)| d.is_finite())
        .min_by(|a, b| a.1.total_cmp(b.1))
        .unwrap();
    eprintln!(
        "inclined: best {dv:.0} m/s tof {:.2} d",
        pc.tof[k % 24] / 86_400.0
    );
    let s0 = ScState {
        epoch: t0(),
        state: State::new(
            rv,
            vv,
            IcrfBody {
                center: BodyId::EARTH,
            },
        ),
        mass: 24_960.0,
    };
    let p = Propagator::new(&e, &reg);
    let eng = Some(EngineModel {
        thrust: 66_723.0,
        isp: 318.0,
    });
    let res = transfer::plan(
        &p,
        &e,
        &reg,
        &s0,
        &park,
        eng,
        &HorizonPolicy::default(),
        BodyId::MOON,
        Epoch::from_tdb_seconds(pc.dep[k / 24]),
        pc.tof[k % 24],
        1_737_400.0 + 200e3,
    );
    if let Err(err) = &res {
        eprintln!("inclined: ERR {err:?}");
    }
    let (plan, miss) = res.unwrap();
    eprintln!(
        "inclined: TLI {:.0} MCC {:.1} miss {:.1} km",
        plan[0].dv_magnitude(),
        plan[1].dv_magnitude(),
        miss / 1000.0
    );
    assert!(miss.abs() < 20e3);
}
