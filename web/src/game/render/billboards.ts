// Billboards: scenery and karts projected into the Mode-7 view, depth sorted, scaled with
// nearest-neighbor (the SNES look), with soft ground shadows under the karts.

import { H, W, mix, type Screen, type Sprite } from "../core/gfx";
import type { Kart } from "../race/kart";
import type { Placed } from "../world/scenery";
import type { Camera } from "./mode7";
import { KART_VIEWS } from "./sprites";

interface Item {
  z: number;
  sx: number;
  gy: number;
  ppm: number; // pixels per meter at this depth
  draw: () => void;
}

export function drawWorldSprites(scr: Screen, cam: Camera, scenery: Placed[], karts: Kart[],
                                 kartSprites: Sprite[][], fog: number, sparks: (k: Kart) => number): void {
  const fx = Math.cos(cam.heading), fy = Math.sin(cam.heading);
  const rx = Math.sin(cam.heading), ry = -Math.cos(cam.heading);
  const items: Item[] = [];
  const project = (x: number, y: number) => {
    const dx = x - cam.x, dy = y - cam.y;
    const z = dx * fx + dy * fy;
    if (z < 1.2 || z > cam.far) return null;
    const lat = dx * rx + dy * ry;
    const ppm = cam.focal / z;
    const sx = W / 2 + lat * ppm;
    if (sx < -200 || sx > W + 200) return null;
    return { z, sx, gy: cam.horizon + cam.height * ppm, ppm };
  };
  const fogAt = (z: number) => (z > cam.far * 0.45 ? Math.min(1, (z - cam.far * 0.45) / (cam.far * 0.55)) ** 1.5 : 0);

  for (const it of scenery) {
    const p = project(it.x, it.y);
    if (!p) continue;
    const h = it.art.height * p.ppm;
    if (h < 1.5) continue;
    const w = (h * it.art.sprite.w) / it.art.sprite.h;
    items.push({ ...p, draw: () => scr.blitScaled(it.art.sprite, p.sx - w / 2, p.gy - h, w, h, it.flip, fog, fogAt(p.z)) });
  }
  for (const k of karts) {
    const p = project(k.x, k.y);
    if (!p) continue;
    const sprites = kartSprites[k.livery % kartSprites.length];
    const view = Math.atan2(k.y - cam.y, k.x - cam.x); // camera -> kart, world frame
    let rel = view - (k.heading + k.slip);
    if (k.isPlayer) rel -= k.steer * 0.18; // lean into the steer
    const vi = (((Math.round((rel / (Math.PI * 2)) * KART_VIEWS) % KART_VIEWS) + KART_VIEWS) % KART_VIEWS);
    const s = sprites[vi];
    const h = 1.75 * p.ppm * (s.h / 44);
    const w = (h * s.w) / s.h;
    const bounce = k.surface === "grass" && Math.abs(k.v) > 3 ? Math.round(Math.sin(performance.now() / 45 + k.id)) : 0;
    items.push({
      ...p,
      draw: () => {
        shadow(scr, p.sx, p.gy, 1.0 * p.ppm, 0.32 * p.ppm);
        scr.blitScaled(s, p.sx - w / 2, p.gy - h * 0.86 + bounce, w, h, false, fog, fogAt(p.z));
        const sp = sparks(k);
        if (sp) drawSparks(scr, p.sx, p.gy, p.ppm, sp, k.driftDir);
      },
    });
  }
  items.sort((a, b) => b.z - a.z);
  for (const it of items) it.draw();
}

function shadow(scr: Screen, cx: number, cy: number, rx: number, ry: number): void {
  const buf = scr.buf;
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    if (y < 0 || y >= H) continue;
    const half = rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / ry) ** 2));
    for (let x = Math.floor(cx - half); x <= cx + half; x++) {
      if (x < 0 || x >= W) continue;
      buf[y * W + x] = mix(buf[y * W + x], 0xff000000, 0.35);
    }
  }
}

function drawSparks(scr: Screen, cx: number, gy: number, ppm: number, level: number, dir: number): void {
  const colors = level === 2 ? [0xff2b8cff, 0xff63c8ff, 0xffffffff] : [0xffffb347, 0xffffe0a0, 0xffffffff];
  const t = performance.now() / 60;
  for (let k = 0; k < 7; k++) {
    const side = k & 1 ? 1 : -1;
    const x = cx + side * 0.75 * ppm + Math.sin(t + k * 1.7) * 0.4 * ppm - dir * 0.2 * ppm;
    const y = gy - (0.1 + ((t * 0.37 + k * 0.29) % 0.6)) * ppm;
    const c = colors[k % 3];
    const r = Math.max(1, Math.round(ppm * 0.06));
    scr.fillRect(x - r / 2, y - r / 2, r, r, c);
  }
}
