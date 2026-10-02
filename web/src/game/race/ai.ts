// Rival drivers. Pure pursuit on a racing line that cuts the inside of corners, a speed profile
// from the curvature ahead, a little sloppiness, simple overtaking room and the classic kart
// racer rubber band: rivals far behind the player find a few percent, rivals far ahead lift.
// Like a human, they drift the tight corners and release on the exit for the mini-turbo.

import { Rand } from "../core/gfx";
import { HALF_WIDTH, type Track } from "../world/track";
import type { ClassParams, Controls, Kart } from "./kart";

export class RivalDriver {
  private lane: number;
  private laneTarget: number;
  private wobble = 0;
  private readonly skill: number;
  private drifting = false;
  private driftSide = 0;
  private driftCooldown = 0; // one "drift this corner?" decision per corner
  private trickTried = false; // one trick attempt per ramp

  constructor(private readonly rng: Rand, readonly kart: Kart, rank: number) {
    this.lane = rng.range(-2.5, 2.5);
    this.laneTarget = this.lane;
    this.skill = 1 - rank * 0.008 + rng.range(-0.01, 0.01); // slight spread across the field
  }

  act(dt: number, track: Track, cls: ClassParams, player: Kart, others: Kart[]): Controls {
    const k = this.kart;
    const v = Math.max(k.v, 0);
    if (this.rng.next() < dt * 0.3) this.laneTarget = this.rng.range(-3, 3);
    // give room to a kart right in front
    for (const o of others) {
      if (o === k) continue;
      const dx = o.x - k.x, dy = o.y - k.y;
      const fwd = dx * Math.cos(k.heading) + dy * Math.sin(k.heading);
      const lat = -dx * Math.sin(k.heading) + dy * Math.cos(k.heading);
      if (fwd > 0 && fwd < 7 && Math.abs(lat) < 2.2) this.laneTarget = lat > 0 ? -3.2 : 3.2;
    }
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * 1.2);

    const look = track.ahead(k.idx, 7 + v * 0.5);
    const kappa = track.curvature(look);
    const line = Math.max(-HALF_WIDTH + 1.5, Math.min(HALF_WIDTH - 1.5,
      this.lane + Math.sign(kappa) * Math.min(2.8, Math.abs(kappa) * 120)));
    const [tx, ty] = track.tangent(look);
    const gx = track.xs[look] - ty * line, gy = track.ys[look] + tx * line;
    const ang = Math.atan2(gy - k.y, gx - k.x) - k.heading;
    const err = Math.atan2(Math.sin(ang), Math.cos(ang));
    this.wobble += (this.rng.range(-1, 1) * cls.aiNoise - this.wobble) * Math.min(1, dt * 2);
    const steer = Math.max(-1, Math.min(1, err * 2.6 + this.wobble));

    // speed: friction-limited corners within braking distance, then the rubber band
    let vt = cls.vmax * cls.aiSpeed * this.skill;
    for (let m = 0; m <= 60; m += 6) {
      const kk = Math.abs(track.curvature(track.ahead(k.idx, m))) + 1e-4;
      const vc = Math.sqrt((cls.grip * cls.aiCorner) / kk);
      vt = Math.min(vt, Math.sqrt(vc * vc + 2 * 14 * m));
    }
    const gap = k.dist - player.dist;
    if (gap < -70) vt *= 1.06;
    else if (gap > 60) vt *= 0.93;
    if (Math.abs(k.offset) > HALF_WIDTH + 2) vt = Math.min(vt, 14);
    const throttle = v < vt ? 1 : 0;
    const brake = v > vt + 2 ? Math.min(1, (v - vt) / 6) : 0;
    return {
      steer, throttle, brake, drift: this.drift(dt, track, cls, steer) || this.trick(cls),
      item: this.wantsItem(track, cls, others),
    };
  }

  /** Hop at a ramp's lip (a tap of the drift button) for a trick, timed by skill. */
  private trick(cls: ClassParams): boolean {
    const k = this.kart;
    if (k.rampU < 0) {
      this.trickTried = false;
      return false;
    }
    if (this.trickTried || k.rampU < 0.9 - 0.12 * this.rng.next()) return false;
    this.trickTried = true;
    return this.rng.next() < 0.35 + 0.55 * cls.aiCorner;
  }

  /** When to fire the item: a turbo on a straight, oil with a kart close behind, an orb with a
   * kart in range ahead; anything held too long gets used. Sharper classes react sooner. */
  private wantsItem(track: Track, cls: ClassParams, others: Kart[]): boolean {
    const k = this.kart;
    if (!k.item || k.spin > 0 || k.finished) return false;
    if (k.itemAge < 1.6 - cls.aiCorner) return false; // reaction time: 0.9 s rookie, 0.65 s legend
    if (k.itemAge > 9) return true;
    if (k.item === "turbo") {
      const straight = [10, 25, 40].every((m) => Math.abs(track.curvature(track.ahead(k.idx, m))) < 1 / 90);
      return straight && k.v > 0.5 * cls.vmax && k.surface === "road";
    }
    let behind = Infinity, ahead = Infinity;
    for (const o of others) {
      if (o === k) continue;
      const gap = o.dist - k.dist;
      if (gap > 0) ahead = Math.min(ahead, gap);
      else behind = Math.min(behind, -gap);
    }
    return k.item === "oil" ? behind > 3 && behind < 28 : ahead > 6 && ahead < 90;
  }

  private drift(dt: number, track: Track, cls: ClassParams, steer: number): boolean {
    const k = this.kart;
    const kappa = track.curvature(track.ahead(k.idx, 3 + Math.max(k.v, 0) * 0.25));
    this.driftCooldown -= dt;
    if (this.drifting) {
      // hold through the corner; let go as it opens up (or if the kart runs wide)
      if (Math.abs(kappa) < 1 / 75 || Math.sign(kappa) !== this.driftSide || k.surface !== "road") {
        this.drifting = false;
      }
    } else if (this.driftCooldown <= 0 && k.v > 16 && Math.abs(kappa) > 1 / 40 &&
               Math.sign(steer) === Math.sign(kappa) && k.surface === "road") {
      this.driftCooldown = 2.5;
      if (this.rng.next() < cls.aiCorner * 0.8) {
        this.drifting = true;
        this.driftSide = Math.sign(kappa);
      }
    }
    return this.drifting;
  }
}
