//! DOP853: explicit Runge–Kutta of order 8 with embedded 5th- and 3rd-order error
//! estimators and 7th-order dense output.
//!
//! E. Hairer, S. P. Nørsett, G. Wanner, *Solving Ordinary Differential Equations I*,
//! 2nd ed., Springer (1993), §II.10. Ported from Hairer's `dop853.f` (version of
//! 2004). Copyright (c) 2004, UNIGE. BSD-2-Clause; see third_party/HAIRER-LICENSE.txt.
//!
//! Differences from the Fortran:
//! - Generic over a fixed state size `N`. The right-hand side is a closure.
//! - Dense output is always produced, and every accepted step is handed to a
//!   callback. The propagator stores the steps (trajectory) and does event detection on
//!   them, so rendering and warp never influence the step sequence.
//! - No stiffness detection. Orbital problems aren't stiff, and the Fortran only
//!   uses it to emit a warning.
//! - Arithmetic follows the Fortran's order, and all powers go through `fmath`,
//!   so results are deterministic across platforms.

// Coefficients are copied verbatim (30 digits) from dop853.f.
#![allow(clippy::excessive_precision)]

use crate::math::fmath;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dop853Options {
    /// Relative and absolute tolerance on each component.
    pub rtol: f64,
    pub atol: f64,
    /// Maximum step size, s. Use `f64::INFINITY` for none.
    pub h_max: f64,
    /// Maximum number of steps per call.
    pub max_steps: usize,
    /// If true, the last step is not shortened to land on `t_end`: integration stops at
    /// the first natural step end ≥ `t_end`. A trajectory extended later from that
    /// point then has exactly the step sequence of one long run. This is what makes
    /// chunked propagation (and so time warp) bit-identical.
    pub overshoot: bool,
}

impl Default for Dop853Options {
    fn default() -> Dop853Options {
        Dop853Options {
            rtol: 1e-12,
            atol: 1e-12,
            h_max: f64::INFINITY,
            max_steps: 10_000_000,
            overshoot: false,
        }
    }
}

/// One accepted step with its dense-output polynomial (8 coefficient vectors).
#[derive(Clone, Debug, PartialEq)]
pub struct DenseStep<const N: usize> {
    pub t0: f64,
    pub h: f64,
    pub cont: [[f64; N]; 8],
    /// The step's end state, exactly as the integrator computed it. The dense polynomial
    /// at s = 1 reproduces it only to rounding, so restarts continue from this value.
    pub y1: [f64; N],
}

impl<const N: usize> DenseStep<N> {
    pub fn t1(&self) -> f64 {
        self.t0 + self.h
    }

    /// Interpolated state at `t` in [t0, t0 + h] (Fortran `CONTD8`). Exactly the end
    /// state at t = t0 + h.
    pub fn eval(&self, t: f64) -> [f64; N] {
        if t == self.t1() {
            return self.y1;
        }
        let s = (t - self.t0) / self.h;
        let s1 = 1.0 - s;
        let c = &self.cont;
        let mut y = [0.0; N];
        for i in 0..N {
            let conpar = c[4][i] + s * (c[5][i] + s1 * (c[6][i] + s * c[7][i]));
            y[i] = c[0][i] + s * (c[1][i] + s1 * (c[2][i] + s * (c[3][i] + s1 * conpar)));
        }
        y
    }
}

/// What the step callback wants next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepControl {
    Continue,
    /// Stop after this step (the caller handles the event inside it).
    Stop,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Integration<const N: usize> {
    pub t: f64,
    pub y: [f64; N],
    pub accepted: usize,
    pub rejected: usize,
    pub evaluations: usize,
    /// Step size proposed for the next step: pass it back in to continue seamlessly.
    pub h_next: f64,
    pub stopped_by_callback: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum IntegratorError {
    TooManySteps { t: f64 },
    StepTooSmall { t: f64, h: f64 },
    NonFinite { t: f64 },
}

impl core::fmt::Display for IntegratorError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            IntegratorError::TooManySteps { t } => {
                write!(f, "too many integration steps (stopped at t = {t} s)")
            }
            IntegratorError::StepTooSmall { t, h } => {
                write!(f, "step size underflow at t = {t} s (h = {h})")
            }
            IntegratorError::NonFinite { t } => write!(f, "non-finite state at t = {t} s"),
        }
    }
}

impl std::error::Error for IntegratorError {}

// Coefficients from dop853.f (Hairer), subroutine DP86CO.
const C2: f64 = 0.526001519587677318785587544488e-01;
const C3: f64 = 0.789002279381515978178381316732e-01;
const C4: f64 = 0.118350341907227396726757197510e+00;
const C5: f64 = 0.281649658092772603273242802490e+00;
const C6: f64 = 0.333333333333333333333333333333e+00;
const C7: f64 = 0.25e+00;
const C8: f64 = 0.307692307692307692307692307692e+00;
const C9: f64 = 0.651282051282051282051282051282e+00;
const C10: f64 = 0.6e+00;
const C11: f64 = 0.857142857142857142857142857142e+00;
const C14: f64 = 0.1e+00;
const C15: f64 = 0.2e+00;
const C16: f64 = 0.777777777777777777777777777778e+00;

const B1: f64 = 5.42937341165687622380535766363e-2;
const B6: f64 = 4.45031289275240888144113950566e0;
const B7: f64 = 1.89151789931450038304281599044e0;
const B8: f64 = -5.8012039600105847814672114227e0;
const B9: f64 = 3.1116436695781989440891606237e-1;
const B10: f64 = -1.52160949662516078556178806805e-1;
const B11: f64 = 2.01365400804030348374776537501e-1;
const B12: f64 = 4.47106157277725905176885569043e-2;

const BHH1: f64 = 0.244094488188976377952755905512e+00;
const BHH2: f64 = 0.733846688281611857341361741547e+00;
const BHH3: f64 = 0.220588235294117647058823529412e-01;

const ER1: f64 = 0.1312004499419488073250102996e-01;
const ER6: f64 = -0.1225156446376204440720569753e+01;
const ER7: f64 = -0.4957589496572501915214079952e+00;
const ER8: f64 = 0.1664377182454986536961530415e+01;
const ER9: f64 = -0.3503288487499736816886487290e+00;
const ER10: f64 = 0.3341791187130174790297318841e+00;
const ER11: f64 = 0.8192320648511571246570742613e-01;
const ER12: f64 = -0.2235530786388629525884427845e-01;

const A21: f64 = 5.26001519587677318785587544488e-2;
const A31: f64 = 1.97250569845378994544595329183e-2;
const A32: f64 = 5.91751709536136983633785987549e-2;
const A41: f64 = 2.95875854768068491816892993775e-2;
const A43: f64 = 8.87627564304205475450678981324e-2;
const A51: f64 = 2.41365134159266685502369798665e-1;
const A53: f64 = -8.84549479328286085344864962717e-1;
const A54: f64 = 9.24834003261792003115737966543e-1;
const A61: f64 = 3.7037037037037037037037037037e-2;
const A64: f64 = 1.70828608729473871279604482173e-1;
const A65: f64 = 1.25467687566822425016691814123e-1;
const A71: f64 = 3.7109375e-2;
const A74: f64 = 1.70252211019544039314978060272e-1;
const A75: f64 = 6.02165389804559606850219397283e-2;
const A76: f64 = -1.7578125e-2;
const A81: f64 = 3.70920001185047927108779319836e-2;
const A84: f64 = 1.70383925712239993810214054705e-1;
const A85: f64 = 1.07262030446373284651809199168e-1;
const A86: f64 = -1.53194377486244017527936158236e-2;
const A87: f64 = 8.27378916381402288758473766002e-3;
const A91: f64 = 6.24110958716075717114429577812e-1;
const A94: f64 = -3.36089262944694129406857109825e0;
const A95: f64 = -8.68219346841726006818189891453e-1;
const A96: f64 = 2.75920996994467083049415600797e1;
const A97: f64 = 2.01540675504778934086186788979e1;
const A98: f64 = -4.34898841810699588477366255144e1;
const A101: f64 = 4.77662536438264365890433908527e-1;
const A104: f64 = -2.48811461997166764192642586468e0;
const A105: f64 = -5.90290826836842996371446475743e-1;
const A106: f64 = 2.12300514481811942347288949897e1;
const A107: f64 = 1.52792336328824235832596922938e1;
const A108: f64 = -3.32882109689848629194453265587e1;
const A109: f64 = -2.03312017085086261358222928593e-2;
const A111: f64 = -9.3714243008598732571704021658e-1;
const A114: f64 = 5.18637242884406370830023853209e0;
const A115: f64 = 1.09143734899672957818500254654e0;
const A116: f64 = -8.14978701074692612513997267357e0;
const A117: f64 = -1.85200656599969598641566180701e1;
const A118: f64 = 2.27394870993505042818970056734e1;
const A119: f64 = 2.49360555267965238987089396762e0;
const A1110: f64 = -3.0467644718982195003823669022e0;
const A121: f64 = 2.27331014751653820792359768449e0;
const A124: f64 = -1.05344954667372501984066689879e1;
const A125: f64 = -2.00087205822486249909675718444e0;
const A126: f64 = -1.79589318631187989172765950534e1;
const A127: f64 = 2.79488845294199600508499808837e1;
const A128: f64 = -2.85899827713502369474065508674e0;
const A129: f64 = -8.87285693353062954433549289258e0;
const A1210: f64 = 1.23605671757943030647266201528e1;
const A1211: f64 = 6.43392746015763530355970484046e-1;
const A141: f64 = 5.61675022830479523392909219681e-2;
const A147: f64 = 2.53500210216624811088794765333e-1;
const A148: f64 = -2.46239037470802489917441475441e-1;
const A149: f64 = -1.24191423263816360469010140626e-1;
const A1410: f64 = 1.5329179827876569731206322685e-1;
const A1411: f64 = 8.20105229563468988491666602057e-3;
const A1412: f64 = 7.56789766054569976138603589584e-3;
const A1413: f64 = -8.298e-3;
const A151: f64 = 3.18346481635021405060768473261e-2;
const A156: f64 = 2.83009096723667755288322961402e-2;
const A157: f64 = 5.35419883074385676223797384372e-2;
const A158: f64 = -5.49237485713909884646569340306e-2;
const A1511: f64 = -1.08347328697249322858509316994e-4;
const A1512: f64 = 3.82571090835658412954920192323e-4;
const A1513: f64 = -3.40465008687404560802977114492e-4;
const A1514: f64 = 1.41312443674632500278074618366e-1;
const A161: f64 = -4.28896301583791923408573538692e-1;
const A166: f64 = -4.69762141536116384314449447206e0;
const A167: f64 = 7.68342119606259904184240953878e0;
const A168: f64 = 4.06898981839711007970213554331e0;
const A169: f64 = 3.56727187455281109270669543021e-1;
const A1613: f64 = -1.39902416515901462129418009734e-3;
const A1614: f64 = 2.9475147891527723389556272149e0;
const A1615: f64 = -9.15095847217987001081870187138e0;

const D41: f64 = -0.84289382761090128651353491142e+01;
const D46: f64 = 0.56671495351937776962531783590e+00;
const D47: f64 = -0.30689499459498916912797304727e+01;
const D48: f64 = 0.23846676565120698287728149680e+01;
const D49: f64 = 0.21170345824450282767155149946e+01;
const D410: f64 = -0.87139158377797299206789907490e+00;
const D411: f64 = 0.22404374302607882758541771650e+01;
const D412: f64 = 0.63157877876946881815570249290e+00;
const D413: f64 = -0.88990336451333310820698117400e-01;
const D414: f64 = 0.18148505520854727256656404962e+02;
const D415: f64 = -0.91946323924783554000451984436e+01;
const D416: f64 = -0.44360363875948939664310572000e+01;
const D51: f64 = 0.10427508642579134603413151009e+02;
const D56: f64 = 0.24228349177525818288430175319e+03;
const D57: f64 = 0.16520045171727028198505394887e+03;
const D58: f64 = -0.37454675472269020279518312152e+03;
const D59: f64 = -0.22113666853125306036270938578e+02;
const D510: f64 = 0.77334326684722638389603898808e+01;
const D511: f64 = -0.30674084731089398182061213626e+02;
const D512: f64 = -0.93321305264302278729567221706e+01;
const D513: f64 = 0.15697238121770843886131091075e+02;
const D514: f64 = -0.31139403219565177677282850411e+02;
const D515: f64 = -0.93529243588444783865713862664e+01;
const D516: f64 = 0.35816841486394083752465898540e+02;
const D61: f64 = 0.19985053242002433820987653617e+02;
const D66: f64 = -0.38703730874935176555105901742e+03;
const D67: f64 = -0.18917813819516756882830838328e+03;
const D68: f64 = 0.52780815920542364900561016686e+03;
const D69: f64 = -0.11573902539959630126141871134e+02;
const D610: f64 = 0.68812326946963000169666922661e+01;
const D611: f64 = -0.10006050966910838403183860980e+01;
const D612: f64 = 0.77771377980534432092869265740e+00;
const D613: f64 = -0.27782057523535084065932004339e+01;
const D614: f64 = -0.60196695231264120758267380846e+02;
const D615: f64 = 0.84320405506677161018159903784e+02;
const D616: f64 = 0.11992291136182789328035130030e+02;
const D71: f64 = -0.25693933462703749003312586129e+02;
const D76: f64 = -0.15418974869023643374053993627e+03;
const D77: f64 = -0.23152937917604549567536039109e+03;
const D78: f64 = 0.35763911791061412378285349910e+03;
const D79: f64 = 0.93405324183624310003907691704e+02;
const D710: f64 = -0.37458323136451633156875139351e+02;
const D711: f64 = 0.10409964950896230045147246184e+03;
const D712: f64 = 0.29840293426660503123344363579e+02;
const D713: f64 = -0.43533456590011143754432175058e+02;
const D714: f64 = 0.96324553959188282948394950600e+02;
const D715: f64 = -0.39177261675615439165231486172e+02;
const D716: f64 = -0.14972683625798562581422125276e+03;

// Step-size control parameters (Fortran defaults).
const SAFE: f64 = 0.9;
const FAC1: f64 = 0.333;
const FAC2: f64 = 6.0;
const BETA: f64 = 0.0;
const UROUND: f64 = 2.3e-16;

#[inline]
fn axpy<const N: usize>(y: &[f64; N], h: f64, terms: &[(f64, &[f64; N])]) -> [f64; N] {
    let mut out = [0.0; N];
    for i in 0..N {
        let mut s = 0.0;
        for (c, k) in terms {
            s += c * k[i];
        }
        out[i] = y[i] + h * s;
    }
    out
}

/// Initial step size guess (Fortran `HINIT`, order 8).
fn initial_step<const N: usize, F: FnMut(f64, &[f64; N]) -> [f64; N]>(
    f: &mut F,
    t: f64,
    y: &[f64; N],
    f0: &[f64; N],
    dir: f64,
    opts: &Dop853Options,
) -> f64 {
    let (mut dnf, mut dny) = (0.0, 0.0);
    for i in 0..N {
        let sk = opts.atol + opts.rtol * y[i].abs();
        dnf += (f0[i] / sk) * (f0[i] / sk);
        dny += (y[i] / sk) * (y[i] / sk);
    }
    let mut h = if dnf <= 1e-10 || dny <= 1e-10 {
        1e-6
    } else {
        (dny / dnf).sqrt() * 0.01
    };
    h = h.min(opts.h_max) * dir;
    let y1: [f64; N] = core::array::from_fn(|i| y[i] + h * f0[i]);
    let f1 = f(t + h, &y1);
    let mut der2 = 0.0;
    for i in 0..N {
        let sk = opts.atol + opts.rtol * y[i].abs();
        der2 += ((f1[i] - f0[i]) / sk) * ((f1[i] - f0[i]) / sk);
    }
    let der2 = der2.sqrt() / h.abs();
    let der12 = der2.max(dnf.sqrt());
    let h1 = if der12 <= 1e-15 {
        (h.abs() * 1e-3).max(1e-6)
    } else {
        fmath::pow(0.01 / der12, 1.0 / 8.0)
    };
    (100.0 * h.abs()).min(h1).min(opts.h_max) * dir
}

/// Integrate y' = f(t, y) from `t0` to `t_end` (either direction).
///
/// `h0` is the initial step; pass 0.0 for an automatic guess, or the previous call's
/// `h_next` to continue a trajectory without changing the step sequence. `on_step` is
/// called after every accepted step with its dense output and the end state.
#[allow(clippy::too_many_arguments)]
pub fn dop853<const N: usize, F, S>(
    f: &mut F,
    t0: f64,
    y0: [f64; N],
    t_end: f64,
    h0: f64,
    opts: &Dop853Options,
    mut on_step: S,
) -> Result<Integration<N>, IntegratorError>
where
    F: FnMut(f64, &[f64; N]) -> [f64; N],
    S: FnMut(&DenseStep<N>, &[f64; N]) -> StepControl,
{
    let dir = if t_end >= t0 { 1.0 } else { -1.0 };
    let expo1 = 1.0 / 8.0 - BETA * 0.2;
    let (facc1, facc2) = (1.0 / FAC1, 1.0 / FAC2);
    let mut t = t0;
    let mut y = y0;
    let mut k1 = f(t, &y);
    let mut nfcn = 1;
    let mut h = if h0 == 0.0 {
        nfcn += 1;
        initial_step(f, t, &y, &k1, dir, opts)
    } else {
        h0.abs().min(opts.h_max) * dir
    };
    let mut facold: f64 = 1e-4;
    let mut reject = false;
    let (mut accepted, mut rejected) = (0, 0);

    if t == t_end {
        return Ok(Integration {
            t,
            y,
            accepted,
            rejected,
            evaluations: nfcn,
            h_next: h,
            stopped_by_callback: false,
        });
    }

    loop {
        if accepted + rejected > opts.max_steps {
            return Err(IntegratorError::TooManySteps { t });
        }
        if 0.1 * h.abs() <= t.abs() * UROUND {
            return Err(IntegratorError::StepTooSmall { t, h });
        }
        let mut last = false;
        if opts.overshoot {
            last = (t + h - t_end) * dir >= 0.0;
        } else if (t + 1.01 * h - t_end) * dir > 0.0 {
            h = t_end - t;
            last = true;
        }

        let y1 = axpy(&y, h, &[(A21, &k1)]);
        let k2 = f(t + C2 * h, &y1);
        let y1 = axpy(&y, h, &[(A31, &k1), (A32, &k2)]);
        let k3 = f(t + C3 * h, &y1);
        let y1 = axpy(&y, h, &[(A41, &k1), (A43, &k3)]);
        let k4 = f(t + C4 * h, &y1);
        let y1 = axpy(&y, h, &[(A51, &k1), (A53, &k3), (A54, &k4)]);
        let k5 = f(t + C5 * h, &y1);
        let y1 = axpy(&y, h, &[(A61, &k1), (A64, &k4), (A65, &k5)]);
        let k6 = f(t + C6 * h, &y1);
        let y1 = axpy(&y, h, &[(A71, &k1), (A74, &k4), (A75, &k5), (A76, &k6)]);
        let k7 = f(t + C7 * h, &y1);
        let y1 = axpy(
            &y,
            h,
            &[(A81, &k1), (A84, &k4), (A85, &k5), (A86, &k6), (A87, &k7)],
        );
        let k8 = f(t + C8 * h, &y1);
        let y1 = axpy(
            &y,
            h,
            &[
                (A91, &k1),
                (A94, &k4),
                (A95, &k5),
                (A96, &k6),
                (A97, &k7),
                (A98, &k8),
            ],
        );
        let k9 = f(t + C9 * h, &y1);
        let y1 = axpy(
            &y,
            h,
            &[
                (A101, &k1),
                (A104, &k4),
                (A105, &k5),
                (A106, &k6),
                (A107, &k7),
                (A108, &k8),
                (A109, &k9),
            ],
        );
        let k10 = f(t + C10 * h, &y1);
        let y1 = axpy(
            &y,
            h,
            &[
                (A111, &k1),
                (A114, &k4),
                (A115, &k5),
                (A116, &k6),
                (A117, &k7),
                (A118, &k8),
                (A119, &k9),
                (A1110, &k10),
            ],
        );
        // Fortran reuses K2/K3 storage for stages 11 and 12.
        let k11 = f(t + C11 * h, &y1);
        let tph = t + h;
        let y1 = axpy(
            &y,
            h,
            &[
                (A121, &k1),
                (A124, &k4),
                (A125, &k5),
                (A126, &k6),
                (A127, &k7),
                (A128, &k8),
                (A129, &k9),
                (A1210, &k10),
                (A1211, &k11),
            ],
        );
        let k12 = f(tph, &y1);
        nfcn += 11;

        let mut k4n = [0.0; N];
        let mut k5n = [0.0; N];
        for i in 0..N {
            k4n[i] = B1 * k1[i]
                + B6 * k6[i]
                + B7 * k7[i]
                + B8 * k8[i]
                + B9 * k9[i]
                + B10 * k10[i]
                + B11 * k11[i]
                + B12 * k12[i];
            k5n[i] = y[i] + h * k4n[i];
        }
        let (mut err, mut err2) = (0.0, 0.0);
        for i in 0..N {
            let sk = opts.atol + opts.rtol * y[i].abs().max(k5n[i].abs());
            let e2 = k4n[i] - BHH1 * k1[i] - BHH2 * k9[i] - BHH3 * k12[i];
            err2 += (e2 / sk) * (e2 / sk);
            let e = ER1 * k1[i]
                + ER6 * k6[i]
                + ER7 * k7[i]
                + ER8 * k8[i]
                + ER9 * k9[i]
                + ER10 * k10[i]
                + ER11 * k11[i]
                + ER12 * k12[i];
            err += (e / sk) * (e / sk);
        }
        if !(err.is_finite() && err2.is_finite()) {
            return Err(IntegratorError::NonFinite { t });
        }
        let mut deno = err + 0.01 * err2;
        if deno <= 0.0 {
            deno = 1.0;
        }
        let err = h.abs() * err * (1.0 / (N as f64 * deno)).sqrt();
        let fac11 = fmath::pow(err, expo1);
        let fac = fac11 / fmath::pow(facold, BETA);
        let fac = facc2.max(facc1.min(fac / SAFE));
        let mut h_new = h / fac;

        if err <= 1.0 {
            // Step accepted.
            facold = err.max(1e-4);
            accepted += 1;
            let k4 = f(tph, &k5n); // derivative at the new point (FSAL)
            nfcn += 1;

            // Dense output coefficients.
            let mut cont = [[0.0; N]; 8];
            for i in 0..N {
                cont[0][i] = y[i];
                let ydiff = k5n[i] - y[i];
                cont[1][i] = ydiff;
                let bspl = h * k1[i] - ydiff;
                cont[2][i] = bspl;
                cont[3][i] = ydiff - h * k4[i] - bspl;
                cont[4][i] = D41 * k1[i]
                    + D46 * k6[i]
                    + D47 * k7[i]
                    + D48 * k8[i]
                    + D49 * k9[i]
                    + D410 * k10[i]
                    + D411 * k11[i]
                    + D412 * k12[i];
                cont[5][i] = D51 * k1[i]
                    + D56 * k6[i]
                    + D57 * k7[i]
                    + D58 * k8[i]
                    + D59 * k9[i]
                    + D510 * k10[i]
                    + D511 * k11[i]
                    + D512 * k12[i];
                cont[6][i] = D61 * k1[i]
                    + D66 * k6[i]
                    + D67 * k7[i]
                    + D68 * k8[i]
                    + D69 * k9[i]
                    + D610 * k10[i]
                    + D611 * k11[i]
                    + D612 * k12[i];
                cont[7][i] = D71 * k1[i]
                    + D76 * k6[i]
                    + D77 * k7[i]
                    + D78 * k8[i]
                    + D79 * k9[i]
                    + D710 * k10[i]
                    + D711 * k11[i]
                    + D712 * k12[i];
            }
            let y1 = axpy(
                &y,
                h,
                &[
                    (A141, &k1),
                    (A147, &k7),
                    (A148, &k8),
                    (A149, &k9),
                    (A1410, &k10),
                    (A1411, &k11),
                    (A1412, &k12),
                    (A1413, &k4),
                ],
            );
            let k14 = f(t + C14 * h, &y1);
            let y1 = axpy(
                &y,
                h,
                &[
                    (A151, &k1),
                    (A156, &k6),
                    (A157, &k7),
                    (A158, &k8),
                    (A1511, &k11),
                    (A1512, &k12),
                    (A1513, &k4),
                    (A1514, &k14),
                ],
            );
            let k15 = f(t + C15 * h, &y1);
            let y1 = axpy(
                &y,
                h,
                &[
                    (A161, &k1),
                    (A166, &k6),
                    (A167, &k7),
                    (A168, &k8),
                    (A169, &k9),
                    (A1613, &k4),
                    (A1614, &k14),
                    (A1615, &k15),
                ],
            );
            let k16 = f(t + C16 * h, &y1);
            nfcn += 3;
            for i in 0..N {
                cont[4][i] =
                    h * (cont[4][i] + D413 * k4[i] + D414 * k14[i] + D415 * k15[i] + D416 * k16[i]);
                cont[5][i] =
                    h * (cont[5][i] + D513 * k4[i] + D514 * k14[i] + D515 * k15[i] + D516 * k16[i]);
                cont[6][i] =
                    h * (cont[6][i] + D613 * k4[i] + D614 * k14[i] + D615 * k15[i] + D616 * k16[i]);
                cont[7][i] =
                    h * (cont[7][i] + D713 * k4[i] + D714 * k14[i] + D715 * k15[i] + D716 * k16[i]);
            }
            if !k5n.iter().all(|x| x.is_finite()) {
                return Err(IntegratorError::NonFinite { t: tph });
            }
            let step = DenseStep {
                t0: t,
                h,
                cont,
                y1: k5n,
            };
            k1 = k4;
            y = k5n;
            t = tph;
            let control = on_step(&step, &y);
            if h_new.abs() > opts.h_max {
                h_new = dir * opts.h_max;
            }
            if reject {
                h_new = dir * h_new.abs().min(h.abs());
            }
            reject = false;
            // With overshoot, a rejected-then-shrunk final step may no longer reach t_end.
            let last = last && (!opts.overshoot || (t - t_end) * dir >= 0.0);
            if last || control == StepControl::Stop {
                return Ok(Integration {
                    t,
                    y,
                    accepted,
                    rejected,
                    evaluations: nfcn,
                    h_next: h_new,
                    stopped_by_callback: control == StepControl::Stop && !last,
                });
            }
        } else {
            // Step rejected.
            h_new = h / facc1.min(fac11 / SAFE);
            reject = true;
            if accepted >= 1 {
                rejected += 1;
            }
        }
        h = h_new;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Harmonic oscillator y'' = −y: exact solution (cos t, −sin t).
    fn oscillator(_t: f64, y: &[f64; 2]) -> [f64; 2] {
        [y[1], -y[0]]
    }

    #[test]
    fn harmonic_oscillator_is_accurate() {
        let opts = Dop853Options {
            rtol: 1e-13,
            atol: 1e-13,
            ..Default::default()
        };
        let r = dop853(
            &mut oscillator,
            0.0,
            [1.0, 0.0],
            100.0,
            0.0,
            &opts,
            |_, _| StepControl::Continue,
        )
        .unwrap();
        assert!(
            (r.y[0] - fmath::cos(100.0)).abs() < 1e-11,
            "{}",
            r.y[0] - fmath::cos(100.0)
        );
        assert!((r.y[1] + fmath::sin(100.0)).abs() < 1e-11);
    }

    #[test]
    fn dense_output_is_seventh_order_accurate() {
        let opts = Dop853Options {
            rtol: 1e-12,
            atol: 1e-12,
            ..Default::default()
        };
        let mut worst: f64 = 0.0;
        dop853(
            &mut oscillator,
            0.0,
            [1.0, 0.0],
            30.0,
            0.0,
            &opts,
            |s, _| {
                for k in 0..=10 {
                    let t = s.t0 + s.h * f64::from(k) / 10.0;
                    let y = s.eval(t);
                    worst = worst
                        .max((y[0] - fmath::cos(t)).abs())
                        .max((y[1] + fmath::sin(t)).abs());
                }
                StepControl::Continue
            },
        )
        .unwrap();
        assert!(worst < 1e-10, "{worst}");
    }

    #[test]
    fn integrates_backwards() {
        let r = dop853(
            &mut oscillator,
            10.0,
            [fmath::cos(10.0), -fmath::sin(10.0)],
            0.0,
            0.0,
            &Dop853Options::default(),
            |_, _| StepControl::Continue,
        )
        .unwrap();
        assert!((r.y[0] - 1.0).abs() < 1e-10 && r.y[1].abs() < 1e-10);
    }

    #[test]
    fn deterministic_step_sequence() {
        let run = || {
            let mut steps = Vec::new();
            dop853(
                &mut oscillator,
                0.0,
                [1.0, 0.0],
                50.0,
                0.0,
                &Dop853Options::default(),
                |s, _| {
                    steps.push((s.t0.to_bits(), s.h.to_bits()));
                    StepControl::Continue
                },
            )
            .unwrap();
            steps
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn overshoot_makes_chunked_runs_identical() {
        let opts = Dop853Options {
            overshoot: true,
            ..Default::default()
        };
        let one = dop853(
            &mut oscillator,
            0.0,
            [1.0, 0.0],
            40.0,
            0.0,
            &opts,
            |_, _| StepControl::Continue,
        )
        .unwrap();
        // Same span in 400 chunks of 0.1, each continuing from the previous natural step end.
        let (mut t, mut y, mut h) = (0.0, [1.0, 0.0], 0.0);
        while t < 40.0 {
            let target = (t + 0.1f64).min(40.0);
            let r = dop853(&mut oscillator, t, y, target, h, &opts, |_, _| {
                StepControl::Continue
            })
            .unwrap();
            (t, y, h) = (r.t, r.y, r.h_next);
            if r.t >= 40.0 {
                break;
            }
        }
        assert_eq!(t.to_bits(), one.t.to_bits());
        assert_eq!(y.map(f64::to_bits), one.y.map(f64::to_bits));
    }

    #[test]
    fn stop_from_callback() {
        let r = dop853(
            &mut oscillator,
            0.0,
            [1.0, 0.0],
            100.0,
            0.0,
            &Dop853Options::default(),
            |s, _| {
                if s.t1() > 5.0 {
                    StepControl::Stop
                } else {
                    StepControl::Continue
                }
            },
        )
        .unwrap();
        assert!(r.stopped_by_callback && r.t > 5.0 && r.t < 100.0);
    }
}
