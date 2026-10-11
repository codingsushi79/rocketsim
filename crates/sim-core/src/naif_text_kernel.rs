//! Minimal reader for NAIF text kernels (PCK `.tpc`, LSK, FK).
//!
//! Supports what the committed kernels use: `\begindata` / `\begintext` sections,
//! `NAME = value`, `NAME = ( v v ... )` spanning lines, `NAME += (...)`, numbers with
//! D or E exponents, and quoted strings (skipped). Used at build time to generate the
//! IAU rotation tables, and by tests to check `constants.rs` against the kernels.
//! It is not used in the runtime physics path.

use std::collections::BTreeMap;

/// Parse the data sections into `NAME -> numeric values` (keys upper-cased).
pub fn parse(text: &str) -> BTreeMap<String, Vec<f64>> {
    let mut data = String::new();
    let mut in_data = false;
    for line in text.lines() {
        let t = line.trim();
        if t == "\\begindata" {
            in_data = true;
        } else if t == "\\begintext" {
            in_data = false;
        } else if in_data {
            data.push_str(t);
            data.push(' ');
        }
    }
    let mut out: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut rest = data.as_str();
    while let Some(eq) = rest.find('=') {
        let lhs = rest[..eq].trim();
        let (lhs, append) = match lhs.strip_suffix('+') {
            Some(n) => (n.trim_end(), true),
            None => (lhs, false),
        };
        let name = lhs
            .split_whitespace()
            .last()
            .unwrap_or("")
            .to_ascii_uppercase();
        let after = rest[eq + 1..].trim_start();
        let (values, tail) = if let Some(body) = after.strip_prefix('(') {
            let close = body.find(')').unwrap_or(body.len());
            (&body[..close], body.get(close + 1..).unwrap_or(""))
        } else {
            let end = after.find(char::is_whitespace).unwrap_or(after.len());
            (&after[..end], &after[end..])
        };
        let nums = values
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty() && !s.starts_with('\''))
            .filter_map(|s| s.replace(['D', 'd'], "E").parse::<f64>().ok());
        let e = out.entry(name).or_default();
        if !append {
            e.clear();
        }
        e.extend(nums);
        rest = tail;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assignments_and_ignores_text_sections() {
        let k = parse(
            "BODY1_X = ( 9 )\n\\begindata\nBODY399_RADII = ( 6378.1366 6378.1366\n 6356.7519 )\n\
             BODY10_GM = 1.3D+11\nbody5_a += ( 1 )\nBODY5_A += ( 2 3 )\n\\begintext\nBODY2_Y = ( 1 )\n",
        );
        assert_eq!(k["BODY399_RADII"], vec![6378.1366, 6378.1366, 6356.7519]);
        assert_eq!(k["BODY10_GM"], vec![1.3e11]);
        assert_eq!(k["BODY5_A"], vec![1.0, 2.0, 3.0]);
        assert!(!k.contains_key("BODY1_X") && !k.contains_key("BODY2_Y"));
    }
}
