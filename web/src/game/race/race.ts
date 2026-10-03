// The race director: grid, countdown (with rocket starts), live circuit generation during lap 1
// (steered by how the player drives), laps, positions, finish and results. Owns the karts, the
// circuit, its bridges, ramps and boost pads, the ground texture and the scenery.

import { Rand, type Sprite } from "../core/gfx";
import type { Theme } from "../themes";
import { Scenery } from "../world/scenery";
import { WorldTexture } from "../world/texture";
import { HALF_WIDTH, type Layout, N, Track } from "../world/track";
import { type Designer, LiveCircuit } from "../world/trackgen";
import { RivalDriver } from "./ai";
import { Features, TUNNEL_LEN } from "./features";
import { AIMED, AIM_MAX, AIM_RATE, type ItemKind, Items } from "./items";
import { CLASSES, type Controls, type Difficulty, Kart, collideKarts } from "./kart";
import { type Build, DEFAULT_BUILD, rivalBuild } from "./parts";
import { LIVERIES } from "../render/sprites";

export const LAPS = 3;
const FRONTIER_HOLD = 60; // m: below this much dreamed road ahead, speed is capped

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
  | { kind: "spun" } // the player was spun out
  | { kind: "hit" } // the player's item (or prism, or rocket) spun out a rival
  | { kind: "blocked" } // the item held behind the player soaked up a hit
  | { kind: "boom"; near: boolean } // a bomb went off (near the player: shake the camera)
  | { kind: "shock" } // someone used a shock: the screen flashes
  | { kind: "rocketOver" } // the player's rocket has burned out
  | { kind: "jump" } // the player left a ramp
  | { kind: "land"; trick: 0 | 1 | 2 } // and came down (with a trick grade)
  | { kind: "pad" } // the player hit a boost pad
  | { kind: "rocket" } // a perfectly timed start
  | { kind: "burnout" } // throttle held too early: wheels spin at GO
  | { kind: "bridge" }; // the dream crossed itself and built a bridge

export interface RaceSetup {
  rivals: number; // 0..7
  difficulty: Difficulty;
  theme: Theme;
  seed: number;
  replay: Float64Array | null; // points of a locked circuit to race again (game meters)
  layout?: Layout; // what the designer is asked for (default: anything)
  build?: Build; // the player's kart from the garage (default: the classic kart)
  rivalSeed?: number; // the rivals' karts (a Grand Prix keeps them for every race)
}

/** Whether the player's controls reach the race: while racing, and during the countdown, where
 * the throttle decides a rocket start (pressed just before GO) or a burnout (held too long). */
const BRIDGE_CLEAR = 95; // m of road kept free of jumps and pads around a bridge's crossing
const UNDER_CLEAR = 80; // m around the road that passes under a bridge

export function takesControls(phase: Race["phase"]): boolean {
  return phase === "racing" || phase === "countdown";
}

export class Race {
  phase: "dreaming" | "countdown" | "racing" | "done" = "dreaming";
  readonly track: Track;
  readonly live: LiveCircuit | null;
  readonly tex: WorldTexture;
  readonly scenery: Scenery;
  readonly items: Items;
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
  private nextHill = 170; // m of road before the next climb may start (the mountains)
  private readonly hillRng: Rand;
  private aimPhase = 0; // where the player's aiming arrow is in its sweep
  private bridgesSeen = 0;
  /** How the player is driving lap 1 (smoothed), which sets the style of the road ahead. */
  readonly driving = { speed: 0.7, offroad: 0, drift: 0, clean: 1 };

  constructor(readonly setup: RaceSetup, designer: Designer | null, banner: (s: Sprite) => void) {
    this.rng = new Rand(setup.seed);
    this.hillRng = new Rand(setup.seed + 21);
    this.features = new Features(!!setup.theme.mountain);
    this.cls = CLASSES[setup.difficulty];
    this.tex = new WorldTexture(setup.theme, setup.seed);
    this.scenery = new Scenery(setup.theme, setup.seed + 1, banner);
    this.items = new Items(new Rand(setup.seed + 3));
    if (setup.replay) {
      this.live = null;
      this.track = new Track();
      this.track.addKnown(Array.from({ length: N }, (_, j) => j), setup.replay);
      this.onCommit(0, this.track.count);
      this.onLock();
    } else {
      if (!designer) throw new Error("the circuit designer is not loaded");
      this.live = new LiveCircuit(designer, new Rand(setup.seed + 2), setup.layout ?? "any");
      this.track = this.live.track;
      this.live.onCommit = (a, b) => this.onCommit(a, b);
      this.live.onRaise = (a, b) => this.onRaise(a, b);
      this.live.onLock = () => this.onLock();
      this.live.styleSource = () => this.styleWanted();
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
    this.standings = [...this.karts];
  }

  private onCommit(from: number, to: number): void {
    const t = this.track;
    const blocked = (s: number, len: number) =>
      this.items.rowS.some((r) => r > s - 12 && r < s + len + 12) ||
      // keep clear of bridges: the deck and its approach ramps span about 61 m either side of the
      // crossing, and a jump needs room to land; and around the road that passes under it
      t.bridges.some((b) => Math.abs(b.centerS - s - len / 2) < BRIDGE_CLEAR ||
        Math.abs(t.s[b.lower] - s - len / 2) < UNDER_CLEAR) ||
      t.locked && (s + len > t.length - 80);
    // in the mountains the road climbs: lift it before it is painted (raised road leaves a shadow)
    if (this.setup.theme.mountain) this.placeHills(from, to, blocked);
    this.tex.paintRoad(t, from, to);
    this.scenery.onCommit(t, from, to);
    this.items.onCommit(t, from, to);
    const tunnels = this.features.tunnels.length;
    this.features.onCommit(t, from, to, blocked, () => this.rng.next());
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
      // and a climb where the bridge, or the road under it, goes would leave no headroom: flatten it
      for (const [s0, s1] of [[b.centerS - BRIDGE_CLEAR, b.centerS + BRIDGE_CLEAR], [under - UNDER_CLEAR, under + UNDER_CLEAR]]) {
        const r = t.removeHills(s0, s1);
        if (r) this.tex.repaint(t, r[0], r[1]);
      }
      this.events.push({ kind: "bridge" });
    }
  }

  /** Set climbs along newly committed road: 110-170 m long, 3.5-6.2 m high, in the middle of the
   * lap (clear of the grid and the line), away from bridges, item rows and tunnels. */
  private placeHills(from: number, to: number, blocked: (s: number, len: number) => boolean): void {
    const t = this.track;
    for (let i = Math.max(1, from); i < to; i++) {
      const s = t.s[i];
      if (s < this.nextHill) continue;
      const seg = t.segOf[i];
      if (seg < 24 || seg > 180) continue;
      const len = this.hillRng.range(110, 170), h = this.hillRng.range(3.5, 6.2);
      const tunnel = this.features.tunnels.some((tn) => tn.s0 < s + len + 20 && tn.s0 + TUNNEL_LEN > s - 20);
      if (tunnel || blocked(s - 10, len + 20)) {
        this.nextHill = s + 15;
        continue;
      }
      t.addHill({ s0: s, len, h });
      this.nextHill = s + len + this.hillRng.range(90, 180);
    }
  }

  /** A bridge's approach ramp was lifted after it had been painted as ground road. */
  private onRaise(from: number, to: number): void {
    this.tex.repaint(this.track, from, to);
  }

  /** The style the next stretch should have, from how the player is driving (0 calm .. 1 wild):
   * fast, clean and drifting raises it; running wide or slow calms the dream down. */
  styleWanted(): number {
    const d = this.driving;
    // Legend leans wild and Rookie calm; the mountains wind more
    const bias = (this.setup.difficulty === "legend" ? 0.1 : this.setup.difficulty === "rookie" ? -0.1 : 0) +
      (this.setup.theme.mountain ? 0.12 : 0);
    const v = 0.5 + 1.25 * (d.speed - 0.72) + 0.6 * d.drift - 1.1 * d.offroad - 0.25 * (1 - d.clean) + bias;
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
    this.scenery.onLock(this.track);
    this.lockedAt = this.clock;
    this.events.push({ kind: "locked" });
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
    this.drivers.forEach((d) => {
      if (d.kart.finished && this.phase === "done") return;
      const c = d.act(dt, this.track, this.cls, this.player, this.karts);
      d.kart.update(dt, c, this.track, this.cls);
      this.fire(d.kart, c);
      if (this.features.onPad(this.track, d.kart)) d.kart.boostTime = Math.max(d.kart.boostTime, 1.0);
    });
    const controls = this.player.finished ? { steer: 0, throttle: 0.3, brake: 0, drift: false } : playerControls;
    const wasAir = this.player.air, wasRocket = this.player.rocket > 0;
    const { boosted, landed } = this.player.update(dt, controls, this.track, this.cls);
    if (boosted) this.events.push({ kind: "boost" });
    if (!wasAir && this.player.air) this.events.push({ kind: "jump" });
    if (landed !== -1) this.events.push({ kind: "land", trick: landed });
    if (wasRocket && this.player.rocket <= 0) this.events.push({ kind: "rocketOver" });
    if (this.features.onPad(this.track, this.player)) {
      if (this.player.boostTime < 0.85) this.events.push({ kind: "pad" });
      this.player.boostTime = Math.max(this.player.boostTime, 1.0);
    }
    // the aiming arrow sweeps left and right while a boomerang or a bomb is ready to throw
    const p = this.player;
    if (p.item && AIMED.has(p.item) && p.roulette <= 0 && !p.trailing) {
      this.aimPhase += dt * AIM_RATE;
      p.aim = AIM_MAX * Math.sin(this.aimPhase);
    }
    this.fire(this.player, controls);
    this.items.update(dt, this.track, this.karts, (k) => k.place || 1);
    const me = this.player;
    for (const e of this.items.events) {
      if (e.kind === "roll") this.events.push({ kind: "roll" });
      else if (e.kind === "got" && e.kart === me) this.events.push({ kind: "item", item: e.item });
      else if (e.kind === "used" && e.kart === me) this.events.push({ kind: "use", item: e.item });
      else if (e.kind === "spun" && e.kart === me) this.events.push({ kind: "spun" });
      else if (e.kind === "spun" && e.owner === me) this.events.push({ kind: "hit" });
      else if (e.kind === "blocked" && e.kart === me) this.events.push({ kind: "blocked" });
      else if (e.kind === "boom") this.events.push({ kind: "boom", near: Math.hypot(e.x - me.x, e.y - me.y) < 40 });
      else if (e.kind === "shock") this.events.push({ kind: "shock" });
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
      if (k.elev < 1 && this.scenery.collide(k) && k.isPlayer) this.events.push({ kind: "bump" });
      if (k.updateProgress(this.track) && k.crossings > 1) this.completeLap(k);
    }
    this.standings = [...this.karts].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.dist - a.dist;
    });
    this.standings.forEach((k, i) => { k.place = i + 1; });
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

  /** The road surface under each kart: bridge decks and jump ramps. */
  private surfaceUnder(k: Kart): void {
    const r = this.features.rampUnder(this.track, k);
    k.rampU = r.u;
    k.ground = (this.track.elev[k.idx] ?? 0) + r.height;
    k.walled = this.features.inTunnel(this.track, k);
  }

  /** Items act on the press of the button, never while it is merely held: most fire at once;
   * oil, orbs and bombs come out behind the kart and are dropped or fired on the release. */
  private fire(k: Kart, c: Controls): void {
    const down = !!c.item && !k.finished;
    if (down && !k.itemHeld) this.items.press(k, this.karts);
    else if (!down && k.itemHeld) this.items.release(k, this.karts);
    k.itemHeld = down;
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
