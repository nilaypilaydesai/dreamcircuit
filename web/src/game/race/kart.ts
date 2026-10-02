// Arcade kart physics: snappy steering, drifting with mini-turbo boosts, off-road slowdown,
// kart-to-kart bumps and a soft outer fence. Tuned for fun, not for the research simulator.

import { HALF_WIDTH, type Track } from "../world/track";
import type { ItemKind } from "./items";

export type Difficulty = "rookie" | "pro" | "legend";

export interface ClassParams {
  label: string;
  vmax: number; // m/s top speed for everyone in this class
  accel: number;
  grip: number; // m/s^2 of lateral acceleration
  aiSpeed: number; // rivals' straight-line pace relative to vmax
  aiCorner: number; // rivals' cornering commitment
  aiNoise: number; // rivals' steering sloppiness
}

export const CLASSES: Record<Difficulty, ClassParams> = {
  rookie: { label: "ROOKIE", vmax: 24, accel: 9, grip: 19, aiSpeed: 0.84, aiCorner: 0.72, aiNoise: 0.18 },
  pro: { label: "PRO", vmax: 28, accel: 10.5, grip: 22, aiSpeed: 0.93, aiCorner: 0.84, aiNoise: 0.09 },
  legend: { label: "LEGEND", vmax: 32, accel: 12, grip: 25, aiSpeed: 0.99, aiCorner: 0.95, aiNoise: 0.03 },
};

export interface Controls {
  steer: number; // + = left
  throttle: number;
  brake: number;
  drift: boolean;
  item?: boolean; // held: an item fires on the press
}

export type Surface = "road" | "kerb" | "shoulder" | "grass";

export class Kart {
  x = 0;
  y = 0;
  heading = 0;
  v = 0;
  slip = 0; // visual drift angle
  yawRate = 0;
  steer = 0; // smoothed input, also picks the leaning sprite
  idx = 0; // nearest centerline point
  offset = 0;
  surface: Surface = "road";
  drifting = false;
  driftDir = 0;
  driftTime = 0;
  boostTime = 0;
  boostLevel = 0; // 1 = blue sparks, 2 = orange sparks
  bumpTime = 0;
  // items (see items.ts)
  item: ItemKind | null = null;
  roulette = 0; // s left on the player's spinning item slot
  itemAge = 0; // s since the current item arrived
  itemHeld = false; // the item button was down last frame
  spin = 0; // s left in a spin-out
  spinAngle = 0; // the sprite's extra rotation while spinning
  // race bookkeeping
  crossings = 0; // times the start line has been crossed going forward
  dist = 0; // race distance used for positions
  lapStart = 0;
  lapTimes: number[] = [];
  finished = false;
  finishTime = 0;
  place = 0;
  wrongWay = 0;
  private lastFromStart = 0;

  constructor(readonly id: number, readonly name: string, readonly livery: number,
              readonly isPlayer: boolean) {}

  placeOn(track: Track, idx: number, lateral: number): void {
    const [tx, ty] = track.tangent(idx);
    this.x = track.xs[idx] - ty * lateral;
    this.y = track.ys[idx] + tx * lateral;
    this.heading = Math.atan2(ty, tx);
    this.idx = idx;
    this.v = 0;
    this.lastFromStart = track.fromStart(idx);
    this.dist = this.lastFromStart;
  }

  update(dt: number, input: Controls, track: Track, cls: ClassParams): { boosted: boolean } {
    // spun out: no control while the kart slides on, slowing, and the sprite turns
    let c = input;
    if (this.spin > 0) {
      this.spin -= dt;
      this.spinAngle += dt * 13;
      this.v *= Math.exp(-2.2 * dt);
      c = { steer: 0, throttle: 0, brake: 0, drift: false };
      if (this.spin <= 0) this.spinAngle = 0;
    }
    this.idx = track.nearest(this.x, this.y, this.idx);
    this.offset = track.offset(this.x, this.y, this.idx);
    const a = Math.abs(this.offset);
    this.surface = a < HALF_WIDTH - 1.3 ? "road" : a < HALF_WIDTH ? "kerb" : a < HALF_WIDTH + 1.8 ? "shoulder" : "grass";
    const surfaceSpeed = { road: 1, kerb: 0.97, shoulder: 0.82, grass: 0.52 }[this.surface];
    let boosted = false;
    const vmax = cls.vmax * surfaceSpeed * (this.boostTime > 0 ? 1.28 : 1);

    // longitudinal
    if (c.throttle > 0 && this.v >= -0.5) {
      if (this.v < vmax) this.v += cls.accel * c.throttle * (1 - this.v / vmax) * dt * 1.6;
    } else if (c.brake > 0) {
      this.v -= (this.v > 0 ? 22 : 6) * c.brake * dt;
      this.v = Math.max(this.v, -6);
    } else {
      this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), 3.2 * dt);
    }
    if (this.v > vmax) this.v -= (this.v - vmax) * 2.2 * dt; // over the limit (grass, a bump): bleed it off
    if (this.surface === "grass") this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), 5 * dt);
    if (this.boostTime > 0) {
      this.boostTime -= dt;
      this.v = Math.min(this.v + 14 * dt, vmax);
    }

    // steering and drifting
    this.steer += (c.steer - this.steer) * Math.min(1, dt * 9);
    const speed = Math.abs(this.v);
    if (c.drift && !this.drifting && Math.abs(c.steer) > 0.3 && speed > 11 && this.surface !== "grass") {
      this.drifting = true;
      this.driftDir = Math.sign(c.steer);
      this.driftTime = 0;
    }
    if (this.drifting && (!c.drift || speed < 8 || this.surface === "grass")) {
      if (this.driftTime > 0.7) {
        this.boostTime = this.driftTime > 1.6 ? 1.1 : 0.55; // mini-turbo
        boosted = true;
      }
      this.drifting = false;
      this.boostLevel = 0;
    }
    let steerEff = this.steer;
    let yawGain = 1;
    if (this.drifting) {
      this.driftTime += dt;
      this.boostLevel = this.driftTime > 1.6 ? 2 : this.driftTime > 0.7 ? 1 : 0;
      steerEff = this.driftDir * (0.55 + 0.45 * this.steer * this.driftDir);
      yawGain = 1.3;
    }
    const turn = Math.min(1.9, cls.grip / Math.max(speed, 1)) * yawGain;
    this.yawRate = steerEff * turn * Math.min(1, speed / 3.5) * Math.sign(this.v || 1);
    this.heading += this.yawRate * dt;
    const slipTarget = this.drifting ? this.driftDir * 0.32 : 0;
    this.slip += (slipTarget - this.slip) * Math.min(1, dt * 6);
    const dir = this.heading - this.slip * 0.55;
    this.x += Math.cos(dir) * this.v * dt;
    this.y += Math.sin(dir) * this.v * dt;

    // soft outer fence
    if (a > HALF_WIDTH + 17) {
      const [tx, ty] = track.tangent(this.idx);
      const s = Math.sign(this.offset);
      this.x += ty * s * (a - HALF_WIDTH - 17);
      this.y -= tx * s * (a - HALF_WIDTH - 17);
      this.v *= 0.8;
    }
    if (this.bumpTime > 0) this.bumpTime -= dt;
    return { boosted };
  }

  /** Lap bookkeeping from the arc length past the start line. */
  updateProgress(track: Track): boolean {
    const p = track.fromStart(this.idx);
    let crossed = false;
    if (!track.locked) {
      if (this.lastFromStart < 0 && p >= 0) {
        this.crossings = Math.max(this.crossings, 1);
        crossed = true;
      }
      this.dist = p;
    } else {
      const L = track.length;
      const q = ((p % L) + L) % L, q0 = ((this.lastFromStart % L) + L) % L;
      if (q0 > 0.8 * L && q < 0.2 * L) {
        this.crossings += 1;
        crossed = true;
      } else if (q0 < 0.2 * L && q > 0.8 * L && this.crossings > 0) {
        this.crossings -= 1; // backed over the line
      }
      if (this.crossings === 0 && p >= 0 && this.lastFromStart < 0) {
        this.crossings = 1;
        crossed = true;
      }
      this.dist = Math.max(0, this.crossings - 1) * L + (this.crossings === 0 ? q - L : q);
    }
    this.lastFromStart = p;
    // wrong way: driving against the track direction for a while
    const [tx, ty] = track.tangent(this.idx);
    const along = Math.cos(this.heading) * tx + Math.sin(this.heading) * ty;
    this.wrongWay = along < -0.3 && Math.abs(this.v) > 4 ? this.wrongWay + 1 : 0;
    return crossed;
  }
}

/** Resolve kart-kart overlaps with a springy bump. ``vmax`` bounds what a bump can do. */
export function collideKarts(karts: Kart[], vmax = 45): Kart[] {
  const hits: Kart[] = [];
  const R = 1.05;
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i], b = karts[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= 2 * R || d < 1e-6) continue;
      const nx = dx / d, ny = dy / d, push = (2 * R - d) / 2;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      // An impulse along the contact normal, projected onto each kart's heading (karts only
      // change speed along their heading). Without the projection, a side-on pile-up pumps
      // speed into one kart frame after frame, and a kart shoved into reverse runs away.
      const ha = Math.cos(a.heading) * nx + Math.sin(a.heading) * ny;
      const hb = Math.cos(b.heading) * nx + Math.sin(b.heading) * ny;
      const closing = a.v * ha - b.v * hb;
      if (closing > 0) {
        const j = closing * 0.35;
        a.v = Math.max(-8, Math.min(vmax, a.v - j * ha));
        b.v = Math.max(-8, Math.min(vmax, b.v + j * hb));
        a.bumpTime = b.bumpTime = 0.3;
        hits.push(a, b);
      }
    }
  }
  return hits;
}
