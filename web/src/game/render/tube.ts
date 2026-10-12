// The harbor tunnel, drawn as road tunnels are built: the tube round the road (world/tube.ts) as
// rings of panels in sections of lining, an asphalt road in five lanes with white edge lines,
// dashed lane lines and amber cat's eyes, a concrete walkway along each side, the walls faced with
// pale tiles to head height under a dark cable tray and bare concrete above, a concrete roof with
// two rows of lights (each throwing a pool of light on the road below), lane signals on the roof,
// the start line's checks on the road, and boost pads wherever they lie round the tube (the road, a
// wall, the roof; the hover pads on the floor, a hover car on each). Along the lap the lining
// changes (world/tube.ts): stretches of glass over the tiles and across the roof, the harbor's water
// outside with the light coming down through it and fish going by, and stretches of neon, dark
// tiles under strips of coloured light; and on the outside wall of every bend, chevrons point the
// way round. Only the stretch of tube ahead of
// the camera is drawn, and where the circuit crosses itself the other stretch is left out (from
// inside the tube it is never seen, and drawn it would show through the walls). Everything is
// placed between road points where it lies, not snapped to the nearest one.

import { hex, mix, shade } from "../core/gfx";
import { PAD_HALF, PAD_LEN, type Features } from "../race/features";
import type { Theme } from "../themes";
import { SPACING, type Track } from "../world/track";
import { TUBE_FLOOR, TUBE_HALF, TUBE_LANE, TUBE_R, TUBE_ROUND, TUBE_ZONE, type TubeZone, tubeAt, tubeZone, wrapTube } from "../world/tube";
import { type P3, type Painter, face } from "./poly";

const ARC = Math.PI * TUBE_R; // m round each wall, from the road's edge to the roof
const WALL_END = TUBE_FLOOR + ARC;
const EDGE = 2.5 * TUBE_LANE; // m from the middle to each edge line (five lanes)
const WALK = TUBE_FLOOR - EDGE - 0.3; // m of walkway along each side of the road
const LANES = [-1.5, -0.5, 0.5, 1.5].map((k) => k * TUBE_LANE); // the lane lines
const FACETS = 8; // facets round each wall
const TILED = 2; // of them, how many from the walkway up are tiled (to head height)
const TILE_TOP = TUBE_FLOOR + (TILED / FACETS) * ARC;
const ROOF_LAMPS = [-4.5, 4.5]; // m either side of the roof's middle: its two rows of lights
/** How far round from the road's middle the roof is right over a point ``lat`` m left of it. */
const roofOver = (lat: number) => (lat >= 0 ? 1 : -1) * (WALL_END + TUBE_FLOOR - Math.abs(lat));
/** The ring's corners, m round the tube from the road's middle (rising past TUBE_HALF: on round). */
const RING: number[] = (() => {
  const half = [0, 2, TUBE_FLOOR - WALK, TUBE_FLOOR];
  for (let k = 1; k <= FACETS; k++) half.push(TUBE_FLOOR + (k / FACETS) * ARC);
  half.push((WALL_END + TUBE_HALF) / 2, TUBE_HALF);
  const back = half.slice(0, -1).reverse().map((u) => TUBE_ROUND - u); // down the other side, round to the start
  return [...half, ...back];
})();
const LAMP = hex("#fff2cc"), EYE = hex("#ffb52e"), SIGNAL = hex("#141518"), ARROW = hex("#3be27a");
// the glass: the water outside, deep at the walls and lighter over the roof, where the light comes
// down through it; the frames between the panes; the fish going by; and the lamps there, cooler
const DEEP = hex("#0a3550"), SHALLOW = hex("#2b86a8"), FRAME = hex("#1b2430"), FISH = hex("#08202e"), GLASS_LAMP = hex("#d6f6ff");
// neon: dark tiles, a strip of light along each wall at the top of the tiles and another higher up
const NEON = [hex("#ff3ec8"), hex("#2ee6ff")], NEON_LAMP = hex("#ffb8ee");
const CHEVRON = hex("#ffd23f"), CHEVRON_BACK = hex("#16171b");
/** The lamps' light in each lining. */
const LAMP_OF: Record<TubeZone, number> = { tiles: LAMP, glass: GLASS_LAMP, neon: NEON_LAMP };
const SEEN = 260; // m of tube drawn ahead of the camera (past the far plane, where the fog is whole: drawn
// short of it, the far end of a straight showed as a dark disc with an edge)
// (the panels are the backdrop to all else in the tube: sorted 7 m deeper than they are, so a
// panel goes down before a kart, a pad or a line lying on it, even one the length of a pad;
// anything a bend's wall really hides is much further behind it than that)
const BACKDROP = 7;
// (the lines, lights and signs lying on the panels: a tenth of a meter nearer; a margin of 2 m let
// lines on a far wall show through the nearer wall of a bend)
const MARKS = BACKDROP - 0.1;

/** Where the point ``u`` m round the tube at road point i is, ``h`` m in off its surface, and how
 * far that surface is turned from facing up. */
export function tubePoint(track: Track, i: number, u: number, h = 0): { p: P3; tilt: number } {
  const [tx, ty] = track.tangent(i), lx = -ty, ly = tx;
  const q = tubeAt(u), nl = -Math.sin(q.tilt), nz = Math.cos(q.tilt); // the surface's inward normal
  const off = q.lat + nl * h;
  return { p: [track.xs[i] + lx * off, track.ys[i] + ly * off, (track.elev[i] ?? 0) + q.z + nz * h], tilt: q.tilt };
}

/** The inward normal of the tube's surface at ``u`` m round it, at road point i (tipped back
 * where the road climbs, forward where it falls: taken level, the floor of a climb ahead faced
 * away from a camera below it, and was culled). Not of unit length. */
export function normalAt(track: Track, i: number, u: number): P3 {
  const [tx, ty] = track.tangent(i), t = tubeAt(u).tilt, s = Math.sin(t), c = Math.cos(t), g = slopeAt(track, i);
  return [ty * s - g * tx * c, -tx * s - g * ty * c, c];
}

/** The road's rise per m at road point i, across the points either side of it. */
function slopeAt(track: Track, i: number): number {
  const a = track.wrap(i - 1), b = track.wrap(i + 1), run = track.between(a, b);
  return run > 0 ? ((track.elev[b] ?? 0) - (track.elev[a] ?? 0)) / run : 0;
}

/** The point ``u`` m round the tube, ``h`` m in off its surface, ``w`` of the way on from road point
 * i to the next, and the surface's normal there (not of unit length). */
export function tubeBetween(track: Track, i: number, w: number, u: number, h = 0): { p: P3; n: P3 } {
  const a = tubePoint(track, i, u, h).p, na = normalAt(track, i, u), j = track.wrap(i + 1);
  if (w <= 0 || j === i) return { p: a, n: na };
  const b = tubePoint(track, j, u, h).p, nb = normalAt(track, j, u);
  return { p: lerp3(a, b, w), n: lerp3(na, nb, w) };
}

/** A point in the tube's air ``w`` of the way on from road point i: ``lat`` m left of the road's
 * middle and ``z`` m off its floor (as world/tube.ts measures them), and which way is up for
 * something there turned ``roll`` (as a surface's tilt: 0 the right way up, ±π upside down): a kart
 * falling off a wall, or in the rescue drone's hands. */
export function tubeInside(track: Track, i: number, w: number, lat: number, z: number, roll: number): { p: P3; n: P3 } {
  const j = track.wrap(i + 1);
  const at = (k: number): P3 => {
    const [tx, ty] = track.tangent(k);
    return [track.xs[k] - ty * lat, track.ys[k] + tx * lat, (track.elev[k] ?? 0) + z];
  };
  const p = w > 0 && j !== i ? lerp3(at(i), at(j), w) : at(i);
  const [tx, ty] = track.tangent(i), s = Math.sin(roll), c = Math.cos(roll);
  return { p, n: [ty * s, -tx * s, c] };
}

/** Where the point (x, y) of the race's flat terms lies along the road and round the tube: between
 * road points, not at the nearest one (snapped to road points half a meter apart, everything in the
 * tube shook as it moved). The road point before it and how far on from it (``w``), its arc
 * length, and how far round the tube it is. */
export function tubePlace(track: Track, x: number, y: number, hint: number): { i: number; w: number; s: number; u: number } {
  const i = track.foot(x, y, hint), u = track.offset(x, y, i), a = track.along(x, y, i);
  const j = track.wrap(a >= 0 ? i + 1 : i - 1);
  let lo = i, w = 0;
  if (j !== i) {
    // (the gap between the two road points, measured u m round: the flat terms stretch and
    // squeeze the road's length away from its middle on a bend)
    const [ax, ay] = track.tangent(i), [bx, by] = track.tangent(j);
    const span = Math.hypot(track.xs[j] - by * u - (track.xs[i] - ay * u), track.ys[j] + bx * u - (track.ys[i] + ax * u)) || SPACING;
    const f = Math.min(1, Math.abs(a) / span);
    if (a >= 0) w = f;
    else { lo = j; w = 1 - f; }
  }
  return { i: lo, w, s: wrapS(track, track.s[lo] + w * track.between(lo, track.wrap(lo + 1))), u };
}

/** Where a kart is round the tube, by its own place (its road point, how far on, how far round;
 * race/kart.ts), as tubePlace says where a point of the flat terms is. */
export function kartPlace(track: Track, k: { idx: number; tubeW: number; offset: number }): { i: number; w: number; s: number; u: number } {
  return { i: k.idx, w: k.tubeW, s: wrapS(track, track.s[k.idx] + k.tubeW * track.between(k.idx, track.wrap(k.idx + 1))), u: k.offset };
}

/** Which way a camera ``s`` m along the road and ``u`` m round the tube sees kart ``k`` from, as an
 * angle in the race's flat terms (as the kart's heading is), worked out round the tube: from
 * where the camera is in flat terms, a kart crossing the middle of the roof on a bend was seen
 * from the wrong side for a frame (behind the camera, round the inside, the flat terms fold over). */
export function tubeView(track: Track, s: number, u: number, k: { idx: number; tubeW: number; offset: number }): number {
  const q = kartPlace(track, k), [tx, ty] = track.tangent(q.i);
  return Math.atan2(ty, tx) + Math.atan2(wrapTube(q.u - u), around(track, s, q.s));
}

/** The road's height ``w`` of the way on from road point i. */
export const elevBetween = (track: Track, i: number, w: number): number =>
  (track.elev[i] ?? 0) + ((track.elev[track.wrap(i + 1)] ?? 0) - (track.elev[i] ?? 0)) * w;

/** Where the point (x, y) of the race's flat terms, ``h`` m up (as the race measures height),
 * really is round the tube, and the surface's normal there. */
export function tubeSpot(track: Track, x: number, y: number, h: number, hint: number): { p: P3; n: P3 } {
  const q = tubePlace(track, x, y, hint);
  return tubeBetween(track, q.i, q.w, q.u, h - elevBetween(track, q.i, q.w));
}

/** The tube's frame ``w`` of the way on from road point i, ``u`` m round: which way is along the
 * tube (climbing with the road), which way is on round it, and which way its surface faces (all of
 * unit length). */
export function tubeFrame(track: Track, i: number, w: number, u: number): { along: P3; round: P3; up: P3 } {
  const j = track.wrap(i + 1), [ax, ay] = track.tangent(i), [bx, by] = track.tangent(j);
  const tx = ax + (bx - ax) * w, ty = ay + (by - ay) * w, tl = Math.hypot(tx, ty) || 1;
  // (the road's rise, eased from one road point to the next: taken a road point at a time, it
  // changed in steps, and a camera tipping with it shook the whole picture)
  const g = slopeAt(track, i) + (slopeAt(track, j) - slopeAt(track, i)) * w;
  const along = unit([tx / tl, ty / tl, g]);
  const t = tubeAt(u).tilt, c = Math.cos(t), sn = Math.sin(t);
  const round = unit([(-ty / tl) * c, (tx / tl) * c, sn]);
  const up = unit(lerp3(normalAt(track, i, u), normalAt(track, j, u), w));
  return { along, round, up };
}

const lerp3 = (a: P3, b: P3, w: number): P3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
const unit = (v: P3): P3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Arc lengths around which the tube is not drawn while the camera is at ``s``: the other pass of
 * each crossing within sight (only within 140 m of it, the two tubes were drawn cutting through
 * each other further off, up to the far end of the tube drawn). */
function hidden(track: Track, s: number): [number, number][] {
  const out: [number, number][] = [];
  // (the pass the camera is not on, as far off as the tube is drawn; deciding by which pass it is
  // nearer to along the road, so it never leaves out the road ahead of it, the other pass's turn)
  for (const b of track.bridges) {
    const lo = track.s[b.lower], hi = b.centerS, dLo = Math.abs(around(track, s, lo)), dHi = Math.abs(around(track, s, hi));
    if (dLo <= dHi && dLo < SEEN + 50) out.push([hi - 48, hi + 48]);
    if (dHi < dLo && dHi < SEEN + 50) out.push([lo - 48, lo + 48]);
  }
  return out;
}

/** Whether arc length ``s`` lies in the tube left out while the camera is at ``s0`` (what is there,
 * a kart, a box, is not drawn either: it would hang in the camera's own tube). */
export function tubeHides(track: Track, s0: number): (s: number) => boolean {
  const skip = hidden(track, s0);
  return (s) => skip.some(([a, b]) => around(track, a, s) >= 0 && around(track, s, b) >= 0);
}

/** m from arc length ``a`` forward to ``b`` (around a locked lap, either way). */
function around(track: Track, a: number, b: number): number {
  if (!track.locked) return b - a;
  const L = track.length;
  return ((((b - a) % L) + L * 1.5) % L) - L / 2;
}

/** The tube around road point ``from`` (where the camera is), drawn the way the camera looks: on up
 * the road, or (``back``, the rear-view mirror, a drone looking back at the grid) back down it; and
 * ``behind`` road points the other way (more for a camera looking across the tube). */
export function tubeFaces(p: Painter, track: Track, theme: Theme, from: number, f: Features, now: number, back = false,
                          behind = 20): void {
  if (track.count < 2) return;
  const s0 = track.s[from], dir = back ? -1 : 1;
  const skip = hidden(track, s0);
  const out = (s: number) => skip.some(([a, b]) => around(track, a, s) >= 0 && around(track, s, b) >= 0);
  const road = theme.road, walkway = theme.shoulder, concrete = theme.ground, tile = theme.kerb[0], tray = theme.kerb[1];
  const roof = shade(theme.ground[1], 0.88), line = theme.edge;
  // pieces on a grid of road points (3 long near the camera, 6 further off, 12 far off), each
  // starting at a whole multiple of its length, and shaded in sections of lining 12 road points
  // long, so a piece's edges and its shade stay put as the camera moves through (laid from
  // wherever the camera was, they slid along with it and shimmered)
  let i = track.wrap(from - dir * behind);
  for (let guard = 0; guard < 2000; guard++) {
    const ahead = dir * around(track, s0, track.s[i]);
    if (ahead > SEEN) break;
    const lod = ahead < 60 ? 3 : ahead < 120 ? 6 : 12, m = ((i % lod) + lod) % lod;
    const step = dir > 0 ? lod - m : m || lod;
    let j = i + dir * step;
    if (!track.locked && (j >= track.count || j < 0)) break;
    j = track.wrap(j);
    const [a, b] = dir > 0 ? [i, j] : [j, i];
    if (!out(track.s[a])) piece(a, b, ahead);
    i = j;
  }
  marks();
  pads(p, track, f, from, now, dir);
  startLine(p, track, s0);
  glass(p, track, from, s0, behind * 0.6, dir, now, out);
  chevrons(p, track, from, s0, dir, out);

  function piece(i: number, j: number, ahead: number): void {
    const section = Math.floor(i / 12) & 1, zone = tubeZone(track.s[i]);
    for (let k = 0; k < RING.length - 1; k++) {
      const u0 = RING[k], u1 = RING[k + 1], um = (u0 + u1) / 2, a = Math.abs(wrapTube(um));
      let color = a < TUBE_FLOOR - WALK ? shade(road, section ? 1 : 1.04)
        : a < TUBE_FLOOR ? walkway
        : a < TILE_TOP ? shade(tile, (section ? 1 : 0.95) * (zone === "neon" ? 0.42 : 1))
        : a < WALL_END ? concrete[section]
        : shade(roof, section ? 1 : 1.06);
      if (zone === "glass" && a >= TILE_TOP) {
        // the water outside: lighter the higher round (the roof under the light), and the light
        // coming down through it rippling over the panes
        const up = Math.min(1, (a - TILE_TOP) / (WALL_END + TUBE_FLOOR - TILE_TOP));
        const ripple = 0.9 + 0.1 * Math.sin(track.s[i] * 0.35 + now * 1.7 + a * 0.5) * Math.sin(now * 0.9 + a * 0.21);
        color = shade(mix(DEEP, SHALLOW, up * up), ripple);
      } else if (zone === "neon" && a >= TILE_TOP) color = shade(color, 0.55);
      face(p, [tubePoint(track, i, u0).p, tubePoint(track, j, u0).p, tubePoint(track, j, u1).p, tubePoint(track, i, u1).p],
           color, normalAt(track, i, um), BACKDROP);
    }
    if (ahead > 140) return;
    // the edge lines, and the cable tray along the top of the tiles
    for (const [u, w, c] of [[EDGE, 0.08, line], [-EDGE, 0.08, line], [TILE_TOP, 0.12, tray], [-TILE_TOP, 0.12, tray]]) {
      face(p, [tubePoint(track, i, u - w, 0.02).p, tubePoint(track, j, u - w, 0.02).p, tubePoint(track, j, u + w, 0.02).p,
               tubePoint(track, i, u + w, 0.02).p], c, normalAt(track, i, u), MARKS);
    }
  }

  /** The lane lines' dashes, the cat's eyes, the lights down the roof (and the pools of light they
   * throw) and the lane signals, each where it falls along the road (drawn
   * with whichever piece they fell in, they jumped about as the pieces did). */
  function marks(): void {
    const rear = behind * 0.6; // (m)
    const near = (s: number) => {
      const d = dir * around(track, s0, s);
      return d > -rear && d < 140 && !out(s);
    };
    const at = (s: number) => track.stepAlong(from, around(track, s0, s));
    const lo = dir > 0 ? s0 - rear : s0 - 140, hi = dir > 0 ? s0 + 140 : s0 + rear;
    /** Every ``period`` m from the lap's first road point, in [lo, hi] (on a locked lap, counted
     * afresh each lap round, so a mark near the line is the same mark from either side of it). */
    const each = (period: number, fn: (s: number, k: number) => void) => {
      const L = track.length;
      for (const lap of track.locked ? [-1, 0, 1] : [0]) {
        const base = lap * L;
        for (let k = Math.max(0, Math.ceil((lo - base) / period)); k * period + base <= hi; k++) {
          if (track.locked && k * period >= L) break;
          fn(k * period, k);
        }
      }
    };
    /** A patch on the tube from ``s`` for ``len`` m, ``u0`` to ``u1`` round it, ``h`` m off it. */
    const patch = (s: number, len: number, u0: number, u1: number, c: number, h = 0.02, alpha = 1, bias = MARKS) => {
      const a = at(s), b = at(wrapS(track, s + len)), n = normalAt(track, a.i, (u0 + u1) / 2);
      face(p, [tubeBetween(track, a.i, a.w, u0, h).p, tubeBetween(track, b.i, b.w, u0, h).p,
               tubeBetween(track, b.i, b.w, u1, h).p, tubeBetween(track, a.i, a.w, u1, h).p], c, n, bias, alpha);
    };
    // dashed lane lines, 3 m on and 9 m off, and cat's eyes along the edge lines
    each(12, (sa) => {
      if (!near(sa)) return;
      for (const u of LANES) patch(sa, 3, u - 0.07, u + 0.07, line);
    });
    each(6, (sa) => {
      if (!near(sa)) return;
      for (const u of [-(EDGE - 0.25), EDGE - 0.25]) patch(sa, 0.16, u - 0.08, u + 0.08, EYE, 0.03);
    });
    // a light every 4.5 m down each of the roof's two rows, a glow round it, and its pool on the
    // road (in each lining's light; in the neon, now one colour, now the other)
    each(4.5, (sl, k) => {
      if (!near(sl)) return;
      const zone = tubeZone(sl), lamp = zone === "neon" ? NEON[k & 1] : LAMP_OF[zone];
      patch(sl - 1.6, 3.2, -EDGE + 0.6, EDGE - 0.6, lamp, 0.01, zone === "neon" ? 0.1 : 0.07, MARKS + 0.02); // the pool of light on the road
      for (const lat of ROOF_LAMPS) {
        const u = roofOver(lat);
        patch(sl - 1.2, 2.4, u - 1.2, u + 1.2, lamp, 0.01, 0.22, MARKS + 0.01);
        patch(sl - 0.6, 1.2, u - 0.28, u + 0.28, lamp, 0.03);
      }
    });
    // the neon's strips of light along each wall, at the top of the tiles and higher up
    each(6, (sn, k) => {
      if (!near(sn) || tubeZone(sn) !== "neon") return;
      const glow = 0.75 + 0.25 * Math.sin(now * 3 + k * 0.6);
      for (const side of [-1, 1]) {
        patch(sn, 6.02, side * (TILE_TOP + 0.05) - 0.12, side * (TILE_TOP + 0.05) + 0.12, shade(NEON[0], glow), 0.03);
        const hi = side * (TUBE_FLOOR + ARC * 0.55);
        patch(sn, 6.02, hi - 0.12, hi + 0.12, shade(NEON[1], glow), 0.03);
      }
    });
    // lane signals on the roof over each lane, a green arrow on each: every lane open
    each(160, (sg) => {
      if (!near(sg)) return;
      for (const lat of [-2, -1, 0, 1, 2].map((k) => k * TUBE_LANE)) {
        const u = lat === 0 ? TUBE_HALF : roofOver(lat);
        patch(sg - 0.45, 0.9, u - 0.45, u + 0.45, SIGNAL, 0.02);
        const a = at(sg - 0.3), b = at(sg + 0.3), nm = normalAt(track, a.i, u);
        face(p, [tubeBetween(track, a.i, a.w, u - 0.3, 0.03).p, tubeBetween(track, b.i, b.w, u, 0.03).p,
                 tubeBetween(track, a.i, a.w, u + 0.3, 0.03).p], ARROW, nm, MARKS - 0.01);
      }
    });
  }
}

/** Arc length ``s`` folded into the lap once it is locked (around the start of the dense road). */
function wrapS(track: Track, s: number): number {
  if (!track.locked) return s;
  const L = track.length;
  return ((s % L) + L) % L;
}

/** Boost pads round the tube: a plate and three chevrons, laid on the surface wherever the pad is,
 * each one decal at one depth; a hover pad (on the floor) is blue, with a hover car on it seen from
 * above (its four pods glowing) inside a ring that pulses. */
function pads(p: Painter, track: Track, f: Features, from: number, now: number, dir: number): void {
  const s0 = track.s[from];
  for (const pad of f.pads) {
    const ahead = dir * around(track, s0, pad.s0);
    if (ahead < -10 || ahead > 150) continue;
    const at = (u: number, v: number): P3 => {
      const { i, w } = track.stepAlong(pad.start, u); // (by arc length, as the race measures the pad)
      return tubeBetween(track, i, w, pad.offset + v, 0.05).p;
    };
    const nrm = normalAt(track, pad.start, pad.offset), from0 = p.faces.length;
    for (let q = 0; q < 5; q++) {
      const u0 = (PAD_LEN * q) / 5, u1 = (PAD_LEN * (q + 1)) / 5;
      face(p, [at(u0, -PAD_HALF), at(u1, -PAD_HALF), at(u1, PAD_HALF), at(u0, PAD_HALF)], hex(pad.hover ? "#123a6e" : "#7a2e12"), nrm, 0, 1, true);
    }
    if (pad.hover) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 7), ring = mix(hex("#2a7fd0"), hex("#9ff0ff"), pulse);
      const body = hex("#dfe9f8"), pod = mix(hex("#63c8ff"), hex("#ffffff"), pulse);
      const cx = PAD_LEN / 2, r0 = 2.15 + 0.15 * pulse, r1 = r0 + 0.35;
      for (let q = 0; q < 12; q++) { // the ring
        const a0 = (q / 12) * Math.PI * 2, a1 = ((q + 1) / 12) * Math.PI * 2;
        const pt = (r: number, a: number) => at(cx + Math.cos(a) * r, Math.sin(a) * r * 0.95);
        face(p, [pt(r0, a0), pt(r1, a0), pt(r1, a1), pt(r0, a1)], ring, nrm, 0, 1, true);
      }
      face(p, [at(cx - 1.5, -0.75), at(cx + 1.5, -0.75), at(cx + 1.5, 0.75), at(cx - 1.5, 0.75)], body, nrm, 0, 1, true); // the car
      face(p, [at(cx - 0.2, -0.5), at(cx + 0.7, -0.5), at(cx + 0.7, 0.5), at(cx - 0.2, 0.5)], hex("#2c3d5c"), nrm, 0, 1, true); // its screen
      for (const [du, dv] of [[-1.1, -1], [-1.1, 1], [1.1, -1], [1.1, 1]]) { // its four pods, out at the corners
        face(p, [at(cx + du - 0.35, dv - 0.25), at(cx + du + 0.35, dv - 0.25), at(cx + du + 0.35, dv + 0.25), at(cx + du - 0.35, dv + 0.25)],
             pod, nrm, 0, 1, true);
      }
    } else for (let c = 0; c < 3; c++) {
      const u0 = 1 + c * 2, col = mix(hex("#ff8a1f"), hex("#fff2a8"), 0.5 + 0.5 * Math.sin(now * 9 - c * 1.6));
      face(p, [at(u0, -PAD_HALF + 0.4), at(u0 + 1.4, 0), at(u0 + 2.0, 0), at(u0 + 0.6, -PAD_HALF + 0.4)], col, nrm, 0, 1, true);
      face(p, [at(u0 + 0.6, PAD_HALF - 0.4), at(u0 + 2.0, 0), at(u0 + 1.4, 0), at(u0, PAD_HALF - 0.4)], col, nrm, 0, 1, true);
    }
    const mine = p.faces.slice(from0);
    if (!mine.length) continue;
    const depth = Math.max(...mine.map((fc) => fc.z));
    for (const fc of mine) fc.z = depth;
  }
}

/** The start line's two rows of checks across the floor, and its grid slots. */
function startLine(p: Painter, track: Track, s0: number): void {
  const si = track.startIndex;
  if (si < 0 || Math.abs(around(track, s0, track.s[si])) > 120) return;
  const cells = 14, cell = (2 * TUBE_FLOOR) / cells, from0 = p.faces.length;
  for (let r = 0; r < 2; r++) {
    const a = track.wrap(si - 2 + r * 2), b = track.wrap(a + 2);
    for (let c = 0; c < cells; c++) {
      const u0 = -TUBE_FLOOR + c * cell, u1 = u0 + cell;
      face(p, [tubePoint(track, a, u0, 0.03).p, tubePoint(track, b, u0, 0.03).p, tubePoint(track, b, u1, 0.03).p,
               tubePoint(track, a, u1, 0.03).p], (r + c) & 1 ? hex("#1a1a1a") : hex("#f4f4f4"), normalAt(track, a, 0), 0, 1, true);
    }
  }
  const mine = p.faces.slice(from0);
  if (!mine.length) return;
  const depth = Math.max(...mine.map((fc) => fc.z));
  for (const fc of mine) fc.z = depth;
}

/** The glass's frames, a ring of steel every 4 m over the glass, and the fish going by outside it, a
 * few schools to each stretch, each at its own height round the tube, swimming its own way. (Placed
 * by stepping from the camera's road point: from the lap's first, every one cost a walk down the road.) */
function glass(p: Painter, track: Track, from: number, s0: number, rear: number, dir: number, now: number,
               out: (s: number) => boolean): void {
  const lo = dir > 0 ? s0 - rear : s0 - 130, hi = dir > 0 ? s0 + 130 : s0 + rear;
  const end = track.locked ? Infinity : track.s[track.count - 1] ?? 0;
  const fold = (s: number) => wrapS(track, s);
  const spot = (s: number) => (s > end ? null : track.stepAlong(from, around(track, s0, s)));
  for (let s = Math.ceil(lo / 4) * 4; s <= hi; s += 4) {
    const sw = fold(s);
    if (tubeZone(sw) !== "glass" || out(sw)) continue;
    const a = spot(s), b = spot(s + 0.3);
    if (!a || !b) continue;
    for (const [u0, u1] of [[TILE_TOP, WALL_END + TUBE_FLOOR], [TUBE_ROUND - WALL_END - TUBE_FLOOR, TUBE_ROUND - TILE_TOP]]) {
      for (let q = 0; q < 6; q++) {
        const ua = u0 + ((u1 - u0) * q) / 6, ub = u0 + ((u1 - u0) * (q + 1)) / 6;
        face(p, [tubeBetween(track, a.i, a.w, ua, 0.03).p, tubeBetween(track, b.i, b.w, ua, 0.03).p,
                 tubeBetween(track, b.i, b.w, ub, 0.03).p, tubeBetween(track, a.i, a.w, ub, 0.03).p], FRAME,
             normalAt(track, a.i, (ua + ub) / 2), MARKS);
      }
    }
  }
  // fish: schools of six, each fish a body and a tail, outside the glass (drawn on it, behind the frames)
  for (let z = Math.floor(lo / TUBE_ZONE); z <= Math.floor(hi / TUBE_ZONE); z++) {
    if (tubeZone(fold(z * TUBE_ZONE + 1)) !== "glass") continue;
    for (let school = 0; school < 4; school++) {
      const seed = z * 7.31 + school * 3.17, way = school & 1 ? 1 : -1, speed = 2.2 + (school % 3) * 0.7;
      const side = school < 2 ? 1 : -1, u = side * (TILE_TOP + 2 + ((Math.sin(seed) + 1) / 2) * (WALL_END - TILE_TOP - 3));
      const head = z * TUBE_ZONE + ((((seed * 41.7 + way * speed * now) % TUBE_ZONE) + TUBE_ZONE) % TUBE_ZONE);
      for (let f = 0; f < 6; f++) {
        const sf = head - way * (f % 3) * 1.4 - (f > 2 ? 0.7 : 0), uf = u + (f > 2 ? 0.9 : 0) + Math.sin(now * 2 + f + seed) * 0.25;
        if (sf < lo || sf > hi || out(fold(sf))) continue;
        const a = spot(sf), b = spot(sf + way * 0.9), c = spot(sf - way * 0.35);
        if (!a || !b || !c) continue;
        const nrm = normalAt(track, a.i, uf);
        face(p, [tubeBetween(track, a.i, a.w, uf - 0.18, -0.06).p, tubeBetween(track, b.i, b.w, uf, -0.06).p,
                 tubeBetween(track, a.i, a.w, uf + 0.18, -0.06).p], FISH, nrm, MARKS + 0.03);
        face(p, [tubeBetween(track, a.i, a.w, uf, -0.06).p, tubeBetween(track, c.i, c.w, uf - 0.22, -0.06).p,
                 tubeBetween(track, c.i, c.w, uf + 0.22, -0.06).p], FISH, nrm, MARKS + 0.03);
      }
    }
  }
}

/** Chevrons on the outside wall of every bend tighter than 120 m, a little over the walkway, every 9
 * m round it: black boards, a yellow arrow on each pointing on round the bend. */
function chevrons(p: Painter, track: Track, from: number, s0: number, dir: number, out: (s: number) => boolean): void {
  const lo = dir > 0 ? s0 : s0 - 120, hi = dir > 0 ? s0 + 120 : s0;
  const end = track.locked ? Infinity : track.s[track.count - 1] ?? 0;
  const spot = (s: number) => track.stepAlong(from, around(track, s0, s));
  for (let s = Math.ceil(lo / 9) * 9; s <= hi; s += 9) {
    if (s + 2 > end || out(wrapS(track, s))) continue;
    const a = spot(s), kappa = track.curvature(a.i);
    if (Math.abs(kappa) < 1 / 120) continue;
    const side = -Math.sign(kappa); // (the outside of the bend: away from the way it turns)
    const b = spot(s + 1.8), m = spot(s + 0.7);
    const u0 = side * (TUBE_FLOOR + ARC * 0.09), u1 = side * (TUBE_FLOOR + ARC * 0.2), um = (u0 + u1) / 2;
    const nrm = normalAt(track, a.i, um);
    face(p, [tubeBetween(track, a.i, a.w, u0, 0.04).p, tubeBetween(track, b.i, b.w, u0, 0.04).p,
             tubeBetween(track, b.i, b.w, u1, 0.04).p, tubeBetween(track, a.i, a.w, u1, 0.04).p], CHEVRON_BACK, nrm, MARKS - 0.3);
    // the arrow (sorted well in front of its board: by its middle, nearer the board's far end, it was
    // drawn first and the board went over it)
    const tip = tubeBetween(track, b.i, b.w, um, 0.06).p; // (pointing on down the road, the way round)
    const t0 = tubeBetween(track, m.i, m.w, u0 + (u1 - u0) * 0.15, 0.06).p, t1 = tubeBetween(track, m.i, m.w, u1 - (u1 - u0) * 0.15, 0.06).p;
    face(p, [t0, tip, t1], CHEVRON, nrm, MARKS - 1.2);
  }
}
