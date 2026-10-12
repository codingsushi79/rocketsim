// Sequential ray tracing through a real lens prescription, for physically based lens
// ghosts (Hullin, Eisemann, Seidel, Lee 2011, "Physically-Based Real-Time Lens Flare
// Rendering", ACM TOG 30(4):108). Pure math, no three.js: runs at startup.
//
// Lens: double-Gauss 50 mm f/2, US patent 2,673,491 (Tronnier), from W. J. Smith, *Modern
// Lens Design* (1992) p. 312, as scaled to 50 mm in Kolb, Mitchell, Hanrahan 1995 ("A
// Realistic Camera Model for Computer Graphics") and distributed with pbrt
// (`dgauss.50mm.dat`). Columns: radius (mm, 0 = plane), thickness to the next surface (mm),
// refractive index nd after the surface (0 = aperture stop), clear aperture diameter (mm).
// The patent's glass Abbe numbers are not in that table; typical values for each nd are
// assumed (documented below) and only set the ghosts' colour fringes.

export interface Surface {
  r: number;
  t: number;
  nd: number;
  vd: number;
  aperture: number;
}

/** [radius, thickness, nd, aperture diameter, assumed Abbe vd] */
const DGAUSS_50: [number, number, number, number, number][] = [
  [29.475, 3.76, 1.67, 25.2, 47.2], // LaK-type crown
  [84.83, 0.12, 1, 25.2, 0],
  [19.275, 4.025, 1.67, 23, 47.2],
  [40.77, 3.275, 1.699, 23, 30.1], // dense flint
  [12.75, 5.705, 1, 18, 0],
  [0, 4.5, 0, 17.1, 0], // aperture stop
  [-14.495, 1.18, 1.603, 17, 38.0], // flint
  [40.77, 6.065, 1.658, 20, 57.3], // dense crown
  [-20.385, 0.19, 1, 20, 0],
  [437.065, 3.22, 1.717, 20, 47.9], // LaF-type
  [-39.73, 5, 1, 20, 0],
];

export const LENS: Surface[] = DGAUSS_50.map(([r, t, nd, aperture, vd]) => ({ r, t, nd, vd, aperture }));

/** Stop opening as a fraction of its full diameter: f/2 → ~f/4 (a stopped-down camera). */
export const STOP_SCALE = 0.5;
/** Aperture blades (a regular polygon stop): the ghosts' and spikes' shape. */
export const BLADES = 6;

// Wavelengths (nm) for the R, G, B channels.
export const WAVELENGTHS = [650, 550, 450];

/** Refractive index at λ from nd and Abbe vd: a linear dispersion between the F (486.1 nm)
 *  and C (656.3 nm) lines, nF − nC = (nd − 1)/vd, in 1/λ² (Cauchy form). */
export function indexAt(nd: number, vd: number, lambdaNm: number): number {
  if (nd <= 1 || vd <= 0) return 1;
  const dn = (nd - 1) / vd;
  const x = (l: number) => 1 / (l * l);
  const b = dn / (x(486.1) - x(656.3));
  return nd + b * (x(lambdaNm) - x(587.6));
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Vertex z of each surface (first surface at z = 0); light travels +z. */
function vertices(lens: Surface[]): number[] {
  const z: number[] = [];
  let acc = 0;
  for (const s of lens) {
    z.push(acc);
    acc += s.t;
  }
  return z;
}

/** Intersect the ray with surface k. Returns the hit point and the unit normal facing −d. */
function hit(lens: Surface[], zv: number[], k: number, o: V3, d: V3): { p: V3; n: V3 } | null {
  const s = lens[k]!;
  if (s.r === 0) {
    if (Math.abs(d[2]) < 1e-12) return null;
    const t = (zv[k]! - o[2]) / d[2];
    if (t < 1e-9) return null;
    const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, zv[k]!];
    return { p, n: [0, 0, d[2] > 0 ? -1 : 1] };
  }
  const c: V3 = [0, 0, zv[k]! + s.r];
  const oc: V3 = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
  const b = dot(oc, d);
  const cc = dot(oc, oc) - s.r * s.r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  // The cap near the vertex: the root whose hit lies on the vertex side of the centre.
  for (const t of [-b - sq, -b + sq]) {
    if (t < 1e-9) continue;
    const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    if ((p[2] - c[2]) * Math.sign(s.r) < 0) {
      let n: V3 = [(p[0] - c[0]) / s.r, (p[1] - c[1]) / s.r, (p[2] - c[2]) / s.r];
      const l = Math.hypot(n[0], n[1], n[2]);
      n = [n[0] / l, n[1] / l, n[2] / l];
      if (dot(n, d) > 0) n = [-n[0], -n[1], -n[2]];
      return { p, n };
    }
  }
  return null;
}

/** Inside the clear aperture (the stop is a regular polygon of BLADES sides). */
function inside(lens: Surface[], k: number, p: V3): boolean {
  const s = lens[k]!;
  const isStop = s.nd === 0;
  const R = (s.aperture / 2) * (isStop ? STOP_SCALE : 1);
  if (!isStop) return p[0] * p[0] + p[1] * p[1] <= R * R;
  // Polygon with inradius R·cos(π/n), vertices at angle 0 (one blade edge vertical).
  const a = Math.atan2(p[1], p[0]);
  const seg = (2 * Math.PI) / BLADES;
  const local = a - seg * Math.floor(a / seg + 0.5);
  return Math.hypot(p[0], p[1]) * Math.cos(local) <= R * Math.cos(Math.PI / BLADES);
}

/** Snell refraction from n1 into n2 (n faces −d). Null on total internal reflection. */
function refract(d: V3, n: V3, n1: number, n2: number): V3 | null {
  const eta = n1 / n2;
  const ci = -dot(n, d);
  const k = 1 - eta * eta * (1 - ci * ci);
  if (k < 0) return null;
  const a = eta * ci - Math.sqrt(k);
  return [eta * d[0] + a * n[0], eta * d[1] + a * n[1], eta * d[2] + a * n[2]];
}

function reflect(d: V3, n: V3): V3 {
  const k = 2 * dot(d, n);
  return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]];
}

/** Coating: a single quarter-wave MgF₂ layer (n = 1.38) at 550 nm on every glass–air surface. */
const COATING_N = 1.38;
const COATING_LAMBDA = 550;

/** Fresnel reflectance (unpolarized) of the interface n1 | n2 at incidence cosine `ci`,
 *  optionally through a thin film (Hecht, *Optics*, §9.7: Airy summation for one layer). */
export function reflectance(n1: number, n2: number, ci: number, lambdaNm: number, coated: boolean): number {
  const sinI = Math.sqrt(Math.max(0, 1 - ci * ci));
  const amp = (na: number, nb: number, ca: number, cb: number) => ({
    s: (na * ca - nb * cb) / (na * ca + nb * cb),
    p: (nb * ca - na * cb) / (nb * ca + na * cb),
  });
  const cosIn = (n: number) => {
    const s = (n1 / n) * sinI;
    return s >= 1 ? 0 : Math.sqrt(1 - s * s);
  };
  const c2 = cosIn(n2);
  if (c2 === 0) return 1;
  if (!coated) {
    const r = amp(n1, n2, ci, c2);
    return 0.5 * (r.s * r.s + r.p * r.p);
  }
  const nf = COATING_N;
  const cf = cosIn(nf);
  const r01 = amp(n1, nf, ci, cf);
  const r12 = amp(nf, n2, cf, c2);
  const d = COATING_LAMBDA / (4 * nf);
  const delta = (4 * Math.PI * nf * d * cf) / lambdaNm; // round-trip phase
  const film = (a: number, b: number) => {
    // r = (a + b e^{iδ}) / (1 + a b e^{iδ}); |r|²
    const re = a + b * Math.cos(delta), im = b * Math.sin(delta);
    const dre = 1 + a * b * Math.cos(delta), dim = a * b * Math.sin(delta);
    return (re * re + im * im) / (dre * dre + dim * dim);
  };
  return 0.5 * (film(r01.s, r12.s) + film(r01.p, r12.p));
}

interface Medium {
  /** Index before surface k (k = 0 → air). */
  before(k: number): number;
  /** Index after surface k. */
  after(k: number): number;
}

function media(lens: Surface[], lambda: number): Medium {
  const n = lens.map((s) => (s.nd === 0 ? 1 : indexAt(s.nd, s.vd, lambda)));
  return { before: (k) => (k === 0 ? 1 : n[k - 1]!), after: (k) => n[k]! };
}

/** Paraxial-ish properties from real rays near the axis: effective focal length and the
 *  image plane z (focus at infinity), at 550 nm. */
export function focalProperties(lens: Surface[] = LENS): { efl: number; imageZ: number; pupilArea: number } {
  const zv = vertices(lens);
  const m = media(lens, 550);
  const h = 0.05;
  let o: V3 = [0, h, -10], d: V3 = [0, 0, 1];
  for (let k = 0; k < lens.length; k++) {
    const x = hit(lens, zv, k, o, d)!;
    o = x.p;
    d = refract(d, x.n, m.before(k), m.after(k))!;
  }
  // Axis crossing: y + t·dy = 0.
  const t = -o[1] / d[1];
  const imageZ = o[2] + t * d[2];
  const efl = h / Math.tan(Math.atan2(-d[1], d[2]));
  // Entrance pupil area: on-axis rays that reach the image.
  const g = 64;
  const R = lens[0]!.aperture / 2;
  const step = (2 * R) / g;
  let count = 0;
  for (let i = 0; i < g; i++) {
    for (let j = 0; j < g; j++) {
      const x0 = -R + (i + 0.5) * step, y0 = -R + (j + 0.5) * step;
      if (traceDirect(lens, zv, m, [x0, y0, -10], [0, 0, 1])) count++;
    }
  }
  return { efl, imageZ, pupilArea: count * step * step };
}

function traceDirect(lens: Surface[], zv: number[], m: Medium, o: V3, d: V3): boolean {
  for (let k = 0; k < lens.length; k++) {
    const x = hit(lens, zv, k, o, d);
    if (!x || !inside(lens, k, x.p)) return false;
    o = x.p;
    const nd = refract(d, x.n, m.before(k), m.after(k));
    if (!nd) return false;
    d = nd;
  }
  return true;
}

/** A ghost: first reflection at surface `a` (travelling forward), second at `b` < `a`. */
export interface Ghost {
  a: number;
  b: number;
}

export function allGhosts(lens: Surface[] = LENS): Ghost[] {
  const out: Ghost[] = [];
  const reflective = (k: number) => lens[k]!.nd !== 0;
  for (let a = 1; a < lens.length; a++) {
    for (let b = 0; b < a; b++) if (reflective(a) && reflective(b)) out.push({ a, b });
  }
  return out;
}

const coatedAt = (m: Medium, k: number) => m.before(k) === 1 || m.after(k) === 1;

/**
 * Trace one ghost for a collimated beam at field angle θ (in the x–z plane, the source at
 * +x) over a g×g grid on the plane z = 0 spanning the front aperture. Returns per ray the
 * image-plane position (mm) and the energy factor (product of Fresnel terms), or NaN when
 * the ray is vignetted.
 */
export function traceGhost(ghost: Ghost, theta: number, lambda: number, g: number, imageZ: number, lens: Surface[] = LENS): { xy: Float64Array; e: Float64Array; cell: number } {
  const zv = vertices(lens);
  const m = media(lens, lambda);
  const R = lens[0]!.aperture / 2;
  const step = (2 * R) / (g - 1);
  const d0: V3 = [-Math.sin(theta), 0, Math.cos(theta)];
  const xy = new Float64Array(g * g * 2).fill(NaN);
  const e = new Float64Array(g * g);
  for (let i = 0; i < g; i++) {
    for (let j = 0; j < g; j++) {
      const idx = i * g + j;
      const px = -R + j * step, py = -R + i * step;
      // Start upstream so the ray reaches the plane z = 0 at (px, py).
      let o: V3 = [px - d0[0] * (20 / d0[2]), py, -20];
      let d: V3 = [...d0];
      let energy = 1;
      let ok = true;
      const cross = (k: number, n1: number, n2: number, mode: "t" | "r"): boolean => {
        const x = hit(lens, zv, k, o, d);
        if (!x || !inside(lens, k, x.p)) return false;
        const ci = -dot(x.n, d);
        const Rf = lens[k]!.nd === 0 ? 0 : reflectance(n1, n2, ci, lambda, coatedAt(m, k));
        o = x.p;
        if (mode === "r") {
          d = reflect(d, x.n);
          energy *= Rf;
        } else {
          const nd = refract(d, x.n, n1, n2);
          if (!nd) return false;
          d = nd;
          energy *= 1 - Rf;
        }
        return true;
      };
      for (let k = 0; ok && k < ghost.a; k++) ok = cross(k, m.before(k), m.after(k), "t");
      ok = ok && cross(ghost.a, m.before(ghost.a), m.after(ghost.a), "r");
      for (let k = ghost.a - 1; ok && k > ghost.b; k--) ok = cross(k, m.after(k), m.before(k), "t");
      ok = ok && cross(ghost.b, m.after(ghost.b), m.before(ghost.b), "r");
      for (let k = ghost.b + 1; ok && k < lens.length; k++) ok = cross(k, m.before(k), m.after(k), "t");
      if (!ok || d[2] <= 0) continue;
      const t = (imageZ - o[2]) / d[2];
      xy[idx * 2] = o[0] + d[0] * t;
      xy[idx * 2 + 1] = o[1] + d[1] * t;
      e[idx] = energy;
    }
  }
  // Beam cross-section per ray (the grid lies in z = 0; the beam is tilted by θ).
  return { xy, e, cell: step * step * Math.cos(theta) };
}

// Ghost table layout (built in lensWorker.ts).
export const G = 32;
export const THETA_MAX_DEG = 45;
export const THETA_STEPS = 46; // 1° apart
export const KEEP = 16;

export interface GhostTable {
  efl: number;
  /** Entrance pupil area (mm²). */
  pupilArea: number;
  ghosts: number;
  /** [theta][ghost][lambda] → (x, y, r, K): Float32Array of THETA_STEPS·KEEP·3·4. */
  data: Float32Array;
}
