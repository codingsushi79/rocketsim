//! EGM2008 acceleration vs an independent high-precision reference
//! (tests/fixtures/egm2008_accel_reference.csv, tools/fixtures/gen_sh_reference.py):
//! direct potential summation in 50-digit arithmetic, differentiated numerically.

use sim_core::gravity::earth_egm2008;
use sim_core::math::V3;

#[test]
fn egm2008_matches_direct_summation() {
    let mut worst = 0.0f64;
    for line in include_str!("fixtures/egm2008_accel_reference.csv")
        .lines()
        .skip(1)
    {
        let f: Vec<f64> = line.split(',').map(|x| x.parse().unwrap()).collect();
        let n = f[0] as usize;
        let field = earth_egm2008(n);
        let a = field.acceleration(V3::new(f[1], f[2], f[3]), n, n);
        let reference = V3::new(f[4], f[5], f[6]);
        let rel = (a - reference).norm() / reference.norm();
        worst = worst.max(rel);
        assert!(rel < 1e-13, "degree {n}: relative error {rel:e}");
    }
    eprintln!("worst relative error vs reference: {worst:.2e}");
}
