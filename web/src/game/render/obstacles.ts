// Drawing what gets in the way (race/obstacles.ts): cows (walking the way they are going, as the
// camera sees them), tumbleweeds, jellyfish, police cars from the front or behind with their
// lights flashing, the alleys they come out of, geysers (a glowing vent, bubbling before it blows,
// then a column of lava), the tunnel's traffic, a wrecking ball on its cable under a crane's jib,
// and meteors falling at a slant onto the red ring that marks where each will land.

import { hex, mix } from "../core/gfx";
import {
  COW_STARTLED, COW_WALK, GEYSER_BLOW, GEYSER_WARN, METEOR_BURST, METEOR_FALL, METEOR_FALL_TIME, METEOR_HEIGHT, type Obstacles,
  WRECKER_PIVOT,
} from "../race/obstacles";
import { HALF_WIDTH, type Track } from "../world/track";
import type { WorldSprite } from "./billboards";
import type { Camera } from "./mode7";
import { type P3, type Painter, face } from "./poly";
import {
  type SceneryArt, alleyArt, blastFrames, cowFrames, geyserArts, jellyFrames, meteorArts, policeFrames, trafficArt,
  tumbleweedFrames, wreckingBallArt,
} from "./sprites";

const PAINTS = [hex("#d8402e"), hex("#2f80ed"), hex("#f2c94c"), hex("#e8e8ea"), hex("#27ae60"), hex("#9d6bff")];
const CRANE = hex("#e2a72a"), CRANE_DARK = hex("#9a6f18"), CABLE = hex("#1c1d22");

export interface ObstacleArt {
  cow: SceneryArt[];
  tumbleweed: SceneryArt[];
  jelly: SceneryArt[];
  police: { front: SceneryArt[]; rear: SceneryArt[] };
  traffic: SceneryArt[];
  geyser: { vent: SceneryArt; warn: SceneryArt[]; column: SceneryArt[] };
  ball: SceneryArt;
  meteor: { rock: SceneryArt; trail: SceneryArt };
  alley: SceneryArt;
  blast: SceneryArt[];
}

export function obstacleArt(): ObstacleArt {
  return {
    cow: cowFrames(), tumbleweed: tumbleweedFrames(), jelly: jellyFrames(), police: policeFrames(),
    traffic: PAINTS.map(trafficArt), geyser: geyserArts(), ball: wreckingBallArt(), meteor: meteorArts(), alley: alleyArt(),
    blast: blastFrames(2.4),
  };
}

const left = (track: Track, i: number): [number, number] => {
  const [tx, ty] = track.tangent(i);
  return [-ty, tx];
};

/** Sprites for everything in the way, and the alleys police cars come out of. */
export function obstacleSprites(obs: Obstacles, track: Track, cam: Camera, now: number, art: ObstacleArt): WorldSprite[] {
  const out: WorldSprite[] = [];
  const rx = Math.sin(cam.heading), ry = -Math.cos(cam.heading); // the camera's right
  const fx = Math.cos(cam.heading), fy = Math.sin(cam.heading);
  for (const st of obs.sites) {
    if (obs.kind !== "police") break;
    const [lx, ly] = left(track, st.idx), off = st.side * (HALF_WIDTH + 9);
    out.push({ x: track.xs[st.idx] + lx * off, y: track.ys[st.idx] + ly * off, art: art.alley, base: track.elev[st.idx] ?? 0 });
  }
  for (const o of obs.list) {
    const base = track.elev[o.idx] ?? 0;
    switch (o.kind) {
      case "cow": {
        const [lx, ly] = left(track, o.idx), dir = Math.sign(o.target - o.offset) || -o.side;
        const walking = o.state === COW_WALK;
        const frame = o.state === COW_STARTLED ? 2 : walking ? Math.floor(o.phase * 4) % 2 : 0;
        out.push({ x: o.x, y: o.y, art: art.cow[frame], base, flip: (lx * rx + ly * ry) * dir < 0 });
        break;
      }
      case "tumbleweed":
        out.push({ x: o.x, y: o.y, art: art.tumbleweed[Math.floor(o.phase * 10) % 4], base, lift: o.z });
        break;
      case "jelly":
        out.push({ x: o.x, y: o.y, art: art.jelly[Math.floor(o.phase * 5) % 4], base, lift: o.z });
        break;
      case "police": {
        const facing = Math.cos(o.heading) * fx + Math.sin(o.heading) * fy < 0;
        const set = facing ? art.police.front : art.police.rear;
        out.push({ x: o.x, y: o.y, art: set[Math.floor(now * 7) % 2], base: o.z });
        break;
      }
      case "traffic":
        out.push({ x: o.x, y: o.y, art: art.traffic[o.look % art.traffic.length], base, idx: o.idx });
        break;
      case "geyser": {
        const g = art.geyser;
        out.push({ x: o.x, y: o.y, art: o.state === GEYSER_WARN ? g.warn[Math.floor(now * 8) % 2] : g.vent, base, lift: 0.02 });
        if (o.state === GEYSER_BLOW) out.push({ x: o.x, y: o.y, art: g.column[Math.floor(now * 14) % 3], base });
        break;
      }
      case "wrecker": {
        // (not when it swings right through the camera: it filled the screen for a frame)
        const dx = o.x - cam.x, dy = o.y - cam.y, ahead = dx * fx + dy * fy;
        if (!cam.basis && ahead < 2.5 && Math.abs(dx * rx + dy * ry) < 2.5) break;
        out.push({ x: o.x, y: o.y, art: art.ball, base, lift: Math.max(0, o.z - 1.3) });
        break;
      }
      case "meteor": {
        if (o.state === METEOR_FALL) {
          // in at a slant from behind one side: (x, y) is where it will land
          const [lx, ly] = left(track, o.idx), [tx, ty] = track.tangent(o.idx);
          const k = (o.z / METEOR_HEIGHT) * 34;
          const at = (q: number) => [o.x + (lx * o.side * 0.6 - tx * 0.8) * k * q, o.y + (ly * o.side * 0.6 - ty * 0.8) * k * q];
          const [mx, my] = at(1);
          out.push({ x: mx, y: my, art: art.meteor.rock, base, lift: o.z });
          for (let j = 1; j <= 5; j++) {
            const q = 1 + j * 0.07, [qx, qy] = at(q);
            out.push({ x: qx, y: qy, art: art.meteor.trail, base, lift: Math.min(METEOR_HEIGHT, o.z * q + j * 0.8) });
          }
        } else if (o.state === METEOR_BURST) {
          const f = Math.min(art.blast.length - 1, Math.floor((o.t / 0.7) * art.blast.length));
          out.push({ x: o.x, y: o.y, art: art.blast[f], base });
        }
        break;
      }
    }
  }
  return out;
}

/** Faces for what the sprites cannot draw: each wrecking ball's crane (a mast beside the road, a jib
 * out over it, the cable down to the ball), and the ring on the road where each meteor will land. */
export function obstacleFaces(p: Painter, obs: Obstacles, track: Track, now: number): void {
  for (const o of obs.list) {
    const dx = track.xs[o.idx] - p.cam.x, dy = track.ys[o.idx] - p.cam.y;
    if (dx * dx + dy * dy > (p.cam.far + 30) ** 2) continue;
    if (o.kind === "wrecker") crane(p, track, o.idx, o.side, o.offset, o.z);
    else if (o.kind === "meteor" && o.state === METEOR_FALL) ring(p, track, o.idx, o.offset, o.t, now);
  }
}

function crane(p: Painter, track: Track, i: number, side: number, ballOff: number, ballZ: number): void {
  const [tx, ty] = track.tangent(i), [lx, ly] = [-ty, tx];
  const z0 = track.elev[i] ?? 0, mast = side * (HALF_WIDTH + 4.5), top = z0 + WRECKER_PIVOT + 1.6;
  const P = (along: number, off: number, z: number): P3 => [track.xs[i] + tx * along + lx * off, track.ys[i] + ty * along + ly * off, z];
  // the mast: a cross of two lattice slabs, seen from any side
  face(p, [P(-0.6, mast, z0), P(0.6, mast, z0), P(0.6, mast, top), P(-0.6, mast, top)], CRANE, null, 0.05);
  face(p, [P(0, mast - 0.6, z0), P(0, mast + 0.6, z0), P(0, mast + 0.6, top), P(0, mast - 0.6, top)], CRANE_DARK, null, 0.05);
  // the jib, out over the road past its middle, and the pivot the cable hangs from
  const reach = -side * 3.5, jz = z0 + WRECKER_PIVOT + 0.4;
  face(p, [P(0, mast, jz), P(0, reach, jz), P(0, reach, jz + 0.9), P(0, mast, jz + 0.9)], CRANE, null, 0.04);
  face(p, [P(0, mast, jz + 1.3), P(0, reach, jz + 0.9), P(0, reach, jz + 1.05), P(0, mast, jz + 1.45)], CRANE_DARK, null, 0.04);
  // the cable, a thin strip from the pivot to the top of the ball (but not when the camera rides
  // right through it: a few centimeters off, the strip filled half the screen for a frame)
  const pz = z0 + WRECKER_PIVOT, bz = z0 + ballZ + 1.1, cz = p.cam.height;
  const u = Math.max(0, Math.min(1, (pz - cz) / Math.max(0.01, pz - bz))), near = P(0, ballOff * u, cz);
  if (Math.hypot(near[0] - p.cam.x, near[1] - p.cam.y) < 2.5) return;
  face(p, [P(-0.07, 0, pz), P(0.07, 0, pz), P(0.07, ballOff, bz), P(-0.07, ballOff, bz)], CABLE, null, -0.02);
  face(p, [P(0, -0.07, pz), P(0, 0.07, pz), P(0, ballOff + 0.07, bz), P(0, ballOff - 0.07, bz)], CABLE, null, -0.02);
}

/** A red ring on the road, pulsing faster as the meteor nears, drawn as one decal. */
function ring(p: Painter, track: Track, i: number, off: number, t: number, now: number): void {
  const [tx, ty] = track.tangent(i), [lx, ly] = [-ty, tx];
  const cx = track.xs[i] + lx * off, cy = track.ys[i] + ly * off, z = (track.elev[i] ?? 0) + 0.04;
  const urgency = Math.min(1, t / METEOR_FALL_TIME), pulse = 0.5 + 0.5 * Math.sin(now * (8 + 14 * urgency));
  const col = mix(hex("#7a1010"), hex("#ff3a2a"), 0.4 + 0.6 * pulse);
  const from = p.faces.length;
  for (const [r0, r1] of [[2.9, 3.4], [0.9, 1.25]]) {
    for (let k = 0; k < 16; k++) {
      const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
      const Q = (a: number, r: number): P3 => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
      face(p, [Q(a0, r0), Q(a1, r0), Q(a1, r1), Q(a0, r1)], col, [0, 0, 1], 0, 1, true);
    }
  }
  const mine = p.faces.slice(from);
  if (!mine.length) return;
  const depth = Math.max(...mine.map((f) => f.z));
  for (const f of mine) f.z = depth;
}
