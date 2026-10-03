// The land around a circuit, so that the ground is not one flat plane: knolls in the meadows,
// buttes and dunes in the desert, glowing peaks on the neon grid, crags in the mountains, cinder
// cones in the lava, heaps of spoil on the building site, rocks crowned with coral on the reef and
// old crater rims on the moon. Each is a solid of a few dozen faces (render/landforms.ts), set out
// when the circuit locks, always beyond the fence that keeps karts near the road, so nothing ever
// drives into one.

import { HALF_WIDTH } from "./track";

export type LandformKind = "knoll" | "gridpeak" | "butte" | "dune" | "reefrock" | "crag" | "cone" | "spoil" | "rim";

export interface Landform {
  kind: LandformKind;
  x: number;
  y: number;
  r: number; // m: the radius of its foot across
  stretch: number; // its foot is this much longer along ``rot`` than across
  rot: number; // radians
  h: number; // m tall
  seed: number; // for the raggedness of its outline
}

/** How big each kind comes: the radius of its foot and its height (m), and how long it is. */
export const LANDFORM_SIZE: Record<LandformKind, { r: [number, number]; h: [number, number]; stretch: [number, number] }> = {
  knoll: { r: [22, 46], h: [6, 13], stretch: [1, 1.6] },
  gridpeak: { r: [16, 32], h: [16, 32], stretch: [1, 1.15] },
  butte: { r: [14, 28], h: [10, 22], stretch: [1, 1.8] },
  dune: { r: [16, 28], h: [5, 9], stretch: [1.8, 2.6] },
  reefrock: { r: [10, 22], h: [5, 11], stretch: [1, 1.5] },
  crag: { r: [16, 32], h: [10, 22], stretch: [1, 1.5] },
  cone: { r: [12, 22], h: [7, 12], stretch: [1, 1.2] },
  spoil: { r: [8, 15], h: [4, 8], stretch: [1, 1.6] },
  rim: { r: [24, 42], h: [4, 9], stretch: [1, 1.4] },
};

/** How far a landform's foot must stay from the road: past the fence karts cannot cross (17 m out
 * from the road's edge), with a few meters to spare. */
export const LANDFORM_CLEAR = HALF_WIDTH + 20;

/** The farthest its foot reaches from its middle. */
export const reach = (l: Landform): number => l.r * l.stretch;

/** Whether (x, y) is on a landform's foot (with ``margin`` m around it). */
export function onLandform(l: Landform, x: number, y: number, margin = 0): boolean {
  const dx = x - l.x, dy = y - l.y;
  const c = Math.cos(l.rot), s = Math.sin(l.rot);
  const u = (dx * c + dy * s) / (l.r * l.stretch + margin), v = (-dx * s + dy * c) / (l.r + margin);
  return u * u + v * v < 1;
}
