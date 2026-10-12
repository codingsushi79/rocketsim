//! Lambert's problem: the conic connecting two positions in a given time.
//!
//! Algorithm: D. Izzo (2015), "Revisiting Lambert's problem", *Celest. Mech. Dyn. Astr.*
//! 121:1–15, as implemented in ESA's pykep (`lambert_problem.cpp`, MPL-2.0). The time of
//! flight is written in a single non-dimensional variable x; Householder (third-order)
//! iterations solve T(x) = T. Multiple revolutions give two solutions each (left/right).
//! Near x = 1 the Battin hypergeometric series replaces the Lagrange form (Izzo §2.4).
//!
//! All transcendental functions go through `fmath` (libm) for determinism (D8); sqrt and
//! floor are exactly rounded IEEE operations.

use crate::math::{V3, fmath};

const PI: f64 = core::f64::consts::PI;

/// One Lambert solution: velocities at departure and arrival, and its revolution count.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LambertSolution {
    pub v1: V3,
    pub v2: V3,
    pub revs: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LambertError {
    /// The positions are (anti)parallel: the transfer plane is undefined.
    Degenerate,
    /// Non-positive time of flight or gravitational parameter.
    BadInput,
    /// Householder iteration did not converge.
    NoConvergence,
}

/// Solve Lambert's problem.
///
/// - `r1`, `r2`: positions (m) relative to the attracting body;
/// - `tof`: time of flight (s); `mu`: gravitational parameter (m³/s²);
/// - `normal`: reference direction for "prograde" (the transfer's angular momentum has a
///   non-negative component along it), e.g. the ecliptic pole or the parking orbit's h;
/// - `max_revs`: highest number of full revolutions to consider.
///
/// Returns the zero-revolution solution first, then (left, right) pairs per revolution.
pub fn solve(
    r1: V3,
    r2: V3,
    tof: f64,
    mu: f64,
    normal: V3,
    max_revs: u32,
) -> Result<Vec<LambertSolution>, LambertError> {
    if !(tof > 0.0 && mu > 0.0) {
        return Err(LambertError::BadInput);
    }
    let c = r2 - r1;
    let cn = c.norm();
    let r1n = r1.norm();
    let r2n = r2.norm();
    let s = (cn + r1n + r2n) * 0.5;
    let ir1 = r1 * (1.0 / r1n);
    let ir2 = r2 * (1.0 / r2n);
    let ih = ir1
        .cross(ir2)
        .normalized()
        .ok_or(LambertError::Degenerate)?;
    let mut lambda = f64::sqrt((1.0 - cn / s).max(0.0));
    let (it1, it2) = if ih.dot(normal) < 0.0 {
        // The short way is retrograde: take the long way round (prograde).
        lambda = -lambda;
        (ir1.cross(ih), ir2.cross(ih))
    } else {
        (ih.cross(ir1), ih.cross(ir2))
    };
    let t = f64::sqrt(2.0 * mu / (s * s * s)) * tof;

    let xs = find_xy(lambda, t, max_revs)?;

    let gamma = f64::sqrt(mu * s * 0.5);
    let rho = (r1n - r2n) / cn;
    let sigma = f64::sqrt((1.0 - rho * rho).max(0.0));
    let out = xs
        .iter()
        .map(|&(x, revs)| {
            let y = f64::sqrt(1.0 - lambda * lambda + lambda * lambda * x * x);
            let vr1 = gamma * ((lambda * y - x) - rho * (lambda * y + x)) / r1n;
            let vr2 = -gamma * ((lambda * y - x) + rho * (lambda * y + x)) / r2n;
            let vt = gamma * sigma * (y + lambda * x);
            LambertSolution {
                v1: ir1 * vr1 + it1 * (vt / r1n),
                v2: ir2 * vr2 + it2 * (vt / r2n),
                revs,
            }
        })
        .collect();
    Ok(out)
}

/// Non-dimensional solutions x (with revolution counts) of T(x) = t.
fn find_xy(lambda: f64, t: f64, max_revs: u32) -> Result<Vec<(f64, u32)>, LambertError> {
    let l2 = lambda * lambda;
    let l3 = l2 * lambda;
    let mut n_max = (t / PI).floor() as u32;
    let t00 = fmath::acos(lambda) + lambda * f64::sqrt(1.0 - l2);
    let t0 = t00 + f64::from(n_max) * PI;
    let t1 = 2.0 / 3.0 * (1.0 - l3);
    if n_max > 0 && t < t0 {
        // Is t below the minimum time for n_max revolutions? (Halley search for T_min.)
        let mut x_old = 0.0;
        let mut t_min = t0;
        for _ in 0..30 {
            let (dt, ddt, dddt) = dtdx(x_old, t_min, lambda);
            if dt == 0.0 {
                break;
            }
            let x_new = x_old - dt * ddt / (ddt * ddt - dt * dddt * 0.5);
            let err = (x_old - x_new).abs();
            t_min = x2tof(x_new, n_max, lambda);
            x_old = x_new;
            if err < 1e-13 {
                break;
            }
        }
        if t_min > t {
            n_max -= 1;
        }
    }
    let n_max = n_max.min(max_revs);

    let mut out = Vec::with_capacity(1 + 2 * n_max as usize);
    // Zero revolutions: initial guess (Izzo eq. 30).
    let x0 = if t >= t00 {
        -(t - t00) / (t - t00 + 4.0)
    } else if t <= t1 {
        t1 * (t1 - t) / (0.4 * (1.0 - l2 * l3) * t) + 1.0
    } else {
        fmath::pow(t / t00, core::f64::consts::LN_2 / fmath::ln(t1 / t00)) - 1.0
    };
    out.push((householder(t, x0, 0, lambda)?, 0));
    for n in 1..=n_max {
        let nf = f64::from(n);
        // Left and right branches (Izzo eq. 31).
        let a = fmath::pow((nf * PI + PI) / (8.0 * t), 2.0 / 3.0);
        let xl = householder(t, (a - 1.0) / (a + 1.0), n, lambda)?;
        let b = fmath::pow(8.0 * t / (nf * PI), 2.0 / 3.0);
        let xr = householder(t, (b - 1.0) / (b + 1.0), n, lambda)?;
        out.push((xl, n));
        out.push((xr, n));
    }
    Ok(out)
}

fn householder(t: f64, mut x0: f64, n: u32, lambda: f64) -> Result<f64, LambertError> {
    for _ in 0..50 {
        let tof = x2tof(x0, n, lambda);
        let (dt, ddt, dddt) = dtdx(x0, tof, lambda);
        let delta = tof - t;
        let dt2 = dt * dt;
        let x_new = x0
            - delta * (dt2 - delta * ddt * 0.5)
                / (dt * (dt2 - delta * ddt) + dddt * delta * delta / 6.0);
        let err = (x0 - x_new).abs();
        x0 = x_new;
        if !x0.is_finite() {
            return Err(LambertError::NoConvergence);
        }
        if err < 1e-13 {
            return Ok(x0);
        }
    }
    Err(LambertError::NoConvergence)
}

/// dT/dx and higher derivatives (Izzo eq. 22).
fn dtdx(x: f64, t: f64, lambda: f64) -> (f64, f64, f64) {
    let l2 = lambda * lambda;
    let l3 = l2 * lambda;
    let umx2 = 1.0 - x * x;
    let y = f64::sqrt(1.0 - l2 * umx2);
    let y2 = y * y;
    let y3 = y2 * y;
    let dt = 1.0 / umx2 * (3.0 * t * x - 2.0 + 2.0 * l3 * x / y);
    let ddt = 1.0 / umx2 * (3.0 * t + 5.0 * x * dt + 2.0 * (1.0 - l2) * l3 / y3);
    let dddt = 1.0 / umx2 * (7.0 * x * ddt + 8.0 * dt - 6.0 * (1.0 - l2) * l2 * l3 * x / (y3 * y2));
    (dt, ddt, dddt)
}

/// Non-dimensional time of flight T(x) for n revolutions.
fn x2tof(x: f64, n: u32, lambda: f64) -> f64 {
    let battin = 0.01;
    let lagrange = 0.2;
    let dist = (x - 1.0).abs();
    if dist < lagrange && dist > battin {
        return x2tof_lagrange(x, n, lambda);
    }
    let k = lambda * lambda;
    let e = x * x - 1.0;
    let rho = e.abs();
    let z = f64::sqrt(1.0 + k * e);
    if dist < battin {
        let eta = z - lambda * x;
        let s1 = 0.5 * (1.0 - lambda - x * eta);
        let q = hypergeometric_f(s1, 1e-11) * 4.0 / 3.0;
        (eta * eta * eta * q + 4.0 * lambda * eta) * 0.5
            + f64::from(n) * PI / (rho * f64::sqrt(rho))
    } else {
        let y = f64::sqrt(rho);
        let g = x * z - lambda * e;
        let d = if e < 0.0 {
            f64::from(n) * PI + fmath::acos(g.clamp(-1.0, 1.0))
        } else {
            let f = y * (z - lambda * x);
            fmath::ln(f + g)
        };
        (x - lambda * z - d / y) / e
    }
}

fn x2tof_lagrange(x: f64, n: u32, lambda: f64) -> f64 {
    let a = 1.0 / (1.0 - x * x);
    if a > 0.0 {
        let alfa = 2.0 * fmath::acos(x);
        let mut beta = 2.0 * fmath::asin(f64::sqrt(lambda * lambda / a));
        if lambda < 0.0 {
            beta = -beta;
        }
        a * f64::sqrt(a)
            * ((alfa - fmath::sin(alfa)) - (beta - fmath::sin(beta)) + 2.0 * PI * f64::from(n))
            * 0.5
    } else {
        let alfa = 2.0 * fmath::acosh(x);
        let mut beta = 2.0 * fmath::asinh(f64::sqrt(-lambda * lambda / a));
        if lambda < 0.0 {
            beta = -beta;
        }
        -a * f64::sqrt(-a) * ((beta - fmath::sinh(beta)) - (alfa - fmath::sinh(alfa))) * 0.5
    }
}

/// Gauss hypergeometric ₂F₁(3, 1; 5/2; z) by its series (Izzo eq. 19).
fn hypergeometric_f(z: f64, tol: f64) -> f64 {
    let mut sj = 1.0;
    let mut cj = 1.0;
    let mut j = 0.0;
    loop {
        let cj1 = cj * (3.0 + j) * (1.0 + j) / (2.5 + j) * z / (j + 1.0);
        sj += cj1;
        cj = cj1;
        j += 1.0;
        if cj1.abs() <= tol || j > 1000.0 {
            return sj;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kepler;

    #[test]
    fn vallado_example_7_5() {
        // Vallado, *Fundamentals of Astrodynamics and Applications*, 4th ed., Example 7-5:
        // r1 = 15945.34 î km, r2 = 12214.83899 î + 10249.46731 ĵ km, Δt = 76 min,
        // μ = 398600.4418 km³/s²; v1 = (2.058913, 2.915965, 0) km/s,
        // v2 = (−3.451565, 0.910315, 0) km/s.
        let km = 1000.0;
        let r1 = V3::new(15945.34 * km, 0.0, 0.0);
        let r2 = V3::new(12214.83899 * km, 10249.46731 * km, 0.0);
        let s = solve(
            r1,
            r2,
            76.0 * 60.0,
            3.986_004_418e14,
            V3::new(0.0, 0.0, 1.0),
            0,
        )
        .unwrap();
        let v1 = s[0].v1 * (1.0 / km);
        let v2 = s[0].v2 * (1.0 / km);
        assert!(
            v1.max_abs_diff(V3::new(2.058913, 2.915965, 0.0)) < 2e-6,
            "{v1:?}"
        );
        assert!(
            v2.max_abs_diff(V3::new(-3.451565, 0.910315, 0.0)) < 2e-6,
            "{v2:?}"
        );
    }

    /// Every solution, propagated with the universal-variable Kepler solver, must arrive.
    #[test]
    fn solutions_reach_the_target_including_multi_rev_and_hyperbolic() {
        let mu = 3.986004418e14;
        let cases = [
            (
                V3::new(7.0e6, 0.0, 0.0),
                V3::new(-3.0e6, 9.0e6, 1.0e6),
                4_000.0,
            ),
            (
                V3::new(7.0e6, 1.0e6, 0.0),
                V3::new(2.0e6, 8.0e6, -2.0e6),
                900.0,
            ), // hyperbolic
            (
                V3::new(8.0e6, 0.0, 1.0e6),
                V3::new(0.0, -9.0e6, 0.0),
                40_000.0,
            ), // multi-rev
            (
                V3::new(4.2e7, 0.0, 0.0),
                V3::new(-3.0e7, -2.0e7, 5.0e6),
                60_000.0,
            ),
        ];
        for (r1, r2, tof) in cases {
            let sols = solve(r1, r2, tof, mu, V3::new(0.0, 0.0, 1.0), 3).unwrap();
            assert!(!sols.is_empty());
            for s in sols {
                let (rf, vf) = kepler::propagate(r1, s.v1, mu, tof).unwrap();
                assert!(
                    (rf - r2).norm() < 1e-6 * r2.norm(),
                    "revs {} miss {} m",
                    s.revs,
                    (rf - r2).norm()
                );
                assert!((vf - s.v2).norm() < 1e-6 * s.v2.norm());
                // Prograde with respect to the reference normal.
                assert!(r1.cross(s.v1).z >= 0.0);
            }
        }
    }
}
