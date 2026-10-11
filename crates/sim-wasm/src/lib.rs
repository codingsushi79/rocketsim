//! Browser bindings. Each export is a thin wrapper over `sim-core`; no physics here.

use sim_core::bodies::BodyRegistry;
use sim_core::time::{self, Epoch, UtcDateTime};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    sim_core::VERSION.to_string()
}

/// Determinism canary as 16 hex digits. Must equal `simctl canary`.
#[wasm_bindgen]
pub fn canary() -> String {
    format!("{:016x}", sim_core::determinism::canary())
}

/// UTC ISO string → TDB seconds past J2000 (f64; display precision).
#[wasm_bindgen(js_name = utcToTdbSeconds)]
pub fn utc_to_tdb_seconds(utc: &str) -> Result<f64, JsError> {
    let u = UtcDateTime::parse_iso(utc)?;
    Ok(time::utc_to_tdb(&u)?.tdb_seconds())
}

/// TDB seconds past J2000 → UTC ISO string with millisecond precision.
#[wasm_bindgen(js_name = tdbToUtcIso)]
pub fn tdb_to_utc_iso(tdb_seconds: f64) -> Result<String, JsError> {
    if !tdb_seconds.is_finite() {
        return Err(JsError::new("TDB seconds must be finite"));
    }
    Ok(time::tdb_to_utc(Epoch::from_tdb_seconds(tdb_seconds))?.to_iso(3))
}

/// True if the UTC string is past the bundled leap-second table's expiry.
#[wasm_bindgen(js_name = isProvisionalUtc)]
pub fn is_provisional_utc(utc: &str) -> Result<bool, JsError> {
    Ok(UtcDateTime::parse_iso(utc)?.is_provisional())
}

/// Built-in bodies as JSON: [{id, name, kind, parent, gm, radii: [a, b, c]}].
#[wasm_bindgen(js_name = bodiesJson)]
pub fn bodies_json() -> String {
    let rows: Vec<String> = BodyRegistry::builtin()
        .iter()
        .map(|b| {
            format!(
                r#"{{"id":{},"name":"{}","kind":"{:?}","parent":{},"gm":{:e},"radii":[{},{},{}]}}"#,
                b.id.0,
                b.name,
                b.kind,
                b.parent.map_or("null".to_string(), |p| p.0.to_string()),
                b.gm,
                b.radii.a,
                b.radii.b,
                b.radii.c
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}
