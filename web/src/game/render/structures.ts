// The 3D parts of a circuit, built from flat polygons every frame for whatever is in view:
// bridges (deck with kerbed edges and center dashes, guard rails, girder sides, underside),
// jump ramps (a striped wedge with kerb-coloured sides), boost pads (chevrons that pulse forward),
// and in the mountains, climbs on earth embankments and tunnels through rock mounds.

import { hex, mix, shade } from "../core/gfx";
import { PAD_HALF, PAD_LEN, RAMP_HEIGHT, RAMP_LEN, TUNNEL_H, type Features } from "../race/features";
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
      face(p, [P(i, -hw, hi), P(j, -hw, hj), P(j, -hw + 0.8, hj), P(i, -hw + 0.8, hi)], kerb, up, -0.2);
      face(p, [P(i, hw - 0.8, hi), P(j, hw - 0.8, hj), P(j, hw, hj), P(i, hw, hi)], kerb, up, -0.2);
      face(p, [P(i, -hw + 0.8, hi), P(j, -hw + 0.8, hj), P(j, hw - 0.8, hj), P(i, hw - 0.8, hi)], road, up, -0.2);
      if (Math.floor(s / 4) % 2 === 0) {
        face(p, [P(i, -0.18, hi + 0.01), P(j, -0.18, hj + 0.01), P(j, 0.18, hj + 0.01), P(i, 0.18, hi + 0.01)],
             theme.edge, up, -0.25);
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

/** The mountains' climbs: the road on top of an earth embankment that falls away to the ground on
 * both sides, with low stone walls along the edges. */
export function hillFaces(p: Painter, track: Track, theme: Theme): void {
  const hw = HALF_WIDTH, step = 3;
  const earth = shade(theme.shoulder, 0.9), earthDark = shade(theme.shoulder, 0.7);
  for (const hl of track.hills) {
    const a = indexAt(track, hl.s0), e = Math.min(track.count - 1, indexAt(track, hl.s0 + hl.len));
    if (e - a < 2 || !near(p, track, (a + e) >> 1, hl.len)) continue;
    for (let i = a; i < e; i += step) {
      const j = Math.min(i + step, e);
      const hi = track.elev[i], hj = track.elev[j];
      if (Math.max(hi, hj) < 0.12 || !near(p, track, i)) continue;
      const s = track.s[i];
      const [tx, ty] = track.tangent(i);
      const up: P3 = [0, 0, 1];
      const P = (k: number, off: number, z: number) => edgePoint(track, k, off, z);
      const kerb = Math.floor(s / 3) & 1 ? theme.kerb[0] : theme.kerb[1];
      face(p, [P(i, -hw, hi), P(j, -hw, hj), P(j, -hw + 0.8, hj), P(i, -hw + 0.8, hi)], kerb, up, -0.2);
      face(p, [P(i, hw - 0.8, hi), P(j, hw - 0.8, hj), P(j, hw, hj), P(i, hw, hi)], kerb, up, -0.2);
      face(p, [P(i, -hw + 0.8, hi), P(j, -hw + 0.8, hj), P(j, hw - 0.8, hj), P(i, hw - 0.8, hi)], shade(theme.road, 1.04), up, -0.2);
      if (Math.floor(s / 4) % 2 === 0) {
        face(p, [P(i, -0.18, hi + 0.01), P(j, -0.18, hj + 0.01), P(j, 0.18, hj + 0.01), P(i, 0.18, hi + 0.01)],
             theme.edge, up, -0.25);
      }
      // the embankment: from the road's edge down and out to the ground
      const fi = hi * 1.2 + 0.4, fj = hj * 1.2 + 0.4;
      face(p, [P(i, hw, hi), P(j, hw, hj), P(j, hw + fj, 0), P(i, hw + fi, 0)], earth, [-ty, tx, 1], 0.1);
      face(p, [P(j, -hw, hj), P(i, -hw, hi), P(i, -hw - fi, 0), P(j, -hw - fj, 0)], earthDark, [ty, -tx, 1], 0.1);
      if (Math.max(hi, hj) > 0.6) {
        for (const off of [-hw, hw]) {
          face(p, [P(i, off, hi), P(j, off, hj), P(j, off, hj + 0.55), P(i, off, hi + 0.55)], STONE, null, -0.15);
        }
      }
    }
  }
}

const ROCK = hex("#6f6b66"), ROCK_DARK = hex("#55514c"), CEILING = hex("#2f2d2b"), LAMP = hex("#ffd98a");

/** The mountains' tunnels: walls, a ceiling and lamps inside; outside, a rock mound over the road
 * and a rock face around each mouth. */
export function tunnelFaces(p: Painter, track: Track, f: Features): void {
  const hw = HALF_WIDTH + 0.4, top = TUNNEL_H;
  for (const tn of f.tunnels) {
    if (!near(p, track, tn.start + (tn.n >> 1), 90)) continue;
    for (let k = 0; k < tn.n; k += 3) {
      const i = track.wrap(tn.start + k), j = track.wrap(tn.start + Math.min(tn.n, k + 3));
      const zi = track.elev[i], zj = track.elev[j];
      const [tx, ty] = track.tangent(i);
      const P = (q: number, off: number, z: number) => edgePoint(track, q, off, z);
      // inside: the walls face the road, the ceiling faces down
      face(p, [P(i, hw, zi), P(j, hw, zj), P(j, hw, zj + top), P(i, hw, zi + top)], ROCK_DARK, [ty, -tx, 0], 0.05);
      face(p, [P(j, -hw, zj), P(i, -hw, zi), P(i, -hw, zi + top), P(j, -hw, zj + top)], shade(ROCK_DARK, 0.85), [-ty, tx, 0], 0.05);
      face(p, [P(i, -hw, zi + top), P(j, -hw, zj + top), P(j, hw, zj + top), P(i, hw, zi + top)], CEILING, [0, 0, -1], 0.06);
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
      face(p, [P(i, -hw, hi), P(j, -hw, hj), P(j, hw, hj), P(i, hw, hi)], color, [0, 0, 1], -0.3);
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
                         color: number): void {
  const a = k.heading + angle;
  const fx = Math.cos(a), fy = Math.sin(a), lx = -fy, ly = fx;
  const z = k.ground + 0.06;
  const P = (d: number, w: number): P3 => [k.x + fx * d + lx * w, k.y + fy * d + ly * w, z];
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
         hex("#7a2e12"), [0, 0, 1], -0.3);
    for (let c = 0; c < 3; c++) {
      const u0 = 1 + c * 2;
      const glow = 0.5 + 0.5 * Math.sin(time * 9 - c * 1.6);
      const col = mix(hex("#ff8a1f"), hex("#fff2a8"), glow);
      // a chevron pointing along the road: two arms meeting at the tip
      face(p, [L(u0, -PAD_HALF + 0.4), L(u0 + 1.4, 0), L(u0 + 2.0, 0), L(u0 + 0.6, -PAD_HALF + 0.4)], col, [0, 0, 1], -0.35);
      face(p, [L(u0 + 0.6, PAD_HALF - 0.4), L(u0 + 2.0, 0), L(u0 + 1.4, 0), L(u0, PAD_HALF - 0.4)], col, [0, 0, 1], -0.35);
    }
  }
}
