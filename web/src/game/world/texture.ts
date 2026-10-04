// The ground under the Mode-7 camera: one 2560 x 2560 texture (0.3 m per texel) covering a
// 768 m square (more on the moon, whose circuits are drawn bigger). Terrain is painted once per race; road is painted into it chunk by chunk, as
// the circuit designer commits each new stretch (raised road, on bridges, is painted as the
// shadow it casts). A mip chain keeps distant ground from shimmering. In the volcano the terrain
// is a lake of lava (marked texels whose colours cycle, world/lava.ts) and the road runs on a
// bank of rock with a glowing rim where it meets the lava. Elsewhere the ground is shaded as if it
// rose and fell (a height field lit from the north-west), so the land does not read as flat.

import { hash2, hex, mix, shade, valueNoise } from "../core/gfx";
import type { Theme } from "../themes";
import { CRACK, CRUST, MOLTEN, PHASES, SHADOW, isLava, isMark, lavaColor, lavaMark } from "./lava";
import { type Hazard, hazardColor } from "./hazards";
import { HALF_WIDTH, MAX_FROM_START, type Track } from "./track";

const PUDDLE_NEON = [hex("#ff4f9a"), hex("#39d5ff"), hex("#ffb347"), hex("#9d6bff")]; // Tokyo's, in its puddles

export const TEX = 2560; // texels across, in a world of the usual scale
export const RES = 0.3; // meters per texel
export const HALF = (TEX * RES) / 2; // such a world spans [-HALF, HALF]
const LEVELS = 5;
const RELIEF_STEP = 4; // texels between samples of the ground's relief (its rises are tens of meters across)

/** Texels across the ground of a world that draws its circuits ``scale`` times the usual size:
 * room for the farthest a lap may reach from its start, with a margin (never less than TEX). */
export function texSize(scale = 1): number {
  return Math.max(TEX, Math.ceil((2 * (MAX_FROM_START * scale + 24)) / RES / 16) * 16);
}

/** Half the side of that ground's square (m): the world spans [-half, half]. */
export const worldHalf = (scale = 1): number => (texSize(scale) * RES) / 2;

/** valueNoise(wx, wy, cell, seed) for texels [x0, x1) of the row at ``wy`` (wx at each texel's
 * middle, as the painters work it out), into ``out``: the same numbers, with each noise cell's
 * corners hashed once instead of at every texel (painting is mostly noise). */
function noiseRow(out: Float64Array, x0: number, x1: number, half: number, wy: number, cell: number, seed: number): void {
  const gy = wy / cell, iy = Math.floor(gy), fy = gy - iy, sy = fy * fy * (3 - 2 * fy);
  let at = NaN, a = 0, b = 0, c = 0, d = 0;
  for (let tx = x0; tx < x1; tx++) {
    const gx = ((tx + 0.5) * RES - half) / cell, ix = Math.floor(gx), fx = gx - ix;
    if (ix !== at) {
      at = ix;
      a = hash2(ix, iy, seed); b = hash2(ix + 1, iy, seed);
      c = hash2(ix, iy + 1, seed); d = hash2(ix + 1, iy + 1, seed);
    }
    const sx = fx * fx * (3 - 2 * fx);
    out[tx] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
}
const KERB_KAPPA = 1 / 40; // corners tighter than 40 m radius get kerbs
/** In the volcano: how far from the centerline the rock goes (road, shoulder, then 2.6 m of
 * bank); past it is lava. */
export const BANK_EDGE = HALF_WIDTH + 1.8 + 2.6;

export class WorldTexture {
  readonly levels: Uint32Array[] = [];
  readonly lava: boolean; // the terrain is lava (the volcano)
  readonly size: number; // texels across
  readonly half: number; // m: the world spans [-half, half]
  private readonly rg: number; // relief samples across
  private readonly shaded = new Set<number>(); // raised road whose shadow is already painted
  private readonly relief: Float32Array | null; // the light on the ground's rises, every RELIEF_STEP texels
  private hazards: Hazard[] = []; // painted into the ground (world/hazards.ts), and again after any repaint
  private readonly rows: Float64Array[]; // a row of each scale of noise, as it is painted
  constructor(readonly theme: Theme, readonly seed: number) {
    this.lava = !!theme.volcano;
    this.size = theme.tube ? 256 : texSize(theme.scale); // (inside the tube the ground is never seen)
    this.half = (this.size * RES) / 2;
    this.rg = this.size / RELIEF_STEP + 1;
    this.rows = [0, 1, 2, 3].map(() => new Float64Array(this.size));
    this.relief = this.makeRelief(theme, seed);
    for (let k = 0; k < LEVELS; k++) this.levels.push(new Uint32Array((this.size >> k) * (this.size >> k)));
    this.paintTerrain(0, 0, this.size, this.size);
    this.buildMips(0, 0, this.size, this.size);
  }

  /** The light on the rise and fall of the ground: a height field (two scales of noise, up to
   * ``theme.relief`` m from its lowest to its highest) lit from the north-west, as a factor on the
   * ground's colour; null where the ground is flat. */
  private makeRelief(theme: Theme, seed: number): Float32Array | null {
    const amp = theme.relief ?? 0;
    if (amp <= 0 || theme.volcano) return null;
    const RG = this.rg;
    const d = RELIEF_STEP * RES, hgt = new Float32Array(RG * RG), out = new Float32Array(RG * RG);
    for (let gy = 0; gy < RG; gy++) {
      const wy = this.half - gy * d;
      for (let gx = 0; gx < RG; gx++) {
        const wx = gx * d - this.half;
        hgt[gy * RG + gx] = amp * (valueNoise(wx, wy, 56, seed + 77) * 0.7 + valueNoise(wx, wy, 21, seed + 78) * 0.3);
      }
    }
    const lx = -0.55, ly = 0.55, lz = 0.63;
    for (let gy = 0; gy < RG; gy++) {
      for (let gx = 0; gx < RG; gx++) {
        const hx = (hgt[gy * RG + Math.min(RG - 1, gx + 1)] - hgt[gy * RG + Math.max(0, gx - 1)]) / (2 * d);
        const hy = (hgt[Math.max(0, gy - 1) * RG + gx] - hgt[Math.min(RG - 1, gy + 1) * RG + gx]) / (2 * d);
        const lit = (-hx * lx - hy * ly + lz) / Math.sqrt(hx * hx + hy * hy + 1) / lz;
        out[gy * RG + gx] = Math.max(0.6, Math.min(1.35, 1 + (lit - 1) * 1.6));
      }
    }
    return out;
  }

  /** The relief's light at texel (tx, ty), between its samples (1 where the ground is flat). */
  private lightAt(tx: number, ty: number): number {
    const r = this.relief;
    if (!r) return 1;
    const RG = this.rg;
    const fx = tx / RELIEF_STEP, fy = ty / RELIEF_STEP;
    const ix = Math.min(RG - 2, Math.floor(fx)), iy = Math.min(RG - 2, Math.floor(fy));
    const u = fx - ix, v = fy - iy, k = iy * RG + ix;
    return (r[k] * (1 - u) + r[k + 1] * u) * (1 - v) + (r[k + RG] * (1 - u) + r[k + RG + 1] * u) * v;
  }

  /** Hazards set out beside a locked lap: painted into the ground. */
  addHazards(hazards: Hazard[]): void {
    this.hazards.push(...hazards);
    for (const h of hazards) {
      const r = Math.max(h.rx, h.ry) + 1;
      const [ax, ay] = this.texel(h.x - r, h.y + r), [bx, by] = this.texel(h.x + r, h.y - r);
      const x0 = Math.max(0, Math.floor(ax)), y0 = Math.max(0, Math.floor(ay)), x1 = Math.min(this.size, Math.ceil(bx)), y1 = Math.min(this.size, Math.ceil(by));
      this.paintHazards(x0, y0, x1, y1);
      this.buildMips(x0, y0, x1, y1);
    }
  }

  /** The hazards over texels [x0, x1) x [y0, y1). */
  private paintHazards(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.hazards.length) return;
    const tex = this.levels[0];
    for (let ty = Math.max(0, y0); ty < Math.min(this.size, y1); ty++) {
      const wy = this.half - (ty + 0.5) * RES;
      for (let tx = Math.max(0, x0); tx < Math.min(this.size, x1); tx++) {
        const wx = (tx + 0.5) * RES - this.half;
        for (const h of this.hazards) {
          const r = Math.max(h.rx, h.ry) + 0.5;
          if (Math.abs(wx - h.x) > r || Math.abs(wy - h.y) > r) continue;
          const i = ty * this.size + tx, c = hazardColor(h, wx, wy, tex[i]);
          if (c !== tex[i]) { tex[i] = c; break; }
        }
      }
    }
  }

  /** World meters -> level-0 texel coordinates. */
  texel(x: number, y: number): [number, number] {
    return [(x + this.half) / RES, (this.half - y) / RES];
  }

  /** Whether the ground at world (x, y) is lava (beyond the texture, the lake goes on). */
  lavaAt(x: number, y: number): boolean {
    if (!this.lava) return false;
    const [tx, ty] = this.texel(x, y);
    const ix = Math.floor(tx), iy = Math.floor(ty);
    if (ix < 0 || iy < 0 || ix >= this.size || iy >= this.size) return true;
    return isLava(this.levels[0][iy * this.size + ix]);
  }

  /** The lake: flowing bands (the phase follows two scales of noise and a slow drift across the
   * lake), with cooled plates of crust riding on it, cracked through with molten seams. */
  private paintLava(x0: number, y0: number, x1: number, y1: number): void {
    const tex = this.levels[0], seed = this.seed, [n9, n26, n15] = this.rows;
    const xa = Math.max(0, x0), xb = Math.min(this.size, x1);
    for (let ty = Math.max(0, y0); ty < Math.min(this.size, y1); ty++) {
      const wy = this.half - (ty + 0.5) * RES;
      noiseRow(n9, xa, xb, this.half, wy, 9, seed);
      noiseRow(n26, xa, xb, this.half, wy, 26, seed + 1);
      noiseRow(n15, xa, xb, this.half, wy, 15, seed + 2);
      for (let tx = xa; tx < xb; tx++) {
        const wx = (tx + 0.5) * RES - this.half;
        const n = n9[tx] * 1.3 + n26[tx] * 0.9;
        const phase = Math.floor((n + (wx * 0.8 + wy * 0.5) / 160) * PHASES);
        const plate = n15[tx] > 0.6 && (n * 7) % 1 > 0.08;
        tex[ty * this.size + tx] = lavaMark(phase, plate ? CRUST : MOLTEN);
      }
    }
  }

  /** A building site's churned dirt: two tones, darker mud, gravel, and the tread of the machines'
   * tracks in patches. */
  private paintDirt(x0: number, y0: number, x1: number, y1: number): void {
    const t = this.theme, tex = this.levels[0], seed = this.seed, [n7, n31] = this.rows;
    const xa = Math.max(0, x0), xb = Math.min(this.size, x1);
    for (let ty = Math.max(0, y0); ty < Math.min(this.size, y1); ty++) {
      const wy = this.half - (ty + 0.5) * RES;
      noiseRow(n7, xa, xb, this.half, wy, 7, seed);
      noiseRow(n31, xa, xb, this.half, wy, 31, seed + 1);
      for (let tx = xa; tx < xb; tx++) {
        const wx = (tx + 0.5) * RES - this.half;
        const n = n7[tx], m = n31[tx];
        let c = shade(mix(t.ground[0], t.ground[1], n), 0.88 + 0.22 * m);
        if (m > 0.72) c = shade(c, 0.78); // mud
        const tread = ((wx * 0.6 + wy * 0.8) % 2.6 + 2.6) % 2.6;
        if (n > 0.55 && m < 0.6 && (tread < 0.22 || (tread > 1.1 && tread < 1.32))) c = shade(c, 0.8);
        if (hash2(tx, ty, seed) > 0.982) c = t.groundSpeck;
        tex[ty * this.size + tx] = shade(c, this.lightAt(tx, ty));
      }
    }
  }

  /** Tokyo's ground at night: wet paving in 3 m slabs, puddles holding the city's neon (pink,
   * cyan, amber or violet, brightest in the middle), and an iron manhole cover here and there. */
  private paintCity(x0: number, y0: number, x1: number, y1: number): void {
    const t = this.theme, tex = this.levels[0], seed = this.seed, [n4, n17, n9, n23] = this.rows;
    const xa = Math.max(0, x0), xb = Math.min(this.size, x1);
    for (let ty = Math.max(0, y0); ty < Math.min(this.size, y1); ty++) {
      const wy = this.half - (ty + 0.5) * RES;
      noiseRow(n4, xa, xb, this.half, wy, 4, seed);
      noiseRow(n17, xa, xb, this.half, wy, 17, seed + 1);
      noiseRow(n9, xa, xb, this.half, wy, 9, seed + 2);
      noiseRow(n23, xa, xb, this.half, wy, 23, seed + 3);
      const jy = ((wy % 3) + 3) % 3 < 0.14;
      for (let tx = xa; tx < xb; tx++) {
        const wx = (tx + 0.5) * RES - this.half;
        let c = shade(mix(t.ground[0], t.ground[1], n4[tx]), 0.9 + 0.2 * n17[tx]);
        if (jy || ((wx % 3) + 3) % 3 < 0.14) c = shade(c, 0.8); // the joints between slabs
        const wet = n9[tx];
        if (wet > 0.64) {
          const g = (wet - 0.64) / 0.36, neon = PUDDLE_NEON[Math.min(3, Math.floor(n23[tx] * 4))];
          c = mix(shade(c, 0.55), neon, 0.1 + 0.42 * g * g);
        }
        if (hash2(tx, ty, seed) > 0.986) c = t.groundSpeck;
        tex[ty * this.size + tx] = c;
      }
    }
    // manhole covers, one in a few 20 m squares: an iron disc ruled with a grid, a brighter rim
    const cell = 20;
    for (let gy = Math.floor((this.half - y1 * RES) / cell) - 1; gy <= Math.ceil((this.half - y0 * RES) / cell); gy++) {
      for (let gx = Math.floor((x0 * RES - this.half) / cell) - 1; gx <= Math.ceil((x1 * RES - this.half) / cell); gx++) {
        if (hash2(gx, gy, seed + 9) > 0.3) continue;
        const cx = (gx + 0.2 + 0.6 * hash2(gx, gy, seed + 10)) * cell, cy = (gy + 0.2 + 0.6 * hash2(gx, gy, seed + 11)) * cell;
        const [ctx, cty] = this.texel(cx, cy), span = Math.ceil(0.85 / RES);
        for (let ty = Math.max(y0, 0, Math.floor(cty - span)); ty < Math.min(y1, this.size, cty + span + 1); ty++) {
          for (let tx = Math.max(x0, 0, Math.floor(ctx - span)); tx < Math.min(x1, this.size, ctx + span + 1); tx++) {
            const d = Math.hypot(tx + 0.5 - ctx, ty + 0.5 - cty) * RES;
            if (d > 0.8) continue;
            tex[ty * this.size + tx] = d > 0.66 ? hex("#4a4d55") : (tx + ty) % 2 ? hex("#2a2c32") : hex("#34363d");
          }
        }
      }
    }
  }

  /** The moon's regolith, grey and fine, pocked all over with craters: a bowl in shadow on the
   * side the light comes from and lit on the other, inside a bright rim of thrown-out dust. */
  private paintCraters(x0: number, y0: number, x1: number, y1: number): void {
    const t = this.theme, tex = this.levels[0], seed = this.seed, [n5, n41] = this.rows;
    const xa = Math.max(0, x0), xb = Math.min(this.size, x1);
    for (let ty = Math.max(0, y0); ty < Math.min(this.size, y1); ty++) {
      const wy = this.half - (ty + 0.5) * RES;
      noiseRow(n5, xa, xb, this.half, wy, 5, seed);
      noiseRow(n41, xa, xb, this.half, wy, 41, seed + 1);
      for (let tx = xa; tx < xb; tx++) {
        const n = n5[tx] * 0.6 + n41[tx] * 0.4;
        const c = hash2(tx, ty, seed) > 0.985 ? t.groundSpeck : shade(t.ground[0], 0.82 + 0.3 * n);
        tex[ty * this.size + tx] = shade(c, this.lightAt(tx, ty));
      }
    }
    let r = (seed * 2654435761) >>> 0;
    const next = () => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296);
    const count = Math.round(1100 * (this.size / TEX) ** 2); // as many to the square meter in a bigger world
    for (let k = 0; k < count; k++) {
      const cx = (next() - 0.5) * 2 * this.half, cy = (next() - 0.5) * 2 * this.half, rad = 1.6 + 12 * next() ** 3;
      const [ctx, cty] = this.texel(cx, cy), span = Math.ceil((rad * 1.25) / RES);
      for (let ty = Math.max(y0, 0, Math.floor(cty - span)); ty < Math.min(y1, this.size, cty + span); ty++) {
        for (let tx = Math.max(x0, 0, Math.floor(ctx - span)); tx < Math.min(x1, this.size, ctx + span); tx++) {
          const dx = (tx - ctx) * RES / rad, dy = -(ty - cty) * RES / rad, d = Math.hypot(dx, dy);
          if (d > 1.25) continue;
          const i = ty * this.size + tx, light = -0.6 * dx + 0.8 * dy; // the sun from the north-west
          tex[i] = d < 1 ? shade(tex[i], 0.8 - 0.25 * light * Math.sqrt(1 - d * d)) : shade(tex[i], 1.12 + 0.1 * (1.25 - d));
        }
      }
    }
  }

  private paintTerrain(x0: number, y0: number, x1: number, y1: number): void {
    if (this.lava) {
      this.paintLava(x0, y0, x1, y1);
      return;
    }
    if (this.theme.terrain === "dirt") {
      this.paintDirt(x0, y0, x1, y1);
      return;
    }
    if (this.theme.terrain === "craters") {
      this.paintCraters(x0, y0, x1, y1);
      return;
    }
    if (this.theme.terrain === "city") {
      this.paintCity(x0, y0, x1, y1);
      return;
    }
    const t = this.theme;
    const tex = this.levels[0], [n6, n23] = this.rows;
    const xa = Math.max(0, x0), xb = Math.min(this.size, x1);
    for (let ty = Math.max(0, y0); ty < Math.min(this.size, y1); ty++) {
      const wy = this.half - (ty + 0.5) * RES;
      noiseRow(n6, xa, xb, this.half, wy, 6, this.seed);
      noiseRow(n23, xa, xb, this.half, wy, 23, this.seed + 1);
      for (let tx = xa; tx < xb; tx++) {
        const wx = (tx + 0.5) * RES - this.half;
        const band = Math.floor((wx * 0.7 + wy * 0.7) / 9) & 1; // mowing stripes / dune bands
        let c = t.ground[band];
        const n = n6[tx] * 0.6 + n23[tx] * 0.4;
        c = shade(c, 0.9 + 0.2 * n);
        if (t.ripples) { // sand: ripples drawn across it by the current or the wind, wavering
          c = shade(c, 1 + 0.06 * Math.sin((wx * 0.8 + wy * 0.6) * 2.3 + n * 9));
        }
        const h = hash2(tx, ty, this.seed);
        if (h > 0.985) c = t.groundSpeck;
        tex[ty * this.size + tx] = shade(c, this.lightAt(tx, ty));
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
    const ix0 = Math.max(0, Math.floor(x0)), ix1 = Math.min(this.size - 1, Math.ceil(x1));
    const iy0 = Math.max(0, Math.floor(y0)), iy1 = Math.min(this.size - 1, Math.ceil(y1));
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
        tex[ty * this.size + tx] = color(tx, ty);
      }
    }
    box[0] = Math.min(box[0], ix0); box[1] = Math.min(box[1], iy0);
    box[2] = Math.max(box[2], ix1 + 1); box[3] = Math.max(box[3], iy1 + 1);
  }

  /** Paint committed road between dense indices [from, to). */
  paintRoad(track: Track, from: number, to: number): void {
    const t = this.theme;
    const box = [this.size, this.size, 0, 0];
    const start = Math.max(0, from - 1);
    const end = track.locked ? to : to - 1;
    const strip = (i: number, j: number, a: number, b: number, color: (tx: number, ty: number) => number) => {
      const [tix, tiy] = track.tangent(i), [tjx, tjy] = track.tangent(j);
      const P = (k: number, tx: number, ty: number, off: number) =>
        this.texel(track.xs[k] - ty * off, track.ys[k] + tx * off);
      this.quad([P(i, tix, tiy, a), P(j, tjx, tjy, a), P(j, tjx, tjy, b), P(i, tix, tiy, b)], color, box);
    };
    const asphalt = (tx: number, ty: number) => {
      const h = hash2(tx, ty, 7);
      return h > 0.93 ? t.roadSpeck : shade(t.road, 0.96 + 0.08 * hash2(tx >> 2, ty >> 2, 3));
    };
    const tex = this.levels[0];
    // (lava in a shadow stays lava, only darker; a crack in the rock stays as it is)
    const shadow = (tx: number, ty: number) => {
      const c = tex[ty * this.size + tx];
      return isLava(c) ? lavaMark(c, SHADOW) : isMark(c) ? c : shade(c, 0.62);
    };
    // the volcano's rock bank, laid only over lava (never over road or rock already there), and
    // the glowing rim where it meets the lava
    const rock = (tx: number, ty: number) => {
      const c = tex[ty * this.size + tx];
      if (!isLava(c)) return c;
      const wx = (tx + 0.5) * RES - this.half, wy = this.half - (ty + 0.5) * RES;
      if (Math.abs(valueNoise(wx, wy, 6, this.seed + 6) - 0.5) < 0.022) return lavaMark(c, CRACK);
      if (hash2(tx, ty, 13) > 0.975) return t.groundSpeck;
      return shade(t.ground[(Math.floor(wx / 4) + Math.floor(wy / 4)) & 1], 0.78 + 0.4 * valueNoise(wx, wy, 2.5, this.seed + 5));
    };
    const rim = (tx: number, ty: number) => {
      const c = tex[ty * this.size + tx];
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
    const [tx0, ty1] = this.texel(x0, y0), [tx1, ty0] = this.texel(x1, y1);
    const bx0 = Math.floor(tx0), by0 = Math.floor(ty0), bx1 = Math.ceil(tx1), by1 = Math.ceil(ty1);
    this.paintTerrain(bx0, by0, bx1, by1);
    this.paintHazards(bx0, by0, bx1, by1);
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
        const P = (f: number, l: number) => this.texel(cx + tx * f + nx * l, cy + ty * f + ny * l);
        this.quad([P(f0, a), P(f1, a), P(f1, b), P(f0, b)], () => color, box);
      }
    }
    // grid slots: short white bars behind the line, staggered left/right
    for (let k = 0; k < 8; k++) {
      const f = -7 - k * 5.5;
      const l0 = k & 1 ? -HALF_WIDTH + 1.2 : 0.8;
      const P = (ff: number, l: number) => this.texel(cx + tx * ff + nx * l, cy + ty * ff + ny * l);
      this.quad([P(f, l0), P(f + 0.35, l0), P(f + 0.35, l0 + 4.2), P(f, l0 + 4.2)], () => 0xffeeeeee, box);
    }
  }

  private buildMips(x0: number, y0: number, x1: number, y1: number): void {
    // lava marks are not colours: a block of mostly lava keeps a mark (so far lava flows too),
    // and a block at the lava's edge blends the colours the marks stand for
    const lava = this.lava, flat = (c: number) => (isMark(c) ? lavaColor(c, 0) : c);
    for (let k = 1; k < LEVELS; k++) {
      const src = this.levels[k - 1], dst = this.levels[k];
      const sw = this.size >> (k - 1), dw = this.size >> k;
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
