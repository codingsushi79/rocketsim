//! The shipped terrain grids (`web/public/terrain/*.rsdem`, from
//! `tools/assets/prepare_dems.py`) against published topographic extremes. The grids are
//! 8 px/deg averages, so narrow summits and pits read lower/higher than the point values:
//! tolerances allow for that smoothing.

use flate2::read::GzDecoder;
use sim_core::terrain::HeightGrid;
use std::io::Read;

fn grid(name: &str) -> HeightGrid {
    let path = format!("{}/../../web/public/terrain/{name}.rsdem", env!("CARGO_MANIFEST_DIR"));
    let mut b = Vec::new();
    GzDecoder::new(std::fs::File::open(&path).unwrap()).read_to_end(&mut b).unwrap();
    HeightGrid::from_bytes(&b).unwrap()
}

/// (min, max) height over a lat/lon box in degrees, sampled at 0.05°.
fn extremes(g: &HeightGrid, lat: (f64, f64), lon: (f64, f64)) -> (f64, f64) {
    let d = core::f64::consts::PI / 180.0;
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let n = |a: f64, b: f64| ((b - a) / 0.05).round() as usize;
    for i in 0..=n(lat.0, lat.1) {
        for j in 0..=n(lon.0, lon.1) {
            let h = g.height((lat.0 + i as f64 * 0.05) * d, (lon.0 + j as f64 * 0.05) * d);
            lo = lo.min(h);
            hi = hi.max(h);
        }
    }
    (lo, hi)
}

#[test]
fn mars_olympus_mons_and_hellas() {
    let g = grid("mars");
    // Olympus Mons summit 18.65°N, 226.2°E: 21.3 km above the areoid (Plescia 2004, JGR
    // 109:E03003; MOLA). The summit plateau is broad, so the average stays close.
    let (_, top) = extremes(&g, (17.5, 19.5), (-135.0, -132.5));
    eprintln!("Olympus Mons {top:.0} m");
    assert!((19_500.0..=21_500.0).contains(&top), "Olympus Mons {top} m");
    // Hellas floor: lowest point on Mars, about −8.2 km (Smith et al. 2001, JGR
    // 106:23689, MOLA).
    let (floor, _) = extremes(&g, (-50.0, -35.0), (55.0, 80.0));
    eprintln!("Hellas {floor:.0} m");
    assert!((-8_300.0..=-7_000.0).contains(&floor), "Hellas {floor} m");
}

#[test]
fn moon_extremes() {
    let g = grid("moon");
    // LOLA: highest point +10.786 km (near 5.4°N, 201.4°E) and lowest −9.117 km (Antoniadi
    // crater in the South Pole–Aitken basin, ~70°S, 172°W), relative to the 1,737.4 km
    // sphere (Smith et al. 2010, GRL 37:L18204).
    let (_, top) = extremes(&g, (3.0, 8.0), (-161.0, -156.0));
    eprintln!("lunar high {top:.0} m");
    assert!((9_500.0..=10_800.0).contains(&top), "lunar high point {top} m");
    let (floor, _) = extremes(&g, (-72.0, -68.0), (-176.0, -168.0));
    eprintln!("Antoniadi {floor:.0} m");
    assert!((-9_200.0..=-7_500.0).contains(&floor), "Antoniadi {floor} m");
}

#[test]
fn earth_sea_level_and_tibet() {
    let g = grid("earth");
    // Open ocean is clamped to the sea surface; the Tibetan plateau averages ~4.5 km.
    let (lo, hi) = extremes(&g, (-10.0, 10.0), (-160.0, -140.0));
    assert!(lo == 0.0 && hi < 1_000.0, "central Pacific {lo}..{hi} m");
    let (_, tibet) = extremes(&g, (30.0, 35.0), (85.0, 90.0));
    eprintln!("Tibet {tibet:.0} m");
    assert!((4_000.0..=7_000.0).contains(&tibet), "Tibet {tibet} m");
}
