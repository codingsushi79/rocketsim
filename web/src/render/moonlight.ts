// Moonlight: the Moon's irradiance at an observer, in units of E☉(1 au).
//
// Lunar phase law (Allen's Astrophysical Quantities, 4th ed., §12.5; used by Krisciunas &
// Schaefer 1991, PASP 103:1033, for moonlit-sky brightness): the Moon's V magnitude at
// mean distance is m(α) = −12.73 + 0.026|α| + 4·10⁻⁹·α⁴ (α = phase angle in degrees).
// The Sun's is V = −26.74 at 1 au, so at full moon E_moon/E☉ = 10^(−0.4·14.01) ≈ 2.5·10⁻⁶.
// The law includes the opposition surge, which a Lambert sphere misses.

/** Sun's apparent V magnitude at 1 au (Willmer 2018, ApJS 236:47). */
const SUN_V = -26.74;
/** Full-moon V magnitude at mean distance (Allen). */
const MOON_V_FULL = -12.73;
/** Mean Earth–Moon distance the law refers to, m (Allen). */
const MOON_MEAN_DISTANCE = 384_400e3;

/**
 * @param phaseAngle Sun–Moon–observer angle, rad.
 * @param dObserver Moon–observer distance, m.
 * @param sunAu Sun–Moon distance, au (the law is for 1 au).
 */
export function lunarIrradiance(phaseAngle: number, dObserver: number, sunAu: number): number {
  const a = Math.min(Math.abs(phaseAngle) * (180 / Math.PI), 180);
  // Past ~150° the polynomial is untested; the Moon is a thin crescent near the Sun there.
  const m = MOON_V_FULL + 0.026 * a + 4e-9 * a ** 4;
  const atMean = 10 ** (-0.4 * (m - SUN_V));
  return atMean * (MOON_MEAN_DISTANCE / dObserver) ** 2 / (sunAu * sunAu);
}
