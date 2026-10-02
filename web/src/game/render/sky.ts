// A 360-degree parallax backdrop per theme: gradient sky, stars or clouds, a sun, and two hill
// silhouettes that scroll at different rates as the camera turns.

import { H, Rand, W, mix, shade, type Screen } from "../core/gfx";
import type { Theme } from "../themes";

const PAN = 1536; // panorama width in px for a full turn

export class Sky {
  private readonly far: Uint32Array;
  private readonly near: Uint32Array;
  constructor(readonly theme: Theme, readonly horizon: number, seed: number) {
    const rng = new Rand(seed);
    const h = horizon + 1;
    this.far = new Uint32Array(PAN * h);
    this.near = new Uint32Array(PAN * h);
    const t = theme;
    for (let y = 0; y < h; y++) {
      const c = mix(t.skyTop, t.skyHorizon, (y / h) ** 1.4);
      this.far.fill(c, y * PAN, (y + 1) * PAN);
    }
    if (t.stars) {
      for (let k = 0; k < 220; k++) {
        const x = rng.int(0, PAN), y = rng.int(0, Math.floor(h * 0.7));
        this.far[y * PAN + x] = rng.next() > 0.8 ? 0xffffffff : 0xffc8b8ff;
      }
    }
    if (t.sun) this.drawSun(rng, h);
    if (t.clouds) {
      for (let k = 0; k < 14; k++) this.cloud(rng, rng.int(0, PAN), rng.int(6, Math.floor(h * 0.55)));
    }
    this.hills(this.far, rng, h, t.farHills, 0.62, 26, 3);
    this.hills(this.near, rng, h, t.nearHills, 0.82, 12, 5);
  }

  private drawSun(rng: Rand, h: number): void {
    const cx = rng.int(200, PAN - 200), cy = Math.floor(h * 0.62), r = 22;
    for (let y = cy - r - 8; y <= cy + r; y++) {
      for (let x = cx - r - 8; x <= cx + r + 8; x++) {
        if (y < 0 || y >= h) continue;
        const d = Math.hypot(x - cx, y - cy);
        const i = y * PAN + ((x + PAN) % PAN);
        if (d <= r) {
          // synthwave stripes across the lower half of the sun
          const stripe = y > cy && ((y - cy) % 5) < 1 + (y - cy) / 12;
          if (!stripe) this.far[i] = mix(this.theme.sun, 0xffffffff, Math.max(0, (cy - y) / r) * 0.5);
        } else if (d <= r + 8) {
          this.far[i] = mix(this.far[i], this.theme.sun, 0.25 * (1 - (d - r) / 8));
        }
      }
    }
  }

  private cloud(rng: Rand, cx: number, cy: number): void {
    const puffs = rng.int(3, 6);
    for (let p = 0; p < puffs; p++) {
      const px = cx + p * rng.int(7, 11), py = cy - rng.int(0, 4), r = rng.int(4, 8);
      for (let y = py - r; y <= cy + 2; y++) {
        for (let x = px - r; x <= px + r; x++) {
          if (y < 0 || Math.hypot(x - px, y - py) > r) continue;
          const i = y * PAN + ((x + PAN) % PAN);
          this.far[i] = y > cy - 1 ? shade(this.theme.clouds, 0.9) : this.theme.clouds;
        }
      }
    }
  }

  private hills(dst: Uint32Array, rng: Rand, h: number, color: number, base: number, amp: number,
                octaves: number): void {
    // a periodic 1-D fractal profile: sums of sines with integer frequencies wrap seamlessly
    const comps = Array.from({ length: octaves * 3 }, (_, k) => ({
      f: 1 + rng.int(1, 4 + k * 3), a: rng.range(0.4, 1) / (1 + k), p: rng.range(0, Math.PI * 2),
    }));
    const norm = comps.reduce((s, c) => s + c.a, 0);
    for (let x = 0; x < PAN; x++) {
      const th = (x / PAN) * Math.PI * 2;
      let v = 0;
      for (const c of comps) v += c.a * Math.sin(c.f * th + c.p);
      const top = Math.floor(h * base - (v / norm) * amp - amp * 0.4);
      for (let y = Math.max(0, top); y < h; y++) {
        dst[y * PAN + x] = y === top ? shade(color, 1.25) : shade(color, 1 - 0.25 * ((y - top) / Math.max(1, h - top)));
      }
    }
  }

  draw(scr: Screen, heading: number): void {
    const buf = scr.buf;
    const h = this.horizon + 1;
    const off = (layer: number) => Math.floor((-heading / (Math.PI * 2)) * PAN * layer);
    const of = off(1), on = off(1.6);
    for (let y = 0; y < Math.min(h, H); y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const n = this.near[y * PAN + ((((x + on) % PAN) + PAN) % PAN)];
        buf[row + x] = n || this.far[y * PAN + ((((x + of) % PAN) + PAN) % PAN)];
      }
    }
  }
}
