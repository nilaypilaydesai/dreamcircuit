// The neon tunnel, drawn: the tube round the road (world/tube.ts) as rings of panels, a dark floor
// with a dashed middle line, walls and ceiling in panels of deep violet, glowing strips along the
// floor's edges, the middle of each wall and the ceiling's edges, rings of light every few meters
// sweeping past (fading as they near the camera), the start line's checks on the floor, and boost
// pads wherever they lie round the tube (the floor, a wall, the ceiling). Only the stretch of tube
// ahead of the camera is drawn, and where the circuit crosses itself the other stretch is left out
// (from inside the tube it is never seen, and drawn it would show through the walls). Everything is
// placed between road points where it lies, not snapped to the nearest one.

import { hex, mix, shade } from "../core/gfx";
import { PAD_HALF, PAD_LEN, type Features } from "../race/features";
import type { Theme } from "../themes";
import { SPACING, type Track } from "../world/track";
import { TUBE_FLOOR, TUBE_HALF, TUBE_R, TUBE_ROUND, tubeAt, wrapTube } from "../world/tube";
import { type P3, type Painter, face } from "./poly";

const WALL_END = TUBE_FLOOR + Math.PI * TUBE_R;
const MID_WALL = TUBE_FLOOR + (Math.PI * TUBE_R) / 2;
/** The ring's corners, m round the tube from the floor's middle (rising past TUBE_HALF: on round). */
const RING: number[] = (() => {
  const half = [0, TUBE_FLOOR / 2, TUBE_FLOOR];
  for (let k = 1; k <= 6; k++) half.push(TUBE_FLOOR + (k / 6) * Math.PI * TUBE_R);
  half.push((WALL_END + TUBE_HALF) / 2, TUBE_HALF);
  const back = half.slice(0, -1).reverse().map((u) => TUBE_ROUND - u); // down the other side, round to the start
  return [...half, ...back];
})();
const RING_GAP = 10.8; // m between rings of light
const SEEN = 230; // m of tube drawn ahead of the camera
// (the panels are the backdrop to all else in the tube: sorted 7 m deeper than they are, so a
// panel goes down before a kart, a pad or a strip of light lying on it, even one the length of a
// pad; anything a bend's wall really hides is much further behind it than that)
const BACKDROP = 7;
// (the strips of light, the dashes and the rings lying on the panels: sorted 2 m nearer than the
// panels, so one never swaps places with the panel under it as the camera moves; a tenth of a
// meter apart, a strip along the floor's edge blinked as the wall's panel beside it went over it)
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

/** Where the point (x, y) of the race's flat terms lies along the road and round the tube: between
 * road points, not at the nearest one (snapped to road points half a meter apart, everything in the
 * tube shook as it moved). The road point before it and how far on from it (``w``), its arc
 * length, and how far round the tube it is. */
export function tubePlace(track: Track, x: number, y: number, hint: number): { i: number; w: number; s: number; u: number } {
  const i = track.nearest(x, y, hint), u = track.offset(x, y, i), a = track.along(x, y, i);
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
 * each crossing the camera is near. */
function hidden(track: Track, s: number): [number, number][] {
  const out: [number, number][] = [];
  const near = (a: number) => Math.abs(around(track, s, a)) < 140;
  for (const b of track.bridges) {
    const lo = track.s[b.lower], hi = b.centerS;
    if (near(lo)) out.push([hi - 48, hi + 48]);
    if (near(hi)) out.push([lo - 48, lo + 48]);
  }
  return out;
}

/** m from arc length ``a`` forward to ``b`` (around a locked lap, either way). */
function around(track: Track, a: number, b: number): number {
  if (!track.locked) return b - a;
  const L = track.length;
  return ((((b - a) % L) + L * 1.5) % L) - L / 2;
}

/** The tube around road point ``from`` (where the camera is), drawn the way the camera looks: on up
 * the road, or (``back``, the rear-view mirror, a drone looking back at the grid) back down it. */
export function tubeFaces(p: Painter, track: Track, theme: Theme, from: number, f: Features, now: number, back = false): void {
  if (track.count < 2) return;
  const s0 = track.s[from], dir = back ? -1 : 1;
  const skip = hidden(track, s0);
  const out = (s: number) => skip.some(([a, b]) => around(track, a, s) >= 0 && around(track, s, b) >= 0);
  const panel = [theme.ground[0], theme.ground[1]], floor = theme.road, ceiling = shade(theme.ground[1], 0.78);
  const ringCols = [theme.kerb[0], theme.kerb[1]], strip = theme.edge, line = mix(theme.edge, hex("#ffffff"), 0.5);
  // pieces on a grid of road points (3 long near the camera, 6 further off, 12 far off), each
  // starting at a whole multiple of its length, and shaded in bands 12 road points long, so a
  // piece's edges and its shade stay put as the camera moves through (laid from wherever the camera
  // was, they slid along with it, and the floor's checks and the rings of light shimmered)
  let i = track.wrap(from - dir * 20);
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

  function piece(i: number, j: number, ahead: number): void {
    const band = Math.floor(i / 12) & 1;
    for (let k = 0; k < RING.length - 1; k++) {
      const u0 = RING[k], u1 = RING[k + 1], um = (u0 + u1) / 2, a = Math.abs(wrapTube(um));
      const color = a <= TUBE_FLOOR ? shade(floor, band ? 1 : 1.07)
        : a >= WALL_END ? shade(ceiling, (k + band) & 1 ? 1 : 1.1)
        : shade(panel[k & 1], band ? 1 : 1.06);
      face(p, [tubePoint(track, i, u0).p, tubePoint(track, j, u0).p, tubePoint(track, j, u1).p, tubePoint(track, i, u1).p],
           color, normalAt(track, i, um), BACKDROP);
    }
    if (ahead > 140) return;
    // glowing strips along the floor's edges, the middle of each wall and the ceiling's edges
    for (const [u, w, c] of [[TUBE_FLOOR, 0.16, strip], [-TUBE_FLOOR, 0.16, strip], [MID_WALL, 0.2, ringCols[0]],
                             [-MID_WALL, 0.2, ringCols[0]], [WALL_END, 0.16, ringCols[1]], [-WALL_END, 0.16, ringCols[1]]]) {
      face(p, [tubePoint(track, i, u - w, 0.02).p, tubePoint(track, j, u - w, 0.02).p, tubePoint(track, j, u + w, 0.02).p,
               tubePoint(track, i, u + w, 0.02).p], c, normalAt(track, i, u), MARKS);
    }
  }

  /** The middle line's dashes and the rings of light, each where it falls along the road (drawn
   * with whichever piece they fell in, they jumped about as the pieces did). */
  function marks(): void {
    const near = (s: number) => {
      const d = dir * around(track, s0, s);
      return d > -12 && d < 140 && !out(s);
    };
    const at = (s: number) => track.stepAlong(from, around(track, s0, s));
    const lo = dir > 0 ? s0 - 12 : s0 - 140, hi = dir > 0 ? s0 + 140 : s0 + 12;
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
    each(3.6, (sa) => {
      if (!near(sa)) return;
      const a = at(sa), b = at(wrapS(track, sa + 1.8)), n = normalAt(track, a.i, 0);
      face(p, [tubeBetween(track, a.i, a.w, -0.12, 0.02).p, tubeBetween(track, b.i, b.w, -0.12, 0.02).p,
               tubeBetween(track, b.i, b.w, 0.12, 0.02).p, tubeBetween(track, a.i, a.w, 0.12, 0.02).p], line, n, MARKS);
    });
    each(RING_GAP, (sr, r) => {
      if (!near(sr)) return;
      // (fading out as it comes within a few meters of the camera: that close, a ring half a meter
      // deep swept across half the screen in a frame or two, a flash rather than a ring going by)
      const fade = Math.min(1, Math.max(0, (dir * around(track, s0, sr) - 8) / 8));
      if (fade <= 0) return;
      const a = at(sr), b = at(wrapS(track, sr + 0.9));
      const c = shade(ringCols[r & 1], 0.85 + 0.15 * Math.sin(now * 4 + r));
      for (let k = 0; k < RING.length - 1; k++) {
        const u0 = RING[k], u1 = RING[k + 1];
        face(p, [tubeBetween(track, a.i, a.w, u0, 0.03).p, tubeBetween(track, b.i, b.w, u0, 0.03).p,
                 tubeBetween(track, b.i, b.w, u1, 0.03).p, tubeBetween(track, a.i, a.w, u1, 0.03).p],
             c, normalAt(track, a.i, (u0 + u1) / 2), MARKS - 0.05, fade);
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
 * each one decal at one depth. */
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
      face(p, [at(u0, -PAD_HALF), at(u1, -PAD_HALF), at(u1, PAD_HALF), at(u0, PAD_HALF)], hex("#7a2e12"), nrm, 0, 1, true);
    }
    for (let c = 0; c < 3; c++) {
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
  const cells = 10, cell = (2 * TUBE_FLOOR) / cells, from0 = p.faces.length;
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

