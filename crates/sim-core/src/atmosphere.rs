//! Atmosphere density models for drag (spec §2.2).
//!
//! - **Earth**:
//!   - Below 86 km: U.S. Standard Atmosphere 1976 (NOAA-S/T 76-1562, NASA-TM-X-74335,
//!     Part 1), exact layer equations.
//!   - Above: NRLMSISE-00 ([`crate::nrlmsise00`]) with configurable space weather.
//!   - Between 86 and 91 km the two are blended log-linearly, so density (and drag) has
//!     no jump at the switch. The models differ by tens of percent there.
//!   - Altitude is WGS84 geodetic.
//! - **Mars, Venus, Titan**: documented low-fidelity v1 approximations (cited per model)
//!   until mission-derived profiles are added. Altitude is above the mean radius.
//!
//! All densities in kg/m³. `None` means "no atmosphere here" (outside the model's
//! top), and drag is skipped.

use crate::bodies::BodyId;
use crate::constants::radii;
use crate::earth;
use crate::math::{V3, fmath};
use crate::nrlmsise00::{self, MsisInput};
use crate::time::{self, Epoch, days_from_civil};

/// Solar and geomagnetic activity inputs for NRLMSISE-00.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpaceWeather {
    /// Previous-day 10.7 cm solar flux, sfu.
    pub f107: f64,
    /// 81-day centered average F10.7, sfu.
    pub f107a: f64,
    /// Daily planetary geomagnetic index Ap.
    pub ap: f64,
}

impl Default for SpaceWeather {
    /// Moderate activity: the reference values in NRL's own test driver.
    fn default() -> SpaceWeather {
        SpaceWeather {
            f107: 150.0,
            f107a: 150.0,
            ap: 4.0,
        }
    }
}

/// Top of the Earth model (density < 1e-15 kg/m³ above; drag negligible).
const EARTH_TOP_KM: f64 = 2500.0;
const BLEND_LOW_KM: f64 = 86.0;
const BLEND_HIGH_KM: f64 = 91.0;

/// Density at body-fixed position `r_bf` (m) around `body`, or `None` outside the
/// atmosphere or for bodies without one.
pub fn density(body: BodyId, r_bf: V3, t: Epoch, sw: &SpaceWeather) -> Option<f64> {
    match body {
        BodyId::EARTH => earth_density(r_bf, t, sw),
        BodyId::MARS => mars_density(r_bf.norm() - radii::MARS.equatorial_mean()),
        BodyId::VENUS => exponential(r_bf.norm() - radii::VENUS.a, VENUS_RHO0, VENUS_H, 250e3),
        BodyId::TITAN => exponential(
            r_bf.norm() - radii::TITAN.equatorial_mean(),
            TITAN_RHO0,
            TITAN_H,
            1500e3,
        ),
        _ => None,
    }
}

fn earth_density(r_bf: V3, t: Epoch, sw: &SpaceWeather) -> Option<f64> {
    let (lat, lon, h) = earth::itrs_to_geodetic(r_bf);
    let h_km = h / 1000.0;
    if h_km > EARTH_TOP_KM {
        return None;
    }
    if h_km <= BLEND_LOW_KM {
        return Some(us76_density(h.max(0.0)));
    }
    let msis = || {
        let u = time::tdb_to_utc(t).ok()?;
        let doy = (days_from_civil(i64::from(u.year), i64::from(u.month), i64::from(u.day))
            - days_from_civil(i64::from(u.year), 1, 1)
            + 1) as f64;
        let sec = f64::from(u.hour) * 3600.0 + f64::from(u.minute) * 60.0 + u.second;
        let glong = lon.to_degrees();
        let out = nrlmsise00::gtd7d(&MsisInput {
            doy,
            sec,
            alt_km: h_km,
            glat: lat.to_degrees(),
            glong,
            stl: sec / 3600.0 + glong / 15.0,
            f107a: sw.f107a,
            f107: sw.f107,
            ap: sw.ap,
        })?;
        Some(out.d[5] * 1000.0) // g/cm³ → kg/m³
    };
    if h_km >= BLEND_HIGH_KM {
        return msis();
    }
    // Log-linear blend over 86–91 km.
    let w = (h_km - BLEND_LOW_KM) / (BLEND_HIGH_KM - BLEND_LOW_KM);
    let (a, b) = (us76_density(h), msis()?);
    Some(fmath::exp((1.0 - w) * fmath::ln(a) + w * fmath::ln(b)))
}

// ---------------------------------------------------------------------------
// U.S. Standard Atmosphere 1976, 0–86 km (NOAA-S/T 76-1562, §1.2–1.3, Table 4)
// ---------------------------------------------------------------------------

/// Effective Earth radius for geopotential altitude, m (US76 r₀).
const US76_R0: f64 = 6_356_766.0;
/// Sea-level standard gravity, temperature, pressure, molecular weight, gas constant.
const US76_G0: f64 = 9.806_65;
const US76_T0: f64 = 288.15;
const US76_P0: f64 = 101_325.0;
const US76_M0: f64 = 28.964_4; // kg/kmol
const US76_RSTAR: f64 = 8_314.32; // J/(kmol·K)
/// Layer bases (geopotential km′) and molecular-scale temperature lapse rates (K/km′).
const US76_HB: [f64; 8] = [0.0, 11.0, 20.0, 32.0, 47.0, 51.0, 71.0, 84.852];
const US76_LB: [f64; 7] = [-6.5, 0.0, 1.0, 2.8, 0.0, -2.8, -2.0];

/// Density, kg/m³, at geometric altitude `z` (m), 0 ≤ z ≤ 86 km. Uses the exact
/// hydrostatic layer equations (US76 eqs. 33a/33b). ρ = P·M₀/(R*·T_M) holds through
/// 80–86 km, where only the kinetic temperature, not T_M, changes.
pub fn us76_density(z: f64) -> f64 {
    let h = US76_R0 * z / (US76_R0 + z) / 1000.0; // geopotential km′
    let gmr = US76_G0 * US76_M0 / US76_RSTAR * 1000.0; // K per km′ (34.163195)
    let (mut tb, mut pb) = (US76_T0, US76_P0);
    for i in 0..7 {
        let top = US76_HB[i + 1];
        let lb = US76_LB[i];
        let dh = h.min(top) - US76_HB[i];
        let (t, p) = if lb == 0.0 {
            (tb, pb * fmath::exp(-gmr * dh / tb))
        } else {
            let t = tb + lb * dh;
            (t, pb * fmath::pow(tb / t, gmr / lb))
        };
        if h <= top || i == 6 {
            return p * US76_M0 / (US76_RSTAR * t);
        }
        tb = t;
        pb = p;
    }
    unreachable!()
}

// ---------------------------------------------------------------------------
// Other bodies (documented v1 approximations)
// ---------------------------------------------------------------------------

/// Mars: NASA Glenn Research Center "Mars Atmosphere Model" (fit to Mars Global
/// Surveyor data, 1996): T[°C] = −31 − 0.000998h for h > 7000 m, else −23.4 − 0.00222h;
/// p[kPa] = 0.699·exp(−0.00009h); ρ = p / (0.1921·(T + 273.1)). Used to 200 km.
fn mars_density(h: f64) -> Option<f64> {
    if h > 200e3 {
        return None;
    }
    let h = h.max(0.0);
    let t = if h > 7000.0 {
        -31.0 - 0.000998 * h
    } else {
        -23.4 - 0.00222 * h
    };
    let p = 0.699 * fmath::exp(-0.00009 * h);
    // T goes non-physical above ~200 km in this fit; clamp to 100 K.
    Some(p / (0.1921 * (t + 273.1).max(100.0)))
}

/// Venus surface density and scale height (NASA GSFC Venus Fact Sheet: ~65 kg/m³,
/// 15.9 km).
const VENUS_RHO0: f64 = 65.0;
const VENUS_H: f64 = 15_900.0;
/// Titan surface density from Huygens HASI (Fulchignoni et al. 2005, Nature 438:785):
/// p = 146.7 kPa, T = 93.65 K, N₂ → ρ = pM/(RT) ≈ 5.27 kg/m³. Isothermal scale height
/// RT/(Mg) with g = 1.352 m/s² → 20.6 km.
const TITAN_RHO0: f64 = 5.27;
const TITAN_H: f64 = 20_600.0;

fn exponential(h: f64, rho0: f64, scale: f64, top: f64) -> Option<f64> {
    if h > top {
        return None;
    }
    Some(rho0 * fmath::exp(-h.max(0.0) / scale))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// US76 Table I (geometric altitude, density kg/m³), NOAA-S/T 76-1562.
    #[test]
    fn us76_matches_published_table() {
        for (z_km, rho) in [
            (0.0, 1.2250),
            (10.0, 4.1351e-1),
            (20.0, 8.8910e-2),
            (30.0, 1.8410e-2),
            (50.0, 1.0269e-3),
            (80.0, 1.8458e-5),
            (86.0, 6.958e-6),
        ] {
            let got = us76_density(z_km * 1000.0);
            assert!(
                (got / rho - 1.0).abs() < 2e-3,
                "{z_km} km: {got:e} vs {rho:e}"
            );
        }
    }

    #[test]
    fn earth_density_is_continuous_across_the_blend() {
        let sw = SpaceWeather::default();
        let t = Epoch::from_tdb_seconds(8.4e8);
        let at = |h: f64| earth_density(earth::geodetic_to_itrs(0.4, 1.0, h), t, &sw).unwrap();
        for h in [86_000.0, 91_000.0] {
            let (lo, hi) = (at(h - 1.0), at(h + 1.0));
            assert!((hi / lo - 1.0).abs() < 1e-3, "{h}: {lo:e} → {hi:e}");
        }
    }

    #[test]
    fn mars_surface_density() {
        // ~0.020 kg/m³ at the reference surface (Mars fact sheet).
        let r = mars_density(0.0).unwrap();
        assert!((0.010..0.025).contains(&r), "{r}");
    }
}
