// Cuttings: stretches of road where the land rises in walls beside it, so the road runs down
// through the land rather than across it. Grassy banks with a dry-stone wall at their foot in the
// valley, a canyon of red rock in strata on the mesa, walls of rock and coral on the reef, rows of
// shop fronts and lit buildings in Tokyo, basalt cliffs with glowing seams in the volcano, site
// hoardings with containers stacked behind them on the building site, banks of regolith on the
// moon. Set out on flat road once its climbs are decided, clear of bridges, tunnels and whatever
// must come in from the side (cows, police alleys, a crane's mast); a wall keeps karts on the road
// and the shoulder beside it.

import { HALF_WIDTH } from "./track";

export type BankStyle = "grass" | "canyon" | "coral" | "street" | "basalt" | "hoarding" | "regolith";

/** A wall ``h`` m tall along arc lengths [s0, s0 + len), on ``side`` (1 the left, -1 the right). */
export interface Bank { s0: number; len: number; side: 1 | -1; h: number; style: BankStyle }

/** A world's cuttings: how long and tall, how far apart, and how often there is a wall on both
 * sides (a canyon, a street) rather than one. */
export interface BankRule { style: BankStyle; len: [number, number]; h: [number, number]; gap: [number, number]; both: number }

/** m from the centerline to the foot of a wall: past the road and its shoulder. */
export const BANK_AT = HALF_WIDTH + 2.4;
/** How far a wall leans back as it rises (m out per m up), by style: a street's fronts stand
 * upright, a grassy bank lies well back. */
export const BANK_LEAN: Record<BankStyle, number> = {
  grass: 0.7, canyon: 0.18, coral: 0.35, street: 0, basalt: 0.12, hoarding: 0, regolith: 0.8,
};
