// The 3D parts of a circuit, built from flat polygons every frame for whatever is in view:
// bridges (deck with kerbed edges and center dashes, guard rails, girder sides, underside),
// jump ramps (a striped wedge with kerb-coloured sides) and boost pads (chevrons that pulse forward).

import { hex, mix, shade } from "../core/gfx";
import { PAD_HALF, PAD_LEN, RAMP_HEIGHT, RAMP_LEN, type Features } from "../race/features";
import type { Theme } from "../themes";
import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import { type P3, type Painter, face } from "./poly";

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
