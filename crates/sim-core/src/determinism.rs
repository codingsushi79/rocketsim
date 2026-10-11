//! Determinism canary (decision D8).
//!
//! [`canary`] runs a fixed workload through every libm function the core uses,
//! plus the time and frame code, and hashes the exact bit patterns. CI computes
//! it natively and in WASM (Node) and requires the two to match. The golden value
//! in the test catches unintended numeric changes, e.g. from a libm upgrade.
//! Update it deliberately and note the reason in the commit.

use crate::bodies::BodyId;
use crate::frames::{
    BodyOrientation, IcrfBody, LvlhBasis, State, icrf_body_to_body_fixed, icrf_body_to_lvlh,
};
use crate::math::{Quat, V3, fmath};
use crate::time::{Epoch, UtcDateTime, tdb_to_utc, utc_to_tdb};

/// FNV-1a, 64-bit.
struct Fnv(u64);

impl Fnv {
    fn new() -> Fnv {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn f64(&mut self, x: f64) {
        for b in x.to_bits().to_le_bytes() {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn v3(&mut self, v: V3) {
        self.f64(v.x);
        self.f64(v.y);
        self.f64(v.z);
    }
}

pub fn canary() -> u64 {
    let mut h = Fnv::new();
    for i in 0..20_000 {
        let x = f64::from(i) * 0.013_7 - 137.0;
        let (s, c) = fmath::sin_cos(x);
        h.f64(s);
        h.f64(c);
        h.f64(fmath::tan(x * 0.01));
        h.f64(fmath::atan2(x, 3.7));
        h.f64(fmath::asin(s));
        h.f64(fmath::acos(c));
        h.f64(fmath::atan(x));
        h.f64(fmath::exp(x * 0.01));
        h.f64(fmath::ln(x.abs() + 1.0));
        h.f64(fmath::pow(x.abs() + 0.5, 1.37));
        h.f64(fmath::cbrt(x));
        h.f64(fmath::hypot(x, s));
        h.f64(fmath::sinh(x * 0.01));
        h.f64(fmath::cosh(x * 0.01));
        h.f64(fmath::asinh(x));
        h.f64(fmath::acosh(x.abs() + 1.0));
        h.f64(fmath::atanh(s * 0.99));
        h.f64((x.abs() + 1.0).sqrt());
    }

    let start = UtcDateTime::new(2026, 11, 1, 0, 0, 0.0);
    let mut e = utc_to_tdb(&start).expect("valid epoch");
    let reference = State::new(
        V3::new(6_778_137.0, 1.0, -3.0),
        V3::new(0.5, 4_771.0, 6_015.0),
        IcrfBody {
            center: BodyId::EARTH,
        },
    );
    let mut q = Quat::IDENTITY;
    let dq = Quat::from_axis_angle(V3::new(0.3, -0.2, 0.9), 0.01).expect("nonzero axis");
    for k in 0..2_000 {
        e = e.add_seconds(37.25);
        let (sec, frac) = e.tdb_parts();
        h.f64(sec as f64);
        h.f64(frac);
        let w = 0.1 + f64::from(k) * 1e-3;
        let o = BodyOrientation::from_iau_angles(BodyId::EARTH, 0.1, 1.5, w, 7.29e-5);
        let bf = icrf_body_to_body_fixed(&reference, &o).expect("same center");
        h.v3(bf.r);
        h.v3(bf.v);
        let other = State::new(
            reference.r + V3::new(f64::from(k), 2.0, 3.0),
            reference.v,
            reference.frame,
        );
        let l = icrf_body_to_lvlh(&other, &LvlhBasis::from_reference(&reference).expect("ok"))
            .expect("ok");
        h.v3(l.r);
        h.v3(l.v);
        q = (q * dq).normalized().expect("unit");
        h.v3(q.rotate(V3::new(1.0, 2.0, 3.0)));
    }
    // Ephemeris evaluation, IAU rotation models, precise Earth orientation.
    let mut coefs = Vec::new();
    for k in 0..3 * 18 {
        coefs.push(crate::ephemeris::quantize(
            1.0e8 / f64::from(k + 1) * fmath::cos(f64::from(k)),
            1e-3,
        ));
    }
    let mut eph = crate::ephemeris::Ephemeris::new();
    eph.insert(crate::ephemeris::Chunk {
        target: BodyId::MOON,
        center: BodyId::EARTH,
        start: 0,
        seg_len: 345_600,
        n_seg: 1,
        n_coef: 18,
        quantum: 1e-3,
        coefs,
    })
    .expect("valid chunk");
    eph.insert(crate::ephemeris::Chunk {
        target: BodyId::EARTH,
        center: BodyId::SSB,
        start: 0,
        seg_len: 345_600,
        n_seg: 1,
        n_coef: 1,
        quantum: 1.0,
        coefs: vec![1.5e11, -2.0e10, 7.0e9],
    })
    .expect("valid chunk");
    for k in 0..200 {
        let t = Epoch::from_tdb_seconds(f64::from(k) * 1_728.0 + 0.123);
        let s = eph.state_ssb(BodyId::MOON, t).expect("covered");
        h.v3(s.r);
        h.v3(s.v);
        for body in crate::orientation::iau_bodies() {
            let o = crate::orientation::iau_body_orientation(body, t.add_seconds(3.0e8))
                .expect("model");
            h.v3(o.icrf_to_bf.rows[0]);
            h.v3(o.omega_bf);
        }
        let (o, _) = crate::earth::earth_orientation(t.add_seconds(8.0e8));
        h.v3(o.icrf_to_bf.rows[0]);
        h.v3(o.icrf_to_bf.rows[2]);
    }
    let u = tdb_to_utc(e).expect("in table range");
    h.f64(u.second);
    h.f64(Epoch::J2000.add_seconds(-1.5).tdb_parts().1);
    h.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canary_is_stable_within_a_run() {
        assert_eq!(canary(), canary());
    }

    #[test]
    fn canary_matches_golden() {
        // Update deliberately (see module docs). Printed by `simctl canary`.
        assert_eq!(format!("{:016x}", canary()), GOLDEN);
    }

    const GOLDEN: &str = "75fbc3bb150b774d";
}
