// Port of dreamcircuit/sim/render.py. Arithmetic deliberately mirrors numpy's dtypes: the texture
// sampling runs in float32 (Math.fround after every op, the supersample mean summed in numpy's
// order), compositing and HUD in float64, so frames match the Python renderer byte-for-byte in
// the vast majority of pixels (parity test: tests/sim.parity.test.ts).

import { type RenderConfig, type SpriteData, type VehicleParams, clip } from "./config";
import type { Track } from "./track";
import { DELTA, PSI, VX, X, Y } from "./vehicle";

const f = Math.fround;
const HUD_BG = [18.0, 18.0, 22.0];
const SPEED_BAR = [238.0, 238.0, 238.0];
const STEER_MARK = [255.0, 190.0, 40.0];

export class EgoRenderer {
  private readonly fwd: Float32Array;
  private readonly left: Float32Array;
  private readonly spriteIdx: Int32Array;
  private readonly spriteOneMinusA: Float64Array; // fround(1 - a32)
  private readonly spriteRgbA: Float64Array; // fround(rgb32 * a32), 3 per pixel
  private readonly sampled: Float32Array;
  private readonly img: Float64Array;
  // per-frame scratch: products that depend on only the row or only the column
  private readonly fc: Float32Array;
  private readonly fs: Float32Array;
  private readonly ls: Float32Array;
  private readonly lc: Float32Array;

  constructor(readonly track: Track, readonly cfg: RenderConfig, readonly vehicle: VehicleParams,
              sprite: SpriteData) {
    const n = cfg.size * cfg.supersample;
    this.fwd = new Float32Array(n);
    this.left = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const sub = (i + 0.5) / cfg.supersample;
      this.fwd[i] = (cfg.car_row - sub) * cfg.meters_per_px;
      this.left[i] = (cfg.car_col - sub) * cfg.meters_per_px;
    }
    const m = sprite.pixels.length;
    this.spriteIdx = new Int32Array(m);
    this.spriteOneMinusA = new Float64Array(m);
    this.spriteRgbA = new Float64Array(3 * m);
    sprite.pixels.forEach(([idx, r, g, b, a], k) => {
      const a32 = f(a);
      this.spriteIdx[k] = idx;
      this.spriteOneMinusA[k] = f(1 - a32);
      this.spriteRgbA[3 * k] = f(f(r) * a32);
      this.spriteRgbA[3 * k + 1] = f(f(g) * a32);
      this.spriteRgbA[3 * k + 2] = f(f(b) * a32);
    });
    this.sampled = new Float32Array(cfg.size * cfg.size * 3);
    this.img = new Float64Array(cfg.size * cfg.size * 3);
    this.fc = new Float32Array(n);
    this.fs = new Float32Array(n);
    this.ls = new Float32Array(n);
    this.lc = new Float32Array(n);
  }

  /** Bilinear, supersampled texture view into ``this.sampled`` (float32, HWC). */
  private sampleWorld(x: number, y: number, psi: number): void {
    const { size, supersample: ss } = this.cfg;
    const tr = this.track;
    const n = size * ss;
    const c = f(Math.cos(psi));
    const s = f(Math.sin(psi));
    const ax = f(x - tr.origin[0]);
    const ay = f(tr.origin[1] - y);
    for (let i = 0; i < n; i++) {
      this.fc[i] = f(this.fwd[i] * c);
      this.fs[i] = f(this.fwd[i] * s);
      this.ls[i] = f(this.left[i] * s);
      this.lc[i] = f(this.left[i] * c);
    }
    const res = f(tr.texRes);
    const w = tr.texW;
    const hgt = tr.texH;
    const t = tr.tex;
    const out = this.sampled;
    out.fill(0);
    for (let oy = 0; oy < size; oy++) {
      for (let a = 0; a < ss; a++) {
        const i = oy * ss + a;
        const rowA = f(ax + this.fc[i]);
        for (let ox = 0; ox < size; ox++) {
          for (let b = 0; b < ss; b++) {
            const j = ox * ss + b;
            const wx = f(rowA - this.ls[j]);
            const wy = f(ay - f(this.fs[i] + this.lc[j]));
            const col = f(f(wx / res) - 0.5);
            const row = f(f(wy / res) - 0.5);
            const c0 = Math.floor(col);
            const r0 = Math.floor(row);
            const fcw = f(col - c0);
            const frw = f(row - r0);
            const c0i = clip(c0, 0, w - 1);
            const r0i = clip(r0, 0, hgt - 1);
            const c1i = clip(c0i + 1, 0, w - 1);
            const r1i = clip(r0i + 1, 0, hgt - 1);
            const omc = f(1 - fcw);
            const omr = f(1 - frw);
            const p00 = 3 * (r0i * w + c0i);
            const p01 = 3 * (r0i * w + c1i);
            const p10 = 3 * (r1i * w + c0i);
            const p11 = 3 * (r1i * w + c1i);
            const o = 3 * (oy * size + ox);
            for (let ch = 0; ch < 3; ch++) {
              const top = f(f(t[p00 + ch] * omc) + f(t[p01 + ch] * fcw));
              const bot = f(f(t[p10 + ch] * omc) + f(t[p11 + ch] * fcw));
              const v = f(f(top * omr) + f(bot * frw));
              // numpy sums the SxS block sequentially in float32: ((v00 + v01) + v10) + v11
              out[o + ch] = a === 0 && b === 0 ? v : f(out[o + ch] + v);
            }
          }
        }
      }
    }
    const inv = ss * ss;
    for (let k = 0; k < out.length; k++) out[k] = f(out[k] / inv);
  }

  private drawHud(speedFrac: number, steerFrac: number): void {
    const s = this.cfg.size;
    const img = this.img;
    for (let row = s - this.cfg.hud_rows; row < s; row++) {
      for (let col = 0; col < s; col++) {
        for (let ch = 0; ch < 3; ch++) img[3 * (row * s + col) + ch] = HUD_BG[ch];
      }
    }
    const barLen = (s - 4) * clip(speedFrac, 0.0, 1.0);
    const mark = s / 2 - (s / 2 - 4) * clip(steerFrac, -1.0, 1.0);
    for (let col = 0; col < s; col++) {
      const inBar = col >= 2 && col < s - 2 ? 1 : 0;
      const covBar = clip(barLen - (col - 2.0), 0.0, 1.0) * inBar;
      const covMark = clip(Math.min(col + 1.0, mark + 1.0) - Math.max(col, mark - 1.0), 0.0, 1.0);
      for (const [row, cov, color] of [[s - 4, covBar, SPEED_BAR], [s - 3, covBar, SPEED_BAR],
                                       [s - 2, covMark, STEER_MARK], [s - 1, covMark, STEER_MARK]] as
                                      [number, number, number[]][]) {
        for (let ch = 0; ch < 3; ch++) {
          const k = 3 * (row * s + col) + ch;
          img[k] = img[k] * (1 - cov) + color[ch] * cov;
        }
      }
    }
  }

  /** Render a vehicle state into ``out`` as RGB bytes (size * size * 3). */
  renderRGB(state: Float64Array, out: Uint8Array): Uint8Array {
    this.sampleWorld(state[X], state[Y], state[PSI]);
    const img = this.img;
    for (let k = 0; k < img.length; k++) img[k] = this.sampled[k];
    for (let m = 0; m < this.spriteIdx.length; m++) {
      const p = 3 * this.spriteIdx[m];
      for (let ch = 0; ch < 3; ch++) {
        img[p + ch] = img[p + ch] * this.spriteOneMinusA[m] + this.spriteRgbA[3 * m + ch];
      }
    }
    this.drawHud(Math.max(state[VX], 0.0) / this.vehicle.top_speed,
                 state[DELTA] / this.vehicle.max_steer);
    for (let k = 0; k < img.length; k++) out[k] = Math.floor(clip(img[k], 0, 255) + 0.5);
    return out;
  }
}
