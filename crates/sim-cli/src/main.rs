//! `simctl`: headless driver for the physics core.

use sim_core::bodies::{BodyId, BodyRegistry};
use sim_core::earth;
use sim_core::ephemeris::Ephemeris;
use sim_core::frames::{IcrfBody, State, body_fixed_to_icrf_body};
use sim_core::time::{self, Epoch, UtcDateTime};
use std::process::ExitCode;

/// Directory with the built `.rseph` files (`ephem-build build`); override with
/// ROCKETSIM_EPHEM_DIR.
const DEFAULT_EPHEM_DIR: &str = "web/public/ephemeris";

const USAGE: &str = "\
simctl: RocketSim headless core

USAGE:
  simctl time <UTC ISO 8601>   convert UTC to TAI, TT and TDB
  simctl tdb <seconds>         convert TDB seconds past J2000 to UTC
  simctl bodies                list built-in bodies with GM and radii
  simctl ephem <body> <UTC> [<center>]
                               body state (ICRF, km, km/s) relative to center (default SSB);
                               bodies by name or NAIF id
  simctl ground <lat°> <lon°> <h m> <UTC>
                               WGS84 ground site in GCRS (Earth-centered inertial)
  simctl bench                 time ephemeris and orientation evaluation
  simctl canary                print the determinism canary hash
  simctl version               print the core version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["time", utc] => cmd_time(utc),
        ["tdb", secs] => cmd_tdb(secs),
        ["ephem", body, utc] => cmd_ephem(body, utc, "0"),
        ["ephem", body, utc, center] => cmd_ephem(body, utc, center),
        ["ground", lat, lon, h, utc] => cmd_ground(lat, lon, h, utc),
        ["bodies"] => {
            cmd_bodies();
            Ok(())
        }
        ["bench"] => cmd_bench(),
        ["canary"] => {
            println!("{:016x}", sim_core::determinism::canary());
            Ok(())
        }
        ["version"] => {
            println!("{}", sim_core::VERSION);
            Ok(())
        }
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn cmd_time(utc: &str) -> Result<(), String> {
    let u = UtcDateTime::parse_iso(utc).map_err(|e| e.to_string())?;
    let tai = time::utc_to_tai(&u).map_err(|e| e.to_string())?;
    let tt = time::tai_to_tt(tai);
    let tdb = time::tt_to_tdb(tt);
    println!(
        "UTC  {}{}",
        u.to_iso(6),
        if u.is_provisional() {
            "  (provisional: past leap-second table expiry)"
        } else {
            ""
        }
    );
    println!("TAI  {} s past 2000-01-01T12:00:00 TAI", split(tai.parts()));
    println!("TT   {} s past J2000.0 TT", split(tt.parts()));
    println!("TDB  {} s past J2000.0 TDB", split(tdb.tdb_parts()));
    println!(
        "TDB-TT {:+.9} s",
        tdb.seconds_since(Epoch::J2000) - tt.seconds()
    );
    Ok(())
}

/// Format two-part seconds exactly to the nanosecond (truncated), without
/// collapsing to a single f64.
fn split((sec, frac): (i64, f64)) -> String {
    let ns = ((frac * 1e9).floor() as i64).min(999_999_999);
    format!("{sec}.{ns:09}")
}

fn cmd_tdb(secs: &str) -> Result<(), String> {
    let s: f64 = secs.parse().map_err(|_| format!("not a number: {secs}"))?;
    if !s.is_finite() {
        return Err("TDB seconds must be finite".into());
    }
    let u = time::tdb_to_utc(Epoch::from_tdb_seconds(s)).map_err(|e| e.to_string())?;
    println!(
        "{}{}",
        u.to_iso(6),
        if u.is_provisional() {
            "  (provisional)"
        } else {
            ""
        }
    );
    Ok(())
}

fn cmd_bodies() {
    println!(
        "{:>8}  {:<10} {:>22}  {:>12} {:>12} {:>12}",
        "NAIF", "name", "GM [m^3/s^2]", "a [m]", "b [m]", "c [m]"
    );
    for b in BodyRegistry::builtin().iter() {
        println!(
            "{:>8}  {:<10} {:>22.15e}  {:>12.1} {:>12.1} {:>12.1}",
            b.id.0, b.name, b.gm, b.radii.a, b.radii.b, b.radii.c
        );
    }
}

fn parse_body(s: &str) -> Result<BodyId, String> {
    if let Ok(id) = s.parse::<i32>() {
        return Ok(BodyId(id));
    }
    BodyRegistry::builtin()
        .by_name(s)
        .map(|b| b.id)
        .ok_or_else(|| format!("unknown body: {s}"))
}

fn parse_epoch(utc: &str) -> Result<(UtcDateTime, Epoch), String> {
    let u = UtcDateTime::parse_iso(utc).map_err(|e| e.to_string())?;
    let t = time::utc_to_tdb(&u).map_err(|e| e.to_string())?;
    Ok((u, t))
}

fn load_ephemeris() -> Result<Ephemeris, String> {
    let dir = std::env::var("ROCKETSIM_EPHEM_DIR").unwrap_or_else(|_| DEFAULT_EPHEM_DIR.into());
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| {
            format!("{dir}: {e} (build it with `cargo run --release -p ephem-build -- build`)")
        })?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "rseph"))
        .collect();
    files.sort();
    let mut eph = Ephemeris::new();
    for f in files {
        eph.load(&std::fs::read(&f).map_err(|e| e.to_string())?)
            .map_err(|e| format!("{}: {e}", f.display()))?;
    }
    Ok(eph)
}

fn cmd_ephem(body: &str, utc: &str, center: &str) -> Result<(), String> {
    let (target, center) = (parse_body(body)?, parse_body(center)?);
    let (u, t) = parse_epoch(utc)?;
    let eph = load_ephemeris()?;
    let s = eph
        .state_relative(target, center, t)
        .map_err(|e| e.to_string())?;
    println!(
        "{} relative to {} at {} (TDB {:.3} s)",
        target.0,
        center.0,
        u.to_iso(3),
        t.tdb_seconds()
    );
    println!(
        "  r = [{:+.6}, {:+.6}, {:+.6}] km   |r| = {:.6} km",
        s.r.x / 1e3,
        s.r.y / 1e3,
        s.r.z / 1e3,
        s.r.norm() / 1e3
    );
    println!(
        "  v = [{:+.9}, {:+.9}, {:+.9}] km/s |v| = {:.9} km/s",
        s.v.x / 1e3,
        s.v.y / 1e3,
        s.v.z / 1e3,
        s.v.norm() / 1e3
    );
    println!("  frame: ICRF axes, geometric (no light time)");
    Ok(())
}

fn cmd_ground(lat: &str, lon: &str, h: &str, utc: &str) -> Result<(), String> {
    let num = |s: &str| s.parse::<f64>().map_err(|_| format!("not a number: {s}"));
    let (lat, lon, h) = (num(lat)?, num(lon)?, num(h)?);
    let (u, t) = parse_epoch(utc)?;
    let (o, quality) = earth::earth_orientation(t);
    let r_itrs = earth::geodetic_to_itrs(lat.to_radians(), lon.to_radians(), h);
    let site = State::new(
        r_itrs,
        sim_core::math::V3::ZERO,
        sim_core::frames::BodyFixed {
            body: BodyId::EARTH,
        },
    );
    let gcrs: State<IcrfBody> = body_fixed_to_icrf_body(&site, &o).map_err(|e| e.to_string())?;
    println!(
        "site lat {lat}°, lon {lon}°, h {h} m (WGS84) at {}",
        u.to_iso(3)
    );
    println!(
        "  ITRS r = [{:+.3}, {:+.3}, {:+.3}] m",
        r_itrs.x, r_itrs.y, r_itrs.z
    );
    println!(
        "  GCRS r = [{:+.3}, {:+.3}, {:+.3}] m",
        gcrs.r.x, gcrs.r.y, gcrs.r.z
    );
    println!(
        "  GCRS v = [{:+.6}, {:+.6}, {:+.6}] m/s",
        gcrs.v.x, gcrs.v.y, gcrs.v.z
    );
    println!("  Earth orientation parameters: {quality:?}");
    Ok(())
}

fn cmd_bench() -> Result<(), String> {
    let eph = load_ephemeris()?;
    let t0 =
        time::utc_to_tdb(&UtcDateTime::new(2026, 11, 1, 0, 0, 0.0)).map_err(|e| e.to_string())?;
    let bodies: Vec<BodyId> = BodyRegistry::builtin().iter().map(|b| b.id).collect();
    let n = 20_000;
    let mut sink = 0.0;
    let start = std::time::Instant::now();
    for i in 0..n {
        let t = t0.add_seconds(f64::from(i) * 37.0);
        for &b in &bodies {
            sink += eph.state_ssb(b, t).map_err(|e| e.to_string())?.r.x;
        }
    }
    let per = start.elapsed().as_secs_f64() / f64::from(n) / bodies.len() as f64;
    println!(
        "ephemeris state_ssb: {:.0} ns per body ({} bodies → {:.1} µs per full solar-system evaluation)",
        per * 1e9,
        bodies.len(),
        per * bodies.len() as f64 * 1e6
    );
    let start = std::time::Instant::now();
    for i in 0..n {
        sink += earth::earth_orientation(t0.add_seconds(f64::from(i) * 37.0))
            .0
            .icrf_to_bf
            .rows[0]
            .x;
    }
    println!(
        "earth_orientation: {:.1} µs",
        start.elapsed().as_secs_f64() / f64::from(n) * 1e6
    );
    let start = std::time::Instant::now();
    for i in 0..n {
        let t = t0.add_seconds(f64::from(i) * 37.0);
        for &b in &bodies {
            sink += sim_core::orientation::iau_body_orientation(b, t).map_or(0.0, |o| o.omega_bf.z);
        }
    }
    println!(
        "iau_body_orientation: {:.0} ns per body",
        start.elapsed().as_secs_f64() / f64::from(n) / bodies.len() as f64 * 1e9
    );
    std::hint::black_box(sink);
    Ok(())
}
