// Arcade kart physics: snappy steering, drifting with mini-turbo boosts, off-road slowdown,
// kart-to-kart bumps and a soft outer fence; road height (bridges) with guard rails; jumps off
// ramps, with a trick for a well-timed hop; and in the volcano, falling into the lava, out of
// which a drone lifts the kart back onto the road. Tuned for fun, not for the research simulator.

import type { FallKind } from "../world/hazards";
import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import { TUBE_HALF, TUBE_LOOP_SPEED, holdSpeed, wrapTube } from "../world/tube";
import type { ItemKind } from "./odds";
import { type Build, DEFAULT_BUILD, NEUTRAL, type Perf, perfOf, statsOf } from "./parts";

export type Difficulty = "rookie" | "intermediate" | "pro" | "legend";

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
  intermediate: { label: "INTERMEDIATE", vmax: 26, accel: 9.75, grip: 20.5, aiSpeed: 0.885, aiCorner: 0.78, aiNoise: 0.135 },
  pro: { label: "PRO", vmax: 28, accel: 10.5, grip: 22, aiSpeed: 0.93, aiCorner: 0.84, aiNoise: 0.09 },
  legend: { label: "LEGEND", vmax: 32, accel: 12, grip: 25, aiSpeed: 0.99, aiCorner: 0.95, aiNoise: 0.03 },
};

export interface Controls {
  steer: number; // + = left
  throttle: number;
  brake: number;
  drift: boolean;
  item?: boolean; // held: an item fires on the press
  back?: boolean; // held: the item goes out behind the kart on the press (R, the pad's X, BACK)
}

export type Surface = "road" | "kerb" | "shoulder" | "grass" | "air";

export const GRAVITY = 26; // m/s^2: arcade jumps are short and punchy
const TRICK_EARLY = 0.24; // s before the lip a hop still counts as a trick
const TRICK_LATE = 0.18; // s after leaving the lip
const PERFECT = 0.085; // s either side of the lip for a perfect trick
export const SPIN_TIME = 1.0; // s
export const PRISM_SPEED = 1.15; // top speed while invincible
export const ROCKET_SPEED = 1.5; // the rocket's speed, relative to the class top speed
export const REVERSE_SPEED = 7; // m/s backing up (on the road; less on the grass)
export const COIN_SPEED = 0.006; // top speed each coin adds (ten coins: 6%)
export const MAX_COINS = 10;
const REVERSE_ACCEL = 9; // m/s^2
const SHRUNK_SPEED = 0.72; // top speed while shrunk by a shock
// into the lava (the volcano; race.ts decides when): the kart sinks, the screen goes dark while
// a drone lifts it out at the last point it was on the road, lowers it there and lets it go
export const FALL_SINK = 0.55; // s to sink out of sight
export const FALL_SWAP = 0.72; // s: lifted out at the rescue point
export const FALL_RELEASE = 2.0; // s: let go, half a meter up; the driver has control again
export const FALL_END = 2.6; // s: the drone has flown off
export const SINK_DEPTH = 1.8; // m
const CARRY_HIGH = 3.4, CARRY_LOW = 0.55; // m over the road: where the kart is lowered from and let go

export type TrickGrade = 0 | 1 | 2; // none, good, perfect

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
  uses = 0; // shots left in the item (triple turbo, boomerang)
  roulette = 0; // s left on the player's spinning item slot
  itemAge = 0; // s since the current item arrived
  itemHeld = false; // the item button was down last frame
  backHeld = false; // and the back button
  trailing = false; // the item is held out behind the kart (it blocks one hit from behind)
  aim = 0; // rad off the heading where a thrown item will go (the sweeping arrow)
  aimLocked: number | null = null; // the arrow, locked by a first press (the second throws)
  coins = 0; // 0..MAX_COINS, each a little top speed
  gold = 0; // s left of a gold turbo (a boost on every press)
  flares = 0; // s left of flares (a fireball on every press)
  flareCd = 0; // s until the next fireball can be thrown
  grab = 0; // s left with a grabber riding in front
  grabCd = 0; // s until it can bite again
  bite = 0; // s left of a bite (it lunges out)
  phantom = 0; // s left see-through and untouchable
  staticT = 0; // s left with static over the screen (rivals drive half blind)
  jackpot: ItemKind[] = []; // the items of a jackpot still circling the kart, next first
  loot: { item: ItemKind; t: number } | null = null; // an item a phantom stole, on its way (t: s left)
  gravity = GRAVITY; // m/s^2 (low on the moon)
  spin = 0; // s left in a spin-out
  spinAngle = 0; // the sprite's extra rotation while spinning
  prism = 0; // s left invincible (a prism)
  rocket = 0; // s left as a rocket (it drives itself)
  rocketFrom = 0; // the place it was fired from (it burns out after passing a couple of karts)
  private rocketCarry = 0; // m travelled as a rocket that has not yet reached the next road point
  shrink = 0; // s left shrunk by a shock
  fall = -1; // s since the kart went into the lava (-1: it has not; see FALL_*)
  fallKind: FallKind = "lava"; // what it went into: the lava, a hazard, or off the edge of raised road
  fallX = 0; // where it went in (the splash)
  fallY = 0;
  fallZ = 0;
  dropX = 0; // where the drone set it down
  dropY = 0;
  dropZ = 0;
  private safeIdx = 0; // the last road point the kart was on (not the bank, not in the air)
  // the kart's build (garage parts) and what it does to the class's numbers
  build: Build = DEFAULT_BUILD;
  perf: Perf = NEUTRAL;
  // height: the road under the kart (set by the race each frame), and the kart's own
  ground = 0; // m, road surface height here (bridge decks, ramps)
  elev = 0; // m, the kart's height
  vz = 0;
  air = false;
  airTime = 0;
  rampU = -1; // 0..1 while on a jump ramp (set by the race), -1 elsewhere
  slope = 0; // dz/ds of the road under the kart (set by the race)
  bend = 0; // d2z/ds2 of the road under it: how sharply it crests (< 0) or dips (set by the race)
  walled = false; // in a tunnel, between its walls (set by the race)
  tube = false; // racing inside the neon tunnel's tube: its offset is how far round the tube it is (world/tube.ts)
  slipping = false; // in the tube, too slow to hold on where it is: sliding back down the wall
  trick: TrickGrade = 0; // pending: paid out as a boost on landing
  burnout = 0; // s of wheelspin after a too-early start
  trickAngle = 0; // the sprite's extra rotation during a trick
  private hopAge = 9; // s since the hop button was pressed
  private hopHeld = false;
  // race bookkeeping
  crossings = 0; // times the start line has been crossed going forward
  private maxCrossings = 0; // backing over the line and back again must not count a lap twice
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

  /** Fit the kart with a build: its parts set its stats. */
  equip(b: Build): this {
    this.build = b;
    this.perf = perfOf(statsOf(b));
    return this;
  }

  /** A prism or a rocket: nothing can spin the kart, and it spins whatever it touches. */
  get invincible(): boolean {
    return this.prism > 0 || this.rocket > 0;
  }

  /** In the lava or in the rescue drone's hands: out of the race for a moment (nothing hits it,
   * it hits nothing, and it cannot use its item). */
  get falling(): boolean {
    return this.fall >= 0 && this.fall < FALL_RELEASE;
  }

  /** Nothing can touch it right now: a prism, a rocket, a phantom, or the lava. */
  get untouchable(): boolean {
    return this.invincible || this.phantom > 0 || this.falling;
  }

  /** Into the lava (or a hazard, or off the edge of raised road: ``kind``): everything the kart was
   * doing stops. */
  fallIn(kind: FallKind = "lava"): void {
    this.fall = 0;
    this.fallKind = kind;
    this.fallX = this.x;
    this.fallY = this.y;
    this.fallZ = kind === "drop" ? this.elev : this.ground;
    this.v = this.vz = 0;
    this.drifting = false;
    this.boostLevel = this.boostTime = 0;
    this.spin = this.spinAngle = this.trickAngle = 0;
    this.trick = 0;
    this.trailing = false;
  }

  /** Knocked into a spin: it slides on, slowing, with no control for a moment, and three of its
   * coins are gone. Returns false for a kart nothing can touch. */
  spinOut(time = SPIN_TIME): boolean {
    if (this.untouchable) return false;
    this.coins = Math.max(0, this.coins - 3);
    this.spin = Math.max(this.spin, time);
    this.v *= 0.45;
    this.drifting = false;
    this.boostLevel = 0;
    this.boostTime = 0;
    return true;
  }

  /** This kart's top speed in a class, from its build and what it is under right now. */
  topSpeed(cls: ClassParams): number {
    return cls.vmax * this.perf.vmax * (1 + COIN_SPEED * this.coins) * (this.prism > 0 ? PRISM_SPEED : 1) *
      (this.shrink > 0 ? SHRUNK_SPEED : 1);
  }

  placeOn(track: Track, idx: number, lateral: number): void {
    const [tx, ty] = track.tangent(idx);
    this.x = track.xs[idx] - ty * lateral;
    this.y = track.ys[idx] + tx * lateral;
    this.heading = Math.atan2(ty, tx);
    this.idx = this.safeIdx = idx;
    this.v = 0;
    this.ground = this.elev = track.elev[idx] ?? 0;
    this.air = false;
    this.lastFromStart = track.fromStart(idx);
    this.dist = this.lastFromStart;
  }

  /** The sprite's total extra rotation (spin-outs and tricks). */
  get visualSpin(): number {
    return this.spinAngle + this.trickAngle;
  }

  update(dt: number, input: Controls, track: Track, cls: ClassParams):
    { boosted: boolean; landed: TrickGrade | -1 } {
    if (this.prism > 0) this.prism = Math.max(0, this.prism - dt);
    if (this.shrink > 0) this.shrink = Math.max(0, this.shrink - dt);
    if (this.rocket > 0) return this.fly(dt, track, cls);
    if (this.fall >= 0 && this.rescue(dt, track, input)) return { boosted: false, landed: -1 };
    const P = this.perf;
    // spun out: no control while the kart slides on, slowing, and the sprite turns
    let c = input;
    if (this.burnout > 0) {
      this.burnout -= dt;
      c = { ...c, throttle: 0 };
    }
    if (this.spin > 0) {
      this.spin -= dt;
      this.spinAngle += dt * 13;
      this.v *= Math.exp(-2.2 * dt);
      c = { steer: 0, throttle: 0, brake: 0, drift: false };
      if (this.spin <= 0) this.spinAngle = 0;
    }
    this.idx = track.nearest(this.x, this.y, this.idx);
    this.offset = track.offset(this.x, this.y, this.idx);
    if (this.tube && Math.abs(this.offset) > TUBE_HALF) {
      // round over the middle of the ceiling: on round, from the other edge of the unrolled tube
      const [tx, ty] = track.tangent(this.idx), d = wrapTube(this.offset) - this.offset;
      this.x -= ty * d;
      this.y += tx * d;
      this.offset += d;
    }
    const a = Math.abs(this.offset);
    this.surface = this.tube ? "road"
      : a < HALF_WIDTH - 1.3 ? "road" : a < HALF_WIDTH ? "kerb" : a < HALF_WIDTH + 1.8 ? "shoulder" : "grass";
    if (!this.air && this.surface !== "grass") this.safeIdx = this.idx;
    let landed: TrickGrade | -1 = -1;

    // hop button (the drift button) for tricks: a fresh press, timed against the ramp lip
    this.hopAge += dt;
    if (c.drift && !this.hopHeld) this.hopAge = 0;
    this.hopHeld = !!c.drift;

    // height: follow the road, fly off ramp lips, land with the trick's boost
    if (this.air) {
      this.surface = "air";
      this.vz -= this.gravity * dt;
      this.elev += this.vz * dt;
      this.airTime += dt;
      if (this.trick === 0 && this.hopAge === 0 && this.airTime < TRICK_LATE) {
        this.trick = this.airTime < PERFECT ? 2 : 1;
      }
      if (this.trick) this.trickAngle = Math.min(Math.PI * 2, this.trickAngle + dt * 15);
      if (this.elev <= this.ground) {
        this.elev = this.ground;
        this.air = false;
        this.vz = 0;
        landed = this.trick;
        if (this.trick) this.boostTime = Math.max(this.boostTime, this.trick === 2 ? 1.35 : 0.8);
        this.trick = 0;
        this.trickAngle = 0;
      }
    } else if (this.elev - this.ground > 0.3 && this.v > 8) {
      // the road dropped away under a fast kart: the lip of a jump ramp
      this.air = true;
      this.airTime = 0;
      this.vz = Math.max(this.vz, 0) + 4.2 + this.v * 0.11;
      if (this.hopAge < TRICK_EARLY) this.trick = this.hopAge < PERFECT ? 2 : 1;
      this.surface = "air";
    } else if (this.v > 8 && this.rampU < 0 && this.v * this.v * this.bend < -this.gravity) {
      // over a crest faster than gravity can pull the kart down onto the road (only in low
      // gravity, on the moon): it floats off it, carrying the road's climb
      this.air = true;
      this.airTime = 0;
      this.vz = this.v * this.slope;
      this.surface = "air";
    } else {
      this.vz = (this.ground - this.elev) / Math.max(dt, 1e-3); // climbing a ramp: the launch speed
      this.elev = this.ground;
    }
    // guard rails on raised road (no falling off a bridge or a hill), and a tunnel's walls
    if (!this.air && !this.tube && (this.ground > 0.8 || this.walled) && a > HALF_WIDTH - 0.7) {
      const [tx, ty] = track.tangent(this.idx);
      const sgn = Math.sign(this.offset), push = a - (HALF_WIDTH - 0.7);
      this.x += ty * sgn * push;
      this.y -= tx * sgn * push;
      this.offset = sgn * (HALF_WIDTH - 0.7);
      this.v *= 0.97;
      this.bumpTime = 0.2;
      this.surface = "kerb";
    }
    // traction: how much speed the kart keeps on the shoulder and the grass (a prism keeps it all)
    const tr = P.offroad - 1;
    const surfaceSpeed = this.prism > 0 ? 1 : {
      road: 1, kerb: 0.97, shoulder: 0.82 + 0.13 * tr, grass: 0.52 + 0.31 * tr, air: 1,
    }[this.surface];
    let boosted = false;
    const vmax = this.topSpeed(cls) * surfaceSpeed * (this.boostTime > 0 ? 1.28 : 1);
    const accel = cls.accel * P.accel * (this.shrink > 0 ? 0.8 : 1);

    // longitudinal: the brake wins over the gas, and held at a standstill it backs the kart up
    // (slower on the grass, but always: reversing is how a kart gets out of trouble)
    if (c.brake > 0) {
      this.v -= (this.v > 0 ? 22 : REVERSE_ACCEL) * c.brake * dt;
      this.v = Math.max(this.v, -REVERSE_SPEED * Math.max(0.6, surfaceSpeed));
    } else if (c.throttle > 0) {
      if (this.v < 0) this.v = Math.min(0, this.v + 22 * c.throttle * dt); // out of reverse first
      else if (this.v < vmax) this.v += accel * c.throttle * (1 - this.v / vmax) * dt * 1.6;
    } else {
      this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), 3.2 * dt);
    }
    if (this.v > vmax && !this.air) this.v -= (this.v - vmax) * 2.2 * dt; // over the limit: bleed it off
    if (this.surface === "grass" && this.prism <= 0 && this.v > 0) {
      this.v -= Math.min(this.v, (5 / P.offroad) * dt); // the grass drags (going forward)
    }
    if (this.boostTime > 0) {
      this.boostTime -= dt;
      this.v = Math.min(this.v + 14 * dt, vmax);
    }

    // steering and drifting; a better mini-turbo charges sooner and fires for longer
    this.steer += (c.steer - this.steer) * Math.min(1, dt * 9);
    const speed = Math.abs(this.v);
    const charge = (t: number) => t * (0.8 + 0.2 * P.turbo);
    if (c.drift && !this.drifting && !this.air && Math.abs(c.steer) > 0.3 && speed > 11 && this.surface !== "grass") {
      this.drifting = true;
      this.driftDir = Math.sign(c.steer);
      this.driftTime = 0;
    }
    if (this.drifting && (!c.drift || speed < 8 || this.surface === "grass" || this.air)) {
      const ch = charge(this.driftTime);
      if (ch > 0.7) {
        this.boostTime = (ch > 1.6 ? 1.1 : 0.55) * P.turbo; // mini-turbo
        boosted = true;
      }
      this.drifting = false;
      this.boostLevel = 0;
    }
    let steerEff = this.steer;
    let yawGain = 1;
    if (this.drifting) {
      this.driftTime += dt;
      const ch = charge(this.driftTime);
      this.boostLevel = ch > 1.6 ? 2 : ch > 0.7 ? 1 : 0;
      steerEff = this.driftDir * (0.55 + 0.45 * this.steer * this.driftDir);
      yawGain = 1.3;
    }
    const turn = Math.min(1.9 * P.turn, (cls.grip * P.turn) / Math.max(speed, 1)) * yawGain * (this.air ? 0.35 : 1);
    this.yawRate = steerEff * turn * Math.min(1, speed / 3.5) * Math.sign(this.v || 1);
    this.heading += this.yawRate * dt;
    const slipTarget = this.drifting ? this.driftDir * 0.32 : 0;
    this.slip += (slipTarget - this.slip) * Math.min(1, dt * 6);
    const dir = this.heading - this.slip * 0.55;
    this.x += Math.cos(dir) * this.v * dt;
    this.y += Math.sin(dir) * this.v * dt;

    // in the tube, too slow for where it is on the wall: it slides back down toward the floor (fast
    // off the upper half, where it peels off)
    if (this.tube && !this.air) {
      const need = holdSpeed(this.offset), speed = Math.abs(this.v);
      this.slipping = need > 0 && speed < need;
      if (this.slipping) {
        const upper = need >= TUBE_LOOP_SPEED, slide = (upper ? 9 : 3) + (need - speed) * (upper ? 0.6 : 0.5);
        const [tx, ty] = track.tangent(this.idx), d = -Math.sign(this.offset) * Math.min(slide * dt, Math.abs(this.offset));
        this.x -= ty * d;
        this.y += tx * d;
      }
    }
    // soft outer fence
    if (!this.tube && a > HALF_WIDTH + 17) {
      const [tx, ty] = track.tangent(this.idx);
      const s = Math.sign(this.offset);
      this.x += ty * s * (a - HALF_WIDTH - 17);
      this.y -= tx * s * (a - HALF_WIDTH - 17);
      this.v *= 0.8;
    }
    if (this.bumpTime > 0) this.bumpTime -= dt;
    return { boosted, landed };
  }

  /** In the lava: sink, then (in the dark) out at the last road point the kart was on, hanging
   * under the drone as it comes down to the road. Returns false once it is let go (it drops the
   * last half meter and drives on; a fresh hop as it drops is a trick, as off a ramp, but a hop
   * button held all through the rescue is not). */
  private rescue(dt: number, track: Track, input: Controls): boolean {
    this.fall += dt;
    if (this.fall >= FALL_END) this.fall = -1; // the drone has flown off
    if (this.fall < 0 || this.fall >= FALL_RELEASE) return false;
    this.hopAge += dt; // (the hop button is watched all along, as in update)
    if (input.drift && !this.hopHeld) this.hopAge = 0;
    this.hopHeld = !!input.drift;
    this.v = this.vz = 0;
    this.surface = "air";
    if (this.fall < FALL_SWAP) {
      // into the lava (or water, sand, a hole) it sinks out of sight; off raised road it drops
      this.elev = this.fallKind === "drop" ? Math.max(-SINK_DEPTH, this.fallZ - 0.5 * this.gravity * this.fall ** 2)
        : this.ground - SINK_DEPTH * Math.min(1, this.fall / FALL_SINK);
      return true;
    }
    if (this.fall - dt < FALL_SWAP) {
      const i = this.safeIdx;
      const [tx, ty] = track.tangent(i);
      this.x = this.dropX = track.xs[i];
      this.y = this.dropY = track.ys[i];
      this.heading = Math.atan2(ty, tx);
      this.idx = i;
      this.offset = this.slip = this.steer = this.yawRate = 0;
      this.ground = this.dropZ = track.elev[i] ?? 0;
    }
    const u = Math.min(1, (this.fall - FALL_SWAP) / (FALL_RELEASE - FALL_SWAP));
    this.elev = this.ground + CARRY_HIGH + (CARRY_LOW - CARRY_HIGH) * (1 - (1 - u) ** 2);
    if (this.fall + dt >= FALL_RELEASE) { // let go: it drops the rest of the way
      this.air = true;
      this.airTime = 0;
    }
    return true;
  }

  /** As a rocket the kart rides the road itself at rocket speed: along the centerline, easing
   * into the middle, over ramps and bridges at road height (it can neither cut a corner nor fall
   * off a deck), and comes out of it with a boost. */
  private fly(dt: number, track: Track, cls: ClassParams): { boosted: boolean; landed: -1 } {
    this.rocket = Math.max(0, this.rocket - dt);
    this.spin = this.spinAngle = this.trickAngle = 0;
    this.drifting = false;
    this.boostLevel = 0;
    this.v += (cls.vmax * ROCKET_SPEED - this.v) * Math.min(1, dt * 2.5);
    this.rocketCarry += Math.max(0, this.v) * dt;
    const n = Math.floor(this.rocketCarry / SPACING);
    this.rocketCarry -= n * SPACING;
    this.idx = track.wrap(this.idx + n); // (before the lap locks, the road simply ends at the dream)
    this.offset *= Math.exp(-2.5 * dt);
    const [tx, ty] = track.tangent(this.idx);
    this.x = track.xs[this.idx] - ty * this.offset;
    this.y = track.ys[this.idx] + tx * this.offset;
    const d = Math.atan2(Math.sin(Math.atan2(ty, tx) - this.heading), Math.cos(Math.atan2(ty, tx) - this.heading));
    this.heading += d * Math.min(1, dt * 10);
    this.steer += (Math.max(-1, Math.min(1, d * 4)) - this.steer) * Math.min(1, dt * 9);
    this.slip *= Math.exp(-6 * dt);
    this.surface = "road";
    this.air = false;
    this.vz = this.airTime = 0;
    this.trick = 0;
    this.elev = this.ground;
    if (this.rocket <= 0) {
      this.v = Math.min(this.v, this.topSpeed(cls) * 1.2);
      this.boostTime = Math.max(this.boostTime, 0.8);
    }
    return { boosted: false, landed: -1 };
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
    if (crossed) {
      crossed = this.crossings > this.maxCrossings; // only a crossing never reached before
      this.maxCrossings = Math.max(this.maxCrossings, this.crossings);
    }
    // wrong way: driving against the track direction for a while
    const [tx, ty] = track.tangent(this.idx);
    const along = Math.cos(this.heading) * tx + Math.sin(this.heading) * ty;
    this.wrongWay = along < -0.3 && Math.abs(this.v) > 4 ? this.wrongWay + 1 : 0;
    return crossed;
  }
}

/** Resolve kart-kart overlaps with a springy bump in which the heavier kart gives less ground.
 * An invincible kart (prism, rocket) is not moved at all and spins out whoever it touches.
 * ``vmax`` bounds what a bump can do (scaled by each kart's own top speed). Returns the karts
 * that bumped, and the spin-outs as [victim, by] pairs. */
export function collideKarts(karts: Kart[], vmax = 45): { hits: Kart[]; spun: [Kart, Kart][] } {
  const hits: Kart[] = [];
  const spun: [Kart, Kart][] = [];
  const R = 1.05;
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i], b = karts[j];
      if (a.falling || b.falling || a.phantom > 0 || b.phantom > 0) continue; // in the lava, or see-through
      if (Math.abs(a.elev - b.elev) > 1.8) continue; // one on a bridge, one underneath
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= 2 * R || d < 1e-6) continue;
      const nx = dx / d, ny = dy / d, push = (2 * R - d) / 2;
      if ((a.shrink > 0) !== (b.shrink > 0) && !a.invincible && !b.invincible) {
        // a full-size kart runs over one a shock has shrunk: flattened
        const [small, big] = a.shrink > 0 ? [a, b] : [b, a];
        if (small.spinOut(1.0)) spun.push([small, big]);
        continue;
      }
      if (a.invincible !== b.invincible) {
        // a prism or a rocket barges through: the other kart is shoved aside and spun
        const [hard, soft, sgn] = a.invincible ? [a, b, 1] : [b, a, -1];
        soft.x += sgn * nx * push * 2;
        soft.y += sgn * ny * push * 2;
        if (soft.spinOut()) spun.push([soft, hard]);
        continue;
      }
      const ma = a.perf.mass, mb = b.perf.mass;
      const wa = (2 * mb) / (ma + mb), wb = (2 * ma) / (ma + mb); // both 1 for equal weights
      a.x -= nx * push * wa; a.y -= ny * push * wa;
      b.x += nx * push * wb; b.y += ny * push * wb;
      // An impulse along the contact normal, projected onto each kart's heading (karts only
      // change speed along their heading). Without the projection, a side-on pile-up pumps
      // speed into one kart frame after frame, and a kart shoved into reverse runs away.
      const ha = Math.cos(a.heading) * nx + Math.sin(a.heading) * ny;
      const hb = Math.cos(b.heading) * nx + Math.sin(b.heading) * ny;
      const closing = a.v * ha - b.v * hb;
      if (closing > 0) {
        const imp = closing * 0.35;
        a.v = Math.max(-8, Math.min(vmax * a.perf.vmax, a.v - imp * ha * wa));
        b.v = Math.max(-8, Math.min(vmax * b.perf.vmax, b.v + imp * hb * wb));
        a.bumpTime = b.bumpTime = 0.3;
        hits.push(a, b);
      }
    }
  }
  return { hits, spun };
}
