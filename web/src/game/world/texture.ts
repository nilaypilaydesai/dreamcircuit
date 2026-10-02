// The ground under the Mode-7 camera: one 2048 x 2048 texture (0.25 m per texel) covering a
// 512 m square. Terrain is painted once per race; road is painted into it chunk by chunk, as
// the circuit designer commits each new stretch. A mip chain keeps distant ground from
// shimmering.

import { hash2, mix, shade, valueNoise } from "../core/gfx";
import type { Theme } from "../themes";
import { HALF_WIDTH, type Track } from "./track";

export const TEX = 2048;
export const RES = 0.25; // meters per texel
export const HALF = (TEX * RES) / 2; // world spans [-HALF, HALF]
const LEVELS = 5;
const KERB_KAPPA = 1 / 40; // corners tighter than 40 m radius get kerbs

export class WorldTexture {
  readonly levels: Uint32Array[] = [];
  constructor(readonly theme: Theme, readonly seed: number) {
    for (let k = 0; k < LEVELS; k++) this.levels.push(new Uint32Array((TEX >> k) * (TEX >> k)));
    this.paintTerrain();
    this.buildMips(0, 0, TEX, TEX);
  }

  /** World meters -> level-0 texel coordinates. */
  static texel(x: number, y: number): [number, number] {
    return [(x + HALF) / RES, (HALF - y) / RES];
  }

  private paintTerrain(): void {
    const t = this.theme;
    const tex = this.levels[0];
    for (let ty = 0; ty < TEX; ty++) {
      const wy = HALF - (ty + 0.5) * RES;
      for (let tx = 0; tx < TEX; tx++) {
        const wx = (tx + 0.5) * RES - HALF;
        const band = Math.floor((wx * 0.7 + wy * 0.7) / 9) & 1; // mowing stripes / dune bands
        let c = t.ground[band];
        const n = valueNoise(wx, wy, 6, this.seed) * 0.6 + valueNoise(wx, wy, 23, this.seed + 1) * 0.4;
        c = shade(c, 0.9 + 0.2 * n);
        const h = hash2(tx, ty, this.seed);
        if (h > 0.985) c = t.groundSpeck;
        if (t.grid) {
          const gx = Math.abs(((wx % 10) + 10) % 10 - 5), gy = Math.abs(((wy % 10) + 10) % 10 - 5);
          if (gx > 4.85 || gy > 4.85) c = t.grid;
        }
        tex[ty * TEX + tx] = c;
      }
    }
  }

  /** Fill a convex quad (texel coords) with a color function; returns its bounding box. */
  private quad(p: number[][], color: (tx: number, ty: number) => number,
               box: number[]): void {
    const tex = this.levels[0];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of p) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const ix0 = Math.max(0, Math.floor(x0)), ix1 = Math.min(TEX - 1, Math.ceil(x1));
    const iy0 = Math.max(0, Math.floor(y0)), iy1 = Math.min(TEX - 1, Math.ceil(y1));
    // orientation-independent inside test: all edge cross products share a sign
    for (let ty = iy0; ty <= iy1; ty++) {
      const py = ty + 0.5;
      for (let tx = ix0; tx <= ix1; tx++) {
        const px = tx + 0.5;
        let pos = false, neg = false;
        for (let k = 0; k < 4; k++) {
          const a = p[k], b = p[(k + 1) & 3];
          const cr = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
          if (cr > 0.25) pos = true;
          else if (cr < -0.25) neg = true;
        }
        if (pos && neg) continue;
        tex[ty * TEX + tx] = color(tx, ty);
      }
    }
    box[0] = Math.min(box[0], ix0); box[1] = Math.min(box[1], iy0);
    box[2] = Math.max(box[2], ix1 + 1); box[3] = Math.max(box[3], iy1 + 1);
  }

  /** Paint committed road between dense indices [from, to). */
  paintRoad(track: Track, from: number, to: number): void {
    const t = this.theme;
    const box = [TEX, TEX, 0, 0];
    const start = Math.max(0, from - 1);
    const end = track.locked ? to : to - 1;
    const strip = (i: number, j: number, a: number, b: number, color: (tx: number, ty: number) => number) => {
      const [tix, tiy] = track.tangent(i), [tjx, tjy] = track.tangent(j);
      const P = (k: number, tx: number, ty: number, off: number) =>
        WorldTexture.texel(track.xs[k] - ty * off, track.ys[k] + tx * off);
      this.quad([P(i, tix, tiy, a), P(j, tjx, tjy, a), P(j, tjx, tjy, b), P(i, tix, tiy, b)], color, box);
    };
    const asphalt = (tx: number, ty: number) => {
      const h = hash2(tx, ty, 7);
      return h > 0.93 ? t.roadSpeck : shade(t.road, 0.96 + 0.08 * hash2(tx >> 2, ty >> 2, 3));
    };
    for (let i = start; i < end; i++) {
      const j = track.wrap(i + 1);
      const hw = HALF_WIDTH;
      strip(i, j, -hw - 1.8, hw + 1.8, (tx, ty) => shade(t.shoulder, 0.92 + 0.12 * hash2(tx, ty, 11)));
      strip(i, j, -hw, hw, asphalt);
      const kappa = Math.abs(track.curvature(i));
      const s = track.s[i];
      if (kappa > KERB_KAPPA) {
        const c = Math.floor(s / 2.4) & 1 ? t.kerb[0] : t.kerb[1];
        strip(i, j, hw - 1.3, hw, () => c);
        strip(i, j, -hw, -hw + 1.3, () => c);
      } else {
        strip(i, j, hw - 0.45, hw - 0.1, () => t.edge);
        strip(i, j, -hw + 0.1, -hw + 0.45, () => t.edge);
      }
    }
    // Start/finish checkers and grid boxes once the start line exists.
    if (track.startIndex >= start && track.startIndex < end + 1) this.paintStartLine(track, box);
    if (box[2] > box[0]) this.buildMips(box[0], box[1], box[2], box[3]);
  }

  private paintStartLine(track: Track, box: number[]): void {
    const si = track.startIndex;
    const [tx, ty] = track.tangent(si);
    const cx = track.xs[si], cy = track.ys[si];
    const nx = -ty, ny = tx;
    const cells = 10, rows = 2, cell = (2 * HALF_WIDTH) / cells;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cells; c++) {
        const a = -HALF_WIDTH + c * cell, b = a + cell;
        const f0 = -cell + r * cell, f1 = f0 + cell;
        const color = (r + c) & 1 ? 0xff1a1a1a : 0xfff4f4f4;
        const P = (f: number, l: number) => WorldTexture.texel(cx + tx * f + nx * l, cy + ty * f + ny * l);
        this.quad([P(f0, a), P(f1, a), P(f1, b), P(f0, b)], () => color, box);
      }
    }
    // grid slots: short white bars behind the line, staggered left/right
    for (let k = 0; k < 8; k++) {
      const f = -7 - k * 5.5;
      const l0 = k & 1 ? -HALF_WIDTH + 1.2 : 0.8;
      const P = (ff: number, l: number) => WorldTexture.texel(cx + tx * ff + nx * l, cy + ty * ff + ny * l);
      this.quad([P(f, l0), P(f + 0.35, l0), P(f + 0.35, l0 + 4.2), P(f, l0 + 4.2)], () => 0xffeeeeee, box);
    }
  }

  private buildMips(x0: number, y0: number, x1: number, y1: number): void {
    for (let k = 1; k < LEVELS; k++) {
      const src = this.levels[k - 1], dst = this.levels[k];
      const sw = TEX >> (k - 1), dw = TEX >> k;
      const ax = Math.max(0, (x0 >> k) - 1), ay = Math.max(0, (y0 >> k) - 1);
      const bx = Math.min(dw, (x1 >> k) + 1), by = Math.min(dw, (y1 >> k) + 1);
      for (let y = ay; y < by; y++) {
        for (let x = ax; x < bx; x++) {
          const i = 2 * y * sw + 2 * x;
          dst[y * dw + x] = mix(mix(src[i], src[i + 1], 0.5), mix(src[i + sw], src[i + sw + 1], 0.5), 0.5);
        }
      }
    }
  }
}
