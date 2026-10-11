// Navball: the local horizon sphere seen from behind the vehicle, nose at the centre.
// Rendered per pixel on a 2D canvas, so it is exact at any attitude.
//
// Screen mapping (pilot's view): right = body +Y, up = body −Z, into the screen =
// body +X. The sky half is above the local horizontal plane (normal = radial "up"
// from the centre body); heading is measured from the body's north (its spin axis
// projected onto the horizontal plane).

type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V): V => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** q = [w, x, y, z] (body → ICRF) as a row-major matrix. */
function quatToMatrix(q: number[]): number[] {
  const [w, x, y, z] = q as [number, number, number, number];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

export interface NavMarkers {
  prograde: V;
  normal: V;
  radial: V;
  target: V | null;
  maneuver: V | null;
}

export class Navball {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  /** Body-frame direction per pixel (inside the disk), and the disk mask. */
  private dirs: Float32Array;
  private inside: Uint8Array;
  /** Nose pitch/heading/roll, degrees (for the readout). */
  pitch = 0;
  heading = 0;
  roll = 0;

  constructor(size = 168) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = px;
    this.canvas.style.width = this.canvas.style.height = `calc(${size}px * var(--hud-scale))`;
    this.canvas.className = "navball";
    this.ctx = this.canvas.getContext("2d")!;
    this.img = this.ctx.createImageData(px, px);
    this.dirs = new Float32Array(px * px * 3);
    this.inside = new Uint8Array(px * px);
    const r = px / 2;
    for (let j = 0; j < px; j++) {
      for (let i = 0; i < px; i++) {
        const sx = (i + 0.5 - r) / r;
        const sy = (r - j - 0.5) / r;
        const s2 = sx * sx + sy * sy;
        if (s2 > 1) continue;
        const sz = Math.sqrt(1 - s2);
        const k = j * px + i;
        this.inside[k] = 1;
        this.dirs[k * 3] = sz;
        this.dirs[k * 3 + 1] = sx;
        this.dirs[k * 3 + 2] = -sy;
      }
    }
  }

  /** `q` body → ICRF; `up` local vertical and `pole` body spin axis (ICRF units). */
  draw(q: number[], up: V, pole: V, m: NavMarkers): void {
    const R = quatToMatrix(q);
    // (up × pole) × up = pole − up(up·pole): the pole projected on the horizontal.
    const north = normalize(cross(cross(up, pole), up));
    const east = cross(north, up);
    // Local axes expressed in body coordinates: d_icrf·u = d_body·(Rᵀu).
    const toBody = (u: V): V => [
      R[0]! * u[0] + R[3]! * u[1] + R[6]! * u[2],
      R[1]! * u[0] + R[4]! * u[1] + R[7]! * u[2],
      R[2]! * u[0] + R[5]! * u[1] + R[8]! * u[2],
    ];
    const ub = toBody(up), nb = toBody(north), eb = toBody(east);
    const px = this.canvas.width;
    const data = this.img.data;
    const d = this.dirs;
    const line = (x: number, step: number, width: number) => {
      const f = x / step - Math.round(x / step);
      return Math.abs(f) * step < width;
    };
    for (let k = 0; k < px * px; k++) {
      const o = k * 4;
      if (!this.inside[k]) {
        data[o + 3] = 0;
        continue;
      }
      const bx = d[k * 3]!, by = d[k * 3 + 1]!, bz = d[k * 3 + 2]!;
      const su = bx * ub[0] + by * ub[1] + bz * ub[2];
      const elev = Math.asin(Math.max(-1, Math.min(1, su))) * 57.29578;
      const hdg = Math.atan2(bx * eb[0] + by * eb[1] + bz * eb[2], bx * nb[0] + by * nb[1] + bz * nb[2]) * 57.29578;
      let r: number, g: number, b: number;
      if (elev >= 0) {
        const t = Math.min(1, elev / 90);
        (r = 70 - 40 * t), (g = 140 - 50 * t), (b = 215 - 40 * t);
      } else {
        const t = Math.min(1, -elev / 90);
        (r = 150 - 60 * t), (g = 95 - 40 * t), (b = 50 - 25 * t);
      }
      // Grid: horizon, 10° elevation rings, 30° heading meridians (fading near the poles).
      const lw = 0.55 / Math.max(0.15, bx);
      if (Math.abs(elev) < 0.9) (r = 240), (g = 240), (b = 240);
      else if (line(elev, 10, lw) || (Math.abs(elev) < 80 && line(hdg, 30, lw / Math.max(0.2, Math.cos(elev / 57.29578))))) {
        (r = r * 0.55 + 110), (g = g * 0.55 + 110), (b = b * 0.55 + 110);
      }
      // Limb shading.
      const shade = 0.55 + 0.45 * bx;
      data[o] = r * shade;
      data[o + 1] = g * shade;
      data[o + 2] = b * shade;
      data[o + 3] = 255;
    }
    const ctx = this.ctx;
    ctx.putImageData(this.img, 0, 0);

    // Markers.
    const rad = px / 2;
    const mark = (v: V | null, draw: (x: number, y: number, s: number) => void) => {
      if (!v) return;
      const b = toBody(v);
      if (b[0] <= 0.02) return;
      draw(rad + b[1] * rad, rad + b[2] * rad, px / 14);
    };
    ctx.lineWidth = Math.max(1.5, px / 90);
    const circle = (color: string) => (x: number, y: number, s: number) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.55, 0, Math.PI * 2);
      ctx.moveTo(x, y - s * 0.55);
      ctx.lineTo(x, y - s);
      ctx.moveTo(x - s * 0.55, y);
      ctx.lineTo(x - s, y);
      ctx.moveTo(x + s * 0.55, y);
      ctx.lineTo(x + s, y);
      ctx.stroke();
    };
    const xMark = (color: string) => (x: number, y: number, s: number) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.55, 0, Math.PI * 2);
      ctx.moveTo(x - s * 0.4, y - s * 0.4);
      ctx.lineTo(x + s * 0.4, y + s * 0.4);
      ctx.moveTo(x + s * 0.4, y - s * 0.4);
      ctx.lineTo(x - s * 0.4, y + s * 0.4);
      ctx.stroke();
    };
    const tri = (color: string, filled: boolean) => (x: number, y: number, s: number) => {
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 0.6);
      ctx.lineTo(x + s * 0.55, y + s * 0.4);
      ctx.lineTo(x - s * 0.55, y + s * 0.4);
      ctx.closePath();
      if (filled) ctx.fill();
      else ctx.stroke();
    };
    const dotRing = (color: string, filled: boolean) => (x: number, y: number, s: number) => {
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, s * 0.16, 0, Math.PI * 2);
      if (filled) ctx.fill();
      else ctx.stroke();
    };
    const neg = (v: V | null): V | null => (v ? [-v[0], -v[1], -v[2]] : null);
    mark(m.prograde, circle("#e8d64a"));
    mark(neg(m.prograde), xMark("#e8d64a"));
    mark(m.normal, tri("#c86ce0", true));
    mark(neg(m.normal), tri("#c86ce0", false));
    mark(m.radial, dotRing("#5fd8e8", true));
    mark(neg(m.radial), dotRing("#5fd8e8", false));
    mark(m.target, circle("#ff5fa8"));
    mark(neg(m.target), xMark("#ff5fa8"));
    mark(m.maneuver, circle("#4d8dff"));

    // Fixed nose reticle.
    ctx.strokeStyle = "#ffb000";
    ctx.lineWidth = Math.max(2, px / 70);
    ctx.beginPath();
    ctx.moveTo(rad - px * 0.18, rad);
    ctx.lineTo(rad - px * 0.06, rad);
    ctx.lineTo(rad, rad + px * 0.05);
    ctx.lineTo(rad + px * 0.06, rad);
    ctx.lineTo(rad + px * 0.18, rad);
    ctx.stroke();

    // Readouts: nose pitch and heading, roll about the nose.
    const nose: V = [R[0]!, R[3]!, R[6]!];
    const right: V = [R[1]!, R[4]!, R[7]!];
    const head: V = [-R[2]!, -R[5]!, -R[8]!];
    this.pitch = Math.asin(Math.max(-1, Math.min(1, dot(nose, up)))) * 57.29578;
    this.heading = ((Math.atan2(dot(nose, east), dot(nose, north)) * 57.29578) + 360) % 360;
    this.roll = -Math.atan2(dot(right, up), dot(head, up)) * 57.29578;
  }
}
