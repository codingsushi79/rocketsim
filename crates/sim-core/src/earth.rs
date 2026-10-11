//! Precise Earth orientation: GCRS → ITRS (decision D4).
//!
//! R = W(x_p, y_p, s′) · R3(GAST) · NPB, the equinox-based form of IERS Conventions
//! 2010 ch. 5:
//! - NPB: IAU 2006 bias-precession as Fukushima–Williams angles (Hilton et al. 2006;
//!   ERFA `eraPfw06`, `eraObl06`), with IAU 2000B nutation (McCarthy & Luzum 2003;
//!   ERFA `eraNut00b`) scaled by the IAU 2006 adjustments (ERFA `eraNut06a`).
//!   2000B is within ~1 mas of 2000A over 1995–2050, about 3 cm at the surface.
//! - GAST = GMST06 + equation of the equinoxes (ERFA `eraGmst06`, `eraEe00`, `eraEect00`).
//! - W: polar motion with TIO locator s′ (ERFA `eraPom00`, `eraSp00`).
//! - x_p, y_p and UT1 come from IERS EOP (finals2000A), interpolated with 4-point
//!   Lagrange on UT1−TAI, which stays continuous across leap seconds.
//!
//! Coefficients are ported from ERFA 2.0.1 and validated against ERFA `eraC2t06a`
//! in tests/earth_erfa.rs.
//!
//! Portions derived from ERFA: Copyright (C) 2013-2021, NumFOCUS Foundation.
//! All rights reserved. BSD-3-Clause; see third_party/ERFA-LICENSE.txt. ERFA is
//! derived, with permission, from the IAU SOFA library. This code is not endorsed
//! by SOFA.
//!
//! GCRS axes are taken as the `IcrfBody { center: EARTH }` frame.

use crate::bodies::BodyId;
use crate::constants::{SECONDS_PER_DAY, earth_wgs84};
use crate::frames::BodyOrientation;
use crate::math::{M3, V3, fmath};
use crate::time::{self, Epoch, Tai, Tt};
use core::f64::consts::{PI, TAU};

include!(concat!(env!("OUT_DIR"), "/eop.rs"));

/// Arcseconds to radians.
const AS2R: f64 = PI / 648_000.0;
/// Arcseconds in a full turn.
const TURNAS: f64 = 1_296_000.0;
/// Days per Julian century.
const DJC: f64 = 36_525.0;

/// How the Earth orientation parameters at an instant were obtained.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EopQuality {
    /// Interpolated from IERS observed values.
    Observed,
    /// Interpolated from IERS predictions (about a year past the last observation).
    Predicted,
    /// Past the end of the table: UT1−TAI extrapolated linearly, pole held fixed.
    /// Error grows by roughly 0.1 s of UT1 per year, about 50 m/yr at the equator.
    Extrapolated,
    /// Before the table (pre-1973): pole at zero, UT1 from the Espenak–Meeus ΔT
    /// polynomial (~0.1 s ≈ 50 m).
    Model,
}

/// Earth orientation parameters at an instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Eop {
    /// Polar motion, rad.
    pub xp: f64,
    pub yp: f64,
    /// UT1 − TAI, s.
    pub ut1_minus_tai: f64,
    pub quality: EopQuality,
}

/// Earth orientation parameters at the TAI instant `tai`.
pub fn eop(tai: Tai) -> Eop {
    let (sec, frac) = tai.parts();
    // UTC MJD of the instant. EOP rows are tabulated at 0h UTC; using the leap
    // offset at this instant puts the argument on the UTC day grid.
    let tai_days = (sec as f64 + frac) / SECONDS_PER_DAY + 51_544.5;
    let dat = time::tai_minus_utc(tai_days.floor() as i64).unwrap_or(10);
    let mjd = tai_days - dat as f64 / SECONDS_PER_DAY;
    let n = EOP.len() as i64;
    let x = mjd - EOP_FIRST_MJD as f64; // fractional row index
    let row = |i: i64| -> (f64, f64, f64) {
        let (a, b, c) = EOP[i as usize];
        (
            f64::from(a) * 1e-6 * AS2R,
            f64::from(b) * 1e-6 * AS2R,
            f64::from(c) * 1e-7,
        )
    };
    if x < 0.0 {
        return Eop {
            xp: 0.0,
            yp: 0.0,
            ut1_minus_tai: delta_t_model_ut1_minus_tai(mjd),
            quality: EopQuality::Model,
        };
    }
    if x > (n - 1) as f64 {
        let (xp, yp, u_last) = row(n - 1);
        let (_, _, u_year_ago) = row(n - 366);
        let rate = (u_last - u_year_ago) / 365.0;
        return Eop {
            xp,
            yp,
            ut1_minus_tai: u_last + rate * (x - (n - 1) as f64),
            quality: EopQuality::Extrapolated,
        };
    }
    // 4-point Lagrange on rows i0-1 .. i0+2 around the instant (clamped at the ends).
    let i0 = (x.floor() as i64).clamp(1, n - 3);
    let p = x - i0 as f64;
    let w = [
        -p * (p - 1.0) * (p - 2.0) / 6.0,
        (p + 1.0) * (p - 1.0) * (p - 2.0) / 2.0,
        -(p + 1.0) * p * (p - 2.0) / 2.0,
        (p + 1.0) * p * (p - 1.0) / 6.0,
    ];
    let (mut xp, mut yp, mut u) = (0.0, 0.0, 0.0);
    for (k, wk) in w.iter().enumerate() {
        let (a, b, c) = row(i0 - 1 + k as i64);
        xp += wk * a;
        yp += wk * b;
        u += wk * c;
    }
    let quality = if mjd <= EOP_LAST_OBSERVED_MJD as f64 {
        EopQuality::Observed
    } else {
        EopQuality::Predicted
    };
    Eop {
        xp,
        yp,
        ut1_minus_tai: u,
        quality,
    }
}

/// UT1 − TAI from ΔT = TT − UT1 (Espenak & Meeus, "Five Millennium Canon of Solar
/// Eclipses", NASA/TP-2006-214141, polynomial for 1961–1986), used only before the
/// EOP table starts (1973).
fn delta_t_model_ut1_minus_tai(mjd: f64) -> f64 {
    let year = 2000.0 + (mjd - 51_544.5) / 365.25;
    let t = year - 1975.0;
    let delta_t = 45.45 + 1.067 * t - t * t / 260.0 - t * t * t / 718.0;
    // UT1 − TAI = (TT − TAI) − ΔT
    crate::constants::TT_MINUS_TAI - delta_t
}

// ---------------------------------------------------------------------------
// IAU 2006 precession, IAU 2000B nutation, sidereal time (ported from ERFA)
// ---------------------------------------------------------------------------

/// Fukushima–Williams bias-precession angles (γ̄, φ̄, ψ̄) and mean obliquity ε_A, rad
/// (ERFA `eraPfw06`, `eraObl06`). `t`: TT Julian centuries since J2000.
fn pfw06(t: f64) -> (f64, f64, f64, f64) {
    let gamb = (-0.052_928
        + (10.556_378
            + (0.493_204_4 + (-0.000_312_38 + (-0.000_002_788 + 0.000_000_026_0 * t) * t) * t)
                * t)
            * t)
        * AS2R;
    let phib = (84_381.412_819
        + (-46.811_016
            + (0.051_126_8 + (0.000_532_89 + (-0.000_000_440 - 0.000_000_017_6 * t) * t) * t) * t)
            * t)
        * AS2R;
    let psib = (-0.041_775
        + (5_038.481_484
            + (1.558_417_5 + (-0.000_185_22 + (-0.000_026_452 - 0.000_000_014_8 * t) * t) * t)
                * t)
            * t)
        * AS2R;
    let epsa = (84_381.406
        + (-46.836_769
            + (-0.000_183_1 + (0.002_003_40 + (-0.000_000_576 - 0.000_000_043_4 * t) * t) * t)
                * t)
            * t)
        * AS2R;
    (gamb, phib, psib, epsa)
}

/// IAU 2000B luni-solar nutation terms (ERFA `eraNut00b`): Delaunay multipliers
/// (l, l′, F, D, Ω), then longitude (sin, t·sin, cos) and obliquity (cos, t·cos, sin)
/// in units of 0.1 µas.
#[rustfmt::skip]
const NUT00B: [([i8; 5], [f64; 6]); 77] = [
    ([0,0,0,0,1], [-172064161.0,-174666.0,33386.0,92052331.0,9086.0,15377.0]),
    ([0,0,2,-2,2], [-13170906.0,-1675.0,-13696.0,5730336.0,-3015.0,-4587.0]),
    ([0,0,2,0,2], [-2276413.0,-234.0,2796.0,978459.0,-485.0,1374.0]),
    ([0,0,0,0,2], [2074554.0,207.0,-698.0,-897492.0,470.0,-291.0]),
    ([0,1,0,0,0], [1475877.0,-3633.0,11817.0,73871.0,-184.0,-1924.0]),
    ([0,1,2,-2,2], [-516821.0,1226.0,-524.0,224386.0,-677.0,-174.0]),
    ([1,0,0,0,0], [711159.0,73.0,-872.0,-6750.0,0.0,358.0]),
    ([0,0,2,0,1], [-387298.0,-367.0,380.0,200728.0,18.0,318.0]),
    ([1,0,2,0,2], [-301461.0,-36.0,816.0,129025.0,-63.0,367.0]),
    ([0,-1,2,-2,2], [215829.0,-494.0,111.0,-95929.0,299.0,132.0]),
    ([0,0,2,-2,1], [128227.0,137.0,181.0,-68982.0,-9.0,39.0]),
    ([-1,0,2,0,2], [123457.0,11.0,19.0,-53311.0,32.0,-4.0]),
    ([-1,0,0,2,0], [156994.0,10.0,-168.0,-1235.0,0.0,82.0]),
    ([1,0,0,0,1], [63110.0,63.0,27.0,-33228.0,0.0,-9.0]),
    ([-1,0,0,0,1], [-57976.0,-63.0,-189.0,31429.0,0.0,-75.0]),
    ([-1,0,2,2,2], [-59641.0,-11.0,149.0,25543.0,-11.0,66.0]),
    ([1,0,2,0,1], [-51613.0,-42.0,129.0,26366.0,0.0,78.0]),
    ([-2,0,2,0,1], [45893.0,50.0,31.0,-24236.0,-10.0,20.0]),
    ([0,0,0,2,0], [63384.0,11.0,-150.0,-1220.0,0.0,29.0]),
    ([0,0,2,2,2], [-38571.0,-1.0,158.0,16452.0,-11.0,68.0]),
    ([0,-2,2,-2,2], [32481.0,0.0,0.0,-13870.0,0.0,0.0]),
    ([-2,0,0,2,0], [-47722.0,0.0,-18.0,477.0,0.0,-25.0]),
    ([2,0,2,0,2], [-31046.0,-1.0,131.0,13238.0,-11.0,59.0]),
    ([1,0,2,-2,2], [28593.0,0.0,-1.0,-12338.0,10.0,-3.0]),
    ([-1,0,2,0,1], [20441.0,21.0,10.0,-10758.0,0.0,-3.0]),
    ([2,0,0,0,0], [29243.0,0.0,-74.0,-609.0,0.0,13.0]),
    ([0,0,2,0,0], [25887.0,0.0,-66.0,-550.0,0.0,11.0]),
    ([0,1,0,0,1], [-14053.0,-25.0,79.0,8551.0,-2.0,-45.0]),
    ([-1,0,0,2,1], [15164.0,10.0,11.0,-8001.0,0.0,-1.0]),
    ([0,2,2,-2,2], [-15794.0,72.0,-16.0,6850.0,-42.0,-5.0]),
    ([0,0,-2,2,0], [21783.0,0.0,13.0,-167.0,0.0,13.0]),
    ([1,0,0,-2,1], [-12873.0,-10.0,-37.0,6953.0,0.0,-14.0]),
    ([0,-1,0,0,1], [-12654.0,11.0,63.0,6415.0,0.0,26.0]),
    ([-1,0,2,2,1], [-10204.0,0.0,25.0,5222.0,0.0,15.0]),
    ([0,2,0,0,0], [16707.0,-85.0,-10.0,168.0,-1.0,10.0]),
    ([1,0,2,2,2], [-7691.0,0.0,44.0,3268.0,0.0,19.0]),
    ([-2,0,2,0,0], [-11024.0,0.0,-14.0,104.0,0.0,2.0]),
    ([0,1,2,0,2], [7566.0,-21.0,-11.0,-3250.0,0.0,-5.0]),
    ([0,0,2,2,1], [-6637.0,-11.0,25.0,3353.0,0.0,14.0]),
    ([0,-1,2,0,2], [-7141.0,21.0,8.0,3070.0,0.0,4.0]),
    ([0,0,0,2,1], [-6302.0,-11.0,2.0,3272.0,0.0,4.0]),
    ([1,0,2,-2,1], [5800.0,10.0,2.0,-3045.0,0.0,-1.0]),
    ([2,0,2,-2,2], [6443.0,0.0,-7.0,-2768.0,0.0,-4.0]),
    ([-2,0,0,2,1], [-5774.0,-11.0,-15.0,3041.0,0.0,-5.0]),
    ([2,0,2,0,1], [-5350.0,0.0,21.0,2695.0,0.0,12.0]),
    ([0,-1,2,-2,1], [-4752.0,-11.0,-3.0,2719.0,0.0,-3.0]),
    ([0,0,0,-2,1], [-4940.0,-11.0,-21.0,2720.0,0.0,-9.0]),
    ([-1,-1,0,2,0], [7350.0,0.0,-8.0,-51.0,0.0,4.0]),
    ([2,0,0,-2,1], [4065.0,0.0,6.0,-2206.0,0.0,1.0]),
    ([1,0,0,2,0], [6579.0,0.0,-24.0,-199.0,0.0,2.0]),
    ([0,1,2,-2,1], [3579.0,0.0,5.0,-1900.0,0.0,1.0]),
    ([1,-1,0,0,0], [4725.0,0.0,-6.0,-41.0,0.0,3.0]),
    ([-2,0,2,0,2], [-3075.0,0.0,-2.0,1313.0,0.0,-1.0]),
    ([3,0,2,0,2], [-2904.0,0.0,15.0,1233.0,0.0,7.0]),
    ([0,-1,0,2,0], [4348.0,0.0,-10.0,-81.0,0.0,2.0]),
    ([1,-1,2,0,2], [-2878.0,0.0,8.0,1232.0,0.0,4.0]),
    ([0,0,0,1,0], [-4230.0,0.0,5.0,-20.0,0.0,-2.0]),
    ([-1,-1,2,2,2], [-2819.0,0.0,7.0,1207.0,0.0,3.0]),
    ([-1,0,2,0,0], [-4056.0,0.0,5.0,40.0,0.0,-2.0]),
    ([0,-1,2,2,2], [-2647.0,0.0,11.0,1129.0,0.0,5.0]),
    ([-2,0,0,0,1], [-2294.0,0.0,-10.0,1266.0,0.0,-4.0]),
    ([1,1,2,0,2], [2481.0,0.0,-7.0,-1062.0,0.0,-3.0]),
    ([2,0,0,0,1], [2179.0,0.0,-2.0,-1129.0,0.0,-2.0]),
    ([-1,1,0,1,0], [3276.0,0.0,1.0,-9.0,0.0,0.0]),
    ([1,1,0,0,0], [-3389.0,0.0,5.0,35.0,0.0,-2.0]),
    ([1,0,2,0,0], [3339.0,0.0,-13.0,-107.0,0.0,1.0]),
    ([-1,0,2,-2,1], [-1987.0,0.0,-6.0,1073.0,0.0,-2.0]),
    ([1,0,0,0,2], [-1981.0,0.0,0.0,854.0,0.0,0.0]),
    ([-1,0,0,1,0], [4026.0,0.0,-353.0,-553.0,0.0,-139.0]),
    ([0,0,2,1,2], [1660.0,0.0,-5.0,-710.0,0.0,-2.0]),
    ([-1,0,2,4,2], [-1521.0,0.0,9.0,647.0,0.0,4.0]),
    ([-1,1,0,1,1], [1314.0,0.0,0.0,-700.0,0.0,0.0]),
    ([0,-2,2,-2,1], [-1283.0,0.0,0.0,672.0,0.0,0.0]),
    ([1,0,2,2,1], [-1331.0,0.0,8.0,663.0,0.0,4.0]),
    ([-2,0,2,2,2], [1383.0,0.0,-2.0,-594.0,0.0,-2.0]),
    ([-1,0,0,0,2], [1405.0,0.0,4.0,-610.0,0.0,2.0]),
    ([1,1,2,-2,2], [1290.0,0.0,0.0,-556.0,0.0,0.0]),
];

/// IAU 2000B nutation (Δψ, Δε), rad, with the IAU 2006 adjustments (ERFA `eraNut06a`
/// applies the same factors to 2000A). `t`: TT Julian centuries since J2000.
fn nut06b(t: f64) -> (f64, f64) {
    // Delaunay arguments, Simon et al. (1994), as truncated in eraNut00b.
    let el = ((485_868.249_036 + 1_717_915_923.217_8 * t) % TURNAS) * AS2R;
    let elp = ((1_287_104.793_05 + 129_596_581.048_1 * t) % TURNAS) * AS2R;
    let f = ((335_779.526_232 + 1_739_527_262.847_8 * t) % TURNAS) * AS2R;
    let d = ((1_072_260.703_69 + 1_602_961_601.209_0 * t) % TURNAS) * AS2R;
    let om = ((450_160.398_036 - 6_962_890.543_1 * t) % TURNAS) * AS2R;
    let (mut dp, mut de) = (0.0, 0.0);
    // Smallest terms first, as in ERFA.
    for (m, c) in NUT00B.iter().rev() {
        let arg = (f64::from(m[0]) * el
            + f64::from(m[1]) * elp
            + f64::from(m[2]) * f
            + f64::from(m[3]) * d
            + f64::from(m[4]) * om)
            % TAU;
        let (s, co) = fmath::sin_cos(arg);
        dp += (c[0] + c[1] * t) * s + c[2] * co;
        de += (c[3] + c[4] * t) * co + c[5] * s;
    }
    let u2r = AS2R / 1e7;
    // Fixed offsets in lieu of planetary terms (eraNut00b).
    let dpsi = dp * u2r - 0.135e-3 * AS2R;
    let deps = de * u2r + 0.388e-3 * AS2R;
    // IAU 2006 adjustments: J2 secular rate and the obliquity scale factor.
    let fj2 = -2.7774e-6 * t;
    (dpsi * (1.0 + 0.4697e-6 + fj2), deps * (1.0 + fj2))
}

/// Equation of the equinoxes complementary terms (ERFA `eraEect00`), rad.
#[rustfmt::skip]
const EECT00: [([i8; 8], f64, f64); 33] = [
    ([0,0,0,0,1,0,0,0], 2640.96e-6, -0.39e-6),
    ([0,0,0,0,2,0,0,0], 63.52e-6, -0.02e-6),
    ([0,0,2,-2,3,0,0,0], 11.75e-6, 0.01e-6),
    ([0,0,2,-2,1,0,0,0], 11.21e-6, 0.01e-6),
    ([0,0,2,-2,2,0,0,0], -4.55e-6, 0.00e-6),
    ([0,0,2,0,3,0,0,0], 2.02e-6, 0.00e-6),
    ([0,0,2,0,1,0,0,0], 1.98e-6, 0.00e-6),
    ([0,0,0,0,3,0,0,0], -1.72e-6, 0.00e-6),
    ([0,1,0,0,1,0,0,0], -1.41e-6, -0.01e-6),
    ([0,1,0,0,-1,0,0,0], -1.26e-6, -0.01e-6),
    ([1,0,0,0,-1,0,0,0], -0.63e-6, 0.00e-6),
    ([1,0,0,0,1,0,0,0], -0.63e-6, 0.00e-6),
    ([0,1,2,-2,3,0,0,0], 0.46e-6, 0.00e-6),
    ([0,1,2,-2,1,0,0,0], 0.45e-6, 0.00e-6),
    ([0,0,4,-4,4,0,0,0], 0.36e-6, 0.00e-6),
    ([0,0,1,-1,1,-8,12,0], -0.24e-6, -0.12e-6),
    ([0,0,2,0,0,0,0,0], 0.32e-6, 0.00e-6),
    ([0,0,2,0,2,0,0,0], 0.28e-6, 0.00e-6),
    ([1,0,2,0,3,0,0,0], 0.27e-6, 0.00e-6),
    ([1,0,2,0,1,0,0,0], 0.26e-6, 0.00e-6),
    ([0,0,2,-2,0,0,0,0], -0.21e-6, 0.00e-6),
    ([0,1,-2,2,-3,0,0,0], 0.19e-6, 0.00e-6),
    ([0,1,-2,2,-1,0,0,0], 0.18e-6, 0.00e-6),
    ([0,0,0,0,0,8,-13,-1], -0.10e-6, 0.05e-6),
    ([0,0,0,2,0,0,0,0], 0.15e-6, 0.00e-6),
    ([2,0,-2,0,-1,0,0,0], -0.14e-6, 0.00e-6),
    ([1,0,0,-2,1,0,0,0], 0.14e-6, 0.00e-6),
    ([0,1,2,-2,2,0,0,0], -0.14e-6, 0.00e-6),
    ([1,0,0,-2,-1,0,0,0], 0.14e-6, 0.00e-6),
    ([0,0,4,-2,4,0,0,0], 0.13e-6, 0.00e-6),
    ([0,0,2,-2,4,0,0,0], -0.11e-6, 0.00e-6),
    ([1,0,-2,0,-3,0,0,0], 0.11e-6, 0.00e-6),
    ([1,0,-2,0,-1,0,0,0], 0.11e-6, 0.00e-6),
];

/// Complementary terms of the equation of the equinoxes, rad (ERFA `eraEect00`, with the
/// IERS 2003 fundamental arguments `eraFal03` … `eraFapa03`).
fn eect00(t: f64) -> f64 {
    let fa = [
        ((485_868.249_036
            + t * (1_717_915_923.217_8 + t * (31.879_2 + t * (0.051_635 + t * -0.000_244_70))))
            % TURNAS)
            * AS2R,
        ((1_287_104.793_048
            + t * (129_596_581.048_1 + t * (-0.553_2 + t * (0.000_136 + t * -0.000_011_49))))
            % TURNAS)
            * AS2R,
        ((335_779.526_232
            + t * (1_739_527_262.847_8 + t * (-12.751_2 + t * (-0.001_037 + t * 0.000_004_17))))
            % TURNAS)
            * AS2R,
        ((1_072_260.703_692
            + t * (1_602_961_601.209_0 + t * (-6.370_6 + t * (0.006_593 + t * -0.000_031_69))))
            % TURNAS)
            * AS2R,
        ((450_160.398_036
            + t * (-6_962_890.543_1 + t * (7.472_2 + t * (0.007_702 + t * -0.000_059_39))))
            % TURNAS)
            * AS2R,
        (3.176_146_697 + 1_021.328_554_621_1 * t) % TAU,
        (1.753_470_314 + 628.307_584_999_1 * t) % TAU,
        (0.024_381_750 + 0.000_005_386_91 * t) * t,
    ];
    let mut s0 = 0.0;
    for (m, s, c) in EECT00.iter().rev() {
        let a: f64 = m.iter().zip(fa).map(|(&k, f)| f64::from(k) * f).sum();
        let (sa, ca) = fmath::sin_cos(a);
        s0 += s * sa + c * ca;
    }
    // Single t¹ term (ERFA e1 table).
    let s1 = -0.87e-6 * fmath::sin(fa[4]);
    (s0 + s1 * t) * AS2R
}

/// Earth rotation angle (IERS Conventions 2010 eq. 5.15; ERFA `eraEra00`), rad.
/// `ut1`: (whole seconds, fraction) of UT1 past 2000-01-01T12:00:00 UT1.
fn era00(ut1: (i64, f64)) -> f64 {
    let day = ut1.0.div_euclid(86_400);
    let sod = ut1.0.rem_euclid(86_400) as f64 + ut1.1;
    let f = sod / SECONDS_PER_DAY; // fraction of the (JD) day; JD 2451545.0 is integral
    let tu = day as f64 + f;
    let theta = (f + 0.779_057_273_264_0 + 0.002_737_811_911_354_48 * tu) % 1.0;
    let theta = if theta < 0.0 { theta + 1.0 } else { theta };
    TAU * theta
}

/// GCRS → ITRS rotation for given TT, UT1 and polar motion (rad).
/// Exposed for validation against ERFA `eraC2t06a`.
pub fn gcrs_to_itrs(tt: Tt, ut1: (i64, f64), xp: f64, yp: f64) -> M3 {
    let t = tt.seconds() / SECONDS_PER_DAY / DJC;
    let (gamb, phib, psib, epsa) = pfw06(t);
    let (dpsi, deps) = nut06b(t);
    // eraFw2m: NPB = R1(−ε)·R3(−ψ)·R1(φ̄)·R3(γ̄)
    let npb = M3::r1(-(epsa + deps))
        .mul_m3(&M3::r3(-(psib + dpsi)))
        .mul_m3(&M3::r1(phib))
        .mul_m3(&M3::r3(gamb));
    // eraGmst06 + eraEe00
    let gmst = era00(ut1)
        + (0.014_506
            + (4_612.156_534
                + (1.391_581_7
                    + (-0.000_000_44 + (-0.000_029_956 - 0.000_000_036_8 * t) * t) * t)
                    * t)
                * t)
            * AS2R;
    let gast = gmst + dpsi * fmath::cos(epsa) + eect00(t);
    // eraPom00: W = R1(−y_p)·R2(−x_p)·R3(s′), with s′ = −47 µas · t (eraSp00).
    let sp = -47e-6 * t * AS2R;
    let w = M3::r1(-yp).mul_m3(&M3::r2(-xp)).mul_m3(&M3::r3(sp));
    w.mul_m3(&M3::r3(gast)).mul_m3(&npb)
}

/// Earth's orientation (GCRS → ITRS) at TDB epoch `t`, with the EOP quality used.
///
/// Angular velocity is the nominal ERA rate about the ITRS z axis. Precession,
/// nutation, polar-motion rates and length-of-day variations are ≲ 1e-7 relative,
/// which is under 0.05 mm/s at the surface.
pub fn earth_orientation(t: Epoch) -> (BodyOrientation, EopQuality) {
    let tt = time::tdb_to_tt(t);
    let tai = time::tt_to_tai(tt);
    let e = eop(tai);
    let (s, f) = tai.parts();
    let ut1 = Epoch::from_tdb_parts(s, f)
        .add_seconds(e.ut1_minus_tai)
        .tdb_parts();
    let icrf_to_bf = gcrs_to_itrs(tt, ut1, e.xp, e.yp);
    let omega = TAU * (1.0 + 0.002_737_811_911_354_48) / SECONDS_PER_DAY;
    (
        BodyOrientation {
            body: BodyId::EARTH,
            icrf_to_bf,
            omega_bf: V3::new(0.0, 0.0, omega),
        },
        e.quality,
    )
}

/// WGS84 geodetic latitude, longitude (rad) and ellipsoidal height (m) to ITRS
/// Cartesian position (m). NGA TR8350.2 §4; Google Photorealistic 3D Tiles use the
/// same ellipsoid.
pub fn geodetic_to_itrs(lat: f64, lon: f64, h: f64) -> V3 {
    let (a, f) = (earth_wgs84::A, earth_wgs84::F);
    let e2 = f * (2.0 - f);
    let (sl, cl) = fmath::sin_cos(lat);
    let (so, co) = fmath::sin_cos(lon);
    let n = a / (1.0 - e2 * sl * sl).sqrt();
    V3::new(
        (n + h) * cl * co,
        (n + h) * cl * so,
        (n * (1.0 - e2) + h) * sl,
    )
}

/// Inverse of [`geodetic_to_itrs`]: (latitude, longitude, height) by Bowring's
/// iteration (Bowring 1976, Survey Review 23:181). It converges to < 1 µm in a few
/// steps for heights from −10 km to 1e7 km; a fixed iteration count keeps it
/// deterministic.
pub fn itrs_to_geodetic(r: V3) -> (f64, f64, f64) {
    let (a, f) = (earth_wgs84::A, earth_wgs84::F);
    let e2 = f * (2.0 - f);
    let b = a * (1.0 - f);
    let ep2 = e2 / (1.0 - e2);
    let p = fmath::hypot(r.x, r.y);
    let lon = fmath::atan2(r.y, r.x);
    // Parametric latitude start, then Bowring updates.
    let mut beta = fmath::atan2(r.z, (1.0 - f) * p);
    let mut lat = 0.0;
    for _ in 0..5 {
        let (sb, cb) = fmath::sin_cos(beta);
        lat = fmath::atan2(r.z + ep2 * b * sb * sb * sb, p - e2 * a * cb * cb * cb);
        beta = fmath::atan2((1.0 - f) * fmath::sin(lat), fmath::cos(lat));
    }
    let (sl, cl) = fmath::sin_cos(lat);
    let n = a / (1.0 - e2 * sl * sl).sqrt();
    let h = if cl.abs() > 1e-10 {
        p / cl - n
    } else {
        r.z.abs() / sl.abs() - n * (1.0 - e2)
    };
    (lat, lon, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::{UtcDateTime, utc_to_tai};

    #[test]
    fn eop_matches_table_rows_at_0h_utc() {
        // finals2000A row "26 627 61218.00 I 0.203196 … 0.392647 … I 0.0120895":
        // 2026-06-27 0h UTC, x_p = 0.203196″, y_p = 0.392647″, UT1−UTC = 0.0120895 s.
        let tai = utc_to_tai(&UtcDateTime::new(2026, 6, 27, 0, 0, 0.0)).unwrap();
        let e = eop(tai);
        assert!((e.xp / AS2R - 0.203_196).abs() < 1e-9);
        assert!((e.yp / AS2R - 0.392_647).abs() < 1e-9);
        assert!((e.ut1_minus_tai - (0.012_089_5 - 37.0)).abs() < 1e-9);
        assert_eq!(e.quality, EopQuality::Observed);
    }

    #[test]
    fn ut1_is_continuous_across_a_leap_second() {
        // UT1−UTC jumps by +1 s at 2016-12-31/2017-01-01; UT1−TAI must not.
        let before = utc_to_tai(&UtcDateTime::new(2016, 12, 31, 23, 59, 59.0)).unwrap();
        let after = utc_to_tai(&UtcDateTime::new(2017, 1, 1, 0, 0, 0.0)).unwrap();
        let (u0, u1) = (eop(before).ut1_minus_tai, eop(after).ut1_minus_tai);
        assert!((u1 - u0).abs() < 1e-5, "{u0} → {u1}");
    }

    #[test]
    fn quality_regions() {
        let at = |y, m, d| eop(utc_to_tai(&UtcDateTime::new(y, m, d, 0, 0, 0.0)).unwrap()).quality;
        assert_eq!(at(1972, 6, 1), EopQuality::Model);
        assert_eq!(at(2000, 1, 1), EopQuality::Observed);
        assert_eq!(at(2027, 3, 1), EopQuality::Predicted);
        assert_eq!(at(2040, 1, 1), EopQuality::Extrapolated);
    }

    #[test]
    fn geodetic_roundtrip() {
        for (lat, lon, h) in [
            (0.0, 0.0, 0.0),
            (45.0, -120.0, 1234.5),
            (-89.9, 179.0, -50.0),
            (28.5, -80.6, 4.0e5),
        ] {
            let r = geodetic_to_itrs(f64::to_radians(lat), f64::to_radians(lon), h);
            let (la, lo, hh) = itrs_to_geodetic(r);
            assert!((la.to_degrees() - lat).abs() < 1e-11, "{lat}");
            assert!((lo.to_degrees() - lon).abs() < 1e-11, "{lon}");
            assert!((hh - h).abs() < 1e-6, "{h} vs {hh}");
        }
    }

    #[test]
    fn earth_rotation_rate_is_sidereal() {
        let (o, _) = earth_orientation(Epoch::from_tdb_seconds(8.4e8));
        assert!((o.omega_bf.z - 7.292_115_146_706_979e-5).abs() < 1e-18);
    }
}
