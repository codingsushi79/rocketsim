// Credits shown in the game. CREDITS.md in the repository is the full record (URLs,
// licenses, retrieval dates); this list carries the required attributions.

export interface CreditEntry {
  what: string;
  who: string;
  note?: string;
}

export const CREDITS: CreditEntry[] = [
  { what: "Planetary and lunar ephemeris DE440", who: "NASA/JPL Solar System Dynamics (Park et al. 2021)" },
  { what: "Satellite ephemerides (mar099, jup365, sat441, nep098, plu060, ura111), asteroids (sb441-n16)", who: "NASA/JPL SSD and NAIF" },
  { what: "Rotation models (pck00011)", who: "IAU WGCCRE 2015 (Archinal et al. 2018), via NASA/JPL NAIF" },
  { what: "Earth orientation parameters", who: "IERS Rapid Service/Prediction Center (USNO)" },
  { what: "Leap seconds", who: "IERS Earth Orientation Center (Bulletin C)" },
  { what: "Earth gravity model EGM2008", who: "NGA (Pavlis et al. 2012), distributed by ICGEM/GFZ" },
  { what: "Moon gravity GL0660B, Mars gravity MRO120F", who: "NASA/JPL (Konopliv et al.)" },
  { what: "NRLMSISE-00 atmosphere", who: "U.S. Naval Research Laboratory (Picone, Hedin, Drob)" },
  { what: "Earth orientation algorithms (ERFA)", who: "Copyright © 2013–2021 NumFOCUS Foundation; derived from IAU SOFA", note: "BSD-3-Clause" },
  { what: "DOP853 integrator", who: "E. Hairer, Université de Genève", note: "BSD-2-Clause" },
  { what: "Blue Marble Next Generation (Earth day)", who: "NASA Earth Observatory (Reto Stöckli)" },
  { what: "Black Marble 2016 (Earth at night)", who: "NASA Earth Observatory (Miguel Román, NASA GSFC; VIIRS DNB)" },
  { what: "Deep Star Maps 2020 (Milky Way)", who: "NASA/Goddard Space Flight Center Scientific Visualization Studio" },
  { what: "Hipparcos star catalog", who: "ESA (1997), The Hipparcos and Tycho Catalogues, ESA SP-1200; via CDS VizieR" },
  { what: "three.js", who: "three.js authors", note: "MIT" },
];
