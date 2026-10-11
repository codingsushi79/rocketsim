//! NRLMSISE-00 port vs NRL's own test driver output (nrlmsise00_driver.for /
//! nrlmsise00_output.txt, NASA CCMC ModelWeb archive). Cases 1–10: the cases at
//! ≥ 72.5 km with default switches. The reference is printed to 3–4 significant figures.

use sim_core::nrlmsise00::{MsisInput, gtd7d};

#[rustfmt::skip]
/// (doy, ut, alt, lat, long, lst, f107a, f107, ap)
type Case = (f64, f64, f64, f64, f64, f64, f64, f64, f64);

#[rustfmt::skip]
const CASES: [Case; 10] = [
    // doy, ut, alt, lat, long, lst, f107a, f107, ap
    (172.0, 29000.0, 400.0, 60.0, -70.0, 16.0, 150.0, 150.0, 4.0),
    (81.0, 29000.0, 400.0, 60.0, -70.0, 16.0, 150.0, 150.0, 4.0),
    (172.0, 75000.0, 1000.0, 60.0, -70.0, 16.0, 150.0, 150.0, 4.0),
    (172.0, 29000.0, 100.0, 60.0, -70.0, 16.0, 150.0, 150.0, 4.0),
    (172.0, 29000.0, 400.0, 0.0, -70.0, 16.0, 150.0, 150.0, 4.0),
    (172.0, 29000.0, 400.0, 60.0, 0.0, 16.0, 150.0, 150.0, 4.0),
    (172.0, 29000.0, 400.0, 60.0, -70.0, 4.0, 150.0, 150.0, 4.0),
    (172.0, 29000.0, 400.0, 60.0, -70.0, 16.0, 70.0, 150.0, 4.0),
    (172.0, 29000.0, 400.0, 60.0, -70.0, 16.0, 150.0, 180.0, 4.0),
    (172.0, 29000.0, 400.0, 60.0, -70.0, 16.0, 150.0, 150.0, 40.0),
];

/// He, O, N2, O2, Ar, mass (GTD7, without anomalous O), H, N, anomalous O, Tinf, T.
#[rustfmt::skip]
const EXPECTED: [[f64; 11]; 10] = [
    [6.67E+05, 1.14E+08, 2.00E+07, 4.02E+05, 3.56E+03, 4.07E-15, 3.48E+04, 4.10E+06, 2.67E+04, 1.251E+03, 1.241E+03],
    [3.41E+06, 1.59E+08, 1.39E+07, 3.26E+05, 1.56E+03, 5.00E-15, 4.85E+04, 4.38E+06, 6.96E+03, 1.167E+03, 1.162E+03],
    [1.12E+05, 6.93E+04, 4.25E+01, 1.32E-01, 2.62E-05, 2.76E-18, 2.02E+04, 5.74E+03, 2.37E+04, 1.240E+03, 1.240E+03],
    [5.41E+07, 1.92E+11, 6.12E+12, 1.23E+12, 6.02E+10, 3.58E-10, 1.06E+07, 2.62E+05, 0.00E+00, 1.027E+03, 2.069E+02],
    [1.85E+06, 1.48E+08, 1.58E+07, 2.63E+05, 1.59E+03, 4.81E-15, 5.82E+04, 5.48E+06, 1.26E+03, 1.212E+03, 1.208E+03],
    [8.67E+05, 1.28E+08, 1.82E+07, 2.92E+05, 2.40E+03, 4.36E-15, 3.69E+04, 3.90E+06, 2.67E+04, 1.220E+03, 1.213E+03],
    [5.78E+05, 6.98E+07, 1.24E+07, 2.49E+05, 1.41E+03, 2.47E-15, 5.29E+04, 1.07E+06, 2.67E+04, 1.116E+03, 1.113E+03],
    [3.74E+05, 4.78E+07, 5.24E+06, 1.76E+05, 5.50E+02, 1.57E-15, 8.90E+04, 1.98E+06, 9.12E+03, 1.031E+03, 1.025E+03],
    [6.75E+05, 1.25E+08, 2.37E+07, 4.91E+05, 4.58E+03, 4.56E-15, 3.24E+04, 5.37E+06, 2.67E+04, 1.306E+03, 1.293E+03],
    [5.53E+05, 1.20E+08, 3.50E+07, 9.34E+05, 1.10E+04, 4.97E-15, 2.69E+04, 4.89E+06, 2.81E+04, 1.362E+03, 1.347E+03],
];

#[test]
fn matches_nrl_driver_output() {
    for (i, (c, e)) in CASES.iter().zip(EXPECTED.iter()).enumerate() {
        let out = gtd7d(&MsisInput {
            doy: c.0,
            sec: c.1,
            alt_km: c.2,
            glat: c.3,
            glong: c.4,
            stl: c.5,
            f107a: c.6,
            f107: c.7,
            ap: c.8,
        })
        .unwrap();
        let mut got = [0.0; 11];
        got[..9].copy_from_slice(&out.d);
        got[5] -= 1.66e-24 * 16.0 * out.d[8]; // GTD7's total excludes anomalous O
        got[9] = out.t[0];
        got[10] = out.t[1];
        for k in 0..11 {
            if e[k] == 0.0 {
                assert!(
                    got[k].abs() < 1e-30 || got[k] < 1e-3 * e.iter().cloned().fold(0.0, f64::max),
                    "case {} item {k}",
                    i + 1
                );
                continue;
            }
            // 3 significant figures printed (±0.5 in the last digit), plus f32-vs-f64 noise.
            let rel = (got[k] / e[k] - 1.0).abs();
            assert!(
                rel < 6e-3,
                "case {} item {k}: {:e} vs {:e} ({rel:.2e})",
                i + 1,
                got[k],
                e[k]
            );
        }
    }
}
