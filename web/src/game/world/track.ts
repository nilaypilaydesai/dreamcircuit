// A circuit that is still being dreamed. The circuit designer produces a lap as N points along
// the road (start line at point 0, heading +x); this class turns the known points into drivable
// road, one centripetal Catmull-Rom segment at a time.
//
// Segment j runs from point j to j + 1 and needs points j - 1 .. j + 2. Segments are committed
// in driving order, starting just behind the start grid, as soon as their four points are known.
// Committed road never moves sideways again; it may only be lifted onto a bridge before anyone
// gets there. When the last segment closes the loop the circuit is "locked" and laps 2 and 3 run
// on exactly the same road.
//
// Where new road crosses road that already exists, the new stretch becomes a bridge: it climbs a
// ramp, crosses on a deck high enough to drive under, and comes back down. In every world the
// road also climbs over the land, rises and falls set along the lap as it is dreamed.

export const N = 256;
export const SCALE = 1.5; // model meters -> game meters (karts like wide roads)
export const HALF_WIDTH = 6.5; // m, half the road width
export const SPACING = 0.6; // m between dense centerline points
export const FIRST_SEG = N - 23; // committed driving order starts here (just behind the grid)

export const BRIDGE_HEIGHT = 6.0; // m: deck height over the road underneath
export const BRIDGE_RAMP = 44; // m of ramp each side of the deck
export const BRIDGE_DECK = 34; // m of level deck centred on the crossing
const CELL = 8; // m, spatial hash for crossing detection

export interface Bridge {
  center: number; // dense index of the crossing on the bridge (the later stretch)
  centerS: number; // its arc length
  lower: number; // dense index of the crossing on the road underneath
}

/** Height of a bridge's road at arc length offset ``ds`` from its crossing. */
export function bridgeLift(ds: number): number {
  const a = Math.abs(ds);
  if (a <= BRIDGE_DECK / 2) return BRIDGE_HEIGHT;
  const u = (a - BRIDGE_DECK / 2) / BRIDGE_RAMP;
  if (u >= 1) return 0;
  return BRIDGE_HEIGHT * (1 - u * u * (3 - 2 * u));
}

/** What a climb is built as: an earth embankment (or, in the neon tunnel, the tube rising), a
 * concrete foundation, a steel girder (a crane's arm), scaffolding, a crater's rim, a grassy rise
 * in a meadow, a mesa, a sand dune, a ridge of coral, a causeway of basalt, an elevated expressway
 * on concrete piers, or the ramp of a parking garage. */
export type HillStyle =
  | "earth" | "foundation" | "girder" | "scaffold" | "crater" | "meadow"
  | "mesa" | "dune" | "coral" | "basalt" | "expressway" | "garage";

/** A climb: the road rises and falls back over ``len`` m from arc length ``s0``, as a smooth hump
 * ("sine") or up a ramp to a level top and down again ("plateau"). ``side``: which side a one-sided
 * climb has its open side on (1 left, -1 right: the parking bays beside a garage's ramp). */
export interface Hill { s0: number; len: number; h: number; shape?: "sine" | "plateau"; style?: HillStyle; side?: number }

/** The length of a plateau's ramps up and down: long enough that a kart at full speed stays on
 * the road over the top of one (under normal gravity) and that no ramp is steeper than about
 * 22%, and no more than 40% of the climb. */
export const plateauRamp = (len: number, h: number): number =>
  Math.min(len * 0.4, Math.max(14, Math.sqrt(240 * h), 6.8 * h));

/** Height of a hill's road ``ds`` m past its foot: a smooth sin^2 rise and fall, or a plateau's
 * smoothstep ramps either side of its level top. */
export function hillLift(ds: number, len: number, h: number, shape: Hill["shape"] = "sine"): number {
  if (ds <= 0 || ds >= len) return 0;
  if (shape === "plateau") {
    const r = plateauRamp(len, h), u = Math.min(1, ds / r, (len - ds) / r);
    return h * u * u * (3 - 2 * u);
  }
  return h * Math.sin((Math.PI * ds) / len) ** 2;
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

const wrapN = (q: number) => ((q % N) + N) % N;

export class Track {
  /** The lap's points in game meters (x0, y0, x1, y1, ...), filled in as they become known. */
  readonly points = new Float64Array(2 * N);
  readonly known = new Uint8Array(N);
  private nextSeg = FIRST_SEG; // next segment to commit, in driving order
  private segsDone = 0;
  // dense committed centerline in driving order (grows by appending)
  xs: number[] = [];
  ys: number[] = [];
  s: number[] = []; // cumulative arc length
  elev: number[] = []; // road height (bridges), m
  segOf: number[] = [];
  bridges: Bridge[] = [];
  hills: Hill[] = [];
  /** Dense range whose height changed after it was committed (a bridge's approach ramp). */
  raised: [number, number] | null = null;
  startIndex = -1; // first point of segment 0: the start/finish line
  locked = false;
  length = 0; // lap length once locked
  private readonly grid = new Map<number, number[]>();

  get count(): number {
    return this.xs.length;
  }

  /** Share of the lap already committed (for the "dreaming" progress bar). */
  get committedFraction(): number {
    return this.segsDone / N;
  }

  point(j: number): [number, number] {
    const k = wrapN(j);
    return [this.points[2 * k], this.points[2 * k + 1]];
  }

  /** Mark points as known (game meters, indexed by point); returns the dense range committed. */
  addKnown(indices: Iterable<number>, pts: ArrayLike<number>): [number, number] {
    for (const j of indices) {
      const k = wrapN(j);
      this.points[2 * k] = pts[2 * k];
      this.points[2 * k + 1] = pts[2 * k + 1];
      this.known[k] = 1;
    }
    const from = this.count;
    this.raised = null;
    while (this.segsDone < N) {
      const j = this.nextSeg;
      const need = [j - 1, j, j + 1, j + 2].map(wrapN);
      if (!need.every((q) => this.known[q])) break;
      const p = need.map((q) => this.point(q));
      const seg = crSegment(p[0], p[1], p[2], p[3]);
      if (j === 0) this.startIndex = this.count;
      for (const q of seg) {
        const n = this.xs.length;
        const ds = n ? Math.hypot(q[0] - this.xs[n - 1], q[1] - this.ys[n - 1]) : 0;
        this.xs.push(q[0]);
        this.ys.push(q[1]);
        this.s.push(n ? this.s[n - 1] + ds : 0);
        this.elev.push(this.liftAt(this.s[n] ?? 0));
        this.segOf.push(j);
      }
      this.segsDone += 1;
      this.nextSeg = (j + 1) % N;
    }
    this.findCrossings(from);
    for (let i = from; i < this.count; i++) this.elev[i] = this.liftAt(this.s[i]);
    if (this.segsDone === N && !this.locked) {
      const n = this.count;
      this.length = this.s[n - 1] + Math.hypot(this.xs[0] - this.xs[n - 1], this.ys[0] - this.ys[n - 1]);
      this.locked = true;
    }
    return [from, this.count];
  }

  /** Height of the road at arc length ``s`` (0 except on bridges and hills). */
  liftAt(s: number): number {
    let h = 0;
    for (const b of this.bridges) h = Math.max(h, bridgeLift(s - b.centerS));
    for (const hl of this.hills) h = Math.max(h, hillLift(s - hl.s0, hl.len, hl.h, hl.shape));
    return h;
  }

  /** Height of bridges alone at dense index ``i`` (a hill is just the road climbing). */
  bridgeAt(i: number): number {
    let h = 0;
    for (const b of this.bridges) h = Math.max(h, bridgeLift(this.s[i] - b.centerS));
    return h;
  }

  /** Put the road over a hill: committed road on it rises at once, road dreamed later as it comes.
   * Returns the dense range that changed height, if any. */
  addHill(hill: Hill): [number, number] | null {
    this.hills.push(hill);
    return this.relift(hill.s0, hill.s0 + hill.len);
  }

  /** Flatten every hill that reaches into arc lengths [s0, s1) (a bridge needs the room). */
  removeHills(s0: number, s1: number): [number, number] | null {
    const gone = this.hills.filter((h) => h.s0 < s1 && h.s0 + h.len > s0);
    if (!gone.length) return null;
    this.hills = this.hills.filter((h) => !gone.includes(h));
    return this.relift(Math.min(...gone.map((g) => g.s0)), Math.max(...gone.map((g) => g.s0 + g.len)));
  }

  private relift(s0: number, s1: number): [number, number] | null {
    let a = -1, b = -1;
    for (let i = 0; i < this.count; i++) {
      if (this.s[i] < s0 || this.s[i] > s1) continue;
      this.elev[i] = this.liftAt(this.s[i]);
      if (a < 0) a = i;
      b = i + 1;
    }
    return a < 0 ? null : [a, b];
  }

  private cellKey(x: number, y: number): number {
    return (Math.floor(x / CELL) + 1024) * 4096 + (Math.floor(y / CELL) + 1024);
  }

  /** New road from dense index ``from`` that crosses older road becomes a bridge. */
  private findCrossings(from: number): void {
    const n = this.count;
    const minGap = Math.round(90 / SPACING); // a crossing is between stretches far apart in the lap
    for (let i = Math.max(1, from); i < n; i++) {
      const ax = this.xs[i - 1], ay = this.ys[i - 1], bx = this.xs[i], by = this.ys[i];
      const cx = Math.floor((ax + bx) / 2 / CELL), cy = Math.floor((ay + by) / 2 / CELL);
      let hit = -1;
      for (let gx = -1; gx <= 1 && hit < 0; gx++) {
        for (let gy = -1; gy <= 1 && hit < 0; gy++) {
          const list = this.grid.get((cx + gx + 1024) * 4096 + (cy + gy + 1024));
          if (!list) continue;
          for (const j of list) {
            if (j <= 0 || i - j < minGap) continue;
            if (segmentsCross(ax, ay, bx, by, this.xs[j - 1], this.ys[j - 1], this.xs[j], this.ys[j])) {
              hit = j;
              break;
            }
          }
        }
      }
      if (hit >= 0 && !this.bridges.some((b) => Math.abs(b.center - i) < minGap)) this.addBridge(i, hit);
      const k = this.cellKey((ax + bx) / 2, (ay + by) / 2);
      const list = this.grid.get(k);
      if (list) list.push(i);
      else this.grid.set(k, [i]);
    }
  }

  private addBridge(center: number, lower: number): void {
    const b: Bridge = { center, centerS: this.s[center], lower };
    this.bridges.push(b);
    // lift the approach ramp, which is already road (nobody has reached it yet)
    const back = Math.round((BRIDGE_DECK / 2 + BRIDGE_RAMP) / SPACING);
    const a = Math.max(0, center - back);
    for (let i = a; i < this.count; i++) this.elev[i] = this.liftAt(this.s[i]);
    this.raised = [a, center];
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

  /** Nearest committed point, searching a window around ``hint`` along the kart's own stretch
   * (so a kart on a bridge never snaps to the road underneath); global fallback if lost. */
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

  /** How far (x, y) is along the road past point i, in m (negative: before it). */
  along(x: number, y: number, i: number): number {
    const [tx, ty] = this.tangent(i);
    return (x - this.xs[i]) * tx + (y - this.ys[i]) * ty;
  }

  /** Height of the road at (x, y), near dense index i: between the road points either side of
   * it. (Read at the nearest point alone, the road under a kart climbing a bridge's ramp rose in
   * steps of a point, 0.6 m apart, one or two of them a frame: the kart shuddered up it.) */
  heightAt(x: number, y: number, i: number): number {
    const d = this.along(x, y, i);
    const j = this.wrap(d >= 0 ? i + 1 : i - 1);
    const a = this.elev[i] ?? 0, b = this.elev[j] ?? a;
    return j === i ? a : a + (b - a) * Math.min(1, Math.abs(d) / SPACING);
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

  /** m along the road from point i forward to point j (round the lap, once it is locked). */
  between(i: number, j: number): number {
    const d = this.s[j] - this.s[i];
    return d < 0 && this.locked ? d + this.length : d;
  }

  /** The point ``meters`` along the road from point i, and how far on from it towards the next
   * point (0..1). By arc length: the points are a little under SPACING apart (a different little
   * on each stretch of the lap), so counting them off as SPACING each falls short, by up to a
   * meter in ten. */
  stepAlong(i: number, meters: number): { i: number; w: number } {
    let k = i, done = 0;
    for (let guard = 0; guard < this.count; guard++) {
      const j = this.wrap(k + 1);
      if (j === k) break; // (the end of the road known so far)
      const gap = this.between(k, j);
      if (done + gap > meters) return { i: k, w: gap > 0 ? (meters - done) / gap : 0 };
      done += gap;
      k = j;
    }
    return { i: k, w: 0 };
  }

  /** The first point at arc length ``s`` or past it, searching back from point i. */
  indexBack(i: number, s: number): number {
    while (i > 0 && this.s[i - 1] >= s) i--;
    return i;
  }

  /** Point index of the frontier: how far around the lap the road exists. */
  get frontierSeg(): number {
    return this.nextSeg;
  }

  /** A locked circuit from its points (game meters), for re-racing it. */
  static fromPoints(pts: ArrayLike<number>): Track {
    const t = new Track();
    t.addKnown(Array.from({ length: N }, (_, j) => j), pts);
    return t;
  }
}

/** Proper intersection of segments ab and cd. */
export function segmentsCross(ax: number, ay: number, bx: number, by: number,
                              cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay), d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy), d4 = o(ax, ay, bx, by, dx, dy);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// ---------------------------------------------------------------------------------------------
// Drivability checks: the architect's rules (src/dreamcircuit/trackgen/architect.py), in game units

export const MIN_RADIUS = 9.0 * 0.92 * SCALE;
export const MIN_CLEARANCE = (2 * 4.0 + 10.0 * 0.9) * SCALE;
const LOOP_MAX = 920 * SCALE, LAP_MAX = 980 * SCALE, LAP_MIN = 520 * SCALE;
export const MAX_FROM_START = 235 * SCALE;
const CROSS_MIN_ANGLE = (50 * Math.PI) / 180;
const BRIDGE_HALF = 34 * SCALE, UNDER_HALF = 16 * SCALE, CROSS_EXEMPT = 34 * SCALE;
const PREVIEW = 2.0; // m between preview points

export type Layout = "any" | "loop" | "figure8";
const EXPECT: Record<Layout, number | null> = { any: null, loop: 0, figure8: 1 };

/** Dense closed loop through a full guess of the points (game meters), for validation. Each
 * entry is [x, y, point index]. */
export function previewLoop(pts: ArrayLike<number>, spacing = PREVIEW): number[][] {
  const p = (j: number) => [pts[2 * wrapN(j)], pts[2 * wrapN(j) + 1]];
  const out: number[][] = [];
  for (let j = 0; j < N; j++) {
    for (const q of crSegment(p(j - 1), p(j), p(j + 1), p(j + 2), spacing)) out.push([q[0], q[1], j]);
  }
  return out;
}

export interface LapCrossing {
  i: number; // preview index on the earlier stretch
  j: number; // preview index on the later stretch (the bridge)
  angle: number;
}

/** Self-intersections of a preview loop. */
export function loopCrossings(loop: number[][]): LapCrossing[] {
  const n = loop.length;
  const out: LapCrossing[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = loop[j], d = loop[(j + 1) % n];
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.min(a[0], b[0]) > Math.max(c[0], d[0])) continue;
      if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.min(a[1], b[1]) > Math.max(c[1], d[1])) continue;
      if (!segmentsCross(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) continue;
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - c[0], vy = d[1] - c[1];
      const cos = Math.abs(ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-12);
      out.push({ i, j, angle: Math.acos(Math.min(1, cos)) });
    }
  }
  return out;
}

/** Unsigned curvature (1/m) of a preview loop at ``i``, from the points ``k`` either side. */
export function loopCurvature(loop: number[][], i: number, k: number): number {
  const n = loop.length;
  const a = loop[(i - k + n) % n], b = loop[i], c = loop[(i + k) % n];
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) *
    Math.hypot(c[0] - a[0], c[1] - a[1]);
  return d > 1e-9 ? Math.abs(2 * cross) / d : 0;
}

/** Check a full guess of the circuit (game meters), focusing on the points in ``arc`` (new road).
 * ``first`` adds the start-straight rule (the arc with the grid). */
export function checkLap(pts: ArrayLike<number>, arc: Set<number>, layout: Layout = "any",
                         first = false): { ok: boolean; reason: string; crossings: LapCrossing[] } {
  const loop = previewLoop(pts);
  const n = loop.length;
  const arcLen: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    arcLen.push(total);
    const a = loop[i], b = loop[(i + 1) % n];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const expect = EXPECT[layout];
  const fail = (reason: string, crossings: LapCrossing[] = []) => ({ ok: false, reason, crossings });
  if (total < LAP_MIN || total > (expect ? LAP_MAX : LOOP_MAX)) return fail("length");
  const x0 = pts[0], y0 = pts[1];
  for (const p of loop) if (Math.hypot(p[0] - x0, p[1] - y0) > MAX_FROM_START) return fail("too big");
  const crossings = loopCrossings(loop);
  if ((expect !== null && crossings.length !== expect) || crossings.length > 1) return fail("crossings", crossings);
  const exempt = new Uint8Array(n);
  const k = 3; // curvature from points 6 m apart
  for (const c of crossings) {
    if (c.angle < CROSS_MIN_ANGLE) return fail("shallow crossing", crossings);
    for (const [centre, half, lim] of [[c.j, BRIDGE_HALF, 1 / (90 * SCALE)], [c.i, UNDER_HALF, 1 / (50 * SCALE)]]) {
      const w = Math.round(half / PREVIEW);
      for (let q = -w; q <= w; q++) {
        if (loopCurvature(loop, (centre + q + n) % n, k) > lim * 1.3) return fail("bent crossing", crossings);
      }
    }
    for (const centre of [c.i, c.j]) {
      const w = Math.round(CROSS_EXEMPT / PREVIEW);
      for (let q = -w; q <= w; q++) exempt[(centre + q + n) % n] = 1;
      let d = Math.abs(arcLen[centre]);
      d = Math.min(d, total - d);
      if (d < 80 * SCALE) return fail("crossing at the start", crossings);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!arc.has(loop[i][2])) continue;
    if (loopCurvature(loop, i, k) > 1 / MIN_RADIUS) return fail("too tight", crossings);
    const b = loop[i];
    for (let q = 0; q < n; q += 2) {
      let gap = Math.abs(arcLen[q] - arcLen[i]);
      gap = Math.min(gap, total - gap);
      if (gap < 45 * SCALE || (exempt[i] && exempt[q])) continue;
      if (Math.hypot(loop[q][0] - b[0], loop[q][1] - b[1]) < MIN_CLEARANCE) return fail("too close to itself", crossings);
    }
  }
  if (first) {
    const w0 = Math.round((48 * SCALE) / PREVIEW), w1 = Math.round((24 * SCALE) / PREVIEW);
    for (let q = -w0; q < w1; q++) {
      if (loopCurvature(loop, (q + n) % n, k) > 1 / (120 * SCALE) * 1.5) return fail("start not on a straight", crossings);
    }
  }
  return { ok: true, reason: "", crossings };
}
