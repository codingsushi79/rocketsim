//! The Mars-departure variant parses, validates and has the advertised kick-stage Δv.
use sim_core::constants::G0;
use sim_core::math::fmath;
use sim_core::vehicle::VehicleConfig;

#[test]
fn rs1_mds_parses_with_kick_stage_dv() {
    let v = VehicleConfig::from_json(include_str!("../../../data/vehicles/rs1_mds.json")).unwrap();
    assert_eq!(v.stages[0].id, "mds");
    let mass = |c: &VehicleConfig| {
        c.parts.iter().map(|p| p.mass).sum::<f64>()
            + c.tanks.iter().map(|t| t.capacity).sum::<f64>()
    };
    let m0 = mass(&v);
    let prop: f64 = v
        .tanks
        .iter()
        .filter(|t| t.stage == "mds")
        .map(|t| t.capacity)
        .sum();
    // Tsiolkovsky with the RL10C-1-class vacuum Isp of the data file.
    let dv = 449.7 * G0 * fmath::ln(m0 / (m0 - prop));
    eprintln!("stack {m0:.0} kg, MDS Δv {dv:.0} m/s");
    assert!((2_300.0..2_800.0).contains(&dv), "{dv}");
}
