//! Global height grids for ground contact (and the renderer's terrain).
//!
//! Format (`tools/assets/prepare_dems.py`, gzip-decompressed by the caller):
//! `b"RSDEM1" | u32 w | u32 h | f32 metres_per_unit | i16[h][w]` little-endian,
//! equirectangular, row 0 at +90°, column 0 at −180°, pixel-centred. Heights are relative
//! to each body's reference surface:
//! - Moon: the 1,737.4 km sphere (LOLA).
//! - Mars: the MOLA areoid, approximated here by the IAU reference ellipsoid. The
//!   difference is ≲ 1 km away from the Tharsis bulge; documented.
//! - Earth: mean sea level, approximated by the WGS84 ellipsoid (geoid undulation ±100 m),
//!   oceans clamped to the sea surface.
//!
//! The surface height is the reference surface plus the bilinear grid height at the
//! body-fixed latitude and longitude. Deterministic: plain f64 arithmetic plus fmath.

use crate::bodies::BodyId;
use crate::math::{V3, fmath};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct HeightGrid {
    pub width: usize,
    pub height: usize,
    pub scale: f64,
    data: Vec<i16>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TerrainError(pub String);

impl core::fmt::Display for TerrainError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "terrain: {}", self.0)
    }
}

impl std::error::Error for TerrainError {}

impl HeightGrid {
    /// Parse a decompressed `.rsdem` buffer.
    pub fn from_bytes(b: &[u8]) -> Result<HeightGrid, TerrainError> {
        if b.len() < 18 || &b[..6] != b"RSDEM1" {
            return Err(TerrainError("bad magic".into()));
        }
        let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
        let (w, h) = (u32le(6), u32le(10));
        let scale = f64::from(f32::from_le_bytes([b[14], b[15], b[16], b[17]]));
        if w == 0 || h == 0 || b.len() != 18 + 2 * w * h || !(scale.is_finite() && scale > 0.0) {
            return Err(TerrainError("bad size or scale".into()));
        }
        let data = b[18..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        Ok(HeightGrid {
            width: w,
            height: h,
            scale,
            data,
        })
    }

    fn at(&self, i: usize, j: usize) -> f64 {
        f64::from(self.data[i * self.width + j]) * self.scale
    }

    /// Height (m) at latitude/longitude (rad), bilinear between pixel centres; longitude
    /// wraps, latitude clamps at the poles.
    pub fn height(&self, lat: f64, lon: f64) -> f64 {
        let (w, h) = (self.width as f64, self.height as f64);
        let deg = 180.0 / core::f64::consts::PI;
        let y = ((90.0 - lat * deg) / 180.0 * h - 0.5).clamp(0.0, h - 1.0);
        let mut x = (lon * deg + 180.0) / 360.0 * w - 0.5;
        x -= (x / w).floor() * w;
        let (i0, fy) = (y.floor() as usize, y - y.floor());
        let i1 = (i0 + 1).min(self.height - 1);
        let (j0, fx) = (x.floor() as usize % self.width, x - x.floor());
        let j1 = (j0 + 1) % self.width;
        let top = self.at(i0, j0) * (1.0 - fx) + self.at(i0, j1) * fx;
        let bot = self.at(i1, j0) * (1.0 - fx) + self.at(i1, j1) * fx;
        top * (1.0 - fy) + bot * fy
    }
}

/// Height grids by body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Terrain {
    grids: BTreeMap<i32, HeightGrid>,
}

impl Terrain {
    pub fn insert(&mut self, body: BodyId, g: HeightGrid) {
        self.grids.insert(body.0, g);
    }

    pub fn get(&self, body: BodyId) -> Option<&HeightGrid> {
        self.grids.get(&body.0)
    }

    /// Terrain height (m above the reference surface) under the body-fixed point `p`.
    /// Latitude is planetocentric (geodetic for Earth is handled by the caller).
    pub fn height_at(&self, body: BodyId, p: V3) -> f64 {
        let Some(g) = self.get(body) else {
            return 0.0;
        };
        let lat = fmath::atan2(p.z, fmath::hypot(p.x, p.y));
        let lon = fmath::atan2(p.y, p.x);
        g.height(lat, lon)
    }

    pub fn grid_height(&self, body: BodyId, lat: f64, lon: f64) -> f64 {
        self.get(body).map_or(0.0, |g| g.height(lat, lon))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(w: usize, h: usize, f: impl Fn(usize, usize) -> i16) -> HeightGrid {
        let mut b = b"RSDEM1".to_vec();
        b.extend((w as u32).to_le_bytes());
        b.extend((h as u32).to_le_bytes());
        b.extend(2.0f32.to_le_bytes());
        for i in 0..h {
            for j in 0..w {
                b.extend(f(i, j).to_le_bytes());
            }
        }
        HeightGrid::from_bytes(&b).unwrap()
    }

    #[test]
    fn pixel_centres_reproduce_the_grid_and_longitude_wraps() {
        let g = grid(8, 4, |i, j| (i * 10 + j) as i16);
        let deg = core::f64::consts::PI / 180.0;
        // Pixel (1, 2): lat = 90 − 1.5·45 = 22.5°, lon = −180 + 2.5·45 = −67.5°.
        assert!((g.height(22.5 * deg, -67.5 * deg) - 2.0 * 12.0).abs() < 1e-9);
        // Between the last and first columns across ±180°: average of columns 7 and 0.
        let h = g.height(22.5 * deg, 180.0 * deg);
        assert!((h - 2.0 * (17.0 + 10.0) / 2.0).abs() < 1e-9, "{h}");
    }

    #[test]
    fn rejects_truncated_files() {
        assert!(HeightGrid::from_bytes(b"RSDEM1\x02\0\0\0").is_err());
    }
}
