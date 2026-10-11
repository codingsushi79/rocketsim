//! Spherical-harmonic gravity fields.
//!
//! Acceleration from the Cunningham recursion of Montenbruck & Gill, *Satellite
//! Orbits* (2000), §3.2.4–3.2.5, eqs. 3.29–3.33, with unnormalized coefficients
//! converted from the fully normalized published ones. This representation is
//! exact in f64 up to degree and order 70: (n+m)! and the V/W recursion stay within
//! range, so models are capped there.
//!
//! Positions are body-fixed (the caller rotates with [`crate::frames::BodyOrientation`]).

use crate::bodies::BodyId;
use crate::constants::{gm, gravity_fields as gf};
use crate::math::V3;

include!(concat!(env!("OUT_DIR"), "/egm2008.rs"));

/// Highest degree supported by the unnormalized recursion.
pub const MAX_DEGREE: usize = 70;

#[derive(Clone, Debug, PartialEq)]
pub struct ShField {
    pub body: BodyId,
    pub gm: f64,
    pub radius: f64,
    pub n_max: usize,
    /// Unnormalized C and S, index n(n+1)/2 + m.
    c: Vec<f64>,
    s: Vec<f64>,
}

#[inline]
fn idx(n: usize, m: usize) -> usize {
    n * (n + 1) / 2 + m
}

/// Normalization factor N_nm = sqrt((2 − δ₀ₘ)(2n+1)(n−m)!/(n+m)!), so C = N·C̄.
pub fn normalization(n: usize, m: usize) -> f64 {
    let mut ratio = 1.0; // (n−m)!/(n+m)!
    for k in (n - m + 1)..=(n + m) {
        ratio /= k as f64;
    }
    let delta = if m == 0 { 1.0 } else { 2.0 };
    (delta * (2 * n + 1) as f64 * ratio).sqrt()
}

impl ShField {
    /// From fully normalized coefficients (index n(n+1)/2 + m), truncated to `n_max`.
    pub fn from_normalized(
        body: BodyId,
        gm: f64,
        radius: f64,
        n_max: usize,
        cbar: &[f64],
        sbar: &[f64],
    ) -> ShField {
        assert!(n_max <= MAX_DEGREE, "degree {n_max} > {MAX_DEGREE}");
        let len = idx(n_max, n_max) + 1;
        let mut c = vec![0.0; len];
        let mut s = vec![0.0; len];
        for n in 0..=n_max {
            for m in 0..=n {
                let k = normalization(n, m);
                c[idx(n, m)] = cbar[idx(n, m)] * k;
                s[idx(n, m)] = sbar[idx(n, m)] * k;
            }
        }
        ShField {
            body,
            gm,
            radius,
            n_max,
            c,
            s,
        }
    }

    /// Point mass plus an unnormalized zonal J₂.
    pub fn j2(body: BodyId, gm: f64, radius: f64, j2: f64) -> ShField {
        let mut c = vec![0.0; idx(2, 2) + 1];
        c[0] = 1.0;
        c[idx(2, 0)] = -j2;
        ShField {
            body,
            gm,
            radius,
            n_max: 2,
            c,
            s: vec![0.0; idx(2, 2) + 1],
        }
    }

    /// Unnormalized J_n = −C_n0.
    pub fn jn(&self, n: usize) -> f64 {
        if n <= self.n_max {
            -self.c[idx(n, 0)]
        } else {
            0.0
        }
    }

    /// Acceleration (m/s²) at body-fixed position `r` (m), including the central
    /// term, using degrees ≤ `degree` and orders ≤ `order`.
    pub fn acceleration(&self, r: V3, degree: usize, order: usize) -> V3 {
        let n_max = degree.min(self.n_max);
        let m_max = order.min(n_max);
        let nn = n_max + 1; // the recursion needs one degree more
        let w = nn + 1;
        let at = |n: usize, m: usize| n * w + m;
        let mut v = vec![0.0; w * w];
        let mut wv = vec![0.0; w * w];
        let r2 = r.norm_squared();
        let re = self.radius;
        let (x0, y0, z0) = (re * r.x / r2, re * r.y / r2, re * r.z / r2);
        let rho = re * re / r2;

        // Zonal (m = 0) terms.
        v[at(0, 0)] = re / r2.sqrt();
        v[at(1, 0)] = z0 * v[at(0, 0)];
        for n in 2..=nn {
            let nf = n as f64;
            v[at(n, 0)] =
                ((2.0 * nf - 1.0) * z0 * v[at(n - 1, 0)] - (nf - 1.0) * rho * v[at(n - 2, 0)]) / nf;
        }
        // Tesseral and sectorial terms.
        for m in 1..=(m_max + 1).min(nn) {
            let mf = m as f64;
            let (vp, wp) = (v[at(m - 1, m - 1)], wv[at(m - 1, m - 1)]);
            v[at(m, m)] = (2.0 * mf - 1.0) * (x0 * vp - y0 * wp);
            wv[at(m, m)] = (2.0 * mf - 1.0) * (x0 * wp + y0 * vp);
            if m < nn {
                v[at(m + 1, m)] = (2.0 * mf + 1.0) * z0 * v[at(m, m)];
                wv[at(m + 1, m)] = (2.0 * mf + 1.0) * z0 * wv[at(m, m)];
            }
            for n in (m + 2)..=nn {
                let nf = n as f64;
                let a = (2.0 * nf - 1.0) / (nf - mf);
                let b = (nf + mf - 1.0) / (nf - mf);
                v[at(n, m)] = a * z0 * v[at(n - 1, m)] - b * rho * v[at(n - 2, m)];
                wv[at(n, m)] = a * z0 * wv[at(n - 1, m)] - b * rho * wv[at(n - 2, m)];
            }
        }

        // Accelerations (M&G eq. 3.33), smallest terms (highest degree) first.
        let (mut ax, mut ay, mut az) = (0.0, 0.0, 0.0);
        for n in (0..=n_max).rev() {
            for m in (0..=n.min(m_max)).rev() {
                let (c, s) = (self.c[idx(n, m)], self.s[idx(n, m)]);
                if c == 0.0 && s == 0.0 {
                    continue;
                }
                if m == 0 {
                    ax -= c * v[at(n + 1, 1)];
                    ay -= c * wv[at(n + 1, 1)];
                } else {
                    // (n−m+2)!/(n−m)! = (n−m+1)(n−m+2)
                    let fac = ((n - m + 1) * (n - m + 2)) as f64;
                    ax += 0.5
                        * (-c * v[at(n + 1, m + 1)] - s * wv[at(n + 1, m + 1)]
                            + fac * (c * v[at(n + 1, m - 1)] + s * wv[at(n + 1, m - 1)]));
                    ay += 0.5
                        * (-c * wv[at(n + 1, m + 1)]
                            + s * v[at(n + 1, m + 1)]
                            + fac * (-c * wv[at(n + 1, m - 1)] + s * v[at(n + 1, m - 1)]));
                }
                az += (n - m + 1) as f64 * (-c * v[at(n + 1, m)] - s * wv[at(n + 1, m)]);
            }
        }
        V3::new(ax, ay, az) * (self.gm / (re * re))
    }
}

/// EGM2008 truncated to `degree` (≤ 70), with the zero-tide C̄₂₀.
///
/// GM is DE440's Earth GM, the TDB-compatible value consistent with the ephemeris and
/// the sim's TDB clock. EGM2008's own 3.986004415e14 is TT-compatible: they differ by
/// the factor 1 − L_B, with L_B = 1.550519768e-8 (IAU 2006 Res. B3).
pub fn earth_egm2008(degree: usize) -> ShField {
    let mut cbar = EGM2008_C.to_vec();
    cbar[idx(2, 0)] += gf::EARTH_C20_PERMANENT_TIDE;
    let _ = (EGM2008_GM, EGM2008_N_MAX);
    ShField::from_normalized(
        BodyId::EARTH,
        gm::EARTH,
        EGM2008_RADIUS,
        degree.min(MAX_DEGREE),
        &cbar,
        &EGM2008_S,
    )
}

/// The gravity field used for a body, or `None` if it is modelled as a point mass.
/// `earth_degree` selects the EGM2008 truncation.
pub fn body_field(body: BodyId, earth_degree: usize) -> Option<ShField> {
    let sqrt5 = 5.0f64.sqrt();
    Some(match body {
        BodyId::EARTH => earth_egm2008(earth_degree),
        BodyId::MOON => ShField::j2(
            body,
            gm::MOON,
            gf::MOON_RADIUS,
            -gf::MOON_C20_NORMALIZED * sqrt5,
        ),
        BodyId::MARS => ShField::j2(
            body,
            gm::MARS,
            gf::MARS_RADIUS,
            -gf::MARS_C20_NORMALIZED * sqrt5,
        ),
        BodyId::JUPITER => ShField::j2(body, gm::JUPITER, gf::JUPITER_RADIUS, gf::JUPITER_J2),
        BodyId::SATURN => ShField::j2(body, gm::SATURN, gf::SATURN_RADIUS, gf::SATURN_J2),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn j2_matches_closed_form() {
        // a = −μr/r³ − (3/2) J₂ μ R²/r⁵ [x(1 − 5z²/r²), y(1 − 5z²/r²), z(3 − 5z²/r²)]
        // (Vallado eq. 8-30).
        let f = ShField::j2(BodyId::EARTH, gm::EARTH, 6_378_136.3, 1.082_63e-3);
        for r in [
            V3::new(7.0e6, 1.0e6, 2.0e6),
            V3::new(-3.0e6, 2.0e6, -6.5e6),
            V3::new(0.0, 0.0, 7.2e6),
        ] {
            let rn = r.norm();
            let k = -1.5 * 1.082_63e-3 * gm::EARTH * 6_378_136.3 * 6_378_136.3
                / (rn * rn * rn * rn * rn);
            let q = 5.0 * r.z * r.z / (rn * rn);
            let expected = r * (-gm::EARTH / (rn * rn * rn))
                + V3::new(
                    k * r.x * (1.0 - q),
                    k * r.y * (1.0 - q),
                    k * r.z * (3.0 - q),
                );
            let got = f.acceleration(r, 2, 0);
            assert!(
                (got - expected).norm() < 1e-14 * expected.norm(),
                "{got:?} vs {expected:?}"
            );
        }
    }

    #[test]
    fn egm2008_j2_value() {
        // Tide-free C̄₂₀ = −0.484165143790815e-3 (EGM2008 file); the permanent tide adds
        // A₀H₀k₂₀ = −4.20072e-9 → zero-tide J₂ = −√5 C̄₂₀ ≈ 1.0826356e-3.
        let f = earth_egm2008(2);
        let expected = 5.0f64.sqrt() * (0.484_165_143_790_815e-3 - 4.4228e-8 * -0.31460 * 0.30190);
        assert!(
            (f.jn(2) - expected).abs() < 1e-15,
            "{} vs {expected}",
            f.jn(2)
        );
        assert!((f.jn(2) - 1.082_635_6e-3).abs() < 1e-10);
    }

    #[test]
    fn normalization_known_values() {
        // N₂₀ = √5, N₂₂ = √(5/12)·... : (2)(5)(0!)/(4!) = 10/24 → √(5/12)
        assert!((normalization(2, 0) - 5.0f64.sqrt()).abs() < 1e-15);
        assert!((normalization(2, 2) - (5.0f64 / 12.0).sqrt()).abs() < 1e-15);
        assert!(normalization(70, 70).is_finite() && normalization(70, 70) > 0.0);
    }

    #[test]
    fn surface_gravity_is_earthlike() {
        let f = earth_egm2008(70);
        let g = f
            .acceleration(V3::new(6_378_137.0, 0.0, 0.0), 70, 70)
            .norm();
        // Equatorial gravitational (not gravity) acceleration ≈ 9.81–9.82 m/s².
        assert!((9.79..9.84).contains(&g), "{g}");
    }
}
