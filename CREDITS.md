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

### JPL planetary and satellite ephemerides (SPK): `data/kernels/*.bsp` (not committed; `scripts/fetch-kernels.sh`, pinned by `data/kernels/SHA256SUMS`)
Used offline by `tools/ephem-build` to produce the shipped `.rseph` Chebyshev files.

| File | Source | Content | Reference |
|---|---|---|---|
| de440.bsp | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/ | Sun, planet barycenters, Earth, Moon | Park et al. 2021, AJ 161:105 |
| mar099.bsp | …/spk/satellites/ | Mars, Phobos, Deimos | R. A. Jacobson (JPL) |
| jup365.bsp | …/spk/satellites/ | Jupiter, Galilean satellites | R. A. Jacobson (JPL) |
| sat441.bsp | …/spk/satellites/ | Saturn, major satellites | R. A. Jacobson (JPL) |
| nep097.bsp | …/spk/satellites/ | Neptune, Triton | R. A. Jacobson (JPL) |
| plu060.bsp | …/spk/satellites/ | Pluto relative to its barycenter | R. A. Jacobson / M. Brozović (JPL) |
| sb441-n16.bsp | https://ssd.jpl.nasa.gov/ftp/eph/small_bodies/asteroids_de441/ | Ceres, Vesta (DE441 perturbers) | Park et al. 2021 |
- **License:** U.S. Government work (NASA/JPL), public domain in the U.S. NAIF/SSD ask that it be credited.
- **Retrieved:** 2026-10-10
- **Attribution:** "Ephemerides: NASA/JPL Solar System Dynamics and NAIF."

### IERS Earth orientation parameters: `data/eop/finals2000A.all`
- **Source:** https://datacenter.iers.org/data/9/finals2000A.all (IERS Rapid Service/Prediction Center, USNO), Bulletin A with IAU 2000 nutation
- **Content:** daily polar motion and UT1−UTC from 1973-01-02 to about one year ahead (predictions)
- **License:** IERS products are freely available. Cite the IERS.
- **Retrieved:** 2026-10-10
- **Attribution:** "Earth orientation data: IERS Rapid Service/Prediction Center (USNO)."

### JPL Horizons state vectors: `crates/sim-core/tests/fixtures/horizons_vectors.csv`
- **Source:** https://ssd.jpl.nasa.gov/api/horizons.api (JPL Solar System Dynamics). Query script: `tools/fixtures/fetch_horizons.py`
- **License:** U.S. Government work (NASA/JPL)
- **Retrieved:** 2026-10-10 (per-body Horizons ephemeris sources recorded in the file header)

## Reference software (test fixtures only; not shipped)

### ERFA via pyerfa: `crates/sim-core/tests/fixtures/time_erfa.csv`
- **Source:** https://github.com/liberfa/erfa (ERFA 2.0.1), https://pypi.org/project/pyerfa/ (2.0.1.5)
- **License:** BSD-3-Clause. ERFA is derived from the IAU SOFA library; per the SOFA license it isn't called SOFA.
- **Used for:** UTC→TAI→TT→TDB reference values (`eraUtctai`, `eraTaitt`, `eraDtdb`, `eraTttdb`). Generator: `tools/fixtures/gen_time_erfa.py`.
- **Retrieved:** 2026-10-10

### SpiceyPy / CSPICE: `crates/sim-core/tests/fixtures/iau_rotation_spice.csv`
- **Source:** https://pypi.org/project/spiceypy/ (bundles NAIF CSPICE N0067, https://naif.jpl.nasa.gov/naif/toolkit.html)
- **License:** SpiceyPy MIT; CSPICE is NAIF's freely distributed toolkit
- **Used for:** IAU body orientation reference (`tisbod`). Generator: `tools/fixtures/gen_iau_rotation_spice.py`.
- **Retrieved:** 2026-10-10

### Ported code: ERFA 2.0.1 (Earth orientation coefficients in `crates/sim-core/src/earth.rs`)
- **Source:** https://github.com/liberfa/erfa: `eraPfw06`, `eraObl06`, `eraNut00b` (77-term table), `eraNut06a` adjustments, `eraGmst06`, `eraEra00`, `eraEe00`, `eraEect00`, `eraFa*03`, `eraPom00`, `eraSp00`
- **License:** BSD-3-Clause. Copyright (C) 2013-2021, NumFOCUS Foundation; derived, with permission, from the IAU SOFA library. Not endorsed by SOFA. Full license: `third_party/ERFA-LICENSE.txt`.
- **Retrieved:** 2026-10-10
- ERFA `eraC2t06a` (via pyerfa) also generates `tests/fixtures/earth_c2t_erfa.csv` (`tools/fixtures/gen_earth_erfa.py`).

## Libraries

| Library | Version | License | Use |
|---|---|---|---|
| [libm](https://crates.io/crates/libm) | 0.2.16 | MIT OR Apache-2.0 | Deterministic transcendental math in the core |
| [ANISE](https://crates.io/crates/anise) | 0.10.6 | MPL-2.0 | Build-time SPK reader in `tools/ephem-build` (not shipped) |
| [sha2](https://crates.io/crates/sha2) | 0.10 | MIT OR Apache-2.0 | Kernel checksums in build metadata (not shipped) |
| [wasm-bindgen](https://crates.io/crates/wasm-bindgen) | 0.2.129 | MIT OR Apache-2.0 | Rust↔JS bindings |
| [three.js](https://threejs.org) | 0.186.1 | MIT | Rendering |
| [Vite](https://vite.dev) | 8.3.4 | MIT | Web build/dev server |
| [TypeScript](https://www.typescriptlang.org) | 7.0.2 | Apache-2.0 | Web app language |

## Algorithms (cited in code)
- Calendar conversions: H. Hinnant, "chrono-Compatible Low-Level Date Algorithms" (public domain).
- TDB−TT series: G. H. Kaplan, USNO Circular 179 (2005), eq. 2.6.
- Chebyshev ephemeris representation: X. X. Newhall (1989), Celest. Mech. 45:305; interpolation per Press et al., *Numerical Recipes* 3rd ed. §5.8.
- IAU rotation models: Archinal et al. (2018), Celest. Mech. Dyn. Astr. 130:22.
- Earth orientation: IERS Conventions (2010), IERS Technical Note 36, ch. 5; McCarthy & Luzum (2003), Celest. Mech. Dyn. Astr. 85:37 (IAU 2000B).
- ΔT before 1973: Espenak & Meeus (2006), NASA/TP-2006-214141.
- Geodetic conversion: Bowring (1976), Survey Review 23:181.
- Rotation matrices: D. A. Vallado, *Fundamentals of Astrodynamics and Applications*, 4th ed., §3.3.
