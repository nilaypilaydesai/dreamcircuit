// Visual themes: palettes and scenery mixes. All art in the game is original and procedural.

import { hex } from "./core/gfx";
import {
  type HillRule, MESA_HILLS, MOON_HILLS, REEF_HILLS, SITE_HILLS, TOKYO_HILLS, TUBE_HILLS, VALLEY_HILLS, VOLCANO_HILLS,
} from "./race/tracktypes";
import type { ObstacleKind } from "./race/obstacles";
import type { HazardKind } from "./world/hazards";
import type { LandformKind } from "./world/landforms";
import type { HillStyle } from "./world/track";

export type SceneryKind =
  | "pine" | "oak" | "bush" | "rock" | "flowers" | "cactus" | "palm"
  | "mesa" | "tire" | "cone" | "chevron"
  | "kelp" | "coral" | "anemone" | "shell" | "wreck" // the reef
  | "streetlamp" | "vending" | "lantern" | "neonsign" | "pole" | "sakura" // Tokyo's streets
  | "tower" | "apartment" | "billboard" | "pagoda" // and its skyline
  | "basalt" | "obsidian" | "vent" | "spire" | "magmarock" // the volcano
  | "crane" | "skeleton" | "mixer" | "digger" | "pipes" | "girders" | "barrier" | "drum" // the construction zone
  | "lander" | "dish" | "habitat" | "boulder" | "rover"; // the moon

export interface Theme {
  id: string;
  name: string;
  blurb: string; // one line for the WORLD menu
  skyTop: number;
  skyHorizon: number;
  fog: number;
  sun: number; // 0 = none
  stars: boolean;
  farHills: number;
  nearHills: number;
  clouds: number; // 0 = none
  ground: [number, number]; // mowing stripes / dune bands
  groundSpeck: number;
  shoulder: number;
  road: number;
  roadSpeck: number;
  edge: number;
  kerb: [number, number];
  barrier: number;
  near: SceneryKind[]; // decorations beside the road
  far: SceneryKind[]; // landscape across the infield and beyond
  underwater?: boolean; // bubble helmets, rising bubbles, light shafts, caustics, fish
  winding?: boolean; // a more winding road (the dream leans wild): Tokyo's streets, for drifting
  smooth?: boolean; // a smoother road (the dream leans calm): the tube's bends wide enough to drive round inside
  tube?: boolean; // the whole race is run inside a tube (world/tube.ts), up its walls and round over its ceiling
  farAmp?: number; // how tall the far hills on the horizon are (default 26 px)
  volcano?: boolean; // a lake of lava around a rock road (drive into it and a drone fishes you
  // out), crater walls with lava falls all around, embers in the air
  wall?: number; // the low walls along a climb (default: grey stone)
  gravity?: number; // how strong gravity is, relative to the usual (the moon's is weak)
  scale?: number; // how much bigger than usual its circuits are drawn (the moon's: a jump carries a kart far)
  hills?: HillRule; // climbs set along the road as it is dreamed (any track type)
  hillStyle?: HillStyle; // what climbs are built as when the rule does not say (default: earth)
  tunnels?: "city" | "frame"; // tunnels on long straights: under a building, or through a building's steel frame
  helmets?: boolean; // every driver wears a clear helmet (the reef has its own, under water)
  terrain?: "craters" | "dirt" | "city"; // the ground: cratered regolith, a building site's churned dirt, or wet paving at night
  skyline?: "city" | "moon" | "tokyo"; // the far hills are a city of towers and cranes, the moon's ridges with the
  // Earth up above, or Tokyo at night (lit towers, a lattice tower, Fuji far off under the moon)
  relief?: number; // m: how much the ground rises and falls (shaded into it, lit from the north-west)
  ripples?: boolean; // sand: ripples the wind has drawn across it
  landforms?: LandformKind[]; // the land around the circuit: knolls, buttes, dunes, peaks (3D, off the road)
  hazard?: HazardKind; // what a kart can drive into off the road (the rescue drone fishes it out)
  obstacle?: ObstacleKind; // what gets in the way on the road (race/obstacles.ts): cows, police...
}

export const THEMES: Theme[] = [
  {
    id: "valley", name: "DREAM VALLEY", blurb: "OVER ROLLING MEADOWS, PAST WOODS AND KNOLLS",
    skyTop: hex("#3a6fd8"), skyHorizon: hex("#b9e4ff"), fog: hex("#cfeaff"), sun: 0, stars: false,
    farHills: hex("#7b8ccf"), nearHills: hex("#3f9a52"), clouds: hex("#ffffff"),
    ground: [hex("#4caf50"), hex("#43a047")], groundSpeck: hex("#66bb6a"),
    shoulder: hex("#c8b27a"), road: hex("#5b5f6b"), roadSpeck: hex("#666b77"),
    edge: hex("#f2f2f2"), kerb: [hex("#e53935"), hex("#f5f5f5")], barrier: hex("#2e3b2f"),
    near: ["bush", "oak", "pine", "flowers", "rock", "tire", "cone"],
    far: ["oak", "pine", "pine", "bush", "rock", "flowers"],
    hills: VALLEY_HILLS, hillStyle: "meadow", relief: 7, landforms: ["knoll"], hazard: "pond", obstacle: "cow",
  },
  {
    // the neon tunnel: the whole race inside a tube of light (world/tube.ts). Ride up its walls,
    // and fast enough right round over its ceiling; boost pads on the walls and the ceiling;
    // traffic on the floor to weave through or ride the walls past. Its circuits are drawn bigger,
    // and dreamed calmer, so the bends are wide enough to drive round the inside of
    id: "neon", name: "NEON TUNNEL", blurb: "A TUBE OF LIGHT: RIDE THE WALLS, LOOP THE CEILING, PASS THE TRAFFIC",
    skyTop: hex("#0b0420"), skyHorizon: hex("#6d1b7b"), fog: hex("#2a0838"), sun: 0, stars: false,
    farHills: hex("#2a0f4a"), nearHills: hex("#16082e"), clouds: 0,
    ground: [hex("#1c0f3a"), hex("#25144b")], groundSpeck: hex("#24123f"),
    shoulder: hex("#2b1748"), road: hex("#15121f"), roadSpeck: hex("#2b2938"),
    edge: hex("#2de2e6"), kerb: [hex("#ff2bd6"), hex("#2de2e6")], barrier: hex("#ff2bd6"),
    near: [], far: [],
    tube: true, smooth: true, scale: 1.6, hills: TUBE_HILLS, hillStyle: "earth", obstacle: "traffic",
  },
  {
    id: "mesa", name: "SUNSET MESA", blurb: "UP ONTO THE MESAS AND OVER THE DUNES AT DUSK",
    skyTop: hex("#5a2a7a"), skyHorizon: hex("#ffb463"), fog: hex("#f6b27a"), sun: hex("#ffd36b"),
    stars: false, farHills: hex("#a4506a"), nearHills: hex("#c86a3c"), clouds: hex("#ffd1a1"),
    ground: [hex("#d9a35b"), hex("#d29b52")], groundSpeck: hex("#e4b46c"),
    shoulder: hex("#b5763c"), road: hex("#5e534c"), roadSpeck: hex("#6a5f57"),
    edge: hex("#fff3d6"), kerb: [hex("#ff7043"), hex("#fff3d6")], barrier: hex("#6b3b1f"),
    near: ["cactus", "rock", "palm", "tire", "cone", "rock"],
    far: ["mesa", "cactus", "rock", "cactus", "palm"],
    hills: MESA_HILLS, hillStyle: "mesa", relief: 4, ripples: true, landforms: ["butte", "dune", "dune"], hazard: "quicksand", obstacle: "tumbleweed",
  },
  {
    id: "reef", name: "CORAL REEF", blurb: "OVER CORAL RIDGES UNDER THE SEA, IN BUBBLE HELMETS",
    skyTop: hex("#03203b"), skyHorizon: hex("#1f8fb0"), fog: hex("#1a6f8c"), sun: 0, stars: false,
    farHills: hex("#0f4a66"), nearHills: hex("#155868"), clouds: 0,
    ground: [hex("#d8c497"), hex("#cfba8c")], groundSpeck: hex("#f4e9cf"),
    shoulder: hex("#b8a37a"), road: hex("#3f5566"), roadSpeck: hex("#4b6476"),
    edge: hex("#7ff6ff"), kerb: [hex("#ff7f6e"), hex("#fff1e0")], barrier: hex("#1f4a5c"),
    near: ["kelp", "coral", "anemone", "rock", "shell", "kelp", "coral"],
    far: ["kelp", "coral", "kelp", "rock", "wreck", "coral", "anemone"],
    underwater: true, hills: REEF_HILLS, hillStyle: "coral", relief: 3, ripples: true, landforms: ["reefrock"], hazard: "trench", obstacle: "jelly",
  },
  {
    // Tokyo at night, for drifting: winding streets between lit towers, vending machines and paper
    // lanterns, up onto the elevated expressway and up the ramp of a parking garage, through
    // tunnels under buildings, the paving wet and full of neon; Fuji far off under the moon
    id: "tokyo", name: "TOKYO NIGHTS", blurb: "DRIFT THE NEON STREETS, UP THE EXPRESSWAY AND THE PARKING GARAGE",
    skyTop: hex("#05071a"), skyHorizon: hex("#4a2352"), fog: hex("#241a3c"), sun: 0, stars: false,
    farHills: hex("#171b2e"), nearHills: hex("#0f1221"), clouds: 0,
    ground: [hex("#25282f"), hex("#22252c")], groundSpeck: hex("#3a3e4a"),
    shoulder: hex("#3e424c"), road: hex("#1d1f26"), roadSpeck: hex("#272a33"),
    edge: hex("#f2f2f2"), kerb: [hex("#e23b3b"), hex("#f2f2f2")], barrier: hex("#c9ced6"),
    near: ["streetlamp", "vending", "lantern", "neonsign", "pole", "sakura", "streetlamp", "vending"],
    far: ["tower", "apartment", "tower", "billboard", "sakura", "pagoda", "tower", "apartment"],
    winding: true, farAmp: 34, hills: TOKYO_HILLS, hillStyle: "expressway", tunnels: "city", terrain: "city",
    skyline: "tokyo", wall: hex("#b8bcc4"), landforms: ["block"], hazard: "canal", obstacle: "police",
  },
  {
    // inside a volcano: the road is a causeway of rock across a lake of lava ("ground" is the
    // rock of its banks; the lava is painted by world/texture.ts)
    id: "volcano", name: "VOLCANO CORE", blurb: "BASALT CAUSEWAYS OVER THE LAVA. FALL IN AND A DRONE FISHES YOU OUT",
    skyTop: hex("#0c0304"), skyHorizon: hex("#5e1b0f"), fog: hex("#4a170e"), sun: 0, stars: false,
    farHills: hex("#2a1210"), nearHills: hex("#170909"), clouds: hex("#2c1412"),
    ground: [hex("#2e2427"), hex("#2a2124")], groundSpeck: hex("#4a3a3c"),
    shoulder: hex("#3a3034"), road: hex("#2d2a33"), roadSpeck: hex("#3c3843"),
    edge: hex("#ff8a2a"), kerb: [hex("#e0301a"), hex("#1d1518")], barrier: hex("#3a1a14"),
    near: ["magmarock", "basalt", "obsidian", "vent", "magmarock", "basalt"],
    far: ["spire", "basalt", "vent", "obsidian", "spire", "magmarock", "basalt"],
    volcano: true, farAmp: 58, wall: hex("#4a3a3e"), hills: VOLCANO_HILLS, hillStyle: "basalt", landforms: ["cone"], obstacle: "geyser",
  },
  {
    // a building site: the road climbs onto concrete foundations, along scaffolding and high
    // along a girder past a tower crane, and runs through the steel frames of buildings going up
    id: "construction", name: "CONSTRUCTION ZONE",
    blurb: "DRIVE ON THE BUILDINGS: FOUNDATIONS, SCAFFOLDS, A CRANE'S STEEL ARM",
    skyTop: hex("#4f86d6"), skyHorizon: hex("#e6d8b8"), fog: hex("#e2d4b4"), sun: hex("#fff2c0"), stars: false,
    farHills: hex("#7f8796"), nearHills: hex("#5f6672"), clouds: hex("#fbf5e8"),
    ground: [hex("#a8835a"), hex("#9e7a52")], groundSpeck: hex("#c09a6a"),
    shoulder: hex("#8a8478"), road: hex("#4c4e55"), roadSpeck: hex("#5a5c63"),
    edge: hex("#ffd23f"), kerb: [hex("#ffb000"), hex("#1f2026")], barrier: hex("#ff8a1f"),
    near: ["barrier", "drum", "cone", "pipes", "barrier", "drum", "girders"],
    far: ["crane", "skeleton", "mixer", "digger", "pipes", "girders", "skeleton", "crane"],
    hills: SITE_HILLS, hillStyle: "scaffold", tunnels: "frame", terrain: "dirt", skyline: "city",
    wall: hex("#ff8a1f"), relief: 2.5, landforms: ["spoil"], hazard: "pit", obstacle: "wrecker",
  },
  {
    // the moon: low gravity (a fast kart floats over every crater's rim, and a jump carries it
    // three times as far, so its circuits are drawn 1.6 times the size), the Earth up in a black
    // sky, a helmet on every driver
    id: "moon", name: "MOON BASE",
    blurb: "LOW GRAVITY: FLOAT OVER THE CRATERS, THE EARTH OVERHEAD",
    skyTop: hex("#000000"), skyHorizon: hex("#0b0d18"), fog: hex("#1a1c26"), sun: 0, stars: true,
    farHills: hex("#5a5c66"), nearHills: hex("#3c3e47"), clouds: 0,
    ground: [hex("#8d8e93"), hex("#86878c")], groundSpeck: hex("#b3b4b8"),
    shoulder: hex("#6d6e74"), road: hex("#2e3038"), roadSpeck: hex("#3b3d46"),
    edge: hex("#7fe7ff"), kerb: [hex("#e8ecf2"), hex("#3a5bd8")], barrier: hex("#9aa0aa"),
    near: ["boulder", "boulder", "dish", "habitat", "boulder", "lander"],
    far: ["boulder", "lander", "dish", "habitat", "rover", "boulder", "boulder"],
    gravity: 0.3, scale: 1.6, hills: MOON_HILLS, hillStyle: "crater", helmets: true, terrain: "craters", skyline: "moon",
    wall: hex("#9aa0aa"), relief: 3, landforms: ["rim"], hazard: "chasm", obstacle: "meteor",
  },
];
