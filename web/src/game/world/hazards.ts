// What a kart can drive into off the road, in every world, and be fished out of by the rescue
// drone, as from the volcano's lava: a pond in the meadows, a hole in the neon grid, quicksand in
// the desert, a trench in the reef, a crevasse in the mountains, a dug-out pit on the building
// site and a chasm on the moon. Each is an ellipse set out when the lap locks, past the shoulder
// (never on the road), mostly on the outside of the bends, where karts run wide. They are painted
// into the ground (world/texture.ts); a kart on the ground inside one goes in (race/race.ts).

import { hash2, hex, mix, shade, valueNoise } from "../core/gfx";
import { HALF_WIDTH, type Track } from "./track";

export type HazardKind = "pond" | "void" | "quicksand" | "trench" | "crevasse" | "pit" | "chasm";
/** What a kart fell into: a hazard, the lava, or off the edge of raised road. */
export type FallKind = HazardKind | "lava" | "drop";

export interface Hazard {
  kind: HazardKind;
  x: number;
  y: number;
  rx: number; // m: half its length along ``rot`` (the road's direction where it lies)
  ry: number; // m: half its width
  rot: number;
}

/** How far from the road's centerline a hazard keeps: the road, its shoulder and a little more. */
export const HAZARD_CLEAR = HALF_WIDTH + 3.8;
const MAX = 7;
const SIZE: Record<HazardKind, { rx: [number, number]; ry: [number, number] }> = {
  pond: { rx: [7, 12], ry: [4, 7] },
  void: { rx: [5, 9], ry: [4, 6] },
  quicksand: { rx: [6, 10], ry: [4, 7] },
  trench: { rx: [9, 15], ry: [3, 5] },
  crevasse: { rx: [10, 16], ry: [1.6, 2.6] },
  pit: { rx: [5, 9], ry: [4, 6] },
  chasm: { rx: [6, 10], ry: [5, 8] },
};

/** Whether (x, y) is in hazard ``h`` (``margin`` m beyond its edge counts too). */
export function inHazard(h: Hazard, x: number, y: number, margin = 0): boolean {
  const dx = x - h.x, dy = y - h.y, c = Math.cos(h.rot), s = Math.sin(h.rot);
  const u = (dx * c + dy * s) / (h.rx + margin), v = (-dx * s + dy * c) / (h.ry + margin);
  return u * u + v * v < 1;
}

/** Set out up to MAX hazards of ``kind`` beside a locked lap: on the outside of the bends first,
 * each wholly past HAZARD_CLEAR from every road point (``roadDistance``), clear of the start line
 * and of each other. ``next`` is a random number in [0, 1). */
export function placeHazards(track: Track, kind: HazardKind, next: () => number,
                             roadDistance: (x: number, y: number, cap: number) => number): Hazard[] {
  const out: Hazard[] = [];
  const size = SIZE[kind];
  const step = 24; // points between places tried
  const spots: { i: number; bend: number }[] = [];
  for (let i = 0; i < track.count; i += step) {
    if (Math.abs(track.fromStart(i)) < 60) continue;
    spots.push({ i, bend: track.curvature(i) });
  }
  spots.sort((a, b) => Math.abs(b.bend) - Math.abs(a.bend)); // the tightest bends first
  for (const { i, bend } of spots) {
    if (out.length >= MAX) break;
    const rx = size.rx[0] + (size.rx[1] - size.rx[0]) * next(), ry = size.ry[0] + (size.ry[1] - size.ry[0]) * next();
    const side = bend !== 0 ? -Math.sign(bend) : next() < 0.5 ? 1 : -1; // the outside of the bend
    const [tx, ty] = track.tangent(i);
    const off = side * (HAZARD_CLEAR + ry + 0.5 + 3 * next());
    const h: Hazard = { kind, x: track.xs[i] - ty * off, y: track.ys[i] + tx * off, rx, ry, rot: Math.atan2(ty, tx) };
    if (out.some((o) => Math.hypot(o.x - h.x, o.y - h.y) < o.rx + h.rx + 40)) continue;
    // every point of its edge, and its middle, clear of all road
    let clear = roadDistance(h.x, h.y, HAZARD_CLEAR + Math.max(rx, ry) + 1) >= HAZARD_CLEAR + Math.min(rx, ry);
    for (let k = 0; clear && k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, c = Math.cos(h.rot), s = Math.sin(h.rot);
      const u = Math.cos(a) * rx, v = Math.sin(a) * ry;
      clear = roadDistance(h.x + u * c - v * s, h.y + u * s + v * c, HAZARD_CLEAR + 1) >= HAZARD_CLEAR;
    }
    if (clear) out.push(h);
  }
  return out;
}

const C = (s: string) => hex(s);
/** The look of each hazard on the ground at (wx, wy): ``d`` 0 at its middle to 1 at its edge, ``a``
 * the angle around it, ``u``/``v`` across its length and width (m), ``c`` the ground there. */
const LOOKS: Record<HazardKind, (d: number, a: number, u: number, v: number, wx: number, wy: number, c: number) => number> = {
  // still water, deep in the middle, a rim of sand and reeds, rings of ripples and the sky in it
  pond: (d, _a, _u, _v, wx, wy, c) => {
    if (d > 0.9) return hash2(Math.floor(wx * 3), Math.floor(wy * 3), 5) > 0.7 ? C("#5d8a3a") : mix(c, C("#c8b27a"), 0.7);
    const deep = mix(C("#1d4f8c"), C("#3f86c6"), d ** 1.5);
    const ring = Math.abs(((d * 6 + valueNoise(wx, wy, 4, 9) * 0.6) % 1) - 0.5) < 0.05;
    return ring ? shade(deep, 1.25) : deep;
  },
  // a hole in the grid: black, the grid lines sinking into it, a glowing rim
  void: (d, _a, u, v) => {
    if (d > 0.92) return C("#ff2bd6");
    if (d > 0.86) return C("#2de2e6");
    const line = Math.abs((u % 4 + 4) % 4 - 2) > 1.85 || Math.abs((v % 4 + 4) % 4 - 2) > 1.85;
    return line && d > 0.45 ? mix(C("#05010d"), C("#3d1f6b"), (d - 0.45) / 0.45) : C("#05010d");
  },
  // wet sand, darker, turning slowly round its middle
  quicksand: (d, a, _u, _v, wx, wy, c) => {
    if (d > 0.9) return mix(c, C("#e4b46c"), 0.5);
    const swirl = Math.sin(a * 3 + d * 14 + valueNoise(wx, wy, 3, 4) * 2);
    return shade(mix(C("#9c6a3a"), C("#b8834c"), d), 0.92 + 0.1 * swirl);
  },
  // down into the dark blue, a lip of pale sand
  trench: (d, _a, _u, _v, wx, wy, c) => {
    if (d > 0.88) return mix(c, C("#f4e9cf"), 0.45);
    return mix(C("#04101d"), C("#16506e"), d ** 2 + 0.05 * valueNoise(wx, wy, 2, 3));
  },
  // a crack in the snow: white lips, ice blue walls, black depths
  crevasse: (d) => (d > 0.9 ? C("#f6f9ff") : d > 0.62 ? mix(C("#5aa7d8"), C("#bfe6ff"), (d - 0.62) / 0.28) : mix(C("#06101c"), C("#1d4466"), d / 0.62)),
  // a dug-out pit: shoring planks round its lip, striped tape, darkness in it
  pit: (d, a) => {
    if (d > 0.93) return Math.floor((a / (Math.PI * 2)) * 28 + 28) % 2 ? C("#ff8a1f") : C("#f4f1ea");
    if (d > 0.8) return Math.floor((a / (Math.PI * 2)) * 40 + 40) % 2 ? C("#8a5a32") : C("#6e4626");
    return mix(C("#0d0907"), C("#3a2a1c"), d / 0.8);
  },
  // a deep pit in the moon: a bright rim of dust, black within
  chasm: (d, _a, _u, _v, _wx, _wy, c) => (d > 0.88 ? mix(c, C("#e6e7ec"), 0.6) : mix(C("#000000"), C("#2a2b31"), (d / 0.88) ** 3)),
};

/** The colour of the ground at (wx, wy) inside hazard ``h`` (whose ground there is ``c``), or ``c``
 * outside it. */
export function hazardColor(h: Hazard, wx: number, wy: number, c: number): number {
  const dx = wx - h.x, dy = wy - h.y, cs = Math.cos(h.rot), sn = Math.sin(h.rot);
  const u = dx * cs + dy * sn, v = -dx * sn + dy * cs;
  const d = Math.hypot(u / h.rx, v / h.ry);
  if (d >= 1) return c;
  return LOOKS[h.kind](d, Math.atan2(v / h.ry, u / h.rx), u, v, wx, wy, c);
}

/** The colour the screen darkens to as a kart goes in (the drone lifts it out under it). */
export const FALL_TINT: Record<FallKind, number> = {
  lava: hex("#1c0603"), drop: hex("#0b0b14"), pond: hex("#04122a"), trench: hex("#020a14"), quicksand: hex("#1f140a"),
  void: hex("#05010d"), crevasse: hex("#0a1422"), pit: hex("#0b0806"), chasm: hex("#000000"),
};
