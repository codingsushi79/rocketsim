// Visible incandescence of a heated grey body, in the renderer's radiance unit U (see
// units.ts) and white-balanced to sunlight. Pure math (no imports), unit-tested.
//
// Radiative equilibrium εσT⁴ = q (Anderson, *Hypersonic and High-Temperature Gas
// Dynamics*, §6.9); Planck's law against the CIE 1931 2° colour-matching functions (multi-
// lobe fits, Wyman, Sloan & Shirley 2013, JCGT 2(2)); XYZ → linear sRGB (IEC 61966-2-1);
// sunlight as a 5772 K blackbody of 1361 W/m² at 1 au (IAU 2015 B3).

const SIGMA = 5.670374419e-8; // Stefan–Boltzmann, W m⁻² K⁻⁴ (CODATA 2018, exact)
/** Charring-ablator emissivity (typical 0.8–0.9). */
export const EMISSIVITY = 0.85;
const H = 6.62607015e-34, C = 299792458, KB = 1.380649e-23; // SI 2019 exact
const SOLAR_T = 5772; // K, IAU 2015 B3 nominal effective temperature
const SOLAR_E = 1361; // W/m² at 1 au, IAU 2015 B3

/** CIE 1931 2° colour-matching functions, multi-lobe Gaussian fits (Wyman et al. 2013). */
function cmf(l: number): [number, number, number] {
  const g = (x: number, mu: number, s1: number, s2: number) => {
    const t = (x - mu) / (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  const x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

/** Planck spectral radiance, W m⁻² sr⁻¹ m⁻¹. */
function planck(lambdaM: number, T: number): number {
  return (2 * H * C * C) / lambdaM ** 5 / (Math.exp((H * C) / (lambdaM * KB * T)) - 1);
}

function xyzOf(T: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 2) {
    const b = planck(l * 1e-9, T) * 2e-9;
    const [x, y, z] = cmf(l);
    X += b * x;
    Y += b * y;
    Z += b * z;
  }
  return [X, Y, Z];
}

/** XYZ → linear sRGB (IEC 61966-2-1). */
function toRgb([X, Y, Z]: [number, number, number]): [number, number, number] {
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
}

// Sunlight as the reference white: a 5772 K blackbody scaled so its radiance is 1 U
// (E☉/π). White balance divides each channel by the Sun's.
const SUN_SCALE = SOLAR_E / Math.PI / ((SIGMA * SOLAR_T ** 4) / Math.PI);
const SUN_RGB = toRgb(xyzOf(SOLAR_T)).map((c) => c * SUN_SCALE) as [number, number, number];

/** Visible radiance (U, linear sRGB, white-balanced to sunlight) of a grey body at T. */
export function incandescenceU(T: number, emissivity = EMISSIVITY): [number, number, number] {
  const rgb = toRgb(xyzOf(T));
  return rgb.map((c, i) => Math.max(0, (emissivity * c) / SUN_RGB[i]!)) as [number, number, number];
}

/** Radiative-equilibrium wall temperature for heat flux q (W/m²). */
export function wallTemperature(q: number): number {
  return Math.pow(Math.max(q, 0) / (EMISSIVITY * SIGMA), 0.25);
}

