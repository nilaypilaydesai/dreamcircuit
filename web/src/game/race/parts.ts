// The garage: kart parts and what they do. A kart is a body, a set of wheels, a spoiler and an
// exhaust (plus paint, which is only looks). Every part shifts six stats, the same six a classic
// kart racer shows you: SPEED, ACCELERATION, WEIGHT, HANDLING, TRACTION and MINI-TURBO, each on a
// 0-20 point scale around a neutral 10. Bodies take their cues from real supercars and real
// tuner parts, under names of their own. Pure data and arithmetic: rendering is in sprites.ts.

import type { Rand } from "../core/gfx";
import type { Difficulty } from "./kart";

export const STAT_KEYS = ["speed", "accel", "weight", "handling", "traction", "turbo"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Record<StatKey, number>;
export const STAT_LABELS: Record<StatKey, string> = {
  speed: "SPEED", accel: "ACCEL", weight: "WEIGHT", handling: "HANDLING", traction: "TRACTION", turbo: "MINI-TURBO",
};
export const STAT_MAX = 20;

export interface Part {
  id: string;
  name: string; // at most 14 characters, for the garage panel
  note: string; // one line about it
  stats: Partial<Stats>; // points added to the neutral 10
}

export interface Paint { id: string; name: string; color: string }

export const BODIES: Part[] = [
  { id: "classic", name: "CLASSIC KART", note: "THE ORIGINAL GO-KART. BALANCED IN EVERY WAY", stats: {} },
  { id: "corsa", name: "CORSA V8", note: "ITALIAN MID-ENGINE V8 WITH A PRANCING STANCE",
    stats: { speed: 2, handling: 2, accel: -2, weight: -1, traction: -1 } },
  { id: "toro", name: "TORO V12", note: "RAGING-BULL WEDGE WITH A V12. HUGE TOP END",
    stats: { speed: 4, weight: 2, accel: -3, handling: -2, turbo: -1 } },
  { id: "papaya", name: "PAPAYA GT", note: "BRITISH CARBON-TUB SUPERCAR, BORN AT THE TRACK",
    stats: { speed: 2, turbo: 2, accel: 1, weight: -2, traction: -2, handling: -1 } },
  { id: "boxer", name: "BOXER RS", note: "REAR-ENGINE FLAT-SIX. CORNERS LIKE IT IS ON RAILS",
    stats: { handling: 3, traction: 2, speed: -2, weight: -1, turbo: -1 } },
  { id: "hyper", name: "HYPER W16", note: "QUAD-TURBO W16 HYPERCAR. HEAVY, AND FAST",
    stats: { speed: 5, weight: 3, accel: -4, handling: -3, traction: -1 } },
  { id: "ghost", name: "GHOST CC", note: "SWEDISH MEGACAR. LIGHT, LOUD AND A LITTLE WILD",
    stats: { speed: 3, turbo: 2, accel: 1, traction: -3, handling: -1, weight: -2 } },
  { id: "tsukuba", name: "TSUKUBA R", note: "JDM TWIN-TURBO TUNER LEGEND. LIVES FOR DRIFT",
    stats: { turbo: 4, accel: 2, handling: 1, speed: -2, weight: -2, traction: -3 } },
  { id: "pony", name: "PONY V8", note: "AMERICAN MUSCLE. BIG BLOCK, BIGGER BUMPS",
    stats: { speed: 2, weight: 4, accel: 1, handling: -4, traction: -2, turbo: -1 } },
  { id: "kei", name: "KEI SPRINT", note: "TINY JAPANESE CITY CAR. QUICKEST OFF THE LINE",
    stats: { accel: 4, handling: 3, turbo: 1, speed: -4, weight: -4 } },
  { id: "rally", name: "RALLY HATCH", note: "ALL-WHEEL-DRIVE GRAVEL HATCH. GRIPS ANYWHERE",
    stats: { traction: 5, accel: 2, handling: 1, speed: -3, weight: -1, turbo: -2 } },
  { id: "lmp", name: "LE MANS LMP", note: "ENDURANCE PROTOTYPE WITH A SHARK FIN",
    stats: { speed: 2, handling: 2, turbo: 2, weight: -2, traction: -3, accel: -1 } },
  { id: "volt", name: "VOLT EV", note: "ELECTRIC HYPERCAR. ALL THE TORQUE AT ONCE",
    stats: { accel: 5, speed: 1, weight: 2, traction: 1, turbo: -4, handling: -2 } },
];

export const WHEELS: Part[] = [
  { id: "standard", name: "STANDARD", note: "ALL-ROUND KART TIRES", stats: {} },
  { id: "slicks", name: "RACE SLICKS", note: "NO TREAD AT ALL: FAST ON TARMAC, LOST ON GRASS",
    stats: { speed: 2, handling: 1, traction: -3 } },
  { id: "semi", name: "SEMI-SLICKS", note: "TRACK-DAY TIRES THAT STILL HAVE A LITTLE TREAD",
    stats: { speed: 1, handling: 1, traction: -1, turbo: -1 } },
  { id: "offroad", name: "OFF-ROAD", note: "CHUNKY KNOBBY TREAD FOR THE DIRT",
    stats: { traction: 4, weight: 1, speed: -2, handling: -1, accel: -1 } },
  { id: "drag", name: "DRAG RADIALS", note: "WRINKLE-WALL LAUNCH TIRES",
    stats: { accel: 3, speed: 1, handling: -3, traction: -1 } },
  { id: "deepdish", name: "DEEP-DISH", note: "STANCED DEEP-DISH RIMS WITH A POLISHED LIP",
    stats: { turbo: 2, handling: 1, weight: 1, accel: -2, speed: -1 } },
  { id: "monoblock", name: "MONOBLOCK", note: "FORGED ONE-PIECE RIMS. LIGHT AND STIFF",
    stats: { accel: 2, handling: 1, weight: -1, speed: -1, traction: -1 } },
  { id: "carbon", name: "CARBON FIBER", note: "FEATHERWEIGHT CARBON BARRELS",
    stats: { accel: 3, turbo: 1, weight: -2, traction: -2 } },
  { id: "turbofan", name: "TURBOFAN", note: "ENDURANCE-RACE COOLING-FAN COVERS",
    stats: { speed: 3, turbo: -2, accel: -1 } },
  { id: "mesh", name: "CROSS MESH", note: "CLASSIC CROSS-SPOKE MESH RIMS",
    stats: { handling: 2, traction: 1, speed: -1, accel: -1 } },
  { id: "steelies", name: "STEELIES", note: "PLAIN STEEL WHEELS. BUILT TOUGH",
    stats: { weight: 3, traction: 2, speed: -2, accel: -2, turbo: -1 } },
  { id: "whitewall", name: "WHITEWALLS", note: "LOWRIDER WHITEWALLS AND CHROME CAPS",
    stats: { turbo: 3, handling: -1, speed: -1, traction: -1 } },
  { id: "gold", name: "GOLD SPLIT", note: "GOLD SPLIT-SPOKE SHOW RIMS",
    stats: { turbo: 2, accel: 1, speed: -1, weight: -1, traction: -1 } },
];

export const SPOILERS: Part[] = [
  { id: "none", name: "NONE", note: "A CLEAN DECK", stats: {} },
  { id: "lip", name: "LIP SPOILER", note: "A SUBTLE LIP ON THE TAIL", stats: { handling: 1, turbo: -1 } },
  { id: "ducktail", name: "DUCKTAIL", note: "THE CLASSIC UPSWEPT DUCKTAIL",
    stats: { speed: 1, handling: 1, accel: -1, traction: -1 } },
  { id: "whale", name: "WHALE TAIL", note: "A BIG FLAT EIGHTIES WHALE TAIL",
    stats: { traction: 2, handling: 1, weight: 1, speed: -2, accel: -1 } },
  { id: "gtwing", name: "GT WING", note: "ADJUSTABLE GT RACING WING ON TWIN STANDS",
    stats: { handling: 3, traction: 1, weight: 1, speed: -2, accel: -1, turbo: -1 } },
  { id: "swan", name: "SWAN NECK", note: "TOP-MOUNTED SWAN-NECK WING. CLEAN AIR BELOW",
    stats: { handling: 2, turbo: 2, speed: -2, weight: -1, traction: -1 } },
  { id: "chassis", name: "CHASSIS MOUNT", note: "TIME-ATTACK WING BOLTED TO THE FRAME",
    stats: { traction: 3, handling: 2, weight: 2, speed: -3, accel: -2 } },
  { id: "double", name: "DOUBLE DECK", note: "TWO-ELEMENT WING FOR MAXIMUM DOWNFORCE",
    stats: { handling: 4, speed: -3, accel: -1 } },
  { id: "active", name: "ACTIVE AERO", note: "A SELF-ADJUSTING WING THAT DOUBLES AS AN AIRBRAKE",
    stats: { speed: 1, handling: 1, turbo: 1, weight: 1, accel: -2, traction: -1 } },
  { id: "sharkfin", name: "SHARK FIN", note: "PROTOTYPE STABILITY FIN", stats: { speed: 1, turbo: 1, handling: -1, weight: -1 } },
];

export const EXHAUSTS: Part[] = [
  { id: "stock", name: "STOCK", note: "THE FACTORY MUFFLER", stats: {} },
  { id: "catback", name: "CAT-BACK", note: "A FREE-FLOWING CAT-BACK SYSTEM", stats: { accel: 1, speed: 1, traction: -1, turbo: -1 } },
  { id: "straight", name: "STRAIGHT PIPE", note: "NO MUFFLER, NO MANNERS",
    stats: { speed: 2, accel: 1, traction: -2, handling: -1 } },
  { id: "titanium", name: "TITANIUM TIPS", note: "BURNT-BLUE TITANIUM TIPS", stats: { turbo: 3, weight: -1, speed: -1, accel: -1 } },
  { id: "quad", name: "QUAD TIPS", note: "FOUR TIPS, FULL SEND", stats: { speed: 2, weight: 1, accel: -2, turbo: -1 } },
  { id: "side", name: "SIDE EXIT", note: "PIPES OUT THE SIDE SKIRTS", stats: { handling: 1, accel: 1, speed: -1, traction: -1 } },
  { id: "center", name: "CENTER EXIT", note: "ONE BIG RACE-STYLE CENTER PIPE",
    stats: { turbo: 2, accel: 1, speed: -1, weight: -1, traction: -1 } },
  { id: "valved", name: "VALVED", note: "QUIET ON THE CRUISE, LOUD ON THE THROTTLE", stats: { turbo: 1, accel: 1, speed: -1, handling: -1 } },
  { id: "turboback", name: "TURBO-BACK", note: "BIG-BORE TURBO-BACK SYSTEM", stats: { speed: 3, accel: -2, turbo: -1 } },
  { id: "flame", name: "FLAMETHROWER", note: "ANTI-LAG POPS AND FLAMES ON EVERY BOOST", stats: { turbo: 4, traction: -2, weight: -1, handling: -1 } },
  { id: "delete", name: "MUFFLER DELETE", note: "LIGHTER, LOUDER, ANGRIER", stats: { accel: 2, weight: -2 } },
];

export const PAINTS: Paint[] = [
  { id: "sunset", name: "SUNSET ORANGE", color: "#ff7a1a" },
  { id: "rosso", name: "ROSSO CORSA", color: "#d4101a" },
  { id: "papaya", name: "PAPAYA", color: "#ff8f1f" },
  { id: "giallo", name: "GIALLO", color: "#ffcf1a" },
  { id: "lime", name: "VERDE LIME", color: "#8fe01e" },
  { id: "brg", name: "RACING GREEN", color: "#145c2c" },
  { id: "lemans", name: "LE MANS BLUE", color: "#1f4fd8" },
  { id: "sky", name: "SKY BLUE", color: "#45b8ff" },
  { id: "teal", name: "ELECTRIC TEAL", color: "#00c2b2" },
  { id: "purple", name: "MIDNIGHT", color: "#4b1f8a" },
  { id: "pink", name: "HOT PINK", color: "#ff3fa4" },
  { id: "candy", name: "CANDY APPLE", color: "#b5102b" },
  { id: "pearl", name: "PEARL WHITE", color: "#eeeee8" },
  { id: "nardo", name: "NARDO GREY", color: "#8a8d8f" },
  { id: "silver", name: "SATIN SILVER", color: "#c3c9d2" },
  { id: "black", name: "MATTE BLACK", color: "#24242c" },
  { id: "gold", name: "CHROME GOLD", color: "#d8aa3c" },
];

export const ACCENTS: Paint[] = [
  { id: "cream", name: "CREAM", color: "#ffd166" },
  { id: "white", name: "WHITE", color: "#f6f6f6" },
  { id: "black", name: "GLOSS BLACK", color: "#1b1b22" },
  { id: "carbon", name: "CARBON", color: "#34363e" },
  { id: "silver", name: "SILVER", color: "#c3c9d2" },
  { id: "gold", name: "GOLD", color: "#e8b93c" },
  { id: "cyan", name: "NEON CYAN", color: "#2de2e6" },
  { id: "magenta", name: "NEON PINK", color: "#ff2bd6" },
  { id: "lime", name: "NEON LIME", color: "#b6ff3b" },
  { id: "red", name: "RACE RED", color: "#e53935" },
];

export interface Build { body: string; wheels: string; spoiler: string; exhaust: string; paint: string; accent: string }

export const SLOTS = [
  { key: "body", label: "BODY", parts: BODIES },
  { key: "wheels", label: "WHEELS", parts: WHEELS },
  { key: "spoiler", label: "SPOILER", parts: SPOILERS },
  { key: "exhaust", label: "EXHAUST", parts: EXHAUSTS },
] as const;

export const DEFAULT_BUILD: Build = {
  body: "classic", wheels: "standard", spoiler: "none", exhaust: "stock", paint: "sunset", accent: "cream",
};

const find = <T extends { id: string }>(list: T[], id: string): T => list.find((p) => p.id === id) ?? list[0];
export const bodyOf = (b: Build) => find(BODIES, b.body);
export const wheelsOf = (b: Build) => find(WHEELS, b.wheels);
export const spoilerOf = (b: Build) => find(SPOILERS, b.spoiler);
export const exhaustOf = (b: Build) => find(EXHAUSTS, b.exhaust);
export const paintOf = (b: Build) => find(PAINTS, b.paint);
export const accentOf = (b: Build) => find(ACCENTS, b.accent);

/** A build from saved data, with anything unknown replaced by the default part. */
export function cleanBuild(raw: unknown): Build {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends { id: string }>(list: T[], v: unknown, d: string) =>
    typeof v === "string" && list.some((p) => p.id === v) ? v : d;
  return {
    body: pick(BODIES, r.body, DEFAULT_BUILD.body), wheels: pick(WHEELS, r.wheels, DEFAULT_BUILD.wheels),
    spoiler: pick(SPOILERS, r.spoiler, DEFAULT_BUILD.spoiler), exhaust: pick(EXHAUSTS, r.exhaust, DEFAULT_BUILD.exhaust),
    paint: pick(PAINTS, r.paint, DEFAULT_BUILD.paint), accent: pick(ACCENTS, r.accent, DEFAULT_BUILD.accent),
  };
}

/** The six stats of a build: 10 points each, plus what every part adds, kept within 0..20. */
export function statsOf(b: Build): Stats {
  const out = Object.fromEntries(STAT_KEYS.map((k) => [k, 10])) as Stats;
  for (const part of [bodyOf(b), wheelsOf(b), spoilerOf(b), exhaustOf(b)]) {
    for (const k of STAT_KEYS) out[k] += part.stats[k] ?? 0;
  }
  for (const k of STAT_KEYS) out[k] = Math.max(0, Math.min(STAT_MAX, out[k]));
  return out;
}

/** What the stats do on the road, as multipliers on the race class's numbers (1 = neutral):
 * top speed, acceleration, cornering, weight in a bump, speed kept off the road, and how long
 * (and how soon) a drift's mini-turbo fires. */
export interface Perf { vmax: number; accel: number; turn: number; mass: number; offroad: number; turbo: number }

export const NEUTRAL: Perf = { vmax: 1, accel: 1, turn: 1, mass: 1, offroad: 1, turbo: 1 };

export function perfOf(st: Stats): Perf {
  const u = (k: StatKey) => (st[k] - 10) / 10; // -1 .. 1
  return {
    vmax: 1 + 0.08 * u("speed"),
    accel: 1 + 0.25 * u("accel"),
    turn: 1 + 0.12 * u("handling"),
    mass: 1 + 0.4 * u("weight"),
    offroad: 1 + 0.45 * u("traction"),
    turbo: 1 + 0.35 * u("turbo"),
  };
}

/** How good a build is for racing: top speed and mini-turbo matter most (as players find out). */
export function buildScore(b: Build): number {
  const s = statsOf(b);
  return s.speed + 0.75 * s.turbo + 0.6 * s.accel + 0.5 * s.handling + 0.3 * s.traction + 0.25 * s.weight;
}

/** A rival's kart: random parts and paint, and the harder the class, the better the build
 * (rookies get the weakest of a batch of random builds, legends the strongest). */
export function rivalBuild(rng: Rand, difficulty: Difficulty): Build {
  const cands = Array.from({ length: 24 }, (): Build => ({
    body: rng.pick(BODIES).id, wheels: rng.pick(WHEELS).id, spoiler: rng.pick(SPOILERS).id,
    exhaust: rng.pick(EXHAUSTS).id, paint: rng.pick(PAINTS).id, accent: rng.pick(ACCENTS).id,
  }));
  cands.sort((a, b) => buildScore(a) - buildScore(b));
  const [lo, hi] = difficulty === "rookie" ? [0, 8] : difficulty === "pro" ? [8, 16] : [17, 24];
  return cands[rng.int(lo, hi)];
}
