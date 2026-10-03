// Effects over the whole screen: the static an item fills a racer's screen with, and the ring of
// a horn's blast drawn on the ground around a kart.

import { H, W, hex, mix, type Screen, valueNoise } from "../core/gfx";

const SNOW = [hex("#f4f2ff"), hex("#a49ed0"), hex("#5a5480"), hex("#231e38")];

/** Static over the screen: drifting blotches of snow (more of the screen the stronger it is,
 * ``amount`` 0..1), and scanlines over everything. */
export function staticOverlay(scr: Screen, t: number, amount: number): void {
  if (amount <= 0) return;
  const cell = 3, frame = Math.floor(t * 24);
  for (let cy = 0; cy < H; cy += cell) {
    for (let cx = 0; cx < W; cx += cell) {
      const n = valueNoise(cx + t * 26, cy - t * 14, 52, 17) * 0.7 + valueNoise(cx - t * 9, cy, 19, 23) * 0.3;
      if (n < 1 - 0.62 * amount) continue;
      let h = Math.imul((cx * 73856093) ^ (cy * 19349663) ^ (frame * 83492791), 2654435761) >>> 0;
      h ^= h >>> 15;
      const c = SNOW[h & 3];
      const edge = n < 1.04 - 0.62 * amount; // the soft edge of a blotch: half see-through
      for (let y = cy; y < Math.min(H, cy + cell); y++) {
        for (let x = cx; x < Math.min(W, cx + cell); x++) {
          const i = y * W + x;
          scr.buf[i] = edge ? mix(scr.buf[i], c, 0.5) : c;
        }
      }
    }
  }
  for (let y = 0; y < H; y += 2) scr.dimRect(0, y, W, 1, 0xff000000, 0.14 * amount);
}

/** A horn's blast: rings racing out over the ground from (sx, gy), ``u`` 0..1 through the blast. */
export function hornRing(scr: Screen, sx: number, gy: number, ppm: number, u: number): void {
  for (const lag of [0, 0.22]) {
    const v = u - lag;
    if (v <= 0) continue;
    const rx = 9 * v * ppm, ry = Math.max(2, rx * 0.32), alpha = 0.85 * (1 - v);
    const steps = Math.max(24, Math.ceil(Math.PI * 2 * rx));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = Math.round(sx + Math.cos(a) * rx), y = Math.round(gy + Math.sin(a) * ry);
      if (x < 0 || y < 0 || x >= W || y >= H - 1) continue;
      const i = y * W + x;
      scr.buf[i] = mix(scr.buf[i], hex("#f2fdff"), alpha);
      scr.buf[i + W] = mix(scr.buf[i + W], hex("#5fd8ff"), alpha * 0.8); // a glow under the line
    }
  }
}
