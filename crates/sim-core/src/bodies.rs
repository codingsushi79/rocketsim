//! Celestial body identities and properties.
//!
//! Bodies are identified by NAIF integer IDs, the IDs used in SPK/PCK kernels.
//! Asteroids and comets loaded from SPK files later get their NAIF IDs
//! (e.g. 2000001 = Ceres, 20000433 = Eros) and need no code changes. The registry
//! is a runtime table, not an enum.

use crate::constants::{Radii, gm, radii};

/// NAIF integer ID of a body or barycenter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BodyId(pub i32);

impl BodyId {
    pub const SSB: BodyId = BodyId(0);
    pub const SUN: BodyId = BodyId(10);
    pub const MERCURY: BodyId = BodyId(199);
    pub const VENUS: BodyId = BodyId(299);
    pub const EARTH_MOON_BARYCENTER: BodyId = BodyId(3);
    pub const EARTH: BodyId = BodyId(399);
    pub const MOON: BodyId = BodyId(301);
    pub const MARS: BodyId = BodyId(499);
    pub const PHOBOS: BodyId = BodyId(401);
    pub const DEIMOS: BodyId = BodyId(402);
    pub const JUPITER: BodyId = BodyId(599);
    pub const IO: BodyId = BodyId(501);
    pub const EUROPA: BodyId = BodyId(502);
    pub const GANYMEDE: BodyId = BodyId(503);
    pub const CALLISTO: BodyId = BodyId(504);
    pub const SATURN: BodyId = BodyId(699);
    pub const MIMAS: BodyId = BodyId(601);
    pub const ENCELADUS: BodyId = BodyId(602);
    pub const TETHYS: BodyId = BodyId(603);
    pub const DIONE: BodyId = BodyId(604);
    pub const RHEA: BodyId = BodyId(605);
    pub const TITAN: BodyId = BodyId(606);
    pub const IAPETUS: BodyId = BodyId(608);
    pub const URANUS: BodyId = BodyId(799);
    pub const NEPTUNE: BodyId = BodyId(899);
    pub const TRITON: BodyId = BodyId(801);
    pub const PLUTO: BodyId = BodyId(999);
    pub const CERES: BodyId = BodyId(2_000_001);
    pub const VESTA: BodyId = BodyId(2_000_004);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyKind {
    Star,
    Planet,
    DwarfPlanet,
    Moon,
    Asteroid,
    Comet,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BodyInfo {
    pub id: BodyId,
    pub name: String,
    pub kind: BodyKind,
    /// Body that this body orbits (for SOI hierarchy and display); `None` for the Sun.
    pub parent: Option<BodyId>,
    /// GM of the body alone, m³/s².
    pub gm: f64,
    /// IAU reference ellipsoid, m.
    pub radii: Radii,
}

/// (id, name, kind, parent, GM, radii) row of the builtin table.
type BodyRow = (BodyId, &'static str, BodyKind, Option<BodyId>, f64, Radii);

/// Runtime body table. v1 is built from the cited constants. Later bodies can be
/// appended from data (SPK + metadata) with [`BodyRegistry::insert`].
#[derive(Clone, Debug, Default)]
pub struct BodyRegistry {
    bodies: Vec<BodyInfo>,
}

impl BodyRegistry {
    /// The v1 body list (spec §2.1).
    pub fn builtin() -> BodyRegistry {
        use BodyKind::*;
        let s = Some(BodyId::SUN);
        let rows: [BodyRow; 27] = [
            (BodyId::SUN, "Sun", Star, None, gm::SUN, radii::SUN),
            (
                BodyId::MERCURY,
                "Mercury",
                Planet,
                s,
                gm::MERCURY,
                radii::MERCURY,
            ),
            (BodyId::VENUS, "Venus", Planet, s, gm::VENUS, radii::VENUS),
            (BodyId::EARTH, "Earth", Planet, s, gm::EARTH, radii::EARTH),
            (
                BodyId::MOON,
                "Moon",
                Moon,
                Some(BodyId::EARTH),
                gm::MOON,
                radii::MOON,
            ),
            (BodyId::MARS, "Mars", Planet, s, gm::MARS, radii::MARS),
            (
                BodyId::PHOBOS,
                "Phobos",
                Moon,
                Some(BodyId::MARS),
                gm::PHOBOS,
                radii::PHOBOS,
            ),
            (
                BodyId::DEIMOS,
                "Deimos",
                Moon,
                Some(BodyId::MARS),
                gm::DEIMOS,
                radii::DEIMOS,
            ),
            (
                BodyId::JUPITER,
                "Jupiter",
                Planet,
                s,
                gm::JUPITER,
                radii::JUPITER,
            ),
            (
                BodyId::IO,
                "Io",
                Moon,
                Some(BodyId::JUPITER),
                gm::IO,
                radii::IO,
            ),
            (
                BodyId::EUROPA,
                "Europa",
                Moon,
                Some(BodyId::JUPITER),
                gm::EUROPA,
                radii::EUROPA,
            ),
            (
                BodyId::GANYMEDE,
                "Ganymede",
                Moon,
                Some(BodyId::JUPITER),
                gm::GANYMEDE,
                radii::GANYMEDE,
            ),
            (
                BodyId::CALLISTO,
                "Callisto",
                Moon,
                Some(BodyId::JUPITER),
                gm::CALLISTO,
                radii::CALLISTO,
            ),
            (
                BodyId::SATURN,
                "Saturn",
                Planet,
                s,
                gm::SATURN,
                radii::SATURN,
            ),
            (
                BodyId::MIMAS,
                "Mimas",
                Moon,
                Some(BodyId::SATURN),
                gm::MIMAS,
                radii::MIMAS,
            ),
            (
                BodyId::ENCELADUS,
                "Enceladus",
                Moon,
                Some(BodyId::SATURN),
                gm::ENCELADUS,
                radii::ENCELADUS,
            ),
            (
                BodyId::TETHYS,
                "Tethys",
                Moon,
                Some(BodyId::SATURN),
                gm::TETHYS,
                radii::TETHYS,
            ),
            (
                BodyId::DIONE,
                "Dione",
                Moon,
                Some(BodyId::SATURN),
                gm::DIONE,
                radii::DIONE,
            ),
            (
                BodyId::RHEA,
                "Rhea",
                Moon,
                Some(BodyId::SATURN),
                gm::RHEA,
                radii::RHEA,
            ),
            (
                BodyId::TITAN,
                "Titan",
                Moon,
                Some(BodyId::SATURN),
                gm::TITAN,
                radii::TITAN,
            ),
            (
                BodyId::IAPETUS,
                "Iapetus",
                Moon,
                Some(BodyId::SATURN),
                gm::IAPETUS,
                radii::IAPETUS,
            ),
            (
                BodyId::URANUS,
                "Uranus",
                Planet,
                s,
                gm::URANUS,
                radii::URANUS,
            ),
            (
                BodyId::NEPTUNE,
                "Neptune",
                Planet,
                s,
                gm::NEPTUNE,
                radii::NEPTUNE,
            ),
            (
                BodyId::TRITON,
                "Triton",
                Moon,
                Some(BodyId::NEPTUNE),
                gm::TRITON,
                radii::TRITON,
            ),
            (
                BodyId::PLUTO,
                "Pluto",
                DwarfPlanet,
                s,
                gm::PLUTO,
                radii::PLUTO,
            ),
            (
                BodyId::CERES,
                "Ceres",
                DwarfPlanet,
                s,
                gm::CERES,
                radii::CERES,
            ),
            (BodyId::VESTA, "Vesta", Asteroid, s, gm::VESTA, radii::VESTA),
        ];
        let mut reg = BodyRegistry::default();
        for (id, name, kind, parent, gm, radii) in rows {
            reg.insert(BodyInfo {
                id,
                name: name.to_string(),
                kind,
                parent,
                gm,
                radii,
            })
            .expect("builtin body ids are unique");
        }
        reg
    }

    /// Add a body. Fails if the ID is already present.
    pub fn insert(&mut self, info: BodyInfo) -> Result<(), BodyError> {
        if self.get(info.id).is_some() {
            return Err(BodyError::DuplicateId(info.id));
        }
        self.bodies.push(info);
        Ok(())
    }

    pub fn get(&self, id: BodyId) -> Option<&BodyInfo> {
        self.bodies.iter().find(|b| b.id == id)
    }

    pub fn by_name(&self, name: &str) -> Option<&BodyInfo> {
        self.bodies
            .iter()
            .find(|b| b.name.eq_ignore_ascii_case(name))
    }

    /// Bodies in insertion order. The order is deterministic, so anything that
    /// sums over bodies (e.g. gravity) gives bit-identical results run to run.
    pub fn iter(&self) -> impl Iterator<Item = &BodyInfo> {
        self.bodies.iter()
    }

    pub fn len(&self) -> usize {
        self.bodies.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bodies.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyError {
    DuplicateId(BodyId),
}

impl core::fmt::Display for BodyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            BodyError::DuplicateId(id) => write!(f, "duplicate body id {}", id.0),
        }
    }
}

impl std::error::Error for BodyError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_contains_every_v1_body() {
        let reg = BodyRegistry::builtin();
        assert_eq!(reg.len(), 27);
        for name in [
            "Sun",
            "Mercury",
            "Venus",
            "Earth",
            "Mars",
            "Jupiter",
            "Saturn",
            "Uranus",
            "Neptune",
            "Pluto",
            "Moon",
            "Io",
            "Europa",
            "Ganymede",
            "Callisto",
            "Titan",
            "Mimas",
            "Enceladus",
            "Tethys",
            "Dione",
            "Rhea",
            "Iapetus",
            "Phobos",
            "Deimos",
            "Triton",
            "Ceres",
            "Vesta",
        ] {
            assert!(reg.by_name(name).is_some(), "missing {name}");
        }
    }

    #[test]
    fn every_parent_is_registered() {
        let reg = BodyRegistry::builtin();
        for b in reg.iter() {
            if let Some(p) = b.parent {
                assert!(
                    reg.get(p).is_some(),
                    "{} has unknown parent {}",
                    b.name,
                    p.0
                );
            }
        }
    }

    #[test]
    fn duplicate_ids_are_rejected() {
        let mut reg = BodyRegistry::builtin();
        let earth = reg.get(BodyId::EARTH).unwrap().clone();
        assert_eq!(
            reg.insert(earth),
            Err(BodyError::DuplicateId(BodyId::EARTH))
        );
    }
}
