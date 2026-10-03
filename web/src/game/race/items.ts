// Items, the kart racer staple, with original art and rules. Rows of item boxes appear on the
// road as it is dreamed; driving through one gives an item after a short roulette.
//   TURBO         an instant boost.          TRIPLE TURBO  three of them.
//   OIL SLICK     dropped behind the kart; whoever drives through it spins out.
//   DREAM ORB     fired up the road; it homes onto the next kart ahead.
//   BOOMERANG     thrown up the road and back, three times; it spins out every kart it touches.
//   BOMB          lobbed ahead; it blows up when someone comes close (or its fuse runs out).
//   PRISM         invincible for a while: faster, nothing spins you, you spin whoever you touch.
//   SHOCK         a jolt to everyone else: they spin, shrink, slow down and drop their items.
//   ROCKET        the kart becomes a rocket and flies itself up the road, scattering the pack.
// Oil, orbs and bombs can be held out behind the kart (hold the button): held there, they block
// one hit from behind; let go and they are dropped or fired. The odds depend on position: the
// leader mostly gets defensive items, the back of the pack the big ones, and last place gets
// the rocket nine times in ten. Pure logic (no rendering), so it is unit-tested headlessly.

import type { Rand } from "../core/gfx";
import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import { GRAVITY, type Kart, SPIN_TIME } from "./kart";

export { SPIN_TIME };

export type ItemKind = "turbo" | "triple" | "oil" | "orb" | "boomerang" | "bomb" | "prism" | "shock" | "rocket";
export const ITEM_KINDS: ItemKind[] = ["turbo", "triple", "oil", "orb", "boomerang", "bomb", "prism", "shock", "rocket"];
export const ITEM_NAMES: Record<ItemKind, string> = {
  turbo: "TURBO", triple: "TRIPLE TURBO", oil: "OIL SLICK", orb: "DREAM ORB", boomerang: "BOOMERANG",
  bomb: "BOMB", prism: "PRISM", shock: "SHOCK", rocket: "ROCKET",
};
/** Items that can be held out behind the kart while the button is down. */
export const TRAILS: ReadonlySet<ItemKind> = new Set<ItemKind>(["oil", "orb", "bomb"]);
const USES: Partial<Record<ItemKind, number>> = { triple: 3, boomerang: 3 };

export const BOX_SPACING = 210; // m of road between rows of boxes
const BOX_LANES = [-4.2, -1.4, 1.4, 4.2]; // lateral offsets across the road
const BOX_RESPAWN = 4; // s
const PICKUP_R = 1.6; // m
export const ROULETTE = 1.2; // s the player's item slot spins before it settles
const SLICK_R = 1.3;
const ORB_R = 1.4;
const ORB_SPEED = 12; // m/s on top of the shooter's speed
const ORB_RANGE = 150; // m of race distance in which an orb finds a target
const BOOM_OUT = 1.05; // s a boomerang flies out before it turns for home
const BOOM_SPEED = 20; // m/s on top of the thrower's speed, going out
const BOOM_HOME = 34; // m/s coming back
const BOOM_R = 1.5;
const BOOM_LIFE = 4.5; // s
const BOMB_FUSE = 2.6; // s
const BOMB_TRIGGER = 2.6; // m: a kart this close sets it off
export const BOMB_BLAST = 5.5; // m: everyone this close spins
export const BLAST_TIME = 0.6; // s the explosion is drawn for
export const PRISM_TIME = 7; // s
export const ROCKET_TIME = 6; // s
export const SHOCK_SHRINK = 3.5; // s

export interface ItemBox { x: number; y: number; elev: number; respawn: number }
export interface Slick { x: number; y: number; elev: number; ttl: number; owner: Kart; armed: number }
export interface Orb {
  idx: number; carry: number; x: number; y: number; offset: number; v: number; ttl: number;
  owner: Kart; target: Kart | null;
}
export interface Boomerang {
  idx: number; carry: number; x: number; y: number; z: number; offset: number; v: number; t: number;
  home: boolean; owner: Kart; hit: Kart[];
}
export interface Bomb {
  idx: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  fuse: number; landed: boolean; owner: Kart;
}
export interface Blast { x: number; y: number; z: number; age: number }

export type SpinCause = "oil" | "orb" | "boomerang" | "bomb" | "shock";
export type ItemEvent =
  | { kind: "roll"; kart: Kart } // the player's roulette started
  | { kind: "got"; kart: Kart; item: ItemKind }
  | { kind: "used"; kart: Kart; item: ItemKind }
  | { kind: "spun"; kart: Kart; by: SpinCause; owner: Kart }
  | { kind: "blocked"; kart: Kart } // a held item soaked up a hit from behind
  | { kind: "boom"; x: number; y: number }
  | { kind: "shock"; kart: Kart };

// relative odds at the front of the field, a third back, two thirds back, and at the back
const ODDS: Record<ItemKind, [number, number, number, number]> = {
  oil: [34, 14, 4, 0],
  orb: [18, 20, 14, 8],
  boomerang: [14, 18, 14, 6],
  bomb: [14, 14, 8, 4],
  turbo: [14, 18, 16, 10],
  triple: [6, 12, 22, 30],
  prism: [0, 4, 12, 22],
  shock: [0, 0, 6, 12],
  rocket: [0, 0, 4, 8],
};
/** Last place gets the rocket this often. */
export const LAST_ROCKET = 0.9;

/** Position-weighted odds of each item (summing to 1). */
export function itemOdds(place: number, field: number): Record<ItemKind, number> {
  const f = field > 1 ? Math.max(0, Math.min(1, (place - 1) / (field - 1))) : 0.5;
  const b = Math.min(2, Math.floor(f * 3)), t = f * 3 - b;
  const w = Object.fromEntries(ITEM_KINDS.map((k) => [k, ODDS[k][b] * (1 - t) + ODDS[k][b + 1] * t])) as Record<ItemKind, number>;
  if (field > 1 && place >= field) {
    // dead last: the rocket, nine times in ten
    const rest = ITEM_KINDS.filter((k) => k !== "rocket").reduce((s, k) => s + w[k], 0);
    for (const k of ITEM_KINDS) w[k] = k === "rocket" ? LAST_ROCKET : (w[k] / rest) * (1 - LAST_ROCKET);
    return w;
  }
  const sum = ITEM_KINDS.reduce((s, k) => s + w[k], 0);
  for (const k of ITEM_KINDS) w[k] /= sum;
  return w;
}

export function rollItem(place: number, field: number, rng: Rand): ItemKind {
  const p = itemOdds(place, field);
  let u = rng.next();
  for (const k of ITEM_KINDS) {
    u -= p[k];
    if (u < 0) return k;
  }
  return "turbo";
}

/** Knock a kart into a spin (nothing happens to an invincible kart). */
export function spinOut(k: Kart, time = SPIN_TIME): boolean {
  return k.spinOut(time);
}

export class Items {
  boxes: ItemBox[] = [];
  slicks: Slick[] = [];
  orbs: Orb[] = [];
  boomerangs: Boomerang[] = [];
  bombs: Bomb[] = [];
  blasts: Blast[] = [];
  events: ItemEvent[] = [];
  rowS: number[] = []; // arc length of each row of boxes (other features keep clear of them)
  private nextRow = BOX_SPACING * 0.6; // first row a little after the start

  constructor(private readonly rng: Rand) {}

  /** Place rows of boxes on newly committed road (dense indices [from, to)). */
  onCommit(track: Track, from: number, to: number): void {
    for (let i = Math.max(from, 1); i < to; i++) {
      const s = track.fromStart(i);
      if (s < this.nextRow) continue;
      if (track.locked && s > track.length - 70) break; // keep the run to the line clear
      this.nextRow += BOX_SPACING;
      if (track.elev[i] > 0) continue; // never on a bridge's ramps
      this.rowS.push(track.s[i]);
      const [tx, ty] = track.tangent(i);
      for (const lane of BOX_LANES) {
        this.boxes.push({ x: track.xs[i] - ty * lane, y: track.ys[i] + tx * lane, elev: track.elev[i], respawn: 0 });
      }
    }
  }

  /** Give ``k`` an item (a box, or a test). */
  grant(k: Kart, item: ItemKind): void {
    k.item = item;
    k.uses = USES[item] ?? 1;
    k.itemAge = 0;
    k.trailing = false;
  }

  /** The item button went down: oil, orbs and bombs are held out behind the kart; the rest fire. */
  press(k: Kart, karts: Kart[]): boolean {
    if (!k.item || k.roulette > 0 || k.spin > 0 || k.rocket > 0) return false;
    if (TRAILS.has(k.item)) {
      k.trailing = true;
      return true;
    }
    return this.use(k, karts);
  }

  /** The button came up: an item held out behind is dropped (oil) or fired (orb, bomb). */
  release(k: Kart, karts: Kart[]): boolean {
    if (!k.trailing) return false;
    k.trailing = false;
    return this.use(k, karts);
  }

  /** Fire ``k``'s item now. Returns false if it has none ready. */
  use(k: Kart, karts: Kart[]): boolean {
    if (!k.item || k.roulette > 0 || k.spin > 0 || k.rocket > 0) return false;
    const item = k.item;
    k.trailing = false;
    const c = Math.cos(k.heading), s = Math.sin(k.heading);
    switch (item) {
      case "turbo":
      case "triple":
        k.boostTime = Math.max(k.boostTime, 1.3);
        break;
      case "oil":
        this.slicks.push({ x: k.x - c * 2.4, y: k.y - s * 2.4, elev: k.ground, ttl: 30, owner: k, armed: 1.0 });
        break;
      case "orb":
        this.orbs.push({
          idx: k.idx, carry: 0, x: k.x + c * 2, y: k.y + s * 2, offset: k.offset, v: Math.max(k.v, 8) + ORB_SPEED,
          ttl: 6, owner: k, target: this.targetAhead(k, karts),
        });
        break;
      case "boomerang":
        this.boomerangs.push({
          idx: k.idx, carry: 0, x: k.x + c * 2, y: k.y + s * 2, z: k.elev + 0.9, offset: k.offset,
          v: Math.max(k.v, 8) + BOOM_SPEED, t: 0, home: false, owner: k, hit: [],
        });
        break;
      case "bomb": {
        const v = Math.max(k.v, 0) + 9;
        this.bombs.push({ idx: k.idx, x: k.x + c * 2, y: k.y + s * 2, z: k.elev + 1.2, vx: c * v, vy: s * v, vz: 7.5,
                          fuse: BOMB_FUSE, landed: false, owner: k });
        break;
      }
      case "prism":
        k.prism = PRISM_TIME;
        k.shrink = 0;
        break;
      case "shock":
        for (const o of karts) {
          if (o === k || o.finished || o.invincible) continue;
          o.spinOut(0.7);
          o.shrink = SHOCK_SHRINK;
          o.item = null; // a shock knocks the item out of every hand
          o.uses = 0;
          o.trailing = false;
          o.roulette = 0;
          this.events.push({ kind: "spun", kart: o, by: "shock", owner: k });
        }
        this.events.push({ kind: "shock", kart: k });
        break;
      case "rocket":
        k.rocket = ROCKET_TIME;
        k.spin = k.shrink = 0;
        k.drifting = false;
        break;
    }
    k.uses -= 1;
    if (k.uses <= 0) {
      k.item = null;
      k.uses = 0;
    }
    k.itemAge = 0;
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

  /** A projectile at (x, y) reached ``k``: a held item behind it soaks up the hit (true). */
  private shielded(k: Kart, x: number, y: number): boolean {
    if (!k.trailing || !k.item || !TRAILS.has(k.item)) return false;
    const behind = (x - k.x) * Math.cos(k.heading) + (y - k.y) * Math.sin(k.heading) < 0.4;
    if (!behind) return false;
    k.trailing = false;
    k.item = null;
    k.uses = 0;
    this.events.push({ kind: "blocked", kart: k });
    return true;
  }

  /** A projectile hit ``k``: blocked, shrugged off (invincible) or a spin. */
  private strike(k: Kart, x: number, y: number, by: SpinCause, owner: Kart): void {
    if (this.shielded(k, x, y)) return;
    if (k.spinOut()) this.events.push({ kind: "spun", kart: k, by, owner });
  }

  /** Move a projectile ``step`` meters up the road, carrying the remainder between points.
   * Returns false where the dream ends (it flew into the mist). */
  private advance(p: { idx: number; carry: number }, track: Track, step: number): boolean {
    p.carry += step;
    const n = Math.floor(p.carry / SPACING);
    p.carry -= n * SPACING;
    const next = track.wrap(p.idx + n);
    if (!track.locked && next >= track.count - 1) return false;
    p.idx = next;
    return true;
  }

  update(dt: number, track: Track, karts: Kart[], places: (k: Kart) => number): void {
    // boxes: respawn, and hand out items
    for (const b of this.boxes) {
      if (b.respawn > 0) {
        b.respawn -= dt;
        continue;
      }
      for (const k of karts) {
        if (k.finished || Math.abs(k.elev - b.elev) > 1.8) continue;
        if ((k.x - b.x) ** 2 + (k.y - b.y) ** 2 > PICKUP_R * PICKUP_R) continue;
        b.respawn = BOX_RESPAWN;
        if (!k.item && k.roulette <= 0) {
          this.grant(k, rollItem(places(k), karts.length, this.rng));
          if (k.isPlayer) {
            k.roulette = ROULETTE;
            this.events.push({ kind: "roll", kart: k });
          }
          else this.events.push({ kind: "got", kart: k, item: k.item! });
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
      if (!k.item) k.trailing = false;
    }
    // oil slicks
    this.slicks = this.slicks.filter((sl) => {
      sl.ttl -= dt;
      sl.armed -= dt;
      if (sl.ttl <= 0) return false;
      for (const k of karts) {
        if (k === sl.owner && sl.armed > 0) continue;
        if (k.spin > 0 || k.air || Math.abs(k.elev - sl.elev) > 1.2) continue;
        if ((k.x - sl.x) ** 2 + (k.y - sl.y) ** 2 > SLICK_R * SLICK_R) continue;
        if (k.spinOut()) this.events.push({ kind: "spun", kart: k, by: "oil", owner: sl.owner });
        return false; // driven through (an invincible kart just splashes it away)
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
        if (!this.advance(o, track, step)) return false; // flew into the dream mist
        const want = t ? Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, t.offset)) : o.offset;
        o.offset += (want - o.offset) * Math.min(1, dt * 1.5);
        const [tx, ty] = track.tangent(o.idx);
        o.x = track.xs[o.idx] - ty * o.offset;
        o.y = track.ys[o.idx] + tx * o.offset;
      }
      const oz = track.elev[o.idx] ?? 0;
      for (const k of karts) {
        if (k === o.owner || k.spin > 0 || Math.abs(k.elev - oz) > 2.2) continue;
        if ((k.x - o.x) ** 2 + (k.y - o.y) ** 2 > ORB_R * ORB_R) continue;
        this.strike(k, o.x, o.y, "orb", o.owner);
        return false;
      }
      return true;
    });
    // boomerangs: out up the road, then home to the thrower, hitting everyone on the way
    this.boomerangs = this.boomerangs.filter((b) => {
      b.t += dt;
      if (b.t > BOOM_LIFE) return false;
      if (!b.home) {
        if (b.t > BOOM_OUT || !this.advance(b, track, b.v * dt)) b.home = true;
        const [tx, ty] = track.tangent(b.idx);
        b.x = track.xs[b.idx] - ty * b.offset;
        b.y = track.ys[b.idx] + tx * b.offset;
        b.z = (track.elev[b.idx] ?? 0) + 0.9;
      } else {
        const o = b.owner;
        const d = Math.hypot(o.x - b.x, o.y - b.y);
        if (d < 1.8) return false; // caught
        const step = Math.min(d, BOOM_HOME * dt);
        b.x += ((o.x - b.x) / d) * step;
        b.y += ((o.y - b.y) / d) * step;
        b.z += (o.elev + 0.9 - b.z) * Math.min(1, dt * 4);
        b.idx = track.nearest(b.x, b.y, b.idx);
      }
      for (const k of karts) {
        if (k === b.owner || b.hit.includes(k) || Math.abs(k.elev + 0.9 - b.z) > 2.2) continue;
        if ((k.x - b.x) ** 2 + (k.y - b.y) ** 2 > BOOM_R * BOOM_R) continue;
        b.hit.push(k);
        if (this.shielded(k, b.x, b.y)) return false;
        if (k.spinOut()) this.events.push({ kind: "spun", kart: k, by: "boomerang", owner: b.owner });
      }
      return true;
    });
    // bombs: a lob, a landing, a fuse
    this.bombs = this.bombs.filter((bm) => {
      if (!bm.landed) {
        bm.x += bm.vx * dt;
        bm.y += bm.vy * dt;
        bm.vz -= GRAVITY * dt;
        bm.z += bm.vz * dt;
        bm.idx = track.nearest(bm.x, bm.y, bm.idx);
        const ground = track.elev[bm.idx] ?? 0;
        if (bm.z <= ground && bm.vz < 0) {
          bm.z = ground;
          bm.landed = true;
        }
      }
      bm.fuse -= dt;
      const armed = bm.fuse < BOMB_FUSE - 0.6;
      const close = bm.landed && armed && karts.some((k) =>
        Math.abs(k.elev - bm.z) < 2 && (k.x - bm.x) ** 2 + (k.y - bm.y) ** 2 < BOMB_TRIGGER ** 2);
      if (bm.fuse > 0 && !close) return true;
      for (const k of karts) {
        if (Math.abs(k.elev - bm.z) > 3) continue;
        if ((k.x - bm.x) ** 2 + (k.y - bm.y) ** 2 > BOMB_BLAST ** 2) continue;
        if (k.spinOut(1.25)) this.events.push({ kind: "spun", kart: k, by: "bomb", owner: bm.owner });
      }
      this.blasts.push({ x: bm.x, y: bm.y, z: bm.z, age: 0 });
      this.events.push({ kind: "boom", x: bm.x, y: bm.y });
      return false;
    });
    this.blasts = this.blasts.filter((b) => (b.age += dt) < BLAST_TIME);
  }
}
