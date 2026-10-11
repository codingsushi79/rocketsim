//! Chebyshev series: evaluation (value + derivative) and interpolation fits.
//!
//! The same representation JPL uses for DE ephemerides (Newhall 1989,
//! "Numerical representation of planetary ephemerides", Celest. Mech. 45:305).
//! Evaluation uses the forward three-term recurrence, which is stable on
//! [−1, 1] and is plain arithmetic, so it is deterministic.

use crate::math::fmath;
use core::f64::consts::PI;

/// Value and d/dτ of Σ c_k T_k(τ) for τ in [−1, 1].
#[inline]
pub fn eval_with_derivative(c: &[f64], tau: f64) -> (f64, f64) {
    match c.len() {
        0 => (0.0, 0.0),
        1 => (c[0], 0.0),
        _ => {
            // T_k and T'_k by forward recurrence:
            //   T_{k+1} = 2τ T_k − T_{k−1},  T'_{k+1} = 2 T_k + 2τ T'_k − T'_{k−1}.
            let (mut t_prev, mut t) = (1.0, tau);
            let (mut d_prev, mut d) = (0.0, 1.0);
            let mut value = c[0] + c[1] * tau;
            let mut deriv = c[1];
            for &ck in &c[2..] {
                let t_next = 2.0 * tau * t - t_prev;
                let d_next = 2.0 * t + 2.0 * tau * d - d_prev;
                value += ck * t_next;
                deriv += ck * d_next;
                t_prev = t;
                t = t_next;
                d_prev = d;
                d = d_next;
            }
            (value, deriv)
        }
    }
}

/// Chebyshev–Gauss nodes τ_j = cos(π (j + ½) / n), j = 0..n.
pub fn nodes(n: usize) -> Vec<f64> {
    (0..n)
        .map(|j| fmath::cos(PI * (j as f64 + 0.5) / n as f64))
        .collect()
}

/// Interpolating coefficients of degree `n − 1` from samples at [`nodes`]`(n)`:
/// c_k = (2/n) Σ_j f(τ_j) T_k(τ_j), with c_0 halved (Press et al., *Numerical
/// Recipes*, 3rd ed., §5.8).
pub fn fit_from_node_samples(samples: &[f64]) -> Vec<f64> {
    let n = samples.len();
    let mut c = vec![0.0; n];
    for (k, ck) in c.iter_mut().enumerate() {
        let mut s = 0.0;
        for (j, &f) in samples.iter().enumerate() {
            s += f * fmath::cos(PI * k as f64 * (j as f64 + 0.5) / n as f64);
        }
        *ck = 2.0 * s / n as f64;
    }
    if let Some(c0) = c.first_mut() {
        *c0 *= 0.5;
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reproduces_polynomials_exactly() {
        // f(τ) = 3 − 2τ + 5τ³ has an exact degree-3 Chebyshev representation.
        let f = |t: f64| 3.0 - 2.0 * t + 5.0 * t * t * t;
        let df = |t: f64| -2.0 + 15.0 * t * t;
        let samples: Vec<f64> = nodes(6).into_iter().map(f).collect();
        let c = fit_from_node_samples(&samples);
        for i in 0..=20 {
            let t = -1.0 + 0.1 * i as f64;
            let (v, d) = eval_with_derivative(&c, t);
            assert!((v - f(t)).abs() < 1e-13, "{t}");
            assert!((d - df(t)).abs() < 1e-12, "{t}");
        }
        assert!(c[4].abs() < 1e-14 && c[5].abs() < 1e-14);
    }

    #[test]
    fn converges_geometrically_for_smooth_functions() {
        // sin(3τ): coefficients decay like Bessel J_k(3), so degree 20 gives ~1e-15.
        let samples: Vec<f64> = nodes(21).into_iter().map(|t| fmath::sin(3.0 * t)).collect();
        let c = fit_from_node_samples(&samples);
        let mut worst: f64 = 0.0;
        for i in 0..=200 {
            let t = -1.0 + 0.01 * i as f64;
            let (v, d) = eval_with_derivative(&c, t);
            worst = worst.max((v - fmath::sin(3.0 * t)).abs());
            assert!((d - 3.0 * fmath::cos(3.0 * t)).abs() < 1e-12);
        }
        assert!(worst < 1e-14, "{worst}");
    }
}
