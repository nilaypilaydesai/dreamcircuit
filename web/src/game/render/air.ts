// Drawing the sky's course (race/air.ts): its rings, each a band of light standing across the
// course to fly through (gold ones every fourth), the start's checkered banner overhead, the
// balloons that mark out either side of it, clouds above and below it and off to either side, and
// the specks of air rising in its updrafts. The sea far below, and the shoal the course draws across
// it, are the ground (render/mode7.ts); its islands are landforms.

import { hex, mix } from "../core/gfx";
import { type AirCourse, DRAFT_LEN, DRAFT_R, MARK_GAP, RING_R, SKY_LANE } from "../race/air";
import type { Track } from "../world/track";
import type { WorldSprite } from "./billboards";
import { type P3, type Painter, face } from "./poly";
import type { SceneryArt } from "./sprites";

const RING = hex("#7fe7ff"), RING_HOT = hex("#f4feff"), GOLD = hex("#ffc93a"), GOLD_HOT = hex("#fff3a8");
const SEEN = 300; // m of course ahead drawn

export interface AirArt { balloons: { left: SceneryArt[]; right: SceneryArt[] }; clouds: SceneryArt[]; speck: SceneryArt }

/** m from arc length ``a`` forward to ``b`` (round a locked lap, either way). */
function around(track: Track, a: number, b: number): number {
  if (!track.locked) return b - a;
  const L = track.length;
  return ((((b - a) % L) + L * 1.5) % L) - L / 2;
}

/** The point ``off`` m left of the course's middle at road point (i, w), ``up`` m over the course. */
function at(track: Track, i: number, w: number, off: number, up: number): P3 {
  const j = track.wrap(i + 1), [ax, ay] = track.tangent(i), [bx, by] = track.tangent(j);
  const x0 = track.xs[i] - ay * off, y0 = track.ys[i] + ax * off, x1 = track.xs[j] - by * off, y1 = track.ys[j] + bx * off;
  const z0 = track.elev[i] ?? 0, z1 = track.elev[j] ?? z0;
  return [x0 + (x1 - x0) * w, y0 + (y1 - y0) * w, z0 + (z1 - z0) * w + up];
}

/** The rings ahead of the camera (at road point ``from``), and the start's banner. */
export function airFaces(p: Painter, track: Track, air: AirCourse, from: number, now: number): void {
  const s0 = track.s[from];
  for (const r of air.rings) {
    const ahead = around(track, s0, r.s0);
    if (ahead < -25 || ahead > SEEN) continue;
    const [tx, ty] = track.tangent(r.start), lx = -ty, ly = tx;
    const c = at(track, r.start, 0, r.offset, r.lift);
    const shine = 0.5 + 0.5 * Math.sin(now * 6 + r.s0 * 0.1);
    const col = r.gold ? mix(GOLD, GOLD_HOT, shine) : mix(RING, RING_HOT, shine * 0.6);
    const n = 20, r0 = RING_R - 0.3, r1 = RING_R + 0.35;
    const pt = (rad: number, a: number): P3 => [c[0] + lx * Math.cos(a) * rad, c[1] + ly * Math.cos(a) * rad, c[2] + Math.sin(a) * rad];
    for (let q = 0; q < n; q++) {
      const a0 = (q / n) * Math.PI * 2, a1 = ((q + 1) / n) * Math.PI * 2;
      face(p, [pt(r0, a0), pt(r1, a0), pt(r1, a1), pt(r0, a1)], col, null);
    }
  }
  // the start: a checkered banner hung across the course overhead
  const si = track.startIndex;
  if (si >= 0 && Math.abs(around(track, s0, track.s[si])) < SEEN) {
    const cells = 12, half = SKY_LANE * 0.55, cell = (2 * half) / cells;
    for (let row = 0; row < 2; row++) {
      for (let c = 0; c < cells; c++) {
        const u0 = -half + c * cell, u1 = u0 + cell, z0 = 9 + row * 1.2, z1 = z0 + 1.2;
        face(p, [at(track, si, 0, u0, z0), at(track, si, 0, u1, z0), at(track, si, 0, u1, z1), at(track, si, 0, u0, z1)],
             (row + c) & 1 ? hex("#16161c") : hex("#f4f4f4"), null);
      }
    }
  }
}

const hash = (k: number, salt: number) => {
  const v = Math.sin(k * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** The balloons either side of the course every MARK_GAP m, bobbing; clouds round it (by where they
 * are along the lap: the same clouds every lap); and the specks rising in each updraft. */
export function airSprites(track: Track, air: AirCourse, from: number, now: number, art: AirArt): WorldSprite[] {
  const out: WorldSprite[] = [], s0 = track.s[from], end = track.locked ? Infinity : track.s[track.count - 1] ?? 0;
  const L = track.locked ? track.length : Infinity;
  const spot = (s: number) => track.stepAlong(from, around(track, s0, s));
  const fold = (s: number) => (Number.isFinite(L) ? ((s % L) + L) % L : s);
  // balloons
  for (let s = Math.ceil((s0 - 20) / MARK_GAP) * MARK_GAP; s < s0 + SEEN && s < end; s += MARK_GAP) {
    const q = spot(s), k = Math.round(fold(s) / MARK_GAP);
    for (const side of [1, -1]) {
      const bob = Math.sin(now * 1.6 + k * 0.9 + side) * 0.6, f = Math.floor(now * 2 + k) & 1;
      const pt = at(track, q.i, q.w, side * (SKY_LANE - 1), 0);
      out.push({ x: pt[0], y: pt[1], art: (side > 0 ? art.balloons.left : art.balloons.right)[f], base: pt[2] + bob, idx: q.i });
    }
  }
  // clouds: every 55 m along the lap, now and then one (off to a side, high over the course, or low
  // under it, between the course and the sea)
  for (let s = Math.ceil((s0 - 60) / 55) * 55; s < s0 + SEEN + 120 && s < end; s += 55) {
    const k = Math.round(fold(s) / 55);
    if (hash(k, 1) > 0.62) continue;
    const q = spot(s), kind = hash(k, 2), variant = Math.floor(hash(k, 3) * art.clouds.length);
    const side = hash(k, 4) < 0.5 ? 1 : -1;
    const [off, up] = kind < 0.5 ? [side * (SKY_LANE + 12 + hash(k, 5) * 70), -18 + hash(k, 6) * 40]
      : kind < 0.75 ? [side * hash(k, 5) * 30, 26 + hash(k, 6) * 18] : [side * hash(k, 5) * 40, -(22 + hash(k, 6) * 22)];
    const pt = at(track, q.i, q.w, off, up);
    if (pt[2] < 4) continue; // (never down in the sea)
    out.push({ x: pt[0], y: pt[1], art: art.clouds[variant], base: pt[2], flip: hash(k, 7) < 0.5, idx: q.i });
  }
  // updrafts: specks of air rising through each, over and over
  for (const d of air.drafts) {
    const ahead = around(track, s0, d.s0);
    if (ahead < -DRAFT_LEN - 10 || ahead > SEEN) continue;
    for (let n = 0; n < 26; n++) {
      const a = hash(n, d.s0) * Math.PI * 2, rad = DRAFT_R * Math.sqrt(hash(n, d.s0 + 1));
      const along = hash(n, d.s0 + 2) * DRAFT_LEN, rise = ((now * 9 + hash(n, d.s0 + 3) * 30) % 30) - 6;
      const q = spot(d.s0 + along);
      const pt = at(track, q.i, q.w, d.offset + Math.cos(a) * rad, rise);
      out.push({ x: pt[0], y: pt[1], art: art.speck, base: pt[2], idx: q.i, ghost: true, near: 6 });
    }
  }
  return out;
}
