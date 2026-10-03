// Which item a box gives: the classic's own odds. The distributions are those of Mario Kart 8
// (version 4.1, its Grand Prix tables, as transcribed on the Super Mario Wiki), item for item,
// with this game's own item standing in for each of the classic's: one table for the player and
// one for computer drivers, each in nine tiers of distance behind the race leader. The classic
// measures that distance in its own units; they are read here at 2.5 cm a unit (a kart is about
// 2 m long in both games). The values are percent times two, as in the source. The later Deluxe
// edition added an item that steals and turns its user into a phantom, given mid-pack; it takes
// 2.5% in the second to fourth tiers here (PHANTOM). Pure data and arithmetic, tested headlessly.

export type ItemKind =
  | "turbo" | "triple" | "gold" // a boost, three of them, and a golden one: boosts on every press for a while
  | "oil" | "oil3" // dropped behind; three of them, trailing as a shield
  | "puck" | "puck3" // thrown where the arrow is locked, bouncing off the edges of the road
  | "orb" | "orb3" // homes onto the kart ahead
  | "comet" // flies to the leader and comes down on them
  | "bomb" // lobbed after the racer one place ahead; its blast catches everyone near
  | "rocket" // the kart flies itself up the road
  | "static" // fills the screens of everyone ahead with static
  | "shock" // spins and shrinks everyone else
  | "prism" // invincible and faster
  | "flares" // a handful of seconds of bouncing fireballs
  | "boomerang" // thrown where the arrow is locked, and back, three times
  | "grabber" // a claw in front of the kart that snaps at karts and items, a boost with each bite
  | "horn" // a blast of sound: spins karts close by and knocks every item near out of the air, a comet too
  | "jackpot" // eight items circling the kart, used one by one
  | "coin" // two coins: every coin is a little more top speed
  | "phantom"; // see-through and untouchable for a while, and steals someone's item

/** Every item, in the order the HUD's roulette shows them. */
export const ITEM_KINDS: ItemKind[] = [
  "turbo", "triple", "gold", "oil", "oil3", "puck", "puck3", "orb", "orb3", "comet", "bomb", "rocket", "static",
  "shock", "prism", "flares", "boomerang", "grabber", "horn", "jackpot", "coin", "phantom",
];

/** The classic's table columns, in its order, as this game's items. */
const COLUMNS: ItemKind[] = [
  "oil", "puck", "orb", "turbo", "bomb", "static", "comet", "triple", "prism", "rocket", "shock", "gold", "flares",
  "grabber", "horn", "boomerang", "coin", "oil3", "puck3", "orb3", "jackpot",
];

/** m behind the leader at which each tier ends (the last tier has no end). */
const TIERS = { player: [10, 25, 50, 82.5, 137.5, 200, 325, 650], rival: [7.5, 17.5, 32.5, 65, 112.5, 175, 325, 650] };

/** The distributions: one row per tier, one value per column, percent x2. */
const TABLES: Record<"player" | "rival", number[][]> = {
  player: [
    [65, 50, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 70, 0, 0, 0, 0],
    [20, 25, 50, 20, 10, 0, 0, 0, 0, 0, 0, 0, 10, 10, 5, 5, 15, 15, 10, 5, 0],
    [10, 20, 30, 25, 15, 0, 0, 15, 0, 0, 0, 0, 10, 15, 5, 10, 5, 10, 10, 15, 5],
    [0, 15, 20, 50, 5, 5, 0, 60, 0, 0, 0, 0, 5, 5, 0, 10, 0, 0, 10, 10, 5],
    [0, 0, 10, 30, 0, 5, 5, 85, 25, 10, 0, 25, 0, 0, 0, 0, 0, 0, 0, 0, 5],
    [0, 0, 0, 10, 0, 0, 5, 65, 40, 30, 5, 40, 0, 0, 0, 0, 0, 0, 0, 0, 5],
    [0, 0, 0, 0, 0, 0, 5, 35, 35, 60, 10, 55, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 10, 30, 85, 15, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 30, 40, 70, 0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
  rival: [
    [50, 40, 15, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 70, 10, 0, 0, 0],
    [25, 30, 60, 15, 5, 0, 0, 0, 0, 0, 0, 0, 5, 10, 5, 5, 20, 10, 10, 0, 0],
    [30, 35, 30, 25, 10, 0, 0, 10, 0, 0, 0, 0, 10, 5, 0, 10, 15, 10, 10, 0, 0],
    [30, 35, 15, 45, 10, 5, 0, 25, 0, 0, 0, 0, 5, 5, 0, 5, 5, 0, 15, 0, 0],
    [30, 35, 5, 50, 0, 5, 3, 47, 10, 0, 0, 10, 0, 0, 0, 0, 0, 0, 5, 0, 0],
    [15, 20, 0, 50, 0, 0, 4, 58, 20, 10, 3, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [10, 10, 0, 30, 0, 0, 0, 57, 30, 30, 3, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [10, 10, 0, 10, 0, 0, 0, 42, 30, 55, 3, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 30, 0, 0, 0, 60, 30, 50, 0, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
};
/** The phantom's share (percent x2) in the tiers where the later edition gives it. */
const PHANTOM = [0, 5, 5, 5, 0, 0, 0, 0, 0];

/** The rocket keeps this game's own rule on top of the classic's odds (it once carried last place
 * straight into the lead): only the kart in last place, in a field of three or more, at least
 * ROCKET_GAP m behind the kart ahead of it, gets one. */
export const ROCKET_GAP = 60; // m

export interface Standing {
  behind: number; // m of race distance behind the leader (0 for the leader)
  last: boolean; // in last place
  gapAhead: number; // m behind the kart one place ahead
  field: number; // karts in the race
  player: boolean; // the player's odds, or a computer driver's
}

/** The tier a kart is in. */
export function tierOf(behind: number, player: boolean): number {
  const t = TIERS[player ? "player" : "rival"];
  let k = 0;
  while (k < t.length && behind > t[k]) k++;
  return k;
}

/** The odds of each item (summing to 1) for a kart standing like this; ``unavailable`` items (one
 * comet at a time, a shock that has just gone off) give their share to the rest. */
export function itemOdds(s: Standing, unavailable: ReadonlySet<ItemKind> = new Set()): Record<ItemKind, number> {
  const k = tierOf(Math.max(0, s.behind), s.player);
  const row = TABLES[s.player ? "player" : "rival"][k];
  const w = Object.fromEntries(ITEM_KINDS.map((i) => [i, 0])) as Record<ItemKind, number>;
  COLUMNS.forEach((item, c) => { w[item] = row[c]; });
  w.phantom = PHANTOM[k];
  const rocketOk = s.field >= 3 && s.last && s.gapAhead >= ROCKET_GAP;
  if (!rocketOk) w.rocket = 0;
  for (const i of unavailable) w[i] = 0;
  let sum = ITEM_KINDS.reduce((a, i) => a + w[i], 0);
  if (sum <= 0) { w.turbo = 1; sum = 1; } // (everything this tier gives is unavailable)
  for (const i of ITEM_KINDS) w[i] /= sum;
  return w;
}

/** Draw an item with ``u`` uniform in [0, 1). */
export function pickItem(odds: Record<ItemKind, number>, u: number): ItemKind {
  for (const i of ITEM_KINDS) {
    u -= odds[i];
    if (u < 0) return i;
  }
  return "turbo";
}
