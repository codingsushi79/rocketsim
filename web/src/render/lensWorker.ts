// Builds the lens-ghost table off the main thread (lensTrace.ts; Hullin et al. 2011).
//
// For field angles 0…THETA_MAX and each kept ghost and wavelength, rays are traced over a
// G×G grid on the entrance aperture, and the ghost is reduced to what a real flare ghost
// looks like: a soft image of the polygonal stop. Stored per (θ, ghost, λ):
//   x, y  centroid on the image plane, tan-space units (mm / EFL, so it maps straight to
//         the pinhole camera);
//   r     radius of the equivalent uniform disc, √2 × the RMS spread (tan units);
//   K     mean radiance factor: the ghost's equivalent scene radiance is L = π·E☉rel·K [U]
//         (units.ts), from energy conservation and the camera equation:
//           E_image = E_beam · ΣR_i·A_beam,i / A_ghost,   L = E_image · f² / A_pupil.

import { G, KEEP, THETA_MAX_DEG, THETA_STEPS, WAVELENGTHS, allGhosts, focalProperties, traceGhost, type GhostTable } from "./lensTrace";

function build(): GhostTable {
  const { efl, imageZ, pupilArea } = focalProperties();
  // Keep the ghosts carrying the most energy at 10°.
  const ranked = allGhosts()
    .map((g) => {
      const r = traceGhost(g, (10 * Math.PI) / 180, 550, G, imageZ);
      let e = 0;
      for (let i = 0; i < r.e.length; i++) if (!Number.isNaN(r.xy[2 * i]!)) e += r.e[i]!;
      return { g, e };
    })
    .sort((a, b) => b.e - a.e)
    .slice(0, KEEP)
    .map((x) => x.g);
  const data = new Float32Array(THETA_STEPS * KEEP * 3 * 4);
  for (let t = 0; t < THETA_STEPS; t++) {
    const theta = ((t * THETA_MAX_DEG) / (THETA_STEPS - 1)) * (Math.PI / 180);
    for (let k = 0; k < ranked.length; k++) {
      for (let l = 0; l < 3; l++) {
        const r = traceGhost(ranked[k]!, theta, WAVELENGTHS[l]!, G, imageZ);
        let n = 0, e = 0, sx = 0, sy = 0;
        for (let i = 0; i < G * G; i++) {
          const x = r.xy[2 * i]!;
          if (Number.isNaN(x)) continue;
          n++;
          e += r.e[i]!;
          sx += x;
          sy += r.xy[2 * i + 1]!;
        }
        const o = ((t * KEEP + k) * 3 + l) * 4;
        if (n < 4) continue; // vignetted away: r = K = 0
        const cx = sx / n, cy = sy / n;
        let v = 0;
        for (let i = 0; i < G * G; i++) {
          const x = r.xy[2 * i]!;
          if (Number.isNaN(x)) continue;
          v += (x - cx) ** 2 + (r.xy[2 * i + 1]! - cy) ** 2;
        }
        const rad = Math.max(Math.SQRT2 * Math.sqrt(v / n), 0.05); // mm; ≥ blur of a real lens
        const K = (e * r.cell * efl * efl) / (pupilArea * Math.PI * rad * rad);
        data[o] = cx / efl;
        data[o + 1] = cy / efl;
        data[o + 2] = rad / efl;
        data[o + 3] = K;
      }
    }
  }
  return { efl, pupilArea, ghosts: ranked.length, data };
}

self.onmessage = () => {
  const table = build();
  (self as unknown as Worker).postMessage(table, [table.data.buffer]);
};
