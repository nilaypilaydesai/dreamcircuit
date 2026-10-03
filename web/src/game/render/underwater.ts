// Under the sea (the Coral Reef world): sunlight caustics rippling over the sand, shafts of light
// slanting down through the water, bubbles rising past the camera, schools of fish circling the
// reef, and the clear bubble helmet every driver wears down here.

import { H, Rand, W, hex, mix, type Screen } from "../core/gfx";
import { type SceneryArt, fishFrames } from "./sprites";
import type { WorldSprite } from "./billboards";

const CN = 64;
const LUT = new Float32Array(CN * CN);
for (let y = 0; y < CN; y++) {
  for (let x = 0; x < CN; x++) {
    const u = (x / CN) * Math.PI * 2, v = (y / CN) * Math.PI * 2;
    LUT[y * CN + x] = 0.5 + 0.5 * Math.sin(2 * u + 1.2 * Math.sin(3 * v)) * Math.sin(2 * v + 1.1 * Math.sin(2 * u));
  }
}

export const CAUSTIC = hex("#d2fbff");

/** Bright, moving filaments of light on the ground at world (x, y), 0 .. ~0.4, at time ``t``. */
export function caustics(t: number): (x: number, y: number) => number {
  const ox = t * 6, oy = t * 4.5;
  return (x, y) => {
    const a = LUT[((Math.floor(y * 3 + oy) & 63) << 6) | (Math.floor(x * 3 + ox) & 63)];
    const b = LUT[((Math.floor(x * 2.3 - oy) & 63) << 6) | (Math.floor(y * 2.3 + ox * 0.7) & 63)];
    const k = a * b;
    return k > 0.5 ? (k - 0.5) * 0.8 : 0;
  };
}

/** Light shafts and rising bubbles, drawn over the whole view. */
export function waterOverlay(scr: Screen, t: number): void {
  const buf = scr.buf;
  const light = hex("#bff4ff");
  const reach = Math.round(H * 0.8);
  for (let k = 0; k < 5; k++) {
    const cx = ((k * 0.23 + 0.08) * W + Math.sin(t * 0.17 + k * 1.7) * W * 0.06) | 0;
    for (let y = 0; y < reach; y++) {
      const half = 6 + y * 0.12 + 3 * Math.sin(t * 0.6 + k);
      const x0 = Math.max(0, Math.round(cx + y * 0.42 - half)), x1 = Math.min(W, Math.round(cx + y * 0.42 + half));
      const a = 0.09 * (1 - y / reach);
      for (let x = x0; x < x1; x++) buf[y * W + x] = mix(buf[y * W + x], light, a);
    }
  }
  const rng = new Rand(7);
  for (let k = 0; k < 42; k++) {
    const x0 = rng.next() * W, speed = 14 + rng.next() * 26, off = rng.next() * (H + 40), size = rng.next() > 0.8 ? 2 : 1;
    const y = Math.round(H + 20 - ((t * speed + off) % (H + 40)));
    const x = Math.round(x0 + Math.sin(t * 2.3 + k) * 3);
    if (x < 1 || x >= W - 2 || y < 1 || y >= H - 2) continue;
    buf[y * W + x] = mix(buf[y * W + x], 0xffffffff, 0.75);
    if (size > 1) {
      buf[y * W + x + 1] = mix(buf[y * W + x + 1], light, 0.6);
      buf[(y + 1) * W + x] = mix(buf[(y + 1) * W + x], light, 0.6);
    }
  }
}

interface School { cx: number; cy: number; r: number; w: number; ph: number; z: number; n: number; art: SceneryArt[] }

/** Schools of fish circling spots near the road, made once per race. */
export function makeSchools(seed: number, near: (rng: Rand) => [number, number]): School[] {
  const rng = new Rand(seed);
  const colors = ["#ffcf4a", "#ff8a3d", "#63c8ff", "#ff6fb0", "#b6ff3b"].map(hex);
  return Array.from({ length: 12 }, () => {
    const [cx, cy] = near(rng);
    return {
      cx, cy, r: rng.range(7, 18), w: rng.range(0.25, 0.6) * (rng.next() > 0.5 ? 1 : -1), ph: rng.range(0, 6.3),
      z: rng.range(1.8, 6), n: rng.int(3, 7), art: fishFrames(rng.pick(colors)),
    };
  });
}

/** The fish as world sprites at time ``t``, each facing the way it swims across the screen. */
export function fishSprites(schools: School[], t: number, camHeading: number): WorldSprite[] {
  const out: WorldSprite[] = [];
  const rx = Math.sin(camHeading), ry = -Math.cos(camHeading); // screen right
  for (const s of schools) {
    for (let j = 0; j < s.n; j++) {
      const a = s.ph + t * s.w + j * 0.22;
      const r = s.r + (j % 3) * 0.9;
      const vx = -Math.sin(a) * Math.sign(s.w), vy = Math.cos(a) * Math.sign(s.w);
      out.push({
        x: s.cx + Math.cos(a) * r, y: s.cy + Math.sin(a) * r, art: s.art[Math.floor(t * 8 + j) % 2],
        lift: s.z + Math.sin(t * 2 + j) * 0.3, flip: vx * rx + vy * ry < 0,
      });
    }
  }
  return out;
}

/** A clear glass dome over a driver's head: a faint tint, a bright rim and a glint. */
export function drawDome(scr: Screen, cx: number, cy: number, r: number): void {
  const buf = scr.buf;
  const glass = hex("#e6fbff");
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      if (x < 0 || x >= W) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r + 0.6) continue;
      const i = y * W + x;
      buf[i] = mix(buf[i], glass, d > r - 0.9 ? 0.55 : 0.16);
    }
  }
  // a glint on the upper left of the glass
  for (let k = 0; k < Math.max(2, r * 0.6); k++) {
    const a = Math.PI * 1.1 + (k / Math.max(2, r * 0.6)) * 0.7;
    const x = Math.round(cx + Math.cos(a) * r * 0.62), y = Math.round(cy + Math.sin(a) * r * 0.62);
    if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = 0xffffffff;
  }
}
