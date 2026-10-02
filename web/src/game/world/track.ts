// A circuit that is still being dreamed. The diffusion model produces radii r(theta) at N
// angles (start line at theta = 0, laps counter-clockwise); this class turns the known samples
// into drivable road, one centripetal Catmull-Rom segment at a time.
//
// Segment j runs from polar point j to j + 1 and needs points j - 1 .. j + 2. Segments are
// committed in driving order, starting just behind the start grid, as soon as their four
// points are known; committed road never moves again. When the last segment closes the loop
// the circuit is "locked" and laps 2 and 3 run on exactly the same road.

export const N = 128;
export const SCALE = 1.5; // model meters -> game meters (karts like wide roads)
export const HALF_WIDTH = 6.5; // m, half the road width
export const SPACING = 0.6; // m between dense centerline points
export const FIRST_SEG = N - 11; // committed driving order starts here (just behind the grid)

const TWO_PI = Math.PI * 2;

export function polarPoint(r: number, j: number): [number, number] {
  const th = (((j % N) + N) % N) * (TWO_PI / N);
  return [r * SCALE * Math.cos(th), r * SCALE * Math.sin(th)];
}

/** Centripetal Catmull-Rom between p1 and p2, sampled at roughly SPACING (excludes p2). */
export function crSegment(p0: number[], p1: number[], p2: number[], p3: number[],
                          spacing = SPACING): number[][] {
  const d = (a: number[], b: number[]) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6) ** 0.5;
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const m = Math.max(2, Math.ceil(chord / spacing));
  const out: number[][] = [];
  for (let k = 0; k < m; k++) {
    const t = t1 + ((t2 - t1) * k) / m;
    const lerp = (a: number[], b: number[], ta: number, tb: number) => {
      const u = (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };
    const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
    const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
    out.push(lerp(b1, b2, t1, t2));
  }
  return out;
}

export class Track {
  readonly radii = new Float64Array(N);
  readonly known = new Uint8Array(N);
  private committed = new Uint8Array(N);
  private nextSeg = FIRST_SEG; // next segment to commit, in driving order
  private segsDone = 0;
  // dense committed centerline in driving order (grows by appending)
  xs: number[] = [];
  ys: number[] = [];
  s: number[] = []; // cumulative arc length
  segOf: number[] = [];
  startIndex = -1; // first point of segment 0: the start/finish line
  locked = false;
  length = 0; // lap length once locked

  /** Number of committed dense points. */
  get count(): number {
    return this.xs.length;
  }

  /** Share of the lap already committed (for the "dreaming" progress bar). */
  get committedFraction(): number {
    return this.segsDone / N;
  }

  /** Mark polar samples as known; returns the dense index range newly committed. */
  addKnown(indices: Iterable<number>, radii: ArrayLike<number>): [number, number] {
    for (const j of indices) {
      const k = ((j % N) + N) % N;
      this.radii[k] = radii[k];
      this.known[k] = 1;
    }
    const from = this.count;
    while (this.segsDone < N) {
      const j = this.nextSeg;
      const need = [j - 1, j, j + 1, j + 2].map((q) => ((q % N) + N) % N);
      if (!need.every((q) => this.known[q])) break;
      const pts = need.map((q) => polarPoint(this.radii[q], q));
      const seg = crSegment(pts[0], pts[1], pts[2], pts[3]);
      if (j === 0) this.startIndex = this.count;
      for (const p of seg) {
        const n = this.xs.length;
        const ds = n ? Math.hypot(p[0] - this.xs[n - 1], p[1] - this.ys[n - 1]) : 0;
        this.xs.push(p[0]);
        this.ys.push(p[1]);
        this.s.push(n ? this.s[n - 1] + ds : 0);
        this.segOf.push(j);
      }
      this.committed[j] = 1;
      this.segsDone += 1;
      this.nextSeg = (j + 1) % N;
    }
    if (this.segsDone === N && !this.locked) {
      const n = this.count;
      this.length = this.s[n - 1] + Math.hypot(this.xs[0] - this.xs[n - 1], this.ys[0] - this.ys[n - 1]);
      this.locked = true;
    }
    return [from, this.count];
  }

  /** Wrap an index around the loop once locked; clamp to the committed range before. */
  wrap(i: number): number {
    const n = this.count;
    if (this.locked) return ((i % n) + n) % n;
    return Math.max(0, Math.min(n - 1, i));
  }

  tangent(i: number): [number, number] {
    const a = this.wrap(i - 1), b = this.wrap(i + 1);
    const dx = this.xs[b] - this.xs[a], dy = this.ys[b] - this.ys[a];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  /** Signed curvature (1/m, + = left) from three points ~4 m apart. */
  curvature(i: number): number {
    const k = 7;
    const a = this.wrap(i - k), b = this.wrap(i), c = this.wrap(i + k);
    const ax = this.xs[a], ay = this.ys[a], bx = this.xs[b], by = this.ys[b];
    const cx = this.xs[c], cy = this.ys[c];
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d = Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by) * Math.hypot(cx - ax, cy - ay);
    return d > 1e-9 ? (2 * cross) / d : 0;
  }

  /** Nearest committed point, searching a window around ``hint`` (global fallback). */
  nearest(x: number, y: number, hint: number, window = 40): number {
    const n = this.count;
    if (n === 0) return 0;
    let best = -1, bd = Infinity;
    for (let k = -window; k <= window; k++) {
      const i = this.wrap(hint + k);
      const d = (this.xs[i] - x) ** 2 + (this.ys[i] - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 30 * 30) {
      for (let i = 0; i < n; i += 2) {
        const d = (this.xs[i] - x) ** 2 + (this.ys[i] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }

  /** Signed lateral offset of (x, y) from point i (+ = left of the driving direction). */
  offset(x: number, y: number, i: number): number {
    const [tx, ty] = this.tangent(i);
    return (x - this.xs[i]) * -ty + (y - this.ys[i]) * tx;
  }

  /** Arc length of point i measured from the start line (negative on the grid). */
  fromStart(i: number): number {
    if (this.startIndex < 0) return 0;
    return this.s[i] - this.s[this.startIndex];
  }

  /** Index ``meters`` further along the committed road. */
  ahead(i: number, meters: number): number {
    return this.wrap(i + Math.round(meters / SPACING));
  }

  /** Polar angle index of the frontier: how far around the lap the road exists. */
  get frontierSeg(): number {
    return this.nextSeg;
  }

  /** Copy for re-racing a locked circuit. */
  static fromRadii(radii: ArrayLike<number>): Track {
    const t = new Track();
    const all = Array.from({ length: N }, (_, j) => j);
    t.addKnown(all, radii);
    return t;
  }
}

// ---------------------------------------------------------------------------------------------
// Drivability checks (the same rules the Python generator enforces, in game units)

export const MIN_RADIUS = 9.0 * SCALE * 0.9;
export const MIN_CLEARANCE = (2 * 4.0 + 10.0 * 0.9) * SCALE;

/** Dense closed loop for a full guess of the radii, at coarse spacing, for validation. */
export function previewLoop(radii: ArrayLike<number>, spacing = 2.0): number[][] {
  const pts = Array.from({ length: N }, (_, j) => polarPoint(radii[j], j));
  const out: number[][] = [];
  for (let j = 0; j < N; j++) {
    const seg = crSegment(pts[(j + N - 1) % N], pts[j], pts[(j + 1) % N], pts[(j + 2) % N], spacing);
    for (const p of seg) out.push([p[0], p[1], j]);
  }
  return out;
}

/** Check a full guess of the circuit, focusing on the polar arc ``arc`` (new road). */
export function checkGuess(radii: ArrayLike<number>, arc: Set<number>): { ok: boolean; reason: string } {
  const loop = previewLoop(radii);
  const n = loop.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (total < 400 * SCALE || total > 1600 * SCALE) return { ok: false, reason: "length" };
  const k = 3;
  const arcLen: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    arcLen.push(acc);
    const a = loop[i], b = loop[(i + 1) % n];
    acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  for (let i = 0; i < n; i++) {
    if (!arc.has(loop[i][2])) continue;
    const a = loop[(i - k + n) % n], b = loop[i], c = loop[(i + k) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) *
      Math.hypot(c[0] - a[0], c[1] - a[1]);
    const kappa = d > 1e-9 ? Math.abs(2 * cross) / d : 0;
    if (kappa > 1 / MIN_RADIUS) return { ok: false, reason: "too tight" };
    for (let q = 0; q < n; q += 2) {
      let gap = Math.abs(arcLen[q] - arcLen[i]);
      gap = Math.min(gap, total - gap);
      if (gap < 45 * SCALE) continue;
      if (Math.hypot(loop[q][0] - b[0], loop[q][1] - b[1]) < MIN_CLEARANCE) {
        return { ok: false, reason: "too close to itself" };
      }
    }
  }
  return { ok: true, reason: "" };
}
