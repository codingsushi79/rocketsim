//! Predicted trajectories with planned maneuvers, trajectory markers and map geometry.
//!
//! **Prediction.** The future path comes from the same propagator and force model as
//! the flight, with every planned node flown as a *finite* burn of the vehicle's
//! engine:
//! - **Direction:** the node vector, held inertially fixed. The autopilot holds the same.
//! - **Thrust:** full vacuum thrust.
//! - **Duration:** from Tsiolkovsky with the predicted mass at the node,
//!   Δt = m₀vₑ/F · (1 − e^(−Δv/vₑ)).
//! - **Start:** chosen so that half the Δv is delivered before the node time,
//!   t₀ = t_node − m₀vₑ/F · (1 − e^(−Δv/2vₑ)).
//!
//! Each node's vector is evaluated on the trajectory that already includes the earlier
//! nodes, so chained nodes are consistent.
//!
//! **Markers** (apsides, SOI changes, impact, closest approach, nodes relative to a
//! target's orbital plane) are sign changes of an event function, found on the dense
//! output at 8 points per step and bisected to 1 ms.

use crate::bodies::{BodyId, BodyRegistry};
use crate::constants::G0;
use crate::earth;
use crate::ephemeris::Ephemeris;
use crate::frames::BodyOrientation;
use crate::kepler::Elements;
use crate::maneuver::{ManeuverNode, orbit_frame};
use crate::math::{V3, fmath};
use crate::orientation;
use crate::propagator::{
    ArcEnd, Burn, BurnDirection, PropagationError, Propagator, ScState, Trajectory,
};
use crate::time::Epoch;

/// The engine a plan is flown with: vacuum thrust (N) and specific impulse (s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EngineModel {
    pub thrust: f64,
    pub isp: f64,
}

/// How far ahead to predict.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HorizonPolicy {
    /// Orbits to show past the last burn when the orbit is bound within its SOI.
    pub orbits: f64,
    /// Hard cap past the last burn (escape trajectories, long periods), s.
    pub cap: f64,
    /// Never shorter than this from the start, s.
    pub min: f64,
}

impl Default for HorizonPolicy {
    fn default() -> HorizonPolicy {
        HorizonPolicy {
            orbits: 1.05,
            cap: 30.0 * 86_400.0,
            min: 600.0,
        }
    }
}

/// A node as it will be flown.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlannedBurn {
    pub node: ManeuverNode,
    /// Centre body at the node and the node vector (ICRF unit) and Δv vector (m/s).
    pub center: BodyId,
    pub direction: V3,
    pub dv_vector: V3,
    pub start: Epoch,
    /// Burn time at full thrust, s (0 for a zero node, NaN without an engine).
    pub duration: f64,
    pub mass_before: f64,
    pub mass_after: f64,
}

#[derive(Clone, Debug)]
pub struct Prediction {
    pub traj: Trajectory,
    pub burns: Vec<PlannedBurn>,
    pub horizon: Epoch,
}

/// Predict from `s0` with `nodes` (any order; past nodes are ignored).
pub fn predict(
    p: &Propagator,
    s0: &ScState,
    nodes: &[ManeuverNode],
    engine: Option<EngineModel>,
    policy: &HorizonPolicy,
) -> Result<Prediction, PropagationError> {
    let mut traj = p.propagate(s0, s0.epoch, &[])?;
    let mut burns: Vec<Burn> = Vec::new();
    let mut planned = Vec::new();
    let mut sorted: Vec<ManeuverNode> = nodes
        .iter()
        .copied()
        .filter(|n| n.epoch().seconds_since(s0.epoch) >= 0.0)
        .collect();
    sorted.sort_by(|a, b| a.epoch_tdb.total_cmp(&b.epoch_tdb));
    let mut last_end = s0.epoch;
    for node in sorted {
        let t_node = node.epoch();
        // State at the node with the earlier burns only.
        let mut probe = traj.clone();
        p.extend(&mut probe, t_node, &burns)?;
        if probe.terminated().is_some() && probe.end_epoch().seconds_since(t_node) < 0.0 {
            break; // the path ends (impact) before this node
        }
        let Some(s) = probe.state_at(t_node) else {
            break;
        };
        let Some((pro, nrm, rad)) = orbit_frame(s.state.r, s.state.v) else {
            continue;
        };
        let dv_vec = pro * node.prograde + nrm * node.normal + rad * node.radial;
        let dv = dv_vec.norm();
        let direction = dv_vec.normalized().unwrap_or(pro);
        let mut pb = PlannedBurn {
            node,
            center: s.state.frame.center,
            direction,
            dv_vector: dv_vec,
            start: t_node,
            duration: 0.0,
            mass_before: s.mass,
            mass_after: s.mass,
        };
        match engine {
            Some(e) if dv > 0.0 && e.thrust > 0.0 && e.isp > 0.0 => {
                let ve = e.isp * G0;
                let m0 = s.mass;
                let k = m0 * ve / e.thrust;
                let duration = k * (1.0 - fmath::exp(-dv / ve));
                let before = k * (1.0 - fmath::exp(-dv / (2.0 * ve)));
                // Burns never overlap or start in the past.
                let mut start = t_node.add_seconds(-before);
                if start.seconds_since(last_end) < 0.0 {
                    start = last_end;
                }
                pb.start = start;
                pb.duration = duration;
                pb.mass_after = m0 * fmath::exp(-dv / ve);
                // Add the burn before advancing: its start is then a burn boundary the
                // propagator lands on exactly (a plain horizon may overshoot it).
                burns.push(Burn {
                    start,
                    end: start.add_seconds(duration),
                    thrust: e.thrust,
                    isp: e.isp,
                    direction: BurnDirection::Inertial(direction),
                    mass_flow: None,
                });
                p.extend(&mut traj, start, &burns)?;
                last_end = start.add_seconds(duration);
            }
            Some(_) => {}
            None => pb.duration = f64::NAN,
        }
        planned.push(pb);
    }
    // Fly through the last burn, then decide how far to look.
    p.extend(&mut traj, last_end, &burns)?;
    let horizon = horizon_after(p, &traj, last_end, s0.epoch, policy)?;
    p.extend(&mut traj, horizon, &burns)?;
    Ok(Prediction {
        traj,
        burns: planned,
        horizon,
    })
}

/// End of the prediction: `orbits` periods past `t` for a bound orbit inside its SOI,
/// else the cap.
fn horizon_after(
    p: &Propagator,
    traj: &Trajectory,
    t: Epoch,
    start: Epoch,
    policy: &HorizonPolicy,
) -> Result<Epoch, PropagationError> {
    let cap = t.add_seconds(policy.cap);
    let min = start.add_seconds(policy.min);
    let Some(s) = traj.state_at(t.min_epoch(traj.end_epoch())) else {
        return Ok(cap);
    };
    let c = s.state.frame.center;
    let mu = p.reg.get(c).map_or(0.0, |b| b.gm);
    let el = Elements::from_state(s.state.r, s.state.v, mu);
    let soi = p.soi_radius(c, t)?;
    let h = match (el.apoapsis(), el.period(mu)) {
        (Some(ra), Some(period)) if ra < soi => {
            t.add_seconds(policy.orbits * period).min_epoch(cap)
        }
        _ => cap,
    };
    Ok(h.max_epoch(min))
}

trait EpochOrd {
    fn min_epoch(self, o: Epoch) -> Epoch;
    fn max_epoch(self, o: Epoch) -> Epoch;
}

impl EpochOrd for Epoch {
    fn min_epoch(self, o: Epoch) -> Epoch {
        if self.seconds_since(o) <= 0.0 {
            self
        } else {
            o
        }
    }
    fn max_epoch(self, o: Epoch) -> Epoch {
        if self.seconds_since(o) >= 0.0 {
            self
        } else {
            o
        }
    }
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MarkerKind {
    Periapsis,
    Apoapsis,
    SoiChange {
        from: BodyId,
        to: BodyId,
    },
    Impact,
    /// Closest approach to the target; `value` = distance between centres, m.
    ClosestApproach,
    /// Crossing the target's orbital plane; `value` = relative inclination, rad.
    AscendingNode,
    DescendingNode,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Marker {
    pub kind: MarkerKind,
    pub epoch: Epoch,
    /// Body the position is relative to.
    pub center: BodyId,
    pub position: V3,
    /// Altitude above the centre's mean equatorial radius (apsides, SOI, impact), or
    /// the kind-specific value documented on [`MarkerKind`].
    pub value: f64,
}

/// Samples per integrator step for sign-change detection.
const EVENT_SAMPLES: usize = 8;
/// Bisection tolerance, s.
const EVENT_TOL: f64 = 1e-3;
/// At most this many apsides per arc (long horizons of short orbits).
const MAX_APSIDES_PER_ARC: usize = 6;

/// Markers along `traj` from `from` on, for `target` (closest approach, plane nodes).
pub fn markers(
    eph: &Ephemeris,
    reg: &BodyRegistry,
    traj: &Trajectory,
    from: Epoch,
    target: Option<BodyId>,
) -> Vec<Marker> {
    let mut out = Vec::new();
    let radius = |b: BodyId| reg.get(b).map_or(0.0, |i| i.radii.equatorial_mean());
    // Target orbital plane about its parent, fixed at `from`.
    let plane = target.and_then(|t| {
        let parent = reg.get(t)?.parent?;
        let s = eph.state_relative(t, parent, from).ok()?;
        Some((parent, s.r.cross(s.v).normalized()?))
    });
    let mut best_ca: Option<Marker> = None;
    for arc in &traj.arcs {
        let c = arc.center;
        let t_from = from.seconds_since(arc.base).max(arc.t_start);
        if t_from > arc.t_end {
            continue;
        }
        let state = |t: f64| -> (V3, V3) {
            let y = eval_arc(arc, t);
            (V3::new(y[0], y[1], y[2]), V3::new(y[3], y[4], y[5]))
        };
        // Apsides: r·v changes sign.
        let apsis = |t: f64| {
            let (r, v) = state(t);
            r.dot(v)
        };
        let mut n_aps = 0;
        scan(arc, t_from, &apsis, |t, rising| {
            if n_aps >= MAX_APSIDES_PER_ARC {
                return;
            }
            n_aps += 1;
            let (r, _) = state(t);
            out.push(Marker {
                kind: if rising {
                    MarkerKind::Periapsis
                } else {
                    MarkerKind::Apoapsis
                },
                epoch: arc.base.add_seconds(t),
                center: c,
                position: r,
                value: r.norm() - radius(c),
            });
        });
        // Closest approach to the target (local minima of distance).
        if let Some(tb) = target.filter(|&tb| tb != c) {
            let rel = |t: f64| -> Option<(V3, V3)> {
                let ts = eph.state_relative(tb, c, arc.base.add_seconds(t)).ok()?;
                let (r, v) = state(t);
                Some((r - ts.r, v - ts.v))
            };
            let g = |t: f64| rel(t).map_or(0.0, |(d, w)| d.dot(w));
            scan(arc, t_from, &g, |t, rising| {
                if !rising {
                    return;
                }
                if let Some((d, _)) = rel(t) {
                    let m = Marker {
                        kind: MarkerKind::ClosestApproach,
                        epoch: arc.base.add_seconds(t),
                        center: c,
                        position: state(t).0,
                        value: d.norm(),
                    };
                    if best_ca.is_none_or(|b| m.value < b.value) {
                        best_ca = Some(m);
                    }
                }
            });
        }
        // Plane crossings, for arcs around the target's parent.
        if let Some((_, h)) = plane.filter(|(parent, _)| *parent == c) {
            let g = |t: f64| state(t).0.dot(h);
            let mut n = 0;
            scan(arc, t_from, &g, |t, rising| {
                if n >= 2 {
                    return;
                }
                n += 1;
                let (r, v) = state(t);
                let inc = r
                    .cross(v)
                    .normalized()
                    .map_or(0.0, |hn| fmath::acos(hn.dot(h).clamp(-1.0, 1.0)));
                out.push(Marker {
                    kind: if rising {
                        MarkerKind::AscendingNode
                    } else {
                        MarkerKind::DescendingNode
                    },
                    epoch: arc.base.add_seconds(t),
                    center: c,
                    position: r,
                    value: inc,
                });
            });
        }
        // Arc ends.
        let end = arc.base.add_seconds(arc.t_end);
        let (r_end, _) = state(arc.t_end);
        match arc.end {
            ArcEnd::SoiChange { from, to } => out.push(Marker {
                kind: MarkerKind::SoiChange { from, to },
                epoch: end,
                center: c,
                position: r_end,
                value: r_end.norm() - radius(c),
            }),
            ArcEnd::Impact { .. } => out.push(Marker {
                kind: MarkerKind::Impact,
                epoch: end,
                center: c,
                position: r_end,
                value: 0.0,
            }),
            _ => {}
        }
    }
    if let Some(ca) = best_ca {
        out.push(ca);
    }
    out.sort_by(|a, b| a.epoch.seconds_since(b.epoch).total_cmp(&0.0));
    out
}

fn eval_arc(arc: &crate::propagator::Arc, t: f64) -> [f64; 7] {
    if arc.steps.is_empty() || t <= arc.t_start {
        return arc.y_start;
    }
    let i = arc
        .steps
        .partition_point(|s| s.t1() < t)
        .min(arc.steps.len() - 1);
    arc.steps[i].eval(t)
}

/// Find sign changes of `g` over an arc from local time `t_from`; `found(t, rising)`
/// gets each root (rising = − to +).
fn scan(
    arc: &crate::propagator::Arc,
    t_from: f64,
    g: &dyn Fn(f64) -> f64,
    mut found: impl FnMut(f64, bool),
) {
    let mut prev_t = t_from;
    let mut prev_g = g(t_from);
    let mut sample = |t: f64, prev_t: &mut f64, prev_g: &mut f64| {
        if t <= *prev_t {
            return;
        }
        let gt = g(t);
        if (*prev_g < 0.0 && gt >= 0.0) || (*prev_g > 0.0 && gt <= 0.0) {
            let rising = *prev_g < 0.0;
            let (mut lo, mut hi) = (*prev_t, t);
            for _ in 0..80 {
                if hi - lo < EVENT_TOL {
                    break;
                }
                let mid = 0.5 * (lo + hi);
                let gm = g(mid);
                if (gm >= 0.0) == rising {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            found(0.5 * (lo + hi), rising);
        }
        *prev_t = t;
        *prev_g = gt;
    };
    for st in &arc.steps {
        if st.t1() <= t_from {
            continue;
        }
        for k in 1..=EVENT_SAMPLES {
            let t = (st.t0 + st.h * k as f64 / EVENT_SAMPLES as f64).min(arc.t_end);
            sample(t, &mut prev_t, &mut prev_g);
        }
        if st.t1() >= arc.t_end {
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Map geometry
// ---------------------------------------------------------------------------

/// Points along `traj` in [from, to], relative to `center`, following the
/// integrator's adaptive steps (dense where the path curves). Returns flat xyz and,
/// per point, the index of the arc it belongs to. At most `max_points` (decimated).
pub fn sample_path(
    eph: &Ephemeris,
    traj: &Trajectory,
    from: Epoch,
    to: Epoch,
    center: BodyId,
    max_points: usize,
) -> (Vec<f64>, Vec<u32>) {
    let mut ts: Vec<(usize, f64)> = Vec::new();
    for (ai, arc) in traj.arcs.iter().enumerate() {
        let lo = from.seconds_since(arc.base).max(arc.t_start);
        let hi = to.seconds_since(arc.base).min(arc.t_end);
        if hi < lo {
            continue;
        }
        ts.push((ai, lo));
        for st in &arc.steps {
            for k in 1..=4 {
                let t = st.t0 + st.h * f64::from(k) / 4.0;
                if t > lo && t < hi {
                    ts.push((ai, t));
                }
            }
        }
        ts.push((ai, hi));
    }
    let stride = ts.len().div_ceil(max_points.max(2));
    let mut xyz = Vec::new();
    let mut arcs = Vec::new();
    let n = ts.len();
    for (k, &(ai, t)) in ts.iter().enumerate() {
        if stride > 1 && k % stride != 0 && k + 1 != n {
            continue;
        }
        let arc = &traj.arcs[ai];
        let y = eval_arc(arc, t);
        let mut r = V3::new(y[0], y[1], y[2]);
        if arc.center != center {
            match eph.state_relative(arc.center, center, arc.base.add_seconds(t)) {
                Ok(off) => r += off.r,
                Err(_) => continue,
            }
        }
        xyz.extend([r.x, r.y, r.z]);
        arcs.push(ai as u32);
    }
    (xyz, arcs)
}

fn body_orientation(body: BodyId, t: Epoch) -> Option<BodyOrientation> {
    if body == BodyId::EARTH {
        Some(earth::earth_orientation(t).0)
    } else {
        orientation::iau_body_orientation(body, t)
    }
}

/// Sub-spacecraft points (latitude, longitude in radians) over `body`, `n` samples
/// uniformly in time over [from, to]. Earth uses WGS84 geodetic latitude; other bodies
/// planetocentric. Samples outside `body`'s arcs are skipped.
pub fn ground_track(
    eph: &Ephemeris,
    traj: &Trajectory,
    from: Epoch,
    to: Epoch,
    body: BodyId,
    n: usize,
) -> Vec<f64> {
    let mut out = Vec::new();
    let span = to.seconds_since(from);
    for k in 0..n {
        let t = from.add_seconds(span * k as f64 / (n.max(2) - 1) as f64);
        let Some(s) = traj.state_at(t) else { continue };
        let r = if s.state.frame.center == body {
            s.state.r
        } else {
            match eph.state_relative(s.state.frame.center, body, t) {
                Ok(off) => s.state.r + off.r,
                Err(_) => continue,
            }
        };
        let Some(o) = body_orientation(body, t) else {
            continue;
        };
        let bf = o.icrf_to_bf.mul_v3(r);
        let (lat, lon) = if body == BodyId::EARTH {
            let (lat, lon, _) = earth::itrs_to_geodetic(bf);
            (lat, lon)
        } else {
            (
                fmath::atan2(bf.z, fmath::hypot(bf.x, bf.y)),
                fmath::atan2(bf.y, bf.x),
            )
        };
        out.extend([lat, lon]);
    }
    out
}

/// Osculating conic of `body` about its parent at `t`: `n` points (ICRF, relative to
/// the parent). Closed for ellipses; for open orbits, the arc within ±120° of the
/// current true anomaly limit. Two-body μ = GM_parent + GM_body.
pub fn body_orbit(
    eph: &Ephemeris,
    reg: &BodyRegistry,
    body: BodyId,
    t: Epoch,
    n: usize,
) -> Vec<f64> {
    let Some(info) = reg.get(body) else {
        return Vec::new();
    };
    let Some(parent) = info.parent else {
        return Vec::new();
    };
    let Ok(s) = eph.state_relative(body, parent, t) else {
        return Vec::new();
    };
    let mu = reg.get(parent).map_or(0.0, |p| p.gm) + info.gm;
    let el = Elements::from_state(s.r, s.v, mu);
    let mut out = Vec::with_capacity(n * 3);
    for k in 0..n {
        let f = k as f64 / (n.max(2) - 1) as f64;
        let nu = if el.e < 1.0 {
            el.nu + core::f64::consts::TAU * f
        } else {
            el.nu + (f - 0.5) * 2.0 * 120f64.to_radians()
        };
        let (r, _) = Elements { nu, ..el }.to_state(mu);
        out.extend([r.x, r.y, r.z]);
    }
    out
}
