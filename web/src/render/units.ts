// Radiometric conventions shared by every shader.
//
// Radiance unit U = E☉(1 au) / π per steradian, where E☉(1 au) = 1361 W/m² (IAU 2015
// B3). With it, a Lambertian surface of albedo ρ lit by irradiance E (in units of
// E☉(1 au)) at incidence θ has radiance L = ρ·E·cosθ [U], with no π factors anywhere.
// Exposure then maps U to display values, like a camera.

/** AU / R☉ squared: the solar disk's radiance in U (distance-independent). */
export const SUN_RADIANCE_U = (149_597_870_700 / 695_700_000) ** 2; // ≈ 46,240

/** Apparent magnitude of the Sun at 1 au (IAU 2015 B3: V = −26.74). */
export const SUN_MAG_1AU = -26.74;

/** Irradiance of a point source of V magnitude `m`, in units of E☉(1 au). */
export function irradianceFromMagnitude(m: number): number {
  return Math.pow(10, -0.4 * (m - SUN_MAG_1AU));
}

/** Milky Way calibration: the 8-bit map's white (the 99.95th percentile of NASA SVS
 *  `milkyway_2020_4k`) is set to 20.0 mag/arcsec², about the Sagittarius star clouds.
 *  L = π·10^(−0.4(μ − m☉)) / Ω(1″²) in U. This is an assumption, documented, not a
 *  measurement. */
export const MILKY_WAY_WHITE_U = (Math.PI * Math.pow(10, -0.4 * (20.0 - SUN_MAG_1AU))) / 2.350443e-11;

/** Exposure (display value per U) bounds for the auto-exposure. */
export const EXPOSURE_MIN = 1e-3;
export const EXPOSURE_MAX = 3e7;

/** Pre-exposure (Frostbite/Unreal practice): every shader and light multiplies its
 *  radiance (U) by this before writing the HDR buffer, so fp16 targets hold
 *  display-range values. Physical radiances span ~1e-9 (Milky Way) to ~5e4 (solar
 *  disk), beyond half-float range. The engine sets it from last frame's exposure;
 *  the exposure pass then applies only the ratio exposure / preExposure. */
export const PRE_EXPOSURE = { value: 1 };
