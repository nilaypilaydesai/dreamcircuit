// The race director: grid, countdown (with rocket starts), live circuit generation during lap 1
// (steered by the track type and by how the player drives), laps, positions, finish and results.
// Owns the karts, the circuit, its bridges, climbs, ramps and boost pads, the ground texture and
// the scenery, and makes good what the track type confirms when the lap locks.

import { Rand, type Sprite } from "../core/gfx";
import type { Theme } from "../themes";
import { BANK_AT, BANK_LEAN, type Bank } from "../world/banks";
import { type FallKind, type Hazard, inHazard, placeHazards } from "../world/hazards";
import { Scenery } from "../world/scenery";
import { WorldTexture } from "../world/texture";
import { FIRST_SEG, HALF_WIDTH, type Layout, N, SPACING, Track } from "../world/track";
import { tubeAt } from "../world/tube";
import { type Designer, LiveCircuit } from "../world/trackgen";
import { RivalDriver } from "./ai";
import { Features, PAD_LEN, type Pad, RAMP_LEN, TUNNEL_LEN } from "./features";
import { AIMED, AIM_MAX, AIM_RATE, type Field, type ItemKind, Items, ROCKET_TAIL, rocketPasses } from "./items";
import { ALLEY_AT, ALLEY_DEPTH, type ObstacleSite, type ObstacleSound, Obstacles, alleyBlocks } from "./obstacles";
import { CLASSES, type Controls, type Difficulty, FALL_SWAP, GRAVITY, Kart, WALL_FALL_TILT, WING_TIME, collideKarts } from "./kart";
import type { Standing } from "./odds";
import { type Build, DEFAULT_BUILD, rivalBuild } from "./parts";
import {
  type ClimbKind, DEFAULT_PADS, DEFAULT_RAMPS, type HillRule, type TrackType, type TrackTypeId, trackType,
} from "./tracktypes";
import { LIVERIES } from "../render/sprites";

export const LAPS = 3;
const FRONTIER_HOLD = 60; // m: below this much dreamed road ahead, speed is capped
const WINGS_LOW = 2; // s of wings left when a player high on a wall of the tube is told to come down

export type RaceEvent =
  | { kind: "count"; n: number }
  | { kind: "go" }
  | { kind: "lap"; lap: number; final: boolean }
  | { kind: "locked" }
  | { kind: "finish"; place: number }
  | { kind: "boost" }
  | { kind: "bump" }
  | { kind: "roll" } // the player drove through an item box
  | { kind: "item"; item: ItemKind } // the player's item slot settled
  | { kind: "use"; item: ItemKind } // the player fired an item
  | { kind: "aimLocked" } // the player locked the arrow of an aimed item
  | { kind: "coin" } // the player picked up a coin
  | { kind: "static" } // the player's screen is full of static
  | { kind: "comet"; you: boolean } // a comet is on its way to the leader (you: the player leads)
  | { kind: "stolen"; item: ItemKind } // a phantom took the player's item
  | { kind: "steal"; item: ItemKind } // the player's phantom took someone's item
  | { kind: "clash"; near: boolean } // two items took each other out
  | { kind: "horn"; near: boolean } // someone blew a horn
  | { kind: "bite" } // the player's grabber snapped
  | { kind: "bounce"; near: boolean } // a puck or a flare bounced off the edge of the road
  | { kind: "spun" } // the player was spun out
  | { kind: "hit" } // the player's item (or prism, or rocket) spun out a rival
  | { kind: "blocked" } // the item held behind the player soaked up a hit
  | { kind: "boom"; near: boolean; big: boolean } // a bomb or a comet went off (near the player: shake the camera)
  | { kind: "shock" } // someone used a shock: the screen flashes
  | { kind: "rocketOver" } // the player's rocket has burned out
  | { kind: "jump" } // the player left a ramp
  | { kind: "land"; trick: 0 | 1 | 2 } // and came down (with a trick grade)
  | { kind: "pad" } // the player hit a boost pad
  | { kind: "wings"; first: boolean } // a wing pad (in the tunnel's tube): wings, for the walls and the roof
  | { kind: "wingsOff" } // and they ran out
  | { kind: "wingsLow" } // they are running out, and the player is up a wall where they will fall without them
  | { kind: "needWings"; first: boolean } // the player drove at a wall of the tube without them
  | { kind: "rocket" } // a perfectly timed start
  | { kind: "burnout" } // throttle held too early: wheels spin at GO
  | { kind: "bridge" } // the dream crossed itself and built a bridge
  | { kind: "lava" } // the player drove into the lava
  | { kind: "fell"; into: FallKind } // or into a hazard, or off the edge of raised road
  | { kind: "rescued" } // and was lifted out at the road (the camera cuts there)
  | { kind: "obstacle"; sound: ObstacleSound; near: boolean }; // a cow, a police car, a geyser... (race/obstacles.ts)

export interface RaceSetup {
  rivals: number; // 0..7
  difficulty: Difficulty;
  theme: Theme;
  seed: number;
  replay: Float64Array | null; // points of a locked circuit to race again (game meters)
  layout?: Layout; // what the designer is asked for (default: the track type's)
  trackType?: TrackTypeId; // what the circuit is sure to have (default: the classic)
  build?: Build; // the player's kart from the garage (default: the classic kart)
  rivalSeed?: number; // the rivals' karts (a Grand Prix keeps them for every race)
}

/** Whether the player's controls reach the race: while racing, and during the countdown, where
 * the throttle decides a rocket start (pressed just before GO) or a burnout (held too long). */
const OPEN_EDGES = new Set(["girder", "scaffold", "foundation", "basalt"]); // raised road a kart can fall off
const HILL_LOOK = 100; // m of road past a climb's foot that is known before the climb is decided
const BRIDGE_CLEAR = 95; // m of road kept free of jumps and pads around a bridge's crossing
const UNDER_CLEAR = 80; // m around the road that passes under a bridge

export function takesControls(phase: Race["phase"]): boolean {
  return phase === "racing" || phase === "countdown";
}

/** A building beside the road, in road terms: along arc lengths [s0, s0 + len), from ``inner`` to
 * ``outer`` m out from the middle of the road on ``side`` (1 the left, -1 the right). */
interface Footprint { s0: number; len: number; side: number; inner: number; outer: number }
const KART_R = 0.5; // m: how near a building's face a kart's middle comes
/** A cutting's walls: from their foot to the back of their top. */
const bankFootprint = (b: Bank): Footprint => ({ s0: b.s0, len: b.len, side: b.side, inner: BANK_AT, outer: BANK_AT + BANK_LEAN[b.style] * b.h + 4 });
/** The building a Tokyo tunnel runs under, on one side: from just past the tunnel's walls (inside,
 * they hold a kart) out to its outer walls (render/structures.ts). */
const tunnelFootprint = (s0: number, side: number): Footprint => ({ s0, len: TUNNEL_LEN, side, inner: HALF_WIDTH + 2, outer: HALF_WIDTH + 9.4 });
/** A police alley's two buildings and the alley between them (race/obstacles.ts). */
const alleyFootprint = (st: ObstacleSite): Footprint => {
  const a = alleyBlocks(st);
  return { s0: st.s + a.a0, len: a.b1 - a.a0, side: st.side, inner: ALLEY_AT, outer: ALLEY_AT + ALLEY_DEPTH };
};

/** The road point at arc length ``s`` or just past it. */
function indexAtS(t: Track, s: number): number {
  const L = t.locked ? t.length : 0, x = L ? ((s % L) + L) % L : s;
  let lo = 0, hi = t.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t.s[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether arc length ``s``, ``off`` m left of the middle of the road, is within ``m`` m of building
 * ``fp``. */
function inside(t: Track, fp: Footprint, s: number, off: number, m: number): boolean {
  const u = alongLap(t, fp.s0, s), o = off * fp.side;
  return u > -m && u < fp.len + m && o > fp.inner - m && o < fp.outer + m;
}

/** How far along the road arc length ``s`` is past ``s0`` (round the lap, once it is locked: within
 * half a lap either way). */
function alongLap(t: Track, s0: number, s: number): number {
  const d = s - s0, L = t.locked ? t.length : 0;
  return L ? ((((d + L / 2) % L) + L) % L) - L / 2 : d;
}

export class Race {
  phase: "dreaming" | "countdown" | "racing" | "done" = "dreaming";
  readonly track: Track;
  readonly live: LiveCircuit | null;
  readonly tex: WorldTexture;
  readonly scenery: Scenery;
  readonly items: Items;
  /** What gets in the way on the road in this world (cows, police, a wrecking ball...). */
  readonly obstacles: Obstacles;
  readonly features: Features;
  readonly karts: Kart[] = [];
  readonly player: Kart;
  private readonly drivers: RivalDriver[] = [];
  readonly cls;
  clock = 0; // seconds since GO
  countdown = 4; // 3, 2, 1, GO
  events: RaceEvent[] = [];
  standings: Kart[] = [];
  lockedAt = -1;
  private readonly rng: Rand;
  private doneTimer = 0;
  private throttleHeld = 0; // s the player has held the throttle during the countdown
  private nextHill: number; // m of road before the next climb may start
  private hillTurn: number; // which of the world's kinds of climb is next (they take turns)
  private hillTries = 0; // places the next one did not fit
  private hillScan = 1; // the first dense index no climb has been decided for
  private bankScan = 1; // the first dense index no cutting has been decided for
  private nextBank = 160; // m of road before the next cutting may start
  private standAt: Footprint | null = null; // the grandstand by the start, in road terms (once it stands)
  private readonly bankRng: Rand;
  private cranes: number[] = []; // m along the lap of girders' middles not yet dreamed (a crane goes up there)
  private readonly hillRng: Rand;
  /** What a kart can drive into off the road (world/hazards.ts), set out when the lap locks. */
  hazards: Hazard[] = [];
  readonly type: TrackType;
  private readonly hillRule: HillRule | null; // climbs: the track type's, or the world's
  private aimPhase = 0; // where the player's aiming arrow is in its sweep
  private winged = false; // the player has had a wing pad's wings this race
  private wingHint = -Infinity; // race clock when the player was last told walls need wings
  private bridgesSeen = 0;
  /** How the player is driving lap 1 (smoothed), which sets the style of the road ahead. */
  readonly driving = { speed: 0.7, offroad: 0, drift: 0, clean: 1 };

  constructor(readonly setup: RaceSetup, designer: Designer | null, banner: (s: Sprite) => void) {
    this.rng = new Rand(setup.seed);
    this.hillRng = new Rand(setup.seed + 21);
    this.bankRng = new Rand(setup.seed + 53);
    this.hillTurn = this.hillRng.int(0, 6);
    this.type = trackType(setup.trackType);
    this.hillRule = this.type.hills ?? setup.theme.hills ?? null;
    this.nextHill = this.hillRule ? Math.max(60, this.hillRule.gap[1]) : Infinity;
    this.features = new Features({
      tunnels: !!setup.theme.tunnels, ramps: this.type.ramps ?? DEFAULT_RAMPS, pads: this.type.pads ?? DEFAULT_PADS,
      gravity: setup.theme.gravity ?? 1, tube: !!setup.theme.tube,
    });
    this.cls = CLASSES[setup.difficulty];
    this.tex = new WorldTexture(setup.theme, setup.seed);
    this.scenery = new Scenery(setup.theme, setup.seed + 1, banner);
    this.scenery.inWall = (x, y) => this.inBuilding(x, y, 1.5);
    this.items = new Items(new Rand(setup.seed + 3));
    this.obstacles = new Obstacles(setup.theme.obstacle ?? null, new Rand(setup.seed + 41));
    this.obstacles.pace = { vmax: this.cls.vmax, grip: this.cls.grip };
    this.obstacles.strike = (x, y, z) => this.items.hitsCar(x, y, z);
    this.items.ground = (x, y, hint) => {
      const t = this.track, i = t.nearest(x, y, hint);
      return { idx: i, h: (t.elev[i] ?? 0) + this.features.rampAt(t.s[i], t.offset(x, y, i)).height };
    };
    this.obstacles.wallAt = (s, side) => !!this.features.bankAt(s, side);
    this.items.gravity = GRAVITY * (setup.theme.gravity ?? 1);
    // a map is a layout: each world draws it at its own scale (the moon's are bigger)
    const scale = setup.theme.scale ?? 1;
    if (setup.replay) {
      this.live = null;
      this.track = new Track();
      this.track.addKnown(Array.from({ length: N }, (_, j) => j), setup.replay.map((v) => v * scale));
      this.onCommit(0, this.track.count);
      this.onLock();
    } else {
      if (!designer) throw new Error("the circuit designer is not loaded");
      this.live = new LiveCircuit(designer, new Rand(setup.seed + 2), setup.layout ?? this.type.layout, scale);
      this.track = this.live.track;
      this.live.onCommit = (a, b) => this.onCommit(a, b);
      this.live.onRaise = (a, b) => this.onRaise(a, b);
      this.live.onLock = () => this.onLock();
      this.live.styleSource = (arc) => this.styleFor(arc);
      this.live.bandSource = (arc) => this.type.band?.(arc) ?? null;
    }
    const n = setup.rivals + 1;
    const order = Array.from({ length: n }, (_, i) => i);
    // the player starts in the middle of the pack, like the classics; rivals drive random builds
    // from the garage, better ones in the harder classes
    const playerSlot = Math.min(n - 1, Math.floor(n / 2));
    this.player = new Kart(0, LIVERIES[0].name, 0, true).equip(setup.build ?? DEFAULT_BUILD);
    const garage = new Rand(setup.rivalSeed ?? setup.seed + 11);
    let rivalNo = 1;
    for (const slot of order) {
      const k = slot === playerSlot ? this.player
        : new Kart(rivalNo, LIVERIES[rivalNo].name, rivalNo++, false).equip(rivalBuild(garage, setup.difficulty));
      this.karts.push(k);
      if (!k.isPlayer) this.drivers.push(new RivalDriver(this.rng, k, slot));
    }
    for (const k of this.karts) {
      k.gravity = this.items.gravity;
      k.tube = !!setup.theme.tube;
    }
    this.standings = [...this.karts];
  }

  /** Whether arc lengths [s, s + len) are taken: item rows (unless ``rows`` is false: a climb
   * can carry a row of boxes), bridges, or the run to the line. */
  private blocked(s: number, len: number, rows = true): boolean {
    const t = this.track;
    return rows && this.items.rowS.some((r) => r > s - 12 && r < s + len + 12) ||
      // keep clear of bridges: the deck and its approach ramps span about 61 m either side of the
      // crossing, and a jump needs room to land; and around the road that passes under it
      t.bridges.some((b) => Math.abs(b.centerS - s - len / 2) < BRIDGE_CLEAR ||
        Math.abs(t.s[b.lower] - s - len / 2) < UNDER_CLEAR) ||
      t.locked && (s + len > t.length - 80);
  }

  /** Whether road [s, s + len) is free for an obstacle: no bridge, item row or run to the line, no
   * jump (or where its karts land) and no tunnel. */
  private readonly roadFree = (s: number, len: number): boolean =>
    !this.blocked(s, len) && !this.features.rampNear(s - 10, len + 20) &&
    !this.features.tunnels.some((tn) => tn.s0 < s + len + 10 && tn.s0 + TUNNEL_LEN > s - 10);

  /** Whether any kart is on, or coming up to, arc lengths [s, s + len) (what is built at the lock
   * must not appear under a kart or right in front of it). */
  private kartsNear(s: number, len: number): boolean {
    const t = this.track, L = t.length || 1;
    return this.karts.some((k) => ((((t.s[k.idx] - (s - 70)) % L) + L) % L) < len + 90);
  }

  private onCommit(from: number, to: number): void {
    const t = this.track;
    const blocked = (s: number, len: number) => this.blocked(s, len);
    this.tex.paintRoad(t, from, to);
    this.scenery.onCommit(t, from, to);
    this.giveWay(from, to);
    this.items.onCommit(t, from, to);
    const tunnels = this.features.tunnels.length;
    this.features.onCommit(t, from, to, blocked, () => this.rng.next());
    // (nor a building a new tunnel runs under where road dreamed before passes it)
    if (this.setup.theme.tunnels === "city") {
      this.features.tunnels = this.features.tunnels.filter((tn, n) => n < tunnels ||
        ![1, -1].some((side) => this.inWayOf(tunnelFootprint(tn.s0, side), 0, t.count)));
    }
    // nothing grows inside a new tunnel's rock
    for (const tn of this.features.tunnels.slice(tunnels)) this.scenery.clearAlong(t, tn.start, tn.start + tn.n, HALF_WIDTH + 10);
    while (this.bridgesSeen < t.bridges.length) {
      const b = t.bridges[this.bridgesSeen++];
      this.scenery.onBridge(t, b);
      // a ramp dreamed earlier on the road that now runs under the deck would launch karts into
      // it, and one on road that has just been lifted into the bridge would sit under the deck
      const under = t.s[b.lower];
      this.features.ramps = this.features.ramps.filter((r) =>
        Math.abs(r.s0 - under) > UNDER_CLEAR && Math.abs(r.s0 - b.centerS) > BRIDGE_CLEAR);
      // and a pad on road lifted into the bridge would lie under its deck (pads are drawn on the
      // ground and on climbs, not on bridges): measured from its middle, as blocked() measures the
      // road a pad wants (from its start, the one put just clear of a bridge was taken away again,
      // and in the tunnel that left 750 m of floor without a wing pad)
      this.features.pads = this.features.pads.filter((pd) =>
        Math.abs(pd.s0 + PAD_LEN / 2 - under) >= UNDER_CLEAR && Math.abs(pd.s0 + PAD_LEN / 2 - b.centerS) >= BRIDGE_CLEAR);
      // and a climb where the bridge, or the road under it, goes would leave no headroom: flatten it
      // (and bring the item boxes and coins on it down with it: left where they were, they hung in
      // the air over the flattened road); a cutting's walls there, or anything standing beside the
      // road or coming in from its side (a cow, an alley, a crane's mast, a vent), would stand
      // through the deck
      const cleared = [[b.centerS - BRIDGE_CLEAR, b.centerS + BRIDGE_CLEAR], [under - UNDER_CLEAR, under + UNDER_CLEAR]];
      for (const [s0, s1] of cleared) {
        const r = t.removeHills(s0, s1);
        if (r) this.tex.repaint(t, r[0], r[1]);
      }
      this.items.relift(t);
      const there = (s0: number, s1: number) => cleared.some(([a, z]) => s0 < z && s1 > a);
      this.features.banks = this.features.banks.filter((bk) => !there(bk.s0, bk.s0 + bk.len));
      this.obstacles.clearWhere((s) => there(s - 10, s + 10));
      this.events.push({ kind: "bridge" });
    }
    // climbs, decided once the road a stretch past them is known and its jumps are placed (a
    // straight that earns a jump keeps it), until the lap locks
    this.placeHills(t.locked ? t.count : to - Math.round(HILL_LOOK / SPACING));
    this.raiseCranes(to);
    // what gets in the way (cows, geysers, police alleys...), and the cuttings, on road whose
    // climbs are decided
    this.placeObstacles(t.locked ? t.count : to - Math.round(HILL_LOOK / SPACING));
    this.placeBanks(t.locked ? t.count : to - Math.round(HILL_LOOK / SPACING));
  }

  /** What gets in the way, on road up to ``upto``: and no police alley's buildings where another
   * stretch of road passes them. */
  private placeObstacles(upto: number): void {
    const before = new Set(this.obstacles.sites);
    this.obstacles.place(this.track, upto, this.roadFree);
    if (this.obstacles.kind === "police") {
      this.obstacles.dropSites((st) => !before.has(st) && this.inWayOf(alleyFootprint(st), 0, this.track.count));
      // (nothing grows inside a new alley's buildings)
      const t = this.track, fresh = this.obstacles.sites.filter((st) => !before.has(st));
      if (fresh.length) {
        this.scenery.items = this.scenery.items.filter((it) => !fresh.some((st) => {
          const i = t.nearest(it.x, it.y, st.idx), s = t.s[i] + t.along(it.x, it.y, i), off = t.offset(it.x, it.y, i);
          return inside(t, alleyFootprint(st), s, off, 1.5);
        }));
      }
    }
  }

  /** A tower crane beside each girder's middle, once the road there has been dreamed. */
  private raiseCranes(to: number): void {
    const t = this.track;
    this.cranes = this.cranes.filter((sm) => {
      if (sm > t.s[to - 1]) return true;
      let lo = 0, hi = to - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t.s[mid] < sm) lo = mid + 1;
        else hi = mid;
      }
      this.scenery.onGirder(t, lo);
      return false;
    });
  }

  /** Set climbs along newly committed road, by the hill rule (the world's, or the track type's),
   * in the middle of the lap (clear of the grid and the line), away from bridges, item rows and
   * tunnels, and off the straights that may yet earn a jump. */
  private placeHills(upto: number): void {
    const t = this.track, rule = this.hillRule;
    if (!rule) return;
    for (let i = Math.max(1, this.hillScan); i < Math.min(upto, t.count); i++) {
      this.hillScan = i + 1;
      const s = t.s[i];
      if (s < this.nextHill) continue;
      const seg = t.segOf[i];
      if (seg < rule.segs[0] || seg > rule.segs[1]) continue;
      // what it is built as: the world's kinds of climb take turns (every lap has one of each),
      // each waiting a while for room before the next has its go; and how long and high
      const kind: ClimbKind | null = rule.kinds ? rule.kinds[this.hillTurn % rule.kinds.length] : null;
      const lr = kind?.len ?? rule.len, hr = kind?.h ?? rule.h;
      const len = this.hillRng.range(lr[0], lr[1]), h = this.hillRng.range(hr[0], hr[1]);
      const side = this.hillRng.next() < 0.5 ? 1 : -1;
      const tunnel = this.features.tunnels.some((tn) => tn.s0 < s + len + 20 && tn.s0 + TUNNEL_LEN > s - 20);
      // the lap is not closed yet: from the road per segment so far, keep the climb well short of
      // the line (segments after FIRST_SEG lead back to the grid)
      const perSeg = s / Math.max(1, (seg - FIRST_SEG + N) % N);
      const intoLine = seg + (len + 80) / Math.max(perSeg, 1) > N;
      const jump = this.features.rampNear(s - 30, len + 60);
      // (a long climb must clear a bridge, and the road under it, from end to end, not just at its middle)
      const bridged = t.bridges.some((b) => (b.centerS + BRIDGE_CLEAR > s - 10 && b.centerS - BRIDGE_CLEAR < s + len + 10) ||
        (t.s[b.lower] + UNDER_CLEAR > s - 10 && t.s[b.lower] - UNDER_CLEAR < s + len + 10));
      if (tunnel || jump || bridged || intoLine || this.blocked(s - 10, len + 20, false)) {
        this.nextHill = s + 15;
        if (++this.hillTries > 12) {
          this.hillTurn++;
          this.hillTries = 0;
        }
        continue;
      }
      // a straight that may yet earn a jump is left for it: the climb waits until past it
      if (this.features.jumpPending(s + len + 30)) {
        this.nextHill = s + 15;
        continue;
      }
      this.hillTurn++;
      this.hillTries = 0;
      // the road it lifts was painted flat: paint it again, and what stands on it rides up
      const r = t.addHill({ s0: s, len, h, shape: kind?.shape ?? "sine", style: kind?.style ?? this.setup.theme.hillStyle, side });
      if (r) {
        this.tex.repaint(t, r[0], r[1]);
        this.items.relift(t);
        this.scenery.clearAlong(t, r[0], r[1], HALF_WIDTH + 9);
      }
      if (kind?.style === "girder") this.cranes.push(s + len / 2);
      this.nextHill = s + len + this.hillRng.range(rule.gap[0], rule.gap[1]);
    }
  }

  /** Cuttings (world/banks.ts) along road up to ``upto`` whose climbs are decided: on flat road all
   * known, clear of bridges, tunnels, jumps and the line, and of anything that comes in from the
   * side of the road (cows, alleys, tumbleweeds' gullies, a crane's mast). */
  private placeBanks(upto: number): void {
    const rule = this.setup.theme.banks, t = this.track, f = this.features, rng = this.bankRng;
    if (!rule) return;
    for (let i = Math.max(1, this.bankScan); i < Math.min(upto, t.count); i++) {
      const s = t.s[i];
      if (s < this.nextBank || t.fromStart(i) < 100) { this.bankScan = i + 1; continue; }
      const len = rng.range(rule.len[0], rule.len[1]), end = i + Math.round(len / SPACING);
      if (end + 10 >= t.count && !t.locked) return; // (its road is not all known yet: wait)
      this.bankScan = i + 1;
      let flat = true;
      for (let k = i - 12; k <= end + 12 && flat; k += 3) flat = (t.elev[t.wrap(k)] ?? 1) === 0;
      // (cows walk in from beside the road, police cars come out of alleys, a crane stands there; a
      // tumbleweed can as well blow out from the foot of a wall)
      const beside = (o: { s: number }, m: number) => o.s > s - m && o.s < s + len + m;
      if (!flat || this.blocked(s - 10, len + 20, false) || f.rampNear(s - 10, len + 20) ||
          f.tunnels.some((tn) => tn.s0 < s + len + 15 && tn.s0 + TUNNEL_LEN > s - 15) ||
          this.obstacles.list.some((o) => (o.kind === "cow" || o.kind === "wrecker") && beside(o, 45)) ||
          this.obstacles.sites.some((st) => beside(st, this.obstacles.kind === "police" ? 30 : 0)) ||
          (t.locked && s + len > t.length - 120)) {
        this.nextBank = s + 20;
        continue;
      }
      const h = rng.range(rule.h[0], rule.h[1]), first: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
      const sides = rng.next() < rule.both ? [1, -1] as const : [first];
      // (and its walls' land clear of every other stretch of road)
      if (sides.some((side) => this.inWayOf(bankFootprint({ s0: s, len, side, h: h * 1.15, style: rule.style }), 0, t.count))) {
        this.nextBank = s + 20;
        continue;
      }
      for (const side of sides) f.banks.push({ s0: s, len, side, h: h * rng.range(0.85, 1.15), style: rule.style });
      this.scenery.clearAlong(t, i, Math.min(end, t.count - 1), BANK_AT + 10);
      this.nextBank = s + len + rng.range(rule.gap[0], rule.gap[1]);
    }
  }

  /** Whether (x, y) is within ``m`` m of a building beside the road: the land a cutting's wall
   * stands on (from its foot to the back of its top), a building a Tokyo tunnel runs under, a police
   * alley's buildings. */
  private inBuilding(x: number, y: number, m: number): boolean {
    const t = this.track, i = t.nearest(x, y, 0), s = t.s[i] + t.along(x, y, i), off = t.offset(x, y, i);
    return this.buildingsNear(s).some((fp) => inside(t, fp, s, off, m));
  }

  /** New road [from, to) was dreamed: the world gives way to it. A cutting's walls, a building a
   * tunnel runs under or a police alley set out beside road dreamed before, that the new road would
   * run into, is taken away (as the scenery it would run over is: world/scenery.ts). */
  private giveWay(from: number, to: number): void {
    const f = this.features, inWay = (fp: Footprint) => this.inWayOf(fp, from, to);
    f.banks = f.banks.filter((b) => !inWay(bankFootprint(b)));
    if (this.setup.theme.tunnels === "city") f.tunnels = f.tunnels.filter((tn) => ![1, -1].some((side) => inWay(tunnelFootprint(tn.s0, side))));
    if (this.obstacles.kind === "police") this.obstacles.dropSites((st) => inWay(alleyFootprint(st)));
  }

  /** Whether road points [from, to), on another stretch of road than its own, run into building
   * ``fp`` (or come within half a road's width of it). */
  private inWayOf(fp: Footprint, from: number, to: number): boolean {
    const t = this.track, m = HALF_WIDTH + 1;
    for (let j = from; j < to; j += 2) {
      if (Math.abs(alongLap(t, fp.s0 + fp.len / 2, t.s[j])) < fp.len / 2 + 60) continue; // (its own stretch)
      for (let s = fp.s0; s <= fp.s0 + fp.len; s += 2) {
        const i = indexAtS(t, s), [tx, ty] = t.tangent(i), dx = t.xs[j] - t.xs[i], dy = t.ys[j] - t.ys[i];
        const u = dx * tx + dy * ty, o = (dy * tx - dx * ty) * fp.side;
        if (Math.abs(u) < 1.5 && o > fp.inner - m && o < fp.outer + m) return true;
      }
    }
    return false;
  }

  /** The buildings beside the road near arc length ``s``, in road terms: a cutting's walls (from
   * their foot to the back of their top), the buildings Tokyo's tunnels run under (out past their
   * walls; inside, the tunnel's own walls hold a kart), the police alleys' buildings. */
  private buildingsNear(s: number): Footprint[] {
    const t = this.track, f = this.features, out: Footprint[] = [];
    const near = (s0: number, len: number) => { const u = alongLap(t, s0, s); return u > -25 && u < len + 25; };
    for (const b of f.banks) if (near(b.s0, b.len)) out.push(bankFootprint(b));
    if (this.setup.theme.tunnels === "city") {
      for (const tn of f.tunnels) if (near(tn.s0, TUNNEL_LEN)) out.push(tunnelFootprint(tn.s0, 1), tunnelFootprint(tn.s0, -1));
    }
    if (this.obstacles.kind === "police") {
      for (const st of this.obstacles.sites) {
        const fp = alleyFootprint(st);
        if (near(fp.s0, fp.len)) out.push(fp);
      }
    }
    // the grandstand by the start (a picture of one, as wide as it is drawn, and a few meters deep)
    const st = this.scenery.stand;
    if (st && !this.standAt) {
      const i = t.nearest(st.x, st.y, Math.max(0, t.startIndex)), ss = t.s[i] + t.along(st.x, st.y, i), off = t.offset(st.x, st.y, i);
      this.standAt = { s0: ss - st.w / 2, len: st.w, side: Math.sign(off) || 1, inner: Math.abs(off) - 1.5, outer: Math.abs(off) + 2 };
    }
    if (this.standAt && near(this.standAt.s0, this.standAt.len)) out.push(this.standAt);
    return out;
  }

  /** The buildings beside the road are solid: a kart that has driven into one is put back out the
   * way it came in, off its front onto the road (a cutting's wall keeps a kart on the road and the
   * shoulder beside it), off its back onto the land behind, or off an end. (Only the front held: a
   * kart on the pavement beside them drove into Tokyo's buildings, and one coming round the end
   * of a street was snapped back through its wall onto the road.) ``px``, ``py``: where it was. */
  private holdOffBuildings(k: Kart, px: number, py: number): void {
    if (k.tube || k.air || k.falling || k.rocket > 0) return;
    const t = this.track;
    const terms = (x: number, y: number) => {
      const i = t.nearest(x, y, k.idx);
      return { i, s: t.s[i] + t.along(x, y, i), off: t.offset(x, y, i) };
    };
    let was: ReturnType<typeof terms> | null = null, knocked = false;
    // (pushed out along the road on a bend, it can come up a little short: measured anew and again)
    for (let pass = 0; pass < 3; pass++) {
      const now = terms(k.x, k.y), R = KART_R;
      const b = this.buildingsNear(now.s).find((fp) => inside(t, fp, now.s, now.off, R));
      if (!b) return;
      was ??= terms(px, py);
      const u = alongLap(t, b.s0, now.s), o = now.off * b.side;
      const wu = alongLap(t, b.s0, was.s), wo = was.off * b.side;
      let du = 0, dO = 0;
      if (wo <= b.inner - R) dO = b.inner - R - o;
      else if (wo >= b.outer + R) dO = b.outer + R - o;
      else if (wu <= -R) du = -R - u;
      else if (wu >= b.len + R) du = b.len + R - u;
      else { // (in it already: out by the nearest way)
        const ways = [[0, b.inner - R - o], [0, b.outer + R - o], [-R - u, 0], [b.len + R - u, 0]];
        [du, dO] = ways.reduce((m, w) => (Math.hypot(w[0], w[1]) < Math.hypot(m[0], m[1]) ? w : m));
      }
      du += Math.sign(du) * 0.02;
      dO += Math.sign(dO) * 0.02;
      const [tx, ty] = t.tangent(now.i);
      k.x += tx * du - ty * dO * b.side;
      k.y += ty * du + tx * dO * b.side;
      k.offset = (o + dO) * b.side;
      if (!knocked) {
        k.v *= du !== 0 ? 0.35 : 0.97; // (into the end of one head on: most of the way to a stop)
        k.bumpTime = 0.2;
        knocked = true;
      }
    }
  }

  /** The lap has locked: make good the counts the track type confirms (jumps, pads, climbs) on
   * free road that no kart is on or coming up to. */
  private confirm(): void {
    const min = this.type.min;
    if (!min) return;
    const t = this.track, f = this.features;
    const free = (s: number, len: number) => !this.blocked(s, len) && !this.kartsNear(s, len);
    const nearRows = (s: number, len: number) => !this.blocked(s, len, false) && !this.kartsNear(s, len);
    if (min.hills && t.hills.length < min.hills) {
      this.topUpHills(min.hills - t.hills.length, nearRows);
      this.items.relift(t);
    }
    // jumps want long straights clear of the item rows; failing that, next to a row, then on a
    // gentler bend (a 20 m flight there drifts 3 m: still on the road)
    for (const [where, bend] of [[free, 1 / 90], [nearRows, 1 / 90], [nearRows, 1 / 60]] as const) {
      if (min.ramps && f.ramps.length < min.ramps) f.topUpRamps(t, min.ramps - f.ramps.length, where, bend);
    }
    // still short of the jumps it confirms: a climb that no kart is on gives its road to a jump (the
    // straightest climbs first), so the promise is kept
    if (min.ramps && f.ramps.length < min.ramps) {
      const straightness = (h: { s0: number; len: number }) => {
        let worst = 0;
        for (let i = 0; i < t.count; i += 4) if (t.s[i] >= h.s0 && t.s[i] <= h.s0 + h.len) worst = Math.max(worst, Math.abs(t.curvature(i)));
        return worst;
      };
      for (const h of [...t.hills].sort((a, b) => straightness(a) - straightness(b))) {
        if (f.ramps.length >= min.ramps) break;
        if (this.kartsNear(h.s0 - 30, h.len + 60)) continue;
        const r = t.removeHills(h.s0, h.s0 + h.len);
        if (!r) continue;
        this.tex.repaint(t, r[0], r[1]);
        this.items.relift(t);
        f.topUpRamps(t, min.ramps - f.ramps.length, nearRows, 1 / 60);
      }
    }
    for (const where of [free, nearRows]) {
      if (min.pads && f.pads.length < min.pads) f.topUpPads(t, min.pads - f.pads.length, where, () => this.rng.next());
    }
  }

  /** Climbs for a locked lap that has too few: mid-sized ones, then the shortest the rule allows,
   * wherever the road is free and well clear of other climbs, tunnels and jumps. */
  private topUpHills(want: number, free: (s: number, len: number) => boolean): void {
    const rule = this.hillRule;
    if (!rule) return;
    want -= this.addHills(want, (rule.len[0] + rule.len[1]) / 2, (rule.h[0] + rule.h[1]) / 2, free);
    if (want > 0) this.addHills(want, rule.len[0], rule.h[0], free);
  }

  private addHills(want: number, len: number, h: number, free: (s: number, len: number) => boolean): number {
    const t = this.track;
    let added = 0;
    for (let i = 8; i < t.count && added < want; i += 8) {
      const from = t.fromStart(i);
      if (from < 60 || from + len > t.length - 120) continue;
      const s = t.s[i];
      if (t.hills.some((hl) => hl.s0 < s + len + 40 && hl.s0 + hl.len + 40 > s) ||
          t.bridges.some((b) => Math.abs(b.centerS - s - len / 2) < len / 2 + BRIDGE_CLEAR) ||
          this.features.tunnels.some((tn) => tn.s0 < s + len + 20 && tn.s0 + TUNNEL_LEN > s - 20) ||
          this.features.ramps.some((r) => r.s0 < s + len + 30 && r.s0 + RAMP_LEN + 45 > s - 30) ||
          !free(s - 10, len + 20)) continue;
      const style = this.setup.theme.hillStyle, shape = this.hillRule?.kinds?.find((k) => k.style === style)?.shape;
      const r = t.addHill({ s0: s, len, h, style, shape, side: this.hillRng.next() < 0.5 ? 1 : -1 });
      if (r) this.tex.repaint(t, r[0], r[1]);
      added += 1;
    }
    return added;
  }

  /** A bridge's approach ramp was lifted after it had been painted as ground road (and the item boxes
   * and coins on it go up with it: left on the ground, they were buried in the ramp). */
  private onRaise(from: number, to: number): void {
    this.tex.repaint(this.track, from, to);
    this.items.relift(this.track);
  }

  /** The style asked of arc ``arc``: the track type's program, given what the driving asks for. */
  styleFor(arc: number): number {
    return Math.max(0.02, Math.min(0.98, this.type.style(arc, this.styleWanted())));
  }

  /** The style the next stretch should have, from how the player is driving (0 calm .. 1 wild):
   * fast, clean and drifting raises it; running wide or slow calms the dream down. */
  styleWanted(): number {
    const d = this.driving;
    // Legend leans wild and Rookie calm (Intermediate a little calm); Tokyo's streets wind more, and
    // the tunnel's bends are wide (to drive round the inside of the tube)
    const bias = { rookie: -0.1, intermediate: -0.05, pro: 0, legend: 0.1 }[this.setup.difficulty] +
      (this.setup.theme.winding ? 0.12 : 0) + (this.setup.theme.smooth ? -0.22 : 0);
    // (centred a little calm: dreamed laps had too many hairpins)
    const v = 0.45 + 1.25 * (d.speed - 0.72) + 0.6 * d.drift - 1.1 * d.offroad - 0.25 * (1 - d.clean) + bias;
    return Math.max(0.05, Math.min(0.95, v));
  }

  /** Called every frame while racing lap 1: exponential averages over the last ~8 s. */
  private watchDriving(dt: number): void {
    const p = this.player, d = this.driving, a = Math.min(1, dt / 8);
    d.speed += ((Math.abs(p.v) / this.cls.vmax) - d.speed) * a;
    d.offroad += ((p.surface === "grass" || p.surface === "shoulder" ? 1 : 0) - d.offroad) * a;
    d.drift += ((p.drifting ? 1 : 0) - d.drift) * a;
    d.clean += ((p.spin > 0 || p.bumpTime > 0 ? 0 : 1) - d.clean) * a;
  }

  private onLock(): void {
    this.placeHills(this.track.count);
    this.raiseCranes(this.track.count);
    this.placeObstacles(this.track.count);
    this.placeBanks(this.track.count);
    this.scenery.onLock(this.track);
    // (the land is dressed at the lock after the cuttings are set out: nothing it puts down stands
    // on a cutting's wall, or in any other building beside the road; on the moon a boulder stood on
    // a wall's land once its jumps, and so its cuttings, moved)
    // (but the grandstand: it is one of the buildings, as a picture)
    const stand = this.scenery.stand;
    this.scenery.items = this.scenery.items.filter((it) => (stand && it.x === stand.x && it.y === stand.y) ||
      !this.inBuilding(it.x, it.y, 1.5));
    this.confirm();
    // (in the tunnel: wing pads wherever the lap went too long without one, a bridge's clearance
    // having taken one away, say)
    this.features.fillWings(this.track, (s, len) => !this.blocked(s, len) && !this.kartsNear(s, len));
    // the world's hazard, beside the road, on the outside of the bends
    const kind = this.setup.theme.hazard;
    if (kind) {
      const rng = new Rand(this.setup.seed + 31), t = this.track;
      // (never where a cutting's wall stands)
      this.hazards = placeHazards(t, kind, () => rng.next(), (x, y, cap) => this.scenery.roadDistance(t, x, y, cap))
        .filter((h) => !this.inBuilding(h.x, h.y, Math.max(h.rx, h.ry) + 6));
      this.tex.addHazards(this.hazards);
      this.scenery.clearHazards(this.hazards);
    }
    this.lockedAt = this.clock;
    this.events.push({ kind: "locked" });
  }

  /** The circuit as a map keeps it, to race again anywhere: its road points at the usual scale
   * (the moon draws every circuit bigger). */
  layout(): Float64Array {
    const k = this.setup.theme.scale ?? 1;
    return Float64Array.from(this.track.points, (v) => v / k);
  }

  /** Dream the grid and the first stretch, then put the karts on it. */
  async prepare(): Promise<void> {
    if (this.live) await this.live.start();
    const si = this.track.startIndex;
    this.karts.forEach((k, slot) => {
      const back = 7 + slot * 5.5; // two columns, staggered, behind the line
      const idx = this.track.wrap(si - Math.round(back / 0.6));
      k.placeOn(this.track, idx, slot & 1 ? -HALF_WIDTH / 2 : HALF_WIDTH / 2);
    });
    this.standings = [...this.karts].sort((a, b) => b.dist - a.dist);
    this.standings.forEach((k, i) => { k.place = i + 1; });
    this.phase = "countdown";
    this.countdown = 4;
    this.events.push({ kind: "count", n: 3 }); // 2, 1 and GO follow from the clock
  }

  update(dt: number, playerControls: Controls): void {
    if (this.phase === "dreaming") return;
    if (this.phase === "countdown") {
      const before = Math.ceil(this.countdown - 1);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown - 1);
      if (after !== before) this.events.push(after > 0 ? { kind: "count", n: after } : { kind: "go" });
      // rocket start: press the throttle just before GO; hold it too long and the wheels spin
      this.throttleHeld = playerControls.throttle > 0 ? this.throttleHeld + dt : 0;
      if (this.countdown <= 1) {
        this.phase = "racing";
        this.launch();
      }
      return;
    }
    this.clock += dt;
    const leader = this.standings[0];
    this.live?.update(this.track.segOf[leader.idx] ?? 0);
    if (!this.track.locked) this.watchDriving(dt);

    for (const k of this.karts) this.surfaceUnder(k);
    const dangers = this.obstacles.dangers();
    this.drivers.forEach((d) => {
      if (d.kart.finished && this.phase === "done") return;
      const c = d.act(dt, this.track, this.cls, this.player, this.karts, this.items, dangers, this.features.pads);
      const px = d.kart.x, py = d.kart.y;
      d.kart.update(dt, c, this.track, this.cls);
      this.offTheWall(d.kart);
      this.holdOffBuildings(d.kart, px, py);
      this.fire(d.kart, c);
      if (!d.kart.falling) this.padBoost(d.kart);
    });
    const controls = this.player.finished ? { steer: 0, throttle: 0.3, brake: 0, drift: false } : playerControls;
    const wasAir = this.player.air, wasRocket = this.player.rocket > 0;
    const wasSunk = this.player.fall >= 0 && this.player.fall < FALL_SWAP;
    const px = this.player.x, py = this.player.y, wingsWere = this.player.wings;
    const { boosted, landed } = this.player.update(dt, controls, this.track, this.cls);
    const fell = this.offTheWall(this.player);
    if (wingsWere > 0 && this.player.wings <= 0 && !fell) this.events.push({ kind: "wingsOff" });
    // (two seconds of wings left, high on a wall or on the roof: time to come down)
    if (wingsWere > WINGS_LOW && this.player.wings <= WINGS_LOW && this.player.wings > 0 && this.highUp(this.player)) {
      this.events.push({ kind: "wingsLow" });
    }
    this.holdOffBuildings(this.player, px, py);
    if (boosted) this.events.push({ kind: "boost" });
    if (!wasAir && this.player.air && !this.player.falling) this.events.push({ kind: "jump" });
    if (landed !== -1) this.events.push({ kind: "land", trick: landed });
    if (wasRocket && this.player.rocket <= 0) this.events.push({ kind: "rocketOver" });
    if (wasSunk && this.player.fall >= FALL_SWAP) this.events.push({ kind: "rescued" });
    this.hazardsUnder();
    this.obstacles.update(dt, this.track, this.karts, this.player, this.phase === "racing");
    for (const ev of this.obstacles.events) {
      const near = ev.player || Math.hypot(ev.x - this.player.x, ev.y - this.player.y) < 70;
      if (near || ev.sound === "siren") this.events.push({ kind: "obstacle", sound: ev.sound, near });
    }
    this.obstacles.events = [];
    if (!this.player.falling) {
      const was = { boost: this.player.boostTime, wings: this.player.wings };
      const pad = this.padBoost(this.player);
      if (pad?.wing && was.wings < WING_TIME - 0.5) {
        this.events.push({ kind: "wings", first: !this.winged });
        this.winged = true;
      } else if (pad && was.boost < 0.85) this.events.push({ kind: "pad" });
      // (at a wall without wings, now and then: what they need)
      if (this.player.scraped && this.clock - this.wingHint > 6) {
        this.events.push({ kind: "needWings", first: this.wingHint === -Infinity });
        this.wingHint = this.clock;
      }
    }
    // the aiming arrow sweeps left and right while an aimed item is ready, until a press locks it
    const p = this.player;
    if (p.item && AIMED.has(p.item) && p.roulette <= 0 && p.aimLocked === null) {
      this.aimPhase += dt * AIM_RATE;
      p.aim = AIM_MAX * Math.sin(this.aimPhase);
    }
    this.fire(this.player, controls);
    this.items.update(dt, this.track, this.karts, this.field);
    const me = this.player;
    const near = (x: number, y: number, r = 40) => Math.hypot(x - me.x, y - me.y) < r;
    for (const e of this.items.events) {
      if (e.kind === "roll") this.events.push({ kind: "roll" });
      else if (e.kind === "got" && e.kart === me) this.events.push({ kind: "item", item: e.item });
      else if (e.kind === "used" && e.kart === me) this.events.push({ kind: "use", item: e.item });
      else if (e.kind === "locked" && e.kart === me) this.events.push({ kind: "aimLocked" });
      else if (e.kind === "spun" && e.kart === me) this.events.push({ kind: "spun" });
      else if (e.kind === "spun" && e.owner === me) this.events.push({ kind: "hit" });
      else if (e.kind === "blocked" && e.kart === me) this.events.push({ kind: "blocked" });
      else if (e.kind === "boom") this.events.push({ kind: "boom", near: near(e.x, e.y), big: e.big });
      else if (e.kind === "shock") this.events.push({ kind: "shock" });
      else if (e.kind === "coin" && e.kart === me) this.events.push({ kind: "coin" });
      else if (e.kind === "static" && e.kart === me) this.events.push({ kind: "static" });
      else if (e.kind === "comet") this.events.push({ kind: "comet", you: e.target === me });
      else if (e.kind === "stolen" && e.kart === me) this.events.push({ kind: "stolen", item: e.item });
      else if (e.kind === "stolen" && e.by === me) this.events.push({ kind: "steal", item: e.item });
      else if (e.kind === "clash") this.events.push({ kind: "clash", near: near(e.x, e.y, 30) });
      else if (e.kind === "horn") this.events.push({ kind: "horn", near: near(e.kart.x, e.kart.y) });
      else if (e.kind === "bite" && e.kart === me) this.events.push({ kind: "bite" });
      else if (e.kind === "bounce") this.events.push({ kind: "bounce", near: near(e.x, e.y, 25) });
    }
    this.items.events = [];
    if (!this.track.locked) this.holdAtFrontier();
    const { hits, spun } = collideKarts(this.karts, this.cls.vmax * 1.3);
    if (hits.includes(me)) this.events.push({ kind: "bump" });
    for (const [victim, by] of spun) {
      if (victim === me) this.events.push({ kind: "spun" });
      else if (by === me) this.events.push({ kind: "hit" });
    }
    for (const k of this.karts) {
      if (!k.falling && k.elev < 1 && this.scenery.collide(k) && k.isPlayer) this.events.push({ kind: "bump" });
      if (k.updateProgress(this.track) && k.crossings > 1) this.completeLap(k);
    }
    this.standings = [...this.karts].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.dist - a.dist;
    });
    this.standings.forEach((k, i) => { k.place = i + 1; });
    // a rocket burns out once it has carried its kart past a couple of karts (never into the lead)
    for (const k of this.karts) {
      if (k.rocket > ROCKET_TAIL && k.rocketFrom - k.place >= rocketPasses(k.rocketFrom)) k.rocket = ROCKET_TAIL;
    }
    if (this.player.finished) {
      this.doneTimer += dt;
      const allIn = this.karts.every((k) => k.finished);
      if (allIn || this.doneTimer > 12) this.phase = "done";
    }
  }

  /** GO: rocket starts (the player's from timing, the rivals' by chance) and burnouts. */
  private launch(): void {
    const held = this.throttleHeld;
    if (held > 0 && held <= 0.55) {
      this.player.boostTime = 1.2;
      this.events.push({ kind: "rocket" });
    } else if (held > 1.7) {
      this.player.burnout = 0.75;
      this.events.push({ kind: "burnout" });
    }
    for (const d of this.drivers) {
      if (this.rng.next() < 0.2 + 0.45 * this.cls.aiCorner) d.kart.boostTime = 1.0;
    }
  }

  /** A kart on the ground that has left the road goes into what is under it: the volcano's lava
   * (the rock bank is safe; the lava beside raised road is not), or the world's hazard. A drone
   * fishes it out (Kart.fallIn). */
  private hazardsUnder(): void {
    for (const k of this.karts) {
      if (k.falling || k.air || k.rocket > 0 || Math.abs(k.offset) <= HALF_WIDTH || k.elev - k.ground > 0.3) continue;
      if (this.tex.lavaAt(k.x, k.y)) this.fall(k, "lava");
      else {
        const h = this.hazards.find((z) => inHazard(z, k.x, k.y));
        if (h) this.fall(k, h.kind);
      }
    }
  }

  /** Up a wall of the tube further than WALL_FALL_TILT, or on its roof, a kart whose wings have run
   * out falls off it, onto its roof on the floor, and the drone comes for it (Kart.fallIn). Returns
   * whether it fell. (Lower down a wall, it slides back down to the floor.) */
  private offTheWall(k: Kart): boolean {
    if (!k.tube || k.falling || k.air || k.rocket > 0 || k.wings > 0 || !this.highUp(k)) return false;
    this.fall(k, "wall");
    return true;
  }

  /** Whether kart k is high enough up a wall of the tube (or on its roof) to fall without wings. */
  private highUp(k: Kart): boolean {
    return k.tube && Math.abs(tubeAt(k.offset).tilt) > WALL_FALL_TILT;
  }

  private fall(k: Kart, into: FallKind): void {
    k.fallIn(into);
    if (k.isPlayer) this.events.push(into === "lava" ? { kind: "lava" } : { kind: "fell", into });
  }

  /** Whether the road at kart k's spot is raised road with an open edge: a bridge, a girder,
   * scaffolding, a foundation, a mesa's wall or a basalt causeway (not an embankment's
   * slope, which it would just land on, nor an expressway's or a garage's walls). And how far past
   * the road's edge the deck goes there. */
  private openEdge(k: Kart): number | null {
    const t = this.track;
    if (t.bridgeAt(k.idx) > 1) return 0;
    const s = t.s[k.idx];
    const h = t.hills.find((hl) => s >= hl.s0 && s <= hl.s0 + hl.len);
    if (!h) return null;
    const style = h.style ?? this.setup.theme.hillStyle ?? "earth";
    if (style === "mesa") return 2.2; // (a strip of sand along the top before the wall)
    return OPEN_EDGES.has(style) ? 0 : null;
  }

  /** A boost pad under the kart: a second of boost, and a wing pad's wings (the tunnel's tube).
   * Returns the pad. */
  private padBoost(k: Kart): Pad | null {
    const pad = this.features.padUnder(this.track, k);
    if (!pad) return null;
    k.boostTime = Math.max(k.boostTime, 1.0);
    if (pad.wing) k.wings = WING_TIME;
    return pad;
  }

  /** The road surface under each kart: bridge decks and jump ramps, and how the road climbs and
   * crests there (measured over a few meters, so the steps between road points do not show). */
  private surfaceUnder(k: Kart): void {
    const t = this.track, r = this.features.rampUnder(t, k, t.along(k.x, k.y, k.idx));
    k.rampU = r.u;
    k.ground = t.heightAt(k.x, k.y, k.idx) + r.height;
    // flying over the open edge of raised road there is nothing under the kart but the ground far
    // below; once it has dropped well under the deck, the rescue drone comes for it
    if (k.air && !k.falling && k.rocket <= 0 && k.ground > 1.2 && !k.tube) {
      const lip = this.openEdge(k);
      if (lip !== null && Math.abs(k.offset) > HALF_WIDTH + 0.5 + lip) {
        const deck = k.ground;
        k.ground = 0;
        if (k.elev < deck - 1.5) this.fall(k, "drop");
      }
    }
    k.walled = this.features.inTunnel(t, k);
    const a = t.wrap(k.idx - 4), b = t.wrap(k.idx + 4), h = 4 * SPACING;
    const za = t.elev[a] ?? 0, zi = t.elev[k.idx] ?? 0, zb = t.elev[b] ?? 0;
    k.slope = (zb - za) / (2 * h);
    k.bend = (zb - 2 * zi + za) / (h * h);
  }

  /** Items act on the press of the button, never while it is merely held: most fire at once;
   * oil, orbs and bombs come out behind the kart and are dropped or fired on the release. */
  private fire(k: Kart, c: Controls): void {
    const down = !!c.item && !k.finished, back = !!c.back && !k.finished;
    if (down && !k.itemHeld) this.items.press(k, this.karts, this.field);
    else if (!down && k.itemHeld) this.items.release(k, this.karts, this.field);
    if (back && !k.backHeld) this.items.pressBack(k, this.karts, this.field);
    k.itemHeld = down;
    k.backHeld = back;
  }

  /** Safety net for slow devices: nobody can drive past road that has not been dreamed yet.
   * Speed is capped by the distance left to the frontier (the lookahead normally keeps it far
   * out of reach). */
  private holdAtFrontier(): void {
    const t = this.track;
    const end = t.s[t.count - 1];
    for (const k of this.karts) {
      const left = end - t.s[k.idx];
      if (left < FRONTIER_HOLD) k.v = Math.min(k.v, Math.max(0, left - 6) * 0.6);
    }
  }

  private completeLap(k: Kart): void {
    if (k.finished) return; // a cool-down lap is not a lap
    const lapTime = this.clock - k.lapStart;
    k.lapTimes.push(lapTime);
    k.lapStart = this.clock;
    const completed = k.crossings - 1;
    if (completed >= LAPS && !k.finished) {
      k.finished = true;
      k.finishTime = this.clock;
      if (k.isPlayer) this.events.push({ kind: "finish", place: k.place || 1 });
    } else if (k.isPlayer) {
      this.events.push({ kind: "lap", lap: completed + 1, final: completed + 1 === LAPS });
    }
  }

  /** What the items need to know: the leader still racing, and how each kart stands (for the
   * odds of what a box gives). */
  readonly field: Field = {
    leader: () => this.standings.find((k) => !k.finished) ?? null,
    standing: (k: Kart): Standing => {
      const racing = this.standings.filter((o) => !o.finished);
      const lead = racing[0] ?? k, i = racing.indexOf(k);
      const ahead = i > 0 ? racing[i - 1] : null;
      return {
        behind: Math.max(0, lead.dist - k.dist), last: i === racing.length - 1 && racing.length > 1,
        gapAhead: ahead ? ahead.dist - k.dist : 0, field: this.karts.length, player: k.isPlayer,
      };
    },
  };

  /** Estimated finishing times for anyone still racing when results are shown. */
  results(): { kart: Kart; time: number; best: number; estimated: boolean }[] {
    const L = this.track.locked ? this.track.length : 1;
    return this.standings.map((k) => {
      const best = k.lapTimes.length ? Math.min(...k.lapTimes) : 0;
      if (k.finished) return { kart: k, time: k.finishTime, best, estimated: false };
      const done = Math.max(k.dist, 1) / (L * LAPS);
      return { kart: k, time: this.clock / Math.max(done, 0.05), best, estimated: true };
    });
  }

  get lapForHud(): number {
    return Math.min(LAPS, Math.max(1, this.player.crossings));
  }

  get dreamProgress(): number {
    return this.track.committedFraction;
  }
}
