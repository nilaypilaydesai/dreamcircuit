// Items, the kart racer staple, with original art and rules. Rows of item boxes appear on the
// road as it is dreamed; driving through one gives an item after a short roulette. Three items:
//   TURBO  an instant boost.
//   OIL    a slick dropped behind the kart; whoever drives through it spins out.
//   ORB    a dream orb fired up the road; it homes onto the next kart ahead and spins it out.
// The odds depend on position: the leader mostly gets defensive oil, the back of the pack
// mostly turbos and orbs. Pure logic (no rendering), so it is unit-tested headlessly.

import type { Rand } from "../core/gfx";
import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import type { Kart } from "./kart";

export type ItemKind = "turbo" | "oil" | "orb";
export const ITEM_KINDS: ItemKind[] = ["turbo", "oil", "orb"];

export const BOX_SPACING = 210; // m of road between rows of boxes
const BOX_LANES = [-4.2, -1.4, 1.4, 4.2]; // lateral offsets across the road
const BOX_RESPAWN = 4; // s
const PICKUP_R = 1.6; // m
export const ROULETTE = 1.2; // s the player's item slot spins before it settles
const SLICK_R = 1.3;
const ORB_R = 1.4;
const ORB_SPEED = 12; // m/s on top of the shooter's speed
const ORB_RANGE = 150; // m of race distance in which an orb finds a target
export const SPIN_TIME = 1.0; // s

export interface ItemBox { x: number; y: number; respawn: number }
export interface Slick { x: number; y: number; ttl: number; owner: Kart; armed: number }
export interface Orb {
  idx: number; carry: number; x: number; y: number; offset: number; v: number; ttl: number;
  owner: Kart; target: Kart | null;
}

export type ItemEvent =
  | { kind: "roll"; kart: Kart } // the player's roulette started
  | { kind: "got"; kart: Kart; item: ItemKind }
  | { kind: "used"; kart: Kart; item: ItemKind }
  | { kind: "spun"; kart: Kart; by: "oil" | "orb"; owner: Kart };

/** Position-weighted odds: 0 = leading, 1 = last. */
export function itemOdds(place: number, field: number): Record<ItemKind, number> {
  const f = field > 1 ? (place - 1) / (field - 1) : 0.5;
  const turbo = 0.15 + 0.4 * f; // leader: 15% turbo, 25% orb, 60% oil; last: 55%, 40%, 5%
  const orb = 0.25 + 0.15 * f;
  return { turbo, orb, oil: 1 - turbo - orb };
}

export function rollItem(place: number, field: number, rng: Rand): ItemKind {
  const p = itemOdds(place, field);
  const u = rng.next();
  return u < p.turbo ? "turbo" : u < p.turbo + p.orb ? "orb" : "oil";
}

/** Knock a kart into a spin: it slides on, slowing, with no control for a moment. */
export function spinOut(k: Kart): void {
  k.spin = SPIN_TIME;
  k.v *= 0.45;
  k.drifting = false;
  k.boostLevel = 0;
  k.boostTime = 0;
}

export class Items {
  boxes: ItemBox[] = [];
  slicks: Slick[] = [];
  orbs: Orb[] = [];
  events: ItemEvent[] = [];
  private nextRow = BOX_SPACING * 0.6; // first row a little after the start

  constructor(private readonly rng: Rand) {}

  /** Place rows of boxes on newly committed road (dense indices [from, to)). */
  onCommit(track: Track, from: number, to: number): void {
    for (let i = Math.max(from, 1); i < to; i++) {
      const s = track.fromStart(i);
      if (s < this.nextRow) continue;
      if (track.locked && s > track.length - 70) break; // keep the run to the line clear
      this.nextRow += BOX_SPACING;
      const [tx, ty] = track.tangent(i);
      for (const lane of BOX_LANES) {
        this.boxes.push({ x: track.xs[i] - ty * lane, y: track.ys[i] + tx * lane, respawn: 0 });
      }
    }
  }

  /** Fire ``k``'s item. Returns false if it has none ready. */
  use(k: Kart, karts: Kart[]): boolean {
    if (!k.item || k.roulette > 0 || k.spin > 0) return false;
    const item = k.item;
    k.item = null;
    const c = Math.cos(k.heading), s = Math.sin(k.heading);
    if (item === "turbo") {
      k.boostTime = Math.max(k.boostTime, 1.3);
    } else if (item === "oil") {
      this.slicks.push({ x: k.x - c * 2.4, y: k.y - s * 2.4, ttl: 30, owner: k, armed: 1.0 });
    } else {
      this.orbs.push({
        idx: k.idx, carry: 0, x: k.x + c * 2, y: k.y + s * 2, offset: k.offset, v: Math.max(k.v, 8) + ORB_SPEED,
        ttl: 6, owner: k, target: this.targetAhead(k, karts),
      });
    }
    this.events.push({ kind: "used", kart: k, item });
    return true;
  }

  /** The nearest kart ahead in race distance, within range. */
  targetAhead(k: Kart, karts: Kart[]): Kart | null {
    let best: Kart | null = null;
    for (const o of karts) {
      if (o === k || o.finished) continue;
      const gap = o.dist - k.dist;
      if (gap > 0 && gap < ORB_RANGE && (!best || gap < best.dist - k.dist)) best = o;
    }
    return best;
  }

  update(dt: number, track: Track, karts: Kart[], places: (k: Kart) => number): void {
    // boxes: respawn, and hand out items
    for (const b of this.boxes) {
      if (b.respawn > 0) {
        b.respawn -= dt;
        continue;
      }
      for (const k of karts) {
        if (k.finished || (k.x - b.x) ** 2 + (k.y - b.y) ** 2 > PICKUP_R * PICKUP_R) continue;
        b.respawn = BOX_RESPAWN;
        if (!k.item && k.roulette <= 0) {
          k.item = rollItem(places(k), karts.length, this.rng);
          k.itemAge = 0;
          if (k.isPlayer) {
            k.roulette = ROULETTE;
            this.events.push({ kind: "roll", kart: k });
          }
          else this.events.push({ kind: "got", kart: k, item: k.item });
        }
        break;
      }
    }
    for (const k of karts) {
      k.itemAge += dt;
      if (k.roulette > 0) {
        k.roulette -= dt;
        if (k.roulette <= 0 && k.item) this.events.push({ kind: "got", kart: k, item: k.item });
      }
    }
    // oil slicks
    this.slicks = this.slicks.filter((sl) => {
      sl.ttl -= dt;
      sl.armed -= dt;
      if (sl.ttl <= 0) return false;
      for (const k of karts) {
        if (k === sl.owner && sl.armed > 0) continue;
        if (k.spin > 0 || (k.x - sl.x) ** 2 + (k.y - sl.y) ** 2 > SLICK_R * SLICK_R) continue;
        spinOut(k);
        this.events.push({ kind: "spun", kart: k, by: "oil", owner: sl.owner });
        return false;
      }
      return true;
    });
    // dream orbs: fly up the road, steer toward the target once close
    this.orbs = this.orbs.filter((o) => {
      o.ttl -= dt;
      if (o.ttl <= 0) return false;
      const step = o.v * dt;
      // a target that is already spinning (or done) is left alone: the orb flies on
      if (o.target && (o.target.spin > 0 || o.target.finished)) o.target = null;
      const t = o.target;
      const near = t && Math.hypot(t.x - o.x, t.y - o.y) < 22;
      if (near && t) {
        const d = Math.hypot(t.x - o.x, t.y - o.y) || 1;
        o.x += ((t.x - o.x) / d) * step;
        o.y += ((t.y - o.y) / d) * step;
        o.idx = track.nearest(o.x, o.y, o.idx);
      } else {
        o.carry += step; // whole centerline points only, so carry the remainder
        const n = Math.floor(o.carry / SPACING);
        o.carry -= n * SPACING;
        const next = track.wrap(o.idx + n);
        if (!track.locked && next >= track.count - 1) return false; // flew into the dream mist
        o.idx = next;
        const want = t ? Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, t.offset)) : o.offset;
        o.offset += (want - o.offset) * Math.min(1, dt * 1.5);
        const [tx, ty] = track.tangent(o.idx);
        o.x = track.xs[o.idx] - ty * o.offset;
        o.y = track.ys[o.idx] + tx * o.offset;
      }
      for (const k of karts) {
        if (k === o.owner || k.spin > 0) continue;
        if ((k.x - o.x) ** 2 + (k.y - o.y) ** 2 > ORB_R * ORB_R) continue;
        spinOut(k);
        this.events.push({ kind: "spun", kart: k, by: "orb", owner: o.owner });
        return false;
      }
      return true;
    });
  }
}
