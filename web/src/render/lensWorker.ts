// Builds the lens-ghost table off the main thread (lensTrace.ts; Hullin et al. 2011).
//
// For field angles 0…THETA_MAX and each kept ghost and wavelength, every vertex of a G×G
// ray grid gets its image-plane position (in tan-space units: mm / EFL, so it maps
// straight to the pinhole camera) and a radiance factor K such that the ghost's
// equivalent scene radiance is L = π · E☉rel · K [U] (see units.ts):
//   E_image = E_beam · R · A_beam / A_image             (energy conservation per ray tube)
//   L_eq    = E_image · f² / A_pupil                    (camera equation, E = L·A_pupil/f²)
// so K = R · (A_beam / A_image) · f² / A_pupil, with A_image the ray tube's area on the
// image plane (from the grid's neighbouring rays).

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
  const per = G * G * 3;
  const data = new Float32Array(THETA_STEPS * KEEP * 3 * per);
  for (let t = 0; t < THETA_STEPS; t++) {
    const theta = ((t * THETA_MAX_DEG) / (THETA_STEPS - 1)) * (Math.PI / 180);
    for (let k = 0; k < ranked.length; k++) {
      for (let l = 0; l < 3; l++) {
        const r = traceGhost(ranked[k]!, theta, WAVELENGTHS[l]!, G, imageZ);
        const base = ((t * KEEP + k) * 3 + l) * per;
        const P = (i: number, j: number) => [r.xy[(i * G + j) * 2]!, r.xy[(i * G + j) * 2 + 1]!] as const;
        for (let i = 0; i < G; i++) {
          for (let j = 0; j < G; j++) {
            const v = i * G + j;
            const [x, y] = P(i, j);
            let K = 0;
            if (!Number.isNaN(x)) {
              // Image-plane area of this ray's tube: half the cross products to the
              // neighbours (central differences where available).
              const i0 = Math.max(0, i - 1), i1 = Math.min(G - 1, i + 1);
              const j0 = Math.max(0, j - 1), j1 = Math.min(G - 1, j + 1);
              const a = P(i, j0), b = P(i, j1), c = P(i0, j), d = P(i1, j);
              if (![a, b, c, d].some((p) => Number.isNaN(p[0]))) {
                const ux = (b[0] - a[0]) / (j1 - j0), uy = (b[1] - a[1]) / (j1 - j0);
                const vx = (d[0] - c[0]) / (i1 - i0), vy = (d[1] - c[1]) / (i1 - i0);
                const area = Math.abs(ux * vy - uy * vx);
                // Cap the focusing: a caustic would be infinitely bright in the limit.
                K = (r.e[v]! * (r.cell / Math.max(area, r.cell * 1e-4)) * efl * efl) / pupilArea;
              }
            }
            data[base + v * 3] = x / efl;
            data[base + v * 3 + 1] = y / efl;
            data[base + v * 3 + 2] = K;
          }
        }
      }
    }
  }
  return { efl, pupilArea, ghosts: ranked.length, data };
}

self.onmessage = () => {
  const table = build();
  (self as unknown as Worker).postMessage(table, [table.data.buffer]);
};
