//! Celestial-body ephemerides "on rails": Chebyshev segments fitted offline to the
//! JPL kernels (tools/ephem-build) and evaluated here.
//!
//! # File format (`.rseph`, little-endian)
//! ```text
//! magic    8 bytes  "RSEPH\0\0\x02" (last byte = format version)
//! n_chunks u32
//! meta_len u32      length of UTF-8 provenance text that follows
//! meta     meta_len bytes (source kernels + SHA-256, build tolerance, tool version)
//! chunks   n_chunks × {
//!   target  i32     NAIF id
//!   center  i32     NAIF id the position is relative to
//!   start   i64     TDB seconds past J2000 of the first segment start
//!   seg_len i64     segment length, s (integer: boundaries land on whole seconds)
//!   n_seg   u32
//!   n_coef  u32     coefficients per component (degree + 1)
//!   quantum f64     coefficient step q, m
//!   n_bytes u32     length of the packed coefficients
//!   packed  n_seg × 3 × n_coef zigzag-LEB128 integers k; coefficient = k · q
//!                   order [segment][x,y,z][k]
//! }
//! ```
//! Quantization: since |T_k| ≤ 1 on [−1, 1], rounding each coefficient to a
//! multiple of q adds at most n_coef · q / 2 of position error. The builder picks
//! q so that this is ≤ 1/8 of its tolerance, and verifies the fit *after*
//! quantization. High-order coefficients are tiny, so they pack into 1–2 bytes
//! instead of 8.
//! Positions are ICRF axes, meters, TDB. Velocity is the analytic time derivative
//! of the position series, which is also how JPL's own DE readers get velocity.
//!
//! A body can have several chunks (e.g. decade files streamed separately, or the
//! sparse CI test fixture). Every chunk for one target must use the same center,
//! so the bodies form a tree rooted at the SSB (id 0).

use crate::bodies::BodyId;
use crate::chebyshev;
use crate::frames::{IcrfBody, IcrfSsb, State, StateIcrfBody, StateIcrfSsb};
use crate::math::V3;
use crate::time::Epoch;
use std::collections::BTreeMap;

pub const MAGIC: [u8; 8] = *b"RSEPH\0\0\x02";

/// One contiguous run of equal-length Chebyshev segments for one body.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub target: BodyId,
    pub center: BodyId,
    /// TDB seconds past J2000 at the start of segment 0.
    pub start: i64,
    /// Segment length, s.
    pub seg_len: i64,
    pub n_seg: u32,
    /// Coefficients per component (degree + 1).
    pub n_coef: u32,
    /// Coefficient quantum q, m. Every coefficient is an exact integer multiple of q
    /// (see [`quantize`]).
    pub quantum: f64,
    /// `[segment][component][k]`, meters.
    pub coefs: Vec<f64>,
}

/// Round a coefficient to a multiple of `q`. Uses the same expression as the
/// decoder, so in-memory and decoded values are bit-identical.
pub fn quantize(c: f64, q: f64) -> f64 {
    let r = (c / q).round();
    assert!(
        r.abs() < 4.6e18,
        "coefficient {c} too large for quantum {q}"
    );
    let k = r as i64;
    k as f64 * q
}

impl Chunk {
    pub fn end(&self) -> i64 {
        self.start + self.seg_len * i64::from(self.n_seg)
    }

    fn covers(&self, t: Epoch) -> bool {
        let (s, f) = t.tdb_parts();
        s >= self.start && (s < self.end() || (s == self.end() && f == 0.0))
    }

    /// Position (m) and velocity (m/s) of `target` relative to `center` at `t`.
    /// The caller has already checked [`Chunk::covers`].
    fn eval(&self, t: Epoch) -> (V3, V3) {
        let (s, f) = t.tdb_parts();
        let dt = (s - self.start) as f64 + f;
        let len = self.seg_len as f64;
        // The end instant belongs to the last segment (τ = +1).
        let idx = ((dt / len) as u32).min(self.n_seg - 1);
        let local = dt - f64::from(idx) * len;
        let tau = 2.0 * local / len - 1.0;
        let n = self.n_coef as usize;
        let base = idx as usize * 3 * n;
        let comp = |i: usize| {
            chebyshev::eval_with_derivative(&self.coefs[base + i * n..base + (i + 1) * n], tau)
        };
        let (x, dx) = comp(0);
        let (y, dy) = comp(1);
        let (z, dz) = comp(2);
        let k = 2.0 / len; // dτ/dt
        (V3::new(x, y, z), V3::new(dx * k, dy * k, dz * k))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum EphemerisError {
    Format(String),
    UnknownBody(BodyId),
    /// No loaded chunk covers this body at this epoch.
    NoCoverage {
        body: BodyId,
        tdb_seconds: f64,
    },
    /// A chunk's center disagrees with an earlier chunk of the same target.
    InconsistentCenter {
        target: BodyId,
        a: BodyId,
        b: BodyId,
    },
}

impl core::fmt::Display for EphemerisError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            EphemerisError::Format(s) => write!(f, "ephemeris format error: {s}"),
            EphemerisError::UnknownBody(b) => write!(f, "no ephemeris for body {}", b.0),
            EphemerisError::NoCoverage { body, tdb_seconds } => {
                write!(
                    f,
                    "no ephemeris coverage for body {} at TDB {tdb_seconds} s",
                    body.0
                )
            }
            EphemerisError::InconsistentCenter { target, a, b } => {
                write!(
                    f,
                    "body {} has chunks relative to both {} and {}",
                    target.0, a.0, b.0
                )
            }
        }
    }
}

impl std::error::Error for EphemerisError {}

/// Loaded ephemeris: chunks indexed by target body.
#[derive(Clone, Debug, Default)]
pub struct Ephemeris {
    chunks: BTreeMap<BodyId, Vec<Chunk>>,
    center: BTreeMap<BodyId, BodyId>,
    meta: Vec<String>,
}

impl Ephemeris {
    pub fn new() -> Ephemeris {
        Ephemeris::default()
    }

    /// Parse a `.rseph` file and merge its chunks.
    pub fn load(&mut self, bytes: &[u8]) -> Result<(), EphemerisError> {
        let (chunks, meta) = decode(bytes)?;
        for c in chunks {
            self.insert(c)?;
        }
        self.meta.push(meta);
        Ok(())
    }

    pub fn insert(&mut self, c: Chunk) -> Result<(), EphemerisError> {
        if c.seg_len <= 0 || c.n_seg == 0 || c.n_coef == 0 {
            return Err(EphemerisError::Format(format!(
                "empty chunk for body {}",
                c.target.0
            )));
        }
        if !(c.quantum > 0.0 && c.quantum.is_finite()) {
            return Err(EphemerisError::Format(format!(
                "bad quantum for body {}",
                c.target.0
            )));
        }
        if c.coefs
            .iter()
            .any(|x| (x / c.quantum).abs() >= 4.6e18 || x.is_nan())
        {
            return Err(EphemerisError::Format(format!(
                "coefficient overflow for body {}",
                c.target.0
            )));
        }
        if c.coefs.len() != c.n_seg as usize * 3 * c.n_coef as usize {
            return Err(EphemerisError::Format(format!(
                "bad coefficient count for body {}",
                c.target.0
            )));
        }
        if let Some(&existing) = self.center.get(&c.target)
            && existing != c.center
        {
            return Err(EphemerisError::InconsistentCenter {
                target: c.target,
                a: existing,
                b: c.center,
            });
        }
        self.center.insert(c.target, c.center);
        let list = self.chunks.entry(c.target).or_default();
        let pos = list.partition_point(|x| x.start < c.start);
        list.insert(pos, c);
        Ok(())
    }

    /// Provenance text of every loaded file.
    pub fn meta(&self) -> &[String] {
        &self.meta
    }

    pub fn bodies(&self) -> impl Iterator<Item = BodyId> + '_ {
        self.chunks.keys().copied()
    }

    /// The body `target`'s positions are stored relative to.
    pub fn center_of(&self, target: BodyId) -> Option<BodyId> {
        self.center.get(&target).copied()
    }

    /// Covered intervals of a body, as (start, end) TDB seconds, merged when contiguous.
    pub fn coverage(&self, target: BodyId) -> Vec<(i64, i64)> {
        let mut out: Vec<(i64, i64)> = Vec::new();
        for c in self.chunks.get(&target).into_iter().flatten() {
            match out.last_mut() {
                Some(last) if c.start <= last.1 => last.1 = last.1.max(c.end()),
                _ => out.push((c.start, c.end())),
            }
        }
        out
    }

    /// State of `target` relative to its stored center.
    pub fn state_wrt_center(
        &self,
        target: BodyId,
        t: Epoch,
    ) -> Result<(BodyId, V3, V3), EphemerisError> {
        let list = self
            .chunks
            .get(&target)
            .ok_or(EphemerisError::UnknownBody(target))?;
        // Last chunk starting at or before t.
        let (s, _) = t.tdb_parts();
        let i = list.partition_point(|c| c.start <= s);
        // Check the chunk found and the one before it (end-instant case).
        for c in list[..i].iter().rev().take(2) {
            if c.covers(t) {
                let (r, v) = c.eval(t);
                return Ok((c.center, r, v));
            }
        }
        Err(EphemerisError::NoCoverage {
            body: target,
            tdb_seconds: t.tdb_seconds(),
        })
    }

    /// Chain from `body` up to the SSB: [body, parent, …, SSB].
    fn chain(&self, body: BodyId) -> Result<Vec<BodyId>, EphemerisError> {
        let mut out = vec![body];
        let mut b = body;
        while b != BodyId::SSB {
            b = *self.center.get(&b).ok_or(EphemerisError::UnknownBody(b))?;
            if out.contains(&b) {
                return Err(EphemerisError::Format(format!(
                    "cycle in body tree at {}",
                    b.0
                )));
            }
            out.push(b);
        }
        Ok(out)
    }

    /// Sum of stored states from `body` up to (not including) `ancestor`.
    fn sum_to(
        &self,
        chain: &[BodyId],
        ancestor: BodyId,
        t: Epoch,
    ) -> Result<(V3, V3), EphemerisError> {
        let (mut r, mut v) = (V3::ZERO, V3::ZERO);
        for &b in chain.iter().take_while(|&&b| b != ancestor) {
            let (_, rb, vb) = self.state_wrt_center(b, t)?;
            r += rb;
            v += vb;
        }
        Ok((r, v))
    }

    /// Barycentric state of a body (ICRF, m, m/s).
    pub fn state_ssb(&self, body: BodyId, t: Epoch) -> Result<StateIcrfSsb, EphemerisError> {
        let chain = self.chain(body)?;
        let (r, v) = self.sum_to(&chain, BodyId::SSB, t)?;
        Ok(State::new(r, v, IcrfSsb))
    }

    /// State of `target` relative to `center`, computed through their nearest common
    /// ancestor in the body tree. Moon relative to Earth, for example, never touches
    /// AU-scale numbers.
    pub fn state_relative(
        &self,
        target: BodyId,
        center: BodyId,
        t: Epoch,
    ) -> Result<StateIcrfBody, EphemerisError> {
        let ct = self.chain(target)?;
        let cc = self.chain(center)?;
        let ancestor = *ct
            .iter()
            .find(|b| cc.contains(b))
            .expect("both chains end at the SSB");
        let (rt, vt) = self.sum_to(&ct, ancestor, t)?;
        let (rc, vc) = self.sum_to(&cc, ancestor, t)?;
        Ok(State::new(rt - rc, vt - vc, IcrfBody { center }))
    }
}

/// Serialize chunks to the `.rseph` format.
pub fn encode(chunks: &[Chunk], meta: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&(chunks.len() as u32).to_le_bytes());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    for c in chunks {
        out.extend_from_slice(&c.target.0.to_le_bytes());
        out.extend_from_slice(&c.center.0.to_le_bytes());
        out.extend_from_slice(&c.start.to_le_bytes());
        out.extend_from_slice(&c.seg_len.to_le_bytes());
        out.extend_from_slice(&c.n_seg.to_le_bytes());
        out.extend_from_slice(&c.n_coef.to_le_bytes());
        out.extend_from_slice(&c.quantum.to_le_bytes());
        let mut packed = Vec::new();
        for &x in &c.coefs {
            let k = (x / c.quantum).round() as i64;
            debug_assert_eq!(k as f64 * c.quantum, x, "coefficient not quantized");
            // Zigzag, then LEB128.
            let mut z = ((k << 1) ^ (k >> 63)) as u64;
            loop {
                let byte = (z & 0x7f) as u8;
                z >>= 7;
                if z == 0 {
                    packed.push(byte);
                    break;
                }
                packed.push(byte | 0x80);
            }
        }
        out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
        out.extend_from_slice(&packed);
    }
    out
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], EphemerisError> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.b.len());
        let end = end.ok_or_else(|| EphemerisError::Format("truncated file".into()))?;
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, EphemerisError> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }
    fn i32(&mut self) -> Result<i32, EphemerisError> {
        Ok(i32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }
    fn i64(&mut self) -> Result<i64, EphemerisError> {
        Ok(i64::from_le_bytes(
            self.take(8)?.try_into().expect("8 bytes"),
        ))
    }
    fn f64(&mut self) -> Result<f64, EphemerisError> {
        Ok(f64::from_le_bytes(
            self.take(8)?.try_into().expect("8 bytes"),
        ))
    }
}

/// Decode `count` zigzag-LEB128 integers, scaled by `q`.
fn unpack(packed: &[u8], count: usize, q: f64) -> Result<Vec<f64>, EphemerisError> {
    let bad = || EphemerisError::Format("corrupt packed coefficients".into());
    let mut out = Vec::with_capacity(count);
    let mut it = packed.iter();
    for _ in 0..count {
        let (mut z, mut shift) = (0u64, 0u32);
        loop {
            let b = *it.next().ok_or_else(bad)?;
            if shift > 63 {
                return Err(bad());
            }
            z |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        let k = ((z >> 1) as i64) ^ -((z & 1) as i64);
        out.push(k as f64 * q);
    }
    if it.next().is_some() {
        return Err(bad());
    }
    Ok(out)
}

/// Parse a `.rseph` file into chunks and provenance text.
pub fn decode(bytes: &[u8]) -> Result<(Vec<Chunk>, String), EphemerisError> {
    let mut r = Reader { b: bytes, pos: 0 };
    if r.take(8)? != MAGIC {
        return Err(EphemerisError::Format(
            "bad magic or unsupported version".into(),
        ));
    }
    let n = r.u32()?;
    let meta_len = r.u32()? as usize;
    let meta = String::from_utf8(r.take(meta_len)?.to_vec())
        .map_err(|_| EphemerisError::Format("metadata is not UTF-8".into()))?;
    let mut chunks = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let target = BodyId(r.i32()?);
        let center = BodyId(r.i32()?);
        let start = r.i64()?;
        let seg_len = r.i64()?;
        let n_seg = r.u32()?;
        let n_coef = r.u32()?;
        let quantum = r.f64()?;
        let n_bytes = r.u32()? as usize;
        let count = (n_seg as usize)
            .checked_mul(3 * n_coef as usize)
            .ok_or_else(|| EphemerisError::Format("chunk too large".into()))?;
        let coefs = unpack(r.take(n_bytes)?, count, quantum)?;
        chunks.push(Chunk {
            target,
            center,
            start,
            seg_len,
            n_seg,
            n_coef,
            quantum,
            coefs,
        });
    }
    if r.pos != bytes.len() {
        return Err(EphemerisError::Format("trailing bytes".into()));
    }
    Ok((chunks, meta))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chebyshev::{fit_from_node_samples, nodes};
    use crate::math::fmath;

    /// Chunk of a circular orbit r(t) = R (cos ωt, sin ωt, 0), fitted like the builder does.
    fn circular(
        quantum: f64,
        target: i32,
        center: i32,
        radius: f64,
        omega: f64,
        start: i64,
        seg_len: i64,
        n_seg: u32,
    ) -> Chunk {
        let n_coef = 16;
        let mut coefs = Vec::new();
        for s in 0..n_seg {
            let a = (start + i64::from(s) * seg_len) as f64;
            let ts: Vec<f64> = nodes(n_coef)
                .iter()
                .map(|tau| a + (tau + 1.0) * 0.5 * seg_len as f64)
                .collect();
            for comp in 0..3 {
                let samples: Vec<f64> = ts
                    .iter()
                    .map(|&t| match comp {
                        0 => radius * fmath::cos(omega * t),
                        1 => radius * fmath::sin(omega * t),
                        _ => 0.0,
                    })
                    .collect();
                coefs.extend(
                    fit_from_node_samples(&samples)
                        .into_iter()
                        .map(|c| quantize(c, quantum)),
                );
            }
        }
        Chunk {
            target: BodyId(target),
            center: BodyId(center),
            start,
            seg_len,
            n_seg,
            n_coef: n_coef as u32,
            quantum,
            coefs,
        }
    }

    fn test_ephemeris() -> Ephemeris {
        let mut e = Ephemeris::new();
        // "Planet" 399 around the SSB, "moon" 301 around 399.
        e.insert(circular(
            1e-6,
            399,
            0,
            1.5e11,
            2e-7,
            -86_400 * 10,
            86_400,
            20,
        ))
        .unwrap();
        e.insert(circular(
            1e-9,
            301,
            399,
            3.8e8,
            2.6e-6,
            -86_400 * 10,
            21_600,
            80,
        ))
        .unwrap();
        e
    }

    #[test]
    fn evaluates_position_and_velocity() {
        let e = test_ephemeris();
        for k in 0..50 {
            let t = -800_000.0 + 31_337.5 * f64::from(k);
            let s = e
                .state_relative(BodyId(301), BodyId(399), Epoch::from_tdb_seconds(t))
                .unwrap();
            let w = 2.6e-6;
            let r = V3::new(3.8e8 * fmath::cos(w * t), 3.8e8 * fmath::sin(w * t), 0.0);
            let v = V3::new(
                -3.8e8 * w * fmath::sin(w * t),
                3.8e8 * w * fmath::cos(w * t),
                0.0,
            );
            assert!(s.r.max_abs_diff(r) < 1e-4, "{t}: {:?}", s.r - r);
            assert!(s.v.max_abs_diff(v) < 1e-9, "{t}");
        }
    }

    #[test]
    fn composes_chains_through_the_tree() {
        let e = test_ephemeris();
        let t = Epoch::from_tdb_seconds(12_345.0);
        let moon = e.state_ssb(BodyId(301), t).unwrap();
        let earth = e.state_ssb(BodyId(399), t).unwrap();
        let rel = e.state_relative(BodyId(301), BodyId(399), t).unwrap();
        assert!((moon.r - earth.r).max_abs_diff(rel.r) < 1e-4);
        // Earth relative to Moon is exactly the negation, with no SSB-scale rounding.
        let inv = e.state_relative(BodyId(399), BodyId(301), t).unwrap();
        assert_eq!(inv.r, -rel.r);
        assert_eq!(inv.frame.center, BodyId(301));
    }

    #[test]
    fn coverage_edges() {
        let e = test_ephemeris();
        let end = -86_400 * 10 + 86_400 * 20;
        assert!(
            e.state_wrt_center(BodyId(399), Epoch::from_tdb_parts(end, 0.0))
                .is_ok()
        );
        assert!(matches!(
            e.state_wrt_center(BodyId(399), Epoch::from_tdb_parts(end, 1e-6)),
            Err(EphemerisError::NoCoverage { .. })
        ));
        assert!(matches!(
            e.state_wrt_center(BodyId(399), Epoch::from_tdb_parts(-86_400 * 10 - 1, 0.5)),
            Err(EphemerisError::NoCoverage { .. })
        ));
        assert_eq!(e.coverage(BodyId(399)), vec![(-864_000, end)]);
    }

    #[test]
    fn segment_boundaries_are_continuous() {
        let e = test_ephemeris();
        // Approach a boundary from both sides; the fit makes the two segments agree to ~µm.
        let b = -86_400 * 10 + 21_600 * 7;
        let left = e
            .state_wrt_center(BodyId(301), Epoch::from_tdb_parts(b - 1, 1.0 - 1e-9))
            .unwrap();
        let right = e
            .state_wrt_center(BodyId(301), Epoch::from_tdb_parts(b, 1e-9))
            .unwrap();
        assert!(left.1.max_abs_diff(right.1) < 1e-4);
    }

    #[test]
    fn encode_decode_roundtrip_and_rejects_corruption() {
        let chunks = vec![circular(1e-6, 599, 5, 7.4e8, 1e-5, 0, 3600, 3)];
        let bytes = encode(&chunks, "test meta");
        let (back, meta) = decode(&bytes).unwrap();
        assert_eq!(back, chunks);
        assert_eq!(meta, "test meta");
        assert!(decode(&bytes[..bytes.len() - 1]).is_err());
        let mut bad = bytes.clone();
        bad[7] = 1;
        assert!(decode(&bad).is_err());
        let mut extra = bytes;
        extra.push(0);
        assert!(decode(&extra).is_err());
    }

    #[test]
    fn inconsistent_center_rejected() {
        let mut e = test_ephemeris();
        let c = circular(1e-9, 301, 0, 1.0, 1.0, 10_000_000, 100, 1);
        assert!(matches!(
            e.insert(c),
            Err(EphemerisError::InconsistentCenter { .. })
        ));
    }
}
