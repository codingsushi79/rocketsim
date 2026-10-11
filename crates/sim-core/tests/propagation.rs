//! Propagator validation (spec §6, M3): conservation, analytic Kepler cases, J2
//! precession, Hohmann transfer, Tsiolkovsky, warp invariance, determinism, center
//! switching and impact. The ephemeris is the committed 2026-10-25 … 2027-02-05 subset
//! of the shipped files (tests/fixtures/ephem_2026q4.rseph).

use sim_core::bodies::{BodyId, BodyRegistry};
use sim_core::constants::{G0, gm};
use sim_core::ephemeris::Ephemeris;
use sim_core::frames::{IcrfBody, State};
use sim_core::kepler::{self, Elements};
use sim_core::math::{V3, fmath};
use sim_core::propagator::{ArcEnd, Burn, BurnDirection, ForceConfig, Propagator, ScState};
use sim_core::time::{Epoch, UtcDateTime, utc_to_tdb};

fn eph() -> Ephemeris {
    let mut e = Ephemeris::new();
    e.load(include_bytes!("fixtures/ephem_2026q4.rseph"))
        .unwrap();
    e
}

fn t0() -> Epoch {
    utc_to_tdb(&UtcDateTime::new(2026, 11, 1, 0, 0, 0.0)).unwrap()
}

/// Circular orbit of radius r and inclination inc around `center`, ascending node at +x.
fn circular(center: BodyId, mu: f64, r: f64, inc: f64, mass: f64) -> ScState {
    let v = (mu / r).sqrt();
    let (s, c) = fmath::sin_cos(inc);
    ScState {
        epoch: t0(),
        state: State::new(
            V3::new(r, 0.0, 0.0),
            V3::new(0.0, v * c, v * s),
            IcrfBody { center },
        ),
        mass,
    }
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

#[test]
fn two_body_conserves_energy_and_momentum_over_1000_orbits() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let s0 = circular(
        BodyId::EARTH,
        gm::EARTH,
        6_778_137.0,
        51.6f64.to_radians(),
        1000.0,
    );
    let period =
        std::f64::consts::TAU * (6_778_137.0f64 * 6_778_137.0 * 6_778_137.0 / gm::EARTH).sqrt();
    let traj = p
        .propagate(&s0, t0().add_seconds(1000.0 * period), &[])
        .unwrap();
    let energy = |s: &ScState| s.state.v.norm_squared() / 2.0 - gm::EARTH / s.state.r.norm();
    let (e0, h0) = (energy(&s0), s0.state.r.cross(s0.state.v).norm());
    let mut worst = (0.0f64, 0.0f64);
    for k in 0..=1000 {
        let s = traj
            .state_at(t0().add_seconds(f64::from(k) * period))
            .unwrap();
        worst.0 = worst.0.max(((energy(&s) - e0) / e0).abs());
        worst.1 = worst
            .1
            .max(((s.state.r.cross(s.state.v).norm() - h0) / h0).abs());
    }
    // Analytic comparison of the final state.
    let end = traj.state_at(t0().add_seconds(1000.0 * period)).unwrap();
    let (ra, _) = kepler::propagate(s0.state.r, s0.state.v, gm::EARTH, 1000.0 * period).unwrap();
    let dr = (end.state.r - ra).norm();
    eprintln!(
        "1000 orbits: |ΔE/E| ≤ {:.2e}, |Δh/h| ≤ {:.2e}, final position vs Kepler {dr:.3} m, {} steps",
        worst.0,
        worst.1,
        traj.step_count()
    );
    assert!(worst.0 < 1e-10 && worst.1 < 1e-10, "{worst:?}");
    assert!(dr < 10.0, "{dr} m");
}

#[test]
fn matches_analytic_kepler_for_all_conic_types() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mu = gm::EARTH;
    let r0 = V3::new(7.0e6, 0.0, 0.0);
    let vesc = (2.0 * mu / 7.0e6).sqrt();
    // (label, v0, duration)
    let cases = [
        (
            "circular",
            V3::new(0.0, (mu / 7.0e6).sqrt(), 0.0),
            10.0 * 5_828.5,
        ),
        (
            "elliptical e≈0.7",
            V3::new(0.0, 0.8 * (mu / 7.0e6).sqrt() * 1.6, 1500.0),
            3.0 * 86_400.0,
        ),
        (
            "parabolic",
            V3::new(0.0, vesc * 0.8, vesc * 0.6),
            1.5 * 86_400.0,
        ),
        (
            "hyperbolic",
            V3::new(2000.0, 11_500.0, 1000.0),
            1.5 * 86_400.0,
        ),
    ];
    for (label, v0, dt) in cases {
        let s0 = ScState {
            epoch: t0(),
            state: State::new(
                r0,
                v0,
                IcrfBody {
                    center: BodyId::EARTH,
                },
            ),
            mass: 500.0,
        };
        let el = Elements::from_state(r0, v0, mu);
        let s = p
            .propagate(&s0, t0().add_seconds(dt), &[])
            .unwrap()
            .state_at(t0().add_seconds(dt))
            .unwrap();
        let (ra, va) = kepler::propagate(r0, v0, mu, dt).unwrap();
        let (dr, dv) = ((s.state.r - ra).norm(), (s.state.v - va).norm());
        eprintln!(
            "{label:>18} (e = {:.6}): Δr = {dr:.2e} m, Δv = {dv:.2e} m/s after {dt:.0} s",
            el.e
        );
        // Default tolerance; see `integrator_converges_to_analytic_solution` for the
        // convergence to sub-mm at tighter settings.
        assert!(dr < 0.2 && dv < 5e-5, "{label}: {dr} m, {dv} m/s");
    }
}

#[test]
fn j2_nodal_precession_matches_analytic_sun_synchronous_rate() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let mut p = Propagator::new(&e, &reg);
    p.forces = ForceConfig {
        third_body: false,
        drag: false,
        srp: false,
        earth_degree: 2,
        ..ForceConfig::default()
    };
    p.center_switching = false;
    // 800 km sun-synchronous orbit: i = 98.6°.
    let a = 6_378_137.0 + 800e3;
    let inc = 98.6f64.to_radians();
    let s0 = circular(BodyId::EARTH, gm::EARTH, a, inc, 1000.0);
    let days = 10.0;
    let traj = p
        .propagate(&s0, t0().add_seconds(days * 86_400.0), &[])
        .unwrap();
    // Least-squares slope of the osculating node (unwrapped) against time.
    let (mut n, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut prev = None::<f64>;
    let mut offset = 0.0;
    for k in 0..=2000 {
        let t = f64::from(k) * days * 86_400.0 / 2000.0;
        let s = traj.state_at(t0().add_seconds(t)).unwrap();
        let raan = Elements::from_state(s.state.r, s.state.v, gm::EARTH).raan;
        if let Some(pr) = prev {
            if raan - pr > 3.0 {
                offset -= std::f64::consts::TAU;
            } else if pr - raan > 3.0 {
                offset += std::f64::consts::TAU;
            }
        }
        prev = Some(raan);
        let y = raan + offset;
        n += 1.0;
        sx += t;
        sy += y;
        sxx += t * t;
        sxy += t * y;
    }
    let rate = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    let field = sim_core::gravity::earth_egm2008(2);
    let (analytic, _) = kepler::j2_secular_rates(gm::EARTH, field.jn(2), field.radius, a, 0.0, inc);
    let deg_day = |x: f64| x.to_degrees() * 86_400.0;
    eprintln!(
        "node rate: numeric {:.5}°/day, analytic {:.5}°/day (sun-synchronous ≈ 0.9856)",
        deg_day(rate),
        deg_day(analytic)
    );
    // The analytic rate is first-order in J₂ with mean elements; an initially circular
    // osculating orbit has a mean semi-major axis offset of O(J₂(R/a)²) ≈ 1e-3, so
    // ~0.4% agreement is expected.
    assert!(
        (rate / analytic - 1.0).abs() < 1e-2,
        "{} vs {}",
        deg_day(rate),
        deg_day(analytic)
    );
    assert!((deg_day(rate) - 0.9856).abs() < 0.01);
}

#[test]
fn hohmann_leo_to_geo_arrives() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = two_body(&e, &reg);
    let mu = gm::EARTH;
    let (r1, r2) = (6_778_137.0, 42_164_137.0);
    let (dv1, dv2, tof) = kepler::hohmann(mu, r1, r2);
    // Vallado Example 6-1 parameters give 3.935 km/s; these radii: about 3.85 km/s.
    eprintln!(
        "Hohmann {:.1} km → {:.1} km: Δv = {:.4} + {:.4} km/s, TOF = {:.4} h",
        r1 / 1e3,
        r2 / 1e3,
        dv1 / 1e3,
        dv2 / 1e3,
        tof / 3600.0
    );
    let s0 = circular(BodyId::EARTH, mu, r1, 0.0, 1000.0);
    // Impulsive burns: apply Δv as an instantaneous velocity change.
    let mut s = s0;
    s.state.v = s.state.v * (1.0 + dv1 / s.state.v.norm());
    let arrival = p
        .propagate(&s, s.epoch.add_seconds(tof), &[])
        .unwrap()
        .state_at(s.epoch.add_seconds(tof))
        .unwrap();
    let rn = arrival.state.r.norm();
    assert!((rn - r2).abs() < 1.0, "arrival radius {rn} vs {r2}");
    // Apoapsis point: radial velocity ~0, speed + dv2 = circular GEO speed.
    let mut circ = arrival;
    circ.state.v = circ.state.v * (1.0 + dv2 / circ.state.v.norm());
    let el = Elements::from_state(circ.state.r, circ.state.v, mu);
    assert!(el.e < 1e-6, "e after circularization = {}", el.e);
    assert!((el.a - r2).abs() < 1.0);
}

#[test]
fn finite_burn_obeys_tsiolkovsky() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let mut p = Propagator::new(&e, &reg);
    p.forces.srp = false;
    // Deep space, heliocentric, 1 au, 60° ahead of Earth: gravity gradients are
    // ~1e-13 s⁻², so the burn's Δv is isolated from gravity losses.
    let earth = e.state_relative(BodyId::EARTH, BodyId::SUN, t0()).unwrap();
    let ahead = sim_core::math::M3::r3(-60f64.to_radians());
    let r = ahead.mul_v3(earth.r);
    let v = ahead.mul_v3(earth.v);
    let s0 = ScState {
        epoch: t0(),
        state: State::new(
            r,
            v,
            IcrfBody {
                center: BodyId::SUN,
            },
        ),
        mass: 10_000.0,
    };
    let (thrust, isp, dur) = (20_000.0, 320.0, 300.0);
    let burn = Burn {
        start: t0().add_seconds(10.0),
        end: t0().add_seconds(10.0 + dur),
        thrust,
        isp,
        direction: BurnDirection::Inertial(V3::new(0.0, 0.0, 1.0)),
    };
    let t_end = t0().add_seconds(400.0);
    let with = p
        .propagate(&s0, t_end, &[burn])
        .unwrap()
        .state_at(t_end)
        .unwrap();
    let without = p
        .propagate(&s0, t_end, &[])
        .unwrap()
        .state_at(t_end)
        .unwrap();
    let mf = 10_000.0 - thrust / (isp * G0) * dur;
    let ideal = isp * G0 * fmath::ln(10_000.0 / mf);
    let achieved = (with.state.v - without.state.v).norm();
    eprintln!(
        "burn: Δv achieved {achieved:.6} m/s, Tsiolkovsky {ideal:.6} m/s; mass {:.6} vs {mf:.6} kg",
        with.mass
    );
    assert!((with.mass - mf).abs() < 1e-6, "{} vs {mf}", with.mass);
    assert!(
        (achieved / ideal - 1.0).abs() < 1e-7,
        "{achieved} vs {ideal}"
    );
}

#[test]
fn warp_invariance_chunked_equals_single_run() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = Propagator::new(&e, &reg); // full force model
    let s0 = circular(
        BodyId::EARTH,
        gm::EARTH,
        6_778_137.0,
        51.6f64.to_radians(),
        15_000.0,
    );
    let horizon = 3.0 * 3600.0;
    // "100,000× warp": one call to the horizon.
    let fast = p.propagate(&s0, t0().add_seconds(horizon), &[]).unwrap();
    // "1×": advance one 60 Hz frame at a time, extending the trajectory as needed.
    let mut slow = p.propagate(&s0, t0(), &[]).unwrap();
    let frames = (horizon * 60.0) as usize;
    for k in 1..=frames {
        p.extend(&mut slow, t0().add_seconds(k as f64 / 60.0), &[])
            .unwrap();
    }
    for k in 0..=36 {
        let t = t0().add_seconds(f64::from(k) * 300.0);
        let (a, b) = (fast.state_at(t).unwrap(), slow.state_at(t).unwrap());
        assert_eq!(
            a.state.r.x.to_bits(),
            b.state.r.x.to_bits(),
            "t+{}s",
            k * 300
        );
        assert_eq!(a.state.v.z.to_bits(), b.state.v.z.to_bits());
    }
    assert_eq!(fast.step_count(), slow.step_count());
}

#[test]
fn propagation_is_deterministic() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = Propagator::new(&e, &reg);
    let s0 = circular(
        BodyId::EARTH,
        gm::EARTH,
        6_778_137.0,
        51.6f64.to_radians(),
        15_000.0,
    );
    let run = || {
        p.propagate(&s0, t0().add_seconds(86_400.0), &[])
            .unwrap()
            .end_state()
    };
    let (a, b) = (run(), run());
    assert_eq!(a.state.r.x.to_bits(), b.state.r.x.to_bits());
    assert_eq!(a.state.v.y.to_bits(), b.state.v.y.to_bits());
    assert_eq!(a.mass.to_bits(), b.mass.to_bits());
}

#[test]
fn lunar_flyby_center_switching_agrees_with_single_center() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let mut p = Propagator::new(&e, &reg);
    p.forces = ForceConfig {
        drag: false,
        srp: false,
        harmonics: false,
        ..ForceConfig::default()
    };
    p.integrator.rtol = 1e-12;
    // Aim at where the Moon will be ~3 days later: a translunar-like trajectory from
    // a 6,700 km perigee, coplanar with the Moon's orbit.
    let tf = 3.0 * 86_400.0;
    let moon_then = e
        .state_relative(BodyId::MOON, BodyId::EARTH, t0().add_seconds(tf))
        .unwrap()
        .r;
    let h = moon_then.cross(
        e.state_relative(BodyId::MOON, BodyId::EARTH, t0())
            .unwrap()
            .v,
    );
    let dir = (-moon_then).normalized().unwrap();
    let r0 = dir * 6_700e3;
    let vdir = h.cross(dir).normalized().unwrap();
    let v0 = vdir * 10_900.0;
    let s0 = ScState {
        epoch: t0(),
        state: State::new(
            r0,
            v0,
            IcrfBody {
                center: BodyId::EARTH,
            },
        ),
        mass: 1000.0,
    };
    let t_end = t0().add_seconds(6.0 * 86_400.0);
    let switching = p.propagate(&s0, t_end, &[]).unwrap();
    let centers: Vec<BodyId> = switching.arcs.iter().map(|a| a.center).collect();
    p.center_switching = false;
    let fixed = p.propagate(&s0, t_end, &[]).unwrap();
    let a = switching.state_at(t_end).unwrap();
    let b = fixed.state_at(t_end).unwrap();
    // Compare in the same (Earth-centered) frame.
    let a_e = if a.state.frame.center == BodyId::EARTH {
        a.state.r
    } else {
        a.state.r
            + e.state_relative(a.state.frame.center, BodyId::EARTH, t_end)
                .unwrap()
                .r
    };
    let d = (a_e - b.state.r).norm();
    let closest = (0..=600)
        .map(|k| {
            let t = t0().add_seconds(f64::from(k) * 6.0 * 86_400.0 / 600.0);
            let s = fixed.state_at(t).unwrap();
            (s.state.r - e.state_relative(BodyId::MOON, BodyId::EARTH, t).unwrap().r).norm()
        })
        .fold(f64::INFINITY, f64::min);
    eprintln!(
        "flyby: centers {centers:?}, closest approach ≈ {:.0} km, switching vs fixed: {d:.3} m",
        closest / 1e3
    );
    assert!(
        centers.contains(&BodyId::MOON),
        "trajectory never entered the Moon's SOI"
    );
    assert!(d < 100.0, "{d} m");
}

#[test]
fn suborbital_trajectory_impacts_the_ground() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let mut p = Propagator::new(&e, &reg);
    p.forces.drag = false;
    // 200 km up, horizontal speed far too low for orbit.
    let s0 = circular(BodyId::EARTH, gm::EARTH, 6_578_137.0, 0.3, 1000.0);
    let mut s = s0;
    s.state.v = s.state.v * 0.5;
    let traj = p.propagate(&s, t0().add_seconds(7200.0), &[]).unwrap();
    match traj.terminated() {
        Some(ArcEnd::Impact { body }) => assert_eq!(body, BodyId::EARTH),
        other => panic!("expected impact, got {other:?}"),
    }
    let end = traj.end_state();
    let (_, _, h) = sim_core::earth::itrs_to_geodetic(
        sim_core::earth::earth_orientation(end.epoch)
            .0
            .icrf_to_bf
            .mul_v3(end.state.r),
    );
    eprintln!(
        "impact after {:.1} s at h = {h:.3} m",
        end.epoch.seconds_since(t0())
    );
    assert!(h.abs() < 100.0, "impact height {h} m");
}

#[test]
fn integrator_converges_to_analytic_solution() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let mu = gm::EARTH;
    let r0 = V3::new(7.0e6, 0.0, 0.0);
    let v0 = V3::new(0.0, 0.8 * (mu / 7.0e6).sqrt() * 1.6, 1500.0);
    let dt = 3.0 * 86_400.0;
    let (ra, _) = kepler::propagate(r0, v0, mu, dt).unwrap();
    let mut errors = Vec::new();
    for (rtol, atol) in [(1e-11, 1e-6), (1e-12, 1e-7), (1e-13, 1e-8), (1e-14, 1e-9)] {
        let mut p = two_body(&e, &reg);
        p.integrator.rtol = rtol;
        p.integrator.atol = atol;
        let s0 = ScState {
            epoch: t0(),
            state: State::new(
                r0,
                v0,
                IcrfBody {
                    center: BodyId::EARTH,
                },
            ),
            mass: 500.0,
        };
        let tr = p.propagate(&s0, t0().add_seconds(dt), &[]).unwrap();
        let s = tr.state_at(t0().add_seconds(dt)).unwrap();
        let dr = (s.state.r - ra).norm();
        eprintln!(
            "rtol {rtol:e} atol {atol:e}: Δr = {dr:.3e} m, steps {}",
            tr.step_count()
        );
        errors.push(dr);
    }
    // Error falls with tolerance and reaches sub-millimeter.
    assert!(errors.windows(2).all(|w| w[1] < w[0] / 3.0), "{errors:?}");
    assert!(errors[3] < 1e-3, "{errors:?}");
}

#[test]
fn pruning_history_does_not_change_the_future() {
    let (e, reg) = (eph(), BodyRegistry::builtin());
    let p = Propagator::new(&e, &reg);
    let s0 = circular(
        BodyId::EARTH,
        gm::EARTH,
        6_778_137.0,
        51.6f64.to_radians(),
        15_000.0,
    );
    let horizon = 4.0 * 3600.0;
    let full = p.propagate(&s0, t0().add_seconds(horizon), &[]).unwrap();
    // Extend in 10-minute chunks, pruning everything older than a minute each time
    // (what the browser does every frame).
    let mut pruned = p.propagate(&s0, t0(), &[]).unwrap();
    let mut t = 0.0;
    while t < horizon {
        t += 600.0;
        p.extend(&mut pruned, t0().add_seconds(t), &[]).unwrap();
        pruned.prune_before(t0().add_seconds(t - 60.0));
    }
    let a = full.state_at(t0().add_seconds(horizon)).unwrap();
    let b = pruned.state_at(t0().add_seconds(horizon)).unwrap();
    assert_eq!(a.state.r.x.to_bits(), b.state.r.x.to_bits());
    assert_eq!(a.state.v.z.to_bits(), b.state.v.z.to_bits());
    assert!(
        pruned.step_count() < full.step_count() / 4,
        "{} vs {}",
        pruned.step_count(),
        full.step_count()
    );
}
