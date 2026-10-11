//! NRLMSISE-00 empirical atmosphere, thermospheric branch (altitude ≥ 72.5 km).
//!
//! J. M. Picone, A. E. Hedin, D. P. Drob, A. C. Aikin, "NRLMSISE-00 empirical model
//! of the atmosphere", J. Geophys. Res. 107(A12), 1468 (2002).
//!
//! Line-by-line port of NRL's Fortran (`nrlmsise00_sub.for`, routines GTD7D/GTD7 for
//! ALT ≥ ZN2(1) = 72.5 km, GTS7, GLOBE7, GLOB7S, DENSU, SPLINE/SPLINT/SPLINI, DNET,
//! CCOR, CCOR2, SCALH, GLATF), as distributed in the NASA CCMC ModelWeb archive.
//! The Fortran is a U.S. Government work (Naval Research Laboratory). Coefficients
//! are in `nrlmsise00_data.rs`, generated from its BLOCK DATA.
//!
//! Scope and differences:
//! - Only the altitude range ≥ 72.5 km is ported. The sim uses US Standard Atmosphere
//!   1976 below 86 km (spec §2.2), so the mesosphere/stratosphere branch (MESO, DENSM)
//!   is never needed.
//! - Daily-Ap mode only (switch 9 = +1). The 3-hour Ap history mode (switch 9 = −1) is
//!   not ported.
//! - All switches are on (the model's default). Model-call caching (VTST7) is not
//!   ported: every call evaluates from scratch, which gives the same results.
//! - f64 arithmetic (the Fortran is single precision), so results agree with NRL's
//!   published test output to its printed precision (3 significant figures).
//! - Transcendentals go through `fmath`, for determinism.

use crate::math::fmath;
use crate::nrlmsise00_data::{PD, PDL, PDM, PMA, PS, PT, PTL, PTM};

// Fortran constants, kept exactly (including their truncation).
const DGTR: f64 = 1.74533e-2;
const DR: f64 = 1.72142e-2;
const HR: f64 = 0.2618;
const SR: f64 = 7.2722e-5;
const RGAS: f64 = 831.4;

/// Model inputs (Fortran GTD7 argument conventions).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MsisInput {
    /// Day of year (1–366). Year is ignored by the model.
    pub doy: f64,
    /// UT seconds of day.
    pub sec: f64,
    /// Geodetic altitude, km (≥ 72.5).
    pub alt_km: f64,
    /// Geodetic latitude, deg.
    pub glat: f64,
    /// Geodetic longitude, deg.
    pub glong: f64,
    /// Local apparent solar time, hours.
    pub stl: f64,
    /// 81-day average F10.7 (centered), and previous-day F10.7.
    pub f107a: f64,
    pub f107: f64,
    /// Daily magnetic Ap.
    pub ap: f64,
}

/// Model outputs (cgs, as in the Fortran with METERS(.FALSE.)).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MsisOutput {
    /// Number densities, cm⁻³: He, O, N2, O2, Ar, (total mass g/cm³), H, N, anomalous O.
    /// Index 5 is the total mass density **including** anomalous oxygen (GTD7D),
    /// which is the one to use for drag.
    pub d: [f64; 9],
    /// Exospheric and local temperature, K.
    pub t: [f64; 2],
}

#[inline]
fn pd(i: usize, j: usize) -> f64 {
    PD[(j - 1) * 150 + (i - 1)]
}
#[inline]
fn pd_col(j: usize) -> &'static [f64] {
    &PD[(j - 1) * 150..j * 150]
}
#[inline]
fn pdl(i: usize, j: usize) -> f64 {
    PDL[(j - 1) * 25 + (i - 1)]
}
#[inline]
fn ptl(i: usize, j: usize) -> f64 {
    PTL[(j - 1) * 100 + (i - 1)]
}
#[inline]
fn ptl_col(j: usize) -> &'static [f64] {
    &PTL[(j - 1) * 100..j * 100]
}
#[inline]
fn pma(i: usize, j: usize) -> f64 {
    PMA[(j - 1) * 100 + (i - 1)]
}
#[inline]
fn pma_col(j: usize) -> &'static [f64] {
    &PMA[(j - 1) * 100..j * 100]
}
#[inline]
fn ptm(i: usize) -> f64 {
    PTM[i - 1]
}
#[inline]
fn pdm(i: usize, j: usize) -> f64 {
    PDM[(j - 1) * 10 + (i - 1)]
}

/// State shared between GLOBE7 and GLOB7S (Fortran COMMON/LPOLY/) and GLATF (PARMB).
struct Ctx {
    /// plg[n][m], 1-based like the Fortran PLG(n, m).
    plg: [[f64; 5]; 10],
    ctloc: f64,
    stloc: f64,
    c2tloc: f64,
    s2tloc: f64,
    c3tloc: f64,
    s3tloc: f64,
    day: f64,
    dfa: f64,
    apdf: f64,
    long: f64,
    gsurf: f64,
    re: f64,
}

impl Ctx {
    /// GLOBE7: G(L) function for the thermosphere. `p` is a 150-element parameter set.
    #[allow(clippy::too_many_arguments)]
    fn globe7(
        &mut self,
        yrd: f64,
        sec: f64,
        lat: f64,
        long: f64,
        tloc: f64,
        f107a: f64,
        f107: f64,
        ap: f64,
        p: &[f64],
    ) -> f64 {
        let p = |i: usize| p[i - 1];
        let mut t = [0.0f64; 15];
        let iyr = (yrd / 1000.0).trunc();
        self.day = yrd - iyr * 1000.0;
        self.long = long;
        let c = fmath::sin(lat * DGTR);
        let s = fmath::cos(lat * DGTR);
        let c2 = c * c;
        let c4 = c2 * c2;
        let s2 = s * s;
        let g = &mut self.plg;
        g[2][1] = c;
        g[3][1] = 0.5 * (3.0 * c2 - 1.0);
        g[4][1] = 0.5 * (5.0 * c * c2 - 3.0 * c);
        g[5][1] = (35.0 * c4 - 30.0 * c2 + 3.0) / 8.0;
        g[6][1] = (63.0 * c2 * c2 * c - 70.0 * c2 * c + 15.0 * c) / 8.0;
        g[7][1] = (11.0 * c * g[6][1] - 5.0 * g[5][1]) / 6.0;
        g[2][2] = s;
        g[3][2] = 3.0 * c * s;
        g[4][2] = 1.5 * (5.0 * c2 - 1.0) * s;
        g[5][2] = 2.5 * (7.0 * c2 * c - 3.0 * c) * s;
        g[6][2] = 1.875 * (21.0 * c4 - 14.0 * c2 + 1.0) * s;
        g[7][2] = (11.0 * c * g[6][2] - 6.0 * g[5][2]) / 5.0;
        g[3][3] = 3.0 * s2;
        g[4][3] = 15.0 * s2 * c;
        g[5][3] = 7.5 * (7.0 * c2 - 1.0) * s2;
        g[6][3] = 3.0 * c * g[5][3] - 2.0 * g[4][3];
        g[7][3] = (11.0 * c * g[6][3] - 7.0 * g[5][3]) / 4.0;
        g[8][3] = (13.0 * c * g[7][3] - 8.0 * g[6][3]) / 5.0;
        g[4][4] = 15.0 * s2 * s;
        g[5][4] = 105.0 * s2 * s * c;
        g[6][4] = (9.0 * c * g[5][4] - 7.0 * g[4][4]) / 2.0;
        g[7][4] = (11.0 * c * g[6][4] - 8.0 * g[5][4]) / 3.0;
        let g = self.plg;
        self.stloc = fmath::sin(HR * tloc);
        self.ctloc = fmath::cos(HR * tloc);
        self.s2tloc = fmath::sin(2.0 * HR * tloc);
        self.c2tloc = fmath::cos(2.0 * HR * tloc);
        self.s3tloc = fmath::sin(3.0 * HR * tloc);
        self.c3tloc = fmath::cos(3.0 * HR * tloc);
        let day = self.day;
        let cd14 = fmath::cos(DR * (day - p(14)));
        let cd18 = fmath::cos(2.0 * DR * (day - p(18)));
        let cd32 = fmath::cos(DR * (day - p(32)));
        let cd39 = fmath::cos(2.0 * DR * (day - p(39)));
        let df = f107 - f107a;
        let dfa = f107a - 150.0;
        self.dfa = dfa;
        let swc = 1.0; // all switches on
        t[1] = p(20) * df * (1.0 + p(60) * dfa) + p(21) * df * df + p(22) * dfa + p(30) * dfa * dfa;
        let f1 = 1.0 + (p(48) * dfa + p(20) * df + p(21) * df * df) * swc;
        let f2 = 1.0 + (p(50) * dfa + p(20) * df + p(21) * df * df) * swc;
        t[2] = (p(2) * g[3][1] + p(3) * g[5][1] + p(23) * g[7][1])
            + (p(15) * g[3][1]) * dfa * swc
            + p(27) * g[2][1];
        t[3] = p(19) * cd32;
        t[4] = (p(16) + p(17) * g[3][1]) * cd18;
        t[5] = f1 * (p(10) * g[2][1] + p(11) * g[4][1]) * cd14;
        t[6] = p(38) * g[2][1] * cd39;
        let t71 = (p(12) * g[3][2]) * cd14 * swc;
        let t72 = (p(13) * g[3][2]) * cd14 * swc;
        t[7] = f2
            * ((p(4) * g[2][2] + p(5) * g[4][2] + p(28) * g[6][2] + t71) * self.ctloc
                + (p(7) * g[2][2] + p(8) * g[4][2] + p(29) * g[6][2] + t72) * self.stloc);
        let t81 = (p(24) * g[4][3] + p(36) * g[6][3]) * cd14 * swc;
        let t82 = (p(34) * g[4][3] + p(37) * g[6][3]) * cd14 * swc;
        t[8] = f2
            * ((p(6) * g[3][3] + p(42) * g[5][3] + t81) * self.c2tloc
                + (p(9) * g[3][3] + p(43) * g[5][3] + t82) * self.s2tloc);
        t[14] = f2
            * ((p(40) * g[4][4] + (p(94) * g[5][4] + p(47) * g[7][4]) * cd14 * swc) * self.s3tloc
                + (p(41) * g[4][4] + (p(95) * g[5][4] + p(49) * g[7][4]) * cd14 * swc)
                    * self.c3tloc);
        // Daily Ap (switch 9 = +1).
        let apd = ap - 4.0;
        let mut p44 = p(44);
        let p45 = p(45);
        if p44 < 0.0 {
            p44 = 1e-5;
        }
        self.apdf = apd + (p45 - 1.0) * (apd + (fmath::exp(-p44 * apd) - 1.0) / p44);
        let apdf = self.apdf;
        t[9] = apdf
            * (p(33)
                + p(46) * g[3][1]
                + p(35) * g[5][1]
                + (p(101) * g[2][1] + p(102) * g[4][1] + p(103) * g[6][1]) * cd14 * swc
                + (p(122) * g[2][2] + p(123) * g[4][2] + p(124) * g[6][2])
                    * swc
                    * fmath::cos(HR * (tloc - p(125))));
        if long > -1000.0 {
            t[11] = (1.0 + p(81) * dfa * swc)
                * ((p(65) * g[3][2]
                    + p(66) * g[5][2]
                    + p(67) * g[7][2]
                    + p(104) * g[2][2]
                    + p(105) * g[4][2]
                    + p(106) * g[6][2]
                    + swc * (p(110) * g[2][2] + p(111) * g[4][2] + p(112) * g[6][2]) * cd14)
                    * fmath::cos(DGTR * long)
                    + (p(91) * g[3][2]
                        + p(92) * g[5][2]
                        + p(93) * g[7][2]
                        + p(107) * g[2][2]
                        + p(108) * g[4][2]
                        + p(109) * g[6][2]
                        + swc * (p(113) * g[2][2] + p(114) * g[4][2] + p(115) * g[6][2]) * cd14)
                        * fmath::sin(DGTR * long));
            t[12] = (1.0 + p(96) * g[2][1])
                * (1.0 + p(82) * dfa * swc)
                * (1.0 + p(120) * g[2][1] * swc * cd14)
                * ((p(69) * g[2][1] + p(70) * g[4][1] + p(71) * g[6][1])
                    * fmath::cos(SR * (sec - p(72))));
            t[12] += swc
                * (p(77) * g[4][3] + p(78) * g[6][3] + p(79) * g[8][3])
                * fmath::cos(SR * (sec - p(80)) + 2.0 * DGTR * long)
                * (1.0 + p(138) * dfa * swc);
            t[13] = apdf
                * swc
                * (1.0 + p(121) * g[2][1])
                * ((p(61) * g[3][2] + p(62) * g[5][2] + p(63) * g[7][2])
                    * fmath::cos(DGTR * (long - p(64))))
                + apdf
                    * swc
                    * swc
                    * (p(116) * g[2][2] + p(117) * g[4][2] + p(118) * g[6][2])
                    * cd14
                    * fmath::cos(DGTR * (long - p(119)))
                + apdf
                    * swc
                    * (p(84) * g[2][1] + p(85) * g[4][1] + p(86) * g[6][1])
                    * fmath::cos(SR * (sec - p(76)));
        }
        let mut tinf = p(31);
        for ti in &t[1..=14] {
            tinf += ti;
        }
        tinf
    }

    /// GLOB7S: G(L) for the lower atmosphere. `p` is a 100-element parameter set.
    /// Uses the Legendre/time state left by the preceding GLOBE7 call.
    fn glob7s(&self, p: &[f64]) -> f64 {
        let p = |i: usize| p[i - 1];
        let g = &self.plg;
        let day = self.day;
        let swc = 1.0;
        let cd32 = fmath::cos(DR * (day - p(32)));
        let cd18 = fmath::cos(2.0 * DR * (day - p(18)));
        let cd14 = fmath::cos(DR * (day - p(14)));
        let cd39 = fmath::cos(2.0 * DR * (day - p(39)));
        let mut t = [0.0f64; 15];
        t[1] = p(22) * self.dfa;
        t[2] = p(2) * g[3][1]
            + p(3) * g[5][1]
            + p(23) * g[7][1]
            + p(27) * g[2][1]
            + p(15) * g[4][1]
            + p(60) * g[6][1];
        t[3] = (p(19) + p(48) * g[3][1] + p(30) * g[5][1]) * cd32;
        t[4] = (p(16) + p(17) * g[3][1] + p(31) * g[5][1]) * cd18;
        t[5] = (p(10) * g[2][1] + p(11) * g[4][1] + p(21) * g[6][1]) * cd14;
        t[6] = (p(38) * g[2][1]) * cd39;
        let t71 = p(12) * g[3][2] * cd14 * swc;
        let t72 = p(13) * g[3][2] * cd14 * swc;
        t[7] = (p(4) * g[2][2] + p(5) * g[4][2] + t71) * self.ctloc
            + (p(7) * g[2][2] + p(8) * g[4][2] + t72) * self.stloc;
        let t81 = (p(24) * g[4][3] + p(36) * g[6][3]) * cd14 * swc;
        let t82 = (p(34) * g[4][3] + p(37) * g[6][3]) * cd14 * swc;
        t[8] = (p(6) * g[3][3] + p(42) * g[5][3] + t81) * self.c2tloc
            + (p(9) * g[3][3] + p(43) * g[5][3] + t82) * self.s2tloc;
        t[14] = p(40) * g[4][4] * self.s3tloc + p(41) * g[4][4] * self.c3tloc;
        t[9] = self.apdf * (p(33) + p(46) * g[3][1] * swc);
        if self.long > -1000.0 {
            t[11] = (1.0
                + g[2][1]
                    * (p(81) * swc * fmath::cos(DR * (day - p(82)))
                        + p(86) * swc * fmath::cos(2.0 * DR * (day - p(87))))
                + p(84) * swc * fmath::cos(DR * (day - p(85)))
                + p(88) * swc * fmath::cos(2.0 * DR * (day - p(89))))
                * ((p(65) * g[3][2]
                    + p(66) * g[5][2]
                    + p(67) * g[7][2]
                    + p(75) * g[2][2]
                    + p(76) * g[4][2]
                    + p(77) * g[6][2])
                    * fmath::cos(DGTR * self.long)
                    + (p(91) * g[3][2]
                        + p(92) * g[5][2]
                        + p(93) * g[7][2]
                        + p(78) * g[2][2]
                        + p(79) * g[4][2]
                        + p(80) * g[6][2])
                        * fmath::sin(DGTR * self.long));
        }
        t[1..=14].iter().sum()
    }

    /// GLATF: latitude-dependent surface gravity (cm/s²) and effective radius (km).
    fn glatf(&mut self, lat: f64) {
        let c2 = fmath::cos(2.0 * DGTR * lat);
        self.gsurf = 980.616 * (1.0 - 0.0026373 * c2);
        self.re = 2.0 * self.gsurf / (3.085462e-6 + 2.27e-9 * c2) * 1e-5;
    }

    fn scalh(&self, alt: f64, xm: f64, temp: f64) -> f64 {
        let g = self.gsurf / ((1.0 + alt / self.re) * (1.0 + alt / self.re));
        RGAS * temp / (g * xm)
    }

    /// DENSU: Bates temperature profile above ZA, spline below; diffusive density.
    /// Returns (density, temperature at `alt`). Updates tn1[1] and tgn1[1] like the Fortran.
    #[allow(clippy::too_many_arguments)]
    fn densu(
        &self,
        alt: f64,
        dlb: f64,
        tinf: f64,
        tlb: f64,
        xm: f64,
        alpha: f64,
        zlb: f64,
        s2: f64,
        zn1: &[f64; 6],
        tn1: &mut [f64; 6],
        tgn1: &mut [f64; 3],
    ) -> (f64, f64) {
        let re = self.re;
        let zeta = |zz: f64, zl: f64| (zz - zl) * (re + zl) / (re + zz);
        let za = zn1[1];
        let mut z = alt.max(za);
        let zg2 = zeta(z, zlb);
        let tt = tinf - (tinf - tlb) * fmath::exp(-s2 * zg2);
        let ta = tt;
        let mut tz = tt;
        let mut densu = tz;
        // Spline nodes, used below ZA.
        let mn = 5usize;
        let (mut xs, mut ys, mut y2out) = ([0.0f64; 6], [0.0f64; 6], [0.0f64; 6]);
        let (mut zgdif, mut x, mut t1, mut z1) = (0.0, 0.0, 0.0, 0.0);
        if alt < za {
            let dta = (tinf - ta) * s2 * ((re + zlb) / (re + za)) * ((re + zlb) / (re + za));
            tgn1[1] = dta;
            tn1[1] = ta;
            z = alt.max(zn1[mn]);
            z1 = zn1[1];
            let z2 = zn1[mn];
            t1 = tn1[1];
            let t2 = tn1[mn];
            let zg = zeta(z, z1);
            zgdif = zeta(z2, z1);
            for k in 1..=mn {
                xs[k] = zeta(zn1[k], z1) / zgdif;
                ys[k] = 1.0 / tn1[k];
            }
            let yd1 = -tgn1[1] / (t1 * t1) * zgdif;
            let yd2 =
                -tgn1[2] / (t2 * t2) * zgdif * ((re + z2) / (re + z1)) * ((re + z2) / (re + z1));
            spline(&xs, &ys, mn, yd1, yd2, &mut y2out);
            x = zg / zgdif;
            let y = splint(&xs, &ys, &y2out, mn, x);
            tz = 1.0 / y;
            densu = tz;
        }
        if xm == 0.0 {
            return (densu, tz);
        }
        let glb = self.gsurf / ((1.0 + zlb / re) * (1.0 + zlb / re));
        let gamma = xm * glb / (s2 * RGAS * tinf);
        let mut expl = fmath::exp(-s2 * gamma * zg2);
        if expl > 50.0 || tt <= 0.0 {
            expl = 50.0;
        }
        let densa = dlb * fmath::pow(tlb / tt, 1.0 + alpha + gamma) * expl;
        densu = densa;
        if alt >= za {
            return (densu, tz);
        }
        let glb = self.gsurf / ((1.0 + z1 / re) * (1.0 + z1 / re));
        let gamm = xm * glb * zgdif / RGAS;
        let yi = splini(&xs, &ys, &y2out, mn, x);
        let mut expl = gamm * yi;
        if expl > 50.0 || tz <= 0.0 {
            expl = 50.0;
        }
        densu *= fmath::pow(t1 / tz, 1.0 + alpha) * fmath::exp(-expl);
        (densu, tz)
    }
}

/// SPLINE (Numerical Recipes): second derivatives of the interpolating cubic spline.
/// Arrays are 1-based (index 0 unused).
fn spline(x: &[f64; 6], y: &[f64; 6], n: usize, yp1: f64, ypn: f64, y2: &mut [f64; 6]) {
    let mut u = [0.0f64; 6];
    if yp1 > 0.99e30 {
        y2[1] = 0.0;
        u[1] = 0.0;
    } else {
        y2[1] = -0.5;
        u[1] = (3.0 / (x[2] - x[1])) * ((y[2] - y[1]) / (x[2] - x[1]) - yp1);
    }
    for i in 2..n {
        let sig = (x[i] - x[i - 1]) / (x[i + 1] - x[i - 1]);
        let p = sig * y2[i - 1] + 2.0;
        y2[i] = (sig - 1.0) / p;
        u[i] = (6.0
            * ((y[i + 1] - y[i]) / (x[i + 1] - x[i]) - (y[i] - y[i - 1]) / (x[i] - x[i - 1]))
            / (x[i + 1] - x[i - 1])
            - sig * u[i - 1])
            / p;
    }
    let (qn, un) = if ypn > 0.99e30 {
        (0.0, 0.0)
    } else {
        (
            0.5,
            (3.0 / (x[n] - x[n - 1])) * (ypn - (y[n] - y[n - 1]) / (x[n] - x[n - 1])),
        )
    };
    y2[n] = (un - qn * u[n - 1]) / (qn * y2[n - 1] + 1.0);
    for k in (1..n).rev() {
        y2[k] = y2[k] * y2[k + 1] + u[k];
    }
}

/// SPLINT: cubic spline interpolation.
fn splint(xa: &[f64; 6], ya: &[f64; 6], y2a: &[f64; 6], n: usize, x: f64) -> f64 {
    let (mut klo, mut khi) = (1usize, n);
    while khi - klo > 1 {
        let k = (khi + klo) / 2;
        if xa[k] > x {
            khi = k;
        } else {
            klo = k;
        }
    }
    let h = xa[khi] - xa[klo];
    let a = (xa[khi] - x) / h;
    let b = (x - xa[klo]) / h;
    a * ya[klo]
        + b * ya[khi]
        + ((a * a * a - a) * y2a[klo] + (b * b * b - b) * y2a[khi]) * h * h / 6.0
}

/// SPLINI: integral of the cubic spline from xa[1] to x.
fn splini(xa: &[f64; 6], ya: &[f64; 6], y2a: &[f64; 6], n: usize, x: f64) -> f64 {
    let mut yi = 0.0;
    let (mut klo, mut khi) = (1usize, 2usize);
    while x > xa[klo] && khi <= n {
        let xx = if khi < n { x.min(xa[khi]) } else { x };
        let h = xa[khi] - xa[klo];
        let a = (xa[khi] - xx) / h;
        let b = (xx - xa[klo]) / h;
        let a2 = a * a;
        let b2 = b * b;
        yi += ((1.0 - a2) * ya[klo] / 2.0
            + b2 * ya[khi] / 2.0
            + ((-(1.0 + a2 * a2) / 4.0 + a2 / 2.0) * y2a[klo]
                + (b2 * b2 / 4.0 - b2 / 2.0) * y2a[khi])
                * h
                * h
                / 6.0)
            * h;
        klo += 1;
        khi += 1;
    }
    yi
}

/// DNET: turbopause correction combining diffusive and mixed densities.
fn dnet(dd: f64, dm: f64, zhm: f64, xmm: f64, xm: f64) -> f64 {
    let a = zhm / (xmm - xm);
    if !(dm > 0.0 && dd > 0.0) {
        if dd == 0.0 && dm == 0.0 {
            return 1.0;
        }
        if dm == 0.0 {
            return dd;
        }
        return dm;
    }
    let ylog = a * fmath::ln(dm / dd);
    if ylog < -10.0 {
        dd
    } else if ylog > 10.0 {
        dm
    } else {
        dd * fmath::pow(1.0 + fmath::exp(ylog), 1.0 / a)
    }
}

/// CCOR: chemistry/dissociation correction.
fn ccor(alt: f64, r: f64, h1: f64, zh: f64) -> f64 {
    let e = (alt - zh) / h1;
    let c = if e > 70.0 {
        0.0
    } else if e < -70.0 {
        r
    } else {
        r / (1.0 + fmath::exp(e))
    };
    fmath::exp(c)
}

/// CCOR2: O and O2 chemistry/dissociation correction with two scale heights.
fn ccor2(alt: f64, r: f64, h1: f64, zh: f64, h2: f64) -> f64 {
    let e1 = (alt - zh) / h1;
    let e2 = (alt - zh) / h2;
    let c = if e1 > 70.0 || e2 > 70.0 {
        0.0
    } else if e1 < -70.0 && e2 < -70.0 {
        r
    } else {
        r / (1.0 + 0.5 * (fmath::exp(e1) + fmath::exp(e2)))
    };
    fmath::exp(c)
}

/// GTD7D for altitudes ≥ 72.5 km: neutral densities and temperatures, with the total
/// mass density including anomalous oxygen. Returns `None` below 72.5 km.
pub fn gtd7d(inp: &MsisInput) -> Option<MsisOutput> {
    if inp.alt_km.is_nan() || inp.alt_km < 72.5 {
        return None;
    }
    let mut ctx = Ctx {
        plg: [[0.0; 5]; 10],
        ctloc: 0.0,
        stloc: 0.0,
        c2tloc: 0.0,
        s2tloc: 0.0,
        c3tloc: 0.0,
        s3tloc: 0.0,
        day: 0.0,
        dfa: 0.0,
        apdf: 0.0,
        long: 0.0,
        gsurf: 0.0,
        re: 0.0,
    };
    ctx.glatf(inp.glat);
    let mut out = gts7(&mut ctx, inp);
    out.d[5] += 1.66e-24 * 16.0 * out.d[8];
    Some(out)
}

/// GTS7: thermospheric portion of NRLMSISE-00, for all species (MASS = 48).
fn gts7(ctx: &mut Ctx, inp: &MsisInput) -> MsisOutput {
    let (yrd, sec, alt, glat, glong, stl, f107a, f107, ap) = (
        inp.doy, inp.sec, inp.alt_km, inp.glat, inp.glong, inp.stl, inp.f107a, inp.f107, inp.ap,
    );
    const ALPHA: [f64; 10] = [0.0, -0.38, 0.0, 0.0, 0.0, 0.17, 0.0, -0.38, 0.0, 0.0];
    const ALTL: [f64; 9] = [0.0, 200.0, 300.0, 160.0, 250.0, 240.0, 450.0, 320.0, 450.0];
    let za = pdl(16, 2);
    let zn1: [f64; 6] = [0.0, za, 110.0, 100.0, 90.0, 72.5];
    let mut tn1 = [0.0f64; 6];
    let mut tgn1 = [0.0f64; 3];
    let mut d = [0.0f64; 10];

    let tinf = if alt > zn1[1] {
        ptm(1) * PT[0] * (1.0 + ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, &PT))
    } else {
        ptm(1) * PT[0]
    };
    let g0 = if alt > zn1[5] {
        ptm(4) * PS[0] * (1.0 + ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, &PS))
    } else {
        ptm(4) * PS[0]
    };
    let tlb = ptm(2)
        * (1.0 + ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(4)))
        * pd(1, 4);
    let s = g0 / (tinf - tlb);
    if alt < 300.0 {
        tn1[2] = ptm(7) * ptl(1, 1) / (1.0 - ctx.glob7s(ptl_col(1)));
        tn1[3] = ptm(3) * ptl(1, 2) / (1.0 - ctx.glob7s(ptl_col(2)));
        tn1[4] = ptm(8) * ptl(1, 3) / (1.0 - ctx.glob7s(ptl_col(3)));
        tn1[5] = ptm(5) * ptl(1, 4) / (1.0 - ctx.glob7s(ptl_col(4)));
        tgn1[2] = ptm(9) * pma(1, 9) * (1.0 + ctx.glob7s(pma_col(9))) * tn1[5] * tn1[5]
            / ((ptm(5) * ptl(1, 4)) * (ptm(5) * ptl(1, 4)));
    } else {
        tn1[2] = ptm(7) * ptl(1, 1);
        tn1[3] = ptm(3) * ptl(1, 2);
        tn1[4] = ptm(8) * ptl(1, 3);
        tn1[5] = ptm(5) * ptl(1, 4);
        tgn1[2] =
            ptm(9) * pma(1, 9) * tn1[5] * tn1[5] / ((ptm(5) * ptl(1, 4)) * (ptm(5) * ptl(1, 4)));
    }

    let g28 = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(3));
    let day = yrd % 1000.0;
    let zhf =
        pdl(25, 2) * (1.0 + pdl(25, 1) * fmath::sin(DGTR * glat) * fmath::cos(DR * (day - PT[13])));
    let xmm = pdm(5, 3);
    let z = alt;
    let ptm6 = ptm(6);
    let du = |ctx: &Ctx,
              alt: f64,
              dlb: f64,
              ti: f64,
              tl: f64,
              xm: f64,
              a: f64,
              tn1: &mut [f64; 6],
              tgn1: &mut [f64; 3]| {
        ctx.densu(alt, dlb, ti, tl, xm, a, ptm6, s, &zn1, tn1, tgn1)
    };

    // N2
    let db28 = pdm(1, 3) * fmath::exp(g28) * pd(1, 3);
    let (d3, t2) = du(ctx, z, db28, tinf, tlb, 28.0, ALPHA[3], &mut tn1, &mut tgn1);
    d[3] = d3;
    let zh28 = pdm(3, 3) * zhf;
    let zhm28 = pdm(4, 3) * pdl(6, 2);
    let xmd = 28.0 - xmm;
    let (b28, _) = du(
        ctx,
        zh28,
        db28,
        tinf,
        tlb,
        xmd,
        ALPHA[3] - 1.0,
        &mut tn1,
        &mut tgn1,
    );
    if z <= ALTL[3] {
        let (dm28, _) = du(ctx, z, b28, tinf, tlb, xmm, ALPHA[3], &mut tn1, &mut tgn1);
        d[3] = dnet(d[3], dm28, zhm28, xmm, 28.0);
    }

    // He
    let g4 = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(1));
    let db04 = pdm(1, 1) * fmath::exp(g4) * pd(1, 1);
    d[1] = du(ctx, z, db04, tinf, tlb, 4.0, ALPHA[1], &mut tn1, &mut tgn1).0;
    if z <= ALTL[1] {
        let zh04 = pdm(3, 1);
        let (b04, _) = du(
            ctx,
            zh04,
            db04,
            tinf,
            tlb,
            4.0 - xmm,
            ALPHA[1] - 1.0,
            &mut tn1,
            &mut tgn1,
        );
        let (dm04, _) = du(ctx, z, b04, tinf, tlb, xmm, 0.0, &mut tn1, &mut tgn1);
        d[1] = dnet(d[1], dm04, zhm28, xmm, 4.0);
        let rl = fmath::ln(b28 * pdm(2, 1) / b04);
        let zc04 = pdm(5, 1) * pdl(1, 2);
        let hc04 = pdm(6, 1) * pdl(2, 2);
        d[1] *= ccor(z, rl, hc04, zc04);
    }

    // O
    let g16 = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(2));
    let db16 = pdm(1, 2) * fmath::exp(g16) * pd(1, 2);
    d[2] = du(ctx, z, db16, tinf, tlb, 16.0, ALPHA[2], &mut tn1, &mut tgn1).0;
    if z <= ALTL[2] {
        let zh16 = pdm(3, 2);
        let (b16, _) = du(
            ctx,
            zh16,
            db16,
            tinf,
            tlb,
            16.0 - xmm,
            ALPHA[2] - 1.0,
            &mut tn1,
            &mut tgn1,
        );
        let (dm16, _) = du(ctx, z, b16, tinf, tlb, xmm, 0.0, &mut tn1, &mut tgn1);
        d[2] = dnet(d[2], dm16, zhm28, xmm, 16.0);
        let rl = pdm(2, 2) * pdl(17, 2) * (1.0 + pdl(24, 1) * (f107a - 150.0));
        let hc16 = pdm(6, 2) * pdl(4, 2);
        let zc16 = pdm(5, 2) * pdl(3, 2);
        let hc216 = pdm(6, 2) * pdl(5, 2);
        d[2] *= ccor2(z, rl, hc16, zc16, hc216);
        let hcc16 = pdm(8, 2) * pdl(14, 2);
        let zcc16 = pdm(7, 2) * pdl(13, 2);
        let rc16 = pdm(4, 2) * pdl(15, 2);
        d[2] *= ccor(z, rc16, hcc16, zcc16);
    }

    // O2
    let g32 = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(5));
    let db32 = pdm(1, 4) * fmath::exp(g32) * pd(1, 5);
    d[4] = du(ctx, z, db32, tinf, tlb, 32.0, ALPHA[4], &mut tn1, &mut tgn1).0;
    if z <= ALTL[4] {
        let zh32 = pdm(3, 4);
        let (b32, _) = du(
            ctx,
            zh32,
            db32,
            tinf,
            tlb,
            32.0 - xmm,
            ALPHA[4] - 1.0,
            &mut tn1,
            &mut tgn1,
        );
        let (dm32, _) = du(ctx, z, b32, tinf, tlb, xmm, 0.0, &mut tn1, &mut tgn1);
        d[4] = dnet(d[4], dm32, zhm28, xmm, 32.0);
        let rl = fmath::ln(b28 * pdm(2, 4) / b32);
        let hc32 = pdm(6, 4) * pdl(8, 2);
        let zc32 = pdm(5, 4) * pdl(7, 2);
        d[4] *= ccor(z, rl, hc32, zc32);
    }
    let hcc32 = pdm(8, 4) * pdl(23, 2);
    let hcc232 = pdm(8, 4) * pdl(23, 1);
    let zcc32 = pdm(7, 4) * pdl(22, 2);
    let rc32 = pdm(4, 4) * pdl(24, 2) * (1.0 + pdl(24, 1) * (f107a - 150.0));
    d[4] *= ccor2(z, rc32, hcc32, zcc32, hcc232);

    // Ar
    let g40 = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(6));
    let db40 = pdm(1, 5) * fmath::exp(g40) * pd(1, 6);
    d[5] = du(ctx, z, db40, tinf, tlb, 40.0, ALPHA[5], &mut tn1, &mut tgn1).0;
    if z <= ALTL[5] {
        let zh40 = pdm(3, 5);
        let (b40, _) = du(
            ctx,
            zh40,
            db40,
            tinf,
            tlb,
            40.0 - xmm,
            ALPHA[5] - 1.0,
            &mut tn1,
            &mut tgn1,
        );
        let (dm40, _) = du(ctx, z, b40, tinf, tlb, xmm, 0.0, &mut tn1, &mut tgn1);
        d[5] = dnet(d[5], dm40, zhm28, xmm, 40.0);
        let rl = fmath::ln(b28 * pdm(2, 5) / b40);
        let hc40 = pdm(6, 5) * pdl(10, 2);
        let zc40 = pdm(5, 5) * pdl(9, 2);
        d[5] *= ccor(z, rl, hc40, zc40);
    }

    // H
    let g1 = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(7));
    let db01 = pdm(1, 6) * fmath::exp(g1) * pd(1, 7);
    d[7] = du(ctx, z, db01, tinf, tlb, 1.0, ALPHA[7], &mut tn1, &mut tgn1).0;
    if z <= ALTL[7] {
        let zh01 = pdm(3, 6);
        let (b01, _) = du(
            ctx,
            zh01,
            db01,
            tinf,
            tlb,
            1.0 - xmm,
            ALPHA[7] - 1.0,
            &mut tn1,
            &mut tgn1,
        );
        let (dm01, _) = du(ctx, z, b01, tinf, tlb, xmm, 0.0, &mut tn1, &mut tgn1);
        d[7] = dnet(d[7], dm01, zhm28, xmm, 1.0);
        let rl = fmath::ln(b28 * pdm(2, 6) * pdl(18, 2).abs() / b01);
        let hc01 = pdm(6, 6) * pdl(12, 2);
        let zc01 = pdm(5, 6) * pdl(11, 2);
        d[7] *= ccor(z, rl, hc01, zc01);
        let hcc01 = pdm(8, 6) * pdl(20, 2);
        let zcc01 = pdm(7, 6) * pdl(19, 2);
        let rc01 = pdm(4, 6) * pdl(21, 2);
        d[7] *= ccor(z, rc01, hcc01, zcc01);
    }

    // N
    let g14 = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(8));
    let db14 = pdm(1, 7) * fmath::exp(g14) * pd(1, 8);
    d[8] = du(ctx, z, db14, tinf, tlb, 14.0, ALPHA[8], &mut tn1, &mut tgn1).0;
    if z <= ALTL[8] {
        let zh14 = pdm(3, 7);
        let (b14, _) = du(
            ctx,
            zh14,
            db14,
            tinf,
            tlb,
            14.0 - xmm,
            ALPHA[8] - 1.0,
            &mut tn1,
            &mut tgn1,
        );
        let (dm14, _) = du(ctx, z, b14, tinf, tlb, xmm, 0.0, &mut tn1, &mut tgn1);
        d[8] = dnet(d[8], dm14, zhm28, xmm, 14.0);
        let rl = fmath::ln(b28 * pdm(2, 7) * pdl(3, 1).abs() / b14);
        let hc14 = pdm(6, 7) * pdl(2, 1);
        let zc14 = pdm(5, 7) * pdl(1, 1);
        d[8] *= ccor(z, rl, hc14, zc14);
        let hcc14 = pdm(8, 7) * pdl(5, 1);
        let zcc14 = pdm(7, 7) * pdl(4, 1);
        let rc14 = pdm(4, 7) * pdl(6, 1);
        d[8] *= ccor(z, rc14, hcc14, zcc14);
    }

    // Anomalous (hot) oxygen.
    let g16h = ctx.globe7(yrd, sec, glat, glong, stl, f107a, f107, ap, pd_col(9));
    let db16h = pdm(1, 8) * fmath::exp(g16h) * pd(1, 9);
    let tho = pdm(10, 8) * pdl(7, 1);
    let (dd, _) = du(ctx, z, db16h, tho, tho, 16.0, ALPHA[9], &mut tn1, &mut tgn1);
    let zsht = pdm(6, 8);
    let zmho = pdm(5, 8);
    let zsho = ctx.scalh(zmho, 16.0, tho);
    d[9] = dd * fmath::exp(-zsht / zsho * (fmath::exp(-(z - zmho) / zsht) - 1.0));

    // Total mass density (GTD7; GTD7D adds the hot O term).
    d[6] = 1.66e-24
        * (4.0 * d[1] + 16.0 * d[2] + 28.0 * d[3] + 32.0 * d[4] + 40.0 * d[5] + d[7] + 14.0 * d[8]);
    MsisOutput {
        d: [d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9]],
        t: [tinf, t2],
    }
}
