// Something in every world that makes the road harder to drive: cows wandering across it in the
// valley, tumbleweeds blowing across the mesa, jellyfish drifting over the reef road, police cars
// pulling out of the alleys in Tokyo to chase the player down, lava geysers bursting up through
// the volcano's road, a wrecking ball swinging across the building site, meteors falling on the
// moon (a ring on the road where each will land), and traffic in the tunnel. Pure logic:
// where each one is, when it can hit and what a hit does; main.ts draws them, and rivals steer
// round them (dangers()).

import { Rand } from "../core/gfx";
import { BANK_AT } from "../world/banks";
import { HALF_WIDTH, type Track } from "../world/track";
import { CLASSES, type Kart } from "./kart";

export type ObstacleKind = "cow" | "tumbleweed" | "jelly" | "police" | "geyser" | "wrecker" | "meteor" | "traffic";

/** Something in the way, at road point ``idx`` (arc length ``s``), ``offset`` m left of the
 * centerline, ``z`` m over the road; ``state`` and ``t`` (s in that state) say what it is doing. */
export interface Obstacle {
  kind: ObstacleKind;
  idx: number;
  s: number;
  offset: number;
  z: number;
  x: number;
  y: number;
  heading: number; // which way it faces (radians)
  state: number;
  t: number;
  wait: number; // s it waits before it moves (cows), or a geyser's quiet spell
  v: number; // m/s
  side: number; // 1 or -1: where it came from (the left, the right)
  target: number; // the offset it is making for
  phase: number; // its own clock (a jellyfish's drift, a ball's swing)
  r: number; // m: how near a kart's middle must come to be hit
  hot: boolean; // whether it can hit a kart now
  hits: number; // how many karts it has hit (a police car gives up after two: rams, and spins out of its own)
  age: number; // s since it was set out
  look: number; // which variant it is drawn as
}

/** Where things come out from: a police car's alley, a gully tumbleweeds blow out of. */
export interface ObstacleSite { idx: number; s: number; side: number; armed: boolean }

/** A police alley: two buildings facing the road on the site's side, the alley the police cars
 * come out of between them. Their fronts stand ALLEY_AT m out from the middle of the road and they
 * go ALLEY_DEPTH m back; along the road (m from the site) building A runs from a0 to a1 and B from
 * b0 to b1, ha and hb m tall: the same every time for a site. (It was a sprite, a flat picture of
 * two buildings that turned to face the camera, and a kart drove straight through it.) */
export const ALLEY_AT = HALF_WIDTH + 4, ALLEY_DEPTH = 11, ALLEY_MOUTH = 4.6;
export function alleyBlocks(site: ObstacleSite): { a0: number; a1: number; b0: number; b1: number; ha: number; hb: number } {
  const r = (salt: number) => { const v = Math.sin(site.idx * 12.9898 + salt * 78.233) * 43758.5453; return v - Math.floor(v); };
  const m = ALLEY_MOUTH / 2;
  return { a0: -m - 8 - 5 * r(1), a1: -m, b0: m, b1: m + 8 + 5 * r(2),
           ha: 3.6 * (4 + Math.floor(3 * r(3))), hb: 3.6 * (4 + Math.floor(3 * r(4))) };
}

export type ObstacleSound = "moo" | "puff" | "zap" | "siren" | "ram" | "geyser" | "clang" | "impact" | "honk"
  | "spun" | "shaken"; // (a police car spun out by an item; one that has given up the chase)
export interface ObstacleEvent { sound: ObstacleSound; player: boolean; x: number; y: number }

// states
export const COW_GRAZE = 0, COW_WALK = 1, COW_STAND = 2, COW_STARTLED = 3;
export const POLICE_OUT = 0, POLICE_CHASE = 1, POLICE_BACK = 2, POLICE_GONE = 3, POLICE_LUNGE = 4, POLICE_SPUN = 5;
export const GEYSER_QUIET = 0, GEYSER_WARN = 1, GEYSER_BLOW = 2;
export const METEOR_FALL = 0, METEOR_BURST = 1;

export const WRECKER_PIVOT = 13.8, WRECKER_CABLE = 12.3, WRECKER_SWING = 1.0, WRECKER_PERIOD = 3.8;
export const METEOR_FALL_TIME = 1.8, METEOR_HEIGHT = 70, METEOR_BLAST = 3.4;
export const GEYSER_WARN_TIME = 1.0, GEYSER_BLOW_TIME = 1.3, GEYSER_HEIGHT = 7.5;
const POLICE_LEN = 4.4; // m, a police car's length (it rams from behind)
const POLICE_STEER = 3; // m/s: the fastest a police car moves across the road onto the player's line
const POLICE_LUNGE_AT = 9; // m behind the player: where it settles on a line and goes for the ram
const POLICE_SHAKEN = 110; // m: this far behind the player, it has lost them and gives up
const POLICE_ROAD = HALF_WIDTH + 1.5; // m: how far out from the middle of the road it will drive

/** How far apart (m along the road) a world's obstacles are set out. */
const SPACING: Record<ObstacleKind, number> = {
  cow: 260, tumbleweed: 200, jelly: 170, police: 240, geyser: 230, wrecker: 360, meteor: 0, traffic: 0,
};
/** The ones that stand on the ground, and so need flat road (not a climb, a bridge or a tunnel). */
const GROUNDED = new Set<ObstacleKind>(["cow", "tumbleweed", "geyser", "wrecker"]);

export class Obstacles {
  list: Obstacle[] = [];
  readonly sites: ObstacleSite[] = [];
  events: ObstacleEvent[] = [];
  private scan = 1; // the first road point not yet looked at for a site
  private next = 120; // arc length of the next site
  private spawnIn = 5; // s until the next meteor
  private cooldown = 0; // s until the next police car may pull out
  private wreckers = 0;
  /** Whether a cutting's wall stands beside arc length ``s`` on ``side`` (set by the race). */
  wallAt: ((s: number, side: number) => boolean) | null = null;
  /** The race's class: a police car goes no faster than a stock kart's top speed, nor round a bend
   * faster than its grip allows (set by the race). */
  pace = { vmax: CLASSES.pro.vmax, grip: CLASSES.pro.grip }; // (the race sets its own class's)
  /** Whether an item hits a car at (x, y), z m up: oil, a puck, a bomb's blast... (set by the race). */
  strike: ((x: number, y: number, z: number) => boolean) | null = null;

  constructor(readonly kind: ObstacleKind | null, private readonly rng: Rand) {}

  /** Take away the sites ``gone`` says (a police alley new road would run through). */
  dropSites(gone: (st: ObstacleSite) => boolean): void {
    for (let k = this.sites.length - 1; k >= 0; k--) if (gone(this.sites[k])) this.sites.splice(k, 1);
  }

  /** Take away what was set out where ``gone(s)`` says (road a new bridge carries or passes over). */
  clearWhere(gone: (s: number) => boolean): void {
    this.list = this.list.filter((o) => {
      const go = GROUNDED.has(o.kind) || o.kind === "jelly" ? gone(o.s) : false;
      if (go && o.kind === "wrecker") this.wreckers -= 1;
      return !go;
    });
    for (let k = this.sites.length - 1; k >= 0; k--) if (gone(this.sites[k].s)) this.sites.splice(k, 1);
  }

  /** Set out sites on road up to ``upto`` (whose climbs are decided). ``free(s, len)``: the road
   * there has no bridge, jump, tunnel, item row or start on it. */
  place(track: Track, upto: number, free: (s: number, len: number) => boolean): void {
    const kind = this.kind;
    if (!kind || !SPACING[kind]) return;
    for (let i = Math.max(1, this.scan); i < Math.min(upto, track.count); i++) {
      this.scan = i + 1;
      const s = track.s[i];
      if (s < this.next || track.fromStart(i) < 90) continue;
      if (!free(s - 25, 50)) continue;
      // (a police alley's buildings stand on the ground beside flat road, as these do)
      if ((GROUNDED.has(kind) || kind === "police") && !this.flat(track, i, 25)) continue;
      if (kind === "wrecker" && (this.wreckers >= 3 || !this.straight(track, i, 22))) continue;
      this.site(track, i);
      this.next = s + SPACING[kind] * this.rng.range(0.8, 1.25);
    }
  }

  private flat(track: Track, i: number, m: number): boolean {
    const n = Math.round(m / 0.6);
    for (let k = -n; k <= n; k += 3) if ((track.elev[track.wrap(i + k)] ?? 1) !== 0) return false;
    return true;
  }

  private straight(track: Track, i: number, m: number): boolean {
    const n = Math.round(m / 0.6);
    for (let k = -n; k <= n; k += 3) if (Math.abs(track.curvature(track.wrap(i + k))) > 1 / 90) return false;
    return true;
  }

  private make(kind: ObstacleKind, track: Track, idx: number, offset: number): Obstacle {
    const o: Obstacle = {
      kind, idx, s: track.s[idx], offset, z: 0, x: 0, y: 0, heading: 0, state: 0, t: 0, wait: 0, v: 0,
      side: Math.sign(offset) || 1, target: offset, phase: this.rng.range(0, 100), r: 1, hot: false, hits: 0,
      age: 0, look: this.rng.int(0, 4),
    };
    this.locate(track, o);
    return o;
  }

  /** A site at road point ``i``: what stands there, or where things will come from. */
  private site(track: Track, i: number): void {
    const rng = this.rng, side = rng.next() < 0.5 ? 1 : -1;
    switch (this.kind) {
      case "cow": {
        for (let n = rng.next() < 0.3 ? 2 : 1; n > 0; n--) {
          const o = this.make("cow", track, track.wrap(i + n * 6), side * (HALF_WIDTH + rng.range(3.5, 6.5)));
          o.r = 1.3;
          o.wait = rng.range(1, 6);
          this.list.push(o);
        }
        break;
      }
      case "jelly": {
        for (let n = 0; n < 2; n++) {
          const o = this.make("jelly", track, track.wrap(i + n * 14), 0);
          o.r = 1.0;
          this.list.push(o);
        }
        break;
      }
      case "geyser": {
        const o = this.make("geyser", track, i, rng.range(-1, 1) * (HALF_WIDTH - 2));
        o.r = 1.7;
        o.wait = rng.range(2.5, 5);
        o.t = rng.range(0, 3);
        this.list.push(o);
        break;
      }
      case "wrecker": {
        const o = this.make("wrecker", track, i, 0);
        o.side = side;
        o.r = 1.9;
        this.list.push(o);
        this.wreckers += 1;
        break;
      }
      case "tumbleweed":
      case "police":
        this.sites.push({ idx: i, s: track.s[i], side, armed: true });
        break;
      default:
        break;
    }
  }

  /** Where it is in the world, from its place on the road. */
  private locate(track: Track, o: Obstacle): void {
    const [tx, ty] = track.tangent(o.idx);
    o.x = track.xs[o.idx] - ty * o.offset;
    o.y = track.ys[o.idx] + tx * o.offset;
  }

  /** The road point at arc length ``s`` (around a locked lap). */
  private indexAt(track: Track, s: number): number {
    const L = track.length || 1;
    if (track.locked) s = ((s % L) + L) % L;
    let lo = 0, hi = track.count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (track.s[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** m from arc length ``a`` forward to ``b`` (around a locked lap; negative when ``b`` is behind). */
  private ahead(track: Track, a: number, b: number): number {
    const d = b - a;
    if (!track.locked) return d;
    const L = track.length;
    return ((d % L) + L * 1.5) % L - L / 2;
  }

  /** Move everything along by ``dt`` and hit whatever kart is in the way (only while ``racing``). */
  update(dt: number, track: Track, karts: Kart[], player: Kart, racing: boolean): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const ps = track.s[player.idx] ?? 0;
    switch (this.kind) {
      case "tumbleweed": this.blowTumbleweeds(track, ps); break;
      case "police": this.callPolice(track, player, ps, racing); break;
      case "meteor": if (racing) this.callMeteors(dt, track, player, ps); break;
      case "traffic": if (racing) this.callTraffic(track, ps); break;
      default: break;
    }
    for (const o of this.list) {
      o.t += dt;
      o.phase += dt;
      o.age += dt;
      switch (o.kind) {
        case "cow": this.cow(o, dt, track, ps); break;
        case "tumbleweed": this.tumbleweed(o, dt, track); break;
        case "jelly": this.jelly(o, track); break;
        case "police": this.police(o, dt, track, player, ps); break;
        case "geyser": this.geyser(o); break;
        case "wrecker": this.wrecker(o, track); break;
        case "meteor": this.meteor(o); break;
        case "traffic": this.traffic(o, dt, track, ps); break;
      }
      if (racing && o.hot) for (const k of karts) this.hit(o, k, track);
    }
    this.list = this.list.filter((o) => !(o.kind === "tumbleweed" && o.state === 1) &&
      !(o.kind === "police" && o.state === POLICE_GONE && o.t > 3) && !(o.kind === "meteor" && o.state === METEOR_BURST && o.t > 0.7) &&
      !(o.kind === "traffic" && this.ahead(track, ps, o.s) < -120));
  }

  // -------------------------------------------------------------------------------------- cows

  /** Grazing beside the road until a kart comes, then across it at a walk (now and then stopping
   * dead in the middle), and grazing on the other side. */
  private cow(o: Obstacle, dt: number, track: Track, ps: number): void {
    const coming = this.ahead(track, ps, o.s);
    if (o.state === COW_GRAZE) {
      if (o.t > o.wait && ((coming > 45 && coming < 150) || o.t > 16)) {
        o.state = COW_WALK;
        o.t = 0;
        o.v = this.rng.range(1.8, 2.5);
        o.target = -o.side * (HALF_WIDTH + this.rng.range(3.5, 6.5));
        o.wait = this.rng.next() < 0.3 ? 1 : 0; // (whether it will stop half way)
      }
    } else if (o.state === COW_WALK) {
      const dir = Math.sign(o.target - o.offset);
      o.offset += dir * o.v * dt;
      if (o.wait && Math.abs(o.offset) < 1.5) {
        o.state = COW_STAND;
        o.t = 0;
        o.wait = 0;
      } else if (Math.sign(o.target - o.offset) !== dir) {
        o.offset = o.target;
        o.side = -o.side;
        o.state = COW_GRAZE;
        o.t = 0;
        o.wait = this.rng.range(3, 8);
      }
    } else if ((o.state === COW_STAND && o.t > 2) || (o.state === COW_STARTLED && o.t > 1.2)) {
      o.state = COW_WALK;
      o.t = 0;
    }
    const [tx, ty] = track.tangent(o.idx);
    o.heading = Math.atan2(tx, -ty) + (Math.sign(o.target - o.offset) < 0 ? Math.PI : 0); // across the road
    o.hot = true;
    this.locate(track, o);
  }

  // -------------------------------------------------------------------------------- tumbleweeds

  private blowTumbleweeds(track: Track, ps: number): void {
    for (const st of this.sites) {
      const coming = this.ahead(track, ps, st.s);
      if (coming < -40) st.armed = true;
      if (!st.armed || coming < 60 || coming > 140) continue;
      st.armed = false;
      if (this.rng.next() > 0.75) continue;
      // out from beside the road (or the foot of a wall), across to the other side (or wall)
      const from = this.wallAt?.(st.s, st.side) ? BANK_AT - 1 : HALF_WIDTH + 14;
      const to = this.wallAt?.(st.s, -st.side) ? BANK_AT - 1 : HALF_WIDTH + 16;
      const o = this.make("tumbleweed", track, st.idx, st.side * from);
      o.v = this.rng.range(7, 10);
      o.target = -st.side * to;
      o.r = 0.9;
      o.state = 0;
      this.list.push(o);
    }
  }

  /** Rolling across the road on the wind, bouncing, drifting a little along it. */
  private tumbleweed(o: Obstacle, dt: number, track: Track): void {
    const dir = Math.sign(o.target - o.offset);
    o.offset += dir * o.v * dt;
    o.s += Math.sin(o.phase * 1.3) * 1.5 * dt;
    o.idx = this.indexAt(track, o.s);
    o.z = Math.abs(Math.sin(o.phase * 4.2)) * 1.1;
    o.hot = o.z < 1.0;
    if (Math.sign(o.target - o.offset) !== dir) o.state = 1; // across: gone
    this.locate(track, o);
  }

  // --------------------------------------------------------------------------------- jellyfish

  /** Drifting slowly back and forth across the road, rising and sinking: low enough to sting a
   * kart for a few seconds in every cycle. */
  private jelly(o: Obstacle, track: Track): void {
    o.offset = (HALF_WIDTH + 1.5) * Math.sin(o.phase * 0.24);
    o.z = 0.35 + 2.1 * (0.5 + 0.5 * Math.sin(o.phase * 0.85 + 1.3));
    o.hot = o.z < 1.3;
    this.locate(track, o);
  }

  // ----------------------------------------------------------------------------------- police

  private callPolice(track: Track, player: Kart, ps: number, racing: boolean): void {
    for (const st of this.sites) {
      const past = this.ahead(track, st.s, ps);
      if (past < -30 || past > 60) st.armed = true;
      // (once the player is a little way past: it came out right on their tail and rammed them
      // before they could see it coming)
      if (!racing || !st.armed || past < 14 || past > 40) continue;
      st.armed = false;
      if (this.cooldown > 0 || this.list.some((o) => o.kind === "police") || player.finished || this.rng.next() > 0.6) continue;
      // out of the alley: from beside the road, onto it behind the player
      const o = this.make("police", track, st.idx, st.side * (HALF_WIDTH + 6));
      o.side = st.side;
      o.v = 9;
      o.r = 2.0; // (a kart's half width and a car's, near enough: a sidestep clears it)
      o.state = POLICE_OUT;
      this.list.push(o);
      this.events.push({ sound: "siren", player: true, x: o.x, y: o.y });
    }
  }

  /** Out of the alley, then after the player: no faster than a stock kart can go, so that at full
   * speed the player holds it off and a boost pulls away, and gaining only on a player who is slower
   * (off the line, off the road, after a spin); steering onto their line only so fast, and close
   * behind, settling on a line and going for the ram, so that a sidestep then dodges it; and after
   * two rams, or spun out twice by items, or once it has lost the player, it gives up and pulls
   * over. (As it was, it was always faster than the player and moved across the road as fast as
   * they did, so every chase ended in two rams, whatever the player did.) */
  private police(o: Obstacle, dt: number, track: Track, player: Kart, ps: number): void {
    const gap = this.ahead(track, o.s, ps); // m the player is ahead of it
    if (o.state === POLICE_OUT) {
      o.offset += (o.side * 2.5 - o.offset) * Math.min(1, dt * 3);
      o.v = Math.min(o.v + 14 * dt, 20);
      if (o.t > 0.9) { o.state = POLICE_CHASE; o.t = 0; }
    } else if (o.state === POLICE_SPUN) {
      o.v = Math.max(0, o.v - 24 * dt); // (spun out by an item: it skids to a stop, then comes on again)
      if (o.t > 1.6) { o.state = POLICE_CHASE; o.t = 0; }
    } else if (o.state !== POLICE_GONE) {
      // (never at a kart that is stopped or spinning: it hangs back behind it)
      const slow = player.v < 8 || player.spin > 0 || player.falling;
      const bend = Math.abs(track.curvature(o.idx)), top = Math.min(this.pace.vmax * 1.04,
        bend > 1e-4 ? Math.sqrt(this.pace.grip / bend) : Infinity);
      const want = o.state === POLICE_BACK ? Math.max(4, player.v * 0.6)
        : o.state === POLICE_LUNGE ? Math.min(top + 4, Math.max(player.v + 5, 12))
        : slow ? Math.min(top, Math.max(3, gap > 14 ? player.v + 4 : player.v - 2))
        // (right on the player's tail it rams only as it lunges, so a ram is always seen coming)
        : Math.min(top, gap < 5 ? player.v - 1 : Math.max(player.v + (gap > 25 ? 6 : 2), 16));
      o.v += Math.max(-18 * dt, Math.min(16 * dt, want - o.v));
      if (o.state !== POLICE_LUNGE && gap < 40) {
        // (onto the road and its shoulder, no further: after a kart on the pavement it drove into the
        // buildings there)
        const want = Math.max(-POLICE_ROAD, Math.min(POLICE_ROAD, player.offset)), d = want - o.offset;
        o.offset += Math.sign(d) * Math.min(Math.abs(d), POLICE_STEER * dt);
      }
      if (o.state === POLICE_CHASE && !slow && o.age > 2.5 && gap > 0 && gap < POLICE_LUNGE_AT && Math.abs(player.offset - o.offset) < 1.5) {
        o.state = POLICE_LUNGE; // (on its line now, it goes for the ram)
        o.t = 0;
      }
      if (o.state === POLICE_LUNGE && (o.t > 1.8 || gap < -2 || slow)) { o.state = POLICE_BACK; o.t = 0; } // (missed)
      if (o.state === POLICE_BACK && o.t > 2.5) { o.state = POLICE_CHASE; o.t = 0; }
      const lost = gap > POLICE_SHAKEN; // (left behind: the player has shaken it off)
      if (o.hits >= 2 || lost || o.age > 26 || player.finished) {
        if (lost && !player.finished) this.events.push({ sound: "shaken", player: true, x: player.x, y: player.y });
        o.state = POLICE_GONE;
        o.t = 0;
      }
    } else {
      o.v = Math.max(0, o.v - 12 * dt);
      o.offset += (o.side * (HALF_WIDTH + 3) - o.offset) * Math.min(1, dt);
    }
    o.s += o.v * dt;
    if (!track.locked) o.s = Math.min(o.s, track.s[track.count - 1] ?? 0);
    o.idx = this.indexAt(track, o.s);
    o.z = track.elev[o.idx] ?? 0;
    const [tx, ty] = track.tangent(o.idx);
    o.heading = Math.atan2(ty, tx) + (o.state === POLICE_SPUN ? o.t * 9 : 0); // (spun out, it turns round and round)
    o.hot = o.state === POLICE_LUNGE;
    if (o.state === POLICE_GONE) this.cooldown = 12;
    this.locate(track, o);
    // run over the player's oil, hit by a puck, caught in a bomb's blast...: spun out
    if ((o.state === POLICE_CHASE || o.state === POLICE_LUNGE || o.state === POLICE_BACK) && this.strike?.(o.x, o.y, o.z)) {
      o.state = POLICE_SPUN;
      o.t = 0;
      o.hits += 1;
      this.events.push({ sound: "spun", player: false, x: o.x, y: o.y });
    }
  }

  /** Whether a police car is after the player right now (its siren is going). */
  get chasing(): boolean {
    return this.list.some((o) => o.kind === "police" && o.state !== POLICE_GONE);
  }

  /** Whether a police car is going for the ram right now (a sidestep dodges it). */
  get lunging(): boolean {
    return this.list.some((o) => o.kind === "police" && o.state === POLICE_LUNGE);
  }

  // ----------------------------------------------------------------------------------- geysers

  /** Quiet, then a glow and a bubbling for a second (the warning), then a column of lava and fire. */
  private geyser(o: Obstacle): void {
    if (o.state === GEYSER_QUIET && o.t > o.wait) { o.state = GEYSER_WARN; o.t = 0; }
    else if (o.state === GEYSER_WARN && o.t > GEYSER_WARN_TIME) { o.state = GEYSER_BLOW; o.t = 0; }
    else if (o.state === GEYSER_BLOW && o.t > GEYSER_BLOW_TIME) {
      o.state = GEYSER_QUIET;
      o.t = 0;
      o.wait = this.rng.range(2.5, 5);
    }
    o.hot = o.state === GEYSER_BLOW;
    o.z = o.state === GEYSER_BLOW ? GEYSER_HEIGHT : 0;
  }

  // ---------------------------------------------------------------------------- wrecking ball

  /** The ball's swing, in radians from straight down (positive: to the left of the road). */
  static swing(o: Obstacle): number {
    return WRECKER_SWING * Math.sin((2 * Math.PI * o.phase) / WRECKER_PERIOD);
  }

  /** Swinging across the road on its cable, a pendulum under the crane's jib. */
  private wrecker(o: Obstacle, track: Track): void {
    const a = Obstacles.swing(o);
    o.offset = WRECKER_CABLE * Math.sin(a);
    o.z = WRECKER_PIVOT - WRECKER_CABLE * Math.cos(a);
    o.hot = o.z < 3.2;
    this.locate(track, o);
  }

  // ----------------------------------------------------------------------------------- meteors

  private callMeteors(dt: number, track: Track, player: Kart, ps: number): void {
    this.spawnIn -= dt;
    if (this.spawnIn > 0 || player.finished) return;
    this.spawnIn = this.rng.range(3.5, 7);
    if (this.list.filter((o) => o.kind === "meteor").length >= 2) return;
    const s = ps + this.rng.range(70, 130);
    if (!track.locked && s > (track.s[track.count - 1] ?? 0) - 10) return;
    const o = this.make("meteor", track, this.indexAt(track, s), this.rng.range(-1, 1) * (HALF_WIDTH - 1.5));
    o.r = METEOR_BLAST;
    o.state = METEOR_FALL;
    o.z = METEOR_HEIGHT;
    o.side = this.rng.next() < 0.5 ? 1 : -1;
    this.list.push(o);
  }

  /** Falling at a slant onto the ring on the road, then a burst of rock and dust where it lands. */
  private meteor(o: Obstacle): void {
    if (o.state === METEOR_FALL) {
      const u = Math.min(1, o.t / METEOR_FALL_TIME);
      o.z = METEOR_HEIGHT * (1 - u) * (1 - u);
      o.hot = false;
      if (u >= 1) {
        o.state = METEOR_BURST;
        o.t = 0;
        o.z = 0;
        o.hot = true; // (for the one frame it lands)
        this.events.push({ sound: "impact", player: false, x: o.x, y: o.y });
        return;
      }
    } else {
      o.hot = false;
    }
  }

  // ----------------------------------------------------------------------------------- traffic

  private callTraffic(track: Track, ps: number): void {
    const cars = this.list.filter((o) => o.kind === "traffic");
    if (cars.length >= 4) return;
    const far = Math.max(-1, ...cars.map((o) => this.ahead(track, ps, o.s)));
    const s = ps + Math.max(far + this.rng.range(60, 95), 160);
    if (!track.locked && s > (track.s[track.count - 1] ?? 0) - 20) return;
    const lane = [-3.8, 0, 3.8][this.rng.int(0, 3)];
    const o = this.make("traffic", track, this.indexAt(track, s), lane);
    o.s = s;
    o.v = this.rng.range(12, 16.5);
    o.r = 1.7;
    o.hot = true;
    this.list.push(o);
  }

  /** Driving along the tunnel's floor in its lane, slower than any racer. */
  private traffic(o: Obstacle, dt: number, track: Track, _ps: number): void {
    o.s += o.v * dt;
    if (!track.locked) o.s = Math.min(o.s, track.s[track.count - 1] ?? 0);
    o.idx = this.indexAt(track, o.s);
    const [tx, ty] = track.tangent(o.idx);
    o.heading = Math.atan2(ty, tx);
    this.locate(track, o);
  }

  // -------------------------------------------------------------------------------------- hits

  /** Kart k against obstacle o: what happens if it is in the way (and low enough to hit). */
  private hit(o: Obstacle, k: Kart, track: Track): void {
    if (k.falling || k.finished || k.untouchable) return;
    const dx = k.x - o.x, dy = k.y - o.y;
    const ground = track.elev[k.idx] ?? 0, up = k.elev - ground; // how high over the road the kart is
    if (o.kind === "police" || o.kind === "traffic") {
      // a car: from behind (or beside), along its length
      const [tx, ty] = track.tangent(o.idx);
      const along = dx * tx + dy * ty, across = -dx * ty + dy * tx;
      if (Math.abs(along) > POLICE_LEN / 2 + 1.1 || Math.abs(across) > o.r || up > 1.2) return;
      // (backing off, pulling out or spun out; nor at a kart that is stopped or spinning)
      if (o.kind === "police" && (!o.hot || k.v < 6 || k.spin > 0)) return;
      k.spinOut(0.9);
      const shove = across >= 0 ? 1.4 : -1.4; // pushed off to the side it is on
      k.x += -ty * shove;
      k.y += tx * shove;
      if (o.kind === "police") {
        o.hits += 1;
        o.state = POLICE_BACK;
        o.t = 0;
        o.v = Math.min(o.v, k.v);
        this.events.push({ sound: "ram", player: k.isPlayer, x: o.x, y: o.y });
      } else {
        k.v = Math.min(k.v, o.v * 0.6);
        this.events.push({ sound: "honk", player: k.isPlayer, x: o.x, y: o.y });
      }
      return;
    }
    const d = Math.hypot(dx, dy);
    if (d > o.r) return;
    switch (o.kind) {
      case "cow":
        if (up > 1.5 || o.state === COW_STARTLED) return;
        k.spinOut(1.1);
        o.state = COW_STARTLED;
        o.t = 0;
        this.events.push({ sound: "moo", player: k.isPlayer, x: o.x, y: o.y });
        break;
      case "tumbleweed":
        if (up > o.z + 1) return;
        k.v *= 0.72;
        o.state = 1; // burst
        this.events.push({ sound: "puff", player: k.isPlayer, x: o.x, y: o.y });
        break;
      case "jelly":
        if (up > o.z + 0.9) return;
        if (!k.spinOut(0.9)) return;
        o.phase += 2.5; // (it shoots up out of the way)
        this.events.push({ sound: "zap", player: k.isPlayer, x: o.x, y: o.y });
        break;
      case "geyser":
        if (!k.spinOut(1.0)) return;
        k.air = true;
        k.vz = Math.max(k.vz, 8.5);
        k.elev = Math.max(k.elev, ground + 0.3);
        this.events.push({ sound: "geyser", player: k.isPlayer, x: o.x, y: o.y });
        break;
      case "wrecker": {
        if (Math.abs(up + 0.6 - o.z) > 1.9) return;
        if (!k.spinOut(1.4)) return;
        const [tx, ty] = track.tangent(o.idx);
        const swingDir = Math.sign(Math.cos((2 * Math.PI * o.phase) / WRECKER_PERIOD)) || 1; // which way the ball moves
        k.x += -ty * 3 * swingDir;
        k.y += tx * 3 * swingDir;
        k.v *= 0.55;
        this.events.push({ sound: "clang", player: k.isPlayer, x: o.x, y: o.y });
        break;
      }
      case "meteor":
        if (!k.spinOut(1.2)) return;
        k.air = true;
        k.vz = Math.max(k.vz, 5.5);
        k.elev = Math.max(k.elev, ground + 0.3);
        break;
      default:
        break;
    }
  }

  /** What rivals should steer round: where each obstacle that could hit them is. */
  dangers(): { x: number; y: number; r: number }[] {
    return this.list.filter((o) => (o.kind === "meteor" && o.state === METEOR_FALL) || o.hot ||
      (o.kind === "geyser" && o.state === GEYSER_WARN) || (o.kind === "wrecker" && o.z < 6))
      .map((o) => ({ x: o.x, y: o.y, r: o.kind === "wrecker" ? 3 : o.r + 0.5 }));
  }
}
