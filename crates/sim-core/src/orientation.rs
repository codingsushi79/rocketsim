//! Body orientation from the IAU WGCCRE 2015 rotation models (Archinal et al. 2018).
//!
//! The coefficients are generated at build time from `data/pck/pck00011.tpc`, and
//! evaluation follows SPICE's PCK conventions:
//! - α₀ = a₀ + a₁T + a₂T² + Σ aⱼ sin θⱼ
//! - δ₀ = d₀ + d₁T + d₂T² + Σ dⱼ cos θⱼ
//! - W = w₀ + w₁d + w₂d² + Σ wⱼ sin θⱼ
//!
//! T is TDB Julian centuries and d is TDB days past J2000. The nutation-precession
//! angles θⱼ are polynomials in T taken from the system barycenter
//! (`BODYn_NUT_PREC_ANGLES`, degree `BODYn_MAX_PHASE_DEGREE`). Units are degrees.
//!
//! Earth has a precise model in [`crate::earth`]. Its IAU model is kept for reference
//! and testing only.

use crate::bodies::BodyId;
use crate::constants::{DAYS_PER_JULIAN_CENTURY, SECONDS_PER_DAY};
use crate::frames::{BodyOrientation, IauAngles};
use crate::math::fmath;
use crate::time::Epoch;

pub(crate) struct IauModel {
    id: i32,
    /// Pole RA: deg, deg/century, deg/century².
    ra: [f64; 3],
    /// Pole declination: deg, deg/century, deg/century².
    dec: [f64; 3],
    /// Prime meridian: deg, deg/day, deg/day².
    pm: [f64; 3],
    nut_ra: &'static [f64],
    nut_dec: &'static [f64],
    nut_pm: &'static [f64],
    /// Angle polynomials, `angle_terms` coefficients each: deg, deg/century, ...
    angles: &'static [f64],
    angle_terms: usize,
}

include!(concat!(env!("OUT_DIR"), "/iau_models.rs"));

/// The IAU rotation model's pole, prime meridian and their rates at `t`, or `None`
/// for bodies without a model.
pub fn iau_angles(body: BodyId, t: Epoch) -> Option<IauAngles> {
    let m = IAU_MODELS.iter().find(|m| m.id == body.0)?;
    let d = t.tdb_seconds() / SECONDS_PER_DAY;
    let tc = d / DAYS_PER_JULIAN_CENTURY;
    // Angles in degrees; rates in degrees per century (pole) and per day (W).
    let mut ra = m.ra[0] + m.ra[1] * tc + m.ra[2] * tc * tc;
    let mut dec = m.dec[0] + m.dec[1] * tc + m.dec[2] * tc * tc;
    let mut ra_dot = m.ra[1] + 2.0 * m.ra[2] * tc;
    let mut dec_dot = m.dec[1] + 2.0 * m.dec[2] * tc;
    // Reduce the linear term modulo 360° first so fast rotators keep full precision.
    let mut w = (m.pm[1] * d) % 360.0 + m.pm[0] + m.pm[2] * d * d;
    let mut w_dot = m.pm[1] + 2.0 * m.pm[2] * d;
    for (j, poly) in m.angles.chunks_exact(m.angle_terms).enumerate() {
        // θ_j(T) in degrees and dθ_j/dT in degrees per century.
        let (mut theta, mut theta_dot, mut tp) = (0.0, 0.0, 1.0);
        for (k, &c) in poly.iter().enumerate() {
            theta += c * tp;
            if k + 1 < poly.len() {
                theta_dot += (k + 1) as f64 * poly[k + 1] * tp;
            }
            tp *= tc;
        }
        let (s, c) = fmath::sin_cos((theta % 360.0).to_radians());
        // d(sin θ)/dT = cos θ · θ̇ (θ̇ converted to rad per century).
        let theta_dot_rad = theta_dot.to_radians();
        if let Some(a) = m.nut_ra.get(j) {
            ra += a * s;
            ra_dot += a * c * theta_dot_rad;
        }
        if let Some(a) = m.nut_dec.get(j) {
            dec += a * c;
            dec_dot -= a * s * theta_dot_rad;
        }
        if let Some(a) = m.nut_pm.get(j) {
            w += a * s;
            w_dot += a * c * theta_dot_rad / DAYS_PER_JULIAN_CENTURY;
        }
    }
    let per_century = SECONDS_PER_DAY * DAYS_PER_JULIAN_CENTURY;
    Some(IauAngles {
        alpha0: ra.to_radians(),
        delta0: dec.to_radians(),
        w: (w % 360.0).to_radians(),
        alpha0_dot: ra_dot.to_radians() / per_century,
        delta0_dot: dec_dot.to_radians() / per_century,
        w_dot: w_dot.to_radians() / SECONDS_PER_DAY,
    })
}

/// Orientation of a body's IAU body-fixed frame at `t`, or `None` without a model.
pub fn iau_body_orientation(body: BodyId, t: Epoch) -> Option<BodyOrientation> {
    Some(BodyOrientation::from_iau(body, &iau_angles(body, t)?))
}

/// Bodies with an IAU rotation model.
pub fn iau_bodies() -> impl Iterator<Item = BodyId> {
    IAU_MODELS.iter().map(|m| BodyId(m.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bodies::BodyRegistry;

    #[test]
    fn every_v1_body_has_a_rotation_model() {
        for b in BodyRegistry::builtin().iter() {
            assert!(iau_angles(b.id, Epoch::J2000).is_some(), "{}", b.name);
        }
    }

    #[test]
    fn mars_rotation_rate_is_sidereal_day() {
        // WGCCRE 2015: W₁ = 350.891982443297 °/day, i.e. a 24.6229 h sidereal day.
        let a = iau_angles(BodyId::MARS, Epoch::J2000).unwrap();
        let period_h = core::f64::consts::TAU / a.w_dot / 3600.0;
        assert!((period_h - 24.6229).abs() < 1e-3, "{period_h}");
    }
}
