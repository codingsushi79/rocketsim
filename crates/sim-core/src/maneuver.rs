//! Mission-plan data model: maneuver nodes grouped into legs.
//!
//! M6 flies a single leg. The multi-leg shape is here so the M9 transfer planner
//! (Lambert arcs, gravity assists) and M10 save files use the same structures.

use crate::bodies::BodyId;
use crate::math::V3;
use crate::time::Epoch;
use serde::{Deserialize, Serialize};

/// A planned impulse, executed as a finite burn centred on `epoch` (see
/// [`crate::prediction`]).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManeuverNode {
    /// Node time, TDB seconds past J2000 (serialised as one f64; display precision).
    pub epoch_tdb: f64,
    /// Δv in the orbit frame at the node, m/s: prograde (along the velocity relative to
    /// the centre body), normal (along r × v), radial (outward, prograde × normal).
    pub prograde: f64,
    pub normal: f64,
    pub radial: f64,
}

impl ManeuverNode {
    pub fn new(epoch: Epoch, prograde: f64, normal: f64, radial: f64) -> ManeuverNode {
        ManeuverNode {
            epoch_tdb: epoch.tdb_seconds(),
            prograde,
            normal,
            radial,
        }
    }

    pub fn epoch(&self) -> Epoch {
        Epoch::from_tdb_seconds(self.epoch_tdb)
    }

    pub fn dv(&self) -> V3 {
        V3::new(self.prograde, self.normal, self.radial)
    }

    pub fn dv_magnitude(&self) -> f64 {
        self.dv().norm()
    }
}

/// One leg of a mission: nodes flown toward an optional target (e.g. a flyby body).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Leg {
    pub nodes: Vec<ManeuverNode>,
    /// NAIF id of the body this leg aims at, if any.
    pub target: Option<i32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MissionPlan {
    pub legs: Vec<Leg>,
}

impl MissionPlan {
    /// All nodes in time order, with (leg, index-in-leg).
    pub fn nodes(&self) -> Vec<(usize, usize, ManeuverNode)> {
        let mut v: Vec<_> = self
            .legs
            .iter()
            .enumerate()
            .flat_map(|(l, leg)| leg.nodes.iter().enumerate().map(move |(i, n)| (l, i, *n)))
            .collect();
        v.sort_by(|a, b| a.2.epoch_tdb.total_cmp(&b.2.epoch_tdb));
        v
    }

    pub fn target(&self) -> Option<BodyId> {
        self.legs.iter().find_map(|l| l.target).map(BodyId)
    }
}

/// Orthonormal orbit frame at a state: (prograde, normal, radial-out), or `None` for a
/// degenerate (rectilinear or zero-velocity) state.
pub fn orbit_frame(r: V3, v: V3) -> Option<(V3, V3, V3)> {
    let pro = v.normalized()?;
    let nrm = r.cross(v).normalized()?;
    let rad = pro.cross(nrm).normalized()?;
    Some((pro, nrm, rad))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orbit_frame_is_right_handed_and_radial_points_out() {
        let r = V3::new(7e6, 0.0, 0.0);
        let v = V3::new(0.0, 7.5e3, 0.0);
        let (p, n, rad) = orbit_frame(r, v).unwrap();
        assert!(p.max_abs_diff(V3::Y) < 1e-15);
        assert!(n.max_abs_diff(V3::Z) < 1e-15);
        assert!(rad.max_abs_diff(V3::X) < 1e-15);
    }

    #[test]
    fn plan_round_trips_through_json() {
        let plan = MissionPlan {
            legs: vec![Leg {
                nodes: vec![ManeuverNode::new(Epoch::J2000, 100.0, -2.0, 0.5)],
                target: Some(301),
            }],
        };
        let s = serde_json::to_string(&plan).unwrap();
        assert_eq!(serde_json::from_str::<MissionPlan>(&s).unwrap(), plan);
    }
}
