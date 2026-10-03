// Track features, placed on dreamed road as it is committed:
//   jump ramps on long straights: fly off the lip, and hop (the drift button) right at the lip
//   for a trick that pays a boost on landing;
//   boost pads at corner exits;
//   tunnels through rock on straights, in the mountains (their walls keep karts in).
// Pure logic (no rendering), unit-tested headlessly.

import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import type { Kart } from "./kart";

export const RAMP_LEN = 11; // m
export const RAMP_HEIGHT = 1.7; // m at the lip
export const PAD_LEN = 7; // m
export const PAD_HALF = 2.6; // m, half the pad's width
const RAMP_GAP = 260; // m between ramps
const PAD_GAP = 170; // m between pads
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

export class Features {
  ramps: Ramp[] = [];
  pads: Pad[] = [];
  tunnels: Tunnel[] = [];
  private straight = 0; // m of straight road in a row, at the end of what was scanned
  private tunnelRun = 0; // m of gently curving flat road in a row
  private lastTunnel = -Infinity;

  /** ``tunnels``: bore tunnels (the mountain world). */
  constructor(private readonly withTunnels = false) {}

  /** Whether arc lengths [s, s + len) overlap a tunnel (with a margin either side). */
  private tunnelNear(s: number, len: number, margin = 20): boolean {
    return this.tunnels.some((t) => t.s0 < s + len + margin && t.s0 + TUNNEL_LEN > s - margin);
  }
  private cornerSince = -1; // dense index where the last tight corner ended
  private lastRamp = -Infinity;
  private lastPad = -Infinity;

  /** Place features on newly committed road ``[from, to)``. ``blocked(s)`` says whether a
   * stretch is taken (bridges, item boxes, the start). */
  onCommit(track: Track, from: number, to: number, blocked: (s: number, len: number) => boolean,
           rng: () => number): void {
    for (let i = Math.max(from, 8); i < to; i++) {
      const k = Math.abs(track.curvature(i));
      const s = track.s[i];
      // dreamed straights carry a slight wiggle: a bend gentler than 170 m still lands a jump
      // (a 20 m flight drifts about a meter sideways), so it counts as straight here
      this.straight = k < 1 / 170 && track.elev[i] === 0 ? this.straight + SPACING : 0;
      // a ramp in the middle of a long straight
      if (this.straight > 85 && s - this.lastRamp > RAMP_GAP) {
        const s0 = s - 45;
        const start = i - Math.round(45 / SPACING);
        if (!blocked(s0 - 30, RAMP_LEN + 70) && track.fromStart(start) > 140 && !this.tunnelNear(s0 - 30, RAMP_LEN + 70)) {
          this.ramps.push({ start, s0 });
          this.lastRamp = s;
        }
      }
      // a tunnel through the rock on a long, gently curving stretch (the mountains)
      this.tunnelRun = k < 1 / 110 && track.elev[i] === 0 ? this.tunnelRun + SPACING : 0;
      if (this.withTunnels && this.tunnelRun > TUNNEL_LEN + 12 && s - this.lastTunnel > TUNNEL_GAP) {
        const s0 = s - TUNNEL_LEN - 6, start = i - Math.round((TUNNEL_LEN + 6) / SPACING);
        const rampHere = this.ramps.some((r) => r.s0 < s0 + TUNNEL_LEN + 30 && r.s0 + RAMP_LEN > s0 - 30);
        if (!rampHere && !blocked(s0 - 10, TUNNEL_LEN + 20) && track.fromStart(start) > 160) {
          this.tunnels.push({ start, s0, n: Math.round(TUNNEL_LEN / SPACING) });
          this.lastTunnel = s;
          this.tunnelRun = 0;
        }
      }
      // a boost pad as a tight corner opens up
      if (k > 1 / 35) this.cornerSince = i;
      else if (this.cornerSince >= 0 && k < 1 / 90 && i - this.cornerSince > Math.round(10 / SPACING)) {
        this.cornerSince = -1;
        if (s - this.lastPad > PAD_GAP && !blocked(s - 5, PAD_LEN + 10) && track.fromStart(i) > 60) {
          this.pads.push({ start: i, s0: s, offset: (rng() * 2 - 1) * (HALF_WIDTH - PAD_HALF - 1.2) });
          this.lastPad = s;
        }
      }
    }
  }

  /** Height of a ramp's surface under the kart (0 off ramps) and how far up it is (0..1). */
  rampUnder(track: Track, k: Kart): { height: number; u: number } {
    if (Math.abs(k.offset) > HALF_WIDTH) return { height: 0, u: -1 };
    const s = track.s[k.idx];
    for (const r of this.ramps) {
      const u = (s - r.s0) / RAMP_LEN;
      if (u >= 0 && u < 1) return { height: RAMP_HEIGHT * u, u };
    }
    return { height: 0, u: -1 };
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
