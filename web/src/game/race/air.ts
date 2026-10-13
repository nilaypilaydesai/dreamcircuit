// The sky (themes.ts: Sky Isles): the whole race on the wing, every kart a little plane that
// race/kart.ts flies. The dreamed circuit is a course through the air SKY_BASE m over the sea, rising
// and diving as it goes (its climbs, which build nothing under them), marked out by balloons either
// side and threaded with rings to fly through, and with updrafts to ride up and dive out of. This
// places the rings and the updrafts on road as it is committed, as features.ts places pads and
// ramps (by where they are along the lap, never from the race's random numbers, so everything else
// lies where it would have), and says when a plane flies through one.

import type { Track } from "../world/track";
import type { Kart } from "./kart";

export const SKY_BASE = 55; // m over the sea the course flies (its climbs go higher)
export const SKY_LANE = 26; // m either side of the course's middle line before the wind turns a plane back in
export const SKY_CEIL = 34; // m over the course a plane can climb (the air thins out)
export const RING_R = 4.2; // m: how near a ring's middle a plane must fly through it
export const RING_GAP = 115; // m along the course between rings (about: each is set a little off)
export const RING_BOOST = 1.0, GOLD_BOOST = 1.7; // s of boost from a ring, and from a gold one (every fourth)
export const DRAFT_GAP = 430; // m between updrafts
export const DRAFT_LEN = 38, DRAFT_R = 7; // an updraft: m along the course, and its radius
export const DRAFT_LIFT = 24; // m/s^2 it lifts a plane by (up to DRAFT_RISE m/s of climb)
export const DRAFT_RISE = 16;
export const MARK_GAP = 24; // m between the balloons that mark out either side of the course
export const SKY_ITEM_SPREAD = 1.6; // how much wider than on a road a row of boxes is set out across the course

export interface Ring { start: number; s0: number; offset: number; lift: number; gold: boolean }
export interface Draft { start: number; s0: number; offset: number }

export class AirCourse {
  rings: Ring[] = [];
  drafts: Draft[] = [];
  private nextRing = 95;
  private nextDraft = 260;
  private count = 0;

  /** Rings and updrafts on newly committed road [from, to): a ring every RING_GAP m or so, weaving
   * across the course and up and down it, every fourth gold; an updraft every DRAFT_GAP m, to one
   * side. ``blocked(s, len)`` keeps them off the grid and the run to the line. */
  onCommit(track: Track, from: number, to: number, blocked: (s: number, len: number) => boolean): void {
    for (let i = Math.max(from, 8); i < to; i++) {
      const s = track.s[i];
      if (s >= this.nextRing && track.fromStart(i) > 70) {
        this.nextRing = s + RING_GAP * (0.85 + 0.3 * wave(s, 0.013));
        if (!blocked(s - 4, 8)) {
          const gold = this.count++ % 4 === 3;
          this.rings.push({ start: i, s0: s, offset: 10 * Math.sin(s / 97) * (gold ? 0.6 : 1), lift: 2.5 + 6 * Math.sin(s / 71 + 1.3), gold });
        }
      }
      if (s >= this.nextDraft && track.fromStart(i) > 120) {
        this.nextDraft = s + DRAFT_GAP * (0.85 + 0.3 * wave(s, 0.007));
        if (!blocked(s - 5, DRAFT_LEN + 10)) {
          this.drafts.push({ start: i, s0: s, offset: (Math.sin(s / 53) >= 0 ? 1 : -1) * (8 + 6 * wave(s, 0.031)) });
        }
      }
    }
  }

  /** The ring kart k flew through, going from arc length ``s0`` to ``s1`` this frame (s1 > s0; on
   * a locked lap ``L`` long, either may have wrapped), if any: inside its radius across and up. */
  through(track: Track, k: Kart, s0: number, s1: number): Ring | null {
    const L = track.locked ? track.length : Infinity;
    for (const r of this.rings) {
      const d0 = around(r.s0 - s0, L), d1 = around(r.s0 - s1, L);
      if (!(d0 > 0 && d1 <= 0)) continue; // (its plane crossed between the two)
      const up = k.elev - (track.elev[r.start] ?? 0) - r.lift;
      if (Math.hypot(k.offset - r.offset, up) < RING_R) return r;
    }
    return null;
  }

  /** Whether kart k is in an updraft (along it, within its radius across, under its top). */
  inDraft(track: Track, k: Kart): boolean {
    const s = track.s[k.idx], L = track.locked ? track.length : Infinity;
    return this.drafts.some((d) => {
      const a = around(s - d.s0, L);
      return a >= 0 && a <= DRAFT_LEN && Math.abs(k.offset - d.offset) < DRAFT_R && k.elev < (track.elev[d.start] ?? 0) + 30;
    });
  }
}

/** A smooth 0..1 wave along the lap (where along it ``s`` is, at ``f`` cycles a meter). */
function wave(s: number, f: number): number {
  return 0.5 + 0.5 * Math.sin(s * f * Math.PI * 2);
}

/** ``d`` folded into (-L/2, L/2] round a lap of length ``L`` (Infinity: not yet locked). */
function around(d: number, L: number): number {
  if (!Number.isFinite(L)) return d;
  return ((((d + L / 2) % L) + L) % L) - L / 2;
}
