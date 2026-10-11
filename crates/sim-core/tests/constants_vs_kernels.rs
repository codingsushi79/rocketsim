//! Every GM and radius in `constants.rs` must match the committed NAIF kernels
//! (data/pck/gm_de440.tpc, data/pck/pck00011.tpc) after km → m conversion.
//! This catches transcription errors in the hand-written SI literals.

use sim_core::constants::{Radii, gm, radii};
use std::collections::HashMap;

/// Minimal NAIF text-kernel reader: only `\begindata` sections, `NAME = ( v v v )`
/// assignments (possibly spanning several lines), D or E exponents. `+=` appends.
fn read_tpc(text: &str) -> HashMap<String, Vec<f64>> {
    let mut out: HashMap<String, Vec<f64>> = HashMap::new();
    let mut in_data = false;
    let mut data = String::new();
    for line in text.lines() {
        let t = line.trim();
        if t == "\\begindata" {
            in_data = true;
            continue;
        }
        if t == "\\begintext" {
            in_data = false;
            continue;
        }
        if in_data {
            data.push_str(t);
            data.push(' ');
        }
    }
    let mut rest = data.as_str();
    while let Some(eq) = rest.find('=') {
        let lhs = rest[..eq].trim();
        let (name, append) = match lhs.strip_suffix('+') {
            Some(n) => (n.trim(), true),
            None => (lhs, false),
        };
        let name = name.split_whitespace().last().unwrap_or("").to_string();
        let after = rest[eq + 1..].trim_start();
        let (values, tail) = if let Some(body) = after.strip_prefix('(') {
            let close = body.find(')').expect("unclosed (");
            (&body[..close], &body[close + 1..])
        } else {
            let end = after.find(char::is_whitespace).unwrap_or(after.len());
            (&after[..end], &after[end..])
        };
        let nums: Vec<f64> = values
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty() && !s.starts_with('\''))
            .filter_map(|s| s.replace(['D', 'd'], "E").parse().ok())
            .collect();
        let e = out.entry(name).or_default();
        if !append {
            e.clear();
        }
        e.extend(nums);
        rest = tail;
    }
    out
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 4.0 * f64::EPSILON * a.abs().max(b.abs())
}

#[test]
fn gm_values_match_gm_de440() {
    let k = read_tpc(include_str!("../../../data/pck/gm_de440.tpc"));
    let table: &[(&str, f64)] = &[
        ("BODY10_GM", gm::SUN),
        ("BODY199_GM", gm::MERCURY),
        ("BODY299_GM", gm::VENUS),
        ("BODY399_GM", gm::EARTH),
        ("BODY301_GM", gm::MOON),
        ("BODY3_GM", gm::EARTH_MOON_SYSTEM),
        ("BODY499_GM", gm::MARS),
        ("BODY4_GM", gm::MARS_SYSTEM),
        ("BODY401_GM", gm::PHOBOS),
        ("BODY402_GM", gm::DEIMOS),
        ("BODY599_GM", gm::JUPITER),
        ("BODY5_GM", gm::JUPITER_SYSTEM),
        ("BODY501_GM", gm::IO),
        ("BODY502_GM", gm::EUROPA),
        ("BODY503_GM", gm::GANYMEDE),
        ("BODY504_GM", gm::CALLISTO),
        ("BODY699_GM", gm::SATURN),
        ("BODY6_GM", gm::SATURN_SYSTEM),
        ("BODY601_GM", gm::MIMAS),
        ("BODY602_GM", gm::ENCELADUS),
        ("BODY603_GM", gm::TETHYS),
        ("BODY604_GM", gm::DIONE),
        ("BODY605_GM", gm::RHEA),
        ("BODY606_GM", gm::TITAN),
        ("BODY608_GM", gm::IAPETUS),
        ("BODY799_GM", gm::URANUS),
        ("BODY7_GM", gm::URANUS_SYSTEM),
        ("BODY899_GM", gm::NEPTUNE),
        ("BODY8_GM", gm::NEPTUNE_SYSTEM),
        ("BODY801_GM", gm::TRITON),
        ("BODY999_GM", gm::PLUTO),
        ("BODY9_GM", gm::PLUTO_SYSTEM),
        ("BODY2000001_GM", gm::CERES),
        ("BODY2000004_GM", gm::VESTA),
    ];
    for (key, value) in table {
        let v = k.get(*key).unwrap_or_else(|| panic!("{key} not in kernel"));
        assert_eq!(v.len(), 1, "{key}");
        let si = v[0] * 1e9; // km³/s² → m³/s²
        assert!(
            close(si, *value),
            "{key}: kernel {si:e} vs constants {value:e}"
        );
    }
}

#[test]
fn radii_match_pck00011() {
    let k = read_tpc(include_str!("../../../data/pck/pck00011.tpc"));
    let table: &[(&str, Radii)] = &[
        ("BODY10_RADII", radii::SUN),
        ("BODY199_RADII", radii::MERCURY),
        ("BODY299_RADII", radii::VENUS),
        ("BODY399_RADII", radii::EARTH),
        ("BODY301_RADII", radii::MOON),
        ("BODY499_RADII", radii::MARS),
        ("BODY401_RADII", radii::PHOBOS),
        ("BODY402_RADII", radii::DEIMOS),
        ("BODY599_RADII", radii::JUPITER),
        ("BODY501_RADII", radii::IO),
        ("BODY502_RADII", radii::EUROPA),
        ("BODY503_RADII", radii::GANYMEDE),
        ("BODY504_RADII", radii::CALLISTO),
        ("BODY699_RADII", radii::SATURN),
        ("BODY601_RADII", radii::MIMAS),
        ("BODY602_RADII", radii::ENCELADUS),
        ("BODY603_RADII", radii::TETHYS),
        ("BODY604_RADII", radii::DIONE),
        ("BODY605_RADII", radii::RHEA),
        ("BODY606_RADII", radii::TITAN),
        ("BODY608_RADII", radii::IAPETUS),
        ("BODY799_RADII", radii::URANUS),
        ("BODY899_RADII", radii::NEPTUNE),
        ("BODY801_RADII", radii::TRITON),
        ("BODY999_RADII", radii::PLUTO),
        ("BODY2000001_RADII", radii::CERES),
        ("BODY2000004_RADII", radii::VESTA),
    ];
    for (key, r) in table {
        let v = k.get(*key).unwrap_or_else(|| panic!("{key} not in kernel"));
        assert_eq!(v.len(), 3, "{key}");
        for (kv, cv) in v.iter().zip([r.a, r.b, r.c]) {
            assert!(
                close(kv * 1e3, cv),
                "{key}: kernel {} m vs constants {cv} m",
                kv * 1e3
            );
        }
    }
}
