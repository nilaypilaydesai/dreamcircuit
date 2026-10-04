// Items, the kart racer staple: twenty-two of them, as many as the classic this game follows, each
// doing the job of one of the classic's, with original art and names (race/odds.ts has which a
// box gives, by how far a kart is behind the leader). Rows of item boxes and lines of coins appear
// on the road as it is dreamed; driving through a box gives an item after a short roulette.
//   TURBO, TRIPLE TURBO    a boost; three of them, circling the kart until used.
//   GOLD TURBO             a boost on every press for 7.5 s.
//   OIL SLICK, TRIPLE OIL  dropped behind; whoever drives through it spins. Hold the button to
//                          keep one out behind as a shield; three trail behind the kart.
//   PUCK, TRIPLE PUCK      aimed: the first press locks the sweeping arrow (the puck rides out
//                          behind as a shield), the second throws it. It slides along the
//                          arrow, bouncing off the edges of the road, and spins the first kart
//                          it meets, its thrower too. A triple circles the kart.
//   DREAM ORB, TRIPLE ORB  fired up the road, it homes onto the kart ahead (hold the button to
//                          keep it behind as a shield). A triple circles the kart.
//   COMET                  flies up the road over everyone, finds the leader and comes down on
//                          them; its blast spins whoever is near. A horn can knock it down.
//   BOMB                   aimed like the puck; lobbed at the racer one place ahead, it chases
//                          them down and goes off, and its blast spins everyone near (thrown by
//                          the leader, it lands where it was aimed and waits for anyone).
//   ROCKET                 the kart becomes a rocket and flies itself up the road, past two
//                          karts at most and never into the lead.
//   STATIC                 everyone ahead gets static over the screen for a while.
//   SHOCK                  everyone else spins, shrinks, slows and drops their item; a full-size
//                          kart that drives over a shrunk one flattens it.
//   PRISM                  invincible and faster; it spins whoever it touches.
//   FLARES                 for 10 s, every press throws a fireball that bounces up the road.
//   BOOMERANG              aimed like the puck; out along the arrow and back, three times.
//   GRABBER                for 8 s a claw rides in front of the kart, snapping at the karts and
//                          items it can reach; every bite is a little boost.
//   HORN                   a blast of sound: karts close by spin, and every item near is knocked
//                          out of the air, a comet too.
//   JACKPOT                eight items circle the kart; each press uses the next.
//   COIN                   two coins. Every coin, up to ten, is a little more top speed, and a
//                          spin costs three.
//   PHANTOM                see-through and untouchable for 5 s, and it steals someone's item.
// Items meet as they do in the classic: a projectile and an oil slick, or two projectiles, take
// each other out; an item held out behind a kart blocks one hit from behind, and every puck or orb
// of a triple circling it blocks one; a prism or a rocket shrugs everything off and a phantom lets
// it pass straight through; a blast or a horn clears the items around it. Pure logic (no
// rendering), so it is unit-tested headlessly.

import type { Rand } from "../core/gfx";
import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import { GRAVITY, type Kart, MAX_COINS, SPIN_TIME } from "./kart";
import { ITEM_KINDS, type ItemKind, type Standing, itemOdds, pickItem } from "./odds";

export { ITEM_KINDS, SPIN_TIME };
export type { ItemKind };

export const ITEM_NAMES: Record<ItemKind, string> = {
  turbo: "TURBO", triple: "TRIPLE TURBO", gold: "GOLD TURBO", oil: "OIL SLICK", oil3: "TRIPLE OIL", puck: "PUCK",
  puck3: "TRIPLE PUCK", orb: "DREAM ORB", orb3: "TRIPLE ORB", comet: "COMET", bomb: "BOMB", rocket: "ROCKET",
  static: "STATIC", shock: "SHOCK", prism: "PRISM", flares: "FLARES", boomerang: "BOOMERANG", grabber: "GRABBER",
  horn: "HORN", jackpot: "JACKPOT", coin: "COIN", phantom: "PHANTOM",
};
/** Items held out behind the kart while the button is down (let go: dropped or fired). */
export const TRAILS: ReadonlySet<ItemKind> = new Set<ItemKind>(["oil", "orb"]);
/** Items thrown where the arrow points: the first press locks it, the second throws. */
export const AIMED: ReadonlySet<ItemKind> = new Set<ItemKind>(["puck", "puck3", "bomb", "boomerang"]);
/** Items the back button throws behind the kart (aimed ones along an arrow behind it). */
export const THROWN_BACK: ReadonlySet<ItemKind> = new Set<ItemKind>(["puck", "puck3", "orb", "orb3", "boomerang", "bomb", "flares"]);
/** Aimed items that ride out behind the kart, as a shield, once the arrow is locked. */
const HELD_WHEN_LOCKED: ReadonlySet<ItemKind> = new Set<ItemKind>(["puck", "bomb"]);
/** Items whose every shot circles the kart (each blocks one hit) until it is fired. */
export const ORBITS: ReadonlySet<ItemKind> = new Set<ItemKind>(["puck3", "orb3"]);
const USES: Partial<Record<ItemKind, number>> = { triple: 3, oil3: 3, puck3: 3, orb3: 3, boomerang: 3 };
/** The jackpot's eight, in the order they are used. */
export const JACKPOT: ItemKind[] = ["oil", "bomb", "static", "coin", "puck", "turbo", "orb", "prism"];

export const BOX_SPACING = 210; // m of road between rows of boxes
const BOX_LANES = [-4.2, -1.4, 1.4, 4.2]; // lateral offsets across the road
const BOX_RESPAWN = 4; // s
const PICKUP_R = 1.6; // m
export const COIN_SPACING = 210; // m between lines of coins (halfway between the rows of boxes)
const COIN_RESPAWN = 10; // s
export const ROULETTE = 1.2; // s the player's item slot spins before it settles
const SLICK_R = 2.1; // m: a kart this close to a slick's middle drives through it (it is 4.6 m across)
const ORB_R = 1.4;
const ORB_SPEED = 12; // m/s on top of the shooter's speed
const ORB_RANGE = 150; // m of race distance in which an orb finds a target
const PUCK_SPEED = 22; // m/s on top of the thrower's speed
const PUCK_R = 1.4;
const PUCK_LIFE = 8; // s
const PUCK_BOUNCES = 6;
const FLARE_SPEED = 14;
const FLARE_LIFE = 2.2;
const FLARE_EVERY = 0.25; // s between fireballs
export const FLARES_TIME = 10; // s
export const GOLD_TIME = 7.5; // s
const BOOM_OUT = 1.05; // s a boomerang flies out before it turns for home
const BOOM_SPEED = 20; // m/s on top of the thrower's speed, going out
const BOOM_HOME = 34; // m/s coming back
const BOOM_R = 1.5;
const BOOM_LIFE = 4.5; // s
const BOMB_CHASE = 7; // s a bomb chases its target before it goes off anyway
const BOMB_HIT = 1.7; // m: close enough to the target to go off
const MINE_LIFE = 25; // s a leader's bomb waits on the track
const BOMB_TRIGGER = 2.6; // m: a kart this close sets a waiting bomb off
export const BOMB_BLAST = 5.5; // m: everyone this close to a bomb when it goes off spins
export const COMET_SPEED = 75; // m/s up the road
export const COMET_BLAST = 6.5; // m
const COMET_HOVER = 0.7; // s over the leader before it comes down
const COMET_DIVE = 0.25; // s
export const COMET_HEIGHT = 4.5; // m over the road
export const STATIC_TIME = 4.5; // s
export const GRAB_TIME = 8; // s
const GRAB_REACH = 4.5; // m in front of the kart
const GRAB_ARC = 0.75; // rad either side of straight ahead
export const PHANTOM_TIME = 5; // s
const LOOT_FLIGHT = 1; // s a stolen item takes to arrive
export const HORN_R = 7; // m: karts this close spin
const HORN_CLEAR = 9; // m: items this close are knocked out
const HORN_COMET = 14; // m: and a comet this close
/** Items thrown where the arrow points, and how far it sweeps either side of straight ahead. */
export const AIM_MAX = 0.75; // rad
export const AIM_RATE = 3.1; // rad/s of sweep phase: one sweep across and back in about 2 s
export const BLAST_TIME = 0.6; // s an explosion is drawn for
export const RING_TIME = 0.5; // s a horn's ring is drawn for
export const PRISM_TIME = 7; // s
export const ROCKET_TIME = 4.5; // s at most
export const ROCKET_PASSES = 2; // karts a rocket carries its kart past before it burns out
export const ROCKET_TAIL = 0.35; // s it flies on after the last pass (clear of the kart it passed)
export const SHOCK_SHRINK = 3.5; // s
/** s an item stays out of the boxes after one is used (the classic keeps these rare). */
const COOLDOWN: Partial<Record<ItemKind, number>> = { shock: 25, comet: 20, static: 15 };

/** How many karts a rocket fired from ``place`` may pass: up to ROCKET_PASSES, and never into
 * first place. */
export function rocketPasses(place: number): number {
  return Math.max(0, Math.min(ROCKET_PASSES, place - 2));
}

export interface ItemBox { x: number; y: number; elev: number; respawn: number; idx: number }
export interface CoinSpot { x: number; y: number; elev: number; respawn: number; idx: number }
/** An oil slick: where it lies, how high (the road under the kart that dropped it), and the road
 * point it was dropped from (where to look for the road under it, on a deck over another road);
 * and the road's height at that point when it was last seen (``road``), so that it goes up or down
 * with the road (relift). */
export interface Slick { x: number; y: number; elev: number; idx: number; ttl: number; owner: Kart; armed: number; road?: number }
export interface Orb {
  idx: number; carry: number; x: number; y: number; offset: number; v: number; ttl: number;
  owner: Kart; target: Kart | null;
}
/** A puck slides; a flare hops (z over the road, vz) and burns out sooner. */
export interface Puck {
  kind: "puck" | "flare" | "orb"; idx: number; x: number; y: number; z: number; vz: number; vx: number; vy: number;
  t: number; bounces: number; owner: Kart;
}
export interface Boomerang {
  idx: number; x: number; y: number; z: number; vx: number; vy: number; t: number;
  home: boolean; owner: Kart; hit: Kart[];
}
export interface Bomb {
  idx: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  age: number; landed: boolean; owner: Kart;
  target: Kart | null; // the racer one place ahead of the thrower; null: a waiting bomb
}
export interface Comet {
  idx: number; carry: number; dist: number; x: number; y: number; z: number; t: number; owner: Kart;
  target: Kart | null; phase: "fly" | "hover" | "dive";
}
export interface Blast { x: number; y: number; z: number; age: number; size: number }
export interface Ring { kart: Kart; age: number } // a horn's blast, centred on the kart that blew it

export type SpinCause = "oil" | "orb" | "puck" | "flare" | "boomerang" | "bomb" | "comet" | "shock" | "horn" | "grabber";
export type ItemEvent =
  | { kind: "roll"; kart: Kart } // the player's roulette started
  | { kind: "got"; kart: Kart; item: ItemKind }
  | { kind: "used"; kart: Kart; item: ItemKind }
  | { kind: "locked"; kart: Kart } // an aimed item's arrow was locked
  | { kind: "spun"; kart: Kart; by: SpinCause; owner: Kart }
  | { kind: "blocked"; kart: Kart } // a held or circling item soaked up a hit
  | { kind: "boom"; x: number; y: number; big: boolean }
  | { kind: "clash"; x: number; y: number } // two items took each other out
  | { kind: "shock"; kart: Kart }
  | { kind: "horn"; kart: Kart }
  | { kind: "static"; kart: Kart; by: Kart } // a kart got static over its screen
  | { kind: "comet"; target: Kart | null } // a comet is on its way to the leader
  | { kind: "stolen"; kart: Kart; by: Kart; item: ItemKind } // a phantom took a kart's item
  | { kind: "coin"; kart: Kart }
  | { kind: "bite"; kart: Kart }
  | { kind: "bounce"; x: number; y: number };

/** What the items need to know about the race: who is where. */
export interface Field {
  standing: (k: Kart) => Standing; // for the odds
  leader: () => Kart | null; // the kart in first place that is still racing
}

export class Items {
  boxes: ItemBox[] = [];
  coins: CoinSpot[] = [];
  slicks: Slick[] = [];
  orbs: Orb[] = [];
  pucks: Puck[] = [];
  boomerangs: Boomerang[] = [];
  bombs: Bomb[] = [];
  comets: Comet[] = [];
  blasts: Blast[] = [];
  rings: Ring[] = [];
  events: ItemEvent[] = [];
  rowS: number[] = []; // arc length of each row of boxes (other features keep clear of them)
  gravity = GRAVITY; // m/s^2 for anything lobbed (low on the moon)
  private nextRow = BOX_SPACING * 0.6; // first row a little after the start
  private nextCoins = BOX_SPACING * 0.6 + COIN_SPACING / 2;
  private readonly cooldown = new Map<ItemKind, number>();

  constructor(private readonly rng: Rand) {}

  /** Place rows of boxes and lines of coins on newly committed road (dense indices [from, to)). */
  onCommit(track: Track, from: number, to: number): void {
    for (let i = Math.max(from, 1); i < to; i++) {
      const s = track.fromStart(i);
      if (track.locked && s > track.length - 70) break; // keep the run to the line clear
      const [tx, ty] = track.tangent(i);
      if (s >= this.nextRow) {
        this.nextRow += BOX_SPACING;
        if (track.bridgeAt(i) > 0) continue; // never on a bridge's ramps (a climb is fine)
        this.rowS.push(track.s[i]);
        for (const lane of BOX_LANES) {
          this.boxes.push({ x: track.xs[i] - ty * lane, y: track.ys[i] + tx * lane, elev: track.elev[i], respawn: 0, idx: i });
        }
      } else if (s >= this.nextCoins) {
        // a short line of coins down one lane
        this.nextCoins += COIN_SPACING;
        if (track.bridgeAt(i) > 0) continue;
        const lane = [-3.2, 0, 3.2][Math.floor(this.rng.next() * 3)];
        for (let c = 0; c < 4; c++) {
          const j = i + Math.round((c * 3.2) / SPACING);
          if (j >= track.count) break;
          const [cx, cy] = track.tangent(j);
          this.coins.push({ x: track.xs[j] - cy * lane, y: track.ys[j] + cx * lane, elev: track.elev[j], respawn: 0, idx: j });
        }
      }
    }
  }

  /** The road was lifted or lowered (a climb added or flattened, a bridge built): the boxes, coins
   * and oil on it go with it (left where they were, they hung in the air or sank into it). */
  relift(track: Track): void {
    for (const b of this.boxes) b.elev = track.elev[b.idx] ?? b.elev;
    for (const c of this.coins) c.elev = track.elev[c.idx] ?? c.elev;
    for (const sl of this.slicks) {
      const now = track.elev[sl.idx] ?? 0;
      sl.elev += now - (sl.road ?? now);
      sl.road = now;
    }
  }

  /** Whether something thrown or dropped hits a car at (x, y), z m up (a police car after the
   * player): oil, a puck, an orb, a flare, a boomerang, a bomb's blast or a horn's ring. Oil, pucks
   * and orbs are used up by it. */
  hitsCar(x: number, y: number, z: number): boolean {
    const near = (ax: number, ay: number, r: number) => (ax - x) ** 2 + (ay - y) ** 2 < r * r;
    const sl = this.slicks.findIndex((s) => near(s.x, s.y, SLICK_R + 0.6) && Math.abs(s.elev - z) < 1.5);
    if (sl >= 0) {
      this.slicks.splice(sl, 1);
      return true;
    }
    const pk = this.pucks.findIndex((p) => near(p.x, p.y, PUCK_R + 1) && p.z < 2);
    if (pk >= 0) {
      this.pucks.splice(pk, 1);
      return true;
    }
    const ob = this.orbs.findIndex((o) => near(o.x, o.y, ORB_R + 1));
    if (ob >= 0) {
      this.orbs.splice(ob, 1);
      return true;
    }
    return this.boomerangs.some((b) => near(b.x, b.y, 2.4)) ||
      this.blasts.some((b) => b.age < 0.15 && near(b.x, b.y, BOMB_BLAST * b.size)) ||
      this.rings.some((r) => r.age < 0.15 && near(r.kart.x, r.kart.y, HORN_R));
  }

  /** Give ``k`` an item (a box, a phantom's theft, or a test). */
  grant(k: Kart, item: ItemKind): void {
    k.item = item;
    k.uses = USES[item] ?? 1;
    k.itemAge = 0;
    k.trailing = false;
    k.aimLocked = null;
    k.jackpot = [];
  }

  /** Take ``k``'s item away (a shock, a theft, a block). */
  private clear(k: Kart): void {
    k.item = null;
    k.uses = 0;
    k.trailing = false;
    k.aimLocked = null;
    k.jackpot = [];
    k.gold = k.flares = 0;
  }

  /** Items that cannot come out of a box right now: one comet at a time, and the rare ones for a
   * while after one is used. */
  unavailable(): Set<ItemKind> {
    const out = new Set<ItemKind>();
    for (const [i, t] of this.cooldown) if (t > 0) out.add(i);
    if (this.comets.length) out.add("comet");
    return out;
  }

  /** The item button went down. An aimed item locks the arrow on the first press and is thrown on
   * the second; oil and orbs come out behind the kart (dropped or fired when the button comes up);
   * everything else is used at once. */
  press(k: Kart, karts: Kart[], field?: Field): boolean {
    if (!this.ready(k)) return false;
    const item = k.item!;
    if (AIMED.has(item)) {
      if (k.aimLocked === null) {
        k.aimLocked = k.aim;
        if (HELD_WHEN_LOCKED.has(item)) k.trailing = true;
        this.events.push({ kind: "locked", kart: k });
        return true;
      }
      return this.use(k, karts, field);
    }
    if (TRAILS.has(item)) {
      k.trailing = true;
      return true;
    }
    return this.use(k, karts, field);
  }

  /** The back button went down (R, the pad's X, BACK on a touch screen): the item goes out behind.
   * An aimed item's arrow locks behind the kart on the first press (mirrored, on the same side of
   * the kart as the sweep in front) and the second press throws it; an orb or a flare is thrown
   * straight back; oil is dropped; anything else is used as by the item button. */
  pressBack(k: Kart, karts: Kart[], field?: Field): boolean {
    if (!this.ready(k)) return false;
    const item = k.item!;
    if (AIMED.has(item)) {
      if (k.aimLocked === null) {
        k.aimLocked = Math.PI - k.aim;
        if (HELD_WHEN_LOCKED.has(item)) k.trailing = true;
        this.events.push({ kind: "locked", kart: k });
        return true;
      }
      return this.use(k, karts, field);
    }
    k.trailing = false;
    return this.use(k, karts, field, true);
  }

  /** The button came up: oil or an orb held out behind is dropped or fired. (An aimed item stays
   * locked until the second press.) */
  release(k: Kart, karts: Kart[], field?: Field): boolean {
    if (!k.trailing || !k.item || !TRAILS.has(k.item)) return false;
    k.trailing = false;
    return this.use(k, karts, field);
  }

  private ready(k: Kart): boolean {
    return !!k.item && k.roulette <= 0 && k.spin <= 0 && k.rocket <= 0 && !k.falling;
  }

  /** Use ``k``'s item now (``back``: thrown behind the kart). Returns false if it has none ready. */
  use(k: Kart, karts: Kart[], field?: Field, back = false): boolean {
    if (!this.ready(k)) return false;
    const item = k.item!;
    // the jackpot: the first press sets the eight circling, every press after uses the next
    if (item === "jackpot") {
      if (!k.jackpot.length) {
        k.jackpot = [...JACKPOT];
      } else {
        const next = k.jackpot.shift()!;
        this.effect(k, next, karts, field, back ? Math.PI : 0);
        if (!k.jackpot.length) this.clear(k);
      }
      k.itemAge = 0;
      this.events.push({ kind: "used", kart: k, item });
      return true;
    }
    // a gold turbo and flares stay in the slot while they last: every press is another go
    if (item === "gold" || item === "flares") {
      if (item === "gold") {
        if (k.gold <= 0) k.gold = GOLD_TIME;
        k.boostTime = Math.max(k.boostTime, 1.0);
      } else {
        if (k.flares <= 0) k.flares = FLARES_TIME;
        if (k.flareCd > 0) return false;
        this.throwPuck(k, "flare", back ? Math.PI : 0);
        k.flareCd = FLARE_EVERY;
      }
      k.itemAge = 0;
      this.events.push({ kind: "used", kart: k, item });
      return true;
    }
    const aim = k.aimLocked ?? (back ? Math.PI : k.aim);
    this.effect(k, item, karts, field, aim);
    k.aimLocked = null;
    k.trailing = false;
    k.uses -= 1;
    if (k.uses <= 0) this.clear(k);
    k.itemAge = 0;
    this.events.push({ kind: "used", kart: k, item });
    return true;
  }

  /** What an item does when it is used (``aim``: rad off the heading, for the thrown ones). */
  private effect(k: Kart, item: ItemKind, karts: Kart[], field: Field | undefined, aim: number): void {
    const c = Math.cos(k.heading), s = Math.sin(k.heading);
    switch (item) {
      case "turbo":
      case "triple":
        k.boostTime = Math.max(k.boostTime, 1.3);
        break;
      case "gold":
        k.gold = GOLD_TIME;
        k.boostTime = Math.max(k.boostTime, 1.0);
        break;
      case "oil":
      case "oil3":
        this.slicks.push({ x: k.x - c * 3.4, y: k.y - s * 3.4, elev: k.ground, idx: k.idx, ttl: 30, owner: k, armed: 1.0 });
        break;
      case "puck":
      case "puck3":
        this.throwPuck(k, "puck", aim);
        break;
      case "orb":
      case "orb3":
        if (Math.cos(aim) < 0) { // thrown back: straight down the road, at whoever is behind
          this.throwPuck(k, "orb", aim);
          break;
        }
        this.orbs.push({
          idx: k.idx, carry: 0, x: k.x + c * 2, y: k.y + s * 2, offset: k.offset, v: Math.max(k.v, 8) + ORB_SPEED,
          ttl: 6, owner: k, target: this.targetAhead(k, karts),
        });
        break;
      case "comet": {
        const target = field?.leader() ?? null;
        this.comets.push({ idx: k.idx, carry: 0, dist: k.dist, x: k.x, y: k.y, z: k.elev + COMET_HEIGHT, t: 0, owner: k,
                           target, phase: "fly" });
        this.events.push({ kind: "comet", target });
        break;
      }
      case "bomb": {
        // lobbed ahead it chases the racer in front; lobbed back it lands behind and waits
        const a = k.heading + aim, back = Math.cos(aim) < 0, v = back ? 12 : Math.max(k.v, 0) + 9;
        const target = !back && k.place > 1 ? karts.find((o) => o.place === k.place - 1 && !o.finished) ?? null : null;
        this.bombs.push({ idx: k.idx, x: k.x + Math.cos(a) * 2, y: k.y + Math.sin(a) * 2, z: k.elev + 1.2, vx: Math.cos(a) * v,
                          vy: Math.sin(a) * v, vz: 7.5 * Math.sqrt(this.gravity / GRAVITY), age: 0, landed: false, owner: k,
                          target });
        break;
      }
      case "boomerang": {
        const a = k.heading + aim, v = Math.cos(aim) < 0 ? BOOM_SPEED + 8 : Math.max(k.v, 8) + BOOM_SPEED;
        this.boomerangs.push({
          idx: k.idx, x: k.x + Math.cos(a) * 2, y: k.y + Math.sin(a) * 2, z: k.elev + 0.9, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          t: 0, home: false, owner: k, hit: [],
        });
        break;
      }
      case "rocket":
        k.rocket = ROCKET_TIME;
        k.rocketFrom = k.place || karts.length;
        k.spin = k.shrink = 0;
        k.drifting = false;
        break;
      case "static":
        for (const o of karts) {
          if (o === k || o.finished || o.phantom > 0 || o.dist <= k.dist) continue;
          o.staticT = STATIC_TIME;
          this.events.push({ kind: "static", kart: o, by: k });
        }
        this.cooldown.set("static", COOLDOWN.static!);
        break;
      case "shock":
        for (const o of karts) {
          if (o === k || o.finished || o.untouchable) continue;
          o.spinOut(0.7);
          o.shrink = SHOCK_SHRINK;
          this.clear(o); // a shock knocks the item out of every hand
          o.roulette = 0;
          this.events.push({ kind: "spun", kart: o, by: "shock", owner: k });
        }
        this.cooldown.set("shock", COOLDOWN.shock!);
        this.events.push({ kind: "shock", kart: k });
        break;
      case "prism":
        k.prism = PRISM_TIME;
        k.shrink = 0;
        break;
      case "flares":
        k.flares = FLARES_TIME;
        break;
      case "grabber":
        k.grab = GRAB_TIME;
        k.grabCd = 0.3;
        break;
      case "horn":
        this.horn(k, karts);
        break;
      case "coin":
        k.coins = Math.min(MAX_COINS, k.coins + 2);
        k.boostTime = Math.max(k.boostTime, 0.3);
        this.events.push({ kind: "coin", kart: k });
        break;
      case "phantom":
        k.phantom = PHANTOM_TIME;
        this.steal(k, karts);
        break;
      case "jackpot":
        break; // (handled in use)
    }
  }

  /** A puck, a flare or an orb thrown back, off the kart along ``aim``. Thrown ahead it carries
   * the kart's speed; thrown back it goes back down the road at its own. */
  private throwPuck(k: Kart, kind: Puck["kind"], aim: number): void {
    const speed = kind === "flare" ? FLARE_SPEED : PUCK_SPEED;
    const a = k.heading + aim, v = Math.cos(aim) < 0 ? speed + 4 : Math.max(k.v, 8) + speed;
    const c = Math.cos(a), s = Math.sin(a);
    this.pucks.push({
      kind, idx: k.idx, x: k.x + c * 2.2, y: k.y + s * 2.2, z: k.ground + (kind === "flare" ? 0.8 : kind === "orb" ? 0.45 : 0.35),
      vz: kind === "flare" ? 3 : 0, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, bounces: 0, owner: k,
    });
  }

  /** The horn: karts close by spin, and every item near is knocked out of the air. */
  private horn(k: Kart, karts: Kart[]): void {
    const near = (x: number, y: number, r: number) => (x - k.x) ** 2 + (y - k.y) ** 2 < r * r;
    for (const o of karts) {
      if (o === k || o.finished || !near(o.x, o.y, HORN_R) || Math.abs(o.elev - k.elev) > 2.5) continue;
      if (o.spinOut(0.9)) this.events.push({ kind: "spun", kart: o, by: "horn", owner: k });
    }
    this.slicks = this.slicks.filter((it) => !near(it.x, it.y, HORN_CLEAR));
    this.orbs = this.orbs.filter((it) => !near(it.x, it.y, HORN_CLEAR));
    this.pucks = this.pucks.filter((it) => !near(it.x, it.y, HORN_CLEAR));
    this.boomerangs = this.boomerangs.filter((it) => it.owner === k || !near(it.x, it.y, HORN_CLEAR));
    this.bombs = this.bombs.filter((it) => !near(it.x, it.y, HORN_CLEAR));
    this.comets = this.comets.filter((it) => !near(it.x, it.y, HORN_COMET));
    this.rings.push({ kart: k, age: 0 });
    this.events.push({ kind: "horn", kart: k });
  }

  /** The phantom takes the item of a kart that has one (one ahead of it if it can), and it comes
   * over to the thief a moment later. */
  private steal(k: Kart, karts: Kart[]): void {
    const has = (o: Kart) => o !== k && !!o.item && o.roulette <= 0 && o.rocket <= 0 && !o.falling && o.item !== "phantom";
    const ahead = karts.filter((o) => has(o) && o.dist > k.dist);
    const pool = ahead.length ? ahead : karts.filter(has);
    if (!pool.length) return;
    const victim = pool[Math.floor(this.rng.next() * pool.length)];
    const item = victim.item!;
    this.clear(victim);
    k.loot = { item, t: LOOT_FLIGHT };
    this.events.push({ kind: "stolen", kart: victim, by: k, item });
  }

  /** The nearest kart ahead in race distance, within range, that can be hit. */
  targetAhead(k: Kart, karts: Kart[]): Kart | null {
    let best: Kart | null = null;
    for (const o of karts) {
      if (o === k || o.finished || o.phantom > 0) continue;
      const gap = o.dist - k.dist;
      if (gap > 0 && gap < ORB_RANGE && (!best || gap < best.dist - k.dist)) best = o;
    }
    return best;
  }

  /** The hit a projectile from (x, y) brings to ``k``: soaked up by a puck or an orb circling it,
   * or by an item held out behind it (from behind only), shrugged off by a prism or a rocket, or
   * a spin. (A phantom is never reached: callers skip it.) */
  private strike(k: Kart, x: number, y: number, by: SpinCause, owner: Kart, time = SPIN_TIME): void {
    if (k.invincible || k.falling) return;
    if (k.item && ORBITS.has(k.item) && k.uses > 0 && k.roulette <= 0) {
      k.uses -= 1;
      if (k.uses <= 0) this.clear(k);
      this.events.push({ kind: "blocked", kart: k });
      return;
    }
    if (this.shielded(k, x, y)) return;
    if (k.spinOut(time)) this.events.push({ kind: "spun", kart: k, by, owner });
  }

  /** An item held out behind ``k`` (or the oil of a triple trailing it) soaks up a hit from
   * behind: true (and the item is gone, or one oil of the three). */
  private shielded(k: Kart, x: number, y: number): boolean {
    const behind = (x - k.x) * Math.cos(k.heading) + (y - k.y) * Math.sin(k.heading) < 0.4;
    if (!behind || !k.item || k.roulette > 0) return false;
    if (k.item === "oil3" && k.uses > 0) {
      k.uses -= 1;
      if (k.uses <= 0) this.clear(k);
    } else if (k.trailing) {
      this.clear(k);
    } else {
      return false;
    }
    this.events.push({ kind: "blocked", kart: k });
    return true;
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

  /** An explosion of ``radius`` m: everyone in it spins (the ``center`` kart, if any, for longer),
   * whatever they hold, and every item in it is gone; other bombs go off too. */
  private blast(x: number, y: number, z: number, karts: Kart[], radius: number, by: SpinCause, owner: Kart,
                center: Kart | null = null): void {
    const inside = (px: number, py: number, pz: number) => (px - x) ** 2 + (py - y) ** 2 < radius * radius && Math.abs(pz - z) < 3;
    for (const k of karts) {
      if (k.finished || !inside(k.x, k.y, k.elev)) continue;
      if (k.spinOut(k === center ? 2 : 1.25)) this.events.push({ kind: "spun", kart: k, by, owner });
    }
    this.slicks = this.slicks.filter((it) => !inside(it.x, it.y, it.elev));
    this.orbs = this.orbs.filter((it) => (it.x - x) ** 2 + (it.y - y) ** 2 >= radius * radius);
    this.pucks = this.pucks.filter((it) => !inside(it.x, it.y, it.z));
    const chain = this.bombs.filter((b) => b.landed && inside(b.x, b.y, b.z));
    this.bombs = this.bombs.filter((b) => !chain.includes(b));
    this.blasts.push({ x, y, z, age: 0, size: radius / BOMB_BLAST });
    this.events.push({ kind: "boom", x, y, big: radius > BOMB_BLAST });
    for (const b of chain) this.blast(b.x, b.y, b.z, karts, BOMB_BLAST, "bomb", b.owner);
  }

  update(dt: number, track: Track, karts: Kart[], field: Field): void {
    for (const [i, t] of this.cooldown) this.cooldown.set(i, t - dt);
    for (const sl of this.slicks) sl.road ??= track.elev[sl.idx] ?? 0; // (the road under a new slick)
    this.updateBoxes(dt, karts, field);
    this.updateKarts(dt, karts);
    this.updateSlicks(dt, karts);
    this.updateOrbs(dt, track, karts);
    this.updatePucks(dt, track, karts);
    this.updateBoomerangs(dt, track, karts);
    this.updateBombs(dt, track, karts);
    this.updateComets(dt, track, karts, field);
    this.clashes(karts);
    this.blasts = this.blasts.filter((b) => (b.age += dt) < BLAST_TIME);
    this.rings = this.rings.filter((r) => (r.age += dt) < RING_TIME);
  }

  /** Boxes hand out items (odds by how far behind the leader, race/odds.ts); coins are picked up. */
  private updateBoxes(dt: number, karts: Kart[], field: Field): void {
    for (const b of this.boxes) {
      if (b.respawn > 0) {
        b.respawn -= dt;
        continue;
      }
      for (const k of karts) {
        if (k.finished || k.falling || Math.abs(k.elev - b.elev) > 1.8) continue;
        if ((k.x - b.x) ** 2 + (k.y - b.y) ** 2 > PICKUP_R * PICKUP_R) continue;
        b.respawn = BOX_RESPAWN;
        if (!k.item && k.roulette <= 0 && !k.loot) {
          this.grant(k, pickItem(itemOdds(field.standing(k), this.unavailable()), this.rng.next()));
          if (k.item === "comet") this.cooldown.set("comet", COOLDOWN.comet!);
          if (k.isPlayer) {
            k.roulette = ROULETTE;
            this.events.push({ kind: "roll", kart: k });
          } else this.events.push({ kind: "got", kart: k, item: k.item! });
        }
        break;
      }
    }
    for (const c of this.coins) {
      if (c.respawn > 0) {
        c.respawn -= dt;
        continue;
      }
      for (const k of karts) {
        if (k.finished || k.falling || Math.abs(k.elev - c.elev) > 1.8) continue;
        if ((k.x - c.x) ** 2 + (k.y - c.y) ** 2 > 1.3 * 1.3) continue;
        c.respawn = COIN_RESPAWN;
        k.coins = Math.min(MAX_COINS, k.coins + 1);
        this.events.push({ kind: "coin", kart: k });
        break;
      }
    }
  }

  /** The clocks of what each kart has going: the roulette, a gold turbo, flares, the grabber, a
   * phantom and the item it stole, static. */
  private updateKarts(dt: number, karts: Kart[]): void {
    for (const k of karts) {
      k.itemAge += dt;
      if (k.roulette > 0) {
        k.roulette -= dt;
        if (k.roulette <= 0 && k.item) this.events.push({ kind: "got", kart: k, item: k.item });
      }
      if (!k.item) k.trailing = false;
      if (k.gold > 0 && (k.gold -= dt) <= 0 && k.item === "gold") this.clear(k);
      if (k.flareCd > 0) k.flareCd -= dt;
      if (k.flares > 0 && (k.flares -= dt) <= 0 && k.item === "flares") this.clear(k);
      if (k.staticT > 0) k.staticT = Math.max(0, k.staticT - dt);
      if (k.phantom > 0) k.phantom = Math.max(0, k.phantom - dt);
      if (k.bite > 0) k.bite = Math.max(0, k.bite - dt);
      if (k.loot && (k.loot.t -= dt) <= 0) {
        const item = k.loot.item;
        k.loot = null;
        if (!k.item && k.roulette <= 0) {
          this.grant(k, item);
          this.events.push({ kind: "got", kart: k, item });
        }
      }
      if (k.grab > 0) this.grabber(dt, k, karts);
    }
  }

  /** The grabber snaps at whatever comes within reach in front of the kart (and now and then at
   * nothing): karts spin, items are gone, and every bite gives its kart a little boost. */
  private grabber(dt: number, k: Kart, karts: Kart[]): void {
    k.grab = Math.max(0, k.grab - dt);
    k.grabCd -= dt;
    if (k.grabCd > 0 || k.spin > 0) return;
    const c = Math.cos(k.heading), s = Math.sin(k.heading);
    const reach = (x: number, y: number) => {
      const dx = x - k.x, dy = y - k.y, f = dx * c + dy * s;
      return f > 0.5 && f < GRAB_REACH && Math.abs(Math.atan2(-dx * s + dy * c, f)) < GRAB_ARC;
    };
    const victims = karts.filter((o) => o !== k && !o.finished && o.phantom <= 0 && reach(o.x, o.y) &&
      Math.abs(o.elev - k.elev) < 2);
    const items = this.slicks.some((it) => reach(it.x, it.y)) || this.pucks.some((it) => reach(it.x, it.y)) ||
      this.orbs.some((it) => reach(it.x, it.y)) || this.bombs.some((it) => reach(it.x, it.y));
    if (!victims.length && !items && k.grabCd > -1.6) return; // nothing to bite yet
    for (const o of victims) this.strike(o, k.x, k.y, "grabber", k, 0.9);
    this.slicks = this.slicks.filter((it) => !reach(it.x, it.y));
    this.pucks = this.pucks.filter((it) => !reach(it.x, it.y));
    this.orbs = this.orbs.filter((it) => !reach(it.x, it.y));
    this.bombs = this.bombs.filter((it) => !reach(it.x, it.y));
    k.bite = 0.3;
    k.grabCd = 0.8;
    k.boostTime = Math.max(k.boostTime, 0.45);
    this.events.push({ kind: "bite", kart: k });
  }

  private updateSlicks(dt: number, karts: Kart[]): void {
    this.slicks = this.slicks.filter((sl) => {
      sl.ttl -= dt;
      sl.armed -= dt;
      if (sl.ttl <= 0) return false;
      for (const k of karts) {
        if (k === sl.owner && sl.armed > 0) continue;
        if (k.spin > 0 || k.air || k.falling || k.phantom > 0 || Math.abs(k.elev - sl.elev) > 1.2) continue;
        if ((k.x - sl.x) ** 2 + (k.y - sl.y) ** 2 > SLICK_R * SLICK_R) continue;
        if (k.spinOut()) this.events.push({ kind: "spun", kart: k, by: "oil", owner: sl.owner });
        return false; // driven through (an invincible kart just splashes it away)
      }
      return true;
    });
  }

  /** Dream orbs fly up the road and home onto their target once close. */
  private updateOrbs(dt: number, track: Track, karts: Kart[]): void {
    this.orbs = this.orbs.filter((o) => {
      o.ttl -= dt;
      if (o.ttl <= 0) return false;
      const step = o.v * dt;
      // a target that is already spinning (or done, or out of reach) is left alone: the orb flies on
      if (o.target && (o.target.spin > 0 || o.target.finished || o.target.falling || o.target.phantom > 0)) o.target = null;
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
        if (k === o.owner || k.spin > 0 || k.falling || k.phantom > 0 || Math.abs(k.elev - oz) > 2.2) continue;
        if ((k.x - o.x) ** 2 + (k.y - o.y) ** 2 > ORB_R * ORB_R) continue;
        this.strike(k, o.x, o.y, "orb", o.owner);
        return false;
      }
      return true;
    });
  }

  /** Pucks slide along where they were thrown and flares hop; both bounce off the edges of the
   * road, and the first kart either meets spins (a puck's own thrower too, once it is clear). */
  private updatePucks(dt: number, track: Track, karts: Kart[]): void {
    this.pucks = this.pucks.filter((p) => {
      p.t += dt;
      const flare = p.kind === "flare";
      if (p.t > (flare ? FLARE_LIFE : PUCK_LIFE) || p.bounces > (flare ? 3 : PUCK_BOUNCES)) return false;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.idx = track.nearest(p.x, p.y, p.idx);
      if (!track.locked && p.idx >= track.count - 2) return false; // into the dream mist
      const ground = track.elev[p.idx] ?? 0;
      if (flare) {
        p.vz -= GRAVITY * 0.6 * dt;
        p.z += p.vz * dt;
        if (p.z <= ground + 0.25) {
          p.z = ground + 0.25;
          p.vz = 4.2;
        }
      } else {
        p.z = ground + (p.kind === "orb" ? 0.45 : 0.35);
      }
      // the edges of the road (the walls on raised road): bounce back in
      const off = track.offset(p.x, p.y, p.idx), edge = ground > 0.8 ? HALF_WIDTH - 0.6 : HALF_WIDTH + 1.6;
      if (Math.abs(off) > edge) {
        const [tx, ty] = track.tangent(p.idx);
        const nx = -ty, ny = tx, out = p.vx * nx + p.vy * ny; // left of the road is +n
        if (out * off > 0) {
          p.vx -= 2 * out * nx;
          p.vy -= 2 * out * ny;
          p.bounces += 1;
          this.events.push({ kind: "bounce", x: p.x, y: p.y });
        }
        const back = Math.abs(off) - edge;
        p.x -= nx * Math.sign(off) * back;
        p.y -= ny * Math.sign(off) * back;
      }
      for (const k of karts) {
        if (k.finished || k.spin > 0 || k.falling || k.phantom > 0 || Math.abs(k.elev - ground) > 1.6) continue;
        if (k === p.owner && p.t < 0.5) continue; // clear of its thrower first
        if ((k.x - p.x) ** 2 + (k.y - p.y) ** 2 > PUCK_R * PUCK_R) continue;
        this.strike(k, p.x, p.y, flare ? "flare" : p.kind === "orb" ? "orb" : "puck", p.owner, flare ? 0.8 : SPIN_TIME);
        return false;
      }
      return true;
    });
  }

  /** Boomerangs go out where they were aimed, then home to the thrower, hitting everyone on the way. */
  private updateBoomerangs(dt: number, track: Track, karts: Kart[]): void {
    this.boomerangs = this.boomerangs.filter((b) => {
      b.t += dt;
      if (b.t > BOOM_LIFE) return false;
      if (!b.home) {
        if (b.t > BOOM_OUT) b.home = true;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      } else {
        const o = b.owner;
        const d = Math.hypot(o.x - b.x, o.y - b.y);
        if (d < 1.8) return false; // caught
        const step = Math.min(d, BOOM_HOME * dt);
        b.x += ((o.x - b.x) / d) * step;
        b.y += ((o.y - b.y) / d) * step;
        b.z += (o.elev + 0.9 - b.z) * Math.min(1, dt * 4);
      }
      b.idx = track.nearest(b.x, b.y, b.idx);
      for (const k of karts) {
        if (k === b.owner || b.hit.includes(k) || k.falling || k.phantom > 0 || Math.abs(k.elev + 0.9 - b.z) > 2.2) continue;
        if ((k.x - b.x) ** 2 + (k.y - b.y) ** 2 > BOOM_R * BOOM_R) continue;
        b.hit.push(k);
        const before = this.events.length;
        this.strike(k, b.x, b.y, "boomerang", b.owner);
        if (this.events.slice(before).some((e) => e.kind === "blocked")) return false; // a shield stopped it
      }
      return true;
    });
  }

  /** Bombs: a lob, then a chase after the racer one place ahead, and an explosion that spins
   * everyone near; or, from the leader, a landing where it was aimed and a wait for whoever comes
   * close. */
  private updateBombs(dt: number, track: Track, karts: Kart[]): void {
    const going: Bomb[] = [];
    this.bombs = this.bombs.filter((bm) => {
      bm.age += dt;
      const t = bm.target;
      if (t) {
        if (t.finished || t.falling || bm.age > BOMB_CHASE) {
          going.push(bm);
          return false;
        }
        if (bm.age > 0.25) {
          // homing: steer toward the target, skimming over the road at its height
          const dx = t.x - bm.x, dy = t.y - bm.y, d = Math.hypot(dx, dy) || 1;
          const speed = Math.max(Math.hypot(bm.vx, bm.vy), Math.max(t.v, 0) + 14);
          const turn = Math.min(1, dt * 5);
          bm.vx += ((dx / d) * speed - bm.vx) * turn;
          bm.vy += ((dy / d) * speed - bm.vy) * turn;
          bm.vz = 0;
          bm.z += (t.elev + 1.1 - bm.z) * Math.min(1, dt * 4);
        } else {
          bm.vz -= this.gravity * dt;
          bm.z += bm.vz * dt;
        }
        bm.x += bm.vx * dt;
        bm.y += bm.vy * dt;
        bm.idx = track.nearest(bm.x, bm.y, bm.idx);
        const close = (t.x - bm.x) ** 2 + (t.y - bm.y) ** 2 < BOMB_HIT ** 2 && Math.abs(t.elev + 1.1 - bm.z) < 2.5;
        if (!close) return true;
        going.push(bm);
        return false;
      }
      if (!bm.landed) {
        bm.x += bm.vx * dt;
        bm.y += bm.vy * dt;
        bm.vz -= this.gravity * dt;
        bm.z += bm.vz * dt;
        bm.idx = track.nearest(bm.x, bm.y, bm.idx);
        const ground = track.elev[bm.idx] ?? 0;
        if (bm.z <= ground && bm.vz < 0) {
          bm.z = ground;
          bm.landed = true;
          bm.age = 0; // from here on, age counts the wait
        }
        return true;
      }
      const armed = bm.age > 0.6; // its thrower gets a moment to drive clear
      const close = armed && karts.some((k) => !k.falling && k.phantom <= 0 &&
        Math.abs(k.elev - bm.z) < 2 && (k.x - bm.x) ** 2 + (k.y - bm.y) ** 2 < BOMB_TRIGGER ** 2);
      if (bm.age < MINE_LIFE && !close) return true;
      going.push(bm);
      return false;
    });
    for (const bm of going) this.blast(bm.x, bm.y, bm.z, karts, BOMB_BLAST, "bomb", bm.owner, bm.target);
  }

  /** Comets fly up the road over everyone to the leader (whoever leads by then), hang over them
   * for a moment, and come down: a big blast. */
  private updateComets(dt: number, track: Track, karts: Kart[], field: Field): void {
    const going: Comet[] = [];
    this.comets = this.comets.filter((c) => {
      c.t += dt;
      if (c.phase === "fly") {
        const lead = field.leader();
        c.target = lead;
        if (!lead) return false;
        const step = COMET_SPEED * dt;
        c.dist += step;
        if (!this.advance(c, track, step)) c.idx = lead.idx; // (the road ahead is not dreamed yet)
        c.x = track.xs[c.idx];
        c.y = track.ys[c.idx];
        c.z = (track.elev[c.idx] ?? 0) + COMET_HEIGHT;
        if (c.dist >= lead.dist - 6 || c.t > 12) {
          c.phase = "hover";
          c.t = 0;
        }
        return true;
      }
      const t = c.target;
      if (!t || t.finished) return false;
      c.x = t.x;
      c.y = t.y;
      c.idx = t.idx;
      if (c.phase === "hover") {
        c.z = t.elev + COMET_HEIGHT - c.t * 0.6;
        if (c.t > COMET_HOVER) {
          c.phase = "dive";
          c.t = 0;
        }
        return true;
      }
      c.z = t.elev + (COMET_HEIGHT - COMET_HOVER * 0.6) * Math.max(0, 1 - c.t / COMET_DIVE);
      if (c.t < COMET_DIVE) return true;
      going.push(c);
      return false;
    });
    for (const c of going) {
      this.blast(c.x, c.y, c.target?.elev ?? c.z, karts, COMET_BLAST, "comet", c.owner, c.target);
      this.cooldown.set("comet", COOLDOWN.comet!);
    }
  }

  /** Items meeting each other: two projectiles, or a projectile and an oil slick, take each other
   * out; a projectile into a bomb sets it off. */
  private clashes(karts: Kart[]): void {
    const flying: { it: object; x: number; y: number; owner: Kart }[] = [
      ...this.pucks.map((p) => ({ it: p as object, x: p.x, y: p.y, owner: p.owner })),
      ...this.orbs.map((o) => ({ it: o as object, x: o.x, y: o.y, owner: o.owner })),
    ];
    if (!flying.length) return;
    const gone = new Set<object>();
    for (let i = 0; i < flying.length; i++) {
      const a = flying[i];
      if (gone.has(a.it)) continue;
      for (let j = i + 1; j < flying.length; j++) {
        const b = flying[j];
        // (one kart's own shots never take each other out: a triple goes up the road in a stream)
        if (gone.has(b.it) || a.owner === b.owner || (a.x - b.x) ** 2 + (a.y - b.y) ** 2 > 1.3 * 1.3) continue;
        gone.add(a.it);
        gone.add(b.it);
        this.events.push({ kind: "clash", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        break;
      }
      if (gone.has(a.it)) continue;
      const sl = this.slicks.find((s) => (s.x - a.x) ** 2 + (s.y - a.y) ** 2 < SLICK_R * SLICK_R);
      if (sl) {
        gone.add(a.it);
        gone.add(sl);
        this.events.push({ kind: "clash", x: a.x, y: a.y });
        continue;
      }
      const bm = this.bombs.find((b) => (b.x - a.x) ** 2 + (b.y - a.y) ** 2 < 1.5 * 1.5);
      if (bm) {
        gone.add(a.it);
        gone.add(bm);
      }
    }
    if (!gone.size) return;
    const hit = this.bombs.filter((b) => gone.has(b));
    this.pucks = this.pucks.filter((p) => !gone.has(p));
    this.orbs = this.orbs.filter((o) => !gone.has(o));
    this.slicks = this.slicks.filter((s) => !gone.has(s));
    this.bombs = this.bombs.filter((b) => !gone.has(b));
    for (const b of hit) this.blast(b.x, b.y, b.z, karts, BOMB_BLAST, "bomb", b.owner);
  }
}
