//! ephem-build: fit JPL SPK kernels into `.rseph` Chebyshev chunks (see
//! `sim_core::ephemeris` for the format and docs/plans/M2-ephemeris.md for the design).
//!
//! ```text
//! ephem-build build   [--out DIR]            per-decade files for the full spans
//! ephem-build fixture <epochs.txt> <out>     one-segment chunks around each epoch (CI fixture)
//! ephem-build verify  [--dir DIR] [--n N]    built files vs ANISE at random epochs
//! ```
//! The output is deterministic: segments are fitted independently and written in order.

use anise::prelude::{Almanac, Epoch as AEpoch, Frame};
use sha2::{Digest, Sha256};
use sim_core::bodies::BodyId;
use sim_core::chebyshev::{eval_with_derivative, fit_from_node_samples, nodes};
use sim_core::ephemeris::{Chunk, Ephemeris, encode, quantize};
use sim_core::math::V3;
use sim_core::time::Epoch;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const KERNEL_DIR: &str = "data/kernels";
const DAY: i64 = 86_400;
/// Max position error of the fit, m.
const POS_TOL: f64 = 1.0;
/// Max velocity error of the fit, m/s. Velocity is the analytic derivative of the
/// position fit, so it is self-consistent. 1 cm/s keeps short-period moons compact:
/// a 1 mm/s limit tripled the Phobos and Io sizes for no physical gain, since the
/// kernels' own uncertainty is orders of magnitude larger.
const VEL_TOL: f64 = 1e-2;
const MAX_COEF: usize = 26;

/// Span of the planets, barycenters, Sun and Moon (decision D6): 1950–2100.
const SPAN_PLANETS: (i64, i64) = (-18_262 * DAY - DAY / 2, 36_524 * DAY + DAY / 2);
/// Span of the satellites and small bodies: 2000–2100.
const SPAN_MOONS: (i64, i64) = (-DAY / 2, 36_524 * DAY + DAY / 2);

#[derive(Clone, Copy)]
enum Source {
    Kernel(&'static str),
    /// No kernel available. The target coincides with its center (zero offset).
    /// Used only for the Uranus body (see docs/plans/M2-ephemeris.md, open question 1).
    ZeroOffset,
}

struct Spec {
    target: i32,
    center: i32,
    source: Source,
    span: (i64, i64),
}

const fn spec(target: i32, center: i32, source: Source, span: (i64, i64)) -> Spec {
    Spec {
        target,
        center,
        source,
        span,
    }
}

fn specs() -> Vec<Spec> {
    use Source::*;
    let (p, m) = (SPAN_PLANETS, SPAN_MOONS);
    vec![
        spec(10, 0, Kernel("de440"), p),
        spec(199, 0, Kernel("de440"), p),
        spec(299, 0, Kernel("de440"), p),
        spec(399, 0, Kernel("de440"), p),
        spec(301, 399, Kernel("de440"), p),
        spec(4, 0, Kernel("de440"), p),
        spec(499, 4, Kernel("mar099"), p),
        spec(401, 499, Kernel("mar099"), m),
        spec(402, 499, Kernel("mar099"), m),
        spec(5, 0, Kernel("de440"), p),
        spec(599, 5, Kernel("jup365"), p),
        spec(501, 599, Kernel("jup365"), m),
        spec(502, 599, Kernel("jup365"), m),
        spec(503, 599, Kernel("jup365"), m),
        spec(504, 599, Kernel("jup365"), m),
        spec(6, 0, Kernel("de440"), p),
        spec(699, 6, Kernel("sat441"), p),
        spec(601, 699, Kernel("sat441"), m),
        spec(602, 699, Kernel("sat441"), m),
        spec(603, 699, Kernel("sat441"), m),
        spec(604, 699, Kernel("sat441"), m),
        spec(605, 699, Kernel("sat441"), m),
        spec(606, 699, Kernel("sat441"), m),
        spec(608, 699, Kernel("sat441"), m),
        spec(7, 0, Kernel("de440"), p),
        spec(799, 7, ZeroOffset, p),
        spec(8, 0, Kernel("de440"), p),
        spec(899, 8, Kernel("nep097"), p),
        spec(801, 899, Kernel("nep097"), m),
        spec(9, 0, Kernel("de440"), p),
        spec(999, 9, Kernel("plu060"), p),
        spec(2_000_001, 10, Kernel("sb441-n16"), m),
        spec(2_000_004, 10, Kernel("sb441-n16"), m),
    ]
}

/// Loaded kernels, one Almanac per file, so each body is read from exactly the
/// kernel named in its spec (no load-order priority games).
struct Kernels {
    almanacs: BTreeMap<&'static str, Arc<Almanac>>,
    sha256: BTreeMap<&'static str, String>,
}

impl Kernels {
    fn load(names: &[&'static str]) -> Kernels {
        let mut almanacs = BTreeMap::new();
        let mut sha256 = BTreeMap::new();
        for &n in names {
            let path = format!("{KERNEL_DIR}/{n}.bsp");
            let bytes = std::fs::read(&path)
                .unwrap_or_else(|e| panic!("{path}: {e} (run scripts/fetch-kernels.sh)"));
            sha256.insert(n, format!("{:x}", Sha256::digest(&bytes)));
            drop(bytes);
            let a = Almanac::default()
                .load(&path)
                .unwrap_or_else(|e| panic!("{path}: {e}"));
            almanacs.insert(n, Arc::new(a));
        }
        Kernels { almanacs, sha256 }
    }
}

/// Samples a spec's (target − center) state in meters, m/s at TDB seconds `t`.
struct Sampler {
    almanac: Option<Arc<Almanac>>,
    target: Frame,
    center: Frame,
}

impl Sampler {
    fn new(k: &Kernels, s: &Spec) -> Sampler {
        let almanac = match s.source {
            Source::Kernel(n) => Some(k.almanacs[n].clone()),
            Source::ZeroOffset => None,
        };
        Sampler {
            almanac,
            target: Frame::from_ephem_j2000(s.target),
            center: Frame::from_ephem_j2000(s.center),
        }
    }

    fn state(&self, t: f64) -> (V3, V3) {
        let Some(a) = &self.almanac else {
            return (V3::ZERO, V3::ZERO);
        };
        let s = a
            .translate_geometric(self.target, self.center, AEpoch::from_et_seconds(t))
            .unwrap_or_else(|e| panic!("ANISE translate at ET {t}: {e}"));
        let (r, v) = (s.radius_km, s.velocity_km_s);
        (
            V3::new(r[0], r[1], r[2]) * 1e3,
            V3::new(v[0], v[1], v[2]) * 1e3,
        )
    }
}

/// Coefficient quantum for `n` coefficients: rounding adds at most n·q/2 ≤ POS_TOL/8.
fn quantum_for(n: usize) -> f64 {
    POS_TOL / (4.0 * n as f64)
}

/// Fit one segment [a, a + len] and quantize. Returns `[x, y, z]` coefficient blocks.
fn fit_segment(s: &Sampler, a: i64, len: i64, n: usize) -> Vec<f64> {
    let q = quantum_for(n);
    let ts: Vec<f64> = nodes(n)
        .iter()
        .map(|tau| a as f64 + (tau + 1.0) * 0.5 * len as f64)
        .collect();
    let pos: Vec<V3> = ts.iter().map(|&t| s.state(t).0).collect();
    let mut out = Vec::with_capacity(3 * n);
    for comp in [|v: &V3| v.x, |v: &V3| v.y, |v: &V3| v.z] {
        let c = fit_from_node_samples(&pos.iter().map(comp).collect::<Vec<_>>());
        out.extend(c.into_iter().map(|x| quantize(x, q)));
    }
    out
}

/// Max (position, velocity) error of a fitted segment, checked densely enough that
/// fast oscillations inside a segment (e.g. Triton's pull on Neptune) can't alias
/// between test points.
fn segment_error(s: &Sampler, coefs: &[f64], a: i64, len: i64, n: usize) -> (f64, f64) {
    let (mut ep, mut ev) = (0.0f64, 0.0f64);
    let m = (4 * n + 8).max(64);
    let k = 2.0 / len as f64;
    for i in 0..=m {
        let tau = -1.0 + 2.0 * i as f64 / m as f64;
        let t = a as f64 + (tau + 1.0) * 0.5 * len as f64;
        let (r, v) = s.state(t);
        let e = |c: usize| eval_with_derivative(&coefs[c * n..(c + 1) * n], tau);
        let (x, dx) = e(0);
        let (y, dy) = e(1);
        let (z, dz) = e(2);
        ep = ep.max(r.max_abs_diff(V3::new(x, y, z)));
        ev = ev.max(v.max_abs_diff(V3::new(dx * k, dy * k, dz * k)));
    }
    (ep, ev)
}

/// Packed size of quantized coefficients (zigzag LEB128), bytes.
fn packed_bytes(coefs: &[f64], q: f64) -> usize {
    coefs
        .iter()
        .map(|&c| {
            let k = (c / q).round() as i64;
            let z = ((k << 1) ^ (k >> 63)) as u64;
            (64 - z.leading_zeros() as usize).max(1).div_ceil(7)
        })
        .sum()
}

/// Candidate layouts (segment length, coefficients per component), cheapest first,
/// each meeting tolerance with 2× margin on a sample of segments across the span.
fn candidate_layouts(s: &Sampler, span: (i64, i64), zero: bool) -> Vec<(i64, usize)> {
    if zero {
        return vec![(64 * DAY, 1)];
    }
    let lens = [128, 64, 32, 16, 8, 4, 2, 1]
        .map(|d| d * DAY)
        .into_iter()
        .chain([DAY / 2, DAY / 4, DAY / 8, DAY / 16]);
    let mut found: Vec<(f64, i64, usize)> = Vec::new();
    for len in lens {
        let n_total = (span.1 - span.0) / len;
        let samples = 48.min(n_total.max(1));
        let starts: Vec<i64> = (0..samples)
            .map(|i| span.0 + (i * n_total / samples) * len)
            .collect();
        for n in 6..=MAX_COEF {
            let fits: Vec<Vec<f64>> = starts.iter().map(|&a| fit_segment(s, a, len, n)).collect();
            let ok = fits.iter().zip(&starts).all(|(c, &a)| {
                let (ep, ev) = segment_error(s, c, a, len, n);
                ep < 0.5 * POS_TOL && ev < 0.5 * VEL_TOL
            });
            if ok {
                let bytes: usize = fits.iter().map(|c| packed_bytes(c, quantum_for(n))).sum();
                let per_year = 365.25 * DAY as f64 / len as f64 * bytes as f64 / fits.len() as f64;
                found.push((per_year, len, n));
                break;
            }
        }
    }
    assert!(!found.is_empty(), "no layout meets tolerance");
    found.sort_by(|a, b| a.0.total_cmp(&b.0));
    found.into_iter().map(|(_, l, n)| (l, n)).collect()
}

/// Fit a whole span with a fixed layout, in parallel, and check every segment.
fn fit_span(
    s: &Arc<Sampler>,
    start: i64,
    len: i64,
    n_seg: usize,
    n: usize,
    zero: bool,
) -> (Vec<f64>, f64, f64) {
    if zero {
        return (vec![0.0; n_seg * 3 * n], 0.0, 0.0);
    }
    let threads = std::thread::available_parallelism().map_or(4, |x| x.get());
    let per = n_seg.div_ceil(threads);
    let parts: Vec<(Vec<f64>, f64, f64)> = std::thread::scope(|sc| {
        let handles: Vec<_> = (0..threads)
            .map(|ti| {
                let s = s.clone();
                sc.spawn(move || {
                    let mut out = Vec::new();
                    let (mut ep, mut ev) = (0.0f64, 0.0f64);
                    for i in (ti * per)..((ti + 1) * per).min(n_seg) {
                        let a = start + i as i64 * len;
                        let c = fit_segment(&s, a, len, n);
                        let (p, v) = segment_error(&s, &c, a, len, n);
                        ep = ep.max(p);
                        ev = ev.max(v);
                        out.extend(c);
                    }
                    (out, ep, ev)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("fit thread"))
            .collect()
    });
    let mut coefs = Vec::with_capacity(n_seg * 3 * n);
    let (mut ep, mut ev) = (0.0f64, 0.0f64);
    for (c, p, v) in parts {
        coefs.extend(c);
        ep = ep.max(p);
        ev = ev.max(v);
    }
    (coefs, ep, ev)
}

struct Fitted {
    start: i64,
    len: i64,
    n: usize,
    n_seg: usize,
    coefs: Vec<f64>,
    ep: f64,
    ev: f64,
}

/// Fit a body over its whole span. Layouts are tried cheapest first. If any segment
/// of the full span misses tolerance, the degree is raised; once it reaches
/// MAX_COEF, the next (shorter-segment) layout is tried.
fn fit_body(k: &Kernels, s: &Spec) -> Fitted {
    let zero = matches!(s.source, Source::ZeroOffset);
    let sampler = Arc::new(Sampler::new(k, s));
    for (len, n0) in candidate_layouts(&sampler, s.span, zero) {
        // Segment grid aligned to J2000 so decade files join seamlessly.
        let start = s.span.0.div_euclid(len) * len;
        let end = (s.span.1 + len - 1).div_euclid(len) * len;
        let n_seg = ((end - start) / len) as usize;
        for n in n0..=MAX_COEF.max(n0) {
            let (coefs, ep, ev) = fit_span(&sampler, start, len, n_seg, n, zero);
            if ep <= POS_TOL && ev <= VEL_TOL {
                return Fitted {
                    start,
                    len,
                    n,
                    n_seg,
                    coefs,
                    ep,
                    ev,
                };
            }
            eprintln!(
                "  body {}: {len} s × {n} coefs misses tolerance ({ep:.3} m, {ev:.2e} m/s); retrying",
                s.target
            );
        }
    }
    panic!("body {}: no layout meets tolerance", s.target);
}

fn kernel_names() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = specs()
        .iter()
        .filter_map(|s| match s.source {
            Source::Kernel(n) => Some(n),
            Source::ZeroOffset => None,
        })
        .collect();
    v.sort();
    v.dedup();
    v
}

fn meta(k: &Kernels, extra: &str) -> String {
    let mut m = format!(
        "rocketsim ephem-build {} | fit tolerance {POS_TOL} m, {VEL_TOL} m/s (after quantization) | kernels:",
        env!("CARGO_PKG_VERSION")
    );
    for (n, h) in &k.sha256 {
        m.push_str(&format!(" {n}.bsp sha256={h}"));
    }
    m.push_str(" | 799 (Uranus) = Uranus barycenter (zero offset, no satellite kernel) | ");
    m.push_str(extra);
    m
}

/// Decade boundaries (TDB seconds of 20X0-01-01T00:00 ≈ multiple of 3652.5 days from J2000).
fn decade_starts() -> Vec<(i32, i64)> {
    (1950..2100)
        .step_by(10)
        .map(|y| {
            (
                y,
                sim_core::time::days_from_civil(y as i64, 1, 1) * DAY - 10_957 * DAY - DAY / 2,
            )
        })
        .collect()
}

fn cmd_build(out: &Path) {
    std::fs::create_dir_all(out).expect("create output dir");
    let k = Kernels::load(&kernel_names());
    let decades = decade_starts();
    let mut per_decade: BTreeMap<i32, Vec<Chunk>> = BTreeMap::new();
    println!(
        "{:>8} {:>6} {:>8} {:>5} {:>10} {:>10} {:>9}",
        "target", "center", "seg [d]", "coef", "max |dr|", "max |dv|", "MB"
    );
    for s in specs() {
        let Fitted {
            start,
            len,
            n,
            n_seg,
            coefs,
            ep,
            ev,
        } = fit_body(&k, &s);
        let end = start + n_seg as i64 * len;
        println!(
            "{:>8} {:>6} {:>8.3} {:>5} {:>8.3} m {:>6.2e} {:>9.2}",
            s.target,
            s.center,
            len as f64 / DAY as f64,
            n,
            ep,
            ev,
            (coefs.len() * 8) as f64 / 1e6
        );
        // Split into decade chunks on the segment grid.
        for (i, &(year, d0)) in decades.iter().enumerate() {
            let d1 = decades.get(i + 1).map_or(i64::MAX, |x| x.1);
            let first = ((d0.max(start) - start) as f64 / len as f64).floor() as i64;
            let last = (((d1.min(end) - start) + len - 1) / len).min(n_seg as i64);
            if d1 <= start || d0 >= end || first >= last {
                continue;
            }
            let (f, l) = (first as usize, last as usize);
            per_decade.entry(year).or_default().push(Chunk {
                target: BodyId(s.target),
                center: BodyId(s.center),
                start: start + first * len,
                seg_len: len,
                n_seg: (l - f) as u32,
                n_coef: n as u32,
                quantum: quantum_for(n),
                coefs: coefs[f * 3 * n..l * 3 * n].to_vec(),
            });
        }
    }
    let mut total = 0;
    for (year, chunks) in per_decade {
        let bytes = encode(&chunks, &meta(&k, &format!("decade {year}")));
        total += bytes.len();
        let path = out.join(format!("ephem-{year}.rseph"));
        std::fs::write(&path, &bytes).expect("write");
        println!(
            "wrote {} ({:.1} MB)",
            path.display(),
            bytes.len() as f64 / 1e6
        );
    }
    println!("total {:.1} MB", total as f64 / 1e6);
}

/// Epoch list → for each body whose span covers the epoch, one segment around it.
fn cmd_fixture(epochs_file: &Path, out: &Path) {
    let text = std::fs::read_to_string(epochs_file).expect("read epochs");
    let epochs: Vec<f64> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.parse().expect("TDB seconds per line"))
        .collect();
    let k = Kernels::load(&kernel_names());
    let mut chunks = Vec::new();
    for s in specs() {
        let f = fit_body(&k, &s);
        let mut seen = Vec::new();
        for &t in &epochs {
            if t < s.span.0 as f64 || t >= s.span.1 as f64 {
                continue;
            }
            let i = ((t.floor() as i64 - f.start).div_euclid(f.len)) as usize;
            if seen.contains(&i) {
                continue;
            }
            seen.push(i);
            let w = 3 * f.n;
            chunks.push(Chunk {
                target: BodyId(s.target),
                center: BodyId(s.center),
                start: f.start + i as i64 * f.len,
                seg_len: f.len,
                n_seg: 1,
                n_coef: f.n as u32,
                quantum: quantum_for(f.n),
                coefs: f.coefs[i * w..(i + 1) * w].to_vec(),
            });
        }
    }
    let bytes = encode(
        &chunks,
        &meta(
            &k,
            &format!(
                "CI fixture: one segment per body around each epoch in {}",
                epochs_file.display()
            ),
        ),
    );
    std::fs::write(out, &bytes).expect("write fixture");
    println!(
        "wrote {} ({} chunks, {:.0} KB)",
        out.display(),
        chunks.len(),
        bytes.len() as f64 / 1e3
    );
}

/// Built files vs ANISE at pseudo-random epochs (fixed seed: reproducible).
fn cmd_verify(dir: &Path, n: usize) {
    let mut eph = Ephemeris::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("dir")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "rseph"))
        .collect();
    files.sort();
    for f in &files {
        eph.load(&std::fs::read(f).expect("read")).expect("load");
    }
    let k = Kernels::load(&kernel_names());
    let mut rng: u64 = 0x9e37_79b9_7f4a_7c15;
    println!(
        "{:>8} {:>12} {:>12}",
        "target", "max |dr| m", "max |dv| m/s"
    );
    for s in specs() {
        let sampler = Sampler::new(&k, &s);
        let (mut ep, mut ev) = (0.0f64, 0.0f64);
        for _ in 0..n {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let t = s.span.0 as f64
                + (rng >> 11) as f64 / (1u64 << 53) as f64 * (s.span.1 - s.span.0) as f64;
            let (c, r, v) = eph
                .state_wrt_center(BodyId(s.target), Epoch::from_tdb_seconds(t))
                .expect("coverage");
            assert_eq!(c, BodyId(s.center));
            let (r0, v0) = sampler.state(t);
            ep = ep.max(r.max_abs_diff(r0));
            ev = ev.max(v.max_abs_diff(v0));
        }
        println!("{:>8} {:>12.4} {:>12.2e}", s.target, ep, ev);
        assert!(
            ep <= POS_TOL && ev <= VEL_TOL,
            "body {} exceeds tolerance",
            s.target
        );
    }
    println!("verify OK ({} files, {n} epochs per body)", files.len());
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["build"] => cmd_build(Path::new("web/public/ephemeris")),
        ["build", "--out", d] => cmd_build(Path::new(d)),
        ["fixture", e, o] => cmd_fixture(Path::new(e), Path::new(o)),
        ["verify"] => cmd_verify(Path::new("web/public/ephemeris"), 2000),
        ["verify", "--dir", d] => cmd_verify(Path::new(d), 2000),
        ["verify", "--dir", d, "--n", n] => cmd_verify(Path::new(d), n.parse().expect("N")),
        _ => {
            eprintln!(
                "usage: ephem-build build [--out DIR] | fixture <epochs.txt> <out.rseph> | verify [--dir DIR] [--n N]"
            );
            std::process::exit(2);
        }
    }
}
