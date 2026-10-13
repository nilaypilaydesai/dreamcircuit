// Rival drivers. Pure pursuit on a racing line that cuts the inside of corners, a speed profile
// from the curvature ahead (each kart's own top speed and cornering, from its build), a little
// sloppiness, simple overtaking room and the classic kart racer rubber band: rivals far behind
// the player find a few percent, rivals far ahead lift. Like a human, they drift the tight
// corners and release on the exit for the mini-turbo, hold oil and orbs out behind them when
// someone is on their tail, aim before they throw (behind them too, at a kart on their tail, when
// there is nobody to hit ahead), save each item for the moment it works best (a horn for when
// something is about to hit them), and drive half blind through static. In the harbor tunnel they
// go for its hover pads, and hovering, ride up its walls on the straights, now and then for a pad up
// there. In the sky they fly: the same racing line across the course, each at its own height over
// it, climbing or diving for a ring ahead, and over or under an airliner crossing.

import { Rand } from "../core/gfx";
import { HALF_WIDTH, type Track } from "../world/track";
import { TUBE_FLOOR, TUBE_R, holdSpeed } from "../world/tube";
import { type AirCourse, type Ring, SKY_LANE } from "./air";
import { PAD_LEN, type Pad } from "./features";
import { AIMED, AIM_MAX, type Items, THROWN_BACK, TRAILS } from "./items";
import type { ClassParams, Controls, Kart } from "./kart";
import type { Danger } from "./obstacles";

const WALL_TOP = TUBE_FLOOR + Math.PI * TUBE_R; // m round the tube to the top of a wall (the roof's pads are the player's)
// s of hover a rival keeps in hand to come back down off a wall: high up one without it, a kart
// falls off (race.ts), and the drone has to fish it off the floor
const DESCENT = 3.2;
// s of hover under which it keeps to the floor (pure pursuit round a tight bend had carried a kart
// dodging at the foot of a wall up the inside of it, and its hover ran out up there)
const SPARE = DESCENT + 0.8;
// Hovering, a rival rides a wall as a player would where the road runs straight for this far ahead
// (m) and bends no tighter than RIDE_BEND m: nearly upright on it, a little higher the sharper the class
const RIDE_AHEAD = 80, RIDE_BEND = 60;

export class RivalDriver {
  private lane: number;
  private laneTarget: number;
  private wobble = 0;
  private readonly skill: number;
  private drifting = false;
  private driftSide = 0;
  private driftCooldown = 0; // one "drift this corner?" decision per corner
  private trickTried = false; // one trick attempt per ramp
  private holding = false; // the item button is held: an item is out behind the kart
  private tapped = false; // the button went down last frame (a press lasts one frame)
  private backTapped = false; // and the back button
  private seek: Pad | null = null; // in the tunnel's tube: the pad it is going for
  private weighed: Pad | null = null; // and the last one it thought about going for
  private ride = 0; // and hovering, the wall it is riding (1 or -1; 0: on the floor)
  private lanes = 3; // m either side of the middle of the road it picks a lane in (more on the tube's wide floor)
  private ring: Ring | null = null; // in the sky: the ring it is flying for
  private weighedRing: Ring | null = null; // and the last one it thought about
  private airDrifting = false; // in the sky: pulled round a tight turn (the drift button)
  private airDriftCd = 0;

  constructor(private readonly rng: Rand, readonly kart: Kart, rank: number) {
    this.lane = rng.range(-2.5, 2.5);
    this.laneTarget = this.lane;
    this.skill = 1 - rank * 0.008 + rng.range(-0.01, 0.01); // slight spread across the field
  }

  /** ``dangers``: what is in the way on the road (race/obstacles.ts), to steer round; ``pads``, the
   * boost pads (in the tunnel's tube, the hover pads are worth going for). */
  act(dt: number, track: Track, cls: ClassParams, player: Kart, others: Kart[], items?: Items,
      dangers: readonly Danger[] = [], pads: readonly Pad[] = [], air?: AirCourse | null): Controls {
    const k = this.kart;
    if (k.plane) return this.fly(dt, track, cls, player, others, items, dangers, air ?? null);
    const v = Math.max(k.v, 0);
    // (the tube's floor is near twice as wide as a road: its lanes are wider apart, and its edge further out)
    const lanes = k.tube ? TUBE_FLOOR - 3 : 3, floor = k.tube ? TUBE_FLOOR : HALF_WIDTH;
    this.lanes = lanes;
    if (this.rng.next() < dt * 0.3) this.laneTarget = this.rng.range(-lanes, lanes);
    // give room to a kart right in front
    for (const o of others) {
      if (o === k) continue;
      const dx = o.x - k.x, dy = o.y - k.y;
      const fwd = dx * Math.cos(k.heading) + dy * Math.sin(k.heading);
      const lat = -dx * Math.sin(k.heading) + dy * Math.cos(k.heading);
      if (fwd > 0 && fwd < 7 && Math.abs(lat) < 2.2) this.laneTarget = lat > 0 ? -3.2 : 3.2;
    }
    // and to anything in the way (a cow, a geyser, the ring where a meteor will land), more the
    // sharper the class: a lane on the far side of it, from far enough off to make it
    const seen = 18 + 40 * cls.aiCorner;
    const spare = k.tube && k.hover > SPARE; // (hovering in the tube, with hover to spare)
    let dodging = false;
    for (const o of dangers) {
      const dx = o.x - k.x, dy = o.y - k.y;
      const fwd = dx * Math.cos(k.heading) + dy * Math.sin(k.heading);
      const lat = -dx * Math.sin(k.heading) + dy * Math.cos(k.heading);
      if (fwd > 0 && fwd < seen && Math.abs(lat) < o.r + 1.6) {
        // (in the tube, with hover to spare, the foot of a wall will do)
        const room = spare ? TUBE_FLOOR + 2.5 : floor - 1.4;
        this.laneTarget = Math.max(-room, Math.min(room, k.offset + (lat > 0 ? -1 : 1) * (o.r + 2.4)));
        dodging = true;
      }
    }
    const reach = k.tube && !dodging ? this.padLane(track, cls, pads) : null;
    const ride = k.tube && !dodging && reach === null ? this.wallRide(dt, track, cls) : null;
    if (dodging) this.seek = null;
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * 1.2);

    const look = track.ahead(k.idx, 7 + v * 0.5);
    const kappa = track.curvature(look);
    // (in the tube without hover, its walls are walls; with hover to spare, the foot of a wall will
    // do, and up to a pad it is going for or the height it rides a wall at)
    const up = reach ?? ride;
    const edge = up !== null ? Math.max(floor - 1.5, Math.abs(up) + 0.5)
      : spare ? TUBE_FLOOR + 2.5 : floor - 1.5;
    const line = Math.max(-edge, Math.min(edge, this.lane + Math.sign(kappa) * Math.min(2.8, Math.abs(kappa) * 120)));
    const [tx, ty] = track.tangent(look);
    const gx = track.xs[look] - ty * line, gy = track.ys[look] + tx * line;
    const ang = Math.atan2(gy - k.y, gx - k.x) - k.heading;
    const err = Math.atan2(Math.sin(ang), Math.cos(ang));
    const blind = k.staticT > 0 ? 4 : 1; // static over the screen: a much sloppier line
    this.wobble += (this.rng.range(-1, 1) * cls.aiNoise * blind - this.wobble) * Math.min(1, dt * 2);
    const steer = Math.max(-1, Math.min(1, err * 2.6 + this.wobble));

    // speed: friction-limited corners within braking distance, then the rubber band
    let vt = k.topSpeed(cls) * cls.aiSpeed * this.skill;
    const grip = cls.grip * k.perf.turn * cls.aiCorner;
    for (let m = 0; m <= 60; m += 6) {
      const kk = Math.abs(track.curvature(track.ahead(k.idx, m))) + 1e-4;
      const vc = Math.sqrt(grip / kk);
      vt = Math.min(vt, Math.sqrt(vc * vc + 2 * 14 * m));
    }
    const gap = k.dist - player.dist;
    if (gap < -70) vt *= 1.06;
    else if (gap > 60) vt *= 0.93;
    if (Math.abs(k.offset) > HALF_WIDTH + 2 && !k.tube) vt = Math.min(vt, 14);
    if (k.staticT > 0) vt *= 0.93;
    const throttle = v < vt ? 1 : 0;
    const brake = v > vt + 2 ? Math.min(1, (v - vt) / 6) : 0;
    return {
      steer, throttle, brake, drift: this.drift(dt, track, cls, steer), hop: this.trick(cls),
      item: this.itemButton(track, cls, others, items),
      back: this.backButton(cls, others),
    };
  }

  /** In the tunnel's tube, where across it the pad worth going for is (null: none): a hover pad
   * ahead for a kart without hover (or with it running out), and for a hovering kart going fast
   * enough to hold on there, now and then a pad up a wall. */
  private padLane(track: Track, cls: ClassParams, pads: readonly Pad[]): number | null {
    const k = this.kart, s = track.s[k.idx], v = Math.max(k.v, 0);
    const p = this.seek;
    if (p) {
      // (gone past it, or it can no longer hold on up there, or its hover is running out: back down
      // to the floor)
      const lost = !p.hover && Math.abs(p.offset) >= TUBE_FLOOR && (k.hover < DESCENT || v < holdSpeed(p.offset) + 1);
      if (s > p.s0 + PAD_LEN || s < p.s0 - 90 || lost) {
        this.seek = null;
        this.laneTarget = this.rng.range(-this.lanes, this.lanes);
        return null;
      }
      this.laneTarget = p.offset;
      return p.offset;
    }
    for (const q of pads) {
      const d = q.s0 - s;
      if (d < 12 || d > 70 || q === this.weighed) continue;
      // (a hover pad when its hover is low or gone; a plain pad on the floor, any time; one up a wall
      // with hover enough to get there and back down)
      const want = q.hover ? k.hover < 2.5 : Math.abs(q.offset) < TUBE_FLOOR ? true
        : Math.abs(q.offset) < WALL_TOP && k.hover > d / Math.max(v, 1) + DESCENT + 0.5 && v > holdSpeed(q.offset) + 3;
      if (!want) continue;
      this.weighed = q;
      if (this.rng.next() > (q.hover ? 0.85 : 0.3 + 0.5 * cls.aiCorner)) continue;
      this.seek = q;
      this.laneTarget = q.offset;
      return q.offset;
    }
    return null;
  }

  /** In the tunnel's tube, hovering, where the road runs straight: how far round the tube it rides up
   * a wall (null: on the floor). Back down before a bend, before it is too slow to hold on up there,
   * and while its hover still lasts to come down. */
  private wallRide(dt: number, track: Track, cls: ClassParams): number | null {
    const k = this.kart, v = Math.max(k.v, 0);
    const high = TUBE_FLOOR + TUBE_R * (0.75 + 0.75 * cls.aiCorner); // (77 to 85 degrees up)
    let straight = true;
    for (let m = 10; m <= RIDE_AHEAD && straight; m += 10) {
      straight = Math.abs(track.curvature(track.ahead(k.idx, m))) < 1 / RIDE_BEND;
    }
    if (!straight || k.hover < SPARE || v < holdSpeed(high) + 3) {
      if (this.ride !== 0) this.laneTarget = this.rng.range(-this.lanes, this.lanes); // (back down to the floor)
      this.ride = 0;
      return null;
    }
    if (this.ride === 0) {
      if (this.rng.next() > dt * 2) return null; // (not every kart at the same moment)
      this.ride = Math.sign(k.offset + this.rng.range(-3, 3)) || 1;
    }
    this.laneTarget = this.ride * high;
    return this.ride * high;
  }

  /** In the sky: flown. The racing line across the course as on the road, a lane drifting about it,
   * and a height to fly at: its own band over the course ahead (each rival its own), a ring ahead to
   * fly through (by class, not every one), and over or under an airliner crossing ahead. The engine
   * runs by itself: there are no brakes in the air, so the class's pace, its own skill and the
   * rubber band go in its kart's edge in speed (Kart.pace). */
  private fly(dt: number, track: Track, cls: ClassParams, player: Kart, others: Kart[], items: Items | undefined,
              dangers: readonly Danger[], air: AirCourse | null): Controls {
    const k = this.kart, v = Math.max(k.v, 0), s = track.s[k.idx];
    const L = track.locked ? track.length : Infinity;
    const ahead = (s0: number) => (Number.isFinite(L) ? ((((s0 - s + L / 2) % L) + L) % L) - L / 2 : s0 - s);
    if (this.rng.next() < dt * 0.3) this.laneTarget = this.rng.range(-9, 9);
    // room for a plane right in front, at its height
    for (const o of others) {
      if (o === k) continue;
      const dx = o.x - k.x, dy = o.y - k.y;
      const fwd = dx * Math.cos(k.heading) + dy * Math.sin(k.heading);
      const lat = -dx * Math.sin(k.heading) + dy * Math.cos(k.heading);
      if (fwd > 0 && fwd < 9 && Math.abs(lat) < 2.5 && Math.abs(o.elev - k.elev) < 2.5) this.laneTarget = lat > 0 ? -4 : 4;
    }
    // a height: its own band over the course ahead (each rival its own, a meter under it to five over)
    const course = (m: number) => track.elev[track.ahead(k.idx, m)] ?? k.ground;
    let alt = course(35) - 1 + ((k.id * 37) % 7);
    // a ring ahead to fly through, the sharper the class the more of them
    if (air) {
      const d = this.ring ? ahead(this.ring.s0) : 0;
      if (this.ring && (d < 1 || d > 140)) this.ring = null;
      if (!this.ring) {
        for (const r of air.rings) {
          const dr = ahead(r.s0);
          if (dr < 25 || dr > 120 || r === this.weighedRing) continue;
          this.weighedRing = r;
          if (this.rng.next() < 0.45 + 0.55 * cls.aiCorner) this.ring = r;
          break;
        }
      }
      if (this.ring) {
        this.laneTarget = this.ring.offset;
        alt = (track.elev[this.ring.start] ?? k.ground) + this.ring.lift;
      }
    }
    // an airliner crossing ahead at its height: over it, or under it (never down into the sea)
    for (const o of dangers) {
      if (o.z === undefined || o.s === undefined) continue;
      const d = ahead(o.s);
      if (d < -8 || d > 75) continue;
      const z = k.ground + o.z;
      if (Math.abs(alt - z) < 7.5) alt = k.elev >= z || z - 9 < 10 ? z + 9 : z - 9;
    }
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * 1.2);
    // steering: pure pursuit on a line through the lane, cutting the inside of a bend
    const look = track.ahead(k.idx, 9 + v * 0.45);
    const kappa = track.curvature(look), edge = SKY_LANE - 3;
    const line = Math.max(-edge, Math.min(edge, this.lane + Math.sign(kappa) * Math.min(4, Math.abs(kappa) * 150)));
    const [tx, ty] = track.tangent(look);
    const gx = track.xs[look] - ty * line, gy = track.ys[look] + tx * line;
    const ang = Math.atan2(gy - k.y, gx - k.x) - k.heading;
    const err = Math.atan2(Math.sin(ang), Math.cos(ang));
    const blind = k.staticT > 0 ? 4 : 1;
    this.wobble += (this.rng.range(-1, 1) * cls.aiNoise * blind - this.wobble) * Math.min(1, dt * 2);
    const steer = Math.max(-1, Math.min(1, err * 2.4 + this.wobble));
    // up or down to its height, easing off as it gets there
    const pitch = Math.max(-1, Math.min(1, (alt - k.elev) * 0.25 - k.vz * 0.12));
    // pace: its class's edge and pace, its own skill, and the rubber band
    const gap = k.dist - player.dist;
    k.pace = cls.aiPace * cls.aiSpeed * this.skill * (gap < -70 ? 1.06 : gap > 60 ? 0.93 : 1) * (k.staticT > 0 ? 0.95 : 1);
    // pulled round a tight turn with the drift button, for the mini-turbo, as the class decides
    this.airDriftCd -= dt;
    const tight = Math.abs(track.curvature(track.ahead(k.idx, 6 + v * 0.3)));
    if (this.airDrifting) {
      if (tight < 1 / 80) this.airDrifting = false;
    } else if (this.airDriftCd <= 0 && tight > 1 / 50 && v > 16 && Math.sign(steer) === Math.sign(kappa)) {
      this.airDriftCd = 2.5;
      this.airDrifting = this.rng.next() < 0.15 + 0.85 * cls.aiCorner;
    }
    return {
      steer, throttle: 0, brake: 0, pitch, drift: this.airDrifting, hop: false,
      item: this.itemButton(track, cls, others, items), back: this.backButton(cls, others),
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

  /** The item button. Instant items get a one-frame press when the moment is right; oil, orbs and
   * bombs are held out behind as a shield while someone is close behind, and let go (dropped or
   * fired) when the moment comes. Sharper classes react sooner. */
  private itemButton(track: Track, cls: ClassParams, others: Kart[], items?: Items): boolean {
    const k = this.kart;
    if (!k.item || k.roulette > 0 || k.spin > 0 || k.finished || k.rocket > 0 || k.falling) {
      this.holding = this.tapped = false;
      return false;
    }
    const ready = k.itemAge >= 1.6 - cls.aiCorner; // reaction time: 0.9 s rookie, 0.65 s legend
    const fire = ready && (k.itemAge > 9 || this.wantsItem(track, cls, others, items));
    // rivals aim at someone instead of waiting for the sweep (the lock, then the throw, two frames apart)
    if (fire && AIMED.has(k.item) && k.aimLocked === null) k.aim = this.aimAt(others) ?? 0;
    if (TRAILS.has(k.item)) {
      if (this.holding) {
        if (fire) this.holding = false; // the release drops or fires it
        return this.holding;
      }
      if (fire || (ready && this.gaps(others).behind < 18)) this.holding = true;
      return this.holding;
    }
    if (this.tapped) {
      this.tapped = false;
      return false;
    }
    this.tapped = fire;
    return fire;
  }

  /** The back button: a puck, an orb, a boomerang or a bomb thrown back at a kart close behind
   * when there is nobody to throw at ahead (an aimed one locks first, then throws, as the
   * player's does). */
  private backButton(cls: ClassParams, others: Kart[]): boolean {
    const k = this.kart;
    if (this.backTapped) {
      this.backTapped = false;
      return false;
    }
    if (!k.item || !THROWN_BACK.has(k.item) || k.item === "flares" || k.roulette > 0 || k.spin > 0 || k.finished || k.rocket > 0 ||
        k.falling || this.holding || k.itemAge < 1.6 - cls.aiCorner) return false;
    if (k.aimLocked !== null && Math.cos(k.aimLocked) >= 0) return false; // locked ahead: the item button throws it
    const behind = this.aimBehind(others);
    if (behind === null || this.aimAt(others, 40) !== null) return false;
    if (AIMED.has(k.item) && k.aimLocked === null) k.aim = Math.PI - behind; // (the lock mirrors the sweep)
    this.backTapped = true;
    return true;
  }

  /** The angle off the heading to the nearest kart behind inside the arc an arrow sweeps behind
   * the kart (within ``range`` m), if any. */
  private aimBehind(others: Kart[], range = 22): number | null {
    const k = this.kart;
    let best: number | null = null, bestD = range;
    for (const o of others) {
      if (o === k || o.finished || o.phantom > 0 || !this.level(o)) continue;
      const dx = o.x - k.x, dy = o.y - k.y, d = Math.hypot(dx, dy);
      const off = Math.atan2(Math.sin(Math.atan2(dy, dx) - k.heading), Math.cos(Math.atan2(dy, dx) - k.heading));
      if (d < bestD && d > 3 && Math.abs(off) > Math.PI - AIM_MAX) {
        best = off;
        bestD = d;
      }
    }
    return best;
  }

  /** The angle off the heading to the nearest kart ahead inside the aiming arc (within ``range``
   * m), if any. */
  private aimAt(others: Kart[], range = 45): number | null {
    const k = this.kart;
    let best: number | null = null, bestD = range;
    for (const o of others) {
      if (o === k || o.finished || o.phantom > 0 || !this.level(o)) continue;
      const dx = o.x - k.x, dy = o.y - k.y, d = Math.hypot(dx, dy);
      const off = Math.atan2(Math.sin(Math.atan2(dy, dx) - k.heading), Math.cos(Math.atan2(dy, dx) - k.heading));
      if (d < bestD && d > 3 && Math.abs(off) < AIM_MAX) {
        best = off;
        bestD = d;
      }
    }
    return best;
  }

  /** Whether a throw can reach ``o``: anywhere on the road; in the sky, only flying at about this
   * plane's height (what is thrown there flies on level, race/items.ts). */
  private level(o: Kart): boolean {
    return !this.kart.plane || Math.abs(o.elev - this.kart.elev) < 2.6;
  }

  /** Race distance to the nearest kart ahead and behind. */
  private gaps(others: Kart[]): { ahead: number; behind: number } {
    const k = this.kart;
    let ahead = Infinity, behind = Infinity;
    for (const o of others) {
      if (o === k) continue;
      const gap = o.dist - k.dist;
      if (gap > 0) ahead = Math.min(ahead, gap);
      else behind = Math.min(behind, -gap);
    }
    return { ahead, behind };
  }

  /** Something is about to hit this kart: a comet coming for it, an orb homing in, a puck close. */
  private threatened(items?: Items): boolean {
    if (!items) return false;
    const k = this.kart;
    const near = (x: number, y: number, r: number) => (x - k.x) ** 2 + (y - k.y) ** 2 < r * r;
    return items.comets.some((c) => c.target === k && near(c.x, c.y, 45)) ||
      items.orbs.some((o) => o.target === k && near(o.x, o.y, 14)) ||
      items.pucks.some((p) => p.owner !== k && near(p.x, p.y, 7));
  }

  /** The moment for each item: boosts on a straight, oil with a kart close behind, an orb, a
   * puck or a boomerang with a kart in range ahead, a bomb lobbed onto the kart in front, a horn
   * when something is about to hit; the rest as soon as they can. */
  private wantsItem(track: Track, cls: ClassParams, others: Kart[], items?: Items): boolean {
    const k = this.kart;
    const { ahead, behind } = this.gaps(others);
    switch (k.item) {
      case "turbo":
      case "triple":
      case "gold": {
        const straight = [10, 25, 40].every((m) => Math.abs(track.curvature(track.ahead(k.idx, m))) < 1 / 90);
        return straight && k.v > 0.5 * cls.vmax && (k.surface === "road" || k.plane);
      }
      case "oil":
      case "oil3": return behind > 3 && behind < 28;
      case "orb":
      case "orb3": return ahead > 6 && ahead < 90;
      case "puck":
      case "puck3":
      case "boomerang": return this.aimAt(others, 40) !== null; // someone to aim at
      case "flares": return k.flares <= 0 || this.aimAt(others, 26) !== null;
      case "bomb":
      case "comet":
      case "static": return k.place > 1; // they find their targets by themselves
      case "horn": return this.threatened(items) || others.some((o) => o !== k && !o.finished &&
        Math.hypot(o.x - k.x, o.y - k.y) < 5) || k.itemAge > 14;
      case "rocket": return k.surface === "road" || k.plane;
      default: return true; // prism, shock, grabber, jackpot, coin, phantom
    }
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
      if (this.rng.next() < 0.15 + 0.85 * cls.aiCorner) {
        this.drifting = true;
        this.driftSide = Math.sign(kappa);
      }
    }
    return this.drifting;
  }
}
