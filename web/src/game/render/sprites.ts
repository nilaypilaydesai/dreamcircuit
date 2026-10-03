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

/** Bake a voxel model into 16 view sprites; view k shows it from angle 2*pi*k/16 behind. */
export function bakeVoxels(vox: Map<number, number>, cx = 11.5): Sprite[] {
  const vs = litVoxels(vox, cx);
  const sprites: Sprite[] = [];
  for (let v = 0; v < KART_VIEWS; v++) {
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

const baked = new Map<string, Sprite[]>();

/** A kart's 16 views, baked once per build and driver. */
export function kartSprites(build: Build, livery: KartLivery, rocket = false): Sprite[] {
  const key = `${rocket ? "R" : "K"}|${build.body}|${build.wheels}|${build.spoiler}|${build.exhaust}|${build.paint}|${build.accent}|${livery.helmet}|${livery.suit}`;
  let s = baked.get(key);
  if (!s) {
    if (baked.size > 80) baked.clear();
    s = rocket ? bakeVoxels(rocketModel(build, livery), 10) : bakeVoxels(kartModel(build, livery));
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

function turboIcon(): Sprite {
  const s = makeSprite(16, 16);
  for (let k = 0; k < 2; k++) {
    for (let y = 0; y < 12; y++) {
      const x = 3 + k * 6 + (y < 6 ? y : 11 - y) / 1.5;
      rect(s, Math.round(x), 2 + y, Math.round(x) + 3, 3 + y, k ? hex("#ffd23f") : hex("#ff7a1a"));
    }
  }
  outline(s, hex("#2a1408"));
  return s;
}

/** A turbo cell: an orange capsule with a white chevron (what a kart carries for a turbo). */
function turboCell(): Sprite {
  const s = makeSprite(12, 15);
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 12; x++) {
      const corner = (x < 2 || x > 9) && (y < 2 || y > 12);
      if (!corner) px(s, x, y, x < 4 ? hex("#ffa24a") : x > 8 ? hex("#d9580a") : hex("#ff7a1a"));
    }
  }
  for (let k = 0; k < 2; k++) {
    for (let y = 0; y < 6; y++) {
      const x = 3 + (y < 3 ? y : 5 - y) + k * 3;
      px(s, x, 4 + y, 0xffffffff);
      px(s, x + 1, 4 + y, 0xffffffff);
    }
  }
  outline(s, hex("#3a1606"));
  return s;
}

/** Three little turbo cells. */
function tripleIcon(): Sprite {
  const s = makeSprite(16, 16);
  for (const [ox, oy] of [[5, 1], [1, 7], [9, 7]]) {
    rect(s, ox, oy, ox + 6, oy + 8, hex("#ff7a1a"));
    rect(s, ox, oy, ox + 2, oy + 8, hex("#ffa24a"));
    px(s, ox + 2, oy + 2, 0xffffffff);
    px(s, ox + 3, oy + 3, 0xffffffff);
    px(s, ox + 2, oy + 4, 0xffffffff);
  }
  outline(s, hex("#3a1606"));
  return s;
}

function oilIcon(): Sprite {
  const s = makeSprite(16, 16);
  disc(s, 7.5, 9.5, 5, () => hex("#14121c"));
  for (let y = 2; y < 7; y++) rect(s, 8 - Math.floor((y - 1) / 2), y, 8 + Math.ceil((y - 1) / 2), y + 1, hex("#14121c"));
  [hex("#ff5fa2"), hex("#ffd23f"), hex("#63c8ff")].forEach((c, k) => px(s, 5 + k, 8, c));
  outline(s, hex("#d9e1ea"));
  return s;
}

/** An oil barrel: what a kart holds out behind it before the slick is poured. */
function oilBarrel(): Sprite {
  const s = makeSprite(12, 15);
  for (let y = 1; y < 15; y++) {
    for (let x = 1; x < 11; x++) {
      const ring = y === 4 || y === 10;
      px(s, x, y, ring ? hex("#8b93a8") : x < 4 ? hex("#2f3a66") : x > 8 ? hex("#141a33") : hex("#202a52"));
    }
  }
  rect(s, 2, 0, 10, 1, hex("#5a6288"));
  [hex("#ff5fa2"), hex("#ffd23f"), hex("#63c8ff")].forEach((c, k) => px(s, 5 + k, 7, c));
  outline(s, hex("#0a0d1c"));
  return s;
}

/** A boomerang, spinning: four frames a quarter turn apart. */
export function boomerangFrames(): SceneryArt[] {
  return [0, 1, 2, 3].map((f) => {
    const s = makeSprite(18, 18);
    const a = (f / 4) * Math.PI * 2;
    const arm = (ang: number, c: number) => stroke(s, 9, 9, 9 + Math.cos(ang) * 7, 9 + Math.sin(ang) * 7, 1.6, c);
    arm(a, hex("#1fb5a8"));
    arm(a + 1.75, hex("#1fb5a8"));
    stroke(s, 9, 9, 9 + Math.cos(a) * 6, 9 + Math.sin(a) * 6, 0.6, hex("#a8fff4"));
    stroke(s, 9, 9, 9 + Math.cos(a + 1.75) * 6, 9 + Math.sin(a + 1.75) * 6, 0.6, hex("#ffd23f"));
    outline(s, hex("#083b37"));
    return { sprite: s, height: 0.9, solid: false };
  });
}

/** A round bomb with a lit fuse (two frames: the spark flickers). */
export function bombFrames(): SceneryArt[] {
  return [0, 1].map((f) => {
    const s = makeSprite(16, 18);
    disc(s, 7.5, 10.5, 6.5, (x, y) => (Math.hypot(x - 5.5, y - 8) < 2 ? hex("#6b6b80") : hex("#23232c")));
    rect(s, 5, 2, 10, 4, hex("#8a8d99"));
    for (let k = 0; k < 4; k++) px(s, 10 + k, 1 - (k > 1 ? 1 : 0) + 2, hex("#c9a46b"));
    disc(s, 13.5, 1.5, f ? 1.6 : 1.1, () => (f ? 0xffffffff : hex("#ffd23f")));
    if (f) { px(s, 15, 0, hex("#ff8a1f")); px(s, 12, 0, hex("#ff8a1f")); }
    outline(s, hex("#0b0b10"));
    return { sprite: s, height: 1.0, solid: false };
  });
}

/** An explosion: a white flash that blooms into fire and drifts off as smoke. */
export function blastFrames(): SceneryArt[] {
  return [0, 1, 2, 3, 4, 5].map((f) => {
    const s = makeSprite(40, 36);
    const rng = new Rand(17 + f);
    const r = 5 + f * 3;
    const t = f / 5;
    disc(s, 20, 20, r, (x, y) => {
      const d = Math.hypot(x - 20, y - 20) / r;
      if (t > 0.55 && rng.next() < (t - 0.5) * 0.9) return 0; // breaking up
      return t < 0.25
        ? (d < 0.6 ? 0xffffffff : hex("#ffe27a"))
        : t < 0.7
          ? (d < 0.4 ? hex("#ffe27a") : d < 0.75 ? hex("#ff8a1f") : hex("#d9381e"))
          : (d < 0.5 ? hex("#8f8a90") : hex("#5d5862"));
    });
    return { sprite: s, height: 3.2, solid: false };
  });
}

/** The prism: a five-point star in shifting rainbow bands. */
function prismIcon(): Sprite {
  const s = makeSprite(16, 16);
  const pts: number[][] = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? 3.2 : 7.4;
    pts.push([8 + Math.cos(a) * r, 8.6 + Math.sin(a) * r]);
  }
  const bands = [hex("#ff5fa2"), hex("#ffd23f"), hex("#5dff7a"), hex("#63c8ff"), hex("#c79bff")];
  poly(s, pts, (x, y) => (Math.hypot(x - 7.5, y - 8) < 2 ? 0xffffffff : bands[Math.floor((x + y) / 3) % bands.length]));
  outline(s, hex("#2b0f5c"));
  return s;
}

/** The shock: a lightning bolt. */
function shockIcon(): Sprite {
  const s = makeSprite(16, 16);
  poly(s, [[9, 0], [3, 9], [7, 9], [5, 16], [13, 6], [9, 6], [12, 0]], (x) => (x < 7 ? hex("#fff6b0") : hex("#ffd23f")));
  outline(s, hex("#3d2a00"));
  return s;
}

/** The rocket, nose up and to the right, flame trailing. */
function rocketIcon(): Sprite {
  const s = makeSprite(16, 16);
  stroke(s, 4, 12, 11, 5, 2.4, hex("#eef0f6"));
  stroke(s, 10, 6, 12.5, 3.5, 1.6, hex("#ff3b4f"));
  disc(s, 8, 8, 1.2, () => hex("#2c3d5c"));
  poly(s, [[2, 9], [5, 9], [3, 6]], () => hex("#ff7a1a"));
  poly(s, [[7, 14], [7, 11], [10, 13]], () => hex("#ff7a1a"));
  disc(s, 2.5, 13.5, 1.6, () => hex("#ffd23f"));
  px(s, 1, 15, hex("#ff8a1f"));
  outline(s, hex("#1d1f2a"));
  return s;
}

/** 16x16 icons for the HUD's item slot. */
export function itemIcons(): Record<"turbo" | "triple" | "oil" | "orb" | "boomerang" | "bomb" | "prism" | "shock" | "rocket", Sprite> {
  const boom = boomerangFrames()[0].sprite, bomb = bombFrames()[0].sprite;
  const fit = (src: Sprite): Sprite => { // a 16x16 copy
    const s = makeSprite(16, 16);
    const ox = Math.floor((16 - src.w) / 2), oy = Math.floor((16 - src.h) / 2);
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const c = src.data[y * src.w + x]; if (c) px(s, x + ox, y + oy, c); }
    return s;
  };
  return {
    turbo: turboIcon(), triple: tripleIcon(), oil: oilIcon(), orb: orbArt().sprite, boomerang: fit(boom),
    bomb: fit(bomb), prism: prismIcon(), shock: shockIcon(), rocket: rocketIcon(),
  };
}

/** What a kart carries out behind it, by item (drawn small, trailing the kart). */
export function heldArt(): Record<"turbo" | "triple" | "oil" | "orb" | "boomerang" | "bomb" | "prism" | "shock" | "rocket", SceneryArt> {
  const icons = itemIcons();
  const art = (sprite: Sprite, height = 0.85): SceneryArt => ({ sprite, height, solid: false });
  return {
    turbo: art(turboCell()), triple: art(turboCell()), oil: art(oilBarrel(), 0.95), orb: orbArt(),
    boomerang: boomerangFrames()[0], bomb: bombFrames()[0], prism: art(icons.prism), shock: art(icons.shock),
    rocket: art(icons.rocket, 0.95),
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
