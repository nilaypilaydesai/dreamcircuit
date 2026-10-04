// The neon tunnel, drawn: the tube round the road (world/tube.ts) as rings of panels, a dark floor
// with a dashed middle line, walls and ceiling in panels of deep violet, glowing strips along the
// floor's edges and up the middle of each wall, rings of light every few meters sweeping past, the
// start line's checks on the floor, and boost pads wherever they lie round the tube (the floor, a
// wall, the ceiling). Only the stretch of tube ahead of the camera is drawn, and where the circuit
// crosses itself the other stretch is left out (from inside the tube it is never seen, and drawn
// it would show through the walls).

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

/** Where the point ``u`` m round the tube at road point i is, ``h`` m in off its surface, and how
 * far that surface is turned from facing up. */
export function tubePoint(track: Track, i: number, u: number, h = 0): { p: P3; tilt: number } {
  const [tx, ty] = track.tangent(i), lx = -ty, ly = tx;
  const q = tubeAt(u), nl = -Math.sin(q.tilt), nz = Math.cos(q.tilt); // the surface's inward normal
  const off = q.lat + nl * h;
  return { p: [track.xs[i] + lx * off, track.ys[i] + ly * off, (track.elev[i] ?? 0) + q.z + nz * h], tilt: q.tilt };
}

/** The inward normal of the tube's surface at ``u`` m round it, at road point i. */
export function normalAt(track: Track, i: number, u: number): P3 {
  const [tx, ty] = track.tangent(i), t = tubeAt(u).tilt, s = -Math.sin(t);
  return [-ty * s, tx * s, Math.cos(t)];
}

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
  let i = track.wrap(from - dir * Math.round(12 / SPACING)), guard = 0;
  while (guard++ < 2000) {
    const ahead = dir * around(track, s0, track.s[i]);
    const step = ahead < 60 ? 3 : ahead < 120 ? 6 : 12;
    let j = i + dir * step;
    if (!track.locked && (j >= track.count || j < 0)) break;
    j = track.wrap(j);
    if (ahead > SEEN) break;
    const [a, b] = dir > 0 ? [i, j] : [j, i];
    if (!out(track.s[a])) piece(a, b, ahead);
    i = j;
  }
  pads(p, track, f, from, now, dir);
  startLine(p, track, s0);

  function piece(i: number, j: number, ahead: number): void {
    const n = Math.floor(track.s[i] / 1.8);
    for (let k = 0; k < RING.length - 1; k++) {
      const u0 = RING[k], u1 = RING[k + 1], um = (u0 + u1) / 2, a = Math.abs(wrapTube(um));
      const color = a <= TUBE_FLOOR ? shade(floor, n & 1 ? 1 : 1.07)
        : a >= WALL_END ? shade(ceiling, (k + n) & 1 ? 1 : 1.1)
        : shade(panel[k & 1], n & 1 ? 1 : 1.06);
      face(p, [tubePoint(track, i, u0).p, tubePoint(track, j, u0).p, tubePoint(track, j, u1).p, tubePoint(track, i, u1).p],
           color, normalAt(track, i, um), BACKDROP);
    }
    if (ahead > 140) return;
    // glowing strips along the floor's edges and up each wall, and the middle line, dashed
    for (const [u, w, c] of [[TUBE_FLOOR, 0.16, strip], [-TUBE_FLOOR, 0.16, strip], [MID_WALL, 0.2, ringCols[0]],
                             [-MID_WALL, 0.2, ringCols[0]], [WALL_END, 0.16, ringCols[1]], [-WALL_END, 0.16, ringCols[1]]]) {
      face(p, [tubePoint(track, i, u - w, 0.02).p, tubePoint(track, j, u - w, 0.02).p, tubePoint(track, j, u + w, 0.02).p,
               tubePoint(track, i, u + w, 0.02).p], c, normalAt(track, i, u), BACKDROP - 0.1);
    }
    if (n % 2 === 0) {
      face(p, [tubePoint(track, i, -0.12, 0.02).p, tubePoint(track, j, -0.12, 0.02).p, tubePoint(track, j, 0.12, 0.02).p,
               tubePoint(track, i, 0.12, 0.02).p], line, [0, 0, 1], BACKDROP - 0.1);
    }
    // a ring of light where one falls in this piece, pulsing gently
    const r0 = Math.floor(track.s[i] / RING_GAP), r1 = Math.floor(track.s[j] / RING_GAP);
    if (r1 !== r0) {
      const q = track.wrap(i + 1), glow = 0.85 + 0.15 * Math.sin(now * 4 + r1);
      const c = shade(ringCols[r1 & 1], glow);
      for (let k = 0; k < RING.length - 1; k++) {
        const u0 = RING[k], u1 = RING[k + 1];
        face(p, [tubePoint(track, i, u0, 0.03).p, tubePoint(track, q, u0, 0.03).p, tubePoint(track, q, u1, 0.03).p,
                 tubePoint(track, i, u1, 0.03).p], c, normalAt(track, i, (u0 + u1) / 2), BACKDROP - 0.15);
      }
    }
  }
}

/** Boost pads round the tube: a plate and three chevrons, laid on the surface wherever the pad is,
 * each one decal at one depth. */
function pads(p: Painter, track: Track, f: Features, from: number, now: number, dir: number): void {
  const s0 = track.s[from];
  for (const pad of f.pads) {
    const ahead = dir * around(track, s0, pad.s0);
    if (ahead < -10 || ahead > 150) continue;
    const at = (u: number, v: number): P3 => {
      const k = u / SPACING, i0 = Math.floor(k), w = k - i0;
      const a = tubePoint(track, track.wrap(pad.start + i0), pad.offset + v, 0.05).p;
      const b = tubePoint(track, track.wrap(pad.start + i0 + 1), pad.offset + v, 0.05).p;
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
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
               tubePoint(track, a, u1, 0.03).p], (r + c) & 1 ? hex("#1a1a1a") : hex("#f4f4f4"), [0, 0, 1], 0, 1, true);
    }
  }
  const mine = p.faces.slice(from0);
  if (!mine.length) return;
  const depth = Math.max(...mine.map((fc) => fc.z));
  for (const fc of mine) fc.z = depth;
}

