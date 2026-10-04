// Track features, placed on dreamed road as it is committed:
//   jump ramps on long straights: fly off the lip, and hop (the drift button) right at the lip
//   for a trick that pays a boost on landing;
//   boost pads at corner exits (and, on some track types, along the straights);
//   tunnels on straights, under buildings in Tokyo and through buildings going up on the building
//   site (their walls keep karts in).
// How long a straight earns a jump and how far apart pads are depend on the track type
// (race/tracktypes.ts); when the lap locks, a type's minimum counts are made good on the best
// free road left. Pure logic (no rendering), unit-tested headlessly.

import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import type { Kart } from "./kart";
import type { Bank } from "../world/banks";
import { TUBE_FLOOR, TUBE_R } from "../world/tube";
import { DEFAULT_PADS, DEFAULT_RAMPS, type PadRule, type RampRule } from "./tracktypes";

export const RAMP_LEN = 11; // m
export const RAMP_HEIGHT = 1.7; // m at the lip
export const PAD_LEN = 7; // m
export const PAD_HALF = 2.6; // m, half the pad's width
export const TUNNEL_LEN = 52; // m
export const TUNNEL_H = 5.8; // m from the road to the ceiling
const TUNNEL_GAP = 320; // m between tunnels

export interface Ramp {
  start: number; // dense index of the foot of the ramp
  s0: number; // its arc length
}

export interface Pad {
  start: number;
  s0: number;
  offset: number; // lateral position of the pad's centre
}

export interface Tunnel {
  start: number; // dense index of the mouth
  s0: number;
  n: number; // dense points through it
}

/** What a race builds: tunnels (Tokyo, the building site), the jump rule (null: no jumps) and the pad rule;
 * ``gravity``, relative to the usual, sets how far a jump flies (on the moon, three times as far). */
export interface FeatureRules { tunnels: boolean; ramps: RampRule | null; pads: PadRule; gravity: number; tube: boolean }

/** Where a top-up may build: ``free(s, len)`` says whether arc lengths [s, s + len) are clear of
 * bridges, item rows and karts. */
export type Free = (s: number, len: number) => boolean;

const FLIGHT = 45; // m from a ramp's foot to well past where karts land (in the usual gravity)
const TOPUP_BEND = 1 / 90; // the gentlest a top-up jump's flight may bend (a 20 m flight drifts 2 m)

export class Features {
  ramps: Ramp[] = [];
  pads: Pad[] = [];
  tunnels: Tunnel[] = [];
  /** Cuttings (world/banks.ts): walls of land beside the road, set out by the race. */
  banks: Bank[] = [];
  private straight = 0; // m of straight road in a row, at the end of what was scanned
  private tunnelRun = 0; // m of gently curving flat road in a row
  private lastTunnel = -Infinity;
  private readonly withTunnels: boolean;
  private readonly rampRule: RampRule | null;
  private readonly padRule: PadRule;
  /** m from a ramp's foot to well past where karts land: a kart flies about as much further as
   * gravity is weaker (the ramp itself is no longer). */
  readonly flight: number;
  private readonly straightFor: number; // m of straight road that earns a jump (room for the flight too)
  private readonly tube: boolean; // in the neon tunnel's tube: pads go on its walls and ceiling too

  /** ``rules``: what to build (true/false: the defaults, with or without tunnels). */
  constructor(rules: Partial<FeatureRules> | boolean = {}) {
    const r = typeof rules === "boolean" ? { tunnels: rules } : rules;
    this.withTunnels = !!r.tunnels;
    this.rampRule = r.ramps === undefined ? DEFAULT_RAMPS : r.ramps;
    this.padRule = r.pads ?? DEFAULT_PADS;
    this.flight = RAMP_LEN + (FLIGHT - RAMP_LEN) / (r.gravity ?? 1);
    this.straightFor = (this.rampRule?.straight ?? DEFAULT_RAMPS.straight) + this.flight - FLIGHT;
    this.tube = !!r.tube;
  }

  /** Whether arc lengths [s, s + len) overlap a tunnel (with a margin either side). */
  private tunnelNear(s: number, len: number, margin = 20): boolean {
    return this.tunnels.some((t) => t.s0 < s + len + margin && t.s0 + TUNNEL_LEN > s - margin);
  }
  private cornerSince = -1; // dense index where the last tight corner ended
  private lastRamp = -Infinity;
  private scanned = 0; // arc length of the last road scanned
  private lastPad = -Infinity;

  /** Place features on newly committed road ``[from, to)``. ``blocked(s)`` says whether a
   * stretch is taken (bridges, item boxes, the start). */
  onCommit(track: Track, from: number, to: number, blocked: (s: number, len: number) => boolean,
           rng: () => number): void {
    const rr = this.rampRule;
    for (let i = Math.max(from, 8); i < to; i++) {
      const k = Math.abs(track.curvature(i));
      const s = track.s[i];
      this.scanned = s;
      // dreamed straights carry a slight wiggle: a bend gentler than 170 m still lands a jump
      // (a 20 m flight drifts about a meter sideways), so it counts as straight here
      this.straight = k < (rr?.bend ?? DEFAULT_RAMPS.bend) && track.elev[i] === 0 ? this.straight + SPACING : 0;
      // a ramp in the middle of a long straight
      if (rr && this.straight > this.straightFor && s - this.lastRamp > rr.gap) {
        // (its foot on a road point, so the wedge drawn and the one driven up are the same)
        const start = track.indexBack(i, s - this.flight), s0 = track.s[start];
        if (!blocked(s0 - 30, RAMP_LEN + 70) && track.fromStart(start) > 140 && !this.tunnelNear(s0 - 30, RAMP_LEN + 70) &&
            !this.padNear(s0 - 15, this.flight + 15)) {
          this.ramps.push({ start, s0 });
          this.lastRamp = s;
        }
      }
      // a tunnel on a long, gently curving stretch (under a building in Tokyo, through one going up on the site)
      this.tunnelRun = k < 1 / 110 && track.elev[i] === 0 ? this.tunnelRun + SPACING : 0;
      if (this.withTunnels && this.tunnelRun > TUNNEL_LEN + 12 && s - this.lastTunnel > TUNNEL_GAP) {
        // (its mouths on road points: the tunnel drawn is the one whose walls keep karts in)
        const start = track.indexBack(i, s - TUNNEL_LEN - 6), s0 = track.s[start];
        const rampHere = this.ramps.some((r) => r.s0 < s0 + TUNNEL_LEN + 30 && r.s0 + RAMP_LEN > s0 - 30);
        if (!rampHere && !blocked(s0 - 10, TUNNEL_LEN + 20) && track.fromStart(start) > 160) {
          this.tunnels.push({ start, s0, n: track.indexBack(i, s0 + TUNNEL_LEN) - start });
          this.lastTunnel = s;
          this.tunnelRun = 0;
        }
      }
      // a boost pad as a tight corner opens up
      const pr = this.padRule;
      if (k > 1 / 35) this.cornerSince = i;
      else if (this.cornerSince >= 0 && k < 1 / 90 && i - this.cornerSince > Math.round(10 / SPACING)) {
        this.cornerSince = -1;
        if (s - this.lastPad > pr.gap) this.tryPad(track, i, blocked, rng);
      }
      // and, on the fast track types, along the straights (clear of the jumps)
      if (pr.straights && this.straight > 60 && s - this.lastPad > pr.gap) {
        const at = Math.max(8, i - Math.round(25 / SPACING));
        if (!this.rampNear(track.s[at] - 20, PAD_LEN + 40)) this.tryPad(track, at, blocked, rng);
      }
    }
  }

  /** Whether the straight the scan ended on may yet earn a jump (it is still running, long enough
   * to count, and the last jump is far enough back), reaching back before arc length ``s1``: a
   * climb up to there would take its place. */
  jumpPending(s1: number): boolean {
    const rr = this.rampRule;
    if (!rr || this.straight < 20) return false;
    return this.scanned - this.straight < s1 && this.scanned + (this.straightFor - this.straight) - this.lastRamp > rr.gap;
  }

  /** A pad at dense index ``i`` if the road there is free. */
  private tryPad(track: Track, i: number, blocked: (s: number, len: number) => boolean, rng: () => number): boolean {
    const s = track.s[i];
    if (blocked(s - 5, PAD_LEN + 10) || track.fromStart(i) <= 60 || this.tunnelNear(s - 5, PAD_LEN + 10, 5)) return false;
    this.pads.push({ start: i, s0: s, offset: this.padOffset(rng) });
    this.lastPad = s;
    return true;
  }

  /** Where across the road a pad goes: anywhere on it; in the tube, as often up a wall, and now and
   * then on the ceiling (where only a kart going fast enough to loop can reach it). */
  private padOffset(rng: () => number): number {
    if (!this.tube) return (rng() * 2 - 1) * (HALF_WIDTH - PAD_HALF - 1.2); // (one draw, as ever, outside the tube)
    const side = rng() < 0.5 ? 1 : -1, r = rng();
    if (r < 0.4) return (rng() * 2 - 1) * (HALF_WIDTH - PAD_HALF - 1.2);
    if (r < 0.82) return side * (TUBE_FLOOR + 1.5 + rng() * (Math.PI * TUBE_R - 3));
    return side * (TUBE_FLOOR + Math.PI * TUBE_R + 3.2);
  }

  /** Whether a jump (or where its karts land) is on arc lengths [s, s + len). */
  rampNear(s: number, len: number): boolean {
    return this.ramps.some((r) => r.s0 < s + len && r.s0 + this.flight > s);
  }

  private padNear(s: number, len: number): boolean {
    return this.pads.some((p) => p.s0 < s + len && p.s0 + PAD_LEN > s);
  }

  /** The most bent road (1/m) over dense indices [i, i + n), or Infinity past the end of the road
   * or anywhere it is raised (bridges, climbs). */
  private worstBend(track: Track, i: number, n: number): number {
    if (i + n >= track.count) return Infinity;
    let worst = 0;
    for (let j = i; j < i + n; j += 3) {
      if (track.elev[j] !== 0) return Infinity;
      worst = Math.max(worst, Math.abs(track.curvature(j)));
    }
    return worst;
  }

  /** Make good ``want`` jumps on a locked lap: on the straightest free stretches left (their
   * flight may bend no more than TOPUP_BEND), well apart from other jumps. Returns how many it
   * added. */
  topUpRamps(track: Track, want: number, free: Free, limit = TOPUP_BEND): number {
    const zone = Math.round(this.flight / SPACING);
    const spots: { i: number; bend: number }[] = [];
    for (let i = 8; i < track.count; i += 4) {
      const from = track.fromStart(i);
      if (from < 140 || from > track.length - 200) continue;
      const bend = this.worstBend(track, i, zone);
      if (bend < limit) spots.push({ i, bend });
    }
    spots.sort((a, b) => a.bend - b.bend);
    let added = 0;
    for (const { i } of spots) {
      if (added >= want) break;
      const s0 = track.s[i];
      if (this.ramps.some((r) => Math.abs(r.s0 - s0) < 120) || this.padNear(s0 - 15, this.flight + 15) ||
          this.tunnelNear(s0 - 30, RAMP_LEN + 70) || !free(s0 - 30, RAMP_LEN + 70)) continue;
      this.ramps.push({ start: i, s0 });
      added += 1;
    }
    this.ramps.sort((a, b) => a.s0 - b.s0);
    return added;
  }

  /** Make good ``want`` boost pads on a locked lap, where the road is fairly straight and free,
   * well apart from other pads and clear of the jumps. Returns how many it added. */
  topUpPads(track: Track, want: number, free: Free, rng: () => number): number {
    const zone = Math.round((PAD_LEN + 10) / SPACING);
    const spots: { i: number; bend: number }[] = [];
    for (let i = 8; i < track.count; i += 5) {
      const from = track.fromStart(i);
      if (from < 60 || from > track.length - 120) continue;
      const bend = this.worstBend(track, i, zone);
      if (bend < 1 / 60) spots.push({ i, bend });
    }
    spots.sort((a, b) => a.bend - b.bend);
    let added = 0;
    for (const { i } of spots) {
      if (added >= want) break;
      const s0 = track.s[i];
      if (this.pads.some((p) => Math.abs(p.s0 - s0) < 70) || this.rampNear(s0 - 20, PAD_LEN + 40) ||
          this.tunnelNear(s0 - 5, PAD_LEN + 10, 5) || !free(s0 - 5, PAD_LEN + 10)) continue;
      this.pads.push({ start: i, s0, offset: this.padOffset(rng) });
      added += 1;
    }
    this.pads.sort((a, b) => a.s0 - b.s0);
    return added;
  }

  /** Height of a ramp's surface under the kart (0 off ramps) and how far up it is (0..1). */
  rampUnder(track: Track, k: Kart, along = 0): { height: number; u: number } {
    // (where the kart is between road points: the wedge rises smoothly)
    return this.rampAt(track.s[k.idx] + along, k.offset);
  }

  /** How high a jump ramp lifts the road at arc length ``s``, ``offset`` m left of the centerline,
   * and how far up the ramp that is (0 at its foot, 1 at the lip; -1 off any ramp). */
  rampAt(s: number, offset: number): { height: number; u: number } {
    if (Math.abs(offset) > HALF_WIDTH) return { height: 0, u: -1 };
    for (const r of this.ramps) {
      const u = (s - r.s0) / RAMP_LEN;
      if (u >= 0 && u < 1) return { height: RAMP_HEIGHT * u, u };
    }
    return { height: 0, u: -1 };
  }

  /** The cutting's wall beside arc length ``s`` on ``side`` (1 the left, -1 the right), if any. */
  bankAt(s: number, side: number): Bank | undefined {
    return this.banks.find((b) => b.side === side && s >= b.s0 && s < b.s0 + b.len);
  }

  /** Whether arc length ``s`` is inside a tunnel. */
  tunnelAt(s: number): boolean {
    return this.tunnels.some((t) => s >= t.s0 && s <= t.s0 + TUNNEL_LEN);
  }

  /** Whether the kart is driving through a tunnel (its walls keep it on the road). */
  inTunnel(track: Track, k: Kart): boolean {
    return Math.abs(k.offset) < HALF_WIDTH + 2 && this.tunnelAt(track.s[k.idx]);
  }

  /** Whether the kart is on a boost pad. */
  onPad(track: Track, k: Kart): boolean {
    if (k.air) return false;
    const s = track.s[k.idx];
    for (const p of this.pads) {
      if (s >= p.s0 && s < p.s0 + PAD_LEN && Math.abs(k.offset - p.offset) < PAD_HALF + 0.4) return true;
    }
    return false;
  }
}
