// Drawing the land around a circuit (world/landforms.ts). Each landform is a solid turned about
// its middle: rings of points from its foot up (each a little ragged), joined into faces lit by the
// sun from the north-west, in its world's colours: bands of grass on a knoll, strata of sandstone
// on a butte, a crown of coral on a reef rock, a crater of lava on a cinder cone,
// glowing ridges and rings on a neon peak, floors of lit windows on a tower block.

import { hex, mix, shade } from "../core/gfx";
import type { Theme } from "../themes";
import { type Landform, type LandformKind, reach } from "../world/landforms";
import { type P3, type Painter, face } from "./poly";

interface Look {
  sides: number;
  profile: [number, number][]; // from the foot up: (radius, height), as fractions of the landform's
  jitter: number; // how ragged its outline is (a fraction of the radius)
  lean?: number; // its top shifted along its length (a dune's crest), a fraction of the radius
  band: (theme: Theme, ring: number, side: number, l: Landform) => number; // between rings ring and ring + 1
  cap?: (theme: Theme) => number; // a flat top in this colour
  capLit?: boolean; // the sun lights the top too (else it glows: a crater of lava)
  ridges?: (theme: Theme, side: number) => number; // glowing lines up its edges, and rings around it
  glows?: (ring: number) => boolean; // bands that give light rather than take the sun's (lit windows)
}

const STRATA = [hex("#c8693a"), hex("#d98b4f"), hex("#b5532f"), hex("#e2a467"), hex("#a8472a")];
const CORALS = [hex("#ff6f91"), hex("#ff9f5a"), hex("#b76cff"), hex("#ffd45a"), hex("#5ad1c4")];
const REEF_ROCK = hex("#56697a"), BASALT = hex("#2f2729");
/** A tower block's profile: straight up, a ring at every band of wall and of windows (seven floors). */
const BLOCK_RINGS: [number, number][] = [
  [1, 0], ...Array.from({ length: 7 }, (_, f): [number, number][] => [[1, 0.04 + f * 0.137], [1, 0.12 + f * 0.137]]).flat(), [1, 1],
];
const BLOCK_LIT = [hex("#ffd98a"), hex("#dfe8ff"), hex("#ffcf7a"), hex("#1b1e29"), hex("#9fd8ff")];

const LOOKS: Record<LandformKind, Look> = {
  knoll: {
    sides: 12, profile: [[1, 0], [0.8, 0.4], [0.52, 0.76], [0.22, 0.96], [0, 1]], jitter: 0.07,
    band: (t, k) => mix(shade(t.ground[1], 0.92), shade(t.ground[0], 1.1), k / 3),
  },
  gridpeak: {
    sides: 5, profile: [[1, 0], [0, 1]], jitter: 0.12, band: () => hex("#21103f"),
    ridges: (t, q) => (q & 1 ? t.edge : t.kerb[0]),
  },
  butte: {
    sides: 11, profile: [[1, 0], [0.97, 0.22], [0.94, 0.45], [0.91, 0.68], [0.88, 0.88], [0.85, 1]], jitter: 0.15,
    band: (_t, k, _q, l) => STRATA[(k + l.seed) % STRATA.length], cap: (t) => t.ground[0], capLit: true,
  },
  dune: {
    sides: 10, profile: [[1, 0], [0.72, 0.42], [0.42, 0.8], [0.12, 1]], jitter: 0.05, lean: 0.35,
    band: (t, k) => shade(t.ground[0], 1 + 0.03 * k), cap: (t) => shade(t.ground[0], 1.08), capLit: true,
  },
  reefrock: {
    sides: 9, profile: [[1, 0], [0.92, 0.35], [0.7, 0.7], [0.42, 0.94], [0, 1]], jitter: 0.15,
    band: (_t, k, q, l) => (k < 2 ? shade(REEF_ROCK, 0.9 + 0.1 * (q & 1)) : CORALS[(q + l.seed) % CORALS.length]),
  },
  cone: {
    sides: 10, profile: [[1, 0], [0.74, 0.55], [0.44, 1]], jitter: 0.08,
    band: (_t, k) => (k === 0 ? BASALT : mix(BASALT, hex("#7a2410"), 0.35)), cap: () => hex("#ff7a1e"),
  },
  spoil: {
    sides: 8, profile: [[1, 0], [0.62, 0.6], [0.2, 1]], jitter: 0.12,
    band: (t, k, q) => shade(t.ground[0], (0.94 + 0.04 * k) * (q & 1 ? 0.96 : 1)),
    cap: (t) => t.ground[0], capLit: true,
  },
  rim: {
    sides: 12, profile: [[1, 0], [0.82, 0.35], [0.55, 0.72], [0.25, 0.94], [0, 1]], jitter: 0.06,
    band: (t, k) => shade(t.ground[0], 0.96 + 0.05 * k),
  },
  // a tower block at night: floors of dark wall and bands of windows, lit or not side by side
  block: {
    sides: 4, profile: BLOCK_RINGS, jitter: 0,
    band: (_t, k, q, l) => (k % 2 === 1 ? BLOCK_LIT[Math.floor(hash(l.seed, q, k) * BLOCK_LIT.length)] : hex("#262a36")),
    cap: () => hex("#3a3e4a"), capLit: true, glows: (k) => k % 2 === 1,
  },
};

const SUN: P3 = [-0.55, 0.55, 0.63]; // from the north-west, fairly high (as the ground's relief)

function hash(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h ^= h >>> 15;
  return (Math.imul(h, 0x27d4eb2f) >>> 0) / 4294967296;
}

/** The outward unit normal of a face of a solid whose middle is ``mid``. */
function normal(pts: P3[], mid: P3): P3 {
  const a = pts[0], b = pts[1], c = pts[pts.length - 1];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n: P3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  let cx = 0, cy = 0, cz = 0;
  for (const q of pts) { cx += q[0]; cy += q[1]; cz += q[2]; }
  const k = pts.length;
  if (n[0] * (cx / k - mid[0]) + n[1] * (cy / k - mid[1]) + n[2] * (cz / k - mid[2]) < 0) n = [-n[0], -n[1], -n[2]];
  const m = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / m, n[1] / m, n[2] / m];
}

const lit = (c: number, n: P3) => shade(c, 0.58 + 0.62 * Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]));
const along = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function build(p: Painter, l: Landform, look: Look, theme: Theme): void {
  const { sides, profile } = look, K = profile.length;
  const c = Math.cos(l.rot), s = Math.sin(l.rot);
  const rings: P3[][] = profile.map(([rf, hf], k) => {
    const shift = (look.lean ?? 0) * l.r * hf;
    return Array.from({ length: sides }, (_, q): P3 => {
      const a = (q / sides) * Math.PI * 2;
      const j = rf > 0 ? 1 + look.jitter * (2 * hash(l.seed, q, k) - 1) : 1;
      const u = Math.cos(a) * l.r * l.stretch * rf * j + shift, v = Math.sin(a) * l.r * rf * j;
      return [l.x + u * c - v * s, l.y + u * s + v * c, l.h * hf];
    });
  });
  const mid: P3 = [l.x, l.y, l.h * 0.35];
  for (let k = 0; k < K - 1; k++) {
    const apex = profile[k + 1][0] === 0;
    for (let q = 0; q < sides; q++) {
      const q2 = (q + 1) % sides;
      const pts = apex ? [rings[k][q], rings[k][q2], rings[k + 1][0]] : [rings[k][q], rings[k][q2], rings[k + 1][q2], rings[k + 1][q]];
      const n = normal(pts, mid);
      const band = look.band(theme, k, q, l);
      face(p, pts, look.glows?.(k) ? band : lit(band, n), n);
      if (look.ridges && apex) {
        // a ring of light around it a third and two thirds of the way up, and a line up its edge
        const top = rings[k + 1][0], ring = shade(theme.grid || hex("#3d1f6b"), 2.3);
        for (const f of [0.33, 0.62]) {
          face(p, [along(pts[0], top, f), along(pts[1], top, f), along(pts[1], top, f + 0.035), along(pts[0], top, f + 0.035)],
               ring, n, -0.05);
        }
        const prev = rings[k][(q + sides - 1) % sides], next = rings[k][q2];
        const tx = next[0] - prev[0], ty = next[1] - prev[1], tl = Math.hypot(tx, ty) || 1;
        const w = 0.8 / tl, wt = 0.22 / tl, b = rings[k][q];
        face(p, [[b[0] - tx * w, b[1] - ty * w, b[2]], [b[0] + tx * w, b[1] + ty * w, b[2]],
                 [top[0] + tx * wt, top[1] + ty * wt, top[2]], [top[0] - tx * wt, top[1] - ty * wt, top[2]]],
             look.ridges(theme, q), [b[0] - l.x, b[1] - l.y, l.r * 0.5], -0.06);
      }
    }
  }
  if (profile[K - 1][0] > 0 && look.cap) {
    const cap = look.cap(theme);
    face(p, rings[K - 1], look.capLit ? lit(cap, [0, 0, 1]) : cap, [0, 0, 1]);
  }
}

/** Faces for the landforms in view. */
export function landformFaces(p: Painter, forms: readonly Landform[], theme: Theme): void {
  const cam = p.cam, fx = Math.cos(cam.heading), fy = Math.sin(cam.heading);
  for (const l of forms) {
    const dx = l.x - cam.x, dy = l.y - cam.y, r = reach(l);
    if (Math.hypot(dx, dy) - r > cam.far || dx * fx + dy * fy < -r) continue;
    build(p, l, LOOKS[l.kind], theme);
  }
}
