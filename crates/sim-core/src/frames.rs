//! Reference frames: frame-tagged vectors and states, plus named, tested
//! conversion functions.
//!
//! # Design
//! The frame *kind* is part of the type, so mixing frames is a compile error:
//!
//! ```compile_fail
//! use sim_core::frames::{VecIcrf, VecLvlh};
//! use sim_core::math::V3;
//! let a = VecIcrf::new(V3::X);
//! let b = VecLvlh::new(V3::X);
//! let _ = a + b; // error: ICRF axes and LVLH axes don't mix
//! ```
//!
//! The frame *center* (which body) is a runtime [`BodyId`] stored in the frame
//! value. The body list is data-driven (SPK asteroids can be loaded later), so
//! bodies can't be types. Conversions check the center and return
//! [`FrameError`] on a mismatch.
//!
//! Free vectors (directions, forces, torques) carry only [`Axes`]. Positions and
//! states carry a full [`Frame`] (axes + origin).
//!
//! Frames:
//! - [`IcrfSsb`]: ICRF axes, origin at the solar-system barycenter.
//! - [`IcrfBody`]: ICRF axes, origin at a body's center (body-centered inertial).
//! - [`BodyFixed`]: a body's rotating axes from the IAU WGCCRE rotation model
//!   (Earth uses IERS orientation from M2), origin at the body's center.
//! - [`Lvlh`]: local vertical / local horizontal of a reference orbit, NASA/CCSDS
//!   convention: +z = nadir (−r̂), +y = −ĥ (opposite the orbit normal),
//!   +x = y × z (≈ along velocity on a circular orbit).
//! - [`ScBody`]: spacecraft body axes. Attitude convention: `q_body_to_icrf`
//!   rotates body vectors into ICRF (Hamilton, scalar first).

use crate::bodies::BodyId;
use crate::math::{M3, Quat, V3};
use core::fmt::Debug;
use core::ops::{Add, Mul, Neg, Sub};

/// Coordinate axes (orientation only, no origin).
pub trait Axes: Copy + PartialEq + Debug {
    const NAME: &'static str;
}

/// A full reference frame: axes plus origin.
pub trait Frame: Copy + PartialEq + Debug {
    type Axes: Axes;
    const NAME: &'static str;
    fn axes(&self) -> Self::Axes;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IcrfAxes;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyFixedAxes {
    pub body: BodyId,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LvlhAxes;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScBodyAxes;

impl Axes for IcrfAxes {
    const NAME: &'static str = "ICRF";
}
impl Axes for BodyFixedAxes {
    const NAME: &'static str = "BodyFixed";
}
impl Axes for LvlhAxes {
    const NAME: &'static str = "LVLH";
}
impl Axes for ScBodyAxes {
    const NAME: &'static str = "ScBody";
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IcrfSsb;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IcrfBody {
    pub center: BodyId,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyFixed {
    pub body: BodyId,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lvlh;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScBody;

impl Frame for IcrfSsb {
    type Axes = IcrfAxes;
    const NAME: &'static str = "ICRF/SSB";
    fn axes(&self) -> IcrfAxes {
        IcrfAxes
    }
}
impl Frame for IcrfBody {
    type Axes = IcrfAxes;
    const NAME: &'static str = "ICRF/body-centered";
    fn axes(&self) -> IcrfAxes {
        IcrfAxes
    }
}
impl Frame for BodyFixed {
    type Axes = BodyFixedAxes;
    const NAME: &'static str = "body-fixed";
    fn axes(&self) -> BodyFixedAxes {
        BodyFixedAxes { body: self.body }
    }
}
impl Frame for Lvlh {
    type Axes = LvlhAxes;
    const NAME: &'static str = "LVLH";
    fn axes(&self) -> LvlhAxes {
        LvlhAxes
    }
}
impl Frame for ScBody {
    type Axes = ScBodyAxes;
    const NAME: &'static str = "spacecraft body";
    fn axes(&self) -> ScBodyAxes {
        ScBodyAxes
    }
}

/// Position in frame `F`, m.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pos<F: Frame> {
    pub r: V3,
    pub frame: F,
}

/// Velocity in frame `F` (the time derivative as seen *in that frame*), m/s.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vel<F: Frame> {
    pub v: V3,
    pub frame: F,
}

/// Position and velocity in frame `F`, m and m/s.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct State<F: Frame> {
    pub r: V3,
    pub v: V3,
    pub frame: F,
}

impl<F: Frame> State<F> {
    pub fn new(r: V3, v: V3, frame: F) -> State<F> {
        State { r, v, frame }
    }
    pub fn pos(&self) -> Pos<F> {
        Pos {
            r: self.r,
            frame: self.frame,
        }
    }
    pub fn vel(&self) -> Vel<F> {
        Vel {
            v: self.v,
            frame: self.frame,
        }
    }
}

/// Free vector (direction, force, torque, acceleration...) in axes `A`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vector<A: Axes> {
    pub v: V3,
    pub axes: A,
}

impl<A: Axes> Vector<A> {
    pub fn in_axes(v: V3, axes: A) -> Vector<A> {
        Vector { v, axes }
    }
    pub fn dot(self, o: Vector<A>) -> f64 {
        assert_eq!(self.axes, o.axes, "{} axes mismatch", A::NAME);
        self.v.dot(o.v)
    }
    pub fn cross(self, o: Vector<A>) -> Vector<A> {
        assert_eq!(self.axes, o.axes, "{} axes mismatch", A::NAME);
        Vector {
            v: self.v.cross(o.v),
            axes: self.axes,
        }
    }
    pub fn norm(self) -> f64 {
        self.v.norm()
    }
}

macro_rules! unit_axes_ctor {
    ($($axes:ident),*) => {$(
        impl Vector<$axes> {
            pub const fn new(v: V3) -> Vector<$axes> {
                Vector { v, axes: $axes }
            }
        }
    )*};
}
unit_axes_ctor!(IcrfAxes, LvlhAxes, ScBodyAxes);

impl<A: Axes> Add for Vector<A> {
    type Output = Vector<A>;
    fn add(self, o: Vector<A>) -> Vector<A> {
        assert_eq!(self.axes, o.axes, "{} axes mismatch", A::NAME);
        Vector {
            v: self.v + o.v,
            axes: self.axes,
        }
    }
}
impl<A: Axes> Sub for Vector<A> {
    type Output = Vector<A>;
    fn sub(self, o: Vector<A>) -> Vector<A> {
        assert_eq!(self.axes, o.axes, "{} axes mismatch", A::NAME);
        Vector {
            v: self.v - o.v,
            axes: self.axes,
        }
    }
}
impl<A: Axes> Neg for Vector<A> {
    type Output = Vector<A>;
    fn neg(self) -> Vector<A> {
        Vector {
            v: -self.v,
            axes: self.axes,
        }
    }
}
impl<A: Axes> Mul<f64> for Vector<A> {
    type Output = Vector<A>;
    fn mul(self, s: f64) -> Vector<A> {
        Vector {
            v: self.v * s,
            axes: self.axes,
        }
    }
}

pub type PosIcrfSsb = Pos<IcrfSsb>;
pub type VelIcrfSsb = Vel<IcrfSsb>;
pub type StateIcrfSsb = State<IcrfSsb>;
pub type PosIcrfBody = Pos<IcrfBody>;
pub type VelIcrfBody = Vel<IcrfBody>;
pub type StateIcrfBody = State<IcrfBody>;
pub type PosBodyFixed = Pos<BodyFixed>;
pub type VelBodyFixed = Vel<BodyFixed>;
pub type StateBodyFixed = State<BodyFixed>;
pub type PosLvlh = Pos<Lvlh>;
pub type VelLvlh = Vel<Lvlh>;
pub type StateLvlh = State<Lvlh>;
pub type PosScBody = Pos<ScBody>;
pub type VecIcrf = Vector<IcrfAxes>;
pub type VecBodyFixed = Vector<BodyFixedAxes>;
pub type VecLvlh = Vector<LvlhAxes>;
pub type VecScBody = Vector<ScBodyAxes>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FrameError {
    /// The state's center/body is not the one the transform is for.
    CenterMismatch { expected: BodyId, found: BodyId },
    /// The LVLH reference state has zero radius or zero angular momentum.
    DegenerateReference,
}

impl core::fmt::Display for FrameError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            FrameError::CenterMismatch { expected, found } => {
                write!(
                    f,
                    "frame center mismatch: expected body {}, found {}",
                    expected.0, found.0
                )
            }
            FrameError::DegenerateReference => {
                write!(f, "LVLH reference state is degenerate (r = 0 or r ∥ v)")
            }
        }
    }
}

impl std::error::Error for FrameError {}

fn check(expected: BodyId, found: BodyId) -> Result<(), FrameError> {
    if expected == found {
        Ok(())
    } else {
        Err(FrameError::CenterMismatch { expected, found })
    }
}

// ---------------------------------------------------------------------------
// ICRF barycentric <-> ICRF body-centered
// ---------------------------------------------------------------------------

/// A body's barycentric state, normally from the ephemeris.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BodyStateSsb {
    pub body: BodyId,
    pub state: StateIcrfSsb,
}

/// Body-centered inertial → barycentric. Same axes, so this is a translation of
/// position and velocity.
pub fn icrf_body_to_icrf_ssb(
    s: &StateIcrfBody,
    center: &BodyStateSsb,
) -> Result<StateIcrfSsb, FrameError> {
    check(center.body, s.frame.center)?;
    Ok(State::new(
        s.r + center.state.r,
        s.v + center.state.v,
        IcrfSsb,
    ))
}

/// Barycentric → body-centered inertial.
pub fn icrf_ssb_to_icrf_body(s: &StateIcrfSsb, center: &BodyStateSsb) -> StateIcrfBody {
    State::new(
        s.r - center.state.r,
        s.v - center.state.v,
        IcrfBody {
            center: center.body,
        },
    )
}

/// Change the integration center (e.g. at an SOI boundary).
///
/// Computes `s + (from − to)`. The body–body offset is formed first, so the
/// spacecraft's small relative vector is never added to an AU-scale barycentric
/// position, which would lose ~10 µm of precision per round-trip.
pub fn recenter_icrf_body(
    s: &StateIcrfBody,
    from: &BodyStateSsb,
    to: &BodyStateSsb,
) -> Result<StateIcrfBody, FrameError> {
    check(from.body, s.frame.center)?;
    let dr = from.state.r - to.state.r;
    let dv = from.state.v - to.state.v;
    Ok(State::new(s.r + dr, s.v + dv, IcrfBody { center: to.body }))
}

// ---------------------------------------------------------------------------
// ICRF body-centered <-> body-fixed rotating
// ---------------------------------------------------------------------------

/// A body's orientation at one instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BodyOrientation {
    pub body: BodyId,
    /// Rotation taking ICRF components to body-fixed components.
    pub icrf_to_bf: M3,
    /// Angular velocity of the body-fixed axes relative to ICRF, in body-fixed
    /// components, rad/s.
    pub omega_bf: V3,
}

impl BodyOrientation {
    /// From IAU WGCCRE angles (Archinal et al. 2018, §2 and Fig. 1).
    /// `alpha0` and `delta0` are the north pole's ICRF right ascension and
    /// declination; `w` is the prime meridian angle; `w_dot` is its rate. Units are
    /// rad and rad/s.
    ///
    /// R = R3(W) · R1(π/2 − δ₀) · R3(π/2 + α₀).
    ///
    /// Angular velocity is taken as Ẇ about the body's pole. The pole's own drift
    /// (α̇₀, δ̇₀ ≲ 1e-11 rad/s, versus Ẇ ~ 1e-5 to 1e-4) is neglected. That causes a
    /// velocity error below 1e-4 m/s at the surface of any v1 body.
    pub fn from_iau_angles(
        body: BodyId,
        alpha0: f64,
        delta0: f64,
        w: f64,
        w_dot: f64,
    ) -> BodyOrientation {
        use core::f64::consts::FRAC_PI_2;
        let icrf_to_bf = M3::r3(w)
            .mul_m3(&M3::r1(FRAC_PI_2 - delta0))
            .mul_m3(&M3::r3(FRAC_PI_2 + alpha0));
        BodyOrientation {
            body,
            icrf_to_bf,
            omega_bf: V3::new(0.0, 0.0, w_dot),
        }
    }
}

/// Body-centered inertial → body-fixed rotating.
/// r_bf = R r, v_bf = R v − ω × r_bf (transport theorem).
pub fn icrf_body_to_body_fixed(
    s: &StateIcrfBody,
    o: &BodyOrientation,
) -> Result<StateBodyFixed, FrameError> {
    check(o.body, s.frame.center)?;
    let r = o.icrf_to_bf.mul_v3(s.r);
    let v = o.icrf_to_bf.mul_v3(s.v) - o.omega_bf.cross(r);
    Ok(State::new(r, v, BodyFixed { body: o.body }))
}

/// Body-fixed rotating → body-centered inertial. r = Rᵀ r_bf, v = Rᵀ (v_bf + ω × r_bf).
pub fn body_fixed_to_icrf_body(
    s: &StateBodyFixed,
    o: &BodyOrientation,
) -> Result<StateIcrfBody, FrameError> {
    check(o.body, s.frame.body)?;
    let rt = o.icrf_to_bf.transpose();
    let r = rt.mul_v3(s.r);
    let v = rt.mul_v3(s.v + o.omega_bf.cross(s.r));
    Ok(State::new(r, v, IcrfBody { center: o.body }))
}

pub fn vec_icrf_to_body_fixed(v: &VecIcrf, o: &BodyOrientation) -> VecBodyFixed {
    Vector {
        v: o.icrf_to_bf.mul_v3(v.v),
        axes: BodyFixedAxes { body: o.body },
    }
}

pub fn vec_body_fixed_to_icrf(
    v: &VecBodyFixed,
    o: &BodyOrientation,
) -> Result<VecIcrf, FrameError> {
    check(o.body, v.axes.body)?;
    Ok(VecIcrf::new(o.icrf_to_bf.transpose().mul_v3(v.v)))
}

// ---------------------------------------------------------------------------
// ICRF body-centered <-> LVLH
// ---------------------------------------------------------------------------

/// LVLH frame of a reference orbit at one instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LvlhBasis {
    pub reference: StateIcrfBody,
    /// Rows are the LVLH x, y, z unit vectors in ICRF components.
    pub icrf_to_lvlh: M3,
    /// Angular velocity of the LVLH axes in ICRF components, rad/s: ω = (r × v) / |r|².
    /// This is exact for the in-plane rotation. The out-of-plane rate depends on
    /// any acceleration normal to the orbit plane and is zero for a central force.
    pub omega_icrf: V3,
}

impl LvlhBasis {
    pub fn from_reference(reference: &StateIcrfBody) -> Result<LvlhBasis, FrameError> {
        let r = reference.r;
        let h = r.cross(reference.v);
        let z = (-r).normalized().ok_or(FrameError::DegenerateReference)?;
        let y = (-h).normalized().ok_or(FrameError::DegenerateReference)?;
        let x = y.cross(z);
        Ok(LvlhBasis {
            reference: *reference,
            icrf_to_lvlh: M3::from_rows(x, y, z),
            omega_icrf: h * (1.0 / r.norm_squared()),
        })
    }
}

/// Body-centered inertial state → LVLH state relative to the reference. Both
/// must share a center. v_lvlh = M (Δv − ω × Δr).
pub fn icrf_body_to_lvlh(s: &StateIcrfBody, basis: &LvlhBasis) -> Result<StateLvlh, FrameError> {
    check(basis.reference.frame.center, s.frame.center)?;
    let dr = s.r - basis.reference.r;
    let dv = s.v - basis.reference.v;
    let m = &basis.icrf_to_lvlh;
    Ok(State::new(
        m.mul_v3(dr),
        m.mul_v3(dv - basis.omega_icrf.cross(dr)),
        Lvlh,
    ))
}

/// LVLH state → body-centered inertial state (centered on the reference's body).
pub fn lvlh_to_icrf_body(s: &StateLvlh, basis: &LvlhBasis) -> StateIcrfBody {
    let mt = basis.icrf_to_lvlh.transpose();
    let dr = mt.mul_v3(s.r);
    let dv = mt.mul_v3(s.v) + basis.omega_icrf.cross(dr);
    State::new(
        basis.reference.r + dr,
        basis.reference.v + dv,
        basis.reference.frame,
    )
}

pub fn vec_icrf_to_lvlh(v: &VecIcrf, basis: &LvlhBasis) -> VecLvlh {
    VecLvlh::new(basis.icrf_to_lvlh.mul_v3(v.v))
}

pub fn vec_lvlh_to_icrf(v: &VecLvlh, basis: &LvlhBasis) -> VecIcrf {
    VecIcrf::new(basis.icrf_to_lvlh.transpose().mul_v3(v.v))
}

// ---------------------------------------------------------------------------
// Spacecraft body <-> ICRF
// ---------------------------------------------------------------------------

/// Spacecraft attitude state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Attitude {
    /// Rotates body-frame vectors into ICRF: v_I = q v_B q*.
    pub q_body_to_icrf: Quat,
    /// Body angular velocity relative to ICRF, in body components, rad/s.
    pub omega_body: VecScBody,
}

pub fn vec_sc_body_to_icrf(v: &VecScBody, att: &Attitude) -> VecIcrf {
    VecIcrf::new(att.q_body_to_icrf.rotate(v.v))
}

pub fn vec_icrf_to_sc_body(v: &VecIcrf, att: &Attitude) -> VecScBody {
    VecScBody::new(att.q_body_to_icrf.conj().rotate(v.v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{ASTRONOMICAL_UNIT, gm};
    use crate::math::fmath;
    use core::f64::consts::{FRAC_PI_2, PI};

    const EARTH: BodyId = BodyId::EARTH;

    fn earth_ssb() -> BodyStateSsb {
        BodyStateSsb {
            body: EARTH,
            state: State::new(
                V3::new(
                    -0.18 * ASTRONOMICAL_UNIT,
                    0.89 * ASTRONOMICAL_UNIT,
                    0.39 * ASTRONOMICAL_UNIT,
                ),
                V3::new(-29_800.0, -3_000.0, -1_300.0),
                IcrfSsb,
            ),
        }
    }

    fn leo() -> StateIcrfBody {
        let r = 6_778_137.0;
        let v = (gm::EARTH / r).sqrt();
        let (s, c) = fmath::sin_cos(51.6_f64.to_radians());
        State::new(
            V3::new(r, 0.0, 0.0),
            V3::new(0.0, v * c, v * s),
            IcrfBody { center: EARTH },
        )
    }

    #[test]
    fn ssb_body_roundtrip() {
        let e = earth_ssb();
        let s = leo();
        let ssb = icrf_body_to_icrf_ssb(&s, &e).unwrap();
        let back = icrf_ssb_to_icrf_body(&ssb, &e);
        // At 1 AU the f64 ulp is ~3e-5 m. That loss is why the integrator works body-centered.
        assert!(back.r.max_abs_diff(s.r) < 1e-4);
        assert!(back.v.max_abs_diff(s.v) < 1e-11);
        assert_eq!(back.frame, s.frame);
    }

    #[test]
    fn center_mismatch_is_an_error() {
        let mut e = earth_ssb();
        e.body = BodyId::MOON;
        assert_eq!(
            icrf_body_to_icrf_ssb(&leo(), &e),
            Err(FrameError::CenterMismatch {
                expected: BodyId::MOON,
                found: EARTH
            })
        );
    }

    #[test]
    fn recenter_matches_via_ssb_and_is_exact_at_the_new_center() {
        let e = earth_ssb();
        let moon = BodyStateSsb {
            body: BodyId::MOON,
            state: State::new(
                e.state.r + V3::new(3.0e8, 2.0e8, 1.0e8),
                e.state.v + V3::new(-500.0, 800.0, 100.0),
                IcrfSsb,
            ),
        };
        let s = leo();
        let direct = recenter_icrf_body(&s, &e, &moon).unwrap();
        let via = icrf_ssb_to_icrf_body(&icrf_body_to_icrf_ssb(&s, &e).unwrap(), &moon);
        assert!(direct.r.max_abs_diff(via.r) < 1e-4);
        assert_eq!(direct.frame.center, BodyId::MOON);
        // A state at the Moon's center, given relative to Earth, is zero relative to the Moon.
        let at_moon = State::new(
            moon.state.r - e.state.r,
            moon.state.v - e.state.v,
            IcrfBody { center: EARTH },
        );
        let rel = recenter_icrf_body(&at_moon, &e, &moon).unwrap();
        assert!(rel.r.norm() < 1e-4 && rel.v.norm() < 1e-11);
    }

    fn some_orientation(w: f64) -> BodyOrientation {
        // Mars-like pole, Earth-like rotation rate.
        BodyOrientation::from_iau_angles(
            EARTH,
            317.68_f64.to_radians(),
            52.89_f64.to_radians(),
            w,
            7.292_115e-5,
        )
    }

    #[test]
    fn iau_pole_and_prime_meridian_geometry() {
        let (a0, d0, w) = (317.68_f64.to_radians(), 52.89_f64.to_radians(), 1.234);
        let o = some_orientation(w);
        let bf_to_icrf = o.icrf_to_bf.transpose();
        let pole = V3::new(
            fmath::cos(d0) * fmath::cos(a0),
            fmath::cos(d0) * fmath::sin(a0),
            fmath::sin(d0),
        );
        // Body +z is the IAU north pole.
        assert!(bf_to_icrf.mul_v3(V3::Z).max_abs_diff(pole) < 1e-15);
        // Body +x (prime meridian) is W from the node Q = ẑ_ICRF × pole, measured
        // eastward along the body equator (Archinal et al. 2018, Fig. 1).
        let q = V3::Z.cross(pole).normalized().unwrap();
        let x = bf_to_icrf.mul_v3(V3::X);
        let angle = fmath::atan2(q.cross(x).dot(pole), q.dot(x));
        assert!((angle - w).abs() < 1e-14, "{angle}");
    }

    #[test]
    fn surface_fixed_point_has_zero_body_fixed_velocity() {
        let o = some_orientation(0.4);
        let r_bf = V3::new(6.0e6, 1.0e6, 2.0e6);
        // Inertial velocity of a point rigidly attached to the body: ω × r.
        let rt = o.icrf_to_bf.transpose();
        let r_i = rt.mul_v3(r_bf);
        let v_i = rt.mul_v3(o.omega_bf).cross(r_i);
        let s = State::new(r_i, v_i, IcrfBody { center: EARTH });
        let bf = icrf_body_to_body_fixed(&s, &o).unwrap();
        assert!(bf.r.max_abs_diff(r_bf) < 1e-8);
        assert!(bf.v.norm() < 1e-9, "{:?}", bf.v);
    }

    #[test]
    fn body_fixed_velocity_matches_finite_difference() {
        // An inertially fixed point appears to move in the rotating frame;
        // compare the transport-theorem velocity with a central difference of R(t)·r.
        let w0 = 0.7;
        let wd = 7.292_115e-5;
        let dt = 1.0;
        let r_i = V3::new(4.0e6, -3.0e6, 5.0e6);
        let s = State::new(r_i, V3::ZERO, IcrfBody { center: EARTH });
        let bf = icrf_body_to_body_fixed(&s, &some_orientation(w0)).unwrap();
        let ahead = some_orientation(w0 + wd * dt).icrf_to_bf.mul_v3(r_i);
        let behind = some_orientation(w0 - wd * dt).icrf_to_bf.mul_v3(r_i);
        let fd = (ahead - behind) * (0.5 / dt);
        assert!(bf.v.max_abs_diff(fd) < 1e-6, "{:?} vs {:?}", bf.v, fd);
    }

    #[test]
    fn body_fixed_roundtrip() {
        let o = some_orientation(2.9);
        let s = leo();
        let back = body_fixed_to_icrf_body(&icrf_body_to_body_fixed(&s, &o).unwrap(), &o).unwrap();
        assert!(back.r.max_abs_diff(s.r) < 1e-8);
        assert!(back.v.max_abs_diff(s.v) < 1e-11);
        let v = VecIcrf::new(V3::new(1.0, 2.0, 3.0));
        let vb = vec_body_fixed_to_icrf(&vec_icrf_to_body_fixed(&v, &o), &o).unwrap();
        assert!(vb.v.max_abs_diff(v.v) < 1e-15);
    }

    #[test]
    fn lvlh_axes_follow_nasa_convention() {
        let reference = leo();
        let b = LvlhBasis::from_reference(&reference).unwrap();
        // Reference itself sits at the LVLH origin, at rest.
        let me = icrf_body_to_lvlh(&reference, &b).unwrap();
        assert!(me.r.norm() < 1e-9 && me.v.norm() < 1e-12);
        // 1 km radially up is −z (z points to nadir).
        let up = State::new(
            reference.r * (1.0 + 1000.0 / reference.r.norm()),
            reference.v,
            reference.frame,
        );
        let up_l = icrf_body_to_lvlh(&up, &b).unwrap();
        assert!(up_l.r.max_abs_diff(V3::new(0.0, 0.0, -1000.0)) < 1e-6);
        // Velocity direction of a circular orbit is +x.
        let vdir = vec_icrf_to_lvlh(&VecIcrf::new(reference.v.normalized().unwrap()), &b);
        assert!(vdir.v.max_abs_diff(V3::X) < 1e-15);
        // Orbit normal is −y.
        let n = vec_icrf_to_lvlh(
            &VecIcrf::new(reference.r.cross(reference.v).normalized().unwrap()),
            &b,
        );
        assert!(n.v.max_abs_diff(-V3::Y) < 1e-15);
    }

    #[test]
    fn lvlh_circular_orbit_drift_matches_clohessy_wiltshire() {
        // A co-planar circular orbit Δr above the reference drifts at
        // ẋ = −(3/2) n Δr in LVLH (Clohessy & Wiltshire 1960; Curtis,
        // *Orbital Mechanics for Engineering Students*, 3rd ed., §7.5).
        let reference = leo();
        let r0 = reference.r.norm();
        let dr = 100.0;
        let r1 = r0 + dr;
        let v1 = (gm::EARTH / r1).sqrt();
        let u = reference.v.normalized().unwrap();
        let other = State::new(reference.r * (r1 / r0), u * v1, reference.frame);
        let b = LvlhBasis::from_reference(&reference).unwrap();
        let l = icrf_body_to_lvlh(&other, &b).unwrap();
        let n = (gm::EARTH / (r0 * r0 * r0)).sqrt();
        let expected = -1.5 * n * dr;
        assert!(
            (l.v.x - expected).abs() < 1e-4 * expected.abs(),
            "{} vs {expected}",
            l.v.x
        );
        assert!(l.v.y.abs() < 1e-12 && l.v.z.abs() < 1e-9);
    }

    #[test]
    fn lvlh_roundtrip_and_degenerate_reference() {
        let reference = leo();
        let b = LvlhBasis::from_reference(&reference).unwrap();
        let other = State::new(
            reference.r + V3::new(1200.0, -300.0, 450.0),
            reference.v + V3::new(-0.4, 1.1, 0.2),
            reference.frame,
        );
        let back = lvlh_to_icrf_body(&icrf_body_to_lvlh(&other, &b).unwrap(), &b);
        assert!(back.r.max_abs_diff(other.r) < 1e-8);
        assert!(back.v.max_abs_diff(other.v) < 1e-11);
        let radial = State::new(V3::X * 7.0e6, V3::X * 100.0, IcrfBody { center: EARTH });
        assert_eq!(
            LvlhBasis::from_reference(&radial),
            Err(FrameError::DegenerateReference)
        );
    }

    #[test]
    fn spacecraft_body_attitude_convention() {
        // Yaw +90° about ICRF z: the body +x axis points along ICRF +y.
        let att = Attitude {
            q_body_to_icrf: Quat::from_axis_angle(V3::Z, FRAC_PI_2).unwrap(),
            omega_body: VecScBody::new(V3::ZERO),
        };
        let x_i = vec_sc_body_to_icrf(&VecScBody::new(V3::X), &att);
        assert!(x_i.v.max_abs_diff(V3::Y) < 1e-15);
        let v = VecIcrf::new(V3::new(0.3, -2.0, 7.0));
        let back = vec_sc_body_to_icrf(&vec_icrf_to_sc_body(&v, &att), &att);
        assert!(back.v.max_abs_diff(v.v) < 1e-14);
        // Half turn about x flips y and z.
        let flip = Attitude {
            q_body_to_icrf: Quat::from_axis_angle(V3::X, PI).unwrap(),
            omega_body: VecScBody::new(V3::ZERO),
        };
        assert!(
            vec_sc_body_to_icrf(&VecScBody::new(V3::Y), &flip)
                .v
                .max_abs_diff(-V3::Y)
                < 1e-15
        );
    }

    #[test]
    #[should_panic(expected = "axes mismatch")]
    fn body_fixed_vectors_of_different_bodies_do_not_mix() {
        let a = Vector::in_axes(V3::X, BodyFixedAxes { body: EARTH });
        let b = Vector::in_axes(V3::X, BodyFixedAxes { body: BodyId::MARS });
        let _ = a + b;
    }
}
