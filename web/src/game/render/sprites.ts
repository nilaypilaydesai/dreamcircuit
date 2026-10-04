// Procedural pixel art. Karts are small voxel models, put together from their garage parts and
// rendered from 16 directions when a race starts (a "voxel baker"); the garage draws the same
// voxels live, at any angle, on its turntable. Scenery and items are painted with simple shape
// primitives. Everything is original: the bodies take their cues from real supercars, but the
// shapes and names are this game's own.

import { H, type Screen, type Sprite, W, hex, makeSprite, mix, Rand, shade } from "../core/gfx";
import { type Build, accentOf, paintOf } from "../race/parts";
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

/** A voxel model: x forward (the rear axle near 3, the front near 19), y to the side, z up. */
class Model {
  readonly vox = new Map<number, number>();
  static key(x: number, y: number, z: number): number {
    return ((x + 64) << 14) | ((y + 64) << 7) | (z + 64);
  }
  put(x: number, y: number, z: number, c: number): void {
    this.vox.set(Model.key(x, y, z), c);
  }
  has(x: number, y: number, z: number): boolean {
    return this.vox.has(Model.key(x, y, z));
  }
  del(x: number, y: number, z: number): void {
    this.vox.delete(Model.key(x, y, z));
  }
  /** Fill [x0, x1) x [y0, y1) x [z0, z1). */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number): void {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) this.put(x, y, z, c);
  }
  /** A body shell: at each x, half-width ``hw(x)`` and roof height ``top(x)`` above z = 2. */
  shell(x0: number, x1: number, hw: (x: number) => number, top: (x: number) => number,
        col: (x: number, y: number, z: number) => number): void {
    for (let x = x0; x < x1; x++) {
      const h = Math.round(hw(x)), t = Math.round(top(x));
      for (let y = -h; y < h; y++) for (let z = 2; z < t; z++) this.put(x, y, z, col(x, y, z));
    }
  }
  /** Empty a cockpit above ``z0``. */
  carve(x0: number, x1: number, hw: number, z0: number): void {
    for (let x = x0; x < x1; x++) for (let y = -hw; y < hw; y++) for (let z = z0; z < 24; z++) this.del(x, y, z);
  }
  /** Paint the outside faces at |y| = edge (both sides) where ``at`` says so. */
  sides(edge: number, x0: number, x1: number, z0: number, z1: number, c: number): void {
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      this.put(x, -edge, z, c);
      this.put(x, edge - 1, z, c);
    }
  }
}

interface Pal {
  paint: number; accent: number; dark: number; glass: number; light: number; tail: number;
  chrome: number; tire: number; helmet: number; suit: number;
}

/** Where a body takes its spoiler and exhaust, and where its driver sits. */
interface Mount { rear: number; deck: number; pipeZ: number; seat: number }

type BodyFn = (m: Model, c: Pal) => Mount;

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));

const BODY_SHAPES: Record<string, BodyFn> = {
  // the original go-kart: an open frame, a nose cone, side pods and the engine out back
  classic: (m, c) => {
    m.box(0, 25, -7, 7, 2, 4, c.paint);
    m.box(17, 25, -5, 5, 3, 6, c.paint);
    m.box(23, 26, -7, 7, 1, 3, c.dark);
    m.box(6, 18, -9, -5, 3, 6, c.accent);
    m.box(6, 18, 5, 9, 3, 6, c.accent);
    m.box(-2, 4, -6, 6, 3, 7, c.dark);
    return { rear: -2, deck: 7, pipeZ: 4, seat: 0 };
  },
  // mid-engine Italian V8: a rounded nose, an engine hump behind the driver, side intakes
  corsa: (m, c) => {
    m.shell(-2, 26, (x) => (x > 21 ? 8 - (x - 21) * 0.5 : 8), (x) => (x < 2 ? 6 : x < 6 ? 7 : lerp(6.4, 4.6, (x - 13) / 12)),
            () => c.paint);
    m.carve(6, 14, 4, 5);
    m.sides(8, 1, 6, 3, 5, c.dark);
    for (const y of [-6, -5, 4, 5]) m.put(-3, y, 4, c.tail);
    for (const y of [-5, -4, 3, 4]) m.put(25, y, 4, c.light);
    m.sides(8, 9, 20, 2, 3, c.accent);
    return { rear: -2, deck: 6, pipeZ: 3, seat: 0 };
  },
  // the raging-bull wedge: wide, flat and sharp, falling to a blade of a nose
  toro: (m, c) => {
    m.shell(-2, 27, (x) => (x > 23 ? 9 - (x - 23) : 9), (x) => lerp(8.4, 3.2, (x + 2) / 29), () => c.paint);
    m.carve(6, 13, 4, 5);
    m.sides(9, 0, 6, 3, 6, c.dark); // hexagon intakes
    for (let x = -1; x < 4; x += 2) for (let y = -6; y < 6; y++) m.put(x, y, 8, c.dark); // engine louvres
    for (const y of [-7, -6, -5, 4, 5, 6]) m.put(24, y, 4, c.light);
    for (let y = -8; y < 8; y++) m.put(-3, y, 5, y % 3 === 0 ? c.tail : c.dark);
    m.sides(9, 3, 24, 2, 3, c.accent);
    return { rear: -2, deck: 8, pipeZ: 3, seat: 0 };
  },
  // British carbon-tub supercar: a teardrop cabin and deep scooped intakes
  papaya: (m, c) => {
    m.shell(-1, 26, (x) => (x > 22 ? 8 - (x - 22) * 0.6 : 8), (x) => (x < 5 ? 6.5 : lerp(6.5, 4.4, (x - 12) / 13)),
            () => c.paint);
    m.carve(5, 13, 4, 5);
    for (const s of [-8, 7]) for (let x = 3; x < 10; x++) for (let z = 3; z < 6 - Math.abs(x - 6) / 3; z++) m.put(x, s, z, c.dark);
    m.sides(8, 2, 11, 2, 3, c.accent);
    for (const y of [-6, -5, -4, 3, 4, 5]) m.put(25, y, 3, c.light);
    for (let y = -7; y < 7; y++) m.put(-2, y, 5, c.tail);
    return { rear: -1, deck: 7, pipeZ: 3, seat: 0 };
  },
  // rear-engine flat-six: a round fastback, frog-eye headlights, a light bar across the tail
  boxer: (m, c) => {
    m.shell(-1, 25, (x) => (x > 21 ? 7.5 - (x - 21) * 0.5 : 7.5), (x) => (x < 5 ? 8 - (5 - x) * 0.35 : lerp(7, 4.5, (x - 9) / 15)),
            () => c.paint);
    m.carve(6, 13, 4, 6);
    for (const s of [-1, 1]) for (let x = 18; x < 23; x++) m.put(x, s < 0 ? -7 : 6, 5, c.paint); // front wings
    for (const y of [-6, 5]) { m.put(24, y, 4, c.light); m.put(24, y, 5, c.light); }
    for (let y = -7; y < 7; y++) m.put(-2, y, 5, c.tail);
    m.sides(8, 4, 18, 2, 3, c.accent);
    return { rear: -1, deck: 7, pipeZ: 3, seat: 0 };
  },
  // quad-turbo W16: long, heavy, two-tone, a horseshoe grille and a chrome curve down each side
  hyper: (m, c) => {
    m.shell(-2, 27, (x) => (x > 23 ? 8.5 - (x - 23) * 0.6 : 8.5), (x) => (x < 4 ? 7 : lerp(6.6, 4.4, (x - 12) / 14)),
            (x) => (x < 11 ? c.accent : c.paint));
    m.carve(6, 13, 4, 5);
    for (let z = 2; z < 6; z++) for (let x = 7; x < 12; x++) {
      if (Math.abs(x - 9.5 - (z - 4) * 0.8) < 0.8) { m.put(x, -9, z, c.chrome); m.put(x, 8, z, c.chrome); }
    }
    for (const [y, z] of [[-2, 2], [-2, 3], [-2, 4], [1, 2], [1, 3], [1, 4], [-1, 4], [0, 4]]) m.put(26, y, z, c.chrome);
    for (const y of [-6, -5, 4, 5]) m.put(25, y, 4, c.light);
    for (let y = -7; y < 7; y++) m.put(-3, y, 5, c.tail);
    return { rear: -2, deck: 7, pipeZ: 3, seat: 0 };
  },
  // Swedish megacar: low and wide with a dark wraparound screen and a stripe nose to tail
  ghost: (m, c) => {
    m.shell(-1, 26, (x) => (x > 22 ? 8 - (x - 22) * 0.6 : 8), (x) => (x < 4 ? 6 : lerp(6, 4.2, (x - 12) / 14)),
            (_x, y) => (y === -1 || y === 0 ? c.accent : c.paint));
    m.carve(5, 12, 4, 5);
    m.box(12, 14, -4, 4, 5, 8, c.glass);
    for (const y of [-6, -5, 4, 5]) m.put(25, y, 3, c.light);
    for (const y of [-7, -6, 5, 6]) m.put(-2, y, 4, c.tail);
    return { rear: -1, deck: 6, pipeZ: 3, seat: -1 };
  },
  // JDM twin-turbo legend: boxy, broad hips, four round tail lights and a vented hood
  tsukuba: (m, c) => {
    m.shell(-1, 26, (x) => (x > 23 ? 8.5 - (x - 23) * 0.5 : 8.5), (x) => (x < 5 ? 8 : x < 15 ? 7 : 6.5), () => c.paint);
    m.carve(6, 14, 4, 6);
    for (const y of [-6, -4, 3, 5]) { m.put(-2, y, 5, c.tail); m.put(-2, y, 6, c.tail); }
    for (let x = 16; x < 22; x += 2) for (let y = -3; y < 3; y++) m.put(x, y, 6, c.dark); // hood vents
    m.sides(9, 1, 24, 4, 5, c.accent);
    m.box(24, 26, -8, 8, 2, 3, c.dark); // front lip
    for (const y of [-7, -6, 5, 6]) m.put(25, y, 4, c.light);
    return { rear: -1, deck: 8, pipeZ: 3, seat: 0 };
  },
  // American muscle: a long hood with a scoop, a boxy tail and twin stripes over the top
  pony: (m, c) => {
    m.shell(-2, 27, () => 8.5, (x) => (x < 4 ? 7.5 : x < 14 ? 7 : 7), (_x, y) => (y === -3 || y === -2 || y === 1 || y === 2 ? c.accent : c.paint));
    m.carve(5, 13, 4, 6);
    m.box(17, 22, -2, 2, 7, 8, c.dark); // hood scoop
    for (const y of [-7, -6, -5, 4, 5, 6]) m.put(-3, y, 5, c.tail);
    m.box(26, 27, -8, 8, 3, 5, c.dark); // grille
    for (const y of [-7, 6]) m.put(26, y, 5, c.light);
    return { rear: -2, deck: 8, pipeZ: 3, seat: 0 };
  },
  // tiny city car: short, tall and square, with a roll hoop over the driver
  kei: (m, c) => {
    m.shell(1, 23, () => 7, (x) => (x < 5 ? 9 : x > 17 ? 7 : 8), () => c.paint);
    m.carve(5, 14, 4, 6);
    m.box(4, 5, -6, 6, 9, 14, c.accent); // roll hoop
    m.box(4, 5, -6, -5, 6, 14, c.accent);
    m.box(4, 5, 5, 6, 6, 14, c.accent);
    for (const y of [-6, 5]) { m.put(23, y, 5, c.light); m.put(23, y, 6, c.light); }
    for (const y of [-6, 5]) m.put(0, y, 6, c.tail);
    return { rear: 1, deck: 9, pipeZ: 3, seat: 1 };
  },
  // gravel-spec hatch: a high roof at the back, mud flaps, a light pod and livery slashes
  rally: (m, c) => {
    m.shell(0, 25, () => 8, (x) => (x < 7 ? 10 : x < 14 ? 7 : 6.5), (x, _y, z) => ((x + z) % 6 < 2 && z < 7 ? c.accent : c.paint));
    m.carve(7, 14, 4, 6);
    m.box(6, 7, -7, 7, 6, 10, c.glass); // rear window
    for (const y of [-6, -3, 2, 5]) m.put(25, y, 5, c.light); // light pod
    for (const s of [-9, 8]) m.box(-1, 0, s, s + 1, 1, 5, c.dark); // mud flaps
    for (const y of [-7, 6]) m.put(-1, y, 7, c.tail);
    return { rear: 0, deck: 10, pipeZ: 3, seat: 1 };
  },
  // endurance prototype: low and long, a narrow tub between bulging wheel arches
  lmp: (m, c) => {
    m.shell(-4, 28, (x) => (x > 15 && x < 23 ? 9 : x < 8 && x > -2 ? 9 : 5), (x) => (x > 15 && x < 23 ? 6 : x < 8 && x > -2 ? 6 : 5),
            (x) => (x > 24 ? c.accent : c.paint));
    m.carve(7, 14, 3, 4);
    m.box(9, 13, -3, 3, 4, 7, c.glass); // canopy
    for (const y of [-7, -6, 5, 6]) m.put(27, y, 3, c.light);
    for (let y = -8; y < 8; y++) m.put(-5, y, 4, c.tail);
    return { rear: -4, deck: 6, pipeZ: 3, seat: 1 };
  },
  // electric hypercar: smooth and flush, light bars nose and tail, a gloss canopy band
  volt: (m, c) => {
    m.shell(-1, 26, (x) => (x > 22 ? 8 - (x - 22) * 0.5 : 8), (x) => (x < 5 ? 6.5 : lerp(6.5, 4.5, (x - 12) / 13)),
            (x, _y, z) => (z >= 5 && x > 2 && x < 18 ? c.accent : c.paint));
    m.carve(6, 13, 4, 5);
    for (let y = -7; y < 7; y++) { m.put(25, y, 3, hex("#bff6ff")); m.put(-2, y, 5, c.tail); }
    return { rear: -1, deck: 7, pipeZ: 3, seat: 0 };
  },
};

function addDriver(m: Model, c: Pal, sx: number): void {
  m.box(5 + sx, 11 + sx, -3, 3, 4, 11, c.suit); // torso
  m.box(11 + sx, 14 + sx, -4, -2, 7, 9, c.suit); // arms
  m.box(11 + sx, 14 + sx, 2, 4, 7, 9, c.suit);
  m.box(13 + sx, 14 + sx, -2, 2, 7, 10, c.dark); // steering wheel
  m.box(5 + sx, 11 + sx, -3, 3, 11, 16, c.helmet);
  m.box(10 + sx, 11 + sx, -2, 2, 12, 15, hex("#20232b")); // visor
  m.box(5 + sx, 11 + sx, -3, 3, 15, 16, shade(c.helmet, 0.85));
}

/** Rim colours and patterns, drawn on each wheel's outer face. */
const RIMS: Record<string, (x: number, z: number, u: number, v: number, c: Pal) => number> = {
  standard: (_x, _z, _u, _v, _c) => hex("#9aa0aa"),
  slicks: (_x, _z, u, v) => (u === 0 || v === 0 ? hex("#ffd23f") : hex("#c3c9d2")),
  semi: () => hex("#b9bfca"),
  offroad: () => hex("#5a5e68"),
  drag: (_x, _z, u, v) => (u === 0 || v === 0 ? hex("#1c1c22") : hex("#d6dbe4")),
  deepdish: (_x, _z, u, v, c) => (u === 0 || v === 0 ? hex("#e6ebf2") : c.accent),
  monoblock: () => hex("#4a4f5a"),
  carbon: (x, z) => ((x + z) & 1 ? hex("#2b2d33") : hex("#3e414a")),
  turbofan: (x, z) => ((x + z) % 3 === 0 ? hex("#9aa0aa") : hex("#ecedf0")),
  mesh: (x, z) => ((x + z) & 1 ? hex("#c3c9d2") : hex("#5a5e68")),
  steelies: (_x, _z, u, v) => (u > 0 && v > 0 ? hex("#d6dbe4") : hex("#26262c")),
  whitewall: (_x, _z, u, v) => (u === 0 || v === 0 ? hex("#f4f4f4") : hex("#d6dbe4")),
  gold: (x, z) => ((x + z) % 3 === 0 ? hex("#a8801f") : hex("#e8b93c")),
};

function addWheels(m: Model, style: string, c: Pal): void {
  const big = style === "offroad" ? 1 : 0;
  const wide = style === "drag" ? 1 : 0;
  const skinny = style === "drag" ? 1 : 0;
  const rim = RIMS[style] ?? RIMS.standard;
  const wheels = [
    { x0: 17 - big, x1: 22 + big, z1: 5 + big, yin: 7, yout: 10 + big - skinny }, // front
    { x0: 0 - big, x1: 7 + big, z1: 6 + big, yin: 7, yout: 11 + big + wide }, // rear
  ];
  for (const w of wheels) {
    for (const side of [-1, 1]) {
      for (let x = w.x0; x < w.x1; x++) {
        for (let z = 0; z < w.z1; z++) {
          const cornerX = x === w.x0 || x === w.x1 - 1, cornerZ = z === 0 || z === w.z1 - 1;
          if (cornerX && cornerZ) continue; // rounded
          const tread = style === "offroad" && (cornerX || cornerZ) && (x + z) % 2 === 0;
          for (let y = w.yin; y < w.yout; y++) m.put(x, side < 0 ? -y - 1 : y, z, tread ? hex("#2e2e36") : c.tire);
          // the rim on the outer face, inside a ring of tire
          if (!cornerX && !cornerZ) {
            const u = Math.min(x - w.x0 - 1, w.x1 - 2 - x), v = Math.min(z - 1, w.z1 - 2 - z);
            m.put(x, side < 0 ? -w.yout : w.yout - 1, z, rim(x, z, u, v, c));
          }
        }
      }
    }
  }
}

function addSpoiler(m: Model, id: string, c: Pal, at: Mount): void {
  const r = at.rear, d = at.deck;
  switch (id) {
    case "lip": m.box(r, r + 2, -6, 6, d, d + 1, c.accent); break;
    case "ducktail":
      m.box(r, r + 3, -7, 7, d, d + 1, c.paint);
      m.box(r - 1, r + 1, -7, 7, d + 1, d + 2, c.paint);
      break;
    case "whale":
      m.box(r - 2, r + 3, -8, 8, d + 1, d + 2, c.accent);
      m.box(r - 2, r - 1, -8, 8, d + 2, d + 3, c.accent);
      m.box(r, r + 2, -5, -4, d, d + 1, c.dark);
      m.box(r, r + 2, 4, 5, d, d + 1, c.dark);
      break;
    case "gtwing":
      m.box(r - 3, r + 1, -9, 9, d + 3, d + 4, c.accent);
      for (const y of [-5, 4]) m.box(r - 1, r, y, y + 1, d, d + 3, c.dark);
      for (const y of [-9, 8]) m.box(r - 3, r + 1, y, y + 1, d + 2, d + 5, c.dark);
      break;
    case "swan":
      m.box(r - 3, r + 1, -9, 9, d + 4, d + 5, c.accent);
      for (const y of [-5, 4]) {
        m.box(r, r + 1, y, y + 1, d, d + 6, c.dark);
        m.box(r - 2, r + 1, y, y + 1, d + 5, d + 6, c.dark);
      }
      break;
    case "chassis":
      m.box(r - 4, r, -9, 9, d + 5, d + 6, c.accent);
      for (const y of [-6, 5]) m.box(r - 3, r - 2, y, y + 1, 2, d + 5, c.dark);
      for (const y of [-9, 8]) m.box(r - 4, r, y, y + 1, d + 4, d + 7, c.dark);
      break;
    case "double":
      m.box(r - 3, r + 1, -9, 9, d + 2, d + 3, c.accent);
      m.box(r - 3, r, -9, 9, d + 5, d + 6, c.accent);
      for (const y of [-9, 8]) m.box(r - 3, r + 1, y, y + 1, d + 1, d + 7, c.dark);
      break;
    case "active":
      for (let k = 0; k < 4; k++) m.box(r - 3 + k, r - 2 + k, -8, 8, d + 4 - (k >> 1), d + 5 - (k >> 1), c.accent);
      m.box(r - 1, r, -1, 1, d, d + 4, c.chrome);
      break;
    case "sharkfin":
      for (let x = r - 1; x < r + 10; x++) {
        const hgt = Math.max(0, Math.round(6 - (x - r) * 0.55));
        for (let z = d; z < d + hgt; z++) m.put(x, 0, z, c.accent);
      }
      break;
    default: break; // none
  }
}

function addExhaust(m: Model, id: string, c: Pal, at: Mount): void {
  const r = at.rear - 1, z = at.pipeZ;
  /** A pipe ``w`` wide and ``h`` tall sticking ``len`` voxels out of the tail, with a tip colour
   * and (for the bigger bores) a dark opening in the middle of the tip. */
  const pipe = (y: number, len: number, col: number, w = 2, h = 2, tip = col) => {
    for (let k = 0; k < len; k++) {
      const end = k === len - 1;
      for (let yy = y; yy < y + w; yy++) {
        for (let zz = z; zz < z + h; zz++) {
          const hole = end && w >= 3 && yy === y + (w >> 1) && zz === z + (h >> 1);
          m.put(r - k, yy, zz, hole ? hex("#14141a") : end ? tip : col);
        }
      }
    }
  };
  const chrome = c.chrome, ti = hex("#6a72d8"), burnt = hex("#c46ad8"), black = hex("#26262e");
  switch (id) {
    case "catback": pipe(-5, 2, chrome); pipe(3, 2, chrome); break;
    case "straight": pipe(-4, 4, chrome, 2, 2, hex("#fff6d6")); pipe(2, 4, chrome, 2, 2, hex("#fff6d6")); break;
    case "titanium": pipe(-5, 2, ti, 2, 2, burnt); pipe(3, 2, ti, 2, 2, burnt); break;
    case "quad": for (const y of [-6, -4, 2, 4]) pipe(y, 2, chrome, 2, 1); break;
    case "side": for (const y of [-10, 9]) { m.box(8, 12, y, y + 1, 3, 5, chrome); m.box(8, 9, y, y + 1, 3, 5, black); } break;
    case "center": pipe(-2, 2, chrome, 3, 3); break;
    case "valved": pipe(-6, 2, chrome, 3, 2); pipe(3, 2, chrome, 3, 2); break;
    case "turboback": pipe(2, 3, chrome, 3, 3); break;
    case "flame": pipe(-4, 2, black, 2, 2, hex("#ff8a1f")); pipe(2, 2, black, 2, 2, hex("#ff8a1f")); break;
    case "delete": pipe(-4, 1, black, 3, 2); pipe(1, 1, black, 3, 2); break;
    default: pipe(-4, 2, hex("#9aa0aa"), 2, 1); pipe(2, 2, hex("#9aa0aa"), 2, 1); break; // stock
  }
}

function palette(build: Build, livery: KartLivery): Pal {
  return {
    paint: hex(paintOf(build).color), accent: hex(accentOf(build).color), dark: hex("#3a3d46"), glass: hex("#2c3d5c"),
    light: hex("#fff3c4"), tail: hex("#ff3b4f"), chrome: hex("#d6dbe4"), tire: hex("#1c1c22"),
    helmet: livery.helmet, suit: livery.suit,
  };
}

/** The voxels of a kart built from ``build``, with the driver in ``livery``'s colours. */
export function kartModel(build: Build, livery: KartLivery): Map<number, number> {
  const m = new Model();
  const c = palette(build, livery);
  const at = (BODY_SHAPES[build.body] ?? BODY_SHAPES.classic)(m, c);
  addWheels(m, build.wheels, c);
  addSpoiler(m, build.spoiler, c, at);
  addExhaust(m, build.exhaust, c, at);
  addDriver(m, c, at.seat);
  return m.vox;
}

/** A rocket, the kart's paint on its stripes and fins, with the driver's helmet in the window. */
export function rocketModel(build: Build, livery: KartLivery): Map<number, number> {
  const m = new Model();
  const paint = hex(paintOf(build).color), white = hex("#eef0f6"), nose = hex("#ff3b4f");
  // a round body along x (centre y = -0.5, z = 7.5), a long nose cone, three tail fins
  for (let x = -4; x < 26; x++) {
    const r = x > 16 ? 6 - (x - 16) * 0.64 : 6;
    for (let y = -7; y < 7; y++) {
      for (let z = 1; z < 15; z++) {
        if (Math.hypot(y + 0.5, z - 7.5) > r) continue;
        m.put(x, y, z, x > 21 ? nose : x === 3 || x === 4 || x === 12 || x === 13 ? paint : white);
      }
    }
  }
  for (let x = -4; x < 3; x++) {
    const ext = Math.round(4 - (x + 4) * 0.5); // fins: deep at the tail, tapering forward
    for (let k = 1; k <= ext; k++) {
      m.put(x, -6 - k, 7, paint);
      m.put(x, 5 + k, 7, paint);
      m.put(x, -1, 13 + k, paint);
      m.put(x, 0, 13 + k, paint);
    }
  }
  m.box(10, 15, -3, 2, 11, 14, hex("#2c3d5c")); // window, with the driver in it
  m.box(11, 14, -2, 1, 12, 14, livery.helmet);
  m.box(-6, -4, -4, 3, 4, 11, hex("#30323c")); // nozzle
  return m.vox;
}

export const KART_VIEWS = 16;
const KW = 64, KH = 56, BASE = KH - 10; // a little room below the ground line for the near corners
/** Fraction of a kart sprite's height above its ground contact. */
export const KART_ANCHOR = BASE / KH;
/** A kart sprite this many pixels tall is 1.75 m of kart. */
export const KART_PX = 44;

interface Lit { x: number; y: number; z: number; c: number; nx: number; ny: number; nz: number }

/** Each voxel with an outward normal (toward its empty neighbours), centred along the kart. */
function litVoxels(vox: Map<number, number>, cx = 11.5): Lit[] {
  const out: Lit[] = [];
  const has = (x: number, y: number, z: number) => vox.has(Model.key(x, y, z));
  for (const [k, c] of vox) {
    const x = (k >> 14) - 64, y = ((k >> 7) & 127) - 64, z = (k & 127) - 64;
    let nx = 0, ny = 0, nz = 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (!has(x + dx, y + dy, z + dz)) { nx += dx; ny += dy; nz += dz; }
    }
    if (nx === 0 && ny === 0 && nz === 0) continue; // buried: never seen
    out.push({ x: x - cx, y, z, c, nx, ny, nz });
  }
  return out;
}

const PITCH = 0.42;

/** Project lit voxels seen from angle ``th`` into a buffer of ``bw`` x ``bh`` pixels around
 * (ox, oy), ``scale`` pixels per voxel, keeping the nearest. */
function splat(vs: Lit[], th: number, scale: number, put: (px: number, py: number, d: number, c: number) => void,
               ox: number, oy: number, pitch = PITCH): void {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const dx = Math.cos(th), dy = Math.sin(th); // view direction (camera -> kart) in kart frame
  const rx = dy, ry = -dx; // screen right
  const size = Math.max(2, Math.ceil(scale) + 1);
  for (const p of vs) {
    const along = p.x * dx + p.y * dy;
    const sx = (p.x * rx + p.y * ry) * scale + ox;
    const sy = oy - (p.z * cp + along * sp) * scale * 0.9;
    const d = along * cp - p.z * sp;
    // lighting in view space: light from the upper left, slightly behind the viewer
    const n = Math.hypot(p.nx, p.ny, p.nz) || 1;
    const vx = (p.nx * rx + p.ny * ry) / n, vz = p.nz / n, vd = (p.nx * dx + p.ny * dy) / n;
    const lit = 0.68 + 0.32 * Math.max(0, -0.45 * vx + 0.75 * vz - 0.45 * vd);
    const col = shade(p.c, lit);
    for (let oy2 = 0; oy2 < size; oy2++) {
      for (let ox2 = 0; ox2 < size; ox2++) put(Math.floor(sx + ox2), Math.floor(sy + oy2), d, col);
    }
  }
}

/** A kart's 16 views, and where the driver's head is in each (sprite pixels). */
export type KartViews = Sprite[] & { heads?: [number, number][] };

/** Where the driver's head is on a build (model coordinates), for the reef's bubble helmets. */
export function kartHead(build: Build): [number, number, number] {
  const seat = (BODY_SHAPES[build.body] ?? BODY_SHAPES.classic)(new Model(), palette(build, LIVERIES[0])).seat;
  return [8 + seat, -0.5, 13.5];
}

/** Bake a voxel model into 16 view sprites; view k shows it from angle 2*pi*k/16 behind. A
 * ``marker`` (model coordinates) is projected into every view too (``heads``). */
export function bakeVoxels(vox: Map<number, number>, cx = 11.5, marker?: [number, number, number]): KartViews {
  const vs = litVoxels(vox, cx);
  const sprites: KartViews = [];
  if (marker) sprites.heads = [];
  const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  for (let v = 0; v < KART_VIEWS; v++) {
    if (marker && sprites.heads) {
      const th = (v / KART_VIEWS) * Math.PI * 2, dx = Math.cos(th), dy = Math.sin(th);
      const mx = marker[0] - cx, along = mx * dx + marker[1] * dy;
      sprites.heads.push([(mx * dy - marker[1] * dx) * 1.55 + KW / 2, BASE - (marker[2] * cp + along * sp) * 1.55 * 0.9]);
    }
    const s = makeSprite(KW, KH);
    const depth = new Float32Array(KW * KH).fill(Infinity);
    splat(vs, (v / KART_VIEWS) * Math.PI * 2, 1.55, (px, py, d, c) => {
      if (px < 0 || py < 0 || px >= KW || py >= KH) return;
      const i = py * KW + px;
      if (d < depth[i]) { depth[i] = d; s.data[i] = c; }
    }, KW / 2, BASE);
    outline(s, hex("#101018"));
    sprites.push(s);
  }
  return sprites;
}

const baked = new Map<string, KartViews>();

/** A kart's 16 views, baked once per build and driver. */
export function kartSprites(build: Build, livery: KartLivery, rocket = false): KartViews {
  const key = `${rocket ? "R" : "K"}|${build.body}|${build.wheels}|${build.spoiler}|${build.exhaust}|${build.paint}|${build.accent}|${livery.helmet}|${livery.suit}`;
  let s = baked.get(key);
  if (!s) {
    if (baked.size > 80) baked.clear();
    s = rocket ? bakeVoxels(rocketModel(build, livery), 10) : bakeVoxels(kartModel(build, livery), 11.5, kartHead(build));
    baked.set(key, s);
  }
  return s;
}

/** The garage turntable: draw a model straight into the screen at any angle and size. */
export class Turntable {
  private depth = new Float32Array(0);
  private lit: Lit[] = [];
  private key = "";

  draw(scr: Screen, vox: Map<number, number>, key: string, cx: number, cy: number, angle: number, scale: number,
       clipTop = 0): void {
    if (key !== this.key) {
      this.lit = litVoxels(vox);
      this.key = key;
    }
    if (this.depth.length !== W * H) this.depth = new Float32Array(W * H);
    this.depth.fill(Infinity);
    const buf = scr.buf, depth = this.depth;
    const drawn: number[] = [];
    splat(this.lit, angle, scale, (px, py, d, c) => {
      if (px < 0 || py < clipTop || px >= W || py >= H) return;
      const i = py * W + px;
      if (d < depth[i]) {
        if (depth[i] === Infinity) drawn.push(i);
        depth[i] = d;
        buf[i] = c;
      }
    }, cx, cy, 0.34);
    // a dark outline around the silhouette, as on the baked sprites
    for (const i of drawn) {
      const x = i % W;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= W * H || depth[j] !== Infinity || (j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
        buf[j] = hex("#101018");
        depth[j] = -Infinity;
      }
    }
  }
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

// ---------------------------------------------------------------------------------- the reef

function kelp(rng: Rand): SceneryArt {
  const s = makeSprite(26, 64);
  const greens = [hex("#2f8f4e"), hex("#3d9b3f"), hex("#5a9a2e")];
  const fronds = rng.int(3, 5);
  for (let f = 0; f < fronds; f++) {
    const x0 = 6 + f * (14 / fronds) + rng.range(-1, 1), ph = rng.range(0, 6), c = rng.pick(greens);
    const top = rng.int(2, 16);
    for (let y = 63; y > top; y--) {
      const x = x0 + Math.sin(y / 7 + ph) * 3;
      rect(s, Math.round(x), y, Math.round(x) + 2, y + 1, (y >> 2) & 1 ? c : shade(c, 1.2));
      if (y % 9 === 0) rect(s, Math.round(x) + 2, y, Math.round(x) + 5, y + 2, shade(c, 1.1)); // a leaf
    }
  }
  outline(s, hex("#0d2e1c"));
  return { sprite: s, height: 8 + rng.range(-1.5, 3), solid: false };
}

function coral(rng: Rand): SceneryArt {
  const s = makeSprite(28, 24);
  const c = rng.pick([hex("#ff6f91"), hex("#ff9a52"), hex("#b06bff"), hex("#ffcf4a"), hex("#ff5f5f")]);
  const branch = (x: number, y: number, a: number, len: number, depth: number) => {
    for (let k = 0; k < len; k++) {
      const xx = x + Math.cos(a) * k, yy = y - Math.sin(a) * k;
      disc(s, xx, yy, depth > 1 ? 1.4 : 1, () => (k > len - 2 ? shade(c, 1.25) : c));
    }
    if (depth > 0) {
      const ex = x + Math.cos(a) * len, ey = y - Math.sin(a) * len;
      branch(ex, ey, a + 0.5, len * 0.7, depth - 1);
      branch(ex, ey, a - 0.5, len * 0.7, depth - 1);
    }
  };
  branch(14, 23, Math.PI / 2 + rng.range(-0.2, 0.2), 8, 2);
  outline(s, shade(c, 0.4));
  return { sprite: s, height: 2.6 + rng.range(0, 1.2), solid: true };
}

function anemone(rng: Rand): SceneryArt {
  const s = makeSprite(18, 14);
  const c = rng.pick([hex("#c86bff"), hex("#ff6fb0"), hex("#5fe0c8")]);
  disc(s, 9, 11, 5, () => shade(c, 0.75));
  for (let k = 0; k < 9; k++) {
    const a = Math.PI * (0.1 + 0.8 * (k / 8));
    for (let t = 0; t < 6; t++) px(s, 9 + Math.cos(a) * (3 + t), 10 - Math.sin(a) * (2 + t * 1.2), t > 4 ? hex("#ffffff") : c);
  }
  outline(s, shade(c, 0.35));
  return { sprite: s, height: 1.3, solid: false };
}

function shell(rng: Rand): SceneryArt {
  const s = makeSprite(14, 9);
  if (rng.next() > 0.5) { // a starfish
    const c = rng.pick([hex("#ff8a3d"), hex("#ff5f7a")]);
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + (k / 5) * Math.PI * 2;
      for (let t = 0; t < 5; t++) px(s, 7 + Math.cos(a) * t, 5 + Math.sin(a) * t * 0.7, c);
    }
    outline(s, shade(c, 0.4));
  } else { // a scallop shell
    for (let y = 0; y < 8; y++) for (let x = 0; x < 14; x++) {
      if (Math.hypot((x - 7) / 6.5, (y - 8) / 7.5) <= 1) px(s, x, y, x % 3 === 0 ? hex("#e8c9b0") : hex("#fff1e4"));
    }
    outline(s, hex("#7a5a48"));
  }
  return { sprite: s, height: 0.6, solid: false };
}

function wreck(rng: Rand): SceneryArt {
  const s = makeSprite(74, 46);
  const wood = hex("#5a4636"), dark = hex("#3a2c22"), moss = hex("#3f7f4f");
  // a hull lying tilted in the sand, broken open, and a snapped mast
  for (let x = 4; x < 70; x++) {
    const top = 26 + Math.round(Math.abs(x - 38) * 0.18) + (x > 50 ? -4 : 0);
    for (let y = top; y < 44; y++) px(s, x, y, (x + y) % 9 === 0 ? dark : y < top + 2 ? moss : wood);
  }
  for (let x = 30; x < 44; x++) for (let y = 30; y < 40; y++) px(s, x, y, hex("#1c1612")); // the hole
  for (let y = 4; y < 30; y++) rect(s, 22 + Math.round(y * 0.15), y, 25 + Math.round(y * 0.15), y + 1, dark);
  rect(s, 14, 12, 34, 14, dark); // the yard
  if (rng.next() > 0.5) for (let k = 0; k < 10; k++) px(s, 36 + k, 36 - (k % 3), hex("#ffd23f")); // gold spilling out
  outline(s, hex("#140f0b"));
  return { sprite: s, height: 13 + rng.range(0, 3), solid: true };
}

/** A small fish (two frames: the tail flicks). */
export function fishFrames(color: number): SceneryArt[] {
  return [0, 1].map((f) => {
    const s = makeSprite(14, 8);
    for (let y = 0; y < 8; y++) for (let x = 2; x < 12; x++) {
      if (Math.hypot((x - 7) / 5, (y - 4) / 3.2) <= 1) px(s, x, y, y < 3 ? shade(color, 1.2) : color);
    }
    for (let y = 1; y < 7; y++) px(s, 1 - (f && y % 2 ? 1 : 0), y, shade(color, 0.85)); // the tail
    px(s, 10, 3, hex("#101018")); // an eye
    outline(s, shade(color, 0.4));
    return { sprite: s, height: 0.55, solid: false };
  });
}

// ---------------------------------------------------------------------------------- Tokyo

const NEONS = [hex("#ff3fa4"), hex("#2de2e6"), hex("#ffd23f"), hex("#9d6bff"), hex("#ff6a3a")];
const NIGHT_INK = hex("#0b0c12");

/** A street lamp: a tall grey pole, an arm reaching out over the road, a sodium lamp glowing
 * orange at its end. */
function streetlamp(rng: Rand): SceneryArt {
  const s = makeSprite(18, 58);
  const pole = hex("#5a5f68");
  rect(s, 2, 6, 4, 58, pole);
  rect(s, 1, 54, 5, 58, shade(pole, 0.8));
  for (let x = 3; x < 13; x++) px(s, x, 6 - Math.round(((x - 3) / 10) ** 2 * 3), pole); // the arm, curving up and out
  rect(s, 10, 2, 16, 4, hex("#3a3e46")); // the lamp's housing, and its glowing lens
  rect(s, 10, 4, 16, 6, hex("#ffb347"));
  rect(s, 11, 6, 15, 7, hex("#ffd9a0"));
  outline(s, NIGHT_INK);
  for (const [x, y] of [[9, 7], [16, 7], [12, 8], [13, 8], [10, 8], [15, 8]]) px(s, x, y, hex("#8a5426")); // the glow under it
  return { sprite: s, height: 8 + rng.range(-0.5, 1), solid: true };
}

/** Vending machines, two side by side: lit windows of drinks in rows, buttons, a coin panel and
 * the slot at the bottom. */
function vending(rng: Rand): SceneryArt {
  const s = makeSprite(26, 30);
  const bodies = [rng.pick([hex("#d8dde6"), hex("#c8202c")]), rng.pick([hex("#2a62c8"), hex("#e8e8ea"), hex("#1f8f4f")])];
  const drinks = [hex("#e8343a"), hex("#2f80ed"), hex("#27ae60"), hex("#f2c94c"), hex("#f2994a"), hex("#ffffff")];
  bodies.forEach((body, m) => {
    const x0 = m * 13;
    rect(s, x0, 0, x0 + 12, 30, body);
    rect(s, x0, 0, x0 + 12, 1, shade(body, 1.25));
    rect(s, x0 + 1, 2, x0 + 11, 17, hex("#e6f6ff"));
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 4; k++) rect(s, x0 + 2 + k * 2, 3 + row * 5, x0 + 3 + k * 2, 6 + row * 5, rng.pick(drinks));
      rect(s, x0 + 2, 6 + row * 5, x0 + 10, 7 + row * 5, hex("#b8c4cc")); // the shelf
    }
    rect(s, x0 + 1, 18, x0 + 11, 19, hex("#4a4f5a"));
    rect(s, x0 + 8, 20, x0 + 11, 23, hex("#2a2d36"));
    rect(s, x0 + 2, 24, x0 + 10, 27, hex("#16181f"));
  });
  outline(s, NIGHT_INK);
  return { sprite: s, height: 1.9, solid: true };
}

/** Red paper lanterns, glowing, hung from a little wooden eave on a post. */
function lantern(rng: Rand): SceneryArt {
  const s = makeSprite(22, 36);
  const wood = hex("#4a2e1c");
  rect(s, 10, 6, 12, 36, wood);
  rect(s, 1, 3, 21, 4, shade(wood, 1.4));
  rect(s, 2, 4, 20, 6, wood);
  const lit = rng.next() < 0.5 ? hex("#ff7a3a") : hex("#ff9a4a");
  for (const cx of [5, 16]) {
    rect(s, cx, 6, cx + 1, 8, hex("#2a1a10"));
    for (let y = 8; y < 21; y++) {
      const t = (y - 8) / 12, w = Math.round(3.6 * Math.sin(Math.PI * (0.12 + 0.76 * t)) + 0.4);
      for (let x = cx - w; x <= cx + 1 + w; x++) {
        const c = y === 8 || y === 20 ? hex("#1a1210") : y % 3 === 0 ? hex("#b5141c") : Math.abs(x - cx - 0.5) < w * 0.45 ? lit : hex("#e8232e");
        px(s, x, y, c);
      }
    }
  }
  outline(s, hex("#140c08"));
  return { sprite: s, height: 3.2, solid: true };
}

/** A neon sign on a pole: a glowing border round a dark panel, and down it four characters made of
 * bright strokes (the look of signs on the street, not words). */
function neonsign(rng: Rand): SceneryArt {
  const s = makeSprite(14, 50);
  const neon = rng.pick(NEONS), ink = rng.pick([hex("#ffffff"), hex("#fff4b0"), rng.pick(NEONS)]);
  rect(s, 6, 32, 8, 50, hex("#4a4f5a"));
  rect(s, 0, 0, 14, 33, neon);
  rect(s, 1, 1, 13, 32, hex("#140f1f"));
  for (let g = 0; g < 4; g++) {
    const y0 = 3 + g * 7;
    rect(s, 3, y0 + rng.int(0, 2), 3 + rng.int(5, 8), y0 + rng.int(0, 2) + 1, ink); // a stroke across
    const x = 4 + rng.int(0, 5);
    rect(s, x, y0, x + 1, y0 + rng.int(4, 6), ink); // one down
    if (rng.next() < 0.7) { const y = y0 + rng.int(3, 5); rect(s, 3 + rng.int(0, 2), y, 3 + rng.int(5, 8), y + 1, ink); }
  }
  outline(s, NIGHT_INK);
  return { sprite: s, height: 5.5 + rng.range(0, 1.5), solid: true };
}

/** A utility pole: concrete, two crossarms with white insulators, a transformer, and wires
 * drooping away to either side. */
function pole(rng: Rand): SceneryArt {
  const s = makeSprite(32, 64);
  const conc = hex("#8a8e96"), arm = hex("#4f535b"), wire = hex("#16181d");
  rect(s, 15, 0, 17, 64, conc);
  rect(s, 15, 0, 16, 64, shade(conc, 1.15));
  for (const y of [6, 12]) {
    rect(s, 7, y, 25, y + 1, arm);
    for (const x of [8, 12, 20, 24]) px(s, x, y - 1, hex("#e8e8e2"));
  }
  rect(s, 17, 20, 22, 28, hex("#6f747c"));
  rect(s, 17, 20, 22, 21, hex("#9aa0aa"));
  outline(s, NIGHT_INK);
  const sag = rng.range(2.5, 4);
  for (const [x0, y0, x1] of [[8, 5, 0], [24, 5, 31], [12, 11, 0], [20, 11, 31]]) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      const t = (x - x0) / (x1 - x0);
      px(s, x, Math.round(y0 + 4 * sag * t * (1 - t) + 2 * t), wire);
    }
  }
  return { sprite: s, height: 10, solid: true };
}

/** A cherry tree in blossom: a dark trunk and branches under a cloud of pink, petals falling. */
function sakura(rng: Rand): SceneryArt {
  const s = makeSprite(36, 36);
  const trunk = hex("#3a2620"), pinks = [hex("#ffc4dd"), hex("#ff9ec7"), hex("#ffb7d5")];
  rect(s, 16, 20, 20, 36, trunk);
  stroke(s, 18, 23, 9, 14, 1, trunk);
  stroke(s, 18, 23, 27, 13, 1, trunk);
  for (const [cx, cy, r] of [[18, 11, 10], [9, 15, 7], [27, 15, 7], [18, 18, 7]]) {
    disc(s, cx, cy, r, (x, y) => (y < cy - r * 0.35 ? hex("#ffe2ef") : pinks[(x * 3 + y * 5) % 3]));
  }
  for (let k = 0; k < 10; k++) px(s, rng.int(6, 30), rng.int(3, 22), hex("#ffffff"));
  outline(s, hex("#5a2a3a"));
  for (let k = 0; k < 7; k++) px(s, rng.int(3, 33), rng.int(25, 35), hex("#ffb7d5")); // petals, falling
  return { sprite: s, height: 6.5 + rng.range(-1, 1.5), solid: true };
}

/** An office tower at night: dark glass, rows of windows (most lit, warm or cool), a red light on
 * the roof, and on some a tall neon sign down one side. */
function tower(rng: Rand): SceneryArt {
  const w = rng.int(22, 30), h = rng.int(84, 112);
  const s = makeSprite(w + 6, h);
  const glass = rng.pick([hex("#1d2436"), hex("#232a3d"), hex("#1a1f2e")]);
  rect(s, 0, 5, w, h, glass);
  rect(s, 0, 5, 2, h, shade(glass, 1.5));
  for (let y = 8; y < h - 2; y += 4) {
    for (let x = 3; x < w - 2; x += 3) {
      const r = rng.next();
      rect(s, x, y, x + 2, y + 2, r < 0.36 ? hex("#ffd98a") : r < 0.56 ? hex("#dfe8ff") : r < 0.6 ? hex("#9fd8ff") : shade(glass, 0.75));
    }
  }
  rect(s, 4, 1, w - 4, 5, shade(glass, 0.85));
  px(s, w >> 1, 0, hex("#ff2a2a"));
  if (rng.next() < 0.6) {
    const neon = rng.pick(NEONS), top = rng.int(14, 30), len = rng.int(26, 44);
    rect(s, w, top, w + 6, top + len, neon);
    rect(s, w + 1, top + 1, w + 5, top + len - 1, hex("#140f1f"));
    for (let y = top + 3; y < top + len - 3; y += 5) rect(s, w + 2, y, w + 4, y + 3, neon);
  }
  outline(s, NIGHT_INK);
  return { sprite: s, height: 45 + rng.range(0, 25), solid: false };
}

/** A block of flats at night: a balcony along every floor, windows lit warm (a few blue with a
 * television on), air conditioners. */
function apartment(rng: Rand): SceneryArt {
  const w = 44, floors = rng.int(7, 11), fh = 6, h = floors * fh + 3;
  const s = makeSprite(w, h);
  const wall = shade(rng.pick([hex("#8f8a80"), hex("#7f8590"), hex("#9a8f7f")]), 0.55);
  rect(s, 0, 0, w, h, wall);
  rect(s, 0, 0, w, 3, shade(wall, 0.8));
  for (let f = 0; f < floors; f++) {
    const y = 3 + f * fh;
    for (let x = 2; x < w - 4; x += 6) {
      const r = rng.next();
      rect(s, x, y + 1, x + 4, y + 4, r < 0.5 ? hex("#ffcf7a") : r < 0.6 ? hex("#7fb2ff") : hex("#202330"));
      if (rng.next() < 0.25) rect(s, x + 4, y + 3, x + 6, y + 5, hex("#c8ccd4")); // an air conditioner
    }
    rect(s, 0, y + fh - 1, w, y + fh, shade(wall, 1.6));
  }
  outline(s, NIGHT_INK);
  return { sprite: s, height: floors * 2.8, solid: false };
}

/** A billboard up on a frame: a big lit screen of colour and shapes (no words). */
function billboard(rng: Rand): SceneryArt {
  const s = makeSprite(48, 40);
  const frame = hex("#3a3e46"), a = rng.pick(NEONS), b = rng.pick([hex("#3a1d6e"), hex("#0f3a6e"), hex("#6e0f3a")]);
  rect(s, 8, 27, 10, 40, frame);
  rect(s, 38, 27, 40, 40, frame);
  rect(s, 0, 0, 48, 28, frame);
  for (let y = 2; y < 26; y++) for (let x = 2; x < 46; x++) px(s, x, y, mix(b, a, Math.min(1, (x + y) / 64)));
  const cx = rng.int(10, 36);
  disc(s, cx, 13, rng.int(5, 8), () => hex("#ffffff"));
  for (let k = 0; k < 3; k++) {
    const y = rng.int(4, 22);
    rect(s, rng.int(3, 20), y, rng.int(26, 45), y + 2, mix(a, hex("#ffffff"), 0.5));
  }
  outline(s, NIGHT_INK);
  return { sprite: s, height: 14 + rng.range(0, 6), solid: false };
}

/** A five-storey pagoda: dark roofs with upturned eaves, vermilion walls between them, a lit
 * window in each, and the spire with its gold rings on top. */
function pagoda(): SceneryArt {
  const w = 38, h = 80;
  const s = makeSprite(w, h);
  const roof = hex("#2a2a33"), wall = hex("#b8322a"), gold = hex("#d9a441"), cx = 19;
  rect(s, cx - 1, 0, cx + 1, 18, gold);
  for (let y = 3; y < 16; y += 3) rect(s, cx - 2, y, cx + 2, y + 1, gold);
  for (let t = 0; t < 5; t++) {
    const yb = 18 + t * 12, half = 7 + t * 2.5;
    rect(s, Math.round(cx - half * 0.6), yb + 3, Math.round(cx + half * 0.6), yb + 12, wall);
    rect(s, cx - 1, yb + 6, cx + 1, yb + 9, hex("#ffd98a"));
    for (let y = yb; y < yb + 4; y++) {
      const hw2 = half * (0.55 + ((y - yb) / 4) * 0.45);
      rect(s, Math.round(cx - hw2), y, Math.round(cx + hw2), y + 1, y === yb ? shade(roof, 1.6) : roof);
    }
    px(s, Math.round(cx - half) - 1, yb + 1, roof); // the eaves' upturned tips
    px(s, Math.round(cx + half), yb + 1, roof);
  }
  rect(s, 7, 78, 31, 80, hex("#5a5e66"));
  outline(s, NIGHT_INK);
  return { sprite: s, height: 32, solid: false };
}

// ---------------------------------------------------------------------------------- the volcano

const HOT = [hex("#ffd86a"), hex("#ff8a1f"), hex("#e0400e")];

/** A cluster of hexagonal basalt columns: lit tops, a lit face and a shaded face on each. */
function basalt(rng: Rand): SceneryArt {
  const n = rng.int(3, 6), cw = 6, w = n * cw + 2, h = 40;
  const s = makeSprite(w, h);
  const base = rng.pick([hex("#3b3237"), hex("#43383c"), hex("#352d33")]);
  for (let k = 0; k < n; k++) {
    const x0 = 1 + k * cw, top = rng.int(4, 22);
    for (let y = top; y < h; y++) {
      for (let x = x0; x < x0 + cw; x++) {
        const face = x < x0 + 2 ? 1.25 : x > x0 + cw - 3 ? 0.72 : 1; // lit left, shaded right
        const joint = (y - top) % 9 === 8; // the columns crack into drums
        px(s, x, y, y < top + 2 ? shade(base, 1.6) : shade(base, joint ? face * 0.7 : face));
      }
    }
    if (rng.next() > 0.6) px(s, x0 + 2, h - 3, HOT[1]); // a glint of lava in a crack at the foot
  }
  outline(s, hex("#120c0e"));
  return { sprite: s, height: 3 + rng.range(0, 2.5), solid: true };
}

/** Black volcanic glass: shards pointing up, each with a bright edge catching the lava's light. */
function obsidian(rng: Rand): SceneryArt {
  const s = makeSprite(24, 30);
  const shards = rng.int(3, 5);
  for (let k = 0; k < shards; k++) {
    const cx = rng.range(5, 19), top = rng.range(1, 14), half = rng.range(3, 5.5);
    poly(s, [[cx - half, 30], [cx + rng.range(-2, 2), top], [cx + half, 30]],
         (x) => (x < cx - half * 0.35 ? hex("#3a2a52") : x > cx + half * 0.3 ? hex("#0d0a14") : hex("#1c1626")));
    stroke(s, cx - half + 1, 29, cx + rng.range(-1.5, 1.5), top + 2, 0.4, hex("#b48cff")); // the bright edge
  }
  outline(s, hex("#07050c"));
  return { sprite: s, height: 2.4 + rng.range(0, 1.8), solid: true };
}

/** A fumarole: a small cone of rock with lava glowing in its throat and a plume of smoke. */
function vent(rng: Rand): SceneryArt {
  const s = makeSprite(28, 34);
  poly(s, [[1, 33], [10, 15], [18, 15], [27, 33]], (x, y) =>
    y > 30 ? hex("#2a1e20") : x < 11 ? hex("#5a4446") : x > 18 ? hex("#2e2225") : hex("#45363a"));
  for (let x = 10; x < 18; x++) px(s, x, 15, HOT[x % 3 === 0 ? 0 : 1]); // the glowing throat
  for (let x = 11; x < 17; x++) px(s, x, 16, HOT[2]);
  for (let k = 0; k < 4; k++) { // a lava trickle down the flank
    px(s, 12 - k, 17 + k * 3, HOT[1]);
    px(s, 12 - k, 18 + k * 3, HOT[2]);
  }
  for (let k = 0; k < 4; k++) { // smoke
    const r = 2.5 + k * 1.1;
    disc(s, 14 + Math.sin(k * 1.7) * 2, 11 - k * 3, r, () => (k ? hex("#5c5052") : hex("#7a6a6a")));
  }
  if (rng.next() > 0.5) px(s, 16, 2, HOT[0]); // an ember
  outline(s, hex("#130c0d"));
  return { sprite: s, height: 3 + rng.range(0, 1.2), solid: true };
}

/** A tall spire of rock standing out of the lava, jagged, with magma glowing in cracks at its foot. */
function spire(rng: Rand): SceneryArt {
  const w = 32, h = 84;
  const s = makeSprite(w, h);
  const lean = rng.range(-4, 4), rock = hex("#3a2e33");
  for (let y = 0; y < h; y++) {
    const u = y / h; // 0 at the tip
    const half = 2 + u * 13 + Math.sin(y * 0.9) * 1.2 + (y % 11 < 2 ? 1.5 : 0);
    const cx = 16 + lean * (1 - u);
    for (let x = Math.round(cx - half); x <= cx + half; x++) {
      const lit = x < cx - half * 0.3 ? 1.3 : x > cx + half * 0.4 ? 0.68 : 1;
      const glow = u > 0.8 ? (u - 0.8) * 4 : 0; // the lava's light on its foot
      px(s, x, y, mix(shade(rock, lit), hex("#c2410f"), glow * 0.55));
    }
  }
  for (let k = 0; k < 5; k++) { // cracks of magma near the foot
    let x = rng.range(9, 23), y = rng.range(60, 82);
    for (let j = 0; j < 6; j++) {
      px(s, x, y, HOT[j % 2]);
      x += rng.range(-1, 1);
      y -= 1;
    }
  }
  outline(s, hex("#110a0c"));
  return { sprite: s, height: 16 + rng.range(0, 10), solid: false };
}

/** A boulder of cooled lava with glowing cracks across it. */
function magmarock(rng: Rand): SceneryArt {
  const r = rock(rng, hex("#3d3236"));
  const sp = r.sprite;
  for (let k = 0; k < 3; k++) {
    let x = rng.range(5, 17), y = rng.range(4, 9);
    for (let j = 0; j < 7; j++) {
      if (sp.data[Math.round(y) * sp.w + Math.round(x)]) px(sp, x, y, HOT[j % 3 === 2 ? 2 : 1]);
      x += rng.range(0.4, 1.2) * (k % 2 ? 1 : -1);
      y += rng.range(0, 0.9);
    }
  }
  return { ...r, height: 1.5 + rng.range(0, 1.1) };
}

/** The rescue drone that fishes a kart out of the lava: four rotors (a blur, two frames), a
 * warning light that blinks, and a winch underneath. */
export function droneFrames(): SceneryArt[] {
  return [0, 1].map((f) => {
    const s = makeSprite(34, 16);
    for (const cx of [5, 28]) { // the rotors: pale blurred discs (alternating streaks spin them)
      for (let x = -5; x <= 5; x++) {
        for (const y of [2, 3]) {
          if ((x + y + f) % 3 !== 0 || Math.abs(x) < 4) px(s, cx + x, y, (x + f) % 2 ? hex("#dfe6ee") : hex("#9aa6b4"));
        }
      }
      rect(s, cx - 1, 3, cx + 1, 6, hex("#4a505c")); // the motor
    }
    stroke(s, 5, 6, 28, 6, 0.8, hex("#5a606c")); // the arms
    for (let y = 5; y < 12; y++) { // the body
      for (let x = 11; x < 23; x++) {
        const corner = (x === 11 || x === 22) && (y === 5 || y === 11);
        if (!corner) px(s, x, y, y < 7 ? hex("#ffcf3a") : x < 14 ? hex("#e8a51c") : x > 20 ? hex("#a66d0c") : hex("#d1901a"));
      }
    }
    for (let x = 12; x < 22; x += 3) px(s, x, 9, hex("#2a2016")); // hazard stripes
    px(s, 16, 4, f ? hex("#ff3b2a") : hex("#ffb0a0")); // the warning light
    px(s, 17, 4, f ? hex("#ff3b2a") : hex("#ffb0a0"));
    rect(s, 15, 12, 19, 14, hex("#3a3f4a")); // the winch
    outline(s, hex("#14161c"));
    return { sprite: s, height: 0.95, solid: false };
  });
}

// ---------------------------------------------------------------------------------- the construction zone

const STEEL_Y = hex("#f2b705"), STEEL_YD = hex("#b38300");

/** A tower crane: a yellow lattice mast, a cab at the top, the jib out to one side with its
 * trolley and hook, the counter-jib and its concrete weights on the other. */
function crane(rng: Rand): SceneryArt {
  const W = 56, Hh = 96;
  const s = makeSprite(W, Hh);
  const mx = 16; // the mast's left rail
  for (let y = 12; y < Hh; y++) { // the mast: two rails and zigzag lacing
    px(s, mx, y, STEEL_Y);
    px(s, mx + 5, y, STEEL_YD);
    const k = (y - 12) % 10;
    px(s, mx + Math.round(k < 5 ? k : 10 - k), y, k < 5 ? STEEL_Y : STEEL_YD);
  }
  for (let x = 2; x < W; x++) { // the jib and the counter-jib, a lattice beam
    px(s, x, 10, STEEL_Y);
    px(s, x, 14, STEEL_YD);
    const k = x % 6;
    px(s, x, 10 + Math.round(k < 3 ? k * 1.3 : (6 - k) * 1.3), STEEL_Y);
  }
  stroke(s, mx + 2.5, 2, 4, 10, 0.4, hex("#4a4f5a")); // the tie rods from the top of the mast
  stroke(s, mx + 2.5, 2, W - 2, 10, 0.4, hex("#4a4f5a"));
  rect(s, mx - 1, 0, mx + 7, 3, STEEL_Y);
  rect(s, 2, 15, 9, 22, hex("#9a9a94")); // the counterweights
  rect(s, 2, 15, 9, 16, hex("#c4c4bc"));
  rect(s, mx + 6, 15, mx + 13, 22, hex("#e8e8e2")); // the cab, and its window
  rect(s, mx + 7, 16, mx + 12, 19, hex("#3a6fd8"));
  const tx = rng.int(30, W - 6); // the trolley, the cable and the hook
  rect(s, tx - 1, 14, tx + 2, 16, hex("#4a4f5a"));
  for (let y = 16; y < 44; y++) px(s, tx, y, hex("#2a2d36"));
  rect(s, tx - 1, 44, tx + 2, 47, hex("#c0392b"));
  outline(s, hex("#3a2a00"));
  return { sprite: s, height: 30 + rng.range(0, 8), solid: false };
}

/** A building going up: a concrete-and-steel frame, floor by floor, columns standing up from the
 * unfinished top, a safety net on one floor. */
function skeleton(rng: Rand): SceneryArt {
  const W = 52, Hh = 76;
  const s = makeSprite(W, Hh);
  const floors = rng.int(5, 8), fh = Math.floor((Hh - 8) / floors);
  for (let f = 0; f <= floors; f++) {
    const y = Hh - 1 - f * fh;
    rect(s, 0, y - 2, W, y + 1, f === 0 ? hex("#8a8a86") : hex("#b8b8b2")); // the slab
    rect(s, 0, y - 2, W, y - 1, hex("#d6d6d0"));
  }
  for (let x = 1; x < W; x += 10) { // the columns, lit on the left
    rect(s, x, Hh - floors * fh - 6, x + 2, Hh, hex("#9a9ea8"));
    px(s, x, Hh - floors * fh - 6, hex("#c8ccd4"));
  }
  const net = rng.int(1, floors);
  for (let y = Hh - 1 - net * fh + 2; y < Hh - 1 - (net - 1) * fh - 2; y++) {
    for (let x = 0; x < W; x++) if ((x + y) % 3 === 0) px(s, x, y, hex("#ff7a1a"));
  }
  outline(s, hex("#3a3c42"));
  return { sprite: s, height: 22 + rng.range(0, 14), solid: false };
}

/** A cement mixer truck: the cab, the turning drum (lit round its length), the wheels. */
function mixer(rng: Rand): SceneryArt {
  const s = makeSprite(36, 22);
  const paint = rng.pick([hex("#ff7a1a"), hex("#e8e8e2"), hex("#2f80ed")]);
  rect(s, 2, 12, 34, 17, hex("#3a3d46")); // the chassis
  rect(s, 25, 5, 34, 15, paint); // the cab
  rect(s, 27, 7, 32, 10, hex("#9ad0ff"));
  rod(s, 4, 11, 24, 7, (t) => 5.2 - Math.abs(t - 0.45) * 4, (t, n) => (Math.floor(t * 8 + n * 2) % 2 ? hex("#e8e8e2") : paint));
  for (const wx of [6, 16, 30]) ball(s, wx, 18, 3, () => hex("#24242c"), 0, 0.5);
  outline(s, hex("#16171c"));
  return { sprite: s, height: 3.4, solid: true };
}

/** An excavator: a yellow cab on its tracks, the boom and the arm reaching up, the bucket. */
function digger(rng: Rand): SceneryArt {
  const s = makeSprite(38, 28);
  rect(s, 2, 21, 24, 27, hex("#2a2b30")); // the tracks
  for (let x = 3; x < 24; x += 3) px(s, x, 24, hex("#5a5c66"));
  rect(s, 4, 13, 22, 21, STEEL_Y); // the body and the cab
  rect(s, 4, 13, 22, 14, hex("#ffd45a"));
  rect(s, 6, 8, 14, 15, STEEL_Y);
  rect(s, 7, 9, 13, 13, hex("#9ad0ff"));
  const up = rng.range(4, 10);
  stroke(s, 18, 14, 28, up, 1.3, STEEL_YD); // the boom
  stroke(s, 28, up, 34, 18, 1.1, STEEL_Y); // the arm
  poly(s, [[31, 18], [37, 18], [36, 23], [32, 23]], () => hex("#5a5c66")); // the bucket
  outline(s, hex("#2a1e00"));
  return { sprite: s, height: 4.2, solid: true };
}

/** A stack of concrete pipes, end on: rings with dark middles, in a pyramid. */
function pipes(rng: Rand): SceneryArt {
  const s = makeSprite(30, 18);
  const c = rng.pick([hex("#a8a49a"), hex("#b06a3a")]);
  for (const [cx, cy] of [[6, 12], [15, 12], [24, 12], [10.5, 5], [19.5, 5]]) {
    ball(s, cx, cy, 4.6, () => c, 0, 0.6);
    disc(s, cx, cy, 2.2, () => hex("#2a2620"));
  }
  outline(s, hex("#3a352c"));
  return { sprite: s, height: 2, solid: true };
}

/** Steel beams in a pile, red with primer, their flanges catching the light. */
function girders(rng: Rand): SceneryArt {
  const s = makeSprite(34, 12);
  for (let k = 0; k < 3; k++) {
    const y = 9 - k * 3, x0 = rng.int(0, 4), x1 = 34 - rng.int(0, 4);
    rect(s, x0, y, x1, y + 1, hex("#d65a3a"));
    rect(s, x0, y + 1, x1, y + 2, hex("#8a3220"));
    rect(s, x0, y + 2, x1, y + 3, hex("#b5442a"));
  }
  outline(s, hex("#2a120a"));
  return { sprite: s, height: 1.3, solid: true };
}

/** A concrete barrier with a red and white band. */
function barrier(): SceneryArt {
  const s = makeSprite(26, 12);
  poly(s, [[1, 12], [5, 4], [21, 4], [25, 12]], (x, y) => (y < 7 ? (Math.floor(x / 4) % 2 ? hex("#e8e8e2") : hex("#d62828")) : x < 6 ? hex("#c8c6bc") : hex("#a8a69c")));
  outline(s, hex("#3a3a36"));
  return { sprite: s, height: 1.1, solid: true };
}

/** A traffic drum: orange and white bands, round. */
function drum(): SceneryArt {
  const s = makeSprite(12, 17);
  rod(s, 6, 1, 6, 16, () => 5, (t) => (Math.floor(t * 5) % 2 ? hex("#f4f4f0") : hex("#ff6a14")));
  outline(s, hex("#2a1408"));
  return { sprite: s, height: 1.2, solid: true };
}

// ---------------------------------------------------------------------------------- the moon

const FOIL = [hex("#f2c14e"), hex("#c8922a"), hex("#ffe08a")];

/** A lunar lander: a gold-foil descent stage on splayed legs, the white ascent stage on top, a
 * dish. */
function lander(rng: Rand): SceneryArt {
  const s = makeSprite(38, 36);
  for (const [x0, x1] of [[6, 2], [32, 36]]) stroke(s, x0 + (x0 < 19 ? 8 : -8), 22, x1, 34, 0.7, hex("#c8ccd4")); // the legs
  for (const x of [2, 36]) rect(s, x - 2, 33, x + 3, 35, hex("#a8acb4")); // the pads
  for (let y = 17; y < 28; y++) for (let x = 9; x < 30; x++) px(s, x, y, FOIL[(x * 7 + y * 3 + Math.floor(rng.next() * 2)) % 3]); // the foil
  ball(s, 19, 13, 8, (u) => (u < -0.3 ? hex("#ffffff") : hex("#d8dce4")), 0, 0.55); // the ascent stage
  rect(s, 16, 10, 22, 13, hex("#2a2d36"));
  stroke(s, 27, 8, 32, 2, 0.5, hex("#c8ccd4"));
  disc(s, 32.5, 2.5, 2, () => hex("#f4f4f0"));
  outline(s, hex("#2a2620"));
  return { sprite: s, height: 7, solid: true };
}

/** A radio dish on its mount, turned up to the sky. */
function dish(rng: Rand): SceneryArt {
  const s = makeSprite(32, 34);
  rect(s, 14, 18, 18, 34, hex("#9aa0aa")); // the mount
  rect(s, 10, 31, 22, 34, hex("#7a808a"));
  const tilt = rng.range(-0.4, 0.4);
  for (let y = 0; y < 22; y++) {
    for (let x = 0; x < 32; x++) {
      const u = (x - 16) / 15, v = (y - 11) / 7, rr = u * u + v * v;
      if (rr > 1) continue;
      const lit = 0.75 + 0.35 * (-u * 0.5 - v * 0.6 + tilt * u);
      px(s, x, y, shade(hex("#e8ecf2"), lit));
    }
  }
  stroke(s, 16, 11, 16 + tilt * 6, 2, 0.5, hex("#5a606c")); // the feed
  outline(s, hex("#3a3e48"));
  return { sprite: s, height: 6, solid: true };
}

/** A habitat: a white dome with a lit window band and a door, a solar panel beside it. */
function habitat(): SceneryArt {
  const s = makeSprite(40, 22);
  for (let y = 0; y < 22; y++) {
    for (let x = 0; x < 30; x++) {
      const u = (x - 15) / 14.5, v = (y - 21) / 20;
      if (u * u + v * v > 1) continue;
      const [diff] = lit(u, v, Math.sqrt(Math.max(0, 1 - u * u - v * v)));
      px(s, x, y, shade(hex("#e8ecf2"), 0.55 + diff * 0.6));
    }
  }
  for (let x = 4; x < 26; x += 4) rect(s, x, 13, x + 2, 15, hex("#ffd98a")); // the windows, lit
  rect(s, 13, 15, 17, 22, hex("#5a606c")); // the door
  rect(s, 33, 12, 34, 22, hex("#9aa0aa")); // the solar panel
  poly(s, [[29, 6], [40, 4], [40, 12], [29, 14]], (x, y) => ((x + y) % 3 ? hex("#2a4fb0") : hex("#4a7fe0")));
  outline(s, hex("#3a3e48"));
  return { sprite: s, height: 4.5, solid: true };
}

/** A moon rock, pocked with little craters. */
function boulder(rng: Rand): SceneryArt {
  const r = rock(rng, hex("#8a8b91"));
  for (let k = 0; k < 4; k++) {
    const x = Math.round(rng.range(5, 17)), y = Math.round(rng.range(4, 12));
    if (r.sprite.data[y * r.sprite.w + x]) {
      px(r.sprite, x, y, hex("#5a5b60"));
      px(r.sprite, x + 1, y, hex("#b0b1b6"));
    }
  }
  return { ...r, height: 1.4 + rng.range(0, 1.8) };
}

/** A rover: six wheels, a white body with a solar deck, a mast with a camera head. */
function rover(): SceneryArt {
  const s = makeSprite(30, 20);
  rect(s, 5, 9, 25, 14, hex("#e8ecf2"));
  rect(s, 3, 7, 27, 9, hex("#2a4fb0"));
  for (const x of [6, 15, 24]) ball(s, x, 16, 3.2, () => hex("#5a5c66"), 0, 0.5);
  rect(s, 20, 1, 22, 9, hex("#9aa0aa"));
  rect(s, 18, 0, 25, 3, hex("#d8dce4"));
  outline(s, hex("#2a2d36"));
  return { sprite: s, height: 2.2, solid: true };
}

export function makeScenery(kind: SceneryKind, rng: Rand): SceneryArt {
  switch (kind) {
    case "kelp": return kelp(rng);
    case "coral": return coral(rng);
    case "anemone": return anemone(rng);
    case "shell": return shell(rng);
    case "wreck": return wreck(rng);
    case "streetlamp": return streetlamp(rng);
    case "vending": return vending(rng);
    case "lantern": return lantern(rng);
    case "neonsign": return neonsign(rng);
    case "pole": return pole(rng);
    case "sakura": return sakura(rng);
    case "tower": return tower(rng);
    case "apartment": return apartment(rng);
    case "billboard": return billboard(rng);
    case "pagoda": return pagoda();
    case "basalt": return basalt(rng);
    case "obsidian": return obsidian(rng);
    case "vent": return vent(rng);
    case "spire": return spire(rng);
    case "magmarock": return magmarock(rng);
    case "crane": return crane(rng);
    case "skeleton": return skeleton(rng);
    case "mixer": return mixer(rng);
    case "digger": return digger(rng);
    case "pipes": return pipes(rng);
    case "girders": return girders(rng);
    case "barrier": return barrier();
    case "drum": return drum();
    case "lander": return lander(rng);
    case "dish": return dish(rng);
    case "habitat": return habitat();
    case "boulder": return boulder(rng);
    case "rover": return rover();
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
// Items are drawn the way the 16-bit classics drew pre-rendered 3D: shading worked out pixel by
// pixel under one light from the upper left (round bodies, balls, a bevelled star, an extruded
// bolt, a crystal cube turning in ten steps), then kept as plain sprites. Each is drawn at a size
// ``k``: 1 in the world, about 1.6 in the HUD's item slot, which shows them pixel for pixel.

const LX = -0.52, LY = -0.6, LZ = 0.61; // the light (x right, y down, z out of the picture)

/** How lit a surface with normal (nx, ny, nz) is (in a few steps: the pixel-art look), and how
 * much of a highlight it shows. */
function lit(nx: number, ny: number, nz: number): [number, number] {
  const d = nx * LX + ny * LY + nz * LZ;
  const r = Math.max(0, 2 * d * nz - LZ) ** 18; // the light reflected toward the viewer
  return [Math.round(Math.max(0, d) * 6) / 6, r > 0.45 ? 1 : r > 0.15 ? 0.45 : 0];
}

/** A ball, lit, with a highlight and ``rim`` light reflected up onto its lower edge; ``base``
 * may vary over it (nx, ny: where on the ball, -1..1). */
function ball(s: Sprite, cx: number, cy: number, r: number, base: (nx: number, ny: number) => number,
              rim = 0, amb = 0.42): void {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const nx = (x + 0.5 - cx) / r, ny = (y + 0.5 - cy) / r, d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2), [diff, spec] = lit(nx, ny, nz);
      let c = shade(base(nx, ny), amb + diff * 0.85);
      if (rim && ny > 0) c = mix(c, rim, Math.min(0.7, (1 - nz) * ny * 1.6));
      if (spec) c = mix(c, 0xffffffff, spec);
      px(s, x, y, c);
    }
  }
}

/** A round body lying in the picture from (x0, y0) to (x1, y1), its radius ``r(t)`` along the
 * way (t = 0..1), shaded round; ``color(t, n)`` is its colour there, n across it (-1..1). */
function rod(s: Sprite, x0: number, y0: number, x1: number, y1: number, r: (t: number) => number,
             color: (t: number, n: number) => number, amb = 0.45): void {
  const len = Math.hypot(x1 - x0, y1 - y0), ax = (x1 - x0) / len, ay = (y1 - y0) / len;
  let big = 0;
  for (let k = 0; k <= 24; k++) big = Math.max(big, r(k / 24));
  for (let y = Math.floor(Math.min(y0, y1) - big); y <= Math.max(y0, y1) + big; y++) {
    for (let x = Math.floor(Math.min(x0, x1) - big); x <= Math.max(x0, x1) + big; x++) {
      const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
      const t = (dx * ax + dy * ay) / len, rr = t >= 0 && t <= 1 ? r(t) : 0;
      if (rr <= 0) continue;
      const n = (-dx * ay + dy * ax) / rr;
      if (Math.abs(n) > 1) continue;
      const [diff, spec] = lit(-ay * n, ax * n, Math.sqrt(1 - n * n));
      let c = shade(color(t, n), amb + diff * 0.8);
      if (spec) c = mix(c, 0xffffffff, spec * 0.85);
      px(s, x, y, c);
    }
  }
}

/** A capsule's radius ``r`` along its length: straight, rounded over the last ``end`` of each end. */
const capsule = (r: number, end: number) => (t: number): number => {
  const e = Math.max(0, Math.abs(t - 0.5) - (0.5 - end)) / end;
  return r * Math.sqrt(Math.max(0, 1 - e * e));
};

const QUESTION = [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."];
/** The rainbow of the items: item box rims, the sheen on oil. */
const SHEEN = ["#ff5fa2", "#ffd23f", "#5dff7a", "#63c8ff", "#c79bff"].map(hex);
/** Frames in a turn of the item box (a quarter turn: a cube looks the same after it). */
export const BOX_FRAMES = 10;

/** Item boxes: a crystal cube with a question mark on every side, seen from a little above,
 * turning as its rim cycles through the colours (ray-cast once into each frame). */
export function itemBoxFrames(): SceneryArt[] {
  const S = 26, unit = 7.8, pitch = 0.45; // px per half-edge; how far it is seen from above
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return Array.from({ length: BOX_FRAMES }, (_, f) => {
    const s = makeSprite(S, S);
    const yaw = 0.3 + (f / BOX_FRAMES) * (Math.PI / 2), rim = SHEEN[f % SHEEN.length];
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cube = (x: number, y: number, z: number) => [x * cy + y * sy, -x * sy + y * cy, z]; // view -> cube
    const d = cube(0, cp, -sp), right = cube(1, 0, 0), up = cube(0, sp, cp); // the ray, the picture's axes
    for (let py = 0; py < S; py++) {
      for (let qx = 0; qx < S; qx++) {
        const u = (qx + 0.5 - S / 2) / unit, v = (S / 2 - py - 0.5) / unit;
        const o = [0, 1, 2].map((a) => u * right[a] + v * up[a] - 5 * d[a]);
        let t0 = -Infinity, t1 = Infinity, axis = 0;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-9) {
            if (Math.abs(o[a]) > 1) t0 = Infinity;
            continue;
          }
          const ta = (-1 - o[a]) / d[a], tb = (1 - o[a]) / d[a];
          if (Math.min(ta, tb) > t0) { t0 = Math.min(ta, tb); axis = a; }
          t1 = Math.min(t1, Math.max(ta, tb));
        }
        if (t0 > t1) continue;
        const h = [0, 1, 2].map((a) => o[a] + t0 * d[a]);
        const sign = d[axis] > 0 ? -1 : 1; // the face turned to the viewer
        // where on that face (across, up), as seen from outside it
        const [fu, fv] = axis === 2 ? [h[0], h[1]] : axis === 0 ? [sign * h[1], h[2]] : [-sign * h[0], h[2]];
        const nx = sign * right[axis], nu = sign * up[axis], nz = -sign * d[axis];
        const [diff] = lit(nx, -nu, nz);
        let c: number;
        if (Math.max(Math.abs(fu), Math.abs(fv)) > 0.74) c = shade(rim, 0.66 + diff * 0.55); // the rim
        else {
          c = shade(mix(hex("#e9dcff"), rim, 0.3), axis === 2 ? 1.08 : 0.46 + diff * 0.7);
          if (axis !== 2) {
            const gx = Math.floor((fu + 0.5) * 5), gy = Math.floor(((0.62 - fv) / 1.24) * 7);
            if (gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && QUESTION[gy][gx] === "#") c = shade(hex("#3a1f6b"), 0.8 + diff * 0.3);
            else if (Math.abs(fu - fv * 0.6 + 0.4) < 0.08) c = mix(c, 0xffffffff, 0.6); // a glint
          }
        }
        px(s, qx, py, c);
      }
    }
    outline(s, hex("#1a1030"));
    return { sprite: s, height: 1.5, solid: false };
  });
}

/** An oil slick, as a sprite: the puddle a slick on raised road shows (on the ground, slicks
 * are painted into the road itself; see render/decals.ts). */
export function slickArt(): SceneryArt {
  const s = makeSprite(40, 12);
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 40; x++) {
      const e = ((x - 19.5) / 19.5) ** 2 + ((y - 5.5) / 5.8) ** 2;
      if (e > 1) continue;
      const sheen = Math.abs(e - 0.45) < 0.07;
      px(s, x, y, sheen ? SHEEN[Math.floor(x / 3) % SHEEN.length] : e > 0.85 ? hex("#2c2838") : hex("#14121c"));
    }
  }
  for (let x = 9; x < 17; x++) px(s, x, 3, hex("#8a8aa0")); // the shine
  return { sprite: s, height: 1.38, solid: false }; // 4.6 m across, as on the ground
}

/** A dream orb: a glassy violet ball with a pale swirl turning inside it. */
export function orbArt(k = 1): SceneryArt {
  const n = Math.round(20 * k), r = n / 2 - 0.7;
  const s = makeSprite(n, n);
  ball(s, n / 2, n / 2, r, (x, y) => {
    const a = Math.atan2(y, x), d = Math.hypot(x, y);
    return Math.sin(a * 2 + d * 6) > 0.55 && d < 0.85 ? hex("#cdb0ff") : hex("#7b3cff");
  }, hex("#ff7ad9"), 0.5);
  outline(s, hex("#2b0f5c"));
  return { sprite: s, height: 1.4, solid: false };
}

/** Fill a polygon (even-odd) in sprite pixel coordinates. */
function poly(s: Sprite, pts: number[][], color: (x: number, y: number) => number): void {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) px(s, x, y, color(x, y));
    }
  }
}

/** A thick line between two sprite points. */
function stroke(s: Sprite, x0: number, y0: number, x1: number, y1: number, r: number, c: number): void {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
  for (let k = 0; k <= n; k++) disc(s, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, r, () => c);
}

/** A turbo cell: an orange capsule with a white arrow up its front, standing up. */
function turboCell(k = 1): Sprite {
  const w = Math.round(14 * k), h = Math.round(18 * k);
  const s = makeSprite(w, h);
  rod(s, w / 2, 0.5, w / 2, h - 0.5, capsule(w / 2 - 1, 0.22), (t, n) => {
    const arrow = (t > 0.22 && t < 0.5 && Math.abs(n) < (t - 0.22) * 2.4) || (t >= 0.5 && t < 0.78 && Math.abs(n) < 0.24);
    return arrow ? 0xffffffff : t < 0.12 || t > 0.88 ? hex("#d9580a") : hex("#ff7a1a");
  });
  outline(s, hex("#3a1606"));
  return s;
}

/** Three turbo cells, for the HUD. */
function tripleIcon(k = 1): Sprite {
  const n = Math.round(18 * k);
  const s = makeSprite(n, n);
  const cell = turboCell(k * 0.58);
  for (const [fx, fy] of [[0.5, 0.02], [0.12, 0.42], [0.88, 0.42]]) {
    const ox = Math.round(fx * n - cell.w / 2), oy = Math.round(fy * n);
    for (let y = 0; y < cell.h; y++) for (let x = 0; x < cell.w; x++) {
      const c = cell.data[y * cell.w + x];
      if (c) px(s, ox + x, oy + y, c);
    }
  }
  return s;
}

/** A drop of oil, glossy black with a rainbow sheen, for the HUD. */
function oilIcon(k = 1): Sprite {
  const w = Math.round(14 * k), h = Math.round(18 * k);
  const s = makeSprite(w, h);
  const r = (t: number) => (t < 0.62 ? (w / 2 - 1) * (t / 0.62) ** 0.75 : (w / 2 - 1) * Math.sqrt(Math.max(0, 1 - ((t - 0.62) / 0.38) ** 2)));
  rod(s, w / 2, 0.5, w / 2, h - 0.5, r, (t, n) =>
    Math.abs(t - 0.66 + n * n * 0.1) < 0.045 ? SHEEN[Math.floor((n + 1) * 2.5) % SHEEN.length] : hex("#2a2638"), 0.5);
  outline(s, hex("#d9e1ea"));
  return s;
}

/** An oil barrel: what a kart holds out behind it before the slick is poured. */
function oilBarrel(k = 1): Sprite {
  const w = Math.round(14 * k), h = Math.round(18 * k);
  const s = makeSprite(w, h);
  const top = Math.max(2, Math.round(2.5 * k));
  rod(s, w / 2, top, w / 2, h - 0.5, () => w / 2 - 1, (t) =>
    Math.abs(t - 0.3) < 0.05 || Math.abs(t - 0.72) < 0.05 ? hex("#a3abc0") : hex("#2b3770"));
  // the lid, an ellipse seen from a little above, and its bung
  for (let y = 0; y < 2 * top; y++) {
    for (let x = 0; x < w; x++) {
      const e = ((x + 0.5 - w / 2) / (w / 2 - 1)) ** 2 + ((y + 0.5 - top) / top) ** 2;
      if (e <= 1) px(s, x, y, e > 0.6 ? hex("#5a6492") : hex("#3a4680"));
    }
  }
  px(s, Math.round(w * 0.65), top, hex("#141a33"));
  [hex("#ff5fa2"), hex("#ffd23f"), hex("#63c8ff")].forEach((c, i) => px(s, Math.round(w / 2 - 1 + i), Math.round(h * 0.52), c));
  outline(s, hex("#0a0d1c"));
  return s;
}

/** A boomerang, spinning flat (eight frames a turn) and seen from above at an angle: each arm
 * rounded across its width and lit, a yellow stripe near each tip, and its edge showing under it. */
export function boomerangFrames(k = 1): SceneryArt[] {
  const W = Math.round(28 * k), Hh = Math.round(22 * k), cx = W / 2, cy = Hh / 2 - k;
  const e = 0.62, se = Math.sin(e), ce = Math.cos(e); // how steeply it is seen from above
  const len = 10.5 * k, thick = 2.2 * k * ce;
  return Array.from({ length: 8 }, (_, f) => {
    const s = makeSprite(W, Hh);
    const a = (f / 8) * Math.PI * 2;
    const tips = [a, a + 1.95].map((b) => [Math.cos(b) * len, Math.sin(b) * len]);
    /** Nearest point on either arm to (x, y) in the boomerang's plane: [distance, how far out
     * the arm (0 at the elbow), signed offset across it, the arm's direction]. */
    const arm = (x: number, y: number): [number, number, number, number, number] => {
      let best: [number, number, number, number, number] = [Infinity, 0, 0, 0, 0];
      for (const [tx, ty] of tips) {
        const t = Math.max(0, Math.min(1, (x * tx + y * ty) / (len * len)));
        const d = Math.hypot(x - tx * t, y - ty * t);
        if (d < best[0]) best = [d, t, (x * ty - y * tx) / len, tx / len, ty / len];
      }
      return best;
    };
    const half = (t: number) => (3.1 - 1.2 * t) * k;
    for (const layer of [0, 1]) { // the edge first, the top over it
      for (let y = 0; y < Hh; y++) {
        for (let x = 0; x < W; x++) {
          // screen -> plane: x across, y away from the viewer (foreshortened)
          const [d, t, side, ax, ay] = arm(x + 0.5 - cx, -(y + 0.5 - cy - (layer ? 0 : thick)) / se);
          if (d > half(t)) continue;
          if (!layer) { px(s, x, y, hex("#0a4f49")); continue; }
          // the top is rounded across the arm: its normal leans out toward the nearer edge
          const w = Math.max(-1, Math.min(1, side / half(t))) * 0.75, up = Math.sqrt(1 - w * w);
          const bx = ay, by = -ax; // across the arm, in the plane
          const nx = bx * w, ny = -(by * w * se + up * ce), nz = -by * w * ce + up * se;
          const [diff, spec] = lit(nx, ny, nz);
          const base = Math.abs(t - 0.74) < 0.08 ? hex("#ffd23f") : hex("#1fb5a8");
          px(s, x, y, mix(shade(base, 0.5 + diff * 0.8), 0xffffffff, spec * 0.8));
        }
      }
    }
    outline(s, hex("#083b37"));
    return { sprite: s, height: 1.5, solid: false };
  });
}

/** A round bomb, gunmetal with a shine, a steel cap and a fuse whose spark flickers (two frames). */
export function bombFrames(k = 1): SceneryArt[] {
  const W = Math.round(22 * k), Hh = Math.round(26 * k), r = 9 * k, cx = W / 2 - 0.5 * k, cy = Hh - r - 0.6;
  return [0, 1].map((f) => {
    const s = makeSprite(W, Hh);
    ball(s, cx, cy, r, () => hex("#2c2c3a"), hex("#5a6aa8"), 0.55);
    // the cap: a short steel cylinder on top
    rod(s, cx - 3.2 * k, cy - r - 0.6 * k, cx + 3.2 * k, cy - r - 0.6 * k, () => 2 * k, () => hex("#8a8d99"));
    for (let x = Math.round(cx - 2.6 * k); x <= cx + 2.6 * k; x++) px(s, x, Math.round(cy - r - 2.4 * k), hex("#c9ccd6"));
    // the fuse, curling up and to the right, and its spark
    stroke(s, cx + 1.5 * k, cy - r - 2.5 * k, cx + 4.5 * k, cy - r - 4.2 * k, 0.55 * k, hex("#c9a46b"));
    const sx = cx + 5.6 * k, sy = Math.max(1.5, cy - r - 5 * k);
    disc(s, sx, sy, (f ? 1.7 : 1.1) * k, () => (f ? 0xffffffff : hex("#ffd23f")));
    if (f) { px(s, sx + 2 * k, sy - k, hex("#ff8a1f")); px(s, sx - 2 * k, sy - k, hex("#ff8a1f")); }
    outline(s, hex("#0b0b10"));
    return { sprite: s, height: 1.5, solid: false };
  });
}

/** An explosion ``height`` m tall: a white flash that blooms into fire and drifts off as smoke. */
export function blastFrames(height = 3.2): SceneryArt[] {
  return [0, 1, 2, 3, 4, 5].map((f) => {
    const s = makeSprite(40, 36);
    const rng = new Rand(17 + f);
    const r = 5 + f * 3;
    const t = f / 5;
    disc(s, 20, 20, r, (x, y) => {
      const d = Math.hypot(x - 20, y - 20) / r;
      if (t > 0.55 && rng.next() < (t - 0.5) * 0.9) return 0; // breaking up
      const lower = y > 20 + r * 0.25 && x > 20 - r * 0.2 ? 0.82 : 1; // a shaded underside: a ball of fire
      return shade(t < 0.25
        ? (d < 0.6 ? 0xffffffff : hex("#ffe27a"))
        : t < 0.7
          ? (d < 0.4 ? hex("#ffe27a") : d < 0.75 ? hex("#ff8a1f") : hex("#d9381e"))
          : (d < 0.5 ? hex("#8f8a90") : hex("#5d5862")), lower);
    });
    return { sprite: s, height, solid: false };
  });
}

/** The prism: a bevelled five-point star, each point a rainbow colour, lit on one side of its
 * ridge and shaded on the other. */
function prismIcon(k = 1): Sprite {
  const n = Math.round(18 * k);
  const s = makeSprite(n, n);
  const cx = n / 2, cy = n / 2 + 0.6 * k, R = n / 2 - 0.6, ri = R * 0.43;
  const pts: number[][] = [];
  for (let j = 0; j < 10; j++) {
    const a = -Math.PI / 2 + (j * Math.PI) / 5;
    pts.push([cx + Math.cos(a) * (j % 2 ? ri : R), cy + Math.sin(a) * (j % 2 ? ri : R)]);
  }
  const bands = ["#ff5fa2", "#ffd23f", "#5dff7a", "#63c8ff", "#c79bff"].map(hex);
  poly(s, pts, (x, y) => {
    const a = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
    const j = Math.round((a + Math.PI / 2) / ((2 * Math.PI) / 5));
    const tip = -Math.PI / 2 + (j * 2 * Math.PI) / 5;
    const face = tip + (Math.sin(a - tip) >= 0 ? 0.35 : -0.35); // which side of the point's ridge
    const [diff, spec] = lit(Math.cos(face) * 0.62, Math.sin(face) * 0.62, 0.78);
    return mix(shade(bands[((j % 5) + 5) % 5], 0.55 + diff * 0.75), 0xffffffff, spec * 0.8);
  });
  outline(s, hex("#2b0f5c"));
  return s;
}

/** The shock: a lightning bolt with depth: its edge shows below and to the right of its face. */
function shockIcon(k = 1): Sprite {
  const n = Math.round(18 * k);
  const s = makeSprite(n, n);
  const bolt = [[10, 0], [3, 10], [8, 10], [5, 17], [14, 6], [9, 6], [13, 0]].map(([x, y]) => [x * k, y * k]);
  poly(s, bolt.map(([x, y]) => [x + 1.4 * k, y + 1.1 * k]), () => hex("#a86e00"));
  poly(s, bolt, (x, y) => mix(hex("#fff8c0"), hex("#ffc21a"), Math.min(1, (x + y) / (20 * k))));
  for (let j = 0; j < 2; j++) { // light along the two upper-left edges
    const [a, b] = j ? [bolt[0], bolt[1]] : [bolt[2], bolt[3]];
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    for (let q = 0; q <= steps; q++) px(s, a[0] + ((b[0] - a[0]) * q) / steps + 0.6, a[1] + ((b[1] - a[1]) * q) / steps, 0xffffffff);
  }
  outline(s, hex("#3d2a00"));
  return s;
}

/** The rocket, nose up and to the right: a round white body with a red nose and fins, a window,
 * and its flame. */
function rocketIcon(k = 1): Sprite {
  const n = Math.round(18 * k);
  const s = makeSprite(n, n);
  const x0 = 4.2 * k, y0 = n - 4.2 * k, x1 = n - 1.2 * k, y1 = 1.2 * k;
  // the flame, then the fins, behind the body
  poly(s, [[x0 - 0.5 * k, y0 - 2.4 * k], [x0 + 2.4 * k, y0 + 0.5 * k], [0.4 * k, n - 0.4 * k]], () => hex("#ff8a1f"));
  disc(s, x0 - 0.6 * k, y0 + 0.6 * k, 1.5 * k, () => hex("#ffd23f"));
  poly(s, [[x0 + 1 * k, y0 - 4.5 * k], [x0 - 1.4 * k, y0 - 5 * k], [x0 + 3 * k, y0 - 2 * k]], () => hex("#ff5a6a"));
  poly(s, [[x0 + 4.5 * k, y0 - 1 * k], [x0 + 5 * k, y0 + 1.4 * k], [x0 + 2 * k, y0 - 3 * k]], () => hex("#b81f30"));
  rod(s, x0, y0, x1, y1, (t) => (t < 0.7 ? 2.9 * k : 2.9 * k * Math.sqrt(Math.max(0, 1 - ((t - 0.7) / 0.3) ** 2))),
      (t) => (t > 0.7 ? hex("#ff3b4f") : Math.abs(t - 0.12) < 0.05 ? hex("#ff3b4f") : hex("#eef0f6")));
  ball(s, x0 + (x1 - x0) * 0.48, y0 + (y1 - y0) * 0.48, 1.4 * k, () => hex("#3a6fd8"), 0, 0.5); // the window
  outline(s, hex("#1d1f2a"));
  return s;
}

/** A puck: a thick disc seen from a little above, its top lit and its edge showing, with three
 * studs round the rim that turn as it spins (four frames). */
export function puckFrames(k = 1): SceneryArt[] {
  const W = Math.round(18 * k), Hh = Math.round(12 * k), cx = W / 2, rx = W / 2 - 1, ry = rx * 0.42, top = ry + 1;
  const edge = 3 * k;
  return [0, 1, 2, 3].map((f) => {
    const s = makeSprite(W, Hh);
    // the edge: a band under the top face, lit on the left
    for (let y = Math.floor(top); y < Math.ceil(top + edge + ry); y++) {
      for (let x = 0; x < W; x++) {
        const n = (x + 0.5 - cx) / rx;
        if (Math.abs(n) > 1) continue;
        const bottom = top + edge + ry * Math.sqrt(1 - n * n);
        if (y + 0.5 > bottom) continue;
        const [diff] = lit(n, 0.3, Math.sqrt(1 - n * n));
        px(s, x, y, shade(hex("#0f6b36"), 0.55 + diff * 0.7));
      }
    }
    // the top: an ellipse, brighter toward the light, with a pale ring and three turning studs
    for (let y = 0; y < Hh; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - top) / ry, d = Math.hypot(u, v);
        if (d > 1) continue;
        const a = Math.atan2(v, u) - (f * Math.PI) / 6;
        const stud = d > 0.62 && d < 0.88 && Math.cos(3 * a) > 0.82;
        const ring = Math.abs(d - 0.45) < 0.1;
        const base = stud ? hex("#f6f2d2") : ring ? hex("#a8f5c8") : hex("#23b45d");
        px(s, x, y, shade(base, 0.82 + 0.3 * Math.max(0, -u * 0.6 - v * 0.5)));
      }
    }
    outline(s, hex("#06331a"));
    return { sprite: s, height: 0.75, solid: false };
  });
}

/** A fireball: a hot white core, orange flame round it and red tongues licking up (two frames). */
export function flareFrames(k = 1): SceneryArt[] {
  const W = Math.round(14 * k), Hh = Math.round(16 * k);
  return [0, 1].map((f) => {
    const s = makeSprite(W, Hh);
    const cx = W / 2, cy = Hh - W / 2;
    for (let y = 0; y < Hh; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - cx) / (W / 2 - 0.5), dy = (y + 0.5 - cy) / (W / 2 - 0.5);
        // a ball, drawn up into tongues of flame
        const lick = dy < 0 ? Math.abs(dx) * 1.4 + Math.max(0, -dy - 0.2) * (0.9 + 0.35 * Math.sin(dx * 7 + f * 2)) : 0;
        const d = Math.hypot(dx, dy > 0 ? dy : 0) + lick;
        if (d > 1) continue;
        px(s, x, y, d < 0.35 ? hex("#fff6c8") : d < 0.6 ? hex("#ffd23f") : d < 0.82 ? hex("#ff8a1f") : hex("#e0401a"));
      }
    }
    return { sprite: s, height: 0.9, solid: false };
  });
}

/** The comet: an icy blue ball wrapped in pale blue fire, sparkling. */
export function cometArt(k = 1): SceneryArt {
  const n = Math.round(22 * k), c = n / 2, r = n * 0.3;
  const s = makeSprite(n, n);
  for (let y = 0; y < n; y++) { // the fire round it
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c, d = Math.hypot(dx, dy) / (n / 2 - 0.5);
      const a = Math.atan2(dy, dx);
      if (d > 0.82 + 0.16 * Math.sin(a * 7)) continue;
      px(s, x, y, d > 0.7 ? hex("#2a6bff") : hex("#7cc4ff"));
    }
  }
  ball(s, c, c, r, () => hex("#cfeeff"), hex("#5aa8ff"), 0.6);
  for (const [dx, dy] of [[-0.9, -0.7], [0.8, -0.85], [0.95, 0.6]]) px(s, c + dx * r * 1.4, c + dy * r * 1.4, 0xffffffff);
  outline(s, hex("#0b2a6b"));
  return { sprite: s, height: 1.8, solid: false };
}

/** A spark of the comet's tail: a small glowing blue ball. */
export function trailArt(): SceneryArt {
  const s = makeSprite(8, 8);
  disc(s, 3.5, 3.5, 3.6, (x, y) => (Math.hypot(x - 3.5, y - 3.5) < 1.8 ? hex("#e6f6ff") : hex("#5aa8ff")));
  return { sprite: s, height: 0.7, solid: false };
}

/** A coin, turning (six frames): gold, lit across its face, a star struck in it while it faces you. */
export function coinFrames(k = 1): SceneryArt[] {
  const n = Math.round(14 * k);
  return [0, 1, 2, 3, 4, 5].map((f) => {
    const s = makeSprite(n, n);
    const turn = Math.cos((f / 6) * Math.PI), w = Math.max(1.2, (n / 2 - 0.6) * Math.abs(turn));
    const c = n / 2, r = n / 2 - 0.6;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5 - c) / w, v = (y + 0.5 - c) / r;
        if (u * u + v * v > 1) continue;
        const [diff, spec] = lit(u * 0.7, v * 0.7, Math.sqrt(Math.max(0, 1 - 0.49 * (u * u + v * v))));
        const rim = u * u + v * v > 0.62;
        const star = Math.abs(turn) > 0.5 && !rim && starAt(u * Math.sign(turn), v);
        const base = star ? hex("#fff1a8") : rim ? hex("#e0a020") : hex("#ffc93a");
        px(s, x, y, mix(shade(base, 0.6 + diff * 0.7), 0xffffffff, spec * 0.8));
      }
    }
    outline(s, hex("#6b4500"));
    return { sprite: s, height: 0.9, solid: false };
  });
}

/** Whether (u, v), in -1..1, is on a small five-point star. */
function starAt(u: number, v: number): boolean {
  const a = Math.atan2(v, u) + Math.PI / 2, d = Math.hypot(u, v);
  const r = 0.28 + 0.2 * Math.max(0, Math.cos(((a % ((2 * Math.PI) / 5)) - Math.PI / 5) * 5) ** 3);
  return d < r * 1.25;
}

/** The grabber: a steel snapping trap on an arm, its two jaws lined with teeth round a dark
 * mouth, red lamps for eyes; frame 0 half open, frame 1 wide open, frame 2 snapped shut. */
export function grabberFrames(k = 1): SceneryArt[] {
  const W = Math.round(20 * k), Hh = Math.round(20 * k);
  return [0.55, 1, 0].map((open) => {
    const s = makeSprite(W, Hh);
    const cx = W / 2, cy = Hh * 0.5, gap = open * 5 * k, jw = 8 * k, jh = 5 * k;
    rod(s, cx, Hh - 0.5, cx, cy + gap / 2 + 2 * k, () => 1.5 * k, () => hex("#7a808c")); // the arm
    if (gap > 0.5) rect(s, Math.round(cx - jw * 0.8), Math.round(cy - gap / 2), Math.round(cx + jw * 0.8), Math.round(cy + gap / 2) + 1, hex("#4a0d18"));
    for (const half of [-1, 1]) { // the upper jaw (-1) and the lower (+1), each a half shell
      const edge = cy + (half * gap) / 2;
      for (let y = Math.floor(edge - jh - 1); y <= edge + jh + 1; y++) {
        for (let x = Math.floor(cx - jw); x <= cx + jw; x++) {
          const nx = (x + 0.5 - cx) / jw, ny = (y + 0.5 - edge) / jh;
          if (nx * nx + ny * ny > 1 || ny * half < 0) continue;
          const [diff, spec] = lit(nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)));
          const stripe = Math.abs(ny) > 0.5 && Math.abs(ny) < 0.68;
          px(s, x, y, mix(shade(stripe ? hex("#ffcf3a") : hex("#8d95a3"), 0.5 + diff * 0.75), 0xffffffff, spec * 0.7));
        }
      }
      // teeth along the jaw's edge, pointing across the mouth
      const th = Math.max(1, Math.min(2.2 * k, gap / 2 + 0.5));
      for (let t = -3; t <= 3; t++) {
        const tx = cx + t * jw * 0.24;
        for (let d = 0; d < th; d++) {
          const w = Math.max(0, (th - d) * 0.45);
          for (let x = Math.round(tx - w); x <= Math.round(tx + w); x++) px(s, x, edge - half * (d + 0.5), hex("#f4f2e6"));
        }
      }
    }
    for (const ex of [-0.5, 0.5]) disc(s, cx + ex * jw, cy - gap / 2 - jh * 0.6, 1.1 * k, () => hex("#ff3b2a"));
    outline(s, hex("#1d2028"));
    return { sprite: s, height: 1.2, solid: false };
  });
}

/** The horn: a red canister with a polished bell flaring out of it. */
function hornIcon(k = 1): Sprite {
  const n = Math.round(18 * k);
  const s = makeSprite(n, n);
  rod(s, 2 * k, n * 0.62, n * 0.5, n * 0.62, () => 3.6 * k, (t) => (t < 0.15 ? hex("#3a3d46") : hex("#e0302a")));
  rod(s, n * 0.45, n * 0.62, n - 1, n * 0.32, (t) => (1.2 + 5.2 * t ** 2.2) * k, () => hex("#d8dde6"));
  for (let y = 0; y < 3; y++) px(s, n - 2, n * 0.32 - 1 + y, hex("#ffffff"));
  outline(s, hex("#20232a"));
  return s;
}

/** Static: an old television, its screen a snowstorm, aerials up. */
function staticIcon(k = 1): Sprite {
  const n = Math.round(18 * k);
  const s = makeSprite(n, n);
  const x0 = 1.5 * k, x1 = n - 3 * k, y0 = 5 * k, y1 = n - 1.5 * k, d = 2 * k; // the front face, and its depth
  stroke(s, n / 2, y0, n / 2 - 4 * k, 0.5, 0.45 * k, hex("#c9ccd6"));
  stroke(s, n / 2, y0, n / 2 + 4 * k, 1, 0.45 * k, hex("#c9ccd6"));
  poly(s, [[x0 + d, y0 - d], [x1 + d, y0 - d], [x1, y0], [x0, y0]], () => hex("#b58a5a")); // the top
  poly(s, [[x1, y0], [x1 + d, y0 - d], [x1 + d, y1 - d], [x1, y1]], () => hex("#6b4a2a")); // the side
  rect(s, Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), hex("#8f6a40")); // the front
  let seed = 7;
  for (let y = Math.round(y0 + 1.5 * k); y < y1 - 1.5 * k; y++) {
    for (let x = Math.round(x0 + 1.5 * k); x < x1 - 1.5 * k; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const g = (seed >> 16) & 255;
      px(s, x, y, g > 170 ? 0xffffffff : g > 90 ? hex("#9aa0b0") : hex("#3a3f4c"));
    }
  }
  outline(s, hex("#1d1408"));
  return s;
}

/** The phantom: a pale violet sheet of a ghost, hollow eyes, glowing at its edges. */
function phantomIcon(k = 1): Sprite {
  const n = Math.round(18 * k);
  const s = makeSprite(n, n);
  const cx = n / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5 - cx) / (n * 0.38), v = (y + 0.5) / n;
      const body = v < 0.45 ? u * u + ((v - 0.45) / 0.4) ** 2 <= 1 : Math.abs(u) <= 1 &&
        v < 0.92 - 0.08 * Math.max(0, Math.sin((u + 1) * Math.PI * 1.5));
      if (!body) continue;
      const [diff] = lit(u * 0.8, (v - 0.45) * 0.8, 0.6);
      px(s, x, y, shade(mix(hex("#d8c8ff"), hex("#9b7bff"), Math.abs(u) * 0.6), 0.65 + diff * 0.6));
    }
  }
  for (const ex of [-0.38, 0.38]) disc(s, cx + ex * n * 0.38, n * 0.4, 1.3 * k, () => hex("#2a1a5a"));
  outline(s, hex("#4a2a9a"));
  return s;
}

/** The jackpot: a gold medal with an 8 on it and eight gems round its rim. */
function jackpotIcon(k = 1): Sprite {
  const n = Math.round(18 * k), c = n / 2;
  const s = makeSprite(n, n);
  ball(s, c, c, n / 2 - 1, (u, v) => (Math.hypot(u, v) > 0.8 ? hex("#e0a020") : hex("#ffc93a")), 0, 0.55);
  const gems = ["#ff5fa2", "#5dff7a", "#63c8ff", "#ffffff", "#c79bff", "#ff8a1f", "#3a6fd8", "#ffd23f"].map(hex);
  for (let j = 0; j < 8; j++) {
    const a = (j / 8) * Math.PI * 2;
    disc(s, c + Math.cos(a) * (n / 2 - 2.6 * k), c + Math.sin(a) * (n / 2 - 2.6 * k), 0.9 * k, () => gems[j]);
  }
  for (const [oy, r] of [[-1.9, 1.7], [2, 2]]) { // the 8: two rings
    for (let a = 0; a < 40; a++) {
      const t = (a / 40) * Math.PI * 2;
      px(s, c + Math.cos(t) * r * k, c + oy * k + Math.sin(t) * r * k, hex("#5a3a00"));
    }
  }
  outline(s, hex("#6b4500"));
  return s;
}

/** Three of an item, one on top of two, for the HUD (a triple oil, puck or orb). */
function threeOf(item: Sprite, n: number): Sprite {
  const s = makeSprite(n, n);
  for (const [fx, fy] of [[0.5, 0.05], [0.2, 0.45], [0.8, 0.45]]) {
    const ox = Math.round(fx * n - item.w / 2), oy = Math.round(fy * n);
    for (let y = 0; y < item.h; y++) for (let x = 0; x < item.w; x++) {
      const c = item.data[y * item.w + x];
      if (c) px(s, ox + x, oy + y, c);
    }
  }
  return s;
}

/** A turbo cell, gilded: the gold turbo. */
function goldCell(k = 1): Sprite {
  const s = turboCell(k);
  for (let i = 0; i < s.data.length; i++) {
    const c = s.data[i];
    if (!c || c === 0xffffffff) continue;
    const [r, g, b] = [c & 255, (c >> 8) & 255, (c >> 16) & 255];
    if (r > 150 && g < 160 && b < 90) s.data[i] = mix(c, hex("#ffd23f"), 0.75); // the orange body turns gold
  }
  return s;
}

type Icons = Record<"turbo" | "triple" | "gold" | "oil" | "oil3" | "puck" | "puck3" | "orb" | "orb3" | "comet" | "bomb" |
  "rocket" | "static" | "shock" | "prism" | "flares" | "boomerang" | "grabber" | "horn" | "jackpot" | "coin" | "phantom",
  Sprite>;

/** The item slot's icons, drawn big enough to show pixel for pixel in the HUD (about 28 px). */
export function itemIcons(): Icons {
  return {
    turbo: turboCell(1.55), triple: tripleIcon(1.6), gold: goldCell(1.55), oil: oilIcon(1.5),
    oil3: threeOf(oilBarrel(0.8), 29), puck: puckFrames(1.55)[0].sprite, puck3: threeOf(puckFrames(0.85)[0].sprite, 29),
    orb: orbArt(1.4).sprite, orb3: threeOf(orbArt(0.62).sprite, 29), comet: cometArt(1.3).sprite,
    bomb: bombFrames(1.12)[0].sprite, rocket: rocketIcon(1.6), static: staticIcon(1.6), shock: shockIcon(1.6),
    prism: prismIcon(1.6), flares: flareFrames(1.8)[0].sprite, boomerang: boomerangFrames(1.12)[1].sprite,
    grabber: grabberFrames(1.4)[0].sprite, horn: hornIcon(1.6), jackpot: jackpotIcon(1.6), coin: coinFrames(2)[0].sprite,
    phantom: phantomIcon(1.6),
  };
}

/** What a kart carries over its driver's head (and holds out behind it, or circling it). */
export function heldArt(): Record<keyof Icons, SceneryArt> {
  const art = (sprite: Sprite, height = 0.85): SceneryArt => ({ sprite, height, solid: false });
  const puck = puckFrames()[0].sprite, orb = orbArt().sprite;
  return {
    turbo: art(turboCell()), triple: art(turboCell()), gold: art(goldCell()), oil: art(oilBarrel(), 0.95),
    oil3: art(oilBarrel(), 0.95), puck: art(puck, 0.55), puck3: art(puck, 0.55), orb: art(orb, 0.9), orb3: art(orb, 0.9),
    comet: art(cometArt().sprite, 0.95), bomb: art(bombFrames()[0].sprite, 0.95), rocket: art(rocketIcon(), 0.95),
    static: art(staticIcon()), shock: art(shockIcon()), prism: art(prismIcon()), flares: art(flareFrames()[0].sprite),
    boomerang: art(boomerangFrames()[1].sprite, 0.9), grabber: art(grabberFrames()[0].sprite, 0.9), horn: art(hornIcon()),
    jackpot: art(jackpotIcon()), coin: art(coinFrames()[0].sprite, 0.7), phantom: art(phantomIcon(), 0.9),
  };
}

/** A concrete bridge pillar ``height`` meters tall. */
export function pillar(height: number): SceneryArt {
  const h = Math.max(6, Math.round(height * 8)), w = 12;
  const s = makeSprite(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const light = x < 4 ? 1.08 : x > 8 ? 0.78 : 0.95; // lit face, shaded face
      const band = y % 16 < 1 ? 0.88 : 1; // formwork lines
      px(s, x, y, shade(hex("#b8b4a8"), light * band));
    }
  }
  rect(s, 0, 0, w, 3, hex("#8f8b80")); // cap
  outline(s, hex("#3b3a36"));
  return { sprite: s, height, solid: true };
}
