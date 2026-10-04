// A tiny software polygon rasterizer for what Mode 7 cannot draw: raised road (bridge decks and
// their ramps, sides, rails and undersides), jump ramps and glowing boost pads. World points are
// projected with the same camera as the ground and the sprites, clipped against a near plane,
// culled by their outward normal, and filled flat with distance fog. Faces join the sprites in
// one painter's sort, so karts drive over decks and under them.

import { H, W, mix, type Screen } from "../core/gfx";
import type { Camera } from "./mode7";

/** A drawable in the shared far-to-near sort. */
export interface Face {
  z: number;
  draw: () => void;
}

export type P3 = [number, number, number];

const NEAR = 0.6;

/** Camera space: (forward, right, up), relative to the camera (turned with it, in the tube). */
export function toCamera(cam: Camera, x: number, y: number, z: number): P3 {
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.height;
  const B = cam.basis;
  if (B) {
    return [dx * B.f[0] + dy * B.f[1] + dz * B.f[2], dx * B.r[0] + dy * B.r[1] + dz * B.r[2], dx * B.u[0] + dy * B.u[1] + dz * B.u[2]];
  }
  const c = Math.cos(cam.heading), s = Math.sin(cam.heading);
  return [dx * c + dy * s, dx * s - dy * c, dz];
}

function clipNear(poly: P3[]): P3[] {
  const out: P3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ain = a[0] >= NEAR, bin = b[0] >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (NEAR - a[0]) / (b[0] - a[0]);
      out.push([NEAR, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** Fill a convex screen-space polygon. */
export function fillConvex(scr: Screen, pts: number[][], color: number, alpha = 1): void {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const ya = Math.max(0, Math.ceil(y0 - 0.5)), yb = Math.min(H - 1, Math.floor(y1 - 0.5));
  const buf = scr.buf;
  const n = pts.length;
  for (let y = ya; y <= yb; y++) {
    const yc = y + 0.5;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
        const x = a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
        xl = Math.min(xl, x);
        xr = Math.max(xr, x);
      }
    }
    if (xl > xr) continue;
    const xa = Math.max(0, Math.ceil(xl - 0.5)), xb = Math.min(W - 1, Math.floor(xr - 0.5));
    const row = y * W;
    if (alpha >= 1) for (let x = xa; x <= xb; x++) buf[row + x] = color;
    else for (let x = xa; x <= xb; x++) buf[row + x] = mix(buf[row + x], color, alpha);
  }
}

export interface Painter {
  cam: Camera;
  scr: Screen;
  fog: number;
  faces: Face[];
}

/** Queue a flat polygon (world space). ``normal`` faces away from the solid; faces seen from
 * behind are skipped (pass null for two-sided faces such as rails). ``bias`` nudges its place in
 * the sort (negative: drawn later, over things at the same depth). ``surface``: road that karts
 * stand on, sorted by its far edge instead of its middle, so anything standing anywhere on it is
 * drawn over it (sorted by its middle, the far half of the piece under a kart was drawn over the
 * kart: its wheels on a bridge, half of it on a steep climb). */
export function face(p: Painter, pts: P3[], color: number, normal: P3 | null, bias = 0,
                     alpha = 1, surface = false): void {
  const { cam } = p;
  if (normal) {
    const q = pts[0];
    const vx = cam.x - q[0], vy = cam.y - q[1], vz = cam.height - q[2];
    if (normal[0] * vx + normal[1] * vy + normal[2] * vz <= 0) return;
  }
  const cs = pts.map((q) => toCamera(cam, q[0], q[1], q[2]));
  let far = true;
  let depth = 0, farthest = 0;
  for (const c of cs) {
    if (c[0] >= NEAR) far = false;
    depth += c[0];
    farthest = Math.max(farthest, c[0]);
  }
  if (far) return;
  depth /= cs.length;
  if (depth > cam.far) return;
  const clipped = clipNear(cs);
  if (clipped.length < 3) return;
  const proj = clipped.map(([f, r, u]) => [W / 2 + (r * cam.focal) / f, cam.horizon - (u * cam.focal) / f]);
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const q of proj) {
    minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]);
    miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]);
  }
  if (maxx < 0 || minx > W || maxy < 0 || miny > H) return;
  const fogT = depth > cam.far * 0.45 ? Math.min(1, (depth - cam.far * 0.45) / (cam.far * 0.55)) ** 1.5 : 0;
  const c = fogT > 0 ? mix(color, p.fog, fogT) : color;
  p.faces.push({ z: (surface ? farthest : depth) + bias, draw: () => fillConvex(p.scr, proj, c, alpha) });
}
