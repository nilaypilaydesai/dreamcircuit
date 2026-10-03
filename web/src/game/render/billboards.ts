// Billboards: scenery and karts projected into the Mode-7 view, scaled with nearest-neighbor
// (the SNES look), with soft shadows under the karts on whatever surface they are over. They are
// depth sorted together with the 3D faces of bridges, ramps and pads (render/poly.ts).
// Karts show what they carry: the item rides out behind them (low and close while it is held as
// a shield), boosts and rockets breathe fire, a prism shimmers through the rainbow and a shocked
// kart is drawn small.

import { H, W, hex, mix, type Screen, type Sprite } from "../core/gfx";
import type { Kart } from "../race/kart";
import type { Placed } from "../world/scenery";
import type { Camera } from "./mode7";
import type { Face } from "./poly";
import { KART_ANCHOR, KART_PX, KART_VIEWS, type SceneryArt } from "./sprites";

/** Moving or animated objects drawn like scenery: item boxes, oil slicks, dream orbs. */
export interface WorldSprite {
  x: number;
  y: number;
  art: SceneryArt;
  lift?: number; // m above the surface under it (it casts a shadow when floating)
  base?: number; // m, height of that surface (a bridge deck)
}

/** How to draw each kart: its 16 views, its drift sparks, and what it carries. */
export interface KartLook {
  sprites: (k: Kart) => Sprite[];
  sparks: (k: Kart) => number;
  held: (k: Kart) => SceneryArt | null;
}

interface Item {
  z: number;
  sx: number;
  gy: number;
  ppm: number; // pixels per meter at this depth
  draw: () => void;
}

const RAINBOW = ["#ff5fa2", "#ffd23f", "#5dff7a", "#63c8ff", "#c79bff"].map(hex);

export function drawWorldSprites(scr: Screen, cam: Camera, scenery: Placed[], karts: Kart[], look: KartLook,
                                 fog: number, extras: WorldSprite[] = [], faces: Face[] = []): void {
  const fx = Math.cos(cam.heading), fy = Math.sin(cam.heading);
  const rx = Math.sin(cam.heading), ry = -Math.cos(cam.heading);
  const items: Item[] = [];
  const now = performance.now() / 1000;
  const project = (x: number, y: number, h = 0) => {
    const dx = x - cam.x, dy = y - cam.y;
    const z = dx * fx + dy * fy;
    if (z < 1.2 || z > cam.far) return null;
    const lat = dx * rx + dy * ry;
    const ppm = cam.focal / z;
    const sx = W / 2 + lat * ppm;
    if (sx < -200 || sx > W + 200) return null;
    return { z, sx, gy: cam.horizon + (cam.height - h) * ppm, ppm };
  };
  // up on a bridge, things at ground level under the deck must be drawn before it
  const lowBias = cam.height > 4.5 ? 2.5 : 0;
  const fogAt = (z: number) => (z > cam.far * 0.45 ? Math.min(1, (z - cam.far * 0.45) / (cam.far * 0.55)) ** 1.5 : 0);
  /** A floating sprite at (x, y), ``lift`` m over a surface at height ``base``. */
  const billboard = (art: SceneryArt, x: number, y: number, base: number, lift: number, bias: number, shadowed = true,
                     size = 1) => {
    const p = project(x, y, base);
    if (!p) return;
    const h = art.height * size * p.ppm;
    if (h < 1) return;
    const w = (h * art.sprite.w) / art.sprite.h;
    const up = lift * p.ppm;
    items.push({
      ...p,
      z: p.z + bias,
      draw: () => {
        if (up > 0 && shadowed) shadow(scr, p.sx, p.gy, w * 0.42, Math.max(1, w * 0.12));
        scr.blitScaled(art.sprite, p.sx - w / 2, p.gy - h - up, w, h, false, fog, fogAt(p.z));
      },
    });
  };

  for (const it of scenery) {
    const p = project(it.x, it.y);
    if (!p || (cam.clear && p.z < cam.clear)) continue;
    const h = it.art.height * p.ppm;
    if (h < 1.5) continue;
    const w = (h * it.art.sprite.w) / it.art.sprite.h;
    items.push({ ...p, z: p.z + lowBias,
      draw: () => scr.blitScaled(it.art.sprite, p.sx - w / 2, p.gy - h, w, h, it.flip, fog, fogAt(p.z)) });
  }
  for (const it of extras) {
    const base = it.base ?? 0;
    billboard(it.art, it.x, it.y, base, it.lift ?? 0, base > 1 ? -0.5 : lowBias);
  }
  for (const k of karts) {
    const p = project(k.x, k.y, k.elev);
    const ps = project(k.x, k.y, k.ground);
    if (!p || !ps) continue;
    const sprites = look.sprites(k);
    const view = Math.atan2(k.y - cam.y, k.x - cam.x); // camera -> kart, world frame
    let rel = view - (k.heading + k.slip + k.visualSpin);
    if (k.isPlayer) rel -= k.steer * 0.18; // lean into the steer
    const vi = (((Math.round((rel / (Math.PI * 2)) * KART_VIEWS) % KART_VIEWS) + KART_VIEWS) % KART_VIEWS);
    const s = sprites[vi];
    const size = k.shrink > 0 ? 0.62 : k.rocket > 0 ? 1.12 : 1;
    const h = 1.75 * p.ppm * (s.h / KART_PX) * size;
    const w = (h * s.w) / s.h;
    const bounce = k.surface === "grass" && Math.abs(k.v) > 3 ? Math.round(Math.sin(performance.now() / 45 + k.id)) : 0;
    const air = Math.max(0, k.elev - k.ground);
    const shrink = (1 / (1 + air * 0.35)) * size;
    const prism = k.prism > 0;
    const tint = prism ? RAINBOW[Math.floor(now * 14 + k.id) % RAINBOW.length] : fog;
    const tintAmount = prism ? (k.prism < 1.5 && Math.floor(now * 10) % 2 ? 0 : 0.42) : fogAt(p.z);
    const bias = k.elev > 1 ? -0.5 : lowBias;
    items.push({
      ...p,
      z: p.z + bias,
      draw: () => {
        shadow(scr, ps.sx, ps.gy, 1.0 * ps.ppm * shrink, 0.32 * ps.ppm * shrink);
        scr.blitScaled(s, p.sx - w / 2, p.gy - h * KART_ANCHOR + bounce, w, h, false, tint, tintAmount);
        const sp = look.sparks(k);
        if (sp) drawSparks(scr, p.sx, p.gy, p.ppm, sp, k.driftDir);
      },
    });
    // fire from the exhaust while boosting (the flamethrower always shows off), and the rocket's plume
    const c = Math.cos(k.heading), sn = Math.sin(k.heading);
    const flames = k.rocket > 0 ? 3 : k.boostTime > 0 ? (k.build.exhaust === "flame" ? 2 : 1) : 0;
    if (flames) {
      const back = k.rocket > 0 ? 2.6 : 1.3;
      const q = project(k.x - c * back, k.y - sn * back, k.elev + (k.rocket > 0 ? 0.55 : 0.3));
      if (q) items.push({ ...q, z: q.z + bias - 0.05, draw: () => drawFlames(scr, q.sx, q.gy, q.ppm, flames) });
    }
    // what it carries, as in the classics: oil, an orb or a bomb held out behind the kart (button
    // down) drags on the road behind it, and triple turbos and boomerangs ride along on the tail
    const art = look.held(k);
    const multi = k.item === "triple" || k.item === "boomerang";
    if (art && k.rocket <= 0 && (k.trailing || multi)) {
      const many = multi ? Math.max(1, k.uses) : 1;
      const dist = k.trailing ? 1.45 : 0.55;
      const lift = k.trailing ? 0.03 : 0.62 + 0.05 * Math.sin(now * 5 + k.id);
      const size = (k.trailing ? 0.5 : 0.4) * (k.shrink > 0 ? 0.62 : 1);
      for (let n = 0; n < many; n++) {
        const lat = (n - (many - 1) / 2) * 0.5;
        const hx = k.x - c * dist - sn * lat, hy = k.y - sn * dist + c * lat;
        billboard(art, hx, hy, k.elev, lift, bias - 0.02, false, size);
      }
    }
  }
  const all: { z: number; draw: () => void }[] = [...items, ...faces];
  all.sort((a, b) => b.z - a.z);
  for (const it of all) it.draw();
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

const FLAME = ["#fff6c8", "#ffd23f", "#ff8a1f", "#ff4d2e"].map(hex);

/** Exhaust fire: small flickering sparks that cool from white to red as they stream away,
 * more of them for the flamethrower and a plume for a rocket. */
function drawFlames(scr: Screen, cx: number, cy: number, ppm: number, size: number): void {
  const t = performance.now() / 50;
  const n = 5 + size * 5;
  const spread = 0.12 + 0.1 * size;
  for (let k = 0; k < n; k++) {
    const u = (t * 0.23 + k * 0.618) % 1; // age of this spark
    const x = cx + Math.sin(t * 0.9 + k * 2.4) * spread * ppm * (0.4 + u);
    const y = cy + u * 0.18 * ppm * size - Math.cos(t * 0.6 + k) * 0.06 * ppm;
    const r = Math.max(1, Math.round(ppm * (0.035 + 0.02 * size) * (1.2 - u)));
    scr.fillRect(x - r / 2, y - r / 2, r, r, FLAME[Math.min(FLAME.length - 1, Math.floor(u * FLAME.length))]);
  }
}
