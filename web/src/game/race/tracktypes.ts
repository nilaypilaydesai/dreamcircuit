// Track types, picked on the setup screens under TRACK. Every circuit is still dreamed live, arc
// by arc, while the race runs; a type steers that dream and confirms what the circuit will have:
//   - the layout the designer is asked for: anything, a plain loop, or a figure-eight (whose
//     crossing becomes a bridge);
//   - a style program: the style each arc is asked for (0 calm .. 1 wild) and the band its
//     measured style must land in (an arc outside it is dreamed again while there is time), or,
//     for the classic, whatever the player's driving asks for;
//   - the rules for what is built on the road as it is committed (jumps, boost pads, climbs),
//     with minimum counts that are made good when the lap locks, on road no kart is near.
// Pure data (no rendering), unit-tested headlessly.

import type { Rand } from "../core/gfx";
import type { Layout } from "../world/track";

export type TrackTypeId = "classic" | "figure8" | "speedway" | "technical" | "grandtour" | "stunt" | "coaster";

/** The measured style (0 calm .. 1 wild) an arc must land in. */
export interface StyleBand { lo: number; hi: number }

/** Jumps: a ramp once ``straight`` m of road in a row bends no tighter than ``bend`` (1/m), at
 * least ``gap`` m after the last one. */
export interface RampRule { straight: number; bend: number; gap: number }

/** Boost pads: out of tight corners, at least ``gap`` m apart; with ``straights``, along long
 * straights too. */
export interface PadRule { gap: number; straights: boolean }

/** Climbs: their lengths, heights and the road between them (m), set on segments ``segs`` of
 * the lap (clear of the grid and the run to the line). */
export interface HillRule { len: [number, number]; h: [number, number]; gap: [number, number]; segs: [number, number] }

export interface TrackType {
  id: TrackTypeId;
  name: string;
  layout: Layout;
  /** What the circuit is sure to have (the setup screens, the dream and the countdown say it). */
  promise: string;
  /** The style asked of arc ``arc`` (0 is the grid and first stretch), given the style the
   * player's driving asks for. */
  style: (arc: number, driving: number) => number;
  /** The band an arc's measured style must land in (none: anything drivable). */
  band?: (arc: number) => StyleBand | null;
  ramps?: RampRule;
  pads?: PadRule;
  hills?: HillRule;
  /** Minimum counts, made good when the lap locks. */
  min?: { ramps?: number; pads?: number; hills?: number };
}

export const DEFAULT_RAMPS: RampRule = { straight: 85, bend: 1 / 170, gap: 260 };
export const DEFAULT_PADS: PadRule = { gap: 170, straights: false };
/** The mountains' climbs (any track type there). */
export const MOUNTAIN_HILLS: HillRule = { len: [110, 170], h: [3.5, 6.2], gap: [90, 180], segs: [24, 180] };

const CALM = 0.04, WILD = 0.96;
// asked for calm or wild, the designer's arcs measure about 0.32 and 0.87 on average
export const CALM_BAND: StyleBand = { lo: 0, hi: 0.45 };
export const WILD_BAND: StyleBand = { lo: 0.6, hi: 1 };

export const TRACK_TYPES: readonly TrackType[] = [
  {
    id: "classic", name: "CLASSIC", layout: "any",
    promise: "THE ROAD FOLLOWS YOUR DRIVING: FAST AND CLEAN DREAMS IT WILDER",
    style: (_arc, driving) => driving,
  },
  {
    id: "figure8", name: "FIGURE 8", layout: "figure8",
    promise: "A BRIDGE WHERE THE TRACK CROSSES ITSELF",
    style: (_arc, driving) => driving,
  },
  {
    id: "speedway", name: "SPEEDWAY", layout: "loop",
    promise: "FAST SWEEPERS, 2+ JUMPS, PADS ON THE STRAIGHTS",
    style: () => CALM, band: () => CALM_BAND,
    ramps: { straight: 70, bend: 1 / 150, gap: 200 }, pads: { gap: 150, straights: true },
    min: { ramps: 2, pads: 3 },
  },
  {
    id: "technical", name: "TECHNICAL", layout: "loop",
    promise: "TIGHT CORNERS ALL LAP, A PAD OUT OF THE HAIRPINS",
    style: () => WILD, band: () => WILD_BAND,
    pads: { gap: 60, straights: false }, min: { pads: 4 },
  },
  {
    id: "grandtour", name: "GRAND TOUR", layout: "any",
    promise: "ALTERNATING FAST AND TWISTY SECTIONS",
    // arc 0 (the grid and first stretch) is fast; then twisty, fast, twisty...
    style: (arc) => (arc % 2 ? WILD : CALM), band: (arc) => (arc % 2 ? WILD_BAND : CALM_BAND),
  },
  {
    id: "stunt", name: "STUNT PARK", layout: "figure8",
    promise: "A BRIDGE AND 3+ JUMPS",
    // calm arcs leave straights to jump on; the others may wander
    style: (arc) => (arc % 2 ? 0.55 : 0.08), band: (arc) => (arc % 2 ? null : CALM_BAND),
    ramps: { straight: 50, bend: 1 / 130, gap: 120 }, min: { ramps: 3 },
  },
  {
    id: "coaster", name: "ROLLER COASTER", layout: "loop",
    promise: "4+ CLIMBS AND DROPS ON EMBANKMENTS",
    style: (_arc, driving) => Math.max(0.05, driving - 0.1),
    hills: { len: [95, 150], h: [4, 6.5], gap: [40, 100], segs: [14, 222] }, min: { hills: 4 },
  },
];

export function trackType(id: TrackTypeId | undefined): TrackType {
  return TRACK_TYPES.find((t) => t.id === id) ?? TRACK_TYPES[0];
}

/** SURPRISE ME: a type at random. ``avoid``: types already raced (a Grand Prix varies them). */
export function surpriseType(rng: Rand, avoid: readonly TrackTypeId[] = []): TrackTypeId {
  const left = TRACK_TYPES.filter((t) => !avoid.includes(t.id));
  return rng.pick(left.length ? left : TRACK_TYPES).id;
}
