//! Time scales and the physics clock (decision D3).
//!
//! - The physics clock is [`Epoch`]: TDB seconds past J2000.0 TDB
//!   (2000-01-01T12:00:00 TDB, the same convention as SPICE ET). It is stored as
//!   whole seconds (`i64`) plus a fraction in [0, 1), like Orekit's
//!   `AbsoluteDate`. That keeps full sub-nanosecond resolution over the
//!   ephemeris span, so long step accumulation does not lose precision.
//! - UTC is only used at the edges (display, scenario input). Chain:
//!   UTC → TAI (IERS leap-second table) → TT (+32.184 s) → TDB (periodic series).
//! - [`Tai`] and [`Tt`] count seconds past 2000-01-01T12:00:00 on their own scales.
//!
//! UTC before 1972-01-01 (variable-length seconds) is not supported.

use crate::constants::{DAYS_PER_JULIAN_CENTURY, SECONDS_PER_DAY, TT_MINUS_TAI};
use crate::math::fmath;
use core::fmt;

include!(concat!(env!("OUT_DIR"), "/leap_seconds.rs"));

/// MJD of the calendar day 2000-01-01.
const MJD_2000_01_01: i64 = 51_544;
/// MJD of 1970-01-01, the zero of [`days_from_civil`].
const MJD_UNIX_EPOCH: i64 = 40_587;
const SECONDS_PER_DAY_I: i64 = 86_400;
/// The J2000 epoch is at 12:00 on 2000-01-01.
const J2000_SECOND_OF_DAY: i64 = 43_200;

/// Two-part seconds count: `sec + frac` with `frac` in [0, 1).
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
struct Split {
    sec: i64,
    frac: f64,
}

impl Split {
    fn new(sec: i64, frac: f64) -> Split {
        assert!(frac.is_finite(), "non-finite time fraction");
        let fl = frac.floor();
        let mut s = Split {
            sec: sec + fl as i64,
            frac: frac - fl,
        };
        // frac − floor(frac) can round up to exactly 1.0 for tiny negative inputs.
        if s.frac >= 1.0 {
            s.sec += 1;
            s.frac -= 1.0;
        }
        s
    }

    fn from_f64(seconds: f64) -> Split {
        assert!(seconds.is_finite(), "non-finite time");
        let fl = seconds.floor();
        Split::new(fl as i64, seconds - fl)
    }

    fn add_seconds(self, dt: f64) -> Split {
        assert!(dt.is_finite(), "non-finite time step");
        // Split dt first so a large step doesn't wipe out the stored fraction.
        let di = dt.floor();
        Split::new(self.sec + di as i64, self.frac + (dt - di))
    }

    fn diff(self, other: Split) -> f64 {
        (self.sec - other.sec) as f64 + (self.frac - other.frac)
    }

    fn to_f64(self) -> f64 {
        self.sec as f64 + self.frac
    }
}

/// The physics clock: an instant on the TDB scale, counted in seconds past
/// J2000.0 TDB.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Epoch(Split);

impl Epoch {
    pub const J2000: Epoch = Epoch(Split { sec: 0, frac: 0.0 });

    pub fn from_tdb_seconds(seconds: f64) -> Epoch {
        Epoch(Split::from_f64(seconds))
    }
    /// From whole seconds plus a fraction (normalized; `frac` may be any finite value).
    pub fn from_tdb_parts(sec: i64, frac: f64) -> Epoch {
        Epoch(Split::new(sec, frac))
    }
    /// TDB seconds past J2000 as one f64. Precision drops to ~0.5 µs at ±100 years.
    /// Use [`Epoch::seconds_since`] for differences.
    pub fn tdb_seconds(self) -> f64 {
        self.0.to_f64()
    }
    /// (whole seconds, fraction in [0, 1)).
    pub fn tdb_parts(self) -> (i64, f64) {
        (self.0.sec, self.0.frac)
    }
    pub fn add_seconds(self, dt: f64) -> Epoch {
        Epoch(self.0.add_seconds(dt))
    }
    /// `self − earlier` in seconds, computed from the split parts with full precision.
    pub fn seconds_since(self, earlier: Epoch) -> f64 {
        self.0.diff(earlier.0)
    }
    /// Julian centuries of TDB since J2000.0, the argument of IAU rotation models.
    pub fn tdb_julian_centuries(self) -> f64 {
        self.tdb_seconds() / (SECONDS_PER_DAY * DAYS_PER_JULIAN_CENTURY)
    }
}

/// An instant on the TAI scale: seconds past 2000-01-01T12:00:00 TAI.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Tai(Split);

/// An instant on the TT scale: seconds past 2000-01-01T12:00:00 TT (J2000.0).
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Tt(Split);

impl Tai {
    pub fn seconds(self) -> f64 {
        self.0.to_f64()
    }
    pub fn parts(self) -> (i64, f64) {
        (self.0.sec, self.0.frac)
    }
}

impl Tt {
    pub fn seconds(self) -> f64 {
        self.0.to_f64()
    }
    pub fn parts(self) -> (i64, f64) {
        (self.0.sec, self.0.frac)
    }
    pub fn julian_centuries(self) -> f64 {
        self.seconds() / (SECONDS_PER_DAY * DAYS_PER_JULIAN_CENTURY)
    }
}

/// A UTC calendar date and time. `second` is in [0, 60), or [60, 61) during a
/// positive leap second.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UtcDateTime {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TimeError {
    /// The string isn't `YYYY-MM-DD[THH:MM[:SS[.fff]]][Z]`.
    Parse(String),
    /// The fields don't form a valid UTC instant (e.g. 23:59:60 on a day with no leap second).
    InvalidDateTime(String),
    /// Before 1972-01-01 UTC (no leap-second-based UTC).
    BeforeLeapSecondTable,
}

impl fmt::Display for TimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TimeError::Parse(s) => write!(f, "cannot parse UTC time: {s}"),
            TimeError::InvalidDateTime(s) => write!(f, "invalid UTC date/time: {s}"),
            TimeError::BeforeLeapSecondTable => {
                write!(f, "UTC before 1972-01-01 is not supported")
            }
        }
    }
}

impl std::error::Error for TimeError {}

/// Days from 1970-01-01 in the proleptic Gregorian calendar.
/// H. Hinnant, "chrono-Compatible Low-Level Date Algorithms", `days_from_civil`.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`] (Hinnant, `civil_from_days`). Returns (y, m, d).
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        _ => 28,
    }
}

/// TAI − UTC (whole seconds) in effect on the UTC day `utc_mjd`, or `None` before 1972.
pub fn tai_minus_utc(utc_mjd: i64) -> Option<i64> {
    LEAP_SECONDS
        .iter()
        .rev()
        .find(|(m, _)| *m <= utc_mjd)
        .map(|(_, d)| *d)
}

/// True if the UTC day `utc_mjd` is on or after the expiry date of the bundled
/// IERS leap-second file. Such dates are *provisional*: a future leap second
/// could still be announced. The UI shows a marker for them.
pub fn is_provisional_utc_mjd(utc_mjd: i64) -> bool {
    utc_mjd >= LEAP_TABLE_EXPIRES_MJD
}

/// UTC MJD on which the bundled leap-second table expires.
pub fn leap_table_expiry_mjd() -> i64 {
    LEAP_TABLE_EXPIRES_MJD
}

impl UtcDateTime {
    pub fn new(year: i32, month: u8, day: u8, hour: u8, minute: u8, second: f64) -> UtcDateTime {
        UtcDateTime {
            year,
            month,
            day,
            hour,
            minute,
            second,
        }
    }

    /// Modified Julian Date of the calendar day (integer, 00:00 UTC).
    pub fn mjd_day(&self) -> i64 {
        days_from_civil(
            i64::from(self.year),
            i64::from(self.month),
            i64::from(self.day),
        ) + MJD_UNIX_EPOCH
    }

    pub fn is_provisional(&self) -> bool {
        is_provisional_utc_mjd(self.mjd_day())
    }

    /// Parse `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `YYYY-MM-DDTHH:MM:SS[.fff]`, with an
    /// optional trailing `Z`. A space may replace `T`. Fields are validated by
    /// [`utc_to_tai`], not here.
    pub fn parse_iso(s: &str) -> Result<UtcDateTime, TimeError> {
        let err = || TimeError::Parse(s.to_string());
        let t = s.trim();
        let t = t.strip_suffix('Z').unwrap_or(t);
        let (date, time) = match t.find(['T', ' ']) {
            Some(i) => (&t[..i], Some(&t[i + 1..])),
            None => (t, None),
        };
        let mut dp = date.split('-');
        let year: i32 = dp.next().ok_or_else(err)?.parse().map_err(|_| err())?;
        let month: u8 = dp.next().ok_or_else(err)?.parse().map_err(|_| err())?;
        let day: u8 = dp.next().ok_or_else(err)?.parse().map_err(|_| err())?;
        if dp.next().is_some() {
            return Err(err());
        }
        let (mut hour, mut minute, mut second) = (0u8, 0u8, 0.0f64);
        if let Some(time) = time {
            let mut tp = time.split(':');
            hour = tp.next().ok_or_else(err)?.parse().map_err(|_| err())?;
            minute = tp.next().ok_or_else(err)?.parse().map_err(|_| err())?;
            if let Some(sec) = tp.next() {
                if sec.is_empty() || !sec.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
                    return Err(err());
                }
                second = sec.parse().map_err(|_| err())?;
            }
            if tp.next().is_some() {
                return Err(err());
            }
        }
        Ok(UtcDateTime {
            year,
            month,
            day,
            hour,
            minute,
            second,
        })
    }

    /// ISO 8601 with `decimals` fractional digits (0–9). The fraction is
    /// truncated, not rounded, so 23:59:59.9999 never turns into an invalid :60.
    pub fn to_iso(&self, decimals: u32) -> String {
        let decimals = decimals.min(9);
        let whole = self.second.floor();
        let mut s = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            self.year, self.month, self.day, self.hour, self.minute, whole as u32
        );
        if decimals > 0 {
            let scale = 10u64.pow(decimals);
            let f = ((self.second - whole) * scale as f64).floor() as u64;
            s.push_str(&format!(
                ".{:0width$}",
                f.min(scale - 1),
                width = decimals as usize
            ));
        }
        s.push('Z');
        s
    }
}

impl fmt::Display for UtcDateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_iso(3))
    }
}

/// UTC → TAI using the IERS leap-second table.
pub fn utc_to_tai(utc: &UtcDateTime) -> Result<Tai, TimeError> {
    let bad = |why: &str| TimeError::InvalidDateTime(format!("{utc:?}: {why}"));
    let (y, m, d) = (
        i64::from(utc.year),
        i64::from(utc.month),
        i64::from(utc.day),
    );
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return Err(bad("no such calendar day"));
    }
    if utc.hour > 23 || utc.minute > 59 {
        return Err(bad("hour/minute out of range"));
    }
    if !(utc.second.is_finite() && utc.second >= 0.0 && utc.second < 61.0) {
        return Err(bad("second out of range"));
    }
    let mjd = utc.mjd_day();
    let dat = tai_minus_utc(mjd).ok_or(TimeError::BeforeLeapSecondTable)?;
    if utc.second >= 60.0 {
        let leap_tonight = tai_minus_utc(mjd + 1).is_some_and(|next| next > dat);
        if !(leap_tonight && utc.hour == 23 && utc.minute == 59) {
            return Err(bad("second 60 only exists during a leap second"));
        }
    }
    let whole = utc.second.floor();
    let sec = (mjd - MJD_2000_01_01) * SECONDS_PER_DAY_I - J2000_SECOND_OF_DAY
        + i64::from(utc.hour) * 3600
        + i64::from(utc.minute) * 60
        + whole as i64
        + dat;
    Ok(Tai(Split::new(sec, utc.second - whole)))
}

/// TAI → UTC. Instants inside a leap second come out as 23:59:60.x.
///
/// The result is rounded to the nearest nanosecond. UTC is display-only, and
/// rounding stops TDB → UTC round trips that land 1e-16 s before midnight from
/// showing as 23:59:59.999.
pub fn tai_to_utc(tai: Tai) -> Result<UtcDateTime, TimeError> {
    let tai = Tai(Split::new(tai.0.sec, (tai.0.frac * 1e9).round() * 1e-9));
    // TAI instant at which each table row takes effect (an integer second).
    let start = |(mjd, dat): (i64, i64)| {
        (mjd - MJD_2000_01_01) * SECONDS_PER_DAY_I - J2000_SECOND_OF_DAY + dat
    };
    let i = LEAP_SECONDS
        .iter()
        .rposition(|&row| tai.0.sec >= start(row))
        .ok_or(TimeError::BeforeLeapSecondTable)?;
    let (_, dat) = LEAP_SECONDS[i];
    let frac = tai.0.frac;

    if let Some(&(next_mjd, next_dat)) = LEAP_SECONDS.get(i + 1) {
        let inserted = next_dat - dat;
        if inserted > 0 && tai.0.sec >= start((next_mjd, next_dat)) - inserted {
            // Inside the leap second(s) right before UTC midnight that starts next_mjd.
            let into = tai.0.sec - (start((next_mjd, next_dat)) - inserted);
            let (y, m, d) = civil_from_days(next_mjd - 1 - MJD_UNIX_EPOCH);
            return Ok(UtcDateTime {
                year: y as i32,
                month: m as u8,
                day: d as u8,
                hour: 23,
                minute: 59,
                second: 60.0 + into as f64 + frac,
            });
        }
    }

    let count = tai.0.sec - dat + J2000_SECOND_OF_DAY; // UTC seconds past 2000-01-01T00:00
    let days = count.div_euclid(SECONDS_PER_DAY_I);
    let sod = count.rem_euclid(SECONDS_PER_DAY_I);
    let (y, m, d) = civil_from_days(MJD_2000_01_01 + days - MJD_UNIX_EPOCH);
    Ok(UtcDateTime {
        year: y as i32,
        month: m as u8,
        day: d as u8,
        hour: (sod / 3600) as u8,
        minute: ((sod % 3600) / 60) as u8,
        second: (sod % 60) as f64 + frac,
    })
}

pub fn tai_to_tt(tai: Tai) -> Tt {
    Tt(tai.0.add_seconds(TT_MINUS_TAI))
}

pub fn tt_to_tai(tt: Tt) -> Tai {
    Tai(tt.0.add_seconds(-TT_MINUS_TAI))
}

/// TDB − TT in seconds at the geocenter, with `t` in Julian centuries of TT since J2000.
///
/// Series from G. H. Kaplan, *The IAU Resolutions on Astronomical Reference
/// Systems, Time Scales, and Earth Rotation Models*, USNO Circular 179 (2005),
/// eq. 2.6. It is a truncation of Fairhead & Bretagnon (1990), accurate to about
/// 10 µs over 1600–2200. Checked against ERFA `eraDtdb` in tests/time_erfa.rs.
/// Topocentric terms (≤ 2 µs) are omitted.
pub fn tdb_minus_tt(t: f64) -> f64 {
    0.001_657 * fmath::sin(628.307_6 * t + 6.240_1)
        + 0.000_022 * fmath::sin(575.338_5 * t + 4.297_0)
        + 0.000_014 * fmath::sin(1_256.615_2 * t + 6.196_9)
        + 0.000_005 * fmath::sin(606.977_7 * t + 4.021_2)
        + 0.000_005 * fmath::sin(52.969_1 * t + 0.444_4)
        + 0.000_002 * fmath::sin(21.329_9 * t + 5.543_1)
        + 0.000_010 * t * fmath::sin(628.307_6 * t + 4.249_0)
}

pub fn tt_to_tdb(tt: Tt) -> Epoch {
    Epoch(tt.0.add_seconds(tdb_minus_tt(tt.julian_centuries())))
}

/// Inverse of [`tt_to_tdb`]. Two fixed-point iterations: the correction's rate
/// of change is ~1e-8, so the residual is far below 1 ps.
pub fn tdb_to_tt(tdb: Epoch) -> Tt {
    let tdb_centuries = tdb.tdb_julian_centuries();
    let tt0 = tdb.0.add_seconds(-tdb_minus_tt(tdb_centuries));
    let tt0_centuries = Tt(tt0).julian_centuries();
    Tt(tdb.0.add_seconds(-tdb_minus_tt(tt0_centuries)))
}

pub fn utc_to_tdb(utc: &UtcDateTime) -> Result<Epoch, TimeError> {
    Ok(tt_to_tdb(tai_to_tt(utc_to_tai(utc)?)))
}

pub fn tdb_to_utc(tdb: Epoch) -> Result<UtcDateTime, TimeError> {
    tai_to_utc(tt_to_tai(tdb_to_tt(tdb)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> UtcDateTime {
        UtcDateTime::parse_iso(s).unwrap()
    }

    #[test]
    fn civil_day_roundtrip_over_four_centuries() {
        for z in -200_000..200_000 {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
    }

    #[test]
    fn j2000_is_11_58_55_816_utc() {
        // J2000.0 = 2000-01-01T12:00:00 TT = 11:58:55.816 UTC (TAI−UTC = 32 s).
        let tt = tai_to_tt(utc_to_tai(&utc("2000-01-01T11:58:55.816")).unwrap());
        assert!(tt.seconds().abs() < 1e-9, "{}", tt.seconds());
    }

    #[test]
    fn leap_second_2016_12_31() {
        let before = utc_to_tai(&utc("2016-12-31T23:59:59")).unwrap();
        let leap = utc_to_tai(&utc("2016-12-31T23:59:60")).unwrap();
        let after = utc_to_tai(&utc("2017-01-01T00:00:00")).unwrap();
        assert_eq!(leap.0.diff(before.0), 1.0);
        assert_eq!(after.0.diff(leap.0), 1.0);
        assert_eq!(tai_to_utc(leap).unwrap().to_iso(0), "2016-12-31T23:59:60Z");
        let mid = Tai(leap.0.add_seconds(0.5));
        assert_eq!(tai_to_utc(mid).unwrap().to_iso(1), "2016-12-31T23:59:60.5Z");
        assert_eq!(tai_to_utc(after).unwrap().to_iso(0), "2017-01-01T00:00:00Z");
    }

    #[test]
    fn second_60_rejected_without_leap() {
        assert!(matches!(
            utc_to_tai(&utc("2018-12-31T23:59:60")),
            Err(TimeError::InvalidDateTime(_))
        ));
        assert!(matches!(
            utc_to_tai(&utc("2016-12-31T12:59:60")),
            Err(TimeError::InvalidDateTime(_))
        ));
    }

    #[test]
    fn pre_1972_rejected() {
        assert_eq!(
            utc_to_tai(&utc("1971-12-31T23:59:59")),
            Err(TimeError::BeforeLeapSecondTable)
        );
        assert!(utc_to_tai(&utc("1972-01-01T00:00:00")).is_ok());
    }

    #[test]
    fn invalid_calendar_rejected() {
        for s in [
            "2023-02-29",
            "2024-13-01",
            "2024-04-31",
            "2024-01-01T24:00:00",
        ] {
            assert!(utc_to_tai(&utc(s)).is_err(), "{s}");
        }
        assert!(utc_to_tai(&utc("2024-02-29")).is_ok());
    }

    #[test]
    fn parse_rejects_garbage() {
        for s in [
            "",
            "2024",
            "2024-01-01T",
            "2024-01-01T10",
            "2024-01-01T10:00:00:00",
            "2024-01-01T10:00:-1",
        ] {
            assert!(UtcDateTime::parse_iso(s).is_err(), "{s:?}");
        }
    }

    #[test]
    fn utc_tdb_roundtrip() {
        for s in [
            "1972-01-01T00:00:00",
            "1999-12-31T23:59:59.999",
            "2026-11-01T00:00:00",
            "2016-12-31T23:59:60.25",
            "2099-06-15T07:30:12.125",
        ] {
            let u = utc(s);
            let back = tdb_to_utc(utc_to_tdb(&u).unwrap()).unwrap();
            assert_eq!(
                (back.year, back.month, back.day, back.hour, back.minute),
                (u.year, u.month, u.day, u.hour, u.minute),
                "{s}"
            );
            assert!(
                (back.second - u.second).abs() < 1e-9,
                "{s}: {}",
                back.second
            );
        }
    }

    #[test]
    fn epoch_split_keeps_precision_over_many_steps() {
        // 10 million 0.1 s steps from a 2100-era epoch. A single f64 (ulp ≈ 0.5 µs
        // at 3e9 s) could drift by up to seconds here; the split form stays below 1 µs.
        let mut e = Epoch::from_tdb_seconds(3.15e9);
        for _ in 0..10_000_000 {
            e = e.add_seconds(0.1);
        }
        let elapsed = e.seconds_since(Epoch::from_tdb_seconds(3.15e9));
        assert!((elapsed - 1.0e6).abs() < 1e-6, "{elapsed}");
    }

    #[test]
    fn epoch_normalizes_fraction() {
        let e = Epoch::from_tdb_parts(10, -0.25);
        assert_eq!(e.tdb_parts(), (9, 0.75));
        let e = Epoch::from_tdb_parts(10, 2.5);
        assert_eq!(e.tdb_parts(), (12, 0.5));
        let e = Epoch::from_tdb_parts(0, -1e-20);
        let (s, f) = e.tdb_parts();
        assert!((0.0..1.0).contains(&f) && (s == -1 || s == 0));
    }

    #[test]
    fn provisional_after_table_expiry() {
        let exp = leap_table_expiry_mjd();
        assert!(!is_provisional_utc_mjd(exp - 1));
        assert!(is_provisional_utc_mjd(exp));
    }
}
