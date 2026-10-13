//! Transfer planning (M9): porkchop grids from Lambert arcs, a patched-conic first guess
//! for the departure burn, and its correction on the full n-body propagator.
//!
//! Two geometries:
//! - **Local** (the target orbits the spacecraft's central body, e.g. LEO → Moon): Lambert
//!   from the spacecraft's own future position on its (two-body) orbit to the target's
//!   ephemeris position; the departure Δv is |v₁ − v_sc|.
//! - **Interplanetary** (target and the central body orbit the same parent, e.g. Earth →
//!   Mars around the Sun): Lambert between the two bodies' heliocentric positions; the
//!   departure hyperbolic excess v∞ = v₁ − v_body is converted into a burn from the
//!   parking orbit, Δv = √(v∞² + 2μ/r) − v_park (patched conics; Vallado §12.6, Curtis §8.6).
//!
//! The patched-conic node is only a first guess. `correct` refines it on the real
//! propagator (all perturbations, the target's gravity) by Newton iteration with a
//! finite-difference Jacobian and minimum-norm steps, targeting the closest-approach
//! distance to the target.

use crate::bodies::{BodyId, BodyRegistry};
use crate::ephemeris::Ephemeris;
use crate::kepler;
use crate::lambert;
use crate::maneuver::{ManeuverNode, orbit_frame};
use crate::math::{V3, fmath};
use crate::prediction::{self, EngineModel, HorizonPolicy, MarkerKind};
use crate::propagator::{Propagator, ScState};
use crate::time::Epoch;

/// Which geometry a transfer uses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Geometry {
    Local,
    Interplanetary { parent: BodyId },
}

#[derive(Clone, Debug, PartialEq)]
pub enum TransferError {
    /// The target is neither a satellite of the central body nor a sibling of it.
    Unsupported,
    Ephemeris(String),
    Lambert,
    /// Newton iteration on the n-body propagator did not reach the tolerance.
    NotConverged {
        miss: f64,
    },
    Propagation(String),
}

impl core::fmt::Display for TransferError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            TransferError::Unsupported => write!(
                f,
                "transfer: target must orbit the central body or share its parent"
            ),
            TransferError::Ephemeris(e) => write!(f, "transfer: ephemeris: {e}"),
            TransferError::Lambert => write!(f, "transfer: no Lambert solution"),
            TransferError::NotConverged { miss } => write!(
                f,
                "transfer: correction did not converge (miss {:.0} km)",
                miss / 1000.0
            ),
            TransferError::Propagation(e) => write!(f, "transfer: {e}"),
        }
    }
}

impl std::error::Error for TransferError {}

pub fn geometry(
    reg: &BodyRegistry,
    center: BodyId,
    target: BodyId,
) -> Result<Geometry, TransferError> {
    let tp = reg
        .get(target)
        .and_then(|b| b.parent)
        .ok_or(TransferError::Unsupported)?;
    if tp == center {
        return Ok(Geometry::Local);
    }
    let cp = reg
        .get(center)
        .and_then(|b| b.parent)
        .ok_or(TransferError::Unsupported)?;
    if tp == cp {
        return Ok(Geometry::Interplanetary { parent: cp });
    }
    Err(TransferError::Unsupported)
}

/// One grid point of a porkchop plot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Arc {
    /// Departure burn Δv (m/s).
    pub dv_depart: f64,
    /// Hyperbolic excess speed at the target (m/s).
    pub v_inf_arrive: f64,
    /// Departure v∞ vector (interplanetary) or the departure velocity change (local), ICRF.
    pub dv_vec: V3,
}

/// The spacecraft's parking orbit, two-body, about its central body.
#[derive(Clone, Copy, Debug)]
pub struct Parking {
    pub center: BodyId,
    pub epoch: Epoch,
    pub r: V3,
    pub v: V3,
    pub mu: f64,
}

impl Parking {
    pub fn at(&self, t: Epoch) -> Option<(V3, V3)> {
        kepler::propagate(self.r, self.v, self.mu, t.seconds_since(self.epoch)).ok()
    }
}

fn state(
    eph: &Ephemeris,
    target: BodyId,
    center: BodyId,
    t: Epoch,
) -> Result<(V3, V3), TransferError> {
    let s = eph
        .state_relative(target, center, t)
        .map_err(|e| TransferError::Ephemeris(e.to_string()))?;
    Ok((s.r, s.v))
}

/// The Lambert arc departing at `t_dep` and arriving `tof` seconds later.
pub fn arc(
    eph: &Ephemeris,
    reg: &BodyRegistry,
    parking: &Parking,
    target: BodyId,
    t_dep: Epoch,
    tof: f64,
) -> Result<Arc, TransferError> {
    let t_arr = t_dep.add_seconds(tof);
    match geometry(reg, parking.center, target)? {
        Geometry::Local => {
            let (r1, v_sc) = parking.at(t_dep).ok_or(TransferError::Lambert)?;
            let (r2, v_tgt) = state(eph, target, parking.center, t_arr)?;
            let h = r1.cross(v_sc);
            let mu = parking.mu;
            let s = lambert::solve(r1, r2, tof, mu, h, 0).map_err(|_| TransferError::Lambert)?;
            let s = s.first().ok_or(TransferError::Lambert)?;
            Ok(Arc {
                dv_depart: (s.v1 - v_sc).norm(),
                v_inf_arrive: (s.v2 - v_tgt).norm(),
                dv_vec: s.v1 - v_sc,
            })
        }
        Geometry::Interplanetary { parent } => {
            let mu_parent = reg
                .get(parent)
                .map(|b| b.gm)
                .ok_or(TransferError::Unsupported)?;
            let (r1, v1b) = state(eph, parking.center, parent, t_dep)?;
            let (r2, v2b) = state(eph, target, parent, t_arr)?;
            let h = r1.cross(v1b);
            let s =
                lambert::solve(r1, r2, tof, mu_parent, h, 0).map_err(|_| TransferError::Lambert)?;
            let s = s.first().ok_or(TransferError::Lambert)?;
            let v_inf = s.v1 - v1b;
            let rp = parking.r.norm();
            let v_park = parking.v.norm();
            let dv = f64::sqrt(v_inf.norm_squared() + 2.0 * parking.mu / rp) - v_park;
            Ok(Arc {
                dv_depart: dv,
                v_inf_arrive: (s.v2 - v2b).norm(),
                dv_vec: v_inf,
            })
        }
    }
}

/// A porkchop grid: `n_dep` departure epochs from `t0` to `t1` × `n_tof` flight times.
/// Row-major (departure, then TOF); NaN where Lambert fails.
pub struct Porkchop {
    pub dep: Vec<f64>,
    pub tof: Vec<f64>,
    pub dv: Vec<f64>,
    pub v_inf: Vec<f64>,
}

#[allow(clippy::too_many_arguments)]
pub fn porkchop(
    eph: &Ephemeris,
    reg: &BodyRegistry,
    parking: &Parking,
    target: BodyId,
    t0: Epoch,
    t1: Epoch,
    n_dep: usize,
    tof_min: f64,
    tof_max: f64,
    n_tof: usize,
) -> Porkchop {
    let span = t1.seconds_since(t0);
    let dep: Vec<f64> = (0..n_dep)
        .map(|i| span * i as f64 / (n_dep.max(2) - 1) as f64)
        .collect();
    let tof: Vec<f64> = (0..n_tof)
        .map(|j| tof_min + (tof_max - tof_min) * j as f64 / (n_tof.max(2) - 1) as f64)
        .collect();
    let mut dv = Vec::with_capacity(n_dep * n_tof);
    let mut v_inf = Vec::with_capacity(n_dep * n_tof);
    for &d in &dep {
        for &t in &tof {
            match arc(eph, reg, parking, target, t0.add_seconds(d), t) {
                Ok(a) => {
                    dv.push(a.dv_depart);
                    v_inf.push(a.v_inf_arrive);
                }
                Err(_) => {
                    dv.push(f64::NAN);
                    v_inf.push(f64::NAN);
                }
            }
        }
    }
    Porkchop {
        dep: dep.iter().map(|d| t0.tdb_seconds() + d).collect(),
        tof,
        dv,
        v_inf,
    }
}

/// Patched-conic departure node for the arc (`t_dep`, `tof`).
///
/// Local: an impulse at `t_dep` equal to v₁ − v_sc. Interplanetary: the burn point on the
/// parking orbit within one period before `t_dep` whose outgoing hyperbola's asymptote is
/// best aligned with v∞ (in-plane, tangential burn at periapsis: the asymptote lies at
/// true anomaly ν∞ = acos(−1/e), e = 1 + r·v∞²/μ; Curtis eq. 8.43).
pub fn first_guess(
    eph: &Ephemeris,
    reg: &BodyRegistry,
    parking: &Parking,
    target: BodyId,
    t_dep: Epoch,
    tof: f64,
) -> Result<ManeuverNode, TransferError> {
    let a = arc(eph, reg, parking, target, t_dep, tof)?;
    let node_at = |t: Epoch, dv: V3| -> Result<ManeuverNode, TransferError> {
        let (r, v) = parking.at(t).ok_or(TransferError::Lambert)?;
        let (pro, nrm, rad) = orbit_frame(r, v).ok_or(TransferError::Lambert)?;
        Ok(ManeuverNode::new(t, dv.dot(pro), dv.dot(nrm), dv.dot(rad)))
    };
    match geometry(reg, parking.center, target)? {
        Geometry::Local => node_at(t_dep, a.dv_vec),
        Geometry::Interplanetary { .. } => {
            let el = kepler::Elements::from_state(parking.r, parking.v, parking.mu);
            let period = el.period(parking.mu).unwrap_or(5_400.0);
            let v_inf = a.dv_vec;
            let vi = v_inf.norm();
            let dir = v_inf.normalized().ok_or(TransferError::Lambert)?;
            let mut best = (f64::NEG_INFINITY, t_dep);
            for k in 0..360 {
                let t = t_dep.add_seconds(-period * f64::from(k) / 360.0);
                let Some((r, v)) = parking.at(t) else {
                    continue;
                };
                let rn = r.norm();
                let e = 1.0 + rn * vi * vi / parking.mu;
                let nu = fmath::acos(-1.0 / e);
                let (pro, _, _) = orbit_frame(r, v).ok_or(TransferError::Lambert)?;
                let rhat = r * (1.0 / rn);
                let tang = (pro - rhat * pro.dot(rhat)).normalized().unwrap_or(pro);
                let asym = rhat * fmath::cos(nu) + tang * fmath::sin(nu);
                let d = asym.dot(dir);
                if d > best.0 {
                    best = (d, t);
                }
            }
            let t = best.1;
            let (r, v) = parking.at(t).ok_or(TransferError::Lambert)?;
            let dv = f64::sqrt(vi * vi + 2.0 * parking.mu / r.norm()) - v.norm();
            Ok(ManeuverNode::new(t, dv, 0.0, 0.0))
        }
    }
}

/// Closest approach to `target` along the n-body prediction with `nodes`: (distance m, epoch).
#[allow(clippy::too_many_arguments)]
pub fn closest_approach(
    p: &Propagator,
    eph: &Ephemeris,
    reg: &BodyRegistry,
    s0: &ScState,
    nodes: &[ManeuverNode],
    engine: Option<EngineModel>,
    policy: &HorizonPolicy,
    target: BodyId,
) -> Result<(f64, Epoch), TransferError> {
    let pred = prediction::predict(p, s0, nodes, engine, policy)
        .map_err(|e| TransferError::Propagation(e.to_string()))?;
    let m = prediction::markers(eph, reg, &pred.traj, s0.epoch, Some(target));
    let r_t = reg.get(target).map_or(0.0, |b| b.radii.equatorial_mean());
    // Outside the target's SOI the marker is a closest approach (centre distance); inside
    // it the arc is target-centred and the encounter is a periapsis (altitude) or impact.
    m.iter()
        .filter_map(|k| match k.kind {
            MarkerKind::ClosestApproach => Some((k.value, k.epoch)),
            MarkerKind::Periapsis if k.center == target => Some((k.value + r_t, k.epoch)),
            MarkerKind::Impact if k.center == target => Some((r_t, k.epoch)),
            _ => None,
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .ok_or(TransferError::NotConverged {
            miss: f64::INFINITY,
        })
}

/// Correct `node` (the last node of `nodes`) on the n-body propagator so the closest
/// approach to `target` is `r_target` (m from its centre). Newton with a forward-difference
/// Jacobian over (prograde, normal, radial) and the minimum-norm step δu = Jᵀ(JJᵀ)⁻¹(−f),
/// limited to 100 m/s per iteration, with backtracking. Returns the corrected node and the remaining miss.
#[allow(clippy::too_many_arguments)]
pub fn correct(
    p: &Propagator,
    eph: &Ephemeris,
    reg: &BodyRegistry,
    s0: &ScState,
    nodes: &[ManeuverNode],
    engine: Option<EngineModel>,
    policy: &HorizonPolicy,
    target: BodyId,
    r_target: f64,
    tol: f64,
) -> Result<(ManeuverNode, f64), TransferError> {
    let mut nodes = nodes.to_vec();
    let last = nodes.len() - 1;
    let eval = |ns: &[ManeuverNode]| {
        closest_approach(p, eph, reg, s0, ns, engine, policy, target).map(|(d, _)| d - r_target)
    };
    let mut f = eval(&nodes)?;
    for _ in 0..25 {
        if f.abs() < tol {
            return Ok((nodes[last], f));
        }
        let h = 0.05; // m/s
        let mut j = [0.0; 3];
        for (k, jk) in j.iter_mut().enumerate() {
            let mut ns = nodes.clone();
            match k {
                0 => ns[last].prograde += h,
                1 => ns[last].normal += h,
                _ => ns[last].radial += h,
            }
            *jk = (eval(&ns)? - f) / h;
        }
        let jj = j[0] * j[0] + j[1] * j[1] + j[2] * j[2];
        if jj <= 0.0 || !jj.is_finite() {
            break;
        }
        let mut step = [-f * j[0] / jj, -f * j[1] / jj, -f * j[2] / jj];
        let n = f64::sqrt(step[0] * step[0] + step[1] * step[1] + step[2] * step[2]);
        if n > 100.0 {
            for s in &mut step {
                *s *= 100.0 / n;
            }
        }
        // Backtracking: halve the step until the miss improves.
        let mut accepted = false;
        for _ in 0..6 {
            let mut ns = nodes.clone();
            ns[last].prograde += step[0];
            ns[last].normal += step[1];
            ns[last].radial += step[2];
            if let Ok(fn_) = eval(&ns)
                && fn_.abs() < f.abs()
            {
                nodes = ns;
                f = fn_;
                accepted = true;
                break;
            }
            for s in &mut step {
                *s *= 0.5;
            }
        }
        if !accepted {
            break;
        }
    }
    if f.abs() < tol {
        Ok((nodes[last], f))
    } else {
        Err(TransferError::NotConverged { miss: f })
    }
}

/// Spacecraft position relative to `target` at `t` on the prediction with `nodes`.
#[allow(clippy::too_many_arguments)]
fn relative_at(
    p: &Propagator,
    eph: &Ephemeris,
    s0: &ScState,
    nodes: &[ManeuverNode],
    engine: Option<EngineModel>,
    policy: &HorizonPolicy,
    target: BodyId,
    t: Epoch,
) -> Result<V3, TransferError> {
    let mut pol = *policy;
    // Look at least to `t` (plus margin).
    pol.min = pol.min.max(t.seconds_since(s0.epoch) + 3_600.0);
    let pred = prediction::predict(p, s0, nodes, engine, &pol)
        .map_err(|e| TransferError::Propagation(e.to_string()))?;
    let s = pred.traj.state_at(t).ok_or(TransferError::NotConverged {
        miss: f64::INFINITY,
    })?;
    let tgt = eph
        .state_relative(target, s.state.frame.center, t)
        .map_err(|e| TransferError::Ephemeris(e.to_string()))?;
    Ok(s.state.r - tgt.r)
}

/// Solve the 3×3 system a·x = b (Gaussian elimination with partial pivoting).
fn solve3(mut a: [[f64; 3]; 3], mut b: [f64; 3]) -> Option<[f64; 3]> {
    for c in 0..3 {
        let piv = (c..3).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))?;
        if a[piv][c].abs() < 1e-300 {
            return None;
        }
        a.swap(c, piv);
        b.swap(c, piv);
        for r in c + 1..3 {
            let f = a[r][c] / a[c][c];
            let pivot_row = a[c];
            for (k, x) in a[r].iter_mut().enumerate().skip(c) {
                *x -= f * pivot_row[k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut x = [0.0; 3];
    for r in (0..3).rev() {
        let s: f64 = (r + 1..3).map(|k| a[r][k] * x[k]).sum();
        x[r] = (b[r] - s) / a[r][r];
    }
    Some(x)
}

/// A control variable of a node: Δv components (m/s) or its time (s).
#[derive(Clone, Copy, Debug)]
pub enum Var {
    Prograde(usize),
    Normal(usize),
    Radial(usize),
    Time(usize),
}

fn apply(nodes: &mut [ManeuverNode], v: Var, d: f64) {
    match v {
        Var::Prograde(i) => nodes[i].prograde += d,
        Var::Normal(i) => nodes[i].normal += d,
        Var::Radial(i) => nodes[i].radial += d,
        Var::Time(i) => nodes[i].epoch_tdb += d,
    }
}

/// Gauss–Newton aim: adjust `vars` so the spacecraft's position relative to `target` at
/// `t_aim`, projected on the rows of `axes` (1–3 unit vectors), matches `point`. Steps are
/// minimum-norm, δ = Jᵀ(JJᵀ)⁻¹(−f) (variables scaled: 1 m/s ↔ 10 s), limited and
/// backtracked. Robust from a patched-conic guess that misses by 10⁵ km. Returns the
/// nodes and the remaining (projected) miss.
#[allow(clippy::too_many_arguments)]
pub fn aim(
    p: &Propagator,
    eph: &Ephemeris,
    s0: &ScState,
    nodes: &[ManeuverNode],
    engine: Option<EngineModel>,
    policy: &HorizonPolicy,
    target: BodyId,
    t_aim: Epoch,
    point: V3,
    axes: &[V3],
    vars: &[Var],
    tol: f64,
) -> Result<(Vec<ManeuverNode>, f64), TransferError> {
    let m = axes.len();
    let n = vars.len();
    let scale = |v: &Var| if matches!(v, Var::Time(_)) { 10.0 } else { 1.0 };
    let eval = |ns: &[ManeuverNode]| -> Result<Vec<f64>, TransferError> {
        let r = relative_at(p, eph, s0, ns, engine, policy, target, t_aim)? - point;
        Ok(axes.iter().map(|a| r.dot(*a)).collect())
    };
    let norm = |f: &[f64]| f64::sqrt(f.iter().map(|x| x * x).sum());
    let mut nodes = nodes.to_vec();
    let mut f = eval(&nodes)?;
    for _ in 0..30 {
        if norm(&f) < tol {
            break;
        }
        // Jacobian in scaled variables.
        let mut jac = vec![vec![0.0; n]; m];
        for (k, v) in vars.iter().enumerate() {
            let h = 0.05 * scale(v);
            let mut ns = nodes.clone();
            apply(&mut ns, *v, h);
            let Ok(fk) = eval(&ns) else {
                return Ok((nodes, norm(&f)));
            };
            for i in 0..m {
                jac[i][k] = (fk[i] - f[i]) / 0.05;
            }
        }
        // (J Jᵀ) y = −f, δ = Jᵀ y.
        let mut a = [[0.0; 3]; 3];
        let mut b = [0.0; 3];
        for i in 0..3 {
            for j in 0..3 {
                a[i][j] = if i < m && j < m {
                    (0..n).map(|k| jac[i][k] * jac[j][k]).sum()
                } else if i == j {
                    1.0
                } else {
                    0.0
                };
            }
            b[i] = if i < m { -f[i] } else { 0.0 };
        }
        let Some(y) = solve3(a, b) else { break };
        let mut step: Vec<f64> = (0..n)
            .map(|k| (0..m).map(|i| jac[i][k] * y[i]).sum())
            .collect();
        let sn = norm(&step);
        if sn > 100.0 {
            for s in &mut step {
                *s *= 100.0 / sn;
            }
        }
        let mut accepted = false;
        for _ in 0..8 {
            let mut ns = nodes.clone();
            for (k, v) in vars.iter().enumerate() {
                apply(&mut ns, *v, step[k] * scale(v));
            }
            if let Ok(fn_) = eval(&ns)
                && norm(&fn_) < norm(&f)
            {
                nodes = ns;
                f = fn_;
                accepted = true;
                break;
            }
            for s in &mut step {
                *s *= 0.5;
            }
        }
        if !accepted {
            break;
        }
    }
    let miss = norm(&f);
    Ok((nodes, miss))
}

/// The full planner, as flown on real missions: the departure burn (patched-conic first
/// guess, then its in-plane components and timing aimed on the n-body propagator), a
/// midcourse correction at 35 % of the flight (full 3-D aim: a normal burn at departure
/// barely moves the ~180°-later arrival out of plane, so that direction belongs to the
/// midcourse burn), and a periapsis trim on the midcourse burn.
/// `r_periapsis`: desired closest approach to the target's centre (m).
/// Returns [departure, midcourse] and the remaining periapsis error (m).
#[allow(clippy::too_many_arguments)]
pub fn plan(
    p: &Propagator,
    eph: &Ephemeris,
    reg: &BodyRegistry,
    s0: &ScState,
    parking: &Parking,
    engine: Option<EngineModel>,
    policy: &HorizonPolicy,
    target: BodyId,
    t_dep: Epoch,
    tof: f64,
    r_periapsis: f64,
) -> Result<(Vec<ManeuverNode>, f64), TransferError> {
    let a = arc(eph, reg, parking, target, t_dep, tof)?;
    let node = first_guess(eph, reg, parking, target, t_dep, tof)?;
    let mu_t = reg.get(target).map_or(0.0, |b| b.gm);
    let t_arr = t_dep.add_seconds(tof);
    let parent = reg
        .get(target)
        .and_then(|b| b.parent)
        .ok_or(TransferError::Unsupported)?;
    let ts = eph
        .state_relative(target, parent, t_arr)
        .map_err(|e| TransferError::Ephemeris(e.to_string()))?;
    let h =
        ts.r.cross(ts.v)
            .normalized()
            .unwrap_or(V3::new(0.0, 0.0, 1.0));
    let vi = a.v_inf_arrive.max(1.0);
    // The arrival v∞ direction from the Lambert arc.
    let (r1, mu_l) = match geometry(reg, parking.center, target)? {
        Geometry::Local => (
            parking.at(t_dep).ok_or(TransferError::Lambert)?.0,
            parking.mu,
        ),
        Geometry::Interplanetary { parent } => (
            state(eph, parking.center, parent, t_dep)?.0,
            reg.get(parent).map_or(0.0, |b| b.gm),
        ),
    };
    let sol = lambert::solve(r1, ts.r, tof, mu_l, h, 0).map_err(|_| TransferError::Lambert)?;
    let v_rel_dir = (sol[0].v2 - ts.v).normalized().unwrap_or(ts.v);
    // Aim point: impact parameter for periapsis r_p, b = r_p·√(1 + 2μ/(r_p·v∞²)) (Curtis
    // eq. 8.51), perpendicular to v∞ in the target's orbital plane; taken on the incoming
    // asymptote Δ = min(¼·TOF, 12 h) before arrival, where the target's pull is still weak.
    let b = r_periapsis * f64::sqrt(1.0 + 2.0 * mu_t / (r_periapsis * vi * vi));
    let side = h.cross(v_rel_dir).normalized().unwrap_or(h);
    let lead = (0.25 * tof).min(43_200.0);
    let t_aim = t_arr.add_seconds(-lead);
    let point = side * b - v_rel_dir * (vi * lead);
    // 0. Energy: finite-burn losses (and any plane change in the first guess) leave the
    // patched-conic burn short, and close to the escape energy the arrival position is so
    // nonlinear in Δv that Gauss–Newton stalls. A 1-D secant on the prograde Δv first makes
    // the distance from the central body at the aim time right.
    let mut node = node;
    if let Ok(tc) = eph.state_relative(target, parking.center, t_aim) {
        let want = (tc.r + point).norm();
        let dist = |n: &ManeuverNode| {
            relative_at(p, eph, s0, &[*n], engine, policy, target, t_aim)
                .map(|rel| (rel + tc.r).norm() - want)
        };
        let (mut x0, mut x1) = (node.prograde, node.prograde + 20.0);
        let mut f0 = dist(&node);
        let mut n1 = node;
        n1.prograde = x1;
        let mut f1 = dist(&n1);
        for _ in 0..20 {
            let (Ok(a), Ok(b)) = (f0.clone(), f1.clone()) else {
                break;
            };
            if b.abs() < 0.01 * want || (b - a).abs() < 1e-9 {
                break;
            }
            let x2 = (x1 - b * (x1 - x0) / (b - a)).clamp(x1 - 200.0, x1 + 200.0);
            x0 = x1;
            f0 = f1;
            x1 = x2;
            n1.prograde = x1;
            f1 = dist(&n1);
        }
        if f1.as_ref().is_ok_and(|v| v.abs() < 0.1 * want) {
            node = n1;
        }
    }
    // 1. Departure: in-plane aim (the plane of the parking orbit) with prograde, radial, time.
    let hp = parking.r.cross(parking.v).normalized().unwrap_or(h);
    let e1 = (point - hp * point.dot(hp)).normalized().unwrap_or(side);
    let e2 = hp.cross(e1);
    let (nodes, _) = aim(
        p,
        eph,
        s0,
        &[node],
        engine,
        policy,
        target,
        t_aim,
        point,
        &[e1, e2],
        &[Var::Prograde(0), Var::Radial(0), Var::Time(0)],
        0.02 * b,
    )?;
    // 2. Midcourse: full 3-D aim.
    let t_mcc = t_dep.add_seconds(0.35 * tof);
    let nodes = [nodes[0], ManeuverNode::new(t_mcc, 0.0, 0.0, 0.0)];
    let (nodes, _) = aim(
        p,
        eph,
        s0,
        &nodes,
        engine,
        policy,
        target,
        t_aim,
        point,
        &[
            V3::new(1.0, 0.0, 0.0),
            V3::new(0.0, 1.0, 0.0),
            V3::new(0.0, 0.0, 1.0),
        ],
        &[Var::Prograde(1), Var::Normal(1), Var::Radial(1)],
        0.02 * b,
    )?;
    // 3. Trim the true periapsis with the midcourse burn.
    let (mcc, miss) = correct(
        p,
        eph,
        reg,
        s0,
        &nodes,
        engine,
        policy,
        target,
        r_periapsis,
        0.01 * r_periapsis.max(20e3),
    )?;
    Ok((vec![nodes[0], mcc], miss))
}
