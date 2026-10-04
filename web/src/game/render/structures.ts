// The 3D parts of a circuit, built from flat polygons every frame for whatever is in view:
// bridges (deck with kerbed edges and center dashes, guard rails, girder sides, underside),
// jump ramps (a striped wedge with kerb-coloured sides), boost pads (chevrons that pulse forward),
// climbs (the road up on an earth embankment, a concrete foundation, a steel girder, a scaffold, a
// crater's rim, a grassy rise, a mesa, a dune, a ridge of coral, a
// causeway of basalt, an elevated expressway or a parking garage's ramp) and tunnels (under a
// building in Tokyo, or through the steel frame of a building going up).

import { hex, mix, shade } from "../core/gfx";
import { PAD_HALF, PAD_LEN, RAMP_HEIGHT, RAMP_LEN, TUNNEL_H, type Features, type Pad, type Tunnel } from "../race/features";
import type { Theme } from "../themes";
import { BANK_AT, BANK_LEAN, type Bank } from "../world/banks";
import { HALF_WIDTH, type Track } from "../world/track";
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

/** The point ``u`` m along the road from point ``from`` (by arc length, as the race measures
 * ramps and pads), ``off`` m left of the centerline, at height ``z``. */
function alongPoint(track: Track, from: number, u: number, off: number, z: number): P3 {
  const { i, w } = track.stepAlong(from, u);
  const a = edgePoint(track, i, off, z);
  if (w <= 0) return a;
  const b = edgePoint(track, track.wrap(i + 1), off, z);
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, z];
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

const CLIMB_STEP = 3; // dense points to a piece of a climb (hillFaces), and of a pad on one

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
const LAMP = hex("#ffd98a");
const SLAB = hex("#b5b1a5"), SLAB_SIDE = hex("#9b978b"), SLAB_UNDER = hex("#77736a"), REBAR = hex("#9a5530");
const STEEL = hex("#68707c"), CRANE = hex("#f2b21b"), CRANE_DARK = hex("#b98310");
const PLANKS = [hex("#b9844c"), hex("#a5733f")], PLANK_GAP = hex("#4a3420"), TOE = hex("#ff8a1f");
const PIPE = hex("#c9cdd4"), PIPE_DARK = hex("#9aa0a9");

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
  top: number; // the nearest sort key of the strips of road drawn on it (deck), for what lies on them
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
  const z0 = zAt(c, u0) + lift, z1 = zAt(c, u1) + lift, faces = c.p.faces, n = faces.length;
  face(c.p, [at(c, u0, off0, z0), at(c, u1, off0, z1), at(c, u1, off1, z1), at(c, u0, off1, z0)], color, UP, bias, 1, true);
  if (faces.length > n) c.top = Math.min(c.top, faces[n].z);
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

const LANE = hex("#e8e8e8"), PARAPET = hex("#9a9ea6"), COPING = hex("#c3c7ce"), FASCIA = hex("#6b7079");
const SOFFIT = hex("#2b2e35"), PIER = hex("#80858d"), LAMP_POLE = hex("#565b64"), SIGN_GREEN = hex("#1d7a4b");

/** Tokyo's elevated expressway: dark asphalt with white lines, concrete parapets with a pale
 * coping, a deep girder underneath, sodium lamps on tall poles reaching out over the road (their
 * light lying in orange pools on the deck), a concrete pier with a cap beam every so often, and
 * now and then a green sign over the road. */
function expresswayClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, n, theme } = c, raised = Math.max(hi, hj) > 0.6;
  deck(c, -hw, hw, shade(theme.road, 1.3));
  deck(c, -hw + 0.35, -hw + 0.55, LANE, 0, 1, 0.01, -0.22);
  deck(c, hw - 0.55, hw - 0.35, LANE, 0, 1, 0.01, -0.22);
  if (Math.floor(c.s / 5) % 2 === 0) deck(c, -0.1, 0.1, LANE, 0, 1, 0.01, -0.25);
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, off, z);
  face(c.p, [P(c.i, -hw, hi - 1.3), P(c.i, hw, hi - 1.3), P(c.j, hw, hj - 1.3), P(c.j, -hw, hj - 1.3)], SOFFIT, DOWN, 0.2);
  for (const side of [1, -1]) {
    band(c, side * hw, -1.3, 0, FASCIA, -0.1);
    if (!raised) continue;
    band(c, side * hw, 0, 1.0, PARAPET);
    band(c, side * hw, 0.9, 1.05, COPING, -0.16);
  }
  const z = (hi + hj) / 2;
  // a lamp every twelve pieces, on alternate sides: a pole up from the parapet, an arm out over the
  // road, the lamp at its end, and its light in a pool on the deck
  const m = n % 12;
  if (raised && m >= 5 && m <= 7) {
    face(c.p, [at(c, 0, -hw, hi + 0.008), at(c, 1, -hw, hj + 0.008), at(c, 1, hw, hj + 0.008), at(c, 0, hw, hi + 0.008)],
         hex("#ffb24a"), UP, -0.205, m === 6 ? 0.12 : 0.06, true);
  }
  if (raised && m === 6) {
    const side = Math.floor(n / 12) & 1 ? 1 : -1, off = side * (hw + 0.25), reach = off - side * 3.2, top = z + 8.2;
    bar(c, off, 0.5, z + 1.0, 0.5, top, 0.22, LAMP_POLE, -0.12);
    face(c.p, [at(c, 0.5, off, top - 0.1), at(c, 0.5, reach, top - 0.1), at(c, 0.5, reach, top + 0.12), at(c, 0.5, off, top + 0.12)],
         LAMP_POLE, null, -0.12);
    face(c.p, [at(c, 0.42, reach + side * 0.7, top - 0.32), at(c, 0.42, reach - side * 0.1, top - 0.32),
               at(c, 0.58, reach - side * 0.1, top - 0.1), at(c, 0.58, reach + side * 0.7, top - 0.1)], SODIUM, null, -0.13);
  }
  // a pier under the middle of the deck, a cap beam across under the girder
  const under = z - 1.3;
  if (n % 16 === 8 && under > 1.5) {
    face(c.p, [at(c, 0.5, -1.1, 0), at(c, 0.5, 1.1, 0), at(c, 0.5, 1.1, under - 1.1), at(c, 0.5, -1.1, under - 1.1)], PIER, null, 0.05);
    bar(c, 0, 0.5, 0, 0.5, under - 1.1, 2.2, shade(PIER, 0.84), 0.05);
    face(c.p, [at(c, 0.5, -hw + 0.6, under - 1.1), at(c, 0.5, hw - 0.6, under - 1.1), at(c, 0.5, hw - 0.6, under),
               at(c, 0.5, -hw + 0.6, under)], shade(PIER, 1.1), null, 0.04);
  }
  // a green sign over the road on two posts, a white border and white lines of lettering
  if (raised && n % 40 === 20) {
    const zb = z + 4.9, back: P3 = [-c.tx, -c.ty, 0];
    for (const side of [1, -1]) bar(c, side * (hw + 0.3), 0.5, z, 0.5, zb + 1.7, 0.2, LAMP_POLE, -0.12);
    face(c.p, [at(c, 0.5, -hw + 0.4, zb), at(c, 0.5, hw - 0.4, zb), at(c, 0.5, hw - 0.4, zb + 1.7), at(c, 0.5, -hw + 0.4, zb + 1.7)],
         LANE, back, -0.12);
    face(c.p, [at(c, 0.5, -hw + 0.55, zb + 0.15), at(c, 0.5, hw - 0.55, zb + 0.15), at(c, 0.5, hw - 0.55, zb + 1.55),
               at(c, 0.5, -hw + 0.55, zb + 1.55)], SIGN_GREEN, back, -0.13);
    for (const [o0, o1, zz] of [[-4.6, -0.6, 1.1], [0.4, 4.2, 1.1], [-3.8, -1.2, 0.55], [1.0, 3.4, 0.55]]) {
      face(c.p, [at(c, 0.5, o0, zb + zz), at(c, 0.5, o1, zb + zz), at(c, 0.5, o1, zb + zz + 0.22), at(c, 0.5, o0, zb + zz + 0.22)],
           LANE, back, -0.14);
    }
  }
}

const GARAGE_FLOOR = hex("#8b9097"), GARAGE_ROOF = hex("#474b54"), TUBE = hex("#eefcff"), GARAGE_SLAB = hex("#9ea2a9");
const GARAGE_EDGE = hex("#7a7e86"), GARAGE_WALL = hex("#b3b7be"), GARAGE_PAINT = hex("#f2d13a"), GARAGE_H = 5.0;

/** The ramp of a parking garage, up a floor and along it: a concrete floor with a yellow line
 * down the middle and a yellow and black kerb, low concrete walls, square columns, and over the
 * road the floor above, lit underneath by strip lights, its slab's edge showing outside; a striped
 * clearance bar over the way in. */
function garageClimb(c: Piece): void {
  const hw = HALF_WIDTH, { hi, hj, n } = c, wide = hw + 1.1, top = GARAGE_H;
  deck(c, -hw, hw, GARAGE_FLOOR);
  deck(c, -hw, -hw + 0.45, STRIPE[n & 1], 0, 1, 0.01, -0.22);
  deck(c, hw - 0.45, hw, STRIPE[(n + 1) & 1], 0, 1, 0.01, -0.22);
  if (n % 3 !== 2) deck(c, -0.12, 0.12, GARAGE_PAINT, 0, 1, 0.01, -0.25);
  const P = (k: number, off: number, z: number) => edgePoint(c.track, k, off, z);
  // the floor above: its underside (the ceiling), the strip lights on it, its top and its edges
  face(c.p, [P(c.i, -wide, hi + top), P(c.i, wide, hi + top), P(c.j, wide, hj + top), P(c.j, -wide, hj + top)], GARAGE_ROOF, DOWN, 0.06);
  if (n % 2 === 0) {
    for (const o of [-2.6, 2.6]) {
      face(c.p, [at(c, 0.1, o - 0.16, zAt(c, 0.1) + top - 0.02), at(c, 0.9, o - 0.16, zAt(c, 0.9) + top - 0.02),
                 at(c, 0.9, o + 0.16, zAt(c, 0.9) + top - 0.02), at(c, 0.1, o + 0.16, zAt(c, 0.1) + top - 0.02)], TUBE, DOWN, 0.05);
    }
  }
  face(c.p, [P(c.i, -wide, hi + top + 0.45), P(c.j, -wide, hj + top + 0.45), P(c.j, wide, hj + top + 0.45),
             P(c.i, wide, hi + top + 0.45)], GARAGE_SLAB, UP, 0.06);
  for (const side of [1, -1]) {
    const off = side * wide, outward: P3 = [-side * c.ty, side * c.tx, 0];
    face(c.p, [P(c.i, off, hi + top), P(c.j, off, hj + top), P(c.j, off, hj + top + 0.45), P(c.i, off, hi + top + 0.45)],
         GARAGE_EDGE, outward, 0.02);
    // the floor's edge down to the ground, and the low wall along it
    flank(c, side, [hw, hw], [hi, hj], [hw, hw], [0, 0], shade(GARAGE_EDGE, side > 0 ? 1 : 0.84), 0.1, 0);
    band(c, side * hw, 0, 0.95, GARAGE_WALL);
    if (n % 4 !== 0) continue;
    // a square column, up from the ground to the floor above, striped yellow and black at the foot
    const o0 = side * (hw + 0.2), o1 = side * (hw + 0.8), zc = Math.max(hi, hj) + top;
    const C0 = (u: number, o: number, zz: number) => at(c, u, o, zz);
    face(c.p, [C0(0, o0, 0), C0(0.35, o0, 0), C0(0.35, o0, zc), C0(0, o0, zc)], GARAGE_WALL, [side * c.ty, -side * c.tx, 0], -0.02);
    face(c.p, [C0(0, o1, 0), C0(0.35, o1, 0), C0(0.35, o1, zc), C0(0, o1, zc)], GARAGE_WALL, outward, -0.02);
    face(c.p, [C0(0, o0, 0), C0(0, o1, 0), C0(0, o1, zc), C0(0, o0, zc)], shade(GARAGE_WALL, 0.8), [-c.tx, -c.ty, 0], -0.02);
    face(c.p, [C0(0.35, o0, 0), C0(0.35, o1, 0), C0(0.35, o1, zc), C0(0.35, o0, zc)], shade(GARAGE_WALL, 0.8), [c.tx, c.ty, 0], -0.02);
    const zf = hi + 0.95;
    face(c.p, [C0(0, o0, zf), C0(0.35, o0, zf), C0(0.35, o0, zf + 0.8), C0(0, o0, zf + 0.8)], STRIPE[0], [side * c.ty, -side * c.tx, 0], -0.03);
    face(c.p, [C0(0, o0, zf + 0.25), C0(0.35, o0, zf + 0.25), C0(0.35, o0, zf + 0.5), C0(0, o0, zf + 0.5)], STRIPE[1],
         [side * c.ty, -side * c.tx, 0], -0.04);
  }
  // the way in: a striped clearance bar under the edge of the floor above
  if (n === 0) {
    for (let b = 0; b < 8; b++) {
      const o0 = -hw + (2 * hw * b) / 8, o1 = -hw + (2 * hw * (b + 1)) / 8;
      face(c.p, [P(c.i, o0, hi + top - 0.6), P(c.i, o1, hi + top - 0.6), P(c.i, o1, hi + top), P(c.i, o0, hi + top)], STRIPE[b & 1],
           [-c.tx, -c.ty, 0], -0.13);
    }
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
/** ``pads``: the boost pads (a part of one on a climb is drawn with the piece of road it lies on,
 * at ``time`` in its glow). */
export function hillFaces(p: Painter, track: Track, theme: Theme, pads: readonly Pad[] = [], time = 0): void {
  const step = CLIMB_STEP;
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
                         len: Math.max(0.05, track.s[j] - track.s[i]), tx, ty, top: Infinity };
      if (style === "expressway") expresswayClimb(c);
      else if (style === "garage") garageClimb(c);
      else if (style === "foundation") foundationClimb(c);
      else if (style === "girder") girderClimb(c);
      else if (style === "scaffold") scaffoldClimb(c);
      else if (style === "crater") craterClimb(c);
      else if (style === "meadow") meadowClimb(c);
      else if (style === "mesa") mesaClimb(c);
      else if (style === "dune") duneClimb(c);
      else if (style === "coral") coralClimb(c);
      else if (style === "basalt") basaltClimb(c);
      else earthClimb(c);
      padsOn(c, pads, time);
    }
  }
}

/** The parts of boost pads on piece ``c`` of a climb: drawn straight after its road (over the
 * lines on it), before anything standing on it. */
function padsOn(c: Piece, pads: readonly Pad[], time: number): void {
  if (!Number.isFinite(c.top)) return;
  for (const pad of pads) {
    // the pad's steps between dense points i..j (step k lies between pad.start + k and + k + 1)
    const past = (q: number) => { // m from the pad's start on to point q (before it: negative)
      const d = c.track.s[q] - pad.s0, L = c.track.length;
      return c.track.locked ? ((((d % L) + L * 1.5) % L) - L / 2) : d;
    };
    const ua = Math.max(0, past(c.i)), ub = Math.min(PAD_LEN, past(c.j));
    if (ub <= ua) continue;
    const faces = c.p.faces, from = faces.length;
    padPart(c.p, c.track, pad, ua, ub, time);
    for (let q = from; q < faces.length; q++) faces[q].z = c.top - 0.001;
  }
}

/** The piece of climb road that dense point ``q`` starts, as hillFaces draws it (its first dense
 * point), or -1 where the road there lies on the ground. */
function climbPieceAt(track: Track, q: number): number {
  const s = track.s[q];
  for (const hl of track.hills) {
    if (s < hl.s0 - 2 || s > hl.s0 + hl.len + 2) continue;
    const a = indexAt(track, hl.s0), e = Math.min(track.count - 1, indexAt(track, hl.s0 + hl.len));
    if (e - a < 2 || q < a || q >= e) continue;
    const i = a + Math.floor((q - a) / CLIMB_STEP) * CLIMB_STEP, j = Math.min(i + CLIMB_STEP, e);
    return Math.max(track.elev[i], track.elev[j]) < 0.12 ? -1 : i;
  }
  return -1;
}

const SHOP = [hex("#ffd98a"), hex("#dfe8ff"), hex("#ffb0d0"), hex("#9fe8ff"), hex("#ffcf7a")];
const CONTAINERS = [hex("#c0392b"), hex("#2f6fb0"), hex("#27885a"), hex("#d98b2b"), hex("#7a7f88")];
const CORALS = [hex("#ff6f91"), hex("#ff9f5a"), hex("#b76cff"), hex("#ffd45a"), hex("#5ad1c4")];

/** The cuttings (world/banks.ts): walls of land beside the road, in each world's own make. */
export function bankFaces(p: Painter, track: Track, banks: readonly Bank[], theme: Theme): void {
  for (const b of banks) {
    const a = indexAt(track, b.s0), e = Math.min(track.count - 1, indexAt(track, b.s0 + b.len));
    if (e - a < 3 || !near(p, track, (a + e) >> 1, b.len)) continue;
    for (let i = a; i < e; i += CLIMB_STEP) {
      const j = Math.min(i + CLIMB_STEP, e);
      if (near(p, track, i)) bankPiece(p, track, b, theme, i, j, (i - a) / CLIMB_STEP, i === a, j === e);
    }
  }
}

function bankPiece(p: Painter, track: Track, b: Bank, theme: Theme, i: number, j: number, n: number, first: boolean,
                   last: boolean): void {
  const sd = b.side, lean = BANK_LEAN[b.style], foot = BANK_AT, h = b.h, back = foot + lean * h + 4;
  const zi = track.elev[i] ?? 0, zj = track.elev[j] ?? 0;
  const [tx, ty] = track.tangent(i);
  const P = (q: number, off: number, z: number) => edgePoint(track, q, sd * off, z);
  const inward: P3 = [sd * ty, -sd * tx, lean]; // facing the road (and the sky, as it leans back)
  // a band of the wall from z0 to z1 m up, in ``color``
  const band = (z0: number, z1: number, color: number, bias = 0.12) => {
    face(p, [P(i, foot + lean * z0, zi + z0), P(j, foot + lean * z0, zj + z0), P(j, foot + lean * z1, zj + z1),
             P(i, foot + lean * z1, zi + z1)], color, inward, bias);
  };
  // a patch on the wall, u0..u1 along the piece and z0..z1 up (a window, a sign), just in front of it
  const patch = (u0: number, u1: number, z0: number, z1: number, color: number) => {
    const A = (u: number, z: number) => {
      const q0 = P(i, foot + lean * z - 0.03, zi + z), q1 = P(j, foot + lean * z - 0.03, zj + z);
      return [q0[0] + (q1[0] - q0[0]) * u, q0[1] + (q1[1] - q0[1]) * u, q0[2] + (q1[2] - q0[2]) * u] as P3;
    };
    face(p, [A(u0, z0), A(u1, z0), A(u1, z1), A(u0, z1)], color, inward, 0.1);
  };
  const lit = jag(n, 41) > 0.5 ? 1 : 0.92;
  switch (b.style) {
    case "grass": {
      band(0, 0.9, shade(STONE, (n & 1 ? 0.92 : 1.04) * lit)); // a dry-stone wall at the foot
      band(0.9, h, shade(theme.ground[n & 1], 0.86 * lit));
      if (n % 2 === 0) patch(0.1, 0.9, 0.86, 0.95, shade(STONE, 1.25));
      break;
    }
    case "canyon": {
      const layers = 5;
      // level beds of rock running the length of the wall, a seam darker every so often
      for (let k = 0; k < layers; k++) {
        band((k * h) / layers, ((k + 1) * h) / layers, shade(STRATA[(k * 2 + 1) % STRATA.length], (k & 1 ? 0.93 : 1.03) * (n % 9 === 0 ? 0.9 : 1)));
      }
      break;
    }
    case "coral": {
      band(0, h * 0.55, shade(hex("#56697a"), lit));
      band(h * 0.55, h, shade(hex("#6d8292"), lit));
      if (n % 2 === 0) patch(0.15, 0.6, h * 0.82, h * 0.98, CORALS[(n >> 1) % CORALS.length]);
      if (n % 3 === 1) patch(0.5, 0.85, h * 0.3, h * 0.42, CORALS[(n + 2) % CORALS.length]);
      break;
    }
    case "street": {
      // shop fronts three pieces wide: a lit window, a sign over it; above, floors of windows
      const shop = Math.floor(n / 3), at = n % 3, glass = SHOP[shop % SHOP.length], sign = NEON_SIGNS[(shop * 3) % NEON_SIGNS.length];
      band(0, 4.6, hex("#1d1f28"));
      band(4.6, h, shade(FACADE, 0.9 + 0.2 * jag(shop, 9)));
      if (at !== 1 || jag(shop, 13) > 0.3) patch(0.08, 0.92, 0.5, 3.1, glass);
      patch(0, 1, 3.5, 4.5, sign);
      if (at === 1) patch(0.15, 0.85, 3.7, 4.3, hex("#16101f"));
      for (let z = 6; z < h - 1.5; z += 3.4) {
        const win = jag(n * 11 + Math.round(z), 21);
        if (win < 0.7) patch(0.2, 0.8, z, z + 1.7, win < 0.42 ? hex("#ffd98a") : win < 0.6 ? hex("#dfe8ff") : hex("#141722"));
      }
      break;
    }
    case "basalt": {
      band(0, h, shade(hex("#2f2729"), (n & 1 ? 0.95 : 1.05) * lit));
      if (jag(n, 17) > 0.55) patch(0.1, 0.9, h * (0.3 + 0.4 * jag(n, 19)), h * (0.3 + 0.4 * jag(n, 19)) + 0.18, hex("#ff7a1e"));
      break;
    }
    case "hoarding": {
      band(0, 2.4, n & 1 ? hex("#2f6fb0") : hex("#2a63a0"));
      patch(0, 1, 1.1, 1.35, hex("#f4f1ea"));
      if (h > 2.6) band(2.4, h, CONTAINERS[Math.floor(n / 4) % CONTAINERS.length]);
      if (h > 2.6 && n % 4 === 0) patch(0, 0.08, 2.4, h, hex("#1f2026"));
      break;
    }
    case "regolith": {
      band(0, h, shade(theme.ground[0], (0.8 + 0.12 * jag(n, 23)) * lit));
      band(h - 0.4, h, shade(theme.ground[0], 1.15));
      break;
    }
  }
  // the land on top of the wall, back from its edge, and the wall's ends
  const top: P3 = [0, 0, 1];
  face(p, [P(i, foot + lean * h, zi + h), P(i, back, zi + h), P(j, back, zj + h), P(j, foot + lean * h, zj + h)],
       b.style === "street" ? ROOF : b.style === "hoarding" ? hex("#3a3e46") : shade(theme.ground[1], 1.05), top, 0.14);
  for (const [q, end, dir] of [[i, first, -1], [j, last, 1]] as const) {
    if (!end) continue;
    const [ex, ey] = track.tangent(q), z = track.elev[q] ?? 0;
    face(p, [P(q, foot, z), P(q, back, z), P(q, back, z + h), P(q, foot + lean * h, z + h)],
         b.style === "street" ? FACADE : b.style === "canyon" ? shade(STRATA[2], 0.85) : shade(theme.ground[0], 0.75),
         [ex * dir, ey * dir, 0], 0.12);
  }
}

/** The tunnels: under a building in Tokyo, through a building's frame on the building site. */
export function tunnelFaces(p: Painter, track: Track, f: Features, theme?: Theme): void {
  for (const tn of f.tunnels) {
    if (!near(p, track, tn.start + (tn.n >> 1), 90)) continue;
    if (theme?.tunnels === "frame") frameTunnel(p, track, tn);
    else cityTunnel(p, track, tn);
  }
}

const TILE = hex("#d6d0c0"), TILE_BAND = hex("#2f6fb0"), TUNNEL_TOP = hex("#34363d"), SODIUM = hex("#ffb347");
const FACADE = hex("#262a36"), ROOF = hex("#3a3e4a"), WINDOWS = [hex("#ffd98a"), hex("#dfe8ff"), hex("#ffb0d0"), hex("#141722")];
const NEON_SIGNS = [hex("#ff3fa4"), hex("#2de2e6"), hex("#ffd23f"), hex("#9d6bff")];
const STOREYS = 5, STOREY_H = 3.6, BLOCK = 9; // the building over the road: its floors, and m out past the walls

/** A point ``u`` of the way from dense point i to j, ``off`` m left of the centerline, ``z`` m up. */
function between(track: Track, i: number, j: number, u: number, off: number, z: number): P3 {
  const a = edgePoint(track, i, off, z), b = edgePoint(track, j, off, z);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, z];
}

/** Under a building, Tokyo-style: tiled walls with a blue band, a ceiling, orange sodium lamps
 * along both walls; outside, the building over the road, its walls rising either side with rows
 * of windows (most of them lit), its roof, and over each mouth its facade, a neon sign over the
 * road. */
function cityTunnel(p: Painter, track: Track, tn: Tunnel): void {
  const hw = HALF_WIDTH + 0.4, top = TUNNEL_H, out = hw + BLOCK, roof = top + STOREYS * STOREY_H;
  for (let k = 0; k < tn.n; k += 3) {
    const i = track.wrap(tn.start + k), j = track.wrap(tn.start + Math.min(tn.n, k + 3)), n = k / 3;
    const zi = track.elev[i], zj = track.elev[j];
    const [tx, ty] = track.tangent(i);
    const P = (q: number, off: number, z: number) => edgePoint(track, q, off, z);
    // inside: the walls face the road, the ceiling faces down
    face(p, [P(i, hw, zi), P(j, hw, zj), P(j, hw, zj + top), P(i, hw, zi + top)], TILE, [ty, -tx, 0], 0.05);
    face(p, [P(j, -hw, zj), P(i, -hw, zi), P(i, -hw, zi + top), P(j, -hw, zj + top)], shade(TILE, 0.86), [-ty, tx, 0], 0.05);
    face(p, [P(i, hw, zi + 1.0), P(j, hw, zj + 1.0), P(j, hw, zj + 1.3), P(i, hw, zi + 1.3)], TILE_BAND, [ty, -tx, 0], 0.04);
    face(p, [P(j, -hw, zj + 1.0), P(i, -hw, zi + 1.0), P(i, -hw, zi + 1.3), P(j, -hw, zj + 1.3)], shade(TILE_BAND, 0.86),
         [-ty, tx, 0], 0.04);
    face(p, [P(i, -hw, zi + top), P(j, -hw, zj + top), P(j, hw, zj + top), P(i, hw, zi + top)], TUNNEL_TOP, DOWN, 0.06);
    if (n % 2 === 0) {
      for (const off of [hw - 0.06, -hw + 0.06]) {
        face(p, [P(i, off, zi + 4.3), P(j, off, zj + 4.3), P(j, off, zj + 4.6), P(i, off, zi + 4.6)], SODIUM, null, -0.05);
      }
    }
    // outside: the building's walls along the road, facing out, and its roof
    face(p, [P(i, out, zi), P(j, out, zj), P(j, out, zj + roof), P(i, out, zi + roof)], FACADE, [-ty, tx, 0], 0.1);
    face(p, [P(j, -out, zj), P(i, -out, zi), P(i, -out, zi + roof), P(j, -out, zj + roof)], shade(FACADE, 0.82), [ty, -tx, 0], 0.1);
    face(p, [P(i, -out, zi + roof), P(j, -out, zj + roof), P(j, out, zj + roof), P(i, out, zi + roof)], ROOF, UP, 0.1);
    // a window a storey on each wall, most of them lit
    for (let f = 0; f < STOREYS + 1; f++) {
      const z0 = (zi + zj) / 2 + 0.9 + f * STOREY_H;
      for (const side of [1, -1]) {
        const lit = WINDOWS[Math.floor(jag(n * 13 + f * 7 + (side > 0 ? 0 : 5), 31) * 4.6) % 4];
        const W0 = (u: number, z: number) => between(track, i, j, u, side * out, z);
        face(p, [W0(0.18, z0), W0(0.82, z0), W0(0.82, z0 + 1.7), W0(0.18, z0 + 1.7)], lit,
             [-side * ty, side * tx, 0], 0.09);
      }
    }
  }
  // each end: the building's facade beside and over the mouth, its windows, and a neon sign
  for (const [q, dir] of [[tn.start, -1], [track.wrap(tn.start + tn.n), 1]] as const) {
    const [tx, ty] = track.tangent(q);
    const z = track.elev[q];
    const L = (off: number, zz: number): P3 => edgePoint(track, q, off, z + zz);
    const fwd: P3 = [tx * dir, ty * dir, 0];
    face(p, [L(-out, top), L(out, top), L(out, roof), L(-out, roof)], FACADE, fwd, -0.1);
    face(p, [L(hw, 0), L(out, 0), L(out, top), L(hw, top)], FACADE, fwd, -0.1);
    face(p, [L(-out, 0), L(-hw, 0), L(-hw, top), L(-out, top)], FACADE, fwd, -0.1);
    face(p, [L(-hw - 0.5, top - 0.4), L(hw + 0.5, top - 0.4), L(hw + 0.5, top), L(-hw - 0.5, top)], shade(TILE, 0.7), fwd, -0.11);
    for (let f = 1; f < STOREYS + 1; f++) {
      for (let o = -out + 1; o < out - 1.5; o += 2.6) {
        if (f === 1 && Math.abs(o + 0.6) < 5.5) continue; // (the sign hangs there)
        const lit = WINDOWS[Math.floor(jag(Math.round(o * 3) + f * 17 + (dir > 0 ? 50 : 0), 37) * 4.6) % 4];
        const z0 = top + 0.9 + (f - 1) * STOREY_H;
        face(p, [L(o, z0), L(o + 1.3, z0), L(o + 1.3, z0 + 1.7), L(o, z0 + 1.7)], lit, fwd, -0.11);
      }
    }
    // the sign: a bright border round a dark panel with a few bright strokes on it
    const neon = NEON_SIGNS[(Math.abs(q) * 7) % NEON_SIGNS.length], z0 = top + 0.5, z1 = top + 3.1;
    face(p, [L(-5, z0), L(5, z0), L(5, z1), L(-5, z1)], neon, fwd, -0.12);
    face(p, [L(-4.7, z0 + 0.3), L(4.7, z0 + 0.3), L(4.7, z1 - 0.3), L(-4.7, z1 - 0.3)], hex("#16101f"), fwd, -0.13);
    for (let g = 0; g < 4; g++) {
      const o = -4.1 + g * 2.15, kind = jag(q + g, 43);
      face(p, [L(o, z0 + 0.7), L(o + 1.5, z0 + 0.7), L(o + 1.5, z0 + 0.95), L(o, z0 + 0.95)], neon, fwd, -0.14);
      face(p, [L(o + 0.6, z0 + 0.7), L(o + 0.9, z0 + 0.7), L(o + 0.9, z1 - 0.7), L(o + 0.6, z1 - 0.7)], neon, fwd, -0.14);
      if (kind > 0.4) face(p, [L(o, z1 - 0.95), L(o + 1.5, z1 - 0.95), L(o + 1.5, z1 - 0.7), L(o, z1 - 0.7)], neon, fwd, -0.14);
    }
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

/** Jump ramps: a wedge in yellow and black stripes from its foot to its lip, measured along the
 * road the way the race measures it, so a kart drives up exactly the wedge it is seen on. */
export function rampFaces(p: Painter, track: Track, f: Features, theme: Theme): void {
  // (seven stripes, each about 1.6 m: narrower ones strobed as a kart drove over them at speed)
  const hw = HALF_WIDTH, stripes = 7, len = RAMP_LEN / stripes;
  for (const r of f.ramps) {
    if (!near(p, track, r.start)) continue;
    const P = (u: number, off: number, z: number) => alongPoint(track, r.start, u, off, z);
    for (let k = 0; k < stripes; k++) {
      const u0 = k * len, u1 = (k + 1) * len, h0 = (RAMP_HEIGHT * u0) / RAMP_LEN, h1 = (RAMP_HEIGHT * u1) / RAMP_LEN;
      const [tx, ty] = track.tangent(track.stepAlong(r.start, u0).i);
      face(p, [P(u0, -hw, h0), P(u1, -hw, h1), P(u1, hw, h1), P(u0, hw, h0)], STRIPE[k & 1], [0, 0, 1], -0.3, 1, true);
      // the sides wear the circuit's kerb colours, so a ramp reads from across the infield
      const side = shade(theme.kerb[k & 1], 0.82);
      face(p, [P(u0, hw, 0), P(u1, hw, 0), P(u1, hw, h1), P(u0, hw, h0)], side, [-ty, tx, 0], -0.2);
      face(p, [P(u1, -hw, 0), P(u0, -hw, 0), P(u0, -hw, h0), P(u1, -hw, h1)], side, [ty, -tx, 0], -0.2);
    }
    const [tx, ty] = track.tangent(track.stepAlong(r.start, RAMP_LEN).i);
    const L = (off: number, z: number) => P(RAMP_LEN, off, z);
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

/** A point ``u`` m along a boost pad from its start and ``v`` m across it from its middle, on
 * the road under it (following the road's bends). */
function padPoint(track: Track, pad: Pad, u: number, v: number): P3 {
  const { i, w } = track.stepAlong(pad.start, u), j = track.wrap(i + 1);
  const a = edgePoint(track, i, pad.offset + v, 0), b = edgePoint(track, j, pad.offset + v, 0);
  const z = (track.elev[i] ?? 0) * (1 - w) + (track.elev[j] ?? 0) * w + 0.05;
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, z];
}

const PAD_PLATE = hex("#7a2e12"), PAD_GLOW = [hex("#ff8a1f"), hex("#fff2a8")];

/** A convex polygon in a pad's own terms (m along it, m across it), cut to the part ``ua`` to
 * ``ub`` m along it. */
function clipAlong(poly: [number, number][], ua: number, ub: number): [number, number][] {
  let out = poly;
  for (const [lim, keep] of [[ua, 1], [ub, -1]]) {
    const was = out;
    out = [];
    for (let k = 0; k < was.length; k++) {
      const a = was[k], b = was[(k + 1) % was.length];
      const ain = (a[0] - lim) * keep >= 0, bin = (b[0] - lim) * keep >= 0;
      if (ain) out.push(a);
      if (ain !== bin) out.push([lim, a[1] + ((b[1] - a[1]) * (lim - a[0])) / (b[0] - a[0])]);
    }
  }
  return out;
}

/** The part of boost pad ``pad`` from ``ua`` to ``ub`` m along it: its plate, in pieces that follow
 * the road round a bend, and the chevrons on it, pulsing forward at ``time``. */
function padPart(p: Painter, track: Track, pad: Pad, ua: number, ub: number, time: number): void {
  const P = (u: number, v: number) => padPoint(track, pad, u, v);
  const pieces = Math.max(1, Math.ceil((ub - ua) / 1.4));
  for (let q = 0; q < pieces; q++) {
    const u0 = ua + ((ub - ua) * q) / pieces, u1 = ua + ((ub - ua) * (q + 1)) / pieces;
    face(p, [P(u0, -PAD_HALF), P(u1, -PAD_HALF), P(u1, PAD_HALF), P(u0, PAD_HALF)], PAD_PLATE, UP, 0, 1, true);
  }
  for (let c = 0; c < 3; c++) {
    const u0 = 1 + c * 2;
    if (u0 + 2 <= ua || u0 >= ub) continue;
    const col = mix(PAD_GLOW[0], PAD_GLOW[1], 0.5 + 0.5 * Math.sin(time * 9 - c * 1.6));
    // a chevron pointing along the road: two arms meeting at the tip
    const arms: [number, number][][] = [
      [[u0, -PAD_HALF + 0.4], [u0 + 1.4, 0], [u0 + 2.0, 0], [u0 + 0.6, -PAD_HALF + 0.4]],
      [[u0 + 0.6, PAD_HALF - 0.4], [u0 + 2.0, 0], [u0 + 1.4, 0], [u0, PAD_HALF - 0.4]],
    ];
    for (const arm of arms) {
      const cut = clipAlong(arm, ua, ub);
      if (cut.length >= 3) face(p, cut.map(([u, v]) => P(u, v)), col, UP, 0, 1, true);
    }
  }
}

/** Boost pads on the ground (hillFaces draws the parts of them on a climb). */
export function padFaces(p: Painter, track: Track, f: Features, time: number): void {
  for (const pad of f.pads) {
    if (!near(p, track, pad.start)) continue;
    const from = p.faces.length;
    // the pad's steps between road points (m along it where each starts), and runs of them on the ground
    const us: number[] = [];
    for (let k = 0, u = 0; u < PAD_LEN && k < 40; k++, u = track.between(pad.start, track.wrap(pad.start + k))) us.push(u);
    const steps = us.length, end = (k: number) => (k < steps ? us[k] : PAD_LEN);
    for (let k = 0; k < steps;) {
      if (climbPieceAt(track, track.wrap(pad.start + k)) >= 0) { k++; continue; }
      const k0 = k;
      while (k < steps && climbPieceAt(track, track.wrap(pad.start + k)) < 0) k++;
      padPart(p, track, pad, us[k0], end(k), time);
    }
    // one decal at one depth, its far end's (the sort is stable: the plate goes down first, then
    // the chevrons on it), so every kart on it is drawn over it
    const mine = p.faces.slice(from);
    if (!mine.length) continue;
    const depth = Math.max(...mine.map((fc) => fc.z));
    for (const fc of mine) fc.z = depth;
  }
}
