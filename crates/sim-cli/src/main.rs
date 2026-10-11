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
  simctl propagate [options]   propagate a spacecraft and print osculating elements
      --epoch <UTC>            start (default 2026-11-01T00:00:00Z)
      --alt <km> --inc <deg>   circular Earth orbit (default 400 km, 51.6°)
      --mass <kg>              (default 15000)
      --duration <N[s|m|h|d]>  (default 1d)   --every <N[s|m|h|d]> output interval (default 1h)
      --degree <n>             EGM2008 degree/order (default 8)
      --no-drag --no-srp --no-third-body --no-harmonics
      --burn <start_s>,<dur_s>,<thrust_N>,<isp_s>,<prograde|retrograde|normal|antinormal|radial-out|radial-in>
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
        ["propagate", rest @ ..] => cmd_propagate(rest),
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

fn parse_duration(s: &str) -> Result<f64, String> {
    let (num, unit) = s.split_at(s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len()));
    let n: f64 = num.parse().map_err(|_| format!("bad duration: {s}"))?;
    let k = match unit {
        "" | "s" => 1.0,
        "m" => 60.0,
        "h" => 3600.0,
        "d" => 86_400.0,
        _ => return Err(format!("bad duration unit: {s}")),
    };
    Ok(n * k)
}

fn cmd_propagate(args: &[&str]) -> Result<(), String> {
    use sim_core::constants::{earth_wgs84, gm};
    use sim_core::kepler::Elements;
    use sim_core::math::{V3, fmath};
    use sim_core::propagator::{Burn, BurnDirection, Propagator, ScState};

    let mut epoch = "2026-11-01T00:00:00Z".to_string();
    let (mut alt_km, mut inc_deg, mut mass) = (400.0, 51.6, 15_000.0);
    let (mut duration, mut every) = (86_400.0, 3_600.0);
    let mut degree = 8usize;
    let (mut drag, mut srp, mut third, mut harmonics) = (true, true, true, true);
    let mut burn_spec: Option<String> = None;
    let mut it = args.iter();
    while let Some(&a) = it.next() {
        let mut val = || {
            it.next()
                .copied()
                .ok_or_else(|| format!("{a} needs a value"))
        };
        let num = |v: &str| v.parse::<f64>().map_err(|_| format!("bad number: {v}"));
        match a {
            "--epoch" => epoch = val()?.to_string(),
            "--alt" => alt_km = num(val()?)?,
            "--inc" => inc_deg = num(val()?)?,
            "--mass" => mass = num(val()?)?,
            "--duration" => duration = parse_duration(val()?)?,
            "--every" => every = parse_duration(val()?)?,
            "--degree" => degree = val()?.parse().map_err(|_| "bad degree".to_string())?,
            "--no-drag" => drag = false,
            "--no-srp" => srp = false,
            "--no-third-body" => third = false,
            "--no-harmonics" => harmonics = false,
            "--burn" => burn_spec = Some(val()?.to_string()),
            _ => return Err(format!("unknown option {a}\n{USAGE}")),
        }
    }
    let (_, t0) = parse_epoch(&epoch)?;
    let eph = load_ephemeris()?;
    let reg = BodyRegistry::builtin();
    let mut p = Propagator::new(&eph, &reg);
    p.forces.drag = drag;
    p.forces.srp = srp;
    p.forces.third_body = third;
    p.forces.harmonics = harmonics;
    p.forces.earth_degree = degree;
    let r = earth_wgs84::A + alt_km * 1e3;
    let v = (gm::EARTH / r).sqrt();
    let (si, ci) = fmath::sin_cos(inc_deg.to_radians());
    let s0 = ScState {
        epoch: t0,
        state: State::new(
            V3::new(r, 0.0, 0.0),
            V3::new(0.0, v * ci, v * si),
            IcrfBody {
                center: BodyId::EARTH,
            },
        ),
        mass,
    };
    let mut burns = Vec::new();
    if let Some(spec) = burn_spec {
        let f: Vec<&str> = spec.split(',').collect();
        if f.len() != 5 {
            return Err("--burn needs start,duration,thrust,isp,direction".into());
        }
        let n = |x: &str| x.parse::<f64>().map_err(|_| format!("bad number {x}"));
        let direction = match f[4] {
            "prograde" => BurnDirection::Prograde,
            "retrograde" => BurnDirection::Retrograde,
            "normal" => BurnDirection::Normal,
            "antinormal" => BurnDirection::AntiNormal,
            "radial-out" => BurnDirection::RadialOut,
            "radial-in" => BurnDirection::RadialIn,
            d => return Err(format!("bad burn direction {d}")),
        };
        let start = t0.add_seconds(n(f[0])?);
        burns.push(Burn {
            start,
            end: start.add_seconds(n(f[1])?),
            thrust: n(f[2])?,
            isp: n(f[3])?,
            direction,
        });
    }
    let clock = std::time::Instant::now();
    let traj = p
        .propagate(&s0, t0.add_seconds(duration), &burns)
        .map_err(|e| e.to_string())?;
    let elapsed = clock.elapsed();
    println!(
        "{:>10} {:>8} {:>11} {:>10} {:>9} {:>9} {:>9} {:>9} {:>11}",
        "t [h]", "center", "a [km]", "e", "i [°]", "Ω [°]", "ω [°]", "ν [°]", "mass [kg]"
    );
    let mut t: f64 = 0.0;
    loop {
        let tt = t.min(duration);
        let Some(s) = traj.state_at(t0.add_seconds(tt)) else {
            break;
        };
        let mu = reg.get(s.state.frame.center).map_or(gm::EARTH, |b| b.gm);
        let el = Elements::from_state(s.state.r, s.state.v, mu);
        let name = reg
            .get(s.state.frame.center)
            .map_or("?".to_string(), |b| b.name.clone());
        println!(
            "{:>10.3} {:>8} {:>11.3} {:>10.7} {:>9.4} {:>9.4} {:>9.4} {:>9.4} {:>11.3}",
            tt / 3600.0,
            name,
            el.a / 1e3,
            el.e,
            el.i.to_degrees(),
            el.raan.to_degrees(),
            el.argp.to_degrees(),
            el.nu.to_degrees(),
            s.mass
        );
        if tt >= duration {
            break;
        }
        t += every;
    }
    if let Some(end) = traj.terminated() {
        println!(
            "terminated: {end:?} at t = {:.1} s",
            traj.end_epoch().seconds_since(t0)
        );
    }
    println!(
        "{} arcs, {} integration steps, {:.1} ms wall ({:.1} µs/step)",
        traj.arcs.len(),
        traj.step_count(),
        elapsed.as_secs_f64() * 1e3,
        elapsed.as_secs_f64() * 1e6 / traj.step_count().max(1) as f64
    );
    Ok(())
}
