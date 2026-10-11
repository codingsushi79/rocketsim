# Credits and data sources

Every external dataset, texture, model and library used at build time or runtime is listed here.

## Datasets

### IERS leap-second table: `data/time/Leap_Second.dat`
- **Source:** https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat (IERS Earth Orientation Center, Paris Observatory)
- **Content:** TAI−UTC since 1972, updated through IERS Bulletin C 72 (July 2026). The file expires 2027-06-28.
- **License:** IERS products are freely available for scientific and other use. Cite the IERS as the source.
- **Retrieved:** 2026-10-10
- **Attribution:** "Leap second data: IERS Earth Orientation Center (Bulletin C)."

### JPL DE440 gravitational parameters: `data/pck/gm_de440.tpc`
- **Source:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc (NASA/JPL NAIF)
- **Reference:** Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021), "The JPL Planetary and Lunar Ephemerides DE440 and DE441", *AJ* 161:105.
- **License:** U.S. Government work (NASA/JPL). Public domain in the U.S.; NAIF asks that it be credited.
- **Retrieved:** 2026-10-10

### IAU WGCCRE 2015 rotation and shape constants: `data/pck/pck00011.tpc`
- **Source:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc (NASA/JPL NAIF)
- **Reference:** Archinal, B. A., et al. (2018), "Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015", *Celest. Mech. Dyn. Astr.* 130:22.
- **License:** U.S. Government work (NASA/JPL), public domain in the U.S.
- **Retrieved:** 2026-10-10

## Reference software (test fixtures only; not shipped)

### ERFA via pyerfa: `crates/sim-core/tests/fixtures/time_erfa.csv`
- **Source:** https://github.com/liberfa/erfa (ERFA 2.0.1), https://pypi.org/project/pyerfa/ (2.0.1.5)
- **License:** BSD-3-Clause. ERFA is derived from the IAU SOFA library; per the SOFA license it isn't called SOFA.
- **Used for:** UTC→TAI→TT→TDB reference values (`eraUtctai`, `eraTaitt`, `eraDtdb`, `eraTttdb`). Generator: `tools/fixtures/gen_time_erfa.py`.
- **Retrieved:** 2026-10-10

## Libraries

| Library | Version | License | Use |
|---|---|---|---|
| [libm](https://crates.io/crates/libm) | 0.2.16 | MIT OR Apache-2.0 | Deterministic transcendental math in the core |
| [wasm-bindgen](https://crates.io/crates/wasm-bindgen) | 0.2.129 | MIT OR Apache-2.0 | Rust↔JS bindings |
| [three.js](https://threejs.org) | 0.186.1 | MIT | Rendering |
| [Vite](https://vite.dev) | 8.3.4 | MIT | Web build/dev server |
| [TypeScript](https://www.typescriptlang.org) | 7.0.2 | Apache-2.0 | Web app language |

## Algorithms (cited in code)
- Calendar conversions: H. Hinnant, "chrono-Compatible Low-Level Date Algorithms" (public domain).
- TDB−TT series: G. H. Kaplan, USNO Circular 179 (2005), eq. 2.6.
- Rotation matrices: D. A. Vallado, *Fundamentals of Astrodynamics and Applications*, 4th ed., §3.3.
