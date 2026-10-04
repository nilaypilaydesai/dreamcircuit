// The neon tunnel's tube. The road runs inside it: a flat floor as wide as any road, walls that
// curve up in half circles to a flat ceiling, the whole way round. A kart's offset (m left of the
// centerline, as everywhere) is how far round the tube it has gone from the middle of the floor:
// past the floor's edge it is up a wall, past the wall it is on the ceiling, and on round it
// comes down the other wall. So the race goes on in the usual flat terms (the tube unrolled into
// a road 54 m wide whose edges are one and the same line, the middle of the ceiling), and only
// drawing it bends it round.
//
// Up the walls a kart is held on by its speed: below TUBE_WALL_SPEED it slides back down to the
// floor, and on the upper half of the tube it needs TUBE_LOOP_SPEED to stay on, or it peels off
// and slides back down fast. Fast enough, it can go right round over the ceiling.

import { HALF_WIDTH, type Track } from "./track";

export const TUBE_FLOOR = HALF_WIDTH; // m: half the floor's width (and the ceiling's)
export const TUBE_R = 4.5; // m: the walls' radius (the tube is 9 m tall)
export const TUBE_ROUND = 4 * TUBE_FLOOR + 2 * Math.PI * TUBE_R; // m once round
export const TUBE_HALF = TUBE_ROUND / 2;
export const TUBE_WALL_SPEED = 12; // m/s to hold onto a wall
export const TUBE_LOOP_SPEED = 22.5; // m/s to hold onto the ceiling (and so to loop the tube)
const WALL_END = TUBE_FLOOR + Math.PI * TUBE_R; // m round from the floor's middle to the ceiling

/** ``u`` m round the tube, folded into (-TUBE_HALF, TUBE_HALF]. */
export const wrapTube = (u: number): number => {
  if (u > -TUBE_HALF && u <= TUBE_HALF) return u;
  const v = (((u + TUBE_HALF) % TUBE_ROUND) + TUBE_ROUND) % TUBE_ROUND - TUBE_HALF;
  return v === -TUBE_HALF ? TUBE_HALF : v;
};

/** Where the point ``u`` m round the tube is: ``lat`` m left of the centerline and ``z`` m over the
 * floor, and ``tilt``, how far its surface is turned from facing up (radians: π/2 up the left wall,
 * where it faces right; ±π on the ceiling, facing down). */
export function tubeAt(u: number): { lat: number; z: number; tilt: number } {
  u = wrapTube(u);
  const a = Math.abs(u), sg = u < 0 ? -1 : 1;
  if (a <= TUBE_FLOOR) return { lat: u, z: 0, tilt: 0 };
  if (a <= WALL_END) {
    const al = (a - TUBE_FLOOR) / TUBE_R;
    return { lat: sg * (TUBE_FLOOR + TUBE_R * Math.sin(al)), z: TUBE_R - TUBE_R * Math.cos(al), tilt: sg * al };
  }
  return { lat: sg * (TUBE_FLOOR - (a - WALL_END)), z: 2 * TUBE_R, tilt: sg * Math.PI };
}

/** How far the race's flat terms carry the road's length ``u`` m out from its middle by road point
 * i, for every meter of the middle: 1 on a straight, more round the outside of a bend, less round
 * the inside, and nothing or less where the inside of a bend tighter than that folds them over. */
export function flatStretch(track: Track, i: number, u: number): number {
  const j = track.wrap(i + 1);
  if (j === i) return 1;
  const [ax, ay] = track.tangent(i), [bx, by] = track.tangent(j), gap = track.between(i, j);
  if (gap <= 0) return 1;
  const dx = track.xs[j] - by * u - (track.xs[i] - ay * u), dy = track.ys[j] + bx * u - (track.ys[i] + ax * u);
  return (dx * ax + dy * ay) / gap;
}

/** How much further a kart ``u`` m round the tube by road point i moves along the road in the
 * race's flat terms than it really goes along the tube. 1 on the floor, where the two are the
 * same; but on a bend the flat terms stretch the road's length away from its middle (more round
 * the outside, less round the inside), and up the walls and over the ceiling the tube itself is
 * nowhere near that far from the middle, so unmeasured a kart up there sped up or slowed to a
 * crawl through every bend, two and a half times over on a ceiling. */
export function tubeStretch(track: Track, i: number, u: number): number {
  const lat = tubeAt(u).lat;
  if (lat === u) return 1;
  const real = flatStretch(track, i, lat);
  return real > 1e-6 ? Math.max(TUBE_SQUEEZE / 2, flatStretch(track, i, u)) / real : 1;
}

/** Where the flat terms carry the road's length less than this far up a wall or over the ceiling
 * (round the inside of a tight bend, near where they fold over), a kart cannot hold on there and
 * slides back down: in the folds, a kart on the ceiling jumped about the tube. */
export const TUBE_SQUEEZE = 0.3;

/** The speed a kart needs to stay where it is on the tube (0 on the floor): a little up a wall,
 * more higher up, and TUBE_LOOP_SPEED anywhere on the upper half. */
export function holdSpeed(u: number): number {
  const t = Math.abs(tubeAt(u).tilt);
  if (t < 0.12) return 0;
  return t > Math.PI / 2 ? TUBE_LOOP_SPEED : TUBE_WALL_SPEED * (t / (Math.PI / 2));
}
