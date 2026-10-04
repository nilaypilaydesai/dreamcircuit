// Landscape around a circuit that is still being dreamed. Decorations appear beside each new
// stretch of road as it is committed (and anything the new road would run over is cleared);
// when the circuit locks, the rest of the world fills in: the lie of the land (knolls, buttes,
// dunes, peaks: world/landforms.ts), forests, rock fields, mesas, the start gantry and a
// grandstand.

import { Rand, type Sprite } from "../core/gfx";
import { type SceneryArt, chevron, gantry, grandstand, makeScenery, pillar } from "../render/sprites";
import type { Theme } from "../themes";
import { type Hazard, inHazard } from "./hazards";
import { LANDFORM_CLEAR, LANDFORM_SIZE, type Landform, onLandform, reach } from "./landforms";
import { type Bridge, HALF_WIDTH, SPACING, type Track } from "./track";
import { HALF, worldHalf } from "./texture";

export interface Placed {
  x: number;
  y: number;
  art: SceneryArt;
  flip: boolean;
}

const CELL = 12;
const LANDFORMS = 18; // the most a world gets

export class Scenery {
  items: Placed[] = [];
  landforms: Landform[] = [];
  private readonly road = new Map<number, number[]>(); // spatial hash of committed road points
  private readonly cache = new Map<string, SceneryArt[]>(); // a few variants per kind
  private readonly rng: Rand;
  private readonly half: number; // m: the world spans [-half, half] (its ground texture's)
  private readonly area: number; // how many times the usual world's area it has (the moon is bigger)

  constructor(readonly theme: Theme, seed: number, private readonly bannerText: (s: Sprite) => void) {
    this.rng = new Rand(seed);
    this.half = worldHalf(theme.scale);
    this.area = (this.half / HALF) ** 2;
  }

  private key(x: number, y: number): number {
    return (Math.floor(x / CELL) + 512) * 4096 + (Math.floor(y / CELL) + 512);
  }

  private art(kind: Theme["near"][number]): SceneryArt {
    let v = this.cache.get(kind);
    if (!v) {
      v = Array.from({ length: kind === "chevron" ? 1 : 4 }, () => makeScenery(kind, this.rng));
      this.cache.set(kind, v);
    }
    return this.rng.pick(v);
  }

  /** Distance from (x, y) to the nearest committed road point (capped at ``cap``). */
  roadDistance(track: Track, x: number, y: number, cap = 40): number {
    let best = cap;
    const r = Math.ceil(cap / CELL);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const pts = this.road.get((cx + i + 512) * 4096 + (cy + j + 512));
        if (!pts) continue;
        for (const p of pts) best = Math.min(best, Math.hypot(track.xs[p] - x, track.ys[p] - y));
      }
    }
    return best;
  }

  /** New road was committed: index it, clear anything on it, decorate beside it. */
  onCommit(track: Track, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const k = this.key(track.xs[i], track.ys[i]);
      const list = this.road.get(k);
      if (list) list.push(i);
      else this.road.set(k, [i]);
    }
    const clear = HALF_WIDTH + 2.2;
    this.items = this.items.filter((it) => this.roadDistance(track, it.x, it.y, clear + 1) > clear);
    const t = this.theme;
    for (let i = from; i < to; i += 11) {
      if ((track.elev[i] ?? 0) > 0.3) continue; // a climb or a bridge: its own structure dresses it
      const [tx, ty] = track.tangent(i);
      const kappa = track.curvature(i);
      if (Math.abs(kappa) > 1 / 32 && (i % 22) < 11) {
        // chevrons on the outside of tight corners, pointing into the turn
        const side = -Math.sign(kappa);
        const off = side * (HALF_WIDTH + 2.4);
        this.add(track, track.xs[i] - ty * off, track.ys[i] + tx * off, chevron(kappa < 0), false, HALF_WIDTH + 1.6);
        continue;
      }
      for (const side of [1, -1]) {
        if (this.rng.next() > 0.55) continue;
        const off = side * (HALF_WIDTH + this.rng.range(3, 11));
        const kind = this.rng.pick(t.near);
        this.add(track, track.xs[i] - ty * off, track.ys[i] + tx * off, this.art(kind), this.rng.next() > 0.5,
                 HALF_WIDTH + 2.4);
      }
    }
  }

  /** A bridge was built: pillars under its deck, clear of the road it crosses. */
  onBridge(track: Track, b: Bridge): void {
    const lower = (x: number, y: number) => {
      let best = Infinity;
      for (let k = -140; k <= 140; k += 2) {
        const i = track.wrap(b.lower + k);
        best = Math.min(best, Math.hypot(track.xs[i] - x, track.ys[i] - y));
      }
      return best;
    };
    const step = Math.round(11 / SPACING);
    for (let k = -Math.round(60 / SPACING); k <= Math.round(60 / SPACING); k += step) {
      const i = track.wrap(b.center + k);
      const h = track.elev[i];
      if (h < 2.2) continue;
      const [tx, ty] = track.tangent(i);
      for (const side of [1, -1]) {
        const off = side * (HALF_WIDTH - 1.0);
        const x = track.xs[i] - ty * off, y = track.ys[i] + tx * off;
        if (lower(x, y) < HALF_WIDTH + 2.5) continue; // never in the road underneath
        this.items.push({ x, y, art: pillar(h - 0.9), flip: false });
      }
    }
  }

  /** The circuit locked: fill in the landscape and the start/finish furniture. */
  onLock(track: Track): void {
    const t = this.theme;
    this.placeLandforms(track);
    // (as thick on the ground in a bigger world)
    for (let k = 0; k < 900 * this.area && this.items.length < 700 * this.area; k++) {
      const x = this.rng.range(-this.half + 12, this.half - 12), y = this.rng.range(-this.half + 12, this.half - 12);
      const kind = this.rng.pick(t.far);
      const big = kind === "mesa" || kind === "wreck" || kind === "spire" || kind === "crane" || kind === "skeleton" ||
        kind === "tower" || kind === "apartment" || kind === "billboard" || kind === "pagoda";
      // big landmarks stand well back from the road
      const need = big ? 60 : HALF_WIDTH + 7;
      const d = this.roadDistance(track, x, y, need + 10);
      if (d < need) continue;
      // forests cluster: drop a few neighbours around trees
      const n = ["pine", "oak", "cactus", "crystal", "kelp", "coral", "sakura", "basalt", "boulder", "drum"].includes(kind)
        ? this.rng.int(1, 4) : 1;
      for (let m = 0; m < n; m++) {
        const xx = x + this.rng.range(-6, 6) * (m > 0 ? 1 : 0), yy = y + this.rng.range(-6, 6) * (m > 0 ? 1 : 0);
        this.add(track, xx, yy, this.art(kind), this.rng.next() > 0.5, HALF_WIDTH + 6);
      }
    }
    const si = track.startIndex;
    const [tx, ty] = track.tangent(si);
    this.items.push({ x: track.xs[si] + tx * 0.5, y: track.ys[si] + ty * 0.5, art: gantry(this.bannerText), flip: false });
    if (t.volcano) return; // nobody sits out on the lava
    const off = HALF_WIDTH + 9;
    this.add(track, track.xs[si] - ty * off + tx * 25, track.ys[si] + tx * off + ty * 25, grandstand(this.rng), false,
             HALF_WIDTH + 4);
  }

  /** The lie of the land: up to LANDFORMS of the world's kinds, wherever there is room for one
   * well clear of the road (and of each other); nothing grows inside them. */
  private placeLandforms(track: Track): void {
    const kinds = this.theme.landforms;
    if (!kinds?.length) return;
    for (let k = 0; k < 500 * this.area && this.landforms.length < LANDFORMS * this.area; k++) {
      const kind = this.rng.pick(kinds), size = LANDFORM_SIZE[kind];
      const l: Landform = {
        kind, x: 0, y: 0, r: this.rng.range(size.r[0], size.r[1]), stretch: this.rng.range(size.stretch[0], size.stretch[1]),
        rot: this.rng.range(0, Math.PI), h: this.rng.range(size.h[0], size.h[1]), seed: this.rng.int(0, 1 << 20),
      };
      const far = reach(l);
      l.x = this.rng.range(-this.half + far + 8, this.half - far - 8);
      l.y = this.rng.range(-this.half + far + 8, this.half - far - 8);
      if (this.roadDistance(track, l.x, l.y, LANDFORM_CLEAR + far + 2) < LANDFORM_CLEAR + far) continue;
      if (this.landforms.some((o) => Math.hypot(o.x - l.x, o.y - l.y) < reach(o) + far + 6)) continue;
      this.landforms.push(l);
    }
    this.items = this.items.filter((it) => !this.landforms.some((l) => onLandform(l, it.x, it.y, 2)));
  }

  private add(track: Track, x: number, y: number, art: SceneryArt, flip: boolean, clearance: number): void {
    if (Math.abs(x) > this.half - 4 || Math.abs(y) > this.half - 4) return;
    if (this.landforms.some((l) => onLandform(l, x, y, 2))) return;
    if (this.roadDistance(track, x, y, clearance + 1) <= clearance) return;
    this.items.push({ x, y, art, flip });
  }

  /** A girder climb was built: a tower crane stands beside its middle, the road running past its
   * mast (the construction zone). */
  onGirder(track: Track, i: number): void {
    const [tx, ty] = track.tangent(i), side = this.rng.next() < 0.5 ? 1 : -1, off = side * (HALF_WIDTH + 5);
    this.items.push({ x: track.xs[i] - ty * off, y: track.ys[i] + tx * off, art: this.art("crane"), flip: side < 0 });
  }

  /** Nothing stands in a pond, a pit or the like. */
  clearHazards(hazards: readonly Hazard[]): void {
    this.items = this.items.filter((it) => !hazards.some((h) => inHazard(h, it.x, it.y, 1.5)));
  }

  /** Clear everything within ``r`` m of the road between dense indices [from, to) (a tunnel's rock). */
  clearAlong(track: Track, from: number, to: number, r: number): void {
    this.items = this.items.filter((it) => {
      for (let i = from; i < to; i += 4) {
        const j = track.wrap(i);
        if (Math.hypot(track.xs[j] - it.x, track.ys[j] - it.y) < r) return false;
      }
      return true;
    });
  }

  /** Bounce a kart off solid scenery; returns true on impact. */
  collide(k: { x: number; y: number; v: number }): boolean {
    for (const it of this.items) {
      if (!it.art.solid) continue;
      const dx = k.x - it.x, dy = k.y - it.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1.3 * 1.3 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      k.x = it.x + (dx / d) * 1.3;
      k.y = it.y + (dy / d) * 1.3;
      const hit = Math.abs(k.v) > 6;
      k.v *= -0.25;
      return hit;
    }
    return false;
  }
}
