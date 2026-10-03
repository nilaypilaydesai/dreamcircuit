// The ground under the Mode-7 camera: one 2560 x 2560 texture (0.3 m per texel) covering a
// 768 m square. Terrain is painted once per race; road is painted into it chunk by chunk, as
// the circuit designer commits each new stretch (raised road, on bridges, is painted as the
// shadow it casts). A mip chain keeps distant ground from shimmering. In the volcano the terrain
// is a lake of lava (marked texels whose colours cycle, world/lava.ts) and the road runs on a
// bank of rock with a glowing rim where it meets the lava.

import { hash2, mix, shade, valueNoise } from "../core/gfx";
import type { Theme } from "../themes";
import { CRACK, CRUST, MOLTEN, PHASES, SHADOW, isLava, isMark, lavaColor, lavaMark } from "./lava";
import { HALF_WIDTH, type Track } from "./track";

export const TEX = 2560;
export const RES = 0.3; // meters per texel
export const HALF = (TEX * RES) / 2; // world spans [-HALF, HALF]
const LEVELS = 5;
const KERB_KAPPA = 1 / 40; // corners tighter than 40 m radius get kerbs
/** In the volcano: how far from the centerline the rock goes (road, shoulder, then 2.6 m of
 * bank); past it is lava. */
export const BANK_EDGE = HALF_WIDTH + 1.8 + 2.6;

export class WorldTexture {
  readonly levels: Uint32Array[] = [];
  readonly lava: boolean; // the terrain is lava (the volcano)
  private readonly shaded = new Set<number>(); // raised road whose shadow is already painted
  constructor(readonly theme: Theme, readonly seed: number) {
    this.lava = !!theme.volcano;
    for (let k = 0; k < LEVELS; k++) this.levels.push(new Uint32Array((TEX >> k) * (TEX >> k)));
    this.paintTerrain(0, 0, TEX, TEX);
    this.buildMips(0, 0, TEX, TEX);
  }

  /** World meters -> level-0 texel coordinates. */
  static texel(x: number, y: number): [number, number] {
    return [(x + HALF) / RES, (HALF - y) / RES];
  }

  /** Whether the ground at world (x, y) is lava (beyond the texture, the lake goes on). */
  lavaAt(x: number, y: number): boolean {
    if (!this.lava) return false;
    const [tx, ty] = WorldTexture.texel(x, y);
    const ix = Math.floor(tx), iy = Math.floor(ty);
    if (ix < 0 || iy < 0 || ix >= TEX || iy >= TEX) return true;
    return isLava(this.levels[0][iy * TEX + ix]);
  }

  /** The lake: flowing bands (the phase follows two scales of noise and a slow drift across the
   * lake), with cooled plates of crust riding on it, cracked through with molten seams. */
  private paintLava(x0: number, y0: number, x1: number, y1: number): void {
    const tex = this.levels[0], seed = this.seed;
    for (let ty = Math.max(0, y0); ty < Math.min(TEX, y1); ty++) {
      const wy = HALF - (ty + 0.5) * RES;
      for (let tx = Math.max(0, x0); tx < Math.min(TEX, x1); tx++) {
        const wx = (tx + 0.5) * RES - HALF;
        const n = valueNoise(wx, wy, 9, seed) * 1.3 + valueNoise(wx, wy, 26, seed + 1) * 0.9;
        const phase = Math.floor((n + (wx * 0.8 + wy * 0.5) / 160) * PHASES);
        const plate = valueNoise(wx, wy, 15, seed + 2) > 0.6 && (n * 7) % 1 > 0.08;
        tex[ty * TEX + tx] = lavaMark(phase, plate ? CRUST : MOLTEN);
      }
    }
  }

  private paintTerrain(x0: number, y0: number, x1: number, y1: number): void {
    if (this.lava) {
      this.paintLava(x0, y0, x1, y1);
      return;
    }
    const t = this.theme;
    const tex = this.levels[0];
    for (let ty = Math.max(0, y0); ty < Math.min(TEX, y1); ty++) {
      const wy = HALF - (ty + 0.5) * RES;
      for (let tx = Math.max(0, x0); tx < Math.min(TEX, x1); tx++) {
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
    const tex = this.levels[0];
    // (lava in a shadow stays lava, only darker; a crack in the rock stays as it is)
    const shadow = (tx: number, ty: number) => {
      const c = tex[ty * TEX + tx];
      return isLava(c) ? lavaMark(c, SHADOW) : isMark(c) ? c : shade(c, 0.62);
    };
    // the volcano's rock bank, laid only over lava (never over road or rock already there), and
    // the glowing rim where it meets the lava
    const rock = (tx: number, ty: number) => {
      const c = tex[ty * TEX + tx];
      if (!isLava(c)) return c;
      const wx = (tx + 0.5) * RES - HALF, wy = HALF - (ty + 0.5) * RES;
      if (Math.abs(valueNoise(wx, wy, 6, this.seed + 6) - 0.5) < 0.022) return lavaMark(c, CRACK);
      if (hash2(tx, ty, 13) > 0.975) return t.groundSpeck;
      return shade(t.ground[(Math.floor(wx / 4) + Math.floor(wy / 4)) & 1], 0.78 + 0.4 * valueNoise(wx, wy, 2.5, this.seed + 5));
    };
    const rim = (tx: number, ty: number) => {
      const c = tex[ty * TEX + tx];
      return isLava(c) ? lavaMark(c, CRACK) : c;
    };
    for (let i = start; i < end; i++) {
      const j = track.wrap(i + 1);
      const hw = HALF_WIDTH;
      if (Math.max(track.elev[i], track.elev[j]) > 0.25) {
        // raised road is drawn in 3D; on the ground it leaves a shadow (darkened only once)
        if (!this.shaded.has(i)) strip(i, j, -hw, hw, shadow);
        this.shaded.add(i);
        continue;
      }
      if (this.lava) {
        strip(i, j, -BANK_EDGE + 0.5, BANK_EDGE - 0.5, rock);
        strip(i, j, -BANK_EDGE, BANK_EDGE, rim);
      }
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

  /** Road between dense indices [from, to) was raised after it was painted: repaint the ground
   * around it, then every stretch of road that runs through that area. */
  repaint(track: Track, from: number, to: number): void {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const pad = HALF_WIDTH + 2.5;
    for (let i = from; i < to; i++) {
      x0 = Math.min(x0, track.xs[i] - pad); x1 = Math.max(x1, track.xs[i] + pad);
      y0 = Math.min(y0, track.ys[i] - pad); y1 = Math.max(y1, track.ys[i] + pad);
    }
    const [tx0, ty1] = WorldTexture.texel(x0, y0), [tx1, ty0] = WorldTexture.texel(x1, y1);
    const bx0 = Math.floor(tx0), by0 = Math.floor(ty0), bx1 = Math.ceil(tx1), by1 = Math.ceil(ty1);
    this.paintTerrain(bx0, by0, bx1, by1);
    for (let i = from; i < to; i++) this.shaded.delete(i);
    // every committed stretch that passes through the box (the road underneath, the bridge itself)
    const inside = (i: number) => track.xs[i] > x0 - pad && track.xs[i] < x1 + pad && track.ys[i] > y0 - pad && track.ys[i] < y1 + pad;
    let runStart = -1;
    for (let i = 0; i <= track.count; i++) {
      const ok = i < track.count && inside(i);
      if (ok && runStart < 0) runStart = i;
      if (!ok && runStart >= 0) {
        this.paintRoad(track, runStart, Math.min(track.count, i + 1));
        runStart = -1;
      }
    }
    this.buildMips(bx0, by0, bx1, by1);
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
    // lava marks are not colours: a block of mostly lava keeps a mark (so far lava flows too),
    // and a block at the lava's edge blends the colours the marks stand for
    const lava = this.lava, flat = (c: number) => (isMark(c) ? lavaColor(c, 0) : c);
    for (let k = 1; k < LEVELS; k++) {
      const src = this.levels[k - 1], dst = this.levels[k];
      const sw = TEX >> (k - 1), dw = TEX >> k;
      const ax = Math.max(0, (x0 >> k) - 1), ay = Math.max(0, (y0 >> k) - 1);
      const bx = Math.min(dw, (x1 >> k) + 1), by = Math.min(dw, (y1 >> k) + 1);
      for (let y = ay; y < by; y++) {
        for (let x = ax; x < bx; x++) {
          const i = 2 * y * sw + 2 * x;
          const a = src[i], b = src[i + 1], c = src[i + sw], d = src[i + sw + 1];
          if (lava) {
            const marks = +isMark(a) + +isMark(b) + +isMark(c) + +isMark(d);
            dst[y * dw + x] = marks >= 3 ? (isMark(a) ? a : b)
              : mix(mix(flat(a), flat(b), 0.5), mix(flat(c), flat(d), 0.5), 0.5);
          } else {
            dst[y * dw + x] = mix(mix(a, b, 0.5), mix(c, d, 0.5), 0.5);
          }
        }
      }
    }
  }
}
