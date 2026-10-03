// The 3D parts of a circuit, built from flat polygons every frame for whatever is in view:
// bridges (deck with kerbed edges and center dashes, guard rails, girder sides, underside),
// jump ramps (a striped wedge with kerb-coloured sides), boost pads (chevrons that pulse forward),
// climbs (the road up on an earth embankment, a rocky mountainside, a ledge on a cliff, a concrete
// foundation, a steel girder, a scaffold, a crater's rim, a grassy rise, a neon skyway or roller,
// a mesa, a dune, a ridge of coral or a causeway of basalt) and tunnels (through a rock mound, or
// through the steel frame of a building going up).

import { hex, mix, shade } from "../core/gfx";
import { PAD_HALF, PAD_LEN, RAMP_HEIGHT, RAMP_LEN, TUNNEL_H, type Features, type Tunnel } from "../race/features";
import type { Theme } from "../themes";
import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import { type P3, type Painter, face, toCamera } from "./poly";

const DECK = 0.9; // m deck thickness
const RAIL = 0.9; // m rail height
const CONCRETE = hex("#a9a598");
const GIRDER = hex("#6d6a62");
const UNDER = hex("#3c3a36");
const STRIPE = [hex("#ffd23f"), hex("#262433")];

function edgePoint(track: Track, i: number, off: number, z: number): P3 {
  const [tx, ty] = track.tangent(i);
  return [track.xs[i] - ty * off, track.ys[i] + tx * off, z];
}

function near(p: Painter, track: Track, i: number, margin = 40): boolean {
  const dx = track.xs[i] - p.cam.x, dy = track.ys[i] - p.cam.y;
  return dx * dx + dy * dy < (p.cam.far + margin) ** 2;
}

export function bridgeFaces(p: Painter, track: Track, theme: Theme): void {
  const step = 3;
  const hw = HALF_WIDTH;
  for (const b of track.bridges) {
    if (!near(p, track, b.center, 140)) continue;
    let a = b.center, e = b.center;
    while (a > 0 && track.elev[a - 1] > 0.02) a--;
    while (e < track.count - 1 && track.elev[e + 1] > 0.02) e++;
    for (let i = a; i < e; i += step) {
      const j = Math.min(i + step, e);
      if (!near(p, track, i)) continue;
      const hi = track.elev[i], hj = track.elev[j];
      const s = track.s[i];
      const [tx, ty] = track.tangent(i);
      const up: P3 = [0, 0, 1];
      const left: P3 = [-ty, tx, 0], right: P3 = [ty, -tx, 0];
      const P = (k: number, off: number, z: number) => edgePoint(track, k, off, z);
      // deck top: kerbed edges, asphalt, a dashed center line
      const kerb = Math.floor(s / 3) & 1 ? theme.kerb[0] : theme.kerb[1];
      const road = shade(theme.road, 1.04);
      face(p, [P(i, -hw, hi), P(j, -hw, hj), P(j, -hw + 0.8, hj), P(i, -hw + 0.8, hi)], kerb, up, -0.2, 1, true);
      face(p, [P(i, hw - 0.8, hi), P(j, hw - 0.8, hj), P(j, hw, hj), P(i, hw, hi)], kerb, up, -0.2, 1, true);
      face(p, [P(i, -hw + 0.8, hi), P(j, -hw + 0.8, hj), P(j, hw - 0.8, hj), P(i, hw - 0.8, hi)], road, up, -0.2, 1, true);
      if (Math.floor(s / 4) % 2 === 0) {
        face(p, [P(i, -0.18, hi + 0.01), P(j, -0.18, hj + 0.01), P(j, 0.18, hj + 0.01), P(i, 0.18, hi + 0.01)],
             theme.edge, up, -0.25, 1, true);
      }
      if (Math.max(hi, hj) < 0.15) continue;
      // girder sides and underside
      face(p, [P(i, hw, hi), P(j, hw, hj), P(j, hw, hj - DECK), P(i, hw, hi - DECK)], GIRDER, left, 0.1);
      face(p, [P(j, -hw, hj), P(i, -hw, hi), P(i, -hw, hi - DECK), P(j, -hw, hj - DECK)], GIRDER, right, 0.1);
      face(p, [P(i, -hw, hi - DECK), P(i, hw, hi - DECK), P(j, hw, hj - DECK), P(j, -hw, hj - DECK)], UNDER, [0, 0, -1], 0.2);
      // guard rails (two-sided), with posts every few meters
      if (Math.max(hi, hj) > 0.6) {
        for (const off of [-hw, hw]) {
          face(p, [P(i, off, hi + RAIL * 0.55), P(j, off, hj + RAIL * 0.55), P(j, off, hj + RAIL), P(i, off, hi + RAIL)],
               CONCRETE, null, -0.15);
          if (Math.floor(s / 2.4) % 3 === 0) {
            face(p, [P(i, off, hi), P(i + 1, off, hi), P(i + 1, off, hi + RAIL), P(i, off, hi + RAIL)],
                 shade(CONCRETE, 0.8), null, -0.15);
          }
        }
      }
    }
  }
}

/** First dense index whose arc length is at least ``s``. */
function indexAt(track: Track, s: number): number {
  let lo = 0, hi = track.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track.s[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const STONE = hex("#8f8a7c");
const UP: P3 = [0, 0, 1], DOWN: P3 = [0, 0, -1];
const ROCK = hex("#6f6b66"), ROCK_DARK = hex("#55514c"), CEILING = hex("#2f2d2b"), LAMP = hex("#ffd98a");
const SNOW = hex("#eef3fb");
const SLAB = hex("#b5b1a5"), SLAB_SIDE = hex("#9b978b"), SLAB_UNDER = hex("#77736a"), REBAR = hex("#9a5530");
const STEEL = hex("#68707c"), CRANE = hex("#f2b21b"), CRANE_DARK = hex("#b98310");
const PLANKS = [hex("#b9844c"), hex("#a5733f")], PLANK_GAP = hex("#4a3420"), TOE = hex("#ff8a1f");
const PIPE = hex("#c9cdd4"), PIPE_DARK = hex("#9aa0a9"), RAIL_STEEL = hex("#c4c8cf");

/** A steady random number in [0, 1) for dense index ``k`` (the same every frame). */
function jag(k: number, salt: number): number {
  let h = Math.imul(k ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (Math.imul(h, 0xc2b2ae35) >>> 0) / 4294967296;
}

/** One piece of a climb: its road from dense index i to j, at heights hi and hj. */
interface Piece {
  p: Painter;
  track: Track;
  theme: Theme;
  i: number;
  j: number;
  hi: number;
  hj: number;
  s: number; // m of arc length at i
  n: number; // which piece of the climb it is, counting from its foot
  len: number; // m from i to j
  tx: number; // the road's direction
  ty: number;
}

/** A point ``u`` of the way along a piece, ``off`` m left of the centerline, ``z`` m up. */
function at(c: Piece, u: number, off: number, z: number): P3 {
  const a = edgePoint(c.track, c.i, off, z), b = edgePoint(c.track, c.j, off, z);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, z];
}

const zAt = (c: Piece, u: number): number => c.hi + (c.hj - c.hi) * u;

/** A strip of the deck karts drive on, ``off0`` to ``off1`` m left of the centerline, ``u0`` to
 * ``u1`` of the way along the piece, ``lift`` m over the road. */
function deck(c: Piece, off0: number, off1: number, color: number, u0 = 0, u1 = 1, lift = 0, bias = -0.2): void {
  const z0 = zAt(c, u0) + lift, z1 = zAt(c, u1) + lift;
  face(c.p, [at(c, u0, off0, z0), at(c, u1, off0, z1), at(c, u1, off1, z1), at(c, u0, off1, z0)], color, UP, bias, 1, true);
}

/** A bar in the upright plane ``off`` m left of the centerline (a pipe, a strut, a rail): from
 * (u0, z0) to (u1, z1), u the way along the piece, ``w`` m thick, seen from both sides. */
function bar(c: Piece, off: number, u0: number, z0: number, u1: number, z1: number, w: number, color: number, bias = -0.1): void {
  const da = (u1 - u0) * c.len, dz = z1 - z0, l = Math.hypot(da, dz) || 1;
  const pu = ((-dz / l) * w) / 2 / c.len, pz = ((da / l) * w) / 2;
  face(c.p, [at(c, u0 - pu, off, z0 - pz), at(c, u1 - pu, off, z1 - pz), at(c, u1 + pu, off, z1 + pz), at(c, u0 + pu, off, z0 + pz)],
       color, null, bias);
}

/** An upright band along the piece ``off`` m left of the centerline, from ``lo`` to ``top`` m
 * over the road (a wall, a barricade, a toe board), seen from both sides. */
function band(c: Piece, off: number, lo: number, top: number, color: number, bias = -0.15): void {
  const P = (k: number, z: number) => edgePoint(c.track, k, off, z);
  face(c.p, [P(c.i, c.hi + lo), P(c.j, c.hj + lo), P(c.j, c.hj + top), P(c.i, c.hi + top)], color, null, bias);
}

/** A face down one side of a climb (``side`` 1: the left, -1: the right), from ``o0`` m out at
 * heights ``z0`` (at i and at j) to ``o1`` m out at heights ``z1``, facing out (and up, by ``nz``). */
function flank(c: Piece, side: number, o0: [number, number], z0: [number, number], o1: [number, number],
               z1: [number, number], color: number, bias = 0.1, nz = 1): void {
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, side * off, z);
  face(c.p, [P(c.i, o0[0], z0[0]), P(c.j, o0[1], z0[1]), P(c.j, o1[1], z1[1]), P(c.i, o1[0], z1[0])], color,
       [-side * c.ty, side * c.tx, nz], bias);
}

/** Asphalt with kerbed edges and a dashed middle line. */
function asphalt(c: Piece): void {
  const hw = HALF_WIDTH, kerb = Math.floor(c.s / 3) & 1 ? c.theme.kerb[0] : c.theme.kerb[1];
  deck(c, -hw, -hw + 0.8, kerb);
  deck(c, hw - 0.8, hw, kerb);
  deck(c, -hw + 0.8, hw - 0.8, shade(c.theme.road, 1.04));
  if (Math.floor(c.s / 4) % 2 === 0) deck(c, -0.18, 0.18, c.theme.edge, 0, 1, 0.01, -0.25);
}

function walls(c: Piece, color: number): void {
  if (Math.max(c.hi, c.hj) > 0.6) for (const off of [-HALF_WIDTH, HALF_WIDTH]) band(c, off, 0, 0.55, color);
}

/** An earth embankment falling away to the ground on both sides, low stone walls on top. */
function earthClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj } = c;
  asphalt(c);
  const fi = hi * 1.2 + 0.4, fj = hj * 1.2 + 0.4;
  flank(c, 1, [hw, hw], [hi, hj], [hw + fi, hw + fj], [0, 0], shade(c.theme.shoulder, 0.9));
  flank(c, -1, [hw, hw], [hi, hj], [hw + fi, hw + fj], [0, 0], shade(c.theme.shoulder, 0.7));
  walls(c, c.theme.wall ?? STONE);
}

/** Over a shoulder of the mountain: snow along the top, then a broad, ragged slope of rock in two
 * bands down to the valley floor. */
function rockClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, i, j } = c, snow = c.theme.snow || SNOW;
  asphalt(c);
  for (const side of [1, -1]) {
    const fi = (hi * 1.6 + 1) * (0.8 + 0.4 * jag(i, side + 2)), fj = (hj * 1.6 + 1) * (0.8 + 0.4 * jag(j, side + 2));
    const lit = side > 0 ? 1 : 0.8;
    const ki = 0.6 + 0.12 * jag(i, side + 5), kj = 0.6 + 0.12 * jag(j, side + 5); // where the darker band starts
    // each piece a facet of its own, catching the light a little differently, a few dusted with snow
    const facet = lit * (0.86 + 0.26 * jag(c.n, side + 13)), dusted = jag(c.n, side + 17) > 0.8;
    flank(c, side, [hw, hw], [hi, hj], [hw + 0.22 * fi, hw + 0.22 * fj], [hi * 0.78, hj * 0.78], shade(snow, 0.95 * lit));
    flank(c, side, [hw + 0.22 * fi, hw + 0.22 * fj], [hi * 0.78, hj * 0.78], [hw + ki * fi, hw + kj * fj],
          [hi * (1 - ki), hj * (1 - kj)], dusted ? shade(snow, 0.85 * lit) : shade(ROCK, facet));
    flank(c, side, [hw + ki * fi, hw + kj * fj], [hi * (1 - ki), hj * (1 - kj)], [hw + fi, hw + fj], [0, 0],
          shade(ROCK_DARK, facet * (0.9 + 0.2 * jag(c.n, side + 19))));
  }
  walls(c, c.theme.wall ?? STONE);
}

/** A ledge cut into a cliff: a rock face rising over the road on one side (``side``), snow along
 * its top, and on the other a sheer drop to the valley floor behind a guard rail. */
function cliffClimb(c: Piece, side: number): void {
  const hw = HALF_WIDTH, { hi, hj, i, j, tx, ty } = c, snow = c.theme.snow || SNOW;
  asphalt(c);
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, off, z);
  const ti = hi * (1.55 + 0.5 * jag(i, 7)), tj = hj * (1.55 + 0.5 * jag(j, 7)), back = hw + 1.4;
  const rock = Math.floor(c.s / 5.4) & 1 ? ROCK : shade(ROCK, 0.9);
  // the rock face, leaning back from the road, and the snow along its top
  const mid = (z: number, t: number) => z + (t - z) * 0.84;
  face(c.p, [P(i, side * hw, hi), P(j, side * hw, hj), P(j, side * (hw + 1.18), mid(hj, tj)), P(i, side * (hw + 1.18), mid(hi, ti))],
       rock, [side * ty, -side * tx, 0.3], -0.05);
  face(c.p, [P(i, side * (hw + 1.18), mid(hi, ti)), P(j, side * (hw + 1.18), mid(hj, tj)), P(j, side * back, tj), P(i, side * back, ti)],
       shade(snow, 0.92), [side * ty, -side * tx, 0.3], -0.05);
  // the mountain behind it, down to the valley floor
  flank(c, side, [back, back], [ti, tj], [back + 2.5, back + 2.5], [ti * 0.9, tj * 0.9], snow, 0.1);
  flank(c, side, [back + 2.5, back + 2.5], [ti * 0.9, tj * 0.9], [back + 2 + ti, back + 2 + tj], [0, 0],
        shade(ROCK_DARK, 0.86 + 0.26 * jag(c.n, 23)), 0.1);
  // the drop: rock straight down from the road's edge, and the rail along it
  const out = -side;
  flank(c, out, [hw, hw], [hi, hj], [hw + 0.8 + jag(i, 3), hw + 0.8 + jag(j, 3)], [0, 0], shade(ROCK_DARK, 0.92), 0.1, 0.15);
  if (Math.max(hi, hj) > 0.6) {
    band(c, out * hw, 0.5, 0.78, RAIL_STEEL);
    if (c.n % 2 === 0) bar(c, out * hw, 0, hi, 0, hi + 0.82, 0.14, shade(RAIL_STEEL, 0.7), -0.15);
  }
}

/** A building's foundation: a concrete slab poured in bays, with straight concrete walls down to
 * the ground, an orange and white barricade along each edge and rebar sticking up beside it. */
function foundationClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, n } = c, orange = c.theme.wall ?? TOE;
  deck(c, -hw, hw, Math.floor(c.s / 6) & 1 ? SLAB : shade(SLAB, 0.94));
  deck(c, -hw, -hw + 0.5, SLAB_SIDE, 0, 1, 0.01, -0.22);
  deck(c, hw - 0.5, hw, SLAB_SIDE, 0, 1, 0.01, -0.22);
  for (const side of [1, -1]) {
    flank(c, side, [hw, hw], [hi, hj], [hw, hw], [0, 0], shade(SLAB_SIDE, side > 0 ? 1 : 0.84), 0.1, 0);
    if (Math.max(hi, hj) <= 0.6) continue;
    band(c, side * hw, 0, 0.8, (n + (side > 0 ? 0 : 1)) & 1 ? orange : hex("#f4f1ea"));
    if (n % 3 === 1) {
      for (const u of [0.2, 0.55]) bar(c, side * (hw + 0.12), u, zAt(c, u) - 0.1, u, zAt(c, u) + 1.45, 0.09, REBAR, 0.05);
    }
  }
}

/** A crane's girder: a steel deck plate edged in yellow on a truss of yellow steel, a column down
 * to the ground every so often and yellow rails along both sides. */
function girderClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, n } = c;
  deck(c, -hw, hw, n & 1 ? STEEL : shade(STEEL, 0.92));
  deck(c, -hw, -hw + 0.45, CRANE, 0, 1, 0.01, -0.22);
  deck(c, hw - 0.45, hw, CRANE, 0, 1, 0.01, -0.22);
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, off, z);
  face(c.p, [P(c.i, -hw, hi - 0.25), P(c.i, hw, hi - 0.25), P(c.j, hw, hj - 0.25), P(c.j, -hw, hj - 0.25)], UNDER, DOWN, 0.2);
  for (const side of [1, -1]) {
    const off = side * hw;
    band(c, off, -0.25, 0, CRANE_DARK, -0.1);
    if (Math.min(hi, hj) > 0.9) {
      // the truss: a bottom chord, an upright and a diagonal in every piece
      const bi = hi - Math.min(1.6, hi - 0.3), bj = hj - Math.min(1.6, hj - 0.3);
      bar(c, off, 0, bi, 1, bj, 0.22, CRANE, -0.05);
      bar(c, off, 0, hi - 0.25, 0, bi, 0.16, CRANE, -0.05);
      if (n & 1) bar(c, off, 0, hi - 0.25, 1, bj, 0.16, CRANE, -0.05);
      else bar(c, off, 0, bi, 1, hj - 0.25, 0.16, CRANE, -0.05);
      if (n % 8 === 4 && bi > 1) bar(c, side * (hw - 0.5), 0.5, 0, 0.5, (bi + bj) / 2, 0.55, CRANE_DARK, 0.05);
    }
    if (Math.max(hi, hj) > 0.6) {
      bar(c, off, 0, hi + 1.0, 1, hj + 1.0, 0.12, CRANE, -0.15);
      bar(c, off, 0, hi + 0.5, 1, hj + 0.5, 0.1, CRANE, -0.15);
      if (n % 2 === 0) bar(c, off, 0, hi, 0, hi + 1.06, 0.12, CRANE_DARK, -0.15);
    }
  }
}

/** Scaffolding: a deck of planks on a frame of steel pipes (an upright every few metres, a pipe
 * along every two metres up, braces zigzagging along the bottom), toe boards and rails on top. */
function scaffoldClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, n } = c;
  deck(c, -hw, hw, PLANKS[n & 1]);
  deck(c, -hw, hw, PLANK_GAP, 0, 0.08, 0.005, -0.21);
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, off, z);
  face(c.p, [P(c.i, -hw, hi - 0.15), P(c.i, hw, hi - 0.15), P(c.j, hw, hj - 0.15), P(c.j, -hw, hj - 0.15)],
       shade(PLANKS[1], 0.55), DOWN, 0.2);
  for (const side of [1, -1]) {
    const off = side * hw;
    if (Math.max(hi, hj) > 0.4) band(c, off, 0, 0.25, TOE, -0.12);
    if (Math.max(hi, hj) > 0.6) {
      bar(c, off, 0, hi + 0.55, 1, hj + 0.55, 0.1, PIPE, -0.15);
      bar(c, off, 0, hi + 1.05, 1, hj + 1.05, 0.1, PIPE, -0.15);
    }
    if (n % 2 === 0) bar(c, off, 0, 0, 0, hi + 1.1, 0.14, PIPE, -0.05);
    for (let z = 2; z < Math.min(hi, hj) - 0.3; z += 2) bar(c, off, 0, z, 1, z, 0.1, PIPE_DARK, 0);
    const top = Math.min(2, Math.min(hi, hj) - 0.2);
    if (top > 0.6) {
      if (n & 1) bar(c, off, 0, top, 1, 0.1, 0.09, PIPE_DARK, 0);
      else bar(c, off, 0, 0.1, 1, top, 0.09, PIPE_DARK, 0);
    }
  }
}

/** Over a crater's rim: banks of thrown-out dust, brightest along the top, and marker posts with
 * reflectors in place of walls. */
function craterClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, i, j } = c, dust = c.theme.ground[0];
  asphalt(c);
  for (const side of [1, -1]) {
    const fi = hi * 2.3 + 1.5 + 1.5 * jag(i, side + 9), fj = hj * 2.3 + 1.5 + 1.5 * jag(j, side + 9);
    const lit = side > 0 ? 1.08 : 0.84;
    flank(c, side, [hw, hw], [hi, hj], [hw + fi * 0.3, hw + fj * 0.3], [hi * 0.8, hj * 0.8], shade(dust, 1.14 * lit));
    flank(c, side, [hw + fi * 0.3, hw + fj * 0.3], [hi * 0.8, hj * 0.8], [hw + fi, hw + fj], [0, 0], shade(dust, 0.94 * lit));
    if (c.n % 3 === 0 && Math.max(hi, hj) > 0.6) {
      bar(c, side * (hw + 0.25), 0, hi, 0, hi + 0.75, 0.16, c.theme.barrier, -0.12);
      bar(c, side * (hw + 0.25), 0, hi + 0.56, 0, hi + 0.76, 0.17, c.theme.edge, -0.13);
    }
  }
}

/** A point on the face down one side of a climb whose foot is ``fi`` and ``fj`` m out (at i and
 * at j): ``u`` of the way along the piece, ``t`` of the way from the road's edge to the foot. */
function onFlank(c: Piece, side: number, fi: number, fj: number, u: number, t: number): P3 {
  const f = fi + (fj - fi) * u;
  return at(c, u, side * (HALF_WIDTH + t * f), zAt(c, u) * (1 - t));
}

/** A patch of that face (a line ruled on it, a ripple), drawn over it. */
function flankPatch(c: Piece, side: number, fi: number, fj: number, u0: number, u1: number, t0: number, t1: number,
                    color: number, bias = 0.09): void {
  face(c.p, [onFlank(c, side, fi, fj, u0, t0), onFlank(c, side, fi, fj, u1, t0), onFlank(c, side, fi, fj, u1, t1),
             onFlank(c, side, fi, fj, u0, t1)], color, [-side * c.ty, side * c.tx, 1], bias);
}

const FENCE = hex("#8a5a32");

/** A rise in the meadows: grass banks down both sides (each piece a facet of its own, lighter
 * toward the top) and a wooden fence along the top. */
function meadowClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, i, j, theme } = c;
  asphalt(c);
  for (const side of [1, -1]) {
    const fi = hi * 2 + 1.5 + jag(i, side + 31), fj = hj * 2 + 1.5 + jag(j, side + 31);
    const lit = (side > 0 ? 1.04 : 0.84) * (0.93 + 0.12 * jag(c.n, side + 33));
    flank(c, side, [hw, hw], [hi, hj], [hw + 0.4 * fi, hw + 0.4 * fj], [hi * 0.7, hj * 0.7], shade(theme.ground[0], 1.1 * lit));
    flank(c, side, [hw + 0.4 * fi, hw + 0.4 * fj], [hi * 0.7, hj * 0.7], [hw + fi, hw + fj], [0, 0], shade(theme.ground[1], 0.93 * lit));
    if (Math.max(hi, hj) > 0.6) {
      band(c, side * hw, 0.56, 0.7, FENCE);
      if (c.n % 2 === 0) bar(c, side * hw, 0, hi, 0, hi + 0.88, 0.14, shade(FENCE, 0.8), -0.15);
    }
  }
}

const SKYWAY_UNDER = hex("#1a0b30"), SKYWAY_SIDE = hex("#2a1450"), PYLON = hex("#2c1d4a");

/** A skyway on pylons over the grid: a dark deck edged with glowing lines, neon tubes for rails, a
 * strip of light along its edge, and every so often a pylon with a ring of light around it. */
function skywayClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, n, theme } = c;
  deck(c, -hw, hw, shade(theme.road, 1.05));
  deck(c, -hw + 0.3, -hw + 0.6, theme.edge, 0, 1, 0.01, -0.22);
  deck(c, hw - 0.6, hw - 0.3, theme.edge, 0, 1, 0.01, -0.22);
  if (n % 3 === 0) deck(c, -0.15, 0.15, theme.kerb[0], 0, 0.55, 0.01, -0.25);
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, off, z);
  face(c.p, [P(c.i, -hw, hi - 0.6), P(c.i, hw, hi - 0.6), P(c.j, hw, hj - 0.6), P(c.j, -hw, hj - 0.6)], SKYWAY_UNDER, DOWN, 0.2);
  for (const side of [1, -1]) {
    const off = side * hw;
    band(c, off, -0.6, 0, SKYWAY_SIDE, -0.1);
    band(c, off, -0.42, -0.3, theme.kerb[0], -0.11);
    if (Math.max(hi, hj) > 0.6) {
      band(c, off, 0.45, 0.6, theme.edge);
      band(c, off, 0.95, 1.08, theme.kerb[0]);
      if (n % 3 === 0) bar(c, off, 0, hi, 0, hi + 1.08, 0.1, PYLON, -0.14);
    }
  }
  const z = (hi + hj) / 2 - 0.6;
  if (n % 9 === 4 && z > 1.2) {
    // a pylon: a cross of two slabs, seen from any side, ringed with light half way up
    face(c.p, [at(c, 0.5, -0.7, 0), at(c, 0.5, 0.7, 0), at(c, 0.5, 0.7, z), at(c, 0.5, -0.7, z)], PYLON, null, 0.05);
    bar(c, 0, 0.5, 0, 0.5, z, 1.4, shade(PYLON, 0.85), 0.05);
    face(c.p, [at(c, 0.5, -0.72, z * 0.5), at(c, 0.5, 0.72, z * 0.5), at(c, 0.5, 0.72, z * 0.5 + 0.22),
               at(c, 0.5, -0.72, z * 0.5 + 0.22)], theme.edge, null, 0.04);
    bar(c, 0, 0.5, z * 0.5 + 0.11, 0.5, z * 0.5 + 0.11, 1.44, theme.edge, 0.04);
  }
}

/** A low roller of the neon grid: dark banks ruled with glowing lines, as if the grid itself had
 * been lifted into a wave, a neon tube along the top of each. */
function waveClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, theme } = c, line = shade(theme.grid || hex("#3d1f6b"), 1.9);
  asphalt(c);
  for (const side of [1, -1]) {
    const fi = hi * 2.6 + 2, fj = hj * 2.6 + 2;
    flank(c, side, [hw, hw], [hi, hj], [hw + fi, hw + fj], [0, 0], shade(theme.ground[0], side > 0 ? 1.5 : 1.2));
    for (const t of [0.33, 0.66]) flankPatch(c, side, fi, fj, 0, 1, t, t + 0.035, line);
    if (c.n % 2 === 0) flankPatch(c, side, fi, fj, 0, 0.07, 0, 1, line);
    if (Math.max(hi, hj) > 0.4) band(c, side * hw, 0.3, 0.42, theme.edge);
  }
}

const STRATA = [hex("#c8693a"), hex("#d98b4f"), hex("#b5532f"), hex("#e2a467"), hex("#a8472a")];

/** Up onto a mesa: walls of sandstone in level bands of red and ochre (level with the ground, not
 * with the road, as rock is laid down), leaning out a little toward their foot, a strip of sand
 * along the top and a lip of red rock along the road. */
function mesaClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, i, j, tx, ty, theme } = c, top = hw + 2.2, lean = 0.18;
  asphalt(c);
  deck(c, hw, top, theme.ground[0]);
  deck(c, -top, -hw, theme.ground[0]);
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, off, z);
  for (const side of [1, -1]) {
    const lit = side > 0 ? 1.04 : 0.8;
    for (let b = 0; b * 1.1 < Math.max(hi, hj); b++) {
      const z0 = b * 1.1, z1 = z0 + 1.1;
      const bi = Math.min(z0, hi), bj = Math.min(z0, hj), ti = Math.min(z1, hi), tj = Math.min(z1, hj);
      if (ti <= bi && tj <= bj) continue;
      const out = (h: number, z: number) => side * (top + (h - z) * lean);
      face(c.p, [P(i, out(hi, bi), bi), P(j, out(hj, bj), bj), P(j, out(hj, tj), tj), P(i, out(hi, ti), ti)],
           shade(STRATA[b % STRATA.length], lit), [-side * ty, side * tx, lean], 0.1);
    }
    if (Math.max(hi, hj) > 0.6) band(c, side * (hw + 0.1), 0, 0.45, shade(STRATA[2], 0.8));
  }
}

/** Over a dune: wide banks of sand, the side to the sun lit and the other in shade, ripples across
 * them, and sand blown over the road's edges. */
function duneClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, theme } = c, sand = theme.ground[0];
  asphalt(c);
  deck(c, -hw, -hw + 0.7, shade(sand, 0.96), 0, 1, 0.012, -0.23);
  deck(c, hw - 0.7, hw, shade(sand, 0.96), 0, 1, 0.012, -0.23);
  for (const side of [1, -1]) {
    const fi = hi * 3 + 2, fj = hj * 3 + 2, lit = side > 0 ? 1.08 : 0.8;
    flank(c, side, [hw, hw], [hi, hj], [hw + fi, hw + fj], [0, 0], shade(sand, lit * (c.n & 1 ? 1 : 0.97)));
    for (const t of [0.3, 0.62]) flankPatch(c, side, fi, fj, 0, 1, t, t + 0.03, shade(sand, lit * 0.86));
  }
}

const CORAL_COLORS = [hex("#ff6f91"), hex("#ff9f5a"), hex("#b76cff"), hex("#ffd45a"), hex("#5ad1c4")];
const REEF_ROCK = hex("#5b6d7a");

/** Over a ridge of the reef: rock along the top and sand below, coral growing out of the banks in
 * fans of colour. */
function coralClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, i, j, theme } = c;
  asphalt(c);
  for (const side of [1, -1]) {
    const fi = hi * 1.9 + 1.5 + jag(i, side + 41), fj = hj * 1.9 + 1.5 + jag(j, side + 41);
    const lit = (side > 0 ? 1.04 : 0.84) * (0.9 + 0.2 * jag(c.n, side + 43));
    flank(c, side, [hw, hw], [hi, hj], [hw + 0.38 * fi, hw + 0.38 * fj], [hi * 0.66, hj * 0.66], shade(REEF_ROCK, lit));
    flank(c, side, [hw + 0.38 * fi, hw + 0.38 * fj], [hi * 0.66, hj * 0.66], [hw + fi, hw + fj], [0, 0], shade(theme.ground[0], 0.92 * lit));
    if (Math.max(hi, hj) < 0.8) continue;
    for (let k = 0; k < 2; k++) {
      const key = c.i * 2 + k, u = 0.2 + 0.6 * jag(key, side + 45), t = 0.12 + 0.45 * jag(key, side + 47);
      if (jag(key, side + 49) < 0.3) continue;
      const tall = 0.8 + 1.2 * jag(key, side + 51), col = CORAL_COLORS[Math.floor(jag(key, side + 53) * CORAL_COLORS.length)];
      const base = onFlank(c, side, fi, fj, u, t), yaw = jag(key, side + 55) * Math.PI;
      if (jag(key, side + 57) < 0.55) coralFan(c.p, base, yaw, tall, col);
      else coralTubes(c.p, base, yaw, tall, col);
    }
  }
}

/** A sea fan standing on the reef at ``base``, turned ``yaw`` about the upright: narrow at its
 * foot, spreading to a rounded top, a darker heart in it. */
function coralFan(p: Painter, base: P3, yaw: number, tall: number, color: number): void {
  const cx = Math.cos(yaw), cy = Math.sin(yaw);
  const shape = (w: number, h: number): P3[] =>
    [[-0.1, 0], [0.1, 0], [0.55, 0.5], [0.45, 0.86], [0, 1], [-0.45, 0.86], [-0.55, 0.5]].map(([x, z]): P3 =>
      [base[0] + cx * x * w, base[1] + cy * x * w, base[2] + z * h]);
  face(p, shape(tall * 0.9, tall), color, null, -0.12);
  face(p, shape(tall * 0.45, tall * 0.7), shade(color, 0.72), null, -0.13);
}

/** Tube coral: three stubby tubes of different heights side by side, lighter at their mouths. */
function coralTubes(p: Painter, base: P3, yaw: number, tall: number, color: number): void {
  const cx = Math.cos(yaw), cy = Math.sin(yaw);
  [[-0.3, 0.7], [0, 1], [0.32, 0.55]].forEach(([x, f], k) => {
    const x0 = x - 0.11, x1 = x + 0.11, h = tall * f;
    const P = (xx: number, z: number): P3 => [base[0] + cx * xx, base[1] + cy * xx, base[2] + z];
    face(p, [P(x0, 0), P(x1, 0), P(x1, h), P(x0, h)], shade(color, k === 1 ? 1 : 0.85), null, -0.12);
    face(p, [P(x0, h - 0.12), P(x1, h - 0.12), P(x1, h), P(x0, h)], shade(color, 1.3), null, -0.13);
  });
}

const BASALT = [hex("#2b2427"), hex("#3a3034"), hex("#332a2e"), hex("#45393d")];

/** A causeway of basalt over the lava: sheer sides of columns standing shoulder to shoulder, each a
 * shade of its own, lit red at the foot where the lava laps at them, a low wall of basalt along the
 * top with an ember-lit edge. */
function basaltClimb(c: Piece): void {
  const hw = HALF_WIDTH, { tx, ty } = c;
  asphalt(c);
  for (const side of [1, -1]) {
    const off = side * hw, out: P3 = [-side * ty, side * tx, 0];
    for (let k = 0; k < 3; k++) {
      const u0 = k / 3, u1 = (k + 1) / 3, key = c.i * 3 + k;
      const col = shade(BASALT[Math.floor(jag(key, side + 61) * BASALT.length)], side > 0 ? 1.1 : 0.9);
      face(c.p, [at(c, u0, off, 0), at(c, u1, off, 0), at(c, u1, off, zAt(c, u1)), at(c, u0, off, zAt(c, u0))], col, out, 0.1);
    }
    face(c.p, [at(c, 0, off, 0), at(c, 1, off, 0), at(c, 1, off, 0.35), at(c, 0, off, 0.35)], hex("#c2410c"), out, 0.09);
    if (Math.max(c.hi, c.hj) > 0.6) {
      band(c, off, 0, 0.5, hex("#3a2f33"));
      band(c, off, 0.44, 0.52, hex("#ff7a2a"), -0.16);
    }
  }
}

/** The climbs, each built as its style says (the world's own when the climb does not say). */
export function hillFaces(p: Painter, track: Track, theme: Theme): void {
  const step = 3;
  for (const hl of track.hills) {
    const a = indexAt(track, hl.s0), e = Math.min(track.count - 1, indexAt(track, hl.s0 + hl.len));
    if (e - a < 2 || !near(p, track, (a + e) >> 1, hl.len)) continue;
    const style = hl.style ?? theme.hillStyle ?? "earth";
    for (let i = a; i < e; i += step) {
      const j = Math.min(i + step, e);
      const hi = track.elev[i], hj = track.elev[j];
      if (Math.max(hi, hj) < 0.12 || !near(p, track, i)) continue;
      const [tx, ty] = track.tangent(i);
      const c: Piece = { p, track, theme, i, j, hi, hj, s: track.s[i], n: (i - a) / step,
                         len: Math.max(0.05, track.s[j] - track.s[i]), tx, ty };
      if (style === "rock") rockClimb(c);
      else if (style === "cliff") cliffClimb(c, hl.side ?? 1);
      else if (style === "foundation") foundationClimb(c);
      else if (style === "girder") girderClimb(c);
      else if (style === "scaffold") scaffoldClimb(c);
      else if (style === "crater") craterClimb(c);
      else if (style === "meadow") meadowClimb(c);
      else if (style === "skyway") skywayClimb(c);
      else if (style === "wave") waveClimb(c);
      else if (style === "mesa") mesaClimb(c);
      else if (style === "dune") duneClimb(c);
      else if (style === "coral") coralClimb(c);
      else if (style === "basalt") basaltClimb(c);
      else earthClimb(c);
    }
  }
}

/** The tunnels: through rock in the mountains, through a building's frame on the building site. */
export function tunnelFaces(p: Painter, track: Track, f: Features, theme?: Theme): void {
  for (const tn of f.tunnels) {
    if (!near(p, track, tn.start + (tn.n >> 1), 90)) continue;
    if (theme?.tunnels === "frame") frameTunnel(p, track, tn);
    else rockTunnel(p, track, tn);
  }
}

/** Walls, a ceiling and lamps inside; outside, a rock mound over the road and a rock face around
 * each mouth. */
function rockTunnel(p: Painter, track: Track, tn: Tunnel): void {
  const hw = HALF_WIDTH + 0.4, top = TUNNEL_H;
  for (let k = 0; k < tn.n; k += 3) {
    const i = track.wrap(tn.start + k), j = track.wrap(tn.start + Math.min(tn.n, k + 3));
    const zi = track.elev[i], zj = track.elev[j];
    const [tx, ty] = track.tangent(i);
    const P = (q: number, off: number, z: number) => edgePoint(track, q, off, z);
    // inside: the walls face the road, the ceiling faces down
    face(p, [P(i, hw, zi), P(j, hw, zj), P(j, hw, zj + top), P(i, hw, zi + top)], ROCK_DARK, [ty, -tx, 0], 0.05);
    face(p, [P(j, -hw, zj), P(i, -hw, zi), P(i, -hw, zi + top), P(j, -hw, zj + top)], shade(ROCK_DARK, 0.85), [-ty, tx, 0], 0.05);
    face(p, [P(i, -hw, zi + top), P(j, -hw, zj + top), P(j, hw, zj + top), P(i, hw, zi + top)], CEILING, DOWN, 0.06);
    if (k % 12 === 0) {
      for (const off of [hw - 0.06, -hw + 0.06]) {
        face(p, [P(i, off, zi + 4.1), P(j, off, zj + 4.1), P(j, off, zj + 4.6), P(i, off, zi + 4.6)], LAMP, null, -0.05);
      }
    }
    // outside: a rock mound over the tunnel, ridged along the middle
    const ridge = top + 3.5, foot = hw + 6.5;
    face(p, [P(i, foot, zi), P(j, foot, zj), P(j, 0, zj + ridge), P(i, 0, zi + ridge)], ROCK, [-ty, tx, 1], 0.12);
    face(p, [P(j, -foot, zj), P(i, -foot, zi), P(i, 0, zi + ridge), P(j, 0, zj + ridge)], shade(ROCK, 0.8), [ty, -tx, 1], 0.12);
  }
  // a rock face around each mouth, facing out along the road
  for (const [q, dir] of [[tn.start, -1], [track.wrap(tn.start + tn.n), 1]] as const) {
    const [tx, ty] = track.tangent(q);
    const z = track.elev[q];
    const L = (off: number, zz: number): P3 => edgePoint(track, q, off, z + zz);
    const out: P3 = [tx * dir, ty * dir, 0];
    face(p, [L(hw, 0), L(hw + 6.5, 0), L(hw + 2, top + 3.5), L(hw, top + 3.5)], ROCK, out, -0.12);
    face(p, [L(-hw - 6.5, 0), L(-hw, 0), L(-hw, top + 3.5), L(-hw - 2, top + 3.5)], ROCK, out, -0.12);
    face(p, [L(-hw, top), L(hw, top), L(hw, top + 3.5), L(-hw, top + 3.5)], shade(ROCK, 0.9), out, -0.12);
  }
}

const FRAME = hex("#b4472f"), FRAME_DARK = hex("#86331f"), GLASS = hex("#86c6da"), JERSEY = hex("#c9c5b9");
const FLOORS = 3, STOREY = 3.6;

/** Through the ground floor of a building going up: concrete barriers along the road, steel
 * columns, the floor slabs overhead (the first one is the ceiling), glass going in on some bays,
 * the next storey's columns sticking up out of the top, and a striped clearance bar at each end. */
function frameTunnel(p: Painter, track: Track, tn: Tunnel): void {
  const hw = HALF_WIDTH + 0.4, wide = hw + 1.8, top = TUNNEL_H, thick = 0.35;
  for (let k = 0; k < tn.n; k += 3) {
    const i = track.wrap(tn.start + k), j = track.wrap(tn.start + Math.min(tn.n, k + 3)), n = k / 3;
    const zi = track.elev[i], zj = track.elev[j];
    const [tx, ty] = track.tangent(i);
    const P = (q: number, off: number, z: number) => edgePoint(track, q, off, z);
    face(p, [P(i, hw, zi), P(j, hw, zj), P(j, hw, zj + 0.9), P(i, hw, zi + 0.9)], JERSEY, [ty, -tx, 0], 0.05);
    face(p, [P(j, -hw, zj), P(i, -hw, zi), P(i, -hw, zi + 0.9), P(j, -hw, zj + 0.9)], shade(JERSEY, 0.88), [-ty, tx, 0], 0.05);
    for (let f = 0; f < FLOORS; f++) {
      const ai = zi + top + f * STOREY, aj = zj + top + f * STOREY;
      face(p, [P(i, -wide, ai), P(i, wide, ai), P(j, wide, aj), P(j, -wide, aj)], SLAB_UNDER, DOWN, 0.06);
      face(p, [P(i, -wide, ai + thick), P(j, -wide, aj + thick), P(j, wide, aj + thick), P(i, wide, ai + thick)], SLAB, UP, 0.06);
      face(p, [P(i, wide, ai), P(j, wide, aj), P(j, wide, aj + thick), P(i, wide, ai + thick)], SLAB_SIDE, [-ty, tx, 0], 0.02);
      face(p, [P(j, -wide, aj), P(i, -wide, ai), P(i, -wide, ai + thick), P(j, -wide, aj + thick)], shade(SLAB_SIDE, 0.85),
           [ty, -tx, 0], 0.02);
      if (f < FLOORS - 1 && jag(n * 7 + f, 11) > 0.45) {
        for (const side of [1, -1]) {
          face(p, [P(i, side * wide, ai + thick), P(j, side * wide, aj + thick), P(j, side * wide, aj + STOREY),
                   P(i, side * wide, ai + STOREY)], GLASS, null, 0.03, 0.55);
        }
      }
    }
    if (n % 4 !== 0) continue;
    // a column either side, up through every floor and out of the top; a beam across under the ceiling
    const q = track.wrap(i + 1), zc = zi + top + (FLOORS - 1) * STOREY + 2.6;
    for (const side of [1, -1]) {
      const o0 = side * (hw + 0.1), o1 = side * (hw + 0.7);
      face(p, [P(i, o0, zi), P(q, o0, zi), P(q, o0, zc), P(i, o0, zc)], FRAME, [side * ty, -side * tx, 0], -0.02);
      face(p, [P(i, o1, zi), P(q, o1, zi), P(q, o1, zc), P(i, o1, zc)], FRAME, [-side * ty, side * tx, 0], -0.02);
      face(p, [P(i, o0, zi), P(i, o1, zi), P(i, o1, zc), P(i, o0, zc)], FRAME_DARK, [-tx, -ty, 0], -0.02);
      face(p, [P(q, o0, zi), P(q, o1, zi), P(q, o1, zc), P(q, o0, zc)], FRAME_DARK, [tx, ty, 0], -0.02);
      face(p, [P(i, o0, zi + 4.1), P(q, o0, zi + 4.1), P(q, o0, zi + 4.45), P(i, o0, zi + 4.45)], LAMP, [side * ty, -side * tx, 0], -0.04);
    }
    const b0 = zi + top - 0.55;
    face(p, [P(i, -wide, b0), P(i, wide, b0), P(i, wide, zi + top), P(i, -wide, zi + top)], FRAME_DARK, [-tx, -ty, 0], -0.01);
    face(p, [P(q, -wide, b0), P(q, wide, b0), P(q, wide, zi + top), P(q, -wide, zi + top)], FRAME_DARK, [tx, ty, 0], -0.01);
    face(p, [P(i, -wide, b0), P(q, -wide, b0), P(q, wide, b0), P(i, wide, b0)], FRAME, DOWN, -0.01);
  }
  // at each end: the slabs' edges, and a striped clearance bar under the first
  for (const [q, dir] of [[tn.start, -1], [track.wrap(tn.start + tn.n), 1]] as const) {
    const [tx, ty] = track.tangent(q);
    const z = track.elev[q];
    const L = (off: number, zz: number): P3 => edgePoint(track, q, off, z + zz);
    const out: P3 = [tx * dir, ty * dir, 0];
    for (let f = 0; f < FLOORS; f++) {
      const zz = top + f * STOREY;
      face(p, [L(-wide, zz), L(wide, zz), L(wide, zz + thick), L(-wide, zz + thick)], SLAB_SIDE, out, -0.12);
    }
    for (let b = 0; b < 8; b++) {
      const o0 = -hw + (2 * hw * b) / 8, o1 = -hw + (2 * hw * (b + 1)) / 8;
      face(p, [L(o0, top - 0.6), L(o1, top - 0.6), L(o1, top), L(o0, top)], STRIPE[b & 1], out, -0.13);
    }
  }
}

export function rampFaces(p: Painter, track: Track, f: Features, theme: Theme): void {
  const hw = HALF_WIDTH;
  const n = Math.round(RAMP_LEN / SPACING);
  for (const r of f.ramps) {
    if (!near(p, track, r.start)) continue;
    const step = 2;
    for (let k = 0; k < n; k += step) {
      const i = track.wrap(r.start + k), j = track.wrap(r.start + Math.min(n, k + step));
      const hi = (RAMP_HEIGHT * k) / n, hj = (RAMP_HEIGHT * Math.min(n, k + step)) / n;
      const P = (q: number, off: number, z: number) => edgePoint(track, q, off, z);
      const [tx, ty] = track.tangent(i);
      const color = STRIPE[Math.floor((k * SPACING) / 1.6) & 1];
      face(p, [P(i, -hw, hi), P(j, -hw, hj), P(j, hw, hj), P(i, hw, hi)], color, [0, 0, 1], -0.3, 1, true);
      // the sides wear the circuit's kerb colours, so a ramp reads from across the infield
      const side = shade(theme.kerb[(k / step) & 1], 0.82);
      face(p, [P(i, hw, 0), P(j, hw, 0), P(j, hw, hj), P(i, hw, hi)], side, [-ty, tx, 0], -0.2);
      face(p, [P(j, -hw, 0), P(i, -hw, 0), P(i, -hw, hi), P(j, -hw, hj)], side, [ty, -tx, 0], -0.2);
    }
    const lip = track.wrap(r.start + n);
    const [tx, ty] = track.tangent(lip);
    const L = (off: number, z: number) => edgePoint(track, lip, off, z);
    face(p, [L(-hw, 0), L(hw, 0), L(hw, RAMP_HEIGHT), L(-hw, RAMP_HEIGHT)], UNDER, [tx, ty, 0], -0.2);
    face(p, [L(-hw, RAMP_HEIGHT - 0.35), L(hw, RAMP_HEIGHT - 0.35), L(hw, RAMP_HEIGHT), L(-hw, RAMP_HEIGHT)],
         theme.edge, [tx, ty, 0], -0.25);
  }
}

/** The aiming arrow on the road in front of a kart, pointing ``angle`` off its heading: a dark
 * outline under a bright shaft and head. */
export function aimArrow(p: Painter, k: { x: number; y: number; heading: number; ground: number }, angle: number,
                         color: number, reach = 1): void {
  const a = k.heading + angle;
  const fx = Math.cos(a), fy = Math.sin(a), lx = -fy, ly = fx;
  const z = k.ground + 0.06;
  // (``reach`` scales it: the one behind the kart is seen from further off, in the mirror)
  const P = (d: number, w: number): P3 => [k.x + fx * d * reach + lx * w * reach, k.y + fy * d * reach + ly * w * reach, z];
  const arrow = (grow: number, c: number) => {
    face(p, [P(2.2 - grow, -0.3 - grow), P(5.0, -0.3 - grow), P(5.0, 0.3 + grow), P(2.2 - grow, 0.3 + grow)], c, [0, 0, 1]);
    face(p, [P(4.6 - grow, -0.95 - grow), P(6.7 + grow * 1.5, 0), P(4.6 - grow, 0.95 + grow)], c, [0, 0, 1]);
  };
  const from = p.faces.length;
  arrow(0.18, hex("#14121c"));
  arrow(0, color);
  // one decal at one depth (the sort is stable, so the outline always goes down first): under any
  // kart standing on it, and on raised road over the deck it lies on, just before the kart itself
  const mine = p.faces.slice(from);
  if (!mine.length) return;
  const depth = k.ground > 0.05 ? toCamera(p.cam, k.x, k.y, k.ground)[0] - 0.45 : Math.max(...mine.map((f) => f.z)) - 0.45;
  for (const f of mine) f.z = depth;
}

export function padFaces(p: Painter, track: Track, f: Features, time: number): void {
  for (const pad of f.pads) {
    if (!near(p, track, pad.start)) continue;
    const i = pad.start;
    const z = (track.elev[i] ?? 0) + 0.05;
    const [tx, ty] = track.tangent(i);
    const nx = -ty, ny = tx;
    const ox = track.xs[i] + nx * pad.offset, oy = track.ys[i] + ny * pad.offset;
    const L = (u: number, v: number): P3 => [ox + tx * u + nx * v, oy + ty * u + ny * v, z];
    face(p, [L(0, -PAD_HALF), L(PAD_LEN, -PAD_HALF), L(PAD_LEN, PAD_HALF), L(0, PAD_HALF)],
         hex("#7a2e12"), [0, 0, 1], -0.3, 1, true);
    for (let c = 0; c < 3; c++) {
      const u0 = 1 + c * 2;
      const glow = 0.5 + 0.5 * Math.sin(time * 9 - c * 1.6);
      const col = mix(hex("#ff8a1f"), hex("#fff2a8"), glow);
      // a chevron pointing along the road: two arms meeting at the tip
      face(p, [L(u0, -PAD_HALF + 0.4), L(u0 + 1.4, 0), L(u0 + 2.0, 0), L(u0 + 0.6, -PAD_HALF + 0.4)], col, [0, 0, 1], -0.35, 1, true);
      face(p, [L(u0 + 0.6, PAD_HALF - 0.4), L(u0 + 2.0, 0), L(u0 + 1.4, 0), L(u0, PAD_HALF - 0.4)], col, [0, 0, 1], -0.35, 1, true);
    }
  }
}
