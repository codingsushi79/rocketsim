//! Earth orientation (IAU 2006 / 2000B, equinox-based) vs ERFA `eraC2t06a`
//! (IAU 2006 / 2000A, CIO-based). Fixture: tests/fixtures/earth_c2t_erfa.csv
//! (tools/fixtures/gen_earth_erfa.py).
//!
//! Expected difference: IAU 2000B is a truncation of 2000A, good to ~1 mas over
//! 1995–2050 (McCarthy & Luzum 2003) and somewhat worse further out. 1 mas is
//! about 3 cm at Earth's surface.

use sim_core::earth::{gcrs_to_itrs, geodetic_to_itrs};
use sim_core::math::V3;
use sim_core::time::Tt;

#[test]
fn gcrs_to_itrs_matches_erfa_c2t06a() {
    let mut worst_m = 0.0f64;
    for line in include_str!("fixtures/earth_c2t_erfa.csv").lines().skip(1) {
        let f: Vec<f64> = line.split(',').map(|x| x.parse().unwrap()).collect();
        let tt = Tt::from_parts(f[0] as i64, f[1]);
        let m = gcrs_to_itrs(tt, (f[2] as i64, f[3]), f[4], f[5]);
        // Displacement of an equatorial and a mid-latitude surface point, ITRS → GCRS.
        for site in [
            geodetic_to_itrs(0.0, 0.0, 0.0),
            geodetic_to_itrs(0.8, 2.0, 0.0),
        ] {
            let ours = m.transpose().mul_v3(site);
            // GCRS = Mᵀ · ITRS = Σᵢ siteᵢ · (row i of ERFA's matrix)
            let row = |i: usize| V3::new(f[6 + 3 * i], f[7 + 3 * i], f[8 + 3 * i]);
            let theirs = row(0) * site.x + row(1) * site.y + row(2) * site.z;
            let d = (ours - theirs).norm();
            worst_m = worst_m.max(d);
            let year = 2000.0 + f[0] / 3.15576e7;
            // Measured worst case is 14.6 mm over 1976–2093; 5 cm leaves margin.
            let tol = 0.05;
            assert!(
                d < tol,
                "TT {}: surface displacement {d:.4} m vs ERFA (year {year:.0})",
                f[0]
            );
        }
    }
    eprintln!(
        "worst surface-point difference vs ERFA c2t06a: {:.1} mm",
        worst_m * 1e3
    );
}
