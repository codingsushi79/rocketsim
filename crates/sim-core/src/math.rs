//! f64 linear algebra and deterministic scalar math.
//!
//! Everything here is plain f64. Frame semantics live in [`crate::frames`]; these
//! types are the untyped building blocks underneath.

use core::ops::{Add, AddAssign, Mul, Neg, Sub, SubAssign};

/// Deterministic scalar math (decision D8).
///
/// Every transcendental function goes through the pure-Rust `libm` crate, so native
/// and WASM builds produce bit-identical results. `sqrt`, `floor`, `abs` and the
/// basic arithmetic operators are correctly rounded by IEEE 754 on every target,
/// so they use the std implementations.
pub mod fmath {
    #[inline]
    pub fn sin(x: f64) -> f64 {
        libm::sin(x)
    }
    #[inline]
    pub fn cos(x: f64) -> f64 {
        libm::cos(x)
    }
    #[inline]
    pub fn sin_cos(x: f64) -> (f64, f64) {
        libm::sincos(x)
    }
    #[inline]
    pub fn tan(x: f64) -> f64 {
        libm::tan(x)
    }
    #[inline]
    pub fn asin(x: f64) -> f64 {
        libm::asin(x)
    }
    #[inline]
    pub fn acos(x: f64) -> f64 {
        libm::acos(x)
    }
    #[inline]
    pub fn atan(x: f64) -> f64 {
        libm::atan(x)
    }
    #[inline]
    pub fn atan2(y: f64, x: f64) -> f64 {
        libm::atan2(y, x)
    }
    #[inline]
    pub fn exp(x: f64) -> f64 {
        libm::exp(x)
    }
    #[inline]
    pub fn ln(x: f64) -> f64 {
        libm::log(x)
    }
    #[inline]
    pub fn pow(x: f64, y: f64) -> f64 {
        libm::pow(x, y)
    }
    #[inline]
    pub fn cbrt(x: f64) -> f64 {
        libm::cbrt(x)
    }
    #[inline]
    pub fn hypot(x: f64, y: f64) -> f64 {
        libm::hypot(x, y)
    }
    #[inline]
    pub fn sinh(x: f64) -> f64 {
        libm::sinh(x)
    }
    #[inline]
    pub fn cosh(x: f64) -> f64 {
        libm::cosh(x)
    }
    #[inline]
    pub fn asinh(x: f64) -> f64 {
        libm::asinh(x)
    }
    #[inline]
    pub fn acosh(x: f64) -> f64 {
        libm::acosh(x)
    }
    #[inline]
    pub fn atanh(x: f64) -> f64 {
        libm::atanh(x)
    }
}

/// Untyped 3-vector of f64.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct V3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl V3 {
    pub const ZERO: V3 = V3::new(0.0, 0.0, 0.0);
    pub const X: V3 = V3::new(1.0, 0.0, 0.0);
    pub const Y: V3 = V3::new(0.0, 1.0, 0.0);
    pub const Z: V3 = V3::new(0.0, 0.0, 1.0);

    #[inline]
    pub const fn new(x: f64, y: f64, z: f64) -> V3 {
        V3 { x, y, z }
    }
    #[inline]
    pub fn dot(self, o: V3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    #[inline]
    pub fn cross(self, o: V3) -> V3 {
        V3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    #[inline]
    pub fn norm_squared(self) -> f64 {
        self.dot(self)
    }
    #[inline]
    pub fn norm(self) -> f64 {
        self.norm_squared().sqrt()
    }
    /// Unit vector, or `None` for the zero vector (or one with a non-finite norm).
    #[inline]
    pub fn normalized(self) -> Option<V3> {
        let n = self.norm();
        if n > 0.0 && n.is_finite() {
            Some(self * (1.0 / n))
        } else {
            None
        }
    }
    #[inline]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }
    #[inline]
    pub fn max_abs_diff(self, o: V3) -> f64 {
        let d = self - o;
        d.x.abs().max(d.y.abs()).max(d.z.abs())
    }
}

impl Add for V3 {
    type Output = V3;
    #[inline]
    fn add(self, o: V3) -> V3 {
        V3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl Sub for V3 {
    type Output = V3;
    #[inline]
    fn sub(self, o: V3) -> V3 {
        V3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl AddAssign for V3 {
    #[inline]
    fn add_assign(&mut self, o: V3) {
        *self = *self + o;
    }
}
impl SubAssign for V3 {
    #[inline]
    fn sub_assign(&mut self, o: V3) {
        *self = *self - o;
    }
}
impl Neg for V3 {
    type Output = V3;
    #[inline]
    fn neg(self) -> V3 {
        V3::new(-self.x, -self.y, -self.z)
    }
}
impl Mul<f64> for V3 {
    type Output = V3;
    #[inline]
    fn mul(self, s: f64) -> V3 {
        V3::new(self.x * s, self.y * s, self.z * s)
    }
}
impl Mul<V3> for f64 {
    type Output = V3;
    #[inline]
    fn mul(self, v: V3) -> V3 {
        v * self
    }
}

/// Row-major 3x3 matrix of f64.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct M3 {
    pub rows: [V3; 3],
}

impl M3 {
    pub const IDENTITY: M3 = M3::from_rows(V3::X, V3::Y, V3::Z);

    #[inline]
    pub const fn from_rows(r0: V3, r1: V3, r2: V3) -> M3 {
        M3 { rows: [r0, r1, r2] }
    }
    #[inline]
    pub fn transpose(&self) -> M3 {
        let [a, b, c] = self.rows;
        M3::from_rows(
            V3::new(a.x, b.x, c.x),
            V3::new(a.y, b.y, c.y),
            V3::new(a.z, b.z, c.z),
        )
    }
    #[inline]
    pub fn mul_v3(&self, v: V3) -> V3 {
        V3::new(
            self.rows[0].dot(v),
            self.rows[1].dot(v),
            self.rows[2].dot(v),
        )
    }
    #[inline]
    pub fn mul_m3(&self, o: &M3) -> M3 {
        let t = o.transpose();
        let row = |r: V3| V3::new(r.dot(t.rows[0]), r.dot(t.rows[1]), r.dot(t.rows[2]));
        M3::from_rows(row(self.rows[0]), row(self.rows[1]), row(self.rows[2]))
    }

    /// Frame (passive) rotation about the x axis by `angle` radians.
    ///
    /// This is the R1(θ) of Vallado, *Fundamentals of Astrodynamics and Applications*,
    /// 4th ed., §3.3 (eq. 3-15): it gives a vector's components in axes rotated
    /// by +θ about x. The IAU body-orientation formula is written with these.
    pub fn r1(angle: f64) -> M3 {
        let (s, c) = fmath::sin_cos(angle);
        M3::from_rows(V3::X, V3::new(0.0, c, s), V3::new(0.0, -s, c))
    }
    /// Frame (passive) rotation about the y axis (Vallado R2).
    pub fn r2(angle: f64) -> M3 {
        let (s, c) = fmath::sin_cos(angle);
        M3::from_rows(V3::new(c, 0.0, -s), V3::Y, V3::new(s, 0.0, c))
    }
    /// Frame (passive) rotation about the z axis (Vallado R3).
    pub fn r3(angle: f64) -> M3 {
        let (s, c) = fmath::sin_cos(angle);
        M3::from_rows(V3::new(c, s, 0.0), V3::new(-s, c, 0.0), V3::Z)
    }
}

/// Unit quaternion, Hamilton convention, scalar first: q = w + xi + yj + zk.
///
/// Attitude convention used throughout the sim: `q_a_to_b` rotates vectors
/// expressed in frame A into frame B: v_B = q v_A q*.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub w: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Quat {
    pub const IDENTITY: Quat = Quat {
        w: 1.0,
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };

    #[inline]
    pub const fn new(w: f64, x: f64, y: f64, z: f64) -> Quat {
        Quat { w, x, y, z }
    }
    /// Active rotation by `angle` radians about `axis` (right-hand rule).
    /// Returns `None` if `axis` is zero.
    pub fn from_axis_angle(axis: V3, angle: f64) -> Option<Quat> {
        let u = axis.normalized()?;
        let (s, c) = fmath::sin_cos(0.5 * angle);
        Some(Quat::new(c, u.x * s, u.y * s, u.z * s))
    }
    #[inline]
    pub fn conj(self) -> Quat {
        Quat::new(self.w, -self.x, -self.y, -self.z)
    }
    #[inline]
    pub fn norm(self) -> f64 {
        (self.w * self.w + self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }
    /// Renormalize. Integrators call this after every attitude step.
    pub fn normalized(self) -> Option<Quat> {
        let n = self.norm();
        if n > 0.0 && n.is_finite() {
            let k = 1.0 / n;
            Some(Quat::new(self.w * k, self.x * k, self.y * k, self.z * k))
        } else {
            None
        }
    }
    /// Rotate a vector: q v q*. Uses the expanded form
    /// v' = v + 2w(u×v) + 2u×(u×v), where u = (x, y, z).
    pub fn rotate(self, v: V3) -> V3 {
        let u = V3::new(self.x, self.y, self.z);
        let t = u.cross(v) * 2.0;
        v + t * self.w + u.cross(t)
    }
    /// Equivalent rotation matrix: `to_m3().mul_v3(v) == rotate(v)`.
    pub fn to_m3(self) -> M3 {
        let Quat { w, x, y, z } = self;
        M3::from_rows(
            V3::new(
                1.0 - 2.0 * (y * y + z * z),
                2.0 * (x * y - w * z),
                2.0 * (x * z + w * y),
            ),
            V3::new(
                2.0 * (x * y + w * z),
                1.0 - 2.0 * (x * x + z * z),
                2.0 * (y * z - w * x),
            ),
            V3::new(
                2.0 * (x * z - w * y),
                2.0 * (y * z + w * x),
                1.0 - 2.0 * (x * x + y * y),
            ),
        )
    }
}

impl Quat {
    /// Quaternion of a proper rotation matrix (`to_m3` inverse), by Shepperd's method
    /// (J. Guidance and Control 1(3):223, 1978): pick the largest of 4w², 4x², 4y², 4z²
    /// to divide by, for accuracy at any angle.
    pub fn from_m3(m: &M3) -> Quat {
        let [r0, r1, r2] = m.rows;
        let (m00, m11, m22) = (r0.x, r1.y, r2.z);
        let tr = m00 + m11 + m22;
        let q = if tr >= m00 && tr >= m11 && tr >= m22 {
            let s = (1.0 + tr).sqrt() * 2.0;
            Quat::new(
                0.25 * s,
                (r2.y - r1.z) / s,
                (r0.z - r2.x) / s,
                (r1.x - r0.y) / s,
            )
        } else if m00 >= m11 && m00 >= m22 {
            let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0;
            Quat::new(
                (r2.y - r1.z) / s,
                0.25 * s,
                (r0.y + r1.x) / s,
                (r0.z + r2.x) / s,
            )
        } else if m11 >= m22 {
            let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0;
            Quat::new(
                (r0.z - r2.x) / s,
                (r0.y + r1.x) / s,
                0.25 * s,
                (r1.z + r2.y) / s,
            )
        } else {
            let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0;
            Quat::new(
                (r1.x - r0.y) / s,
                (r0.z + r2.x) / s,
                (r1.z + r2.y) / s,
                0.25 * s,
            )
        };
        q.normalized().unwrap_or(Quat::IDENTITY)
    }
}

impl Mul for Quat {
    type Output = Quat;
    /// Hamilton product. `(a * b).rotate(v) == a.rotate(b.rotate(v))`.
    fn mul(self, b: Quat) -> Quat {
        let a = self;
        Quat::new(
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
            a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f64::consts::FRAC_PI_2;

    #[test]
    fn passive_r3_rotates_axes_not_vectors() {
        // Axes rotated +90° about z: the old x axis has components (0, -1, 0).
        let v = M3::r3(FRAC_PI_2).mul_v3(V3::X);
        assert!(v.max_abs_diff(V3::new(0.0, -1.0, 0.0)) < 1e-15);
    }

    #[test]
    fn rotation_matrices_are_orthonormal() {
        for m in [M3::r1(0.3), M3::r2(-1.1), M3::r3(2.7)] {
            let p = m.mul_m3(&m.transpose());
            for i in 0..3 {
                assert!(p.rows[i].max_abs_diff(M3::IDENTITY.rows[i]) < 1e-15);
            }
        }
    }

    #[test]
    fn quaternion_rotates_x_to_y_about_z() {
        let q = Quat::from_axis_angle(V3::Z, FRAC_PI_2).unwrap();
        assert!(q.rotate(V3::X).max_abs_diff(V3::Y) < 1e-15);
        assert!(q.to_m3().mul_v3(V3::X).max_abs_diff(V3::Y) < 1e-15);
    }

    #[test]
    fn quaternion_product_composes_rotations() {
        let a = Quat::from_axis_angle(V3::new(1.0, 2.0, 3.0), 0.7).unwrap();
        let b = Quat::from_axis_angle(V3::new(-2.0, 0.5, 1.0), -1.3).unwrap();
        let v = V3::new(0.3, -4.0, 2.2);
        assert!((a * b).rotate(v).max_abs_diff(a.rotate(b.rotate(v))) < 1e-14);
        assert!(a.conj().rotate(a.rotate(v)).max_abs_diff(v) < 1e-14);
    }

    #[test]
    fn quaternion_from_matrix_round_trips_at_all_angles() {
        for (axis, ang) in [
            (V3::new(0.2, -0.9, 0.4), 2.1),
            (V3::X, 3.1),
            (V3::Y, -3.1),
            (V3::Z, core::f64::consts::PI - 1e-5), // w ≈ 0 branch
            (V3::new(1.0, 1.0, 1.0), 0.001),
        ] {
            let q = Quat::from_axis_angle(axis, ang).unwrap();
            let r = Quat::from_m3(&q.to_m3());
            let v = V3::new(5.0, 1.0, -3.0);
            assert!(r.rotate(v).max_abs_diff(q.rotate(v)) < 1e-13);
        }
    }

    #[test]
    fn quaternion_matrix_matches_rotate() {
        let q = Quat::from_axis_angle(V3::new(0.2, -0.9, 0.4), 2.1).unwrap();
        let v = V3::new(5.0, 1.0, -3.0);
        assert!(q.to_m3().mul_v3(v).max_abs_diff(q.rotate(v)) < 1e-14);
    }
}
