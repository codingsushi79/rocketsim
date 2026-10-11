//! Physical constants: the single cited source for every number the physics uses.
//!
//! Rules (see CLAUDE.md):
//! - SI units only: m, s, kg, rad. Source values in km are converted to SI here,
//!   and the literal is written in SI with the original value in the comment.
//! - Every value has a source. Values copied from the NAIF text kernels in
//!   `data/pck/` are checked against those files by `tests/constants_vs_kernels.rs`.
//!
//! Sources:
//! - [DE440] R. S. Park, W. M. Folkner, J. G. Williams, D. H. Boggs, "The JPL
//!   Planetary and Lunar Ephemerides DE440 and DE441", AJ 161:105 (2021).
//!   Machine-readable values: NAIF `gm_de440.tpc` (data/pck/gm_de440.tpc).
//! - [WGCCRE2015] B. A. Archinal et al., "Report of the IAU Working Group on
//!   Cartographic Coordinates and Rotational Elements: 2015", Celest. Mech. Dyn.
//!   Astr. 130:22 (2018). Machine-readable values: NAIF `pck00011.tpc`
//!   (data/pck/pck00011.tpc).
//! - [IAU2012B2] IAU 2012 Resolution B2 (definition of the astronomical unit).
//! - [CGPM1901] 3rd CGPM (1901), standard acceleration of gravity.
//! - [IAU1991A4] IAU 1991 Resolution A4 (TT − TAI = 32.184 s).
//! - [WGS84] NGA.STND.0036 (formerly NIMA TR8350.2), *World Geodetic System 1984*.
//! - [SI2019] BIPM, *The International System of Units*, 9th ed. (2019).

// Literals keep every digit printed in the source kernel (some have 17
// significant digits) so they can be traced to the source exactly.
#![allow(clippy::excessive_precision)]

/// Speed of light in vacuum, m/s. Exact by definition [SI2019].
pub const SPEED_OF_LIGHT: f64 = 299_792_458.0;

/// Astronomical unit, m. Exact by definition [IAU2012B2].
pub const ASTRONOMICAL_UNIT: f64 = 149_597_870_700.0;

/// Standard gravity, m/s². Used for Isp ↔ exhaust velocity [CGPM1901].
pub const G0: f64 = 9.806_65;

/// Seconds per day (SI days, as used by TT/TDB/TAI). Exact.
pub const SECONDS_PER_DAY: f64 = 86_400.0;

/// Days per Julian century. Exact by definition.
pub const DAYS_PER_JULIAN_CENTURY: f64 = 36_525.0;

/// Julian Date of the J2000.0 epoch, 2000-01-01T12:00:00 in the given time scale.
/// The epoch is defined in TT; the sim's TDB clock counts from
/// 2000-01-01T12:00:00 TDB, the same convention as SPICE ET.
pub const J2000_JD: f64 = 2_451_545.0;

/// Modified Julian Date offset: MJD = JD − 2400000.5. Exact.
pub const MJD_OFFSET: f64 = 2_400_000.5;

/// TT − TAI, s. Exact by definition [IAU1991A4].
pub const TT_MINUS_TAI: f64 = 32.184;

/// WGS84 reference ellipsoid [NGA.STND.0036 / TR8350.2, §3]. Earth surface positions
/// (ground sites, Google 3D Tiles alignment) use this ellipsoid, not the IAU one.
pub mod earth_wgs84 {
    /// Semi-major axis, m (defining parameter).
    pub const A: f64 = 6_378_137.0;
    /// Flattening (defining parameter, 1/f = 298.257223563).
    pub const F: f64 = 1.0 / 298.257_223_563;
}

/// Gravitational parameters GM, m³/s² [DE440 / gm_de440.tpc].
///
/// `*_SYSTEM` values are planet + satellites, the masses DE440 integrates at the
/// system barycenters. Use them when a system is treated as one point mass at its
/// barycenter. Use the planet-only value when the satellites are modeled
/// separately.
pub mod gm {
    /// BODY10_GM = 1.3271244004127942e11 km³/s²
    pub const SUN: f64 = 1.327_124_400_412_794_2e20;
    /// BODY199_GM = 2.2031868551400003e4 km³/s² (= BODY1_GM: no moons)
    pub const MERCURY: f64 = 2.203_186_855_140_000_3e13;
    /// BODY299_GM = 3.24858592e5 km³/s² (= BODY2_GM: no moons)
    pub const VENUS: f64 = 3.248_585_92e14;
    /// BODY399_GM = 3.9860043550702266e5 km³/s²
    pub const EARTH: f64 = 3.986_004_355_070_226_6e14;
    /// BODY301_GM = 4.9028001184575496e3 km³/s²
    pub const MOON: f64 = 4.902_800_118_457_549_6e12;
    /// BODY3_GM = 4.0350323562548019e5 km³/s² (Earth–Moon barycenter)
    pub const EARTH_MOON_SYSTEM: f64 = 4.035_032_356_254_801_9e14;
    /// BODY499_GM = 4.282837362069909e4 km³/s²
    pub const MARS: f64 = 4.282_837_362_069_909e13;
    /// BODY4_GM = 4.2828375815756102e4 km³/s²
    pub const MARS_SYSTEM: f64 = 4.282_837_581_575_610_2e13;
    /// BODY401_GM = 7.087546066894452e-4 km³/s²
    pub const PHOBOS: f64 = 7.087_546_066_894_452e5;
    /// BODY402_GM = 9.615569648120313e-5 km³/s²
    pub const DEIMOS: f64 = 9.615_569_648_120_313e4;
    /// BODY599_GM = 1.266865319003704e8 km³/s²
    pub const JUPITER: f64 = 1.266_865_319_003_704e17;
    /// BODY5_GM = 1.2671276409999998e8 km³/s²
    pub const JUPITER_SYSTEM: f64 = 1.267_127_640_999_999_8e17;
    /// BODY501_GM = 5.959915466180539e3 km³/s²
    pub const IO: f64 = 5.959_915_466_180_539e12;
    /// BODY502_GM = 3.202712099607295e3 km³/s²
    pub const EUROPA: f64 = 3.202_712_099_607_295e12;
    /// BODY503_GM = 9.887832752719638e3 km³/s²
    pub const GANYMEDE: f64 = 9.887_832_752_719_638e12;
    /// BODY504_GM = 7.179283402579837e3 km³/s²
    pub const CALLISTO: f64 = 7.179_283_402_579_837e12;
    /// BODY699_GM = 3.793120623436167e7 km³/s²
    pub const SATURN: f64 = 3.793_120_623_436_167e16;
    /// BODY6_GM = 3.7940584841799997e7 km³/s²
    pub const SATURN_SYSTEM: f64 = 3.794_058_484_179_999_7e16;
    /// BODY601_GM = 2.503488768152587 km³/s²
    pub const MIMAS: f64 = 2.503_488_768_152_587e9;
    /// BODY602_GM = 7.210366688598896 km³/s²
    pub const ENCELADUS: f64 = 7.210_366_688_598_896e9;
    /// BODY603_GM = 4.121352885489587e1 km³/s²
    pub const TETHYS: f64 = 4.121_352_885_489_587e10;
    /// BODY604_GM = 7.311607172482067e1 km³/s²
    pub const DIONE: f64 = 7.311_607_172_482_067e10;
    /// BODY605_GM = 1.539417519146563e2 km³/s²
    pub const RHEA: f64 = 1.539_417_519_146_563e11;
    /// BODY606_GM = 8.978137095521046e3 km³/s²
    pub const TITAN: f64 = 8.978_137_095_521_046e12;
    /// BODY608_GM = 1.205151060137642e2 km³/s²
    pub const IAPETUS: f64 = 1.205_151_060_137_642e11;
    /// BODY799_GM = 5.793951256527211e6 km³/s²
    pub const URANUS: f64 = 5.793_951_256_527_211e15;
    /// BODY7_GM = 5.7945563999999985e6 km³/s²
    pub const URANUS_SYSTEM: f64 = 5.794_556_399_999_998_5e15;
    /// BODY899_GM = 6.835103145462294e6 km³/s²
    pub const NEPTUNE: f64 = 6.835_103_145_462_294e15;
    /// BODY8_GM = 6.8365271005803989e6 km³/s²
    pub const NEPTUNE_SYSTEM: f64 = 6.836_527_100_580_398_9e15;
    /// BODY801_GM = 1.428495462910464e3 km³/s²
    pub const TRITON: f64 = 1.428_495_462_910_464e12;
    /// BODY999_GM = 8.696138177608748e2 km³/s²
    pub const PLUTO: f64 = 8.696_138_177_608_748e11;
    /// BODY9_GM = 9.755e2 km³/s²
    pub const PLUTO_SYSTEM: f64 = 9.755e11;
    /// BODY2000001_GM = 6.2628888644409933e1 km³/s²
    pub const CERES: f64 = 6.262_888_864_440_993_3e10;
    /// BODY2000004_GM = 1.7288232879171513e1 km³/s²
    pub const VESTA: f64 = 1.728_823_287_917_151_3e10;
}

/// Triaxial ellipsoid radii (a, b, c), m. a and b are equatorial; c is polar.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Radii {
    pub a: f64,
    pub b: f64,
    pub c: f64,
}

impl Radii {
    pub const fn new(a: f64, b: f64, c: f64) -> Radii {
        Radii { a, b, c }
    }
    pub const fn sphere(r: f64) -> Radii {
        Radii { a: r, b: r, c: r }
    }
    /// Mean equatorial radius (a + b) / 2. This is the reference radius for
    /// altitude readouts until the terrain models arrive.
    pub fn equatorial_mean(&self) -> f64 {
        0.5 * (self.a + self.b)
    }
}

/// IAU reference ellipsoids, m [WGCCRE2015 / pck00011.tpc, BODYnnn_RADII].
///
/// Earth's Google-tile alignment uses WGS84 (added with the EOP work in M2); this
/// is the IAU ellipsoid.
pub mod radii {
    use super::Radii;
    /// BODY10_RADII = 695700 km (nominal solar radius, IAU 2015 Res. B3)
    pub const SUN: Radii = Radii::sphere(695_700_000.0);
    /// BODY199_RADII = 2440.53, 2440.53, 2438.26 km
    pub const MERCURY: Radii = Radii::new(2_440_530.0, 2_440_530.0, 2_438_260.0);
    /// BODY299_RADII = 6051.8 km
    pub const VENUS: Radii = Radii::sphere(6_051_800.0);
    /// BODY399_RADII = 6378.1366, 6378.1366, 6356.7519 km
    pub const EARTH: Radii = Radii::new(6_378_136.6, 6_378_136.6, 6_356_751.9);
    /// BODY301_RADII = 1737.4 km
    pub const MOON: Radii = Radii::sphere(1_737_400.0);
    /// BODY499_RADII = 3396.19, 3396.19, 3376.20 km
    pub const MARS: Radii = Radii::new(3_396_190.0, 3_396_190.0, 3_376_200.0);
    /// BODY401_RADII = 13.0, 11.4, 9.1 km
    pub const PHOBOS: Radii = Radii::new(13_000.0, 11_400.0, 9_100.0);
    /// BODY402_RADII = 7.8, 6.0, 5.1 km
    pub const DEIMOS: Radii = Radii::new(7_800.0, 6_000.0, 5_100.0);
    /// BODY599_RADII = 71492, 71492, 66854 km (1 bar level)
    pub const JUPITER: Radii = Radii::new(71_492_000.0, 71_492_000.0, 66_854_000.0);
    /// BODY501_RADII = 1829.4, 1819.4, 1815.7 km
    pub const IO: Radii = Radii::new(1_829_400.0, 1_819_400.0, 1_815_700.0);
    /// BODY502_RADII = 1562.6, 1560.3, 1559.5 km
    pub const EUROPA: Radii = Radii::new(1_562_600.0, 1_560_300.0, 1_559_500.0);
    /// BODY503_RADII = 2631.2 km
    pub const GANYMEDE: Radii = Radii::sphere(2_631_200.0);
    /// BODY504_RADII = 2410.3 km
    pub const CALLISTO: Radii = Radii::sphere(2_410_300.0);
    /// BODY699_RADII = 60268, 60268, 54364 km (1 bar level)
    pub const SATURN: Radii = Radii::new(60_268_000.0, 60_268_000.0, 54_364_000.0);
    /// BODY601_RADII = 207.8, 196.7, 190.6 km
    pub const MIMAS: Radii = Radii::new(207_800.0, 196_700.0, 190_600.0);
    /// BODY602_RADII = 256.6, 251.4, 248.3 km
    pub const ENCELADUS: Radii = Radii::new(256_600.0, 251_400.0, 248_300.0);
    /// BODY603_RADII = 538.4, 528.3, 526.3 km
    pub const TETHYS: Radii = Radii::new(538_400.0, 528_300.0, 526_300.0);
    /// BODY604_RADII = 563.4, 561.3, 559.6 km
    pub const DIONE: Radii = Radii::new(563_400.0, 561_300.0, 559_600.0);
    /// BODY605_RADII = 765.0, 763.1, 762.4 km
    pub const RHEA: Radii = Radii::new(765_000.0, 763_100.0, 762_400.0);
    /// BODY606_RADII = 2575.15, 2574.78, 2574.47 km
    pub const TITAN: Radii = Radii::new(2_575_150.0, 2_574_780.0, 2_574_470.0);
    /// BODY608_RADII = 745.7, 745.7, 712.1 km
    pub const IAPETUS: Radii = Radii::new(745_700.0, 745_700.0, 712_100.0);
    /// BODY799_RADII = 25559, 25559, 24973 km (1 bar level)
    pub const URANUS: Radii = Radii::new(25_559_000.0, 25_559_000.0, 24_973_000.0);
    /// BODY899_RADII = 24764, 24764, 24341 km (1 bar level)
    pub const NEPTUNE: Radii = Radii::new(24_764_000.0, 24_764_000.0, 24_341_000.0);
    /// BODY801_RADII = 1352.6 km
    pub const TRITON: Radii = Radii::sphere(1_352_600.0);
    /// BODY999_RADII = 1188.3 km
    pub const PLUTO: Radii = Radii::sphere(1_188_300.0);
    /// BODY2000001_RADII = 487.3, 487.3, 446 km
    pub const CERES: Radii = Radii::new(487_300.0, 487_300.0, 446_000.0);
    /// BODY2000004_RADII = 289, 280, 229 km
    pub const VESTA: Radii = Radii::new(289_000.0, 280_000.0, 229_000.0);
}
