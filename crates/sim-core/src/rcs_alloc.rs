//! Thruster allocation: map a commanded body wrench (force + torque) to thruster
//! duty cycles in [0, 1].
//!
//! Every thruster contributes a full-thrust wrench column bⱼ = [fⱼ; (pⱼ − c) × fⱼ]
//! about the current centre of mass c, so translation and rotation stay physically
//! coupled: a lateral thruster that also makes torque has that torque counted.
//!
//! Solve min ‖W(B u − w)‖² + λ‖u‖² subject to u ≥ 0 with the Lawson–Hanson active-set
//! method in its normal-equation form: FNNLS (Bro & De Jong, "A fast
//! non-negativity-constrained least squares algorithm", J. Chemometrics 11:393, 1997).
//! - W divides torque rows by a reference arm, so both row groups are in newtons.
//! - The small Tikhonov term λ makes the problem strictly convex: the solution is
//!   unique, and the solver prefers the least-propellant combination among the exact ones.
//! - If some duty then exceeds 1, the whole vector is scaled down. The achieved
//!   wrench keeps the commanded direction and only its magnitude saturates.
//!
//! Deterministic: fixed iteration order, ties go to the lowest index, no hashing.

/// Wrench column of one thruster at full thrust: [Fx, Fy, Fz, Tx, Ty, Tz] (N, N·m).
pub type Wrench = [f64; 6];

/// Allocation result.
#[derive(Clone, Debug, PartialEq)]
pub struct Allocation {
    /// Duty cycle per thruster, in [0, 1].
    pub duty: Vec<f64>,
    /// Achieved wrench B·u.
    pub achieved: Wrench,
    /// Scale applied to fit the duty bounds (1 = request fully met in direction).
    pub scale: f64,
}

/// Relative Tikhonov weight (times the mean diagonal of BᵀWᵀWB).
const REGULARIZATION: f64 = 1e-6;
/// Stop when no inactive thruster improves the objective by more than this relative amount.
const TOLERANCE: f64 = 1e-12;

pub fn achieved(columns: &[Wrench], duty: &[f64]) -> Wrench {
    let mut w = [0.0; 6];
    for (c, &u) in columns.iter().zip(duty) {
        for k in 0..6 {
            w[k] += c[k] * u;
        }
    }
    w
}

/// Allocate `want` over `columns`. `arm` is the torque-row scale (m), e.g. the largest
/// thruster lever arm.
// Index loops keep the summation order explicit (determinism).
#[allow(clippy::needless_range_loop)]
pub fn allocate(columns: &[Wrench], want: Wrench, arm: f64) -> Allocation {
    let n = columns.len();
    let arm = if arm > 0.0 { arm } else { 1.0 };
    let weight = [1.0, 1.0, 1.0, 1.0 / arm, 1.0 / arm, 1.0 / arm];
    let wb: Vec<Wrench> = columns
        .iter()
        .map(|c| core::array::from_fn(|k| c[k] * weight[k]))
        .collect();
    let ww: Wrench = core::array::from_fn(|k| want[k] * weight[k]);
    // Normal equations Q = BᵀB + λI, b = Bᵀw.
    let mut q = vec![0.0; n * n];
    let mut b = vec![0.0; n];
    for i in 0..n {
        for j in 0..n {
            let mut s = 0.0;
            for k in 0..6 {
                s += wb[i][k] * wb[j][k];
            }
            q[i * n + j] = s;
        }
        let mut s = 0.0;
        for k in 0..6 {
            s += wb[i][k] * ww[k];
        }
        b[i] = s;
    }
    let mean_diag = if n > 0 {
        (0..n).map(|i| q[i * n + i]).sum::<f64>() / n as f64
    } else {
        0.0
    };
    let lambda = REGULARIZATION * mean_diag.max(f64::MIN_POSITIVE);
    for i in 0..n {
        q[i * n + i] += lambda;
    }
    let mut duty = fnnls(&q, &b, n);
    let max = duty.iter().copied().fold(0.0, f64::max);
    let scale = if max > 1.0 { 1.0 / max } else { 1.0 };
    for u in &mut duty {
        *u = (*u * scale).clamp(0.0, 1.0);
    }
    let achieved = achieved(columns, &duty);
    Allocation {
        duty,
        achieved,
        scale,
    }
}

/// FNNLS: min ½xᵀQx − bᵀx subject to x ≥ 0, for symmetric positive-definite Q (n×n,
/// row-major).
fn fnnls(q: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut x = vec![0.0; n];
    let mut passive = vec![false; n];
    let bmax = b.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
    let tol = TOLERANCE * bmax.max(f64::MIN_POSITIVE);
    for _outer in 0..(3 * n + 3) {
        // Gradient of the negative objective: w = b − Qx.
        let w: Vec<f64> = (0..n)
            .map(|i| b[i] - (0..n).map(|j| q[i * n + j] * x[j]).sum::<f64>())
            .collect();
        let mut best = None;
        for i in 0..n {
            if !passive[i] && w[i] > tol && best.is_none_or(|(_, v)| w[i] > v) {
                best = Some((i, w[i]));
            }
        }
        let Some((j, _)) = best else { break };
        passive[j] = true;
        for _inner in 0..(3 * n + 3) {
            let s = solve_passive(q, b, n, &passive);
            // All passive components positive: accept.
            if (0..n).all(|i| !passive[i] || s[i] > 0.0) {
                x = s;
                break;
            }
            // Step toward s until the first passive component hits zero.
            let mut alpha = f64::INFINITY;
            for i in 0..n {
                if passive[i] && s[i] <= 0.0 {
                    let a = x[i] / (x[i] - s[i]);
                    if a < alpha {
                        alpha = a;
                    }
                }
            }
            for i in 0..n {
                x[i] += alpha * (s[i] - x[i]);
                if passive[i] && x[i] <= tol {
                    passive[i] = false;
                    x[i] = 0.0;
                }
            }
        }
    }
    x
}

/// Solve Q_PP s_P = b_P (Cholesky); s is zero outside the passive set.
fn solve_passive(q: &[f64], b: &[f64], n: usize, passive: &[bool]) -> Vec<f64> {
    let idx: Vec<usize> = (0..n).filter(|&i| passive[i]).collect();
    let m = idx.len();
    let mut l = vec![0.0; m * m];
    for r in 0..m {
        for c in 0..=r {
            let mut s = q[idx[r] * n + idx[c]];
            for k in 0..c {
                s -= l[r * m + k] * l[c * m + k];
            }
            if r == c {
                l[r * m + r] = s.max(f64::MIN_POSITIVE).sqrt();
            } else {
                l[r * m + c] = s / l[c * m + c];
            }
        }
    }
    // Forward then back substitution.
    let mut y = vec![0.0; m];
    for r in 0..m {
        let mut s = b[idx[r]];
        for k in 0..r {
            s -= l[r * m + k] * y[k];
        }
        y[r] = s / l[r * m + r];
    }
    let mut z = vec![0.0; m];
    for r in (0..m).rev() {
        let mut s = y[r];
        for k in (r + 1)..m {
            s -= l[k * m + r] * z[k];
        }
        z[r] = s / l[r * m + r];
    }
    let mut out = vec![0.0; n];
    for (k, &i) in idx.iter().enumerate() {
        out[i] = z[k];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::V3;

    /// A cube-corner layout: 4 quads around the X axis at x = 0, each with ±X and
    /// ±tangential thrusters (16 total), CoM at the origin offset by `c`.
    fn quads(c: V3) -> Vec<Wrench> {
        let mut cols = Vec::new();
        let r = 2.0;
        for (py, pz) in [(r, 0.0), (0.0, r), (-r, 0.0), (0.0, -r)] {
            let p = V3::new(-0.5, py, pz);
            let radial = V3::new(0.0, py, pz) * (1.0 / r);
            let tangent = V3::X.cross(radial);
            for d in [V3::X, -V3::X, tangent, -tangent] {
                let f = d * 100.0;
                let t = (p - c).cross(f);
                cols.push([f.x, f.y, f.z, t.x, t.y, t.z]);
            }
        }
        cols
    }

    fn norm3(a: &[f64]) -> f64 {
        (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
    }

    #[test]
    #[allow(clippy::needless_range_loop)]
    fn pure_torque_gives_no_net_force() {
        for c in [V3::ZERO, V3::new(-1.3, 0.0, 0.0)] {
            let cols = quads(c);
            for want in [
                [0.0, 0.0, 0.0, 50.0, 0.0, 0.0],
                [0.0, 0.0, 0.0, 0.0, 80.0, 0.0],
                [0.0, 0.0, 0.0, 10.0, -30.0, 60.0],
            ] {
                let a = allocate(&cols, want, 2.0);
                assert!(
                    norm3(&a.achieved[..3]) < 1e-3,
                    "force leak {:?}",
                    a.achieved
                );
                for k in 3..6 {
                    assert!((a.achieved[k] - want[k]).abs() < 1e-3 * (1.0 + want[k].abs()));
                }
                assert!(a.duty.iter().all(|&u| (0.0..=1.0).contains(&u)));
            }
        }
    }

    #[test]
    fn pure_force_gives_no_net_torque() {
        let cols = quads(V3::new(-1.3, 0.0, 0.0));
        let a = allocate(&cols, [60.0, 0.0, 0.0, 0.0, 0.0, 0.0], 2.0);
        assert!(norm3(&a.achieved[3..]) < 1e-3);
        assert!((a.achieved[0] - 60.0).abs() < 1e-3);
        // Lateral translation from tangential thrusters at x = −0.5, CoM at −1.3: the
        // allocator must cancel the pitch torque that this creates.
        let a = allocate(&cols, [0.0, 50.0, 0.0, 0.0, 0.0, 0.0], 2.0);
        assert!(norm3(&a.achieved[3..]) < 1e-2, "{:?}", a.achieved);
        assert!((a.achieved[1] - 50.0).abs() < 1e-2);
    }

    #[test]
    fn saturated_request_keeps_its_direction() {
        let cols = quads(V3::ZERO);
        let want = [0.0, 0.0, 0.0, 1e5, 2e5, 0.0];
        let a = allocate(&cols, want, 2.0);
        assert!(a.scale < 1.0);
        let (tx, ty) = (a.achieved[3], a.achieved[4]);
        // The λ‖u‖² term bends the direction by O(λ) = 1e-6.
        assert!((ty / tx - 2.0).abs() < 1e-5, "direction changed: {tx} {ty}");
        assert!(a.duty.iter().any(|&u| (u - 1.0).abs() < 1e-12));
    }

    #[test]
    fn opposed_thrusters_are_not_fired_together() {
        // Minimum-norm: no thruster pair fights itself for a small torque.
        let cols = quads(V3::ZERO);
        let a = allocate(&cols, [0.0, 0.0, 0.0, 20.0, 0.0, 0.0], 2.0);
        let total: f64 = a.duty.iter().sum();
        // Roll by tangentials only: 4 thrusters × 100 N × 2 m → 20 N·m needs Σu = 0.1.
        assert!((total - 0.1).abs() < 1e-6, "Σu = {total}");
    }
}
