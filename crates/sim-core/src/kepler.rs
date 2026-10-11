//! Two-body analytics: classical orbital elements, universal-variable Kepler
//! propagation, Hohmann transfers and J2 secular rates.
//!
//! These are reference solutions for tests, readouts and planning first guesses.
//! The "truth" trajectory is always the numerical propagator.
//!
//! References:
//! - [V] D. A. Vallado, *Fundamentals of Astrodynamics and Applications*, 4th ed.
//!   (2013): Alg. 9 (RV2COE), Alg. 10 (COE2RV), Alg. 8 (KEPLER), §6.3 (Hohmann),
//!   §9.6 (J2 secular rates).
//! - [C] H. D. Curtis, *Orbital Mechanics for Engineering Students*, 3rd ed. (2014):
//!   §3.7 (universal variables), Alg. 4.2.

use crate::math::{V3, fmath};
use core::f64::consts::{PI, TAU};

/// Classical orbital elements. Angles in rad, lengths in m.
///
/// Special cases follow Vallado Alg. 9. Circular orbits put the argument of latitude
/// in `nu` with `argp = 0`. Equatorial orbits put the longitude of periapsis in
/// `argp` with `raan = 0`. Circular equatorial orbits put the true longitude in `nu`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Elements {
    /// Semi-latus rectum p = h²/μ (defined for every conic, including parabolas).
    pub p: f64,
    /// Semi-major axis (infinite for parabolic, negative for hyperbolic orbits).
    pub a: f64,
    pub e: f64,
    pub i: f64,
    pub raan: f64,
    pub argp: f64,
    pub nu: f64,
}

/// Below this, e and i count as zero for the special-case conventions.
const SMALL: f64 = 1e-11;

fn wrap_2pi(x: f64) -> f64 {
    let r = x % TAU;
    if r < 0.0 { r + TAU } else { r }
}

fn angle(a: V3, b: V3) -> f64 {
    // atan2 form: accurate near 0 and π.
    fmath::atan2(a.cross(b).norm(), a.dot(b))
}

impl Elements {
    /// Orbital elements from position and velocity relative to the central body ([V] Alg. 9).
    pub fn from_state(r: V3, v: V3, mu: f64) -> Elements {
        let rm = r.norm();
        let h = r.cross(v);
        let hm = h.norm();
        let n = V3::Z.cross(h);
        let nm = n.norm();
        let e_vec = (r * (v.norm_squared() - mu / rm) - v * r.dot(v)) * (1.0 / mu);
        let e = e_vec.norm();
        let energy = v.norm_squared() / 2.0 - mu / rm;
        let p = hm * hm / mu;
        let a = if (e - 1.0).abs() > SMALL {
            -mu / (2.0 * energy)
        } else {
            f64::INFINITY
        };
        let i = fmath::acos((h.z / hm).clamp(-1.0, 1.0));
        let equatorial = i < SMALL || (PI - i) < SMALL;
        let circular = e < SMALL;

        let mut raan = 0.0;
        let mut argp = 0.0;
        let nu;
        if !equatorial {
            raan = fmath::atan2(n.y, n.x);
        }
        match (circular, equatorial) {
            (false, false) => {
                argp = angle(n, e_vec);
                if e_vec.z < 0.0 {
                    argp = TAU - argp;
                }
                nu = signed_true_anomaly(e_vec, r, h);
            }
            (true, false) => {
                // Argument of latitude.
                let mut u = angle(n, r);
                if r.z < 0.0 {
                    u = TAU - u;
                }
                nu = u;
            }
            (false, true) => {
                // True longitude of periapsis.
                let mut w = fmath::atan2(e_vec.y, e_vec.x);
                if h.z < 0.0 {
                    w = -w;
                }
                argp = w;
                nu = signed_true_anomaly(e_vec, r, h);
            }
            (true, true) => {
                // True longitude.
                let mut l = fmath::atan2(r.y, r.x);
                if h.z < 0.0 {
                    l = -l;
                }
                nu = l;
            }
        }
        let _ = nm;
        Elements {
            p,
            a,
            e,
            i,
            raan: wrap_2pi(raan),
            argp: wrap_2pi(argp),
            nu: wrap_2pi(nu),
        }
    }

    /// Position and velocity from elements ([V] Alg. 10), using the same special-case
    /// conventions as [`Elements::from_state`].
    pub fn to_state(&self, mu: f64) -> (V3, V3) {
        let (sn, cn) = fmath::sin_cos(self.nu);
        let denom = 1.0 + self.e * cn;
        let r_pqw = V3::new(self.p * cn / denom, self.p * sn / denom, 0.0);
        let k = (mu / self.p).sqrt();
        let v_pqw = V3::new(-k * sn, k * (self.e + cn), 0.0);
        // PQW → IJK = R3(−Ω) R1(−i) R3(−ω) (active rotation).
        let rot = crate::math::M3::r3(-self.raan)
            .mul_m3(&crate::math::M3::r1(-self.i))
            .mul_m3(&crate::math::M3::r3(-self.argp));
        (rot.mul_v3(r_pqw), rot.mul_v3(v_pqw))
    }

    /// Orbital period, s (elliptic orbits only).
    pub fn period(&self, mu: f64) -> Option<f64> {
        (self.e < 1.0 && self.a > 0.0).then(|| TAU * (self.a * self.a * self.a / mu).sqrt())
    }

    pub fn periapsis(&self) -> f64 {
        self.p / (1.0 + self.e)
    }

    /// Apoapsis radius (`None` for open orbits).
    pub fn apoapsis(&self) -> Option<f64> {
        (self.e < 1.0).then(|| self.p / (1.0 - self.e))
    }
}

fn signed_true_anomaly(e_vec: V3, r: V3, h: V3) -> f64 {
    let nu = angle(e_vec, r);
    // Sign from the orbit normal: positive when moving away from periapsis.
    if e_vec.cross(r).dot(h) < 0.0 {
        TAU - nu
    } else {
        nu
    }
}

/// Stumpff functions C(z), S(z) ([C] §3.7, eqs. 3.52–3.53). A series is used near
/// z = 0 to avoid cancellation.
pub fn stumpff(z: f64) -> (f64, f64) {
    if z.abs() < 0.5 {
        // C = Σ (−z)^k / (2k+2)!,  S = Σ (−z)^k / (2k+3)!
        let (mut c, mut s) = (0.0, 0.0);
        let mut term_c = 0.5; // 1/2!
        let mut term_s = 1.0 / 6.0; // 1/3!
        for k in 0..12 {
            c += term_c;
            s += term_s;
            let k2 = 2.0 * f64::from(k);
            term_c *= -z / ((k2 + 3.0) * (k2 + 4.0));
            term_s *= -z / ((k2 + 4.0) * (k2 + 5.0));
        }
        (c, s)
    } else if z > 0.0 {
        let sz = z.sqrt();
        (
            (1.0 - fmath::cos(sz)) / z,
            (sz - fmath::sin(sz)) / (sz * sz * sz),
        )
    } else {
        let sz = (-z).sqrt();
        (
            (fmath::cosh(sz) - 1.0) / (-z),
            (fmath::sinh(sz) - sz) / (sz * sz * sz),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum KeplerError {
    /// Newton iteration on the universal anomaly did not converge.
    NoConvergence,
}

/// Two-body propagation by universal variables ([C] Alg. 3.4 with [V] Alg. 8 initial
/// guesses). Works for elliptic, parabolic and hyperbolic orbits and either time
/// direction. Returns (r, v) after `dt` seconds.
pub fn propagate(r0: V3, v0: V3, mu: f64, dt: f64) -> Result<(V3, V3), KeplerError> {
    if dt == 0.0 {
        return Ok((r0, v0));
    }
    let sqmu = mu.sqrt();
    let r0m = r0.norm();
    let vr0 = r0.dot(v0) / r0m;
    let alpha = 2.0 / r0m - v0.norm_squared() / mu; // 1/a
    // Initial guess for the universal anomaly χ (√m).
    let mut chi = if alpha > 1e-12 / r0m {
        // Ellipse: χ ≈ √μ α Δt
        sqmu * dt * alpha
    } else if alpha < -1e-12 / r0m {
        // Hyperbola: Vallado Alg. 8 guess.
        let a = 1.0 / alpha;
        let sign = dt.signum();
        let arg =
            (-2.0 * mu * alpha * dt) / (r0.dot(v0) + sign * (-mu * a).sqrt() * (1.0 - r0m * alpha));
        sign * (-a).sqrt() * fmath::ln(arg.abs().max(1e-300))
    } else {
        // Parabola: Barker's equation via p.
        let h = r0.cross(v0).norm();
        let p = h * h / mu;
        let s = 0.5 * fmath::atan(1.0 / (3.0 * (mu / (p * p * p)).sqrt() * dt));
        let w = fmath::atan(fmath::cbrt(fmath::tan(s)));
        p.sqrt() * 2.0 / fmath::tan(2.0 * w)
    };
    let mut converged = false;
    for _ in 0..200 {
        let z = alpha * chi * chi;
        let (c, s) = stumpff(z);
        let f = r0m * vr0 / sqmu * chi * chi * c
            + (1.0 - alpha * r0m) * chi * chi * chi * s
            + r0m * chi
            - sqmu * dt;
        let fp = r0m * vr0 / sqmu * chi * (1.0 - z * s) + (1.0 - alpha * r0m) * chi * chi * c + r0m;
        let step = f / fp;
        chi -= step;
        if step.abs() <= 1e-13 * chi.abs().max(1.0) {
            converged = true;
            break;
        }
    }
    if !converged {
        return Err(KeplerError::NoConvergence);
    }
    let z = alpha * chi * chi;
    let (c, s) = stumpff(z);
    let f = 1.0 - chi * chi / r0m * c;
    let g = dt - chi * chi * chi * s / sqmu;
    let r = r0 * f + v0 * g;
    let rm = r.norm();
    let fdot = sqmu / (rm * r0m) * (alpha * chi * chi * chi * s - chi);
    let gdot = 1.0 - chi * chi / rm * c;
    Ok((r, r0 * fdot + v0 * gdot))
}

/// Hohmann transfer between coplanar circular orbits of radius r1 and r2 ([V] §6.3).
/// Returns (Δv at departure, Δv at arrival, time of flight), m/s and s.
pub fn hohmann(mu: f64, r1: f64, r2: f64) -> (f64, f64, f64) {
    let a = 0.5 * (r1 + r2);
    let dv1 = ((2.0 * mu / r1 - mu / a).sqrt() - (mu / r1).sqrt()).abs();
    let dv2 = ((mu / r2).sqrt() - (2.0 * mu / r2 - mu / a).sqrt()).abs();
    (dv1, dv2, PI * (a * a * a / mu).sqrt())
}

/// Secular J2 rates of the node and periapsis, rad/s ([V] eqs. 9-41, 9-42).
/// `r_ref` is the reference radius of the J2 coefficient.
pub fn j2_secular_rates(mu: f64, j2: f64, r_ref: f64, a: f64, e: f64, i: f64) -> (f64, f64) {
    let n = (mu / (a * a * a)).sqrt();
    let p = a * (1.0 - e * e);
    let k = n * j2 * (r_ref / p) * (r_ref / p);
    let ci = fmath::cos(i);
    (-1.5 * k * ci, 0.75 * k * (5.0 * ci * ci - 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MU_KM: f64 = 398_600.0; // km³/s², as used in Curtis' examples
    const KM: f64 = 1e3;

    #[test]
    fn curtis_example_4_3_elements() {
        // Curtis, Example 4.3: r = (−6045, −3490, 2500) km, v = (−3.457, 6.618, 2.533) km/s.
        // Published: h = 58,310 km²/s, i = 153.2°, Ω = 255.3°, e = 0.1712, ω = 20.07°, θ = 28.45°.
        let mu = MU_KM * 1e9;
        let el = Elements::from_state(
            V3::new(-6045.0, -3490.0, 2500.0) * KM,
            V3::new(-3.457, 6.618, 2.533) * KM,
            mu,
        );
        let h = (el.p * mu).sqrt() / 1e6; // km²/s
        assert!((h - 58_310.0).abs() < 5.0, "{h}");
        assert!((el.i.to_degrees() - 153.2).abs() < 0.05);
        assert!((el.raan.to_degrees() - 255.3).abs() < 0.05);
        assert!((el.e - 0.1712).abs() < 5e-5);
        assert!((el.argp.to_degrees() - 20.07).abs() < 0.01);
        assert!((el.nu.to_degrees() - 28.45).abs() < 0.01);
    }

    #[test]
    fn vallado_example_2_5_elements() {
        // Vallado, Example 2-5: r = (6524.834, 6862.875, 6448.296) km,
        // v = (4.901327, 5.533756, −1.976341) km/s, μ = 398600.4418 km³/s².
        // Published: p = 11,067.790 km, a = 36,127.343 km, e = 0.832853,
        // i = 87.870°, Ω = 227.898°, ω = 53.38°, ν = 92.335°.
        let mu = 398_600.441_8e9;
        let el = Elements::from_state(
            V3::new(6524.834, 6862.875, 6448.296) * KM,
            V3::new(4.901327, 5.533756, -1.976341) * KM,
            mu,
        );
        assert!((el.p / KM - 11_067.790).abs() < 0.01, "{}", el.p / KM);
        assert!((el.a / KM - 36_127.343).abs() < 0.02, "{}", el.a / KM);
        assert!((el.e - 0.832853).abs() < 1e-6);
        assert!((el.i.to_degrees() - 87.870).abs() < 1e-3);
        assert!((el.raan.to_degrees() - 227.898).abs() < 1e-3);
        assert!((el.argp.to_degrees() - 53.38).abs() < 0.005);
        assert!((el.nu.to_degrees() - 92.335).abs() < 1e-3);
    }

    #[test]
    fn elements_roundtrip_all_regimes() {
        let mu = 3.986_004_418e14;
        for (a, e, i) in [
            (7.0e6, 0.001, 0.9),
            (2.6e7, 0.7, 1.1),
            (-1.2e7, 1.8, 2.5),
            (4.2e7, 0.3, 0.2),
        ] {
            let p = a * (1.0 - e * e);
            let el = Elements {
                p,
                a,
                e,
                i,
                raan: 1.2,
                argp: 4.0,
                nu: 0.5,
            };
            let (r, v) = el.to_state(mu);
            let back = Elements::from_state(r, v, mu);
            assert!((back.p - p).abs() / p < 1e-12);
            assert!((back.e - e).abs() < 1e-12);
            assert!((back.i - i).abs() < 1e-12);
            assert!(
                (back.raan - 1.2).abs() < 1e-10
                    && (back.argp - 4.0).abs() < 1e-10
                    && (back.nu - 0.5).abs() < 1e-10
            );
        }
    }

    #[test]
    fn universal_variables_conserve_energy_and_momentum() {
        // Initial conditions of Curtis Example 3.7 (r0 = 10,000 km, v0 = 10 km/s,
        // vr0 = 3.0752 km/s), propagated 1 h.
        let mu = MU_KM * 1e9;
        let r0 = V3::new(10_000.0, 0.0, 0.0) * KM;
        let vt = (10.0f64 * 10.0 - 3.0752 * 3.0752).sqrt();
        let v0 = V3::new(3.0752, vt, 0.0) * KM;
        let (r, v) = propagate(r0, v0, mu, 3600.0).unwrap();
        let e0 = v0.norm_squared() / 2.0 - mu / r0.norm();
        let e1 = v.norm_squared() / 2.0 - mu / r.norm();
        assert!(((e1 - e0) / e0).abs() < 1e-12);
        assert!((r.cross(v) - r0.cross(v0)).norm() / r0.cross(v0).norm() < 1e-12);
    }

    #[test]
    fn vallado_example_2_4_kepler() {
        // Vallado, Example 2-4: r0 = (1131.340, −2282.343, 6672.423) km,
        // v0 = (−5.64305, 4.30333, 2.42879) km/s, Δt = 40 min.
        // Published: r = (−4219.7527, 4363.0292, −3958.7666) km,
        // v = (3.689866, −1.916735, −6.112511) km/s.
        let (r, v) = propagate(
            V3::new(1131.340, -2282.343, 6672.423) * KM,
            V3::new(-5.64305, 4.30333, 2.42879) * KM,
            398_600.441_8e9,
            40.0 * 60.0,
        )
        .unwrap();
        assert!(
            r.max_abs_diff(V3::new(-4219.7527, 4363.0292, -3958.7666) * KM) < 1.0,
            "{:?}",
            r * 1e-3
        );
        assert!(
            v.max_abs_diff(V3::new(3.689866, -1.916735, -6.112511) * KM) < 1e-3,
            "{:?}",
            v * 1e-3
        );
    }

    #[test]
    fn propagate_forward_and_back_all_conics() {
        let mu = 3.986_004_418e14;
        let r0 = V3::new(7.0e6, 1.0e5, -2.0e5);
        for speed in [7_000.0, 9_500.0, (2.0 * mu / r0.norm()).sqrt(), 14_000.0] {
            let v0 = V3::new(100.0, speed, 900.0);
            for dt in [600.0, 7_200.0, 86_400.0] {
                let (r, v) = propagate(r0, v0, mu, dt).unwrap();
                let (rb, vb) = propagate(r, v, mu, -dt).unwrap();
                assert!(
                    rb.max_abs_diff(r0) < 1e-3,
                    "speed {speed} dt {dt}: {:?}",
                    rb - r0
                );
                assert!(vb.max_abs_diff(v0) < 1e-6);
            }
        }
    }

    #[test]
    fn vallado_example_6_1_hohmann() {
        // Vallado, Example 6-1: 191.34411 km altitude to GEO (35,781.34857 km),
        // R⊕ = 6378.137 km, μ = 398600.4418 km³/s². Published Δv = 3.935224 km/s,
        // τ = 5.256713 h.
        let mu = 398_600.441_8e9;
        let (dv1, dv2, tof) = hohmann(
            mu,
            (6378.137 + 191.344_11) * KM,
            (6378.137 + 35_781.348_57) * KM,
        );
        assert!(
            ((dv1 + dv2) / KM - 3.935224).abs() < 2e-6,
            "{}",
            (dv1 + dv2) / KM
        );
        assert!((tof / 3600.0 - 5.256713).abs() < 2e-6, "{}", tof / 3600.0);
    }

    #[test]
    fn stumpff_series_matches_closed_form_at_switch() {
        for z in [0.49999, -0.49999, 0.5, -0.5] {
            let (c, s) = stumpff(z);
            let (cc, sc) = if z > 0.0 {
                let q = z.sqrt();
                ((1.0 - fmath::cos(q)) / z, (q - fmath::sin(q)) / (q * q * q))
            } else {
                let q = (-z).sqrt();
                (
                    (fmath::cosh(q) - 1.0) / (-z),
                    (fmath::sinh(q) - q) / (q * q * q),
                )
            };
            assert!((c - cc).abs() < 1e-15 && (s - sc).abs() < 1e-15, "{z}");
        }
    }
}
