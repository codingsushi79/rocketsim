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
| nep098_part-1.bsp | …/spk/satellites/ | Neptune, Triton (2026 solution) | JPL SSD satellite ephemeris group |
| ura111xl-799.bsp | …/spk/satellites/ | Uranus relative to its barycenter | JPL SSD satellite ephemeris group |
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

### EGM2008 Earth gravity model: `data/gravity/EGM2008_to90.gfc` (degree ≤ 90 of the full model)
- **Source:** ICGEM, GFZ Potsdam, https://icgem.gfz.de/tom_longtime (EGM2008.gfc, streamed and truncated to degree 90)
- **Reference:** Pavlis, N. K., Holmes, S. A., Kenyon, S. C., Factor, J. K. (2012), "The development and evaluation of the Earth Gravitational Model 2008 (EGM2008)", *JGR* 117:B04406. Produced by the U.S. National Geospatial-Intelligence Agency (NGA).
- **License:** NGA product released for public use (U.S. Government work). ICGEM distributes it freely; cite Pavlis et al.
- **Retrieved:** 2026-10-11

### Planetary gravity coefficients (degree 2), in `crates/sim-core/src/constants.rs`
| Body | Model | Source | Reference |
|---|---|---|---|
| Moon | GL0660B | ICGEM (https://icgem.gfz.de/tom_celestial) | Konopliv et al. 2013, JGR Planets 118:1415 |
| Mars | MRO120F | PDS Geosciences, MRO-M-RSS-5-SDP-V1.0, `jgmro_120f_sha.tab` | Konopliv et al. 2020, Icarus 335:113386 |
| Jupiter | Juno (Durante 2020) | PDS Atmospheres model log; value as tabulated in Howard et al. 2023, A&A 672:A33 | Durante et al. 2020, GRL 47:e2019GL086572 |
| Saturn | Cassini Grand Finale | published value | Iess et al. 2019, Science 364:eaat2965 |
- **License:** NASA/JPL and mission data products, public. Values are cited facts.
- **Retrieved:** 2026-10-11

### NRLMSISE-00 atmosphere model: ported in `crates/sim-core/src/nrlmsise00.rs` (+ generated `nrlmsise00_data.rs`)
- **Source:** Naval Research Laboratory Fortran `nrlmsise00_sub.for`, `nrlmsise00_driver.for`, `nrlmsise00_output.txt`, from the NASA CCMC ModelWeb archive (https://git.smce.nasa.gov/ccmc-share/modelwebarchive, MSIS/NRLMSIS00)
- **Reference:** Picone, J. M., Hedin, A. E., Drob, D. P., Aikin, A. C. (2002), "NRLMSISE-00 empirical model of the atmosphere: Statistical comparisons and scientific issues", *JGR* 107(A12):1468.
- **License:** U.S. Government work (NRL), public domain in the U.S. The C translation by D. Brodowski was **not** used: it carries no license grant.
- **Retrieved:** 2026-10-11

### Earth day texture: Blue Marble Next Generation (November 2004, topography + bathymetry)
- **Source:** https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73884/world.topo.bathy.200411.3x5400x2700.jpg (NASA Earth Observatory / Visible Earth)
- **Reference:** R. Stöckli et al. (2005), "The Blue Marble Next Generation: A true color earth dataset including seasonal dynamics from MODIS", NASA Earth Observatory.
- **License:** NASA imagery, free to use. Credit "NASA Earth Observatory".
- **Derived files:** `web/public/assets/earth_day_2048.jpg` (committed), `earth_day_5400.jpg` (`scripts/fetch-assets.sh`)
- **Retrieved:** 2026-10-11

### Earth night lights: Black Marble 2016 (color, 3 km)
- **Source:** https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg (NASA Earth Observatory)
- **Reference:** NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA GSFC.
- **License:** NASA imagery, free to use with credit.
- **Derived files:** `earth_night_2048.jpg` (committed), `earth_night_8192.jpg` (fetch script)
- **Retrieved:** 2026-10-11

### Milky Way: NASA SVS Deep Star Maps 2020 (`milkyway_2020_4k.exr`, celestial coordinates)
- **Source:** https://svs.gsfc.nasa.gov/4851
- **Credit:** NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. Hipparcos, Tycho-2: ESA.
- **License:** NASA SVS media, free to use with credit.
- **Derived files:** `milkyway_2048.jpg` (committed), `milkyway_4096.jpg` (fetch script), `milkyway.json` (encoding scale and the verified RA convention u = 0.5 − RA/360)
- **Retrieved:** 2026-10-11

### Hipparcos star catalog (V < 8): `web/public/assets/stars_hip_v8.bin`
- **Source:** CDS VizieR, catalog I/239 (hip_main), query `-source=I/239/hip_main&-out=HIP,RAICRS,DEICRS,Vmag,B-V,pmRA,pmDE,Plx&Vmag=<8.0`
- **Reference:** ESA (1997), *The Hipparcos and Tycho Catalogues*, ESA SP-1200.
- **License:** Free for scientific and educational use with citation of ESA SP-1200 and CDS VizieR.
- **Converter:** `tools/assets/prepare_stars.py`
- **Retrieved:** 2026-10-11

### RS-1 Corvid spacecraft (definition and 3D model): `data/vehicles/rs1_corvid.json`, `web/public/models/rs1_corvid.glb`
- **Source:** original to this project. The model is generated procedurally from the JSON by
  `tools/models/build_vehicle_glb.mjs`; no external meshes or textures.
- **Design references (numbers only, cited in `docs/spacecraft_v1.md`):** Apollo CSM and Orion
  public data, Aerojet R-4D and MR-104 class thrusters, Honeywell HR16-class reaction wheels.
- **License:** same as the project.

### Cloud coverage: NASA Blue Marble: Clouds (`web/public/assets/earth_clouds_*.jpg`)
- **Source:** NASA Visible Earth record 57747, `cloud_combined_8192.tif` (MODIS composite),
  https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif
- **Credit:** NASA Goddard Space Flight Center Image by Reto Stöckli (clouds); enhancements by Robert Simmon.
- **License:** NASA imagery, free to use with credit to NASA.
- **Converter:** `tools/assets/prepare_earth_layers.py`
- **Retrieved:** 2026-10-12

### Water mask: Natural Earth 5.1.2 land and lakes (`web/public/assets/earth_water_*.png`)
- **Source:** https://github.com/nvkelso/natural-earth-vector (v5.1.2), `geojson/ne_10m_land.geojson`, `geojson/ne_10m_lakes.geojson`
- **License:** Public domain (Natural Earth). Credit appreciated: "Made with Natural Earth."
- **Converter:** `tools/assets/prepare_earth_layers.py` (rasterised at 4× and box-filtered)
- **Retrieved:** 2026-10-12

### Google Maps attribution logo (`web/public/assets/google/`)
- **Source:** Google Maps Platform attribution asset package,
  https://developers.google.com/static/maps/documentation/images/Google_Maps_Attribution_Assets.zip
  (`GoogleMaps_Logo_WithDarkOutline`, unmodified).
- **Use:** required attribution for Map Tiles API content. Used only as specified by the Map
  Tiles API policies (16–19 dp, clear space, not overlapped).
- **Retrieved:** 2026-10-12

### Google Photorealistic 3D Tiles (streamed at run time, never stored)
- **Source:** Google Maps Platform Map Tiles API, `https://tile.googleapis.com/v1/3dtiles/root.json`,
  with the player's own API key.
- **Terms:** Google Maps Platform Terms of Service and the Map Tiles API policies. Attribution
  (logo plus the aggregated per-tile copyright) is shown on screen whenever tiles are visible.
- **Renderer:** `3d-tiles-renderer` 0.5.3 (NASA-AMMOS), Apache-2.0.

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

### Ported code: DOP853 (`crates/sim-core/src/integrator.rs`)
- **Source:** E. Hairer, `dop853.f` (2004), http://www.unige.ch/~hairer/prog/nonstiff/dop853.f
- **Reference:** Hairer, Nørsett, Wanner, *Solving Ordinary Differential Equations I*, 2nd ed. (1993), §II.10
- **License:** BSD-2-Clause, Copyright (c) 2004, UNIGE. Full text: `third_party/HAIRER-LICENSE.txt`.
- **Retrieved:** 2026-10-11

### mpmath (test fixture generation only): `tests/fixtures/egm2008_accel_reference.csv`
- **Source:** https://mpmath.org (BSD-3-Clause). Used in `tools/fixtures/gen_sh_reference.py` for the independent 50-digit spherical-harmonic reference.

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
| [Playwright](https://playwright.dev) | 1.56.1 | Apache-2.0 | Rendering tests (dev only) |

## Algorithms (cited in code)
- Calendar conversions: H. Hinnant, "chrono-Compatible Low-Level Date Algorithms" (public domain).
- TDB−TT series: G. H. Kaplan, USNO Circular 179 (2005), eq. 2.6.
- Chebyshev ephemeris representation: X. X. Newhall (1989), Celest. Mech. 45:305; interpolation per Press et al., *Numerical Recipes* 3rd ed. §5.8.
- IAU rotation models: Archinal et al. (2018), Celest. Mech. Dyn. Astr. 130:22.
- Earth orientation: IERS Conventions (2010), IERS Technical Note 36, ch. 5; McCarthy & Luzum (2003), Celest. Mech. Dyn. Astr. 85:37 (IAU 2000B).
- ΔT before 1973: Espenak & Meeus (2006), NASA/TP-2006-214141.
- Geodetic conversion: Bowring (1976), Survey Review 23:181.
- Gravity harmonics recursion: Montenbruck & Gill, *Satellite Orbits* (2000), §3.2.4–3.2.5. Conical shadow: same, §3.4.2.
- Third-body f(q): R. H. Battin, *An Introduction to the Mathematics and Methods of Astrodynamics*, rev. ed. (1999), §8.4.
- Kepler/universal variables, elements, Hohmann, J2 rates: Vallado 4th ed. Alg. 8–10, §6.3, §9.6; Curtis 3rd ed. §3.7.
- US Standard Atmosphere 1976: NOAA-S/T 76-1562 (NASA-TM-X-74335).
- Mars atmosphere: NASA Glenn Research Center, "Mars Atmosphere Model". Venus: NASA GSFC Venus Fact Sheet. Titan: Fulchignoni et al. 2005, Nature 438:785 (Huygens HASI).
- Solar irradiance: IAU 2015 Resolution B3 (1361 W/m²); solar V magnitude −26.74.
- Atmospheric scattering: Nishita et al. (1993); O'Neil, GPU Gems 2 ch. 16; Earth parameters from E. Bruneton, IEEE TVCG 2017.
- Star colors: B−V → temperature, Ballesteros (2012), EPL 97:34008.
- Planet geometric albedos for point sources: NASA GSFC planetary fact sheets.
- Rotation matrices: D. A. Vallado, *Fundamentals of Astrodynamics and Applications*, 4th ed., §3.3.
