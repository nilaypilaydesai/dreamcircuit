// The race director: grid, countdown, live circuit generation during lap 1, laps, positions,
// finish and results. Owns the karts, the circuit, the ground texture and the scenery.

import { Rand, type Sprite } from "../core/gfx";
import type { Theme } from "../themes";
import { Scenery } from "../world/scenery";
import { WorldTexture } from "../world/texture";
import { HALF_WIDTH, N, Track } from "../world/track";
import { type CircuitDesigner, LiveCircuit } from "../world/trackgen";
import { RivalDriver } from "./ai";
import { type ItemKind, Items } from "./items";
import { CLASSES, type Controls, type Difficulty, Kart, collideKarts } from "./kart";
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
  | { kind: "hit" }; // the player's oil or orb spun out a rival

export interface RaceSetup {
  rivals: number; // 0..7
  difficulty: Difficulty;
  theme: Theme;
  seed: number;
  replay: Float64Array | null; // radii of a locked circuit to race again
}

export class Race {
  phase: "dreaming" | "countdown" | "racing" | "done" = "dreaming";
  readonly track: Track;
  readonly live: LiveCircuit | null;
  readonly tex: WorldTexture;
  readonly scenery: Scenery;
  readonly items: Items;
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

  constructor(readonly setup: RaceSetup, designer: CircuitDesigner | null, banner: (s: Sprite) => void) {
    this.rng = new Rand(setup.seed);
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
      this.live = new LiveCircuit(designer, new Rand(setup.seed + 2));
      this.track = this.live.track;
      this.live.onCommit = (a, b) => this.onCommit(a, b);
      this.live.onLock = () => this.onLock();
    }
    const n = setup.rivals + 1;
    const order = Array.from({ length: n }, (_, i) => i);
    // the player starts in the middle of the pack, like the classics
    const playerSlot = Math.min(n - 1, Math.floor(n / 2));
    this.player = new Kart(0, LIVERIES[0].name, 0, true);
    let rivalNo = 1;
    for (const slot of order) {
      const k = slot === playerSlot ? this.player : new Kart(rivalNo, LIVERIES[rivalNo].name, rivalNo++, false);
      this.karts.push(k);
      if (!k.isPlayer) this.drivers.push(new RivalDriver(this.rng, k, slot));
    }
    this.standings = [...this.karts];
  }

  private onCommit(from: number, to: number): void {
    this.tex.paintRoad(this.track, from, to);
    this.scenery.onCommit(this.track, from, to);
    this.items.onCommit(this.track, from, to);
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
      if (this.countdown <= 1) this.phase = "racing";
      return;
    }
    this.clock += dt;
    const leader = this.standings[0];
    this.live?.update(this.track.segOf[leader.idx] ?? 0);

    this.drivers.forEach((d) => {
      if (d.kart.finished && this.phase === "done") return;
      const c = d.act(dt, this.track, this.cls, this.player, this.karts);
      d.kart.update(dt, c, this.track, this.cls);
      this.fire(d.kart, c);
    });
    const controls = this.player.finished ? { steer: 0, throttle: 0.3, brake: 0, drift: false } : playerControls;
    const { boosted } = this.player.update(dt, controls, this.track, this.cls);
    if (boosted) this.events.push({ kind: "boost" });
    this.fire(this.player, controls);
    this.items.update(dt, this.track, this.karts, (k) => k.place || 1);
    for (const e of this.items.events) {
      if (e.kind === "roll") this.events.push({ kind: "roll" });
      else if (e.kind === "got" && e.kart.isPlayer) this.events.push({ kind: "item", item: e.item });
      else if (e.kind === "used" && e.kart.isPlayer) this.events.push({ kind: "use", item: e.item });
      else if (e.kind === "spun" && e.kart.isPlayer) this.events.push({ kind: "spun" });
      else if (e.kind === "spun" && e.owner.isPlayer) this.events.push({ kind: "hit" });
    }
    this.items.events = [];
    if (!this.track.locked) this.holdAtFrontier();
    const hits = collideKarts(this.karts, this.cls.vmax * 1.3);
    if (hits.includes(this.player)) this.events.push({ kind: "bump" });
    for (const k of this.karts) {
      if (this.scenery.collide(k) && k.isPlayer) this.events.push({ kind: "bump" });
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

  /** Items fire on the press of the button, not while it is held. */
  private fire(k: Kart, c: Controls): void {
    if (c.item && !k.itemHeld && !k.finished) this.items.use(k, this.karts);
    k.itemHeld = !!c.item;
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
