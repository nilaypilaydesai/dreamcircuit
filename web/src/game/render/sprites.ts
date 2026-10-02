// Procedural pixel art. Karts are tiny voxel models rendered from 16 directions at load time
// (a "voxel baker"); scenery is painted with simple shape primitives. Everything is original.

import { type Sprite, hex, makeSprite, mix, Rand, shade } from "../core/gfx";
import type { SceneryKind } from "../themes";

// ---------------------------------------------------------------------------------- karts

export interface KartLivery {
  name: string;
  body: number;
  accent: number;
  helmet: number;
  suit: number;
}

export const LIVERIES: KartLivery[] = [
  { name: "YOU", body: hex("#ff7a1a"), accent: hex("#ffd166"), helmet: hex("#ffffff"), suit: hex("#2b2d42") },
  { name: "VOLT", body: hex("#2f80ed"), accent: hex("#9be7ff"), helmet: hex("#ffe14d"), suit: hex("#1b2a49") },
  { name: "NOVA", body: hex("#e83f8f"), accent: hex("#ffd1e8"), helmet: hex("#ffffff"), suit: hex("#4a1942") },
  { name: "MOSS", body: hex("#27ae60"), accent: hex("#c8f7c5"), helmet: hex("#f2994a"), suit: hex("#1d3b2a") },
  { name: "BLAZE", body: hex("#eb3b3b"), accent: hex("#ffb4a2"), helmet: hex("#222222"), suit: hex("#3b1111") },
  { name: "PIXEL", body: hex("#9b51e0"), accent: hex("#e0c3fc"), helmet: hex("#56ccf2"), suit: hex("#2a1846") },
  { name: "COMET", body: hex("#f2c94c"), accent: hex("#fff3c4"), helmet: hex("#eb5757"), suit: hex("#3d3416") },
  { name: "ZEPHYR", body: hex("#00b3a6"), accent: hex("#b8fff7"), helmet: hex("#ffffff"), suit: hex("#0d3330") },
];

type Box = [number, number, number, number, number, number, number]; // x0 x1 y0 y1 z0 z1 color

function kartBoxes(l: KartLivery): Box[] {
  const tire = hex("#1c1c22"), hub = hex("#9aa0aa"), dark = hex("#3a3d46"), visor = hex("#20232b");
  return [
    [0, 25, -7, 7, 2, 4, l.body], // floor pan
    [17, 25, -5, 5, 3, 6, l.body], // nose
    [23, 26, -7, 7, 1, 3, dark], // front bumper
    [6, 18, -9, -5, 3, 6, l.accent], // side pods
    [6, 18, 5, 9, 3, 6, l.accent],
    [-2, 4, -6, 6, 3, 7, dark], // engine block
    [-3, -1, -3, -1, 4, 6, hub], [-3, -1, 1, 3, 4, 6, hub], // exhausts
    [-2, 1, -8, 8, 9, 11, l.accent], [-1, 1, -6, -5, 6, 9, dark], [-1, 1, 5, 6, 6, 9, dark], // spoiler
    [17, 22, -10, -7, 0, 5, tire], [17, 22, 7, 10, 0, 5, tire], // front wheels
    [18, 21, -10, -9, 1, 4, hub], [18, 21, 9, 10, 1, 4, hub],
    [0, 7, -11, -7, 0, 6, tire], [0, 7, 7, 11, 0, 6, tire], // rear wheels
    [2, 5, -11, -10, 2, 5, hub], [2, 5, 10, 11, 2, 5, hub],
    [5, 11, -3, 3, 4, 11, l.suit], // driver torso
    [11, 14, -4, -2, 7, 9, l.suit], [11, 14, 2, 4, 7, 9, l.suit], // arms
    [13, 14, -2, 2, 7, 10, dark], // steering wheel
    [5, 11, -3, 3, 11, 16, l.helmet], // helmet
    [10, 11, -2, 2, 12, 15, visor], // visor
    [5, 11, -3, 3, 15, 16, shade(l.helmet, 0.85)],
  ];
}

export const KART_VIEWS = 16;
const KW = 52, KH = 44;

/** Bake one livery into 16 view sprites; view k shows the kart from angle 2*pi*k/16 behind. */
export function bakeKart(l: KartLivery): Sprite[] {
  const boxes = kartBoxes(l);
  const vox = new Map<string, number>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const [x0, x1, y0, y1, z0, z1, c] of boxes) {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) vox.set(key(x, y, z), c);
  }
  const voxels = [...vox.entries()].map(([k, c]) => {
    const [x, y, z] = k.split(",").map(Number);
    // normal: sum of directions toward empty neighbours
    let nx = 0, ny = 0, nz = 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (!vox.has(key(x + dx, y + dy, z + dz))) { nx += dx; ny += dy; nz += dz; }
    }
    return { x: x - 11.5, y, z, c, nx, ny, nz };
  });
  const pitch = 0.42, cp = Math.cos(pitch), sp = Math.sin(pitch);
  const scale = 1.55;
  const sprites: Sprite[] = [];
  for (let v = 0; v < KART_VIEWS; v++) {
    const th = (v / KART_VIEWS) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th); // view direction (camera -> kart) in kart frame
    const rx = dy, ry = -dx; // screen right
    const s = makeSprite(KW, KH);
    const depth = new Float32Array(KW * KH).fill(Infinity);
    for (const p of voxels) {
      const along = p.x * dx + p.y * dy;
      const sx = (p.x * rx + p.y * ry) * scale + KW / 2;
      const sy = KH - 6 - (p.z * cp + along * sp) * scale * 0.9;
      const d = along * cp - p.z * sp;
      // lighting in view space: light from the upper left, slightly behind the viewer
      const n = Math.hypot(p.nx, p.ny, p.nz) || 1;
      const vx = (p.nx * rx + p.ny * ry) / n, vz = p.nz / n, vd = (p.nx * dx + p.ny * dy) / n;
      const lit = 0.68 + 0.32 * Math.max(0, -0.45 * vx + 0.75 * vz - 0.45 * vd);
      const col = shade(p.c, lit);
      for (let oy = 0; oy < 2; oy++) {
        for (let ox = 0; ox < 2; ox++) {
          const px = Math.floor(sx + ox), py = Math.floor(sy + oy);
          if (px < 0 || py < 0 || px >= KW || py >= KH) continue;
          const i = py * KW + px;
          if (d < depth[i]) { depth[i] = d; s.data[i] = col; }
        }
      }
    }
    outline(s, hex("#101018"));
    sprites.push(s);
  }
  return sprites;
}

function outline(s: Sprite, color: number): void {
  const src = Uint32Array.from(s.data);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (src[y * s.w + x]) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const xx = x + dx, yy = y + dy;
        return xx >= 0 && yy >= 0 && xx < s.w && yy < s.h && src[yy * s.w + xx];
      });
      if (n) s.data[y * s.w + x] = color;
    }
  }
}

// ---------------------------------------------------------------------------------- scenery

export interface SceneryArt {
  sprite: Sprite;
  height: number; // meters tall in the world
  solid: boolean; // karts bounce off it
}

function px(s: Sprite, x: number, y: number, c: number) {
  if (x >= 0 && y >= 0 && x < s.w && y < s.h) s.data[(y | 0) * s.w + (x | 0)] = c;
}

function disc(s: Sprite, cx: number, cy: number, r: number, c: (x: number, y: number) => number) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px(s, x, y, c(x, y));
    }
  }
}

function rect(s: Sprite, x0: number, y0: number, x1: number, y1: number, c: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(s, x, y, c);
}

function pine(rng: Rand): SceneryArt {
  const s = makeSprite(26, 44);
  const g = hex("#1f6b3a"), gl = hex("#2f8f4e"), trunk = hex("#6b4226");
  rect(s, 11, 34, 15, 44, trunk);
  for (let tier = 0; tier < 4; tier++) {
    const top = 2 + tier * 8, bot = top + 14, half = 5 + tier * 2.3;
    for (let y = top; y < bot; y++) {
      const w = ((y - top) / (bot - top)) * half;
      for (let x = Math.floor(13 - w); x <= 13 + w; x++) px(s, x, y, x < 13 - w * 0.3 ? gl : g);
    }
  }
  if (rng.next() > 0.5) disc(s, 13, 4, 1.5, () => hex("#e8f5e9"));
  outline(s, hex("#0e2416"));
  return { sprite: s, height: 9 + rng.range(-1.5, 2), solid: true };
}

function oak(rng: Rand): SceneryArt {
  const s = makeSprite(34, 38);
  const trunk = hex("#7a4b2a");
  rect(s, 15, 22, 20, 38, trunk);
  const base = rng.pick([hex("#2e8b3e"), hex("#3a9d45"), hex("#2a7f39")]);
  for (const [cx, cy, r] of [[17, 13, 11], [9, 17, 7], [25, 17, 7], [17, 20, 8]]) {
    disc(s, cx, cy, r, (x, y) => (y < cy - r * 0.3 && x < cx ? shade(base, 1.25) : y > cy + r * 0.4 ? shade(base, 0.8) : base));
  }
  for (let k = 0; k < 8; k++) px(s, rng.int(8, 26), rng.int(6, 20), shade(base, 1.35));
  outline(s, hex("#13301a"));
  return { sprite: s, height: 7.5 + rng.range(-1, 1.5), solid: true };
}

function bush(rng: Rand, color = hex("#2f8f46")): SceneryArt {
  const s = makeSprite(22, 13);
  for (const [cx, cy, r] of [[6, 8, 5], [11, 6, 6], [16, 8, 5]]) {
    disc(s, cx, cy, r, (_x, y) => (y < cy - 1 ? shade(color, 1.2) : color));
  }
  if (rng.next() > 0.6) for (let k = 0; k < 4; k++) px(s, rng.int(4, 18), rng.int(3, 10), hex("#ff5d8f"));
  outline(s, hex("#13301a"));
  return { sprite: s, height: 1.6, solid: false };
}

function rock(rng: Rand, color = hex("#8d8f99")): SceneryArt {
  const s = makeSprite(22, 15);
  const pts = 7;
  const rs = Array.from({ length: pts }, () => rng.range(6, 10));
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 22; x++) {
      const ang = Math.atan2((y - 10) * 1.6, x - 11);
      const k = ((ang + Math.PI) / (Math.PI * 2)) * pts;
      const r = rs[Math.floor(k) % pts] * (1 - (k % 1)) + rs[Math.ceil(k) % pts] * (k % 1);
      if (Math.hypot(x - 11, (y - 10) * 1.6) < r && y <= 14) px(s, x, y, y < 7 ? shade(color, 1.2) : x > 13 ? shade(color, 0.8) : color);
    }
  }
  outline(s, hex("#2a2b30"));
  return { sprite: s, height: 1.8 + rng.range(0, 1.4), solid: true };
}

function flowers(rng: Rand): SceneryArt {
  const s = makeSprite(14, 6);
  const cols = [hex("#ff5d8f"), hex("#ffd166"), hex("#ffffff"), hex("#9b8cff")];
  for (let k = 0; k < 9; k++) {
    const x = rng.int(1, 13), y = rng.int(1, 5);
    px(s, x, y, rng.pick(cols));
    px(s, x, y + 1, hex("#2e7d32"));
  }
  return { sprite: s, height: 0.5, solid: false };
}

function cactus(): SceneryArt {
  const s = makeSprite(20, 36);
  const g = hex("#3e8e41"), gl = hex("#5fb35f");
  const col = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(s, x, y, x === x0 + 1 ? gl : g);
  };
  col(8, 13, 2, 36);
  col(2, 6, 10, 20); col(2, 9, 20, 23);
  col(14, 18, 6, 16); col(12, 18, 16, 19);
  outline(s, hex("#173b19"));
  return { sprite: s, height: 5.5, solid: true };
}

function palm(trunkC = hex("#8a5a32"), frond = hex("#2e9b4f")): SceneryArt {
  const s = makeSprite(34, 44);
  for (let y = 10; y < 44; y++) {
    const x = 17 + Math.sin(y / 9) * 3;
    rect(s, Math.floor(x) - 1, y, Math.floor(x) + 2, y + 1, (y >> 2) & 1 ? trunkC : shade(trunkC, 0.8));
  }
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    for (let t = 0; t < 14; t++) {
      const x = 17 + Math.cos(a) * t, y = 10 + Math.sin(a) * t * 0.55 + (t * t) / 26;
      px(s, x, y, frond);
      px(s, x, y + 1, shade(frond, 0.8));
    }
  }
  outline(s, hex("#13261a"));
  return { sprite: s, height: 9, solid: true };
}

function crystal(rng: Rand): SceneryArt {
  const s = makeSprite(16, 34);
  const c = rng.pick([hex("#ff2bd6"), hex("#2de2e6"), hex("#9b5cff")]);
  for (let y = 0; y < 34; y++) {
    const w = y < 8 ? (y / 8) * 6 : 6 - ((y - 8) / 26) * 2;
    for (let x = Math.floor(8 - w); x <= 8 + w; x++) px(s, x, y, x < 8 ? mix(c, 0xffffffff, 0.35) : c);
  }
  outline(s, shade(c, 0.4));
  return { sprite: s, height: 4.5 + rng.range(0, 3), solid: true };
}

function lamp(): SceneryArt {
  const s = makeSprite(10, 40);
  rect(s, 4, 6, 6, 40, hex("#3a2f55"));
  disc(s, 5, 4, 3.5, () => hex("#2de2e6"));
  disc(s, 5, 4, 1.5, () => 0xffffffff);
  return { sprite: s, height: 7, solid: true };
}

function mesa(rng: Rand): SceneryArt {
  const s = makeSprite(70, 30);
  const c = hex("#b85c38"), cl = hex("#d9804f");
  const top = rng.int(3, 8);
  for (let y = top; y < 30; y++) {
    const inset = Math.max(0, 6 - (y - top)) + (y > 24 ? 0 : 2);
    for (let x = inset; x < 70 - inset; x++) px(s, x, y, (y - top) % 7 === 0 ? cl : y < top + 3 ? cl : c);
  }
  outline(s, hex("#4a2414"));
  return { sprite: s, height: 22 + rng.range(0, 10), solid: false };
}

function tire(): SceneryArt {
  const s = makeSprite(14, 16);
  for (let k = 0; k < 4; k++) {
    rect(s, 1, 1 + k * 4, 13, 4 + k * 4, k & 1 ? hex("#f4f4f4") : hex("#1d1d22"));
  }
  outline(s, hex("#0b0b0e"));
  return { sprite: s, height: 1.5, solid: true };
}

function cone(rng: Rand): SceneryArt {
  const s = makeSprite(10, 12);
  // a nod to the Formula Student roots: blue and yellow cones
  const c = rng.next() > 0.5 ? hex("#246cec") : hex("#facc24");
  for (let y = 0; y < 10; y++) {
    const w = 0.5 + y * 0.42;
    for (let x = Math.floor(5 - w); x <= 5 + w; x++) px(s, x, y, y === 4 || y === 5 ? 0xffffffff : c);
  }
  rect(s, 0, 10, 10, 12, shade(c, 0.6));
  return { sprite: s, height: 0.8, solid: false };
}

export function chevron(right: boolean): SceneryArt {
  const s = makeSprite(22, 18);
  rect(s, 0, 0, 22, 14, hex("#d62828"));
  for (let k = 0; k < 3; k++) {
    for (let y = 2; y < 12; y++) {
      const x = 4 + k * 6 + Math.abs(y - 7) * 0.6;
      px(s, right ? 22 - x : x, y, 0xffffffff);
      px(s, right ? 21 - x : x + 1, y, 0xffffffff);
    }
  }
  rect(s, 4, 14, 6, 18, hex("#444"));
  rect(s, 16, 14, 18, 18, hex("#444"));
  outline(s, hex("#3a0b0b"));
  return { sprite: s, height: 2.2, solid: true };
}

export function makeScenery(kind: SceneryKind, rng: Rand): SceneryArt {
  switch (kind) {
    case "pine": return pine(rng);
    case "oak": return oak(rng);
    case "bush": return bush(rng);
    case "rock": return rock(rng);
    case "flowers": return flowers(rng);
    case "cactus": return cactus();
    case "palm": return palm();
    case "neonpalm": return palm(hex("#ff2bd6"), hex("#2de2e6"));
    case "crystal": return crystal(rng);
    case "lamp": return lamp();
    case "mesa": return mesa(rng);
    case "tire": return tire();
    case "cone": return cone(rng);
    case "chevron": return chevron(rng.next() > 0.5);
  }
}

/** The start gantry: a banner spanning the road, drawn as one wide billboard. */
export function gantry(text: (s: Sprite) => void): SceneryArt {
  const s = makeSprite(120, 40);
  rect(s, 0, 0, 6, 40, hex("#d9d9e3"));
  rect(s, 114, 0, 120, 40, hex("#d9d9e3"));
  rect(s, 6, 4, 114, 18, hex("#1b1f3a"));
  for (let x = 6; x < 114; x += 4) {
    rect(s, x, 4, x + 2, 6, 0xffffffff);
    rect(s, x + 2, 16, x + 4, 18, 0xffffffff);
  }
  text(s);
  outline(s, hex("#0b0b12"));
  return { sprite: s, height: 7.5, solid: false };
}

/** A small grandstand full of pixel spectators. */
export function grandstand(rng: Rand): SceneryArt {
  const s = makeSprite(60, 28);
  rect(s, 0, 4, 60, 28, hex("#5b6070"));
  rect(s, 0, 0, 60, 4, hex("#e53935"));
  for (let row = 0; row < 5; row++) {
    for (let x = 2; x < 58; x += 3) {
      const c = rng.pick([hex("#ffd166"), hex("#ef476f"), hex("#06d6a0"), hex("#118ab2"), hex("#ffffff"), hex("#f78c6b")]);
      px(s, x, 7 + row * 4, c);
      px(s, x, 8 + row * 4, shade(c, 0.7));
    }
  }
  outline(s, hex("#1d1f26"));
  return { sprite: s, height: 6, solid: true };
}

// ---------------------------------------------------------------------------------- items

const QUESTION = [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."];

/** Item boxes: a glossy crystal cube with a question mark, its rim cycling through colors. */
export function itemBoxFrames(): SceneryArt[] {
  const rims = [hex("#ff5fa2"), hex("#ffd23f"), hex("#5dff7a"), hex("#63c8ff"), hex("#c79bff")];
  return rims.map((rim, f) => {
    const s = makeSprite(18, 18);
    rect(s, 0, 0, 18, 18, rim);
    rect(s, 2, 2, 16, 16, mix(hex("#f4ecff"), rim, 0.22));
    for (let k = 0; k < 9; k++) px(s, 3 + k, 3 + ((k + f) % 2), 0xffffffff); // gloss
    rect(s, 2, 13, 16, 16, mix(hex("#d9c9ff"), rim, 0.35));
    QUESTION.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "#") rect(s, 6 + x, 5 + y, 7 + x, 6 + y, hex("#3a1f6b"));
      }
    });
    outline(s, hex("#1a1030"));
    return { sprite: s, height: 1.15, solid: false };
  });
}

/** An oil slick: a flat dark puddle with a rainbow sheen. */
export function slickArt(): SceneryArt {
  const s = makeSprite(30, 9);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 30; x++) {
      const e = ((x - 14.5) / 14.5) ** 2 + ((y - 4) / 4.4) ** 2;
      if (e <= 1) px(s, x, y, hex("#14121c"));
    }
  }
  const sheen = [hex("#ff5fa2"), hex("#ffd23f"), hex("#5dff7a"), hex("#63c8ff")];
  for (let k = 0; k < 12; k++) px(s, 8 + k, 3 + (k > 5 ? 1 : 0), sheen[k % 4]);
  return { sprite: s, height: 0.32, solid: false };
}

/** A dream orb: a glowing violet sphere with a bright core. */
export function orbArt(): SceneryArt {
  const s = makeSprite(14, 14);
  disc(s, 6.5, 6.5, 6.4, (x, y) => mix(hex("#ffffff"), hex("#7b3cff"), Math.min(1, Math.hypot(x - 5, y - 5) / 7)));
  outline(s, hex("#2b0f5c"));
  return { sprite: s, height: 0.9, solid: false };
}

/** 16x16 icons for the HUD's item slot. */
export function itemIcons(): Record<"turbo" | "oil" | "orb", Sprite> {
  const turbo = makeSprite(16, 16);
  for (let k = 0; k < 2; k++) {
    for (let y = 0; y < 12; y++) {
      const x = 3 + k * 6 + (y < 6 ? y : 11 - y) / 1.5;
      rect(turbo, Math.round(x), 2 + y, Math.round(x) + 3, 3 + y, k ? hex("#ffd23f") : hex("#ff7a1a"));
    }
  }
  outline(turbo, hex("#2a1408"));
  const oil = makeSprite(16, 16);
  disc(oil, 7.5, 9.5, 5, () => hex("#14121c"));
  for (let y = 2; y < 7; y++) rect(oil, 8 - Math.floor((y - 1) / 2), y, 8 + Math.ceil((y - 1) / 2), y + 1, hex("#14121c"));
  [hex("#ff5fa2"), hex("#ffd23f"), hex("#63c8ff")].forEach((c, k) => px(oil, 5 + k, 8, c));
  outline(oil, hex("#d9e1ea"));
  return { turbo, oil, orb: orbArt().sprite };
}
