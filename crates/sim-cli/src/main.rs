//! `simctl`: headless driver for the physics core.

use sim_core::bodies::BodyRegistry;
use sim_core::time::{self, Epoch, UtcDateTime};
use std::process::ExitCode;

const USAGE: &str = "\
simctl: RocketSim headless core

USAGE:
  simctl time <UTC ISO 8601>   convert UTC to TAI, TT and TDB
  simctl tdb <seconds>         convert TDB seconds past J2000 to UTC
  simctl bodies                list built-in bodies with GM and radii
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
        ["bodies"] => {
            cmd_bodies();
            Ok(())
        }
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
