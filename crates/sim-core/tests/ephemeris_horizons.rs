//! Ephemeris vs JPL Horizons (spec §6): barycentric ICRF positions and velocities.
//!
//! Fixtures:
//! - tests/fixtures/horizons_vectors.csv: Horizons API, fetched by
//!   tools/fixtures/fetch_horizons.py (date and per-body Horizons sources in its header).
//! - tests/fixtures/ephem_horizons.rseph: the segments of our built ephemeris that
//!   cover those epochs (`ephem-build fixture`). Same fit as the shipped files.
//!
//! Horizons uses DE441 and newer satellite solutions (e.g. nep098) than the NAIF
//! generic kernels we build from (DE440, nep097), so some differences are real
//! model differences, not errors. Tolerances below are documented per body.

use sim_core::bodies::BodyId;
use sim_core::ephemeris::Ephemeris;
use sim_core::math::V3;
use sim_core::time::Epoch;

struct Row {
    naif: i32,
    tdb: f64,
    r: [f64; 3],
    v: [f64; 3],
}

fn rows() -> Vec<Row> {
    include_str!("fixtures/horizons_vectors.csv")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.starts_with("naif") && !l.is_empty())
        .map(|l| {
            let f: Vec<f64> = l.split(',').map(|x| x.parse().unwrap()).collect();
            Row {
                naif: f[0] as i32,
                tdb: ((f[1] - 2_451_545.0) * 86_400.0).round(),
                r: [f[2] * 1e3, f[3] * 1e3, f[4] * 1e3],
                v: [f[5] * 1e3, f[6] * 1e3, f[7] * 1e3],
            }
        })
        .collect()
}

fn ephemeris() -> Ephemeris {
    let mut e = Ephemeris::new();
    e.load(include_bytes!("fixtures/ephem_horizons.rseph"))
        .unwrap();
    e
}

/// (NAIF id, position tolerance m, velocity tolerance m/s, reason)
const TOLERANCES: &[(i32, f64, f64, &str)] = &[
    // Spec §6 bodies: 1 km.
    (399, 1_000.0, 0.01, "spec"),
    (301, 1_000.0, 0.01, "spec"),
    (499, 1_000.0, 0.01, "spec"),
    (599, 1_000.0, 0.01, "spec"),
    // Other DE440 bodies: also 1 km.
    (10, 1_000.0, 0.01, "DE440 vs DE441"),
    (199, 1_000.0, 0.01, "DE440 vs DE441"),
    (299, 1_000.0, 0.01, "DE440 vs DE441"),
    (4, 1_000.0, 0.01, "DE440 vs DE441"),
    (5, 1_000.0, 0.01, "DE440 vs DE441"),
    (6, 1_000.0, 0.01, "DE440 vs DE441"),
    (7, 1_000.0, 0.01, "DE440 vs DE441"),
    (8, 1_000.0, 0.01, "DE440 vs DE441"),
    (9, 1_000.0, 0.01, "DE440 vs DE441"),
    (699, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    (999, 1_000.0, 0.01, "plu060 (same as Horizons)"),
    (401, 1_000.0, 0.01, "mar099 (same as Horizons)"),
    (402, 1_000.0, 0.01, "mar099 (same as Horizons)"),
    (501, 1_000.0, 0.01, "jup365 (same as Horizons)"),
    (502, 1_000.0, 0.01, "jup365 (same as Horizons)"),
    (503, 1_000.0, 0.01, "jup365 (same as Horizons)"),
    (504, 1_000.0, 0.01, "jup365 (same as Horizons)"),
    (601, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    (602, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    (603, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    (604, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    (605, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    (606, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    (608, 1_000.0, 0.01, "sat441 (same as Horizons)"),
    // Model differences, not errors. Horizons' Neptune system (nep098) carries its own
    // heliocentric orbit, which drifts from DE441's Neptune barycenter by ~2,000 km
    // by 2100. Our Neptune–barycenter offset is the physical ~74 km. Triton is
    // checked planet-relative in `moons_relative_to_their_planet_match_horizons`.
    (899, 2_500_000.0, 0.05, "nep098 heliocentric orbit ≠ DE440"),
    (801, 2_500_000.0, 10.0, "nep098 heliocentric orbit ≠ DE440"),
    // sb441-n16 asteroid states are DE441 perturber integrations, which NAIF notes are
    // not best-estimate orbits. Horizons uses newer orbit solutions (JPL#48, #36).
    (2_000_001, 400_000.0, 0.05, "sb441-n16 vs Horizons JPL#48"),
    (2_000_004, 250_000.0, 0.05, "sb441-n16 vs Horizons JPL#36"),
];

fn tolerance(naif: i32) -> (f64, f64, &'static str) {
    TOLERANCES
        .iter()
        .find(|t| t.0 == naif)
        .map(|t| (t.1, t.2, t.3))
        .unwrap_or((f64::INFINITY, f64::INFINITY, "measured only"))
}

#[test]
fn barycentric_states_match_horizons() {
    let e = ephemeris();
    let mut worst: std::collections::BTreeMap<i32, (f64, f64)> = Default::default();
    for r in rows() {
        let s = e
            .state_ssb(BodyId(r.naif), Epoch::from_tdb_seconds(r.tdb))
            .unwrap_or_else(|err| panic!("{err}"));
        let dr = (s.r - V3::new(r.r[0], r.r[1], r.r[2])).norm();
        let dv = (s.v - V3::new(r.v[0], r.v[1], r.v[2])).norm();
        let w = worst.entry(r.naif).or_default();
        w.0 = w.0.max(dr);
        w.1 = w.1.max(dv);
        let (tr, tv, why) = tolerance(r.naif);
        assert!(
            dr <= tr,
            "body {} at TDB {}: |Δr| = {dr:.1} m > {tr} m ({why})",
            r.naif,
            r.tdb
        );
        assert!(
            dv <= tv,
            "body {} at TDB {}: |Δv| = {dv:.4} m/s > {tv} m/s ({why})",
            r.naif,
            r.tdb
        );
    }
    eprintln!(
        "{:>8} {:>12} {:>12}  tolerance",
        "naif", "max|Δr| m", "max|Δv| m/s"
    );
    for (id, (dr, dv)) in &worst {
        let (tr, tv, why) = tolerance(*id);
        eprintln!("{id:>8} {dr:>12.1} {dv:>12.5}  {tr} m / {tv} m/s ({why})");
    }
}

/// Moon relative to its planet's body center: Horizons' satellite solution gives
/// both, so heliocentric differences cancel and this checks our fit + composition.
#[test]
fn moons_relative_to_their_planet_match_horizons() {
    let e = ephemeris();
    let all = rows();
    let find = |naif: i32, tdb: f64| all.iter().find(|r| r.naif == naif && r.tdb == tdb);
    let pairs = [
        (401, 499),
        (402, 499),
        (501, 599),
        (502, 599),
        (503, 599),
        (504, 599),
        (601, 699),
        (602, 699),
        (603, 699),
        (604, 699),
        (605, 699),
        (606, 699),
        (608, 699),
        (801, 899),
        (301, 399),
    ];
    eprintln!(
        "{:>6} {:>6} {:>10} {:>12}",
        "moon", "planet", "max|Δr| m", "max|Δv| m/s"
    );
    for (moon, planet) in pairs {
        let (mut wr, mut wv) = (0.0f64, 0.0f64);
        let mut compared = 0;
        for m in all.iter().filter(|r| r.naif == moon) {
            let p = find(planet, m.tdb)
                .unwrap_or_else(|| panic!("no Horizons {planet} row at {}", m.tdb));
            compared += 1;
            let s = e
                .state_relative(BodyId(moon), BodyId(planet), Epoch::from_tdb_seconds(m.tdb))
                .unwrap();
            let h_r = [m.r[0] - p.r[0], m.r[1] - p.r[1], m.r[2] - p.r[2]];
            let h_v = [m.v[0] - p.v[0], m.v[1] - p.v[1], m.v[2] - p.v[2]];
            let dr = (s.r - V3::new(h_r[0], h_r[1], h_r[2])).norm();
            let dv = (s.v - V3::new(h_v[0], h_v[1], h_v[2])).norm();
            wr = wr.max(dr);
            wv = wv.max(dv);
        }
        assert!(compared >= 5, "{moon}: only {compared} epochs compared");
        eprintln!("{moon:>6} {planet:>6} {wr:>10.1} {wv:>12.5}");
        // Triton: our nep097 vs Horizons' nep098 (NAIF, July 2026, a new orbit
        // solution built on DE442). The ~709 km along-track difference by 2097 is that
        // model update, not a fit error. See docs/PROGRESS.md (M2 open questions).
        // Moon vs Earth: DE440 vs Horizons' DE441 lunar orbit (~9 m).
        let tol = if moon == 801 { 1_000_000.0 } else { 100.0 };
        assert!(
            wr <= tol,
            "{moon} relative to {planet}: {wr:.1} m > {tol} m"
        );
    }
}
