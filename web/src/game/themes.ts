// Visual themes: palettes and scenery mixes. All art in the game is original and procedural.

import { hex } from "./core/gfx";
import {
  type HillRule, MESA_HILLS, MOON_HILLS, MOUNTAIN_HILLS, NEON_HILLS, REEF_HILLS, SITE_HILLS, VALLEY_HILLS, VOLCANO_HILLS,
} from "./race/tracktypes";
import type { HazardKind } from "./world/hazards";
import type { LandformKind } from "./world/landforms";
import type { HillStyle } from "./world/track";

export type SceneryKind =
  | "pine" | "oak" | "bush" | "rock" | "flowers" | "cactus" | "palm" | "crystal" | "neonpalm"
  | "mesa" | "lamp" | "tire" | "cone" | "chevron"
  | "kelp" | "coral" | "anemone" | "shell" | "wreck" // the reef
  | "snowpine" | "cliff" | "peak" | "snowbank" // the mountains
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
  grid: number; // 0 = none (neon grid lines on the ground)
  near: SceneryKind[]; // decorations beside the road
  far: SceneryKind[]; // landscape across the infield and beyond
  underwater?: boolean; // bubble helmets, rising bubbles, light shafts, caustics, fish
  mountain?: boolean; // climbs over hills, tunnels, a more winding road
  snow?: number; // snow on the far mountain tops (0 = none)
  farAmp?: number; // how tall the far hills on the horizon are (default 26 px)
  volcano?: boolean; // a lake of lava around a rock road (drive into it and a drone fishes you
  // out), crater walls with lava falls all around, embers in the air
  wall?: number; // the low walls along a climb (default: grey stone)
  gravity?: number; // how strong gravity is, relative to the usual (the moon's is weak)
  hills?: HillRule; // climbs set along the road as it is dreamed (any track type)
  hillStyle?: HillStyle; // what climbs are built as when the rule does not say (default: earth)
  tunnels?: "rock" | "frame"; // tunnels on long straights: through rock, or a building's steel frame
  helmets?: boolean; // every driver wears a clear helmet (the reef has its own, under water)
  terrain?: "craters" | "dirt"; // the ground: cratered regolith, or a building site's churned dirt
  skyline?: "city" | "moon"; // the far hills are a city of towers and cranes, or the moon's ridges with the Earth up above
  relief?: number; // m: how much the ground rises and falls (shaded into it, lit from the north-west)
  ripples?: boolean; // sand: ripples the wind has drawn across it
  landforms?: LandformKind[]; // the land around the circuit: knolls, buttes, dunes, peaks (3D, off the road)
  hazard?: HazardKind; // what a kart can drive into off the road (the rescue drone fishes it out)
}

export const THEMES: Theme[] = [
  {
    id: "valley", name: "DREAM VALLEY", blurb: "OVER ROLLING MEADOWS, PAST WOODS AND KNOLLS",
    skyTop: hex("#3a6fd8"), skyHorizon: hex("#b9e4ff"), fog: hex("#cfeaff"), sun: 0, stars: false,
    farHills: hex("#7b8ccf"), nearHills: hex("#3f9a52"), clouds: hex("#ffffff"),
    ground: [hex("#4caf50"), hex("#43a047")], groundSpeck: hex("#66bb6a"),
    shoulder: hex("#c8b27a"), road: hex("#5b5f6b"), roadSpeck: hex("#666b77"),
    edge: hex("#f2f2f2"), kerb: [hex("#e53935"), hex("#f5f5f5")], barrier: hex("#2e3b2f"),
    grid: 0,
    near: ["bush", "oak", "pine", "flowers", "rock", "tire", "cone"],
    far: ["oak", "pine", "pine", "bush", "rock", "flowers"],
    hills: VALLEY_HILLS, hillStyle: "meadow", relief: 7, landforms: ["knoll"], hazard: "pond",
  },
  {
    id: "neon", name: "NEON NIGHT", blurb: "A NEON SKYWAY OVER A SYNTHWAVE GRID OF CRYSTALS",
    skyTop: hex("#0b0420"), skyHorizon: hex("#6d1b7b"), fog: hex("#3b1650"), sun: hex("#ff6ad5"),
    stars: true, farHills: hex("#2a0f4a"), nearHills: hex("#16082e"), clouds: 0,
    ground: [hex("#140a26"), hex("#170c2c")], groundSpeck: hex("#24123f"),
    shoulder: hex("#2b1748"), road: hex("#22202e"), roadSpeck: hex("#2b2938"),
    edge: hex("#2de2e6"), kerb: [hex("#ff2bd6"), hex("#2de2e6")], barrier: hex("#ff2bd6"),
    grid: hex("#3d1f6b"),
    near: ["neonpalm", "crystal", "lamp", "cone", "crystal"],
    far: ["crystal", "neonpalm", "crystal", "lamp"],
    hills: NEON_HILLS, hillStyle: "skyway", relief: 3, landforms: ["gridpeak"], hazard: "void",
  },
  {
    id: "mesa", name: "SUNSET MESA", blurb: "UP ONTO THE MESAS AND OVER THE DUNES AT DUSK",
    skyTop: hex("#5a2a7a"), skyHorizon: hex("#ffb463"), fog: hex("#f6b27a"), sun: hex("#ffd36b"),
    stars: false, farHills: hex("#a4506a"), nearHills: hex("#c86a3c"), clouds: hex("#ffd1a1"),
    ground: [hex("#d9a35b"), hex("#d29b52")], groundSpeck: hex("#e4b46c"),
    shoulder: hex("#b5763c"), road: hex("#5e534c"), roadSpeck: hex("#6a5f57"),
    edge: hex("#fff3d6"), kerb: [hex("#ff7043"), hex("#fff3d6")], barrier: hex("#6b3b1f"),
    grid: 0,
    near: ["cactus", "rock", "palm", "tire", "cone", "rock"],
    far: ["mesa", "cactus", "rock", "cactus", "palm"],
    hills: MESA_HILLS, hillStyle: "mesa", relief: 4, ripples: true, landforms: ["butte", "dune", "dune"], hazard: "quicksand",
  },
  {
    id: "reef", name: "CORAL REEF", blurb: "OVER CORAL RIDGES UNDER THE SEA, IN BUBBLE HELMETS",
    skyTop: hex("#03203b"), skyHorizon: hex("#1f8fb0"), fog: hex("#1a6f8c"), sun: 0, stars: false,
    farHills: hex("#0f4a66"), nearHills: hex("#155868"), clouds: 0,
    ground: [hex("#d8c497"), hex("#cfba8c")], groundSpeck: hex("#f4e9cf"),
    shoulder: hex("#b8a37a"), road: hex("#3f5566"), roadSpeck: hex("#4b6476"),
    edge: hex("#7ff6ff"), kerb: [hex("#ff7f6e"), hex("#fff1e0")], barrier: hex("#1f4a5c"),
    grid: 0,
    near: ["kelp", "coral", "anemone", "rock", "shell", "kelp", "coral"],
    far: ["kelp", "coral", "kelp", "rock", "wreck", "coral", "anemone"],
    underwater: true, hills: REEF_HILLS, hillStyle: "coral", relief: 3, ripples: true, landforms: ["reefrock"], hazard: "trench",
  },
  {
    id: "mountain", name: "MOUNTAIN PASS", blurb: "UP THE MOUNTAINSIDE, ALONG CLIFF LEDGES, THROUGH THE ROCK",
    skyTop: hex("#2f6fd6"), skyHorizon: hex("#cfe6ff"), fog: hex("#dbe9f7"), sun: hex("#fff3c4"), stars: false,
    farHills: hex("#6b7ba0"), nearHills: hex("#3d6a4d"), clouds: hex("#ffffff"),
    ground: [hex("#6f8f5a"), hex("#678653")], groundSpeck: hex("#f4f7fb"),
    shoulder: hex("#8f8a7c"), road: hex("#4f525c"), roadSpeck: hex("#5c606b"),
    edge: hex("#f4f4f4"), kerb: [hex("#d62828"), hex("#f4f4f4")], barrier: hex("#3a3d46"),
    grid: 0,
    near: ["snowpine", "rock", "snowpine", "snowbank", "cliff", "snowpine", "cone"],
    far: ["snowpine", "snowpine", "peak", "rock", "cliff", "snowpine", "snowbank"],
    mountain: true, snow: hex("#f6f9ff"), farAmp: 46, hills: MOUNTAIN_HILLS, hillStyle: "rock", tunnels: "rock",
    relief: 8, landforms: ["crag"], hazard: "crevasse",
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
    grid: 0,
    near: ["magmarock", "basalt", "obsidian", "vent", "magmarock", "basalt"],
    far: ["spire", "basalt", "vent", "obsidian", "spire", "magmarock", "basalt"],
    volcano: true, farAmp: 58, wall: hex("#4a3a3e"), hills: VOLCANO_HILLS, hillStyle: "basalt", landforms: ["cone"],
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
    grid: 0,
    near: ["barrier", "drum", "cone", "pipes", "barrier", "drum", "girders"],
    far: ["crane", "skeleton", "mixer", "digger", "pipes", "girders", "skeleton", "crane"],
    hills: SITE_HILLS, hillStyle: "scaffold", tunnels: "frame", terrain: "dirt", skyline: "city",
    wall: hex("#ff8a1f"), relief: 2.5, landforms: ["spoil"], hazard: "pit",
  },
  {
    // the moon: low gravity (a fast kart floats over every crater's rim), the Earth up in a
    // black sky, a helmet on every driver
    id: "moon", name: "MOON BASE",
    blurb: "LOW GRAVITY: FLOAT OVER THE CRATERS, THE EARTH OVERHEAD",
    skyTop: hex("#000000"), skyHorizon: hex("#0b0d18"), fog: hex("#1a1c26"), sun: 0, stars: true,
    farHills: hex("#5a5c66"), nearHills: hex("#3c3e47"), clouds: 0,
    ground: [hex("#8d8e93"), hex("#86878c")], groundSpeck: hex("#b3b4b8"),
    shoulder: hex("#6d6e74"), road: hex("#2e3038"), roadSpeck: hex("#3b3d46"),
    edge: hex("#7fe7ff"), kerb: [hex("#e8ecf2"), hex("#3a5bd8")], barrier: hex("#9aa0aa"),
    grid: 0,
    near: ["boulder", "boulder", "dish", "habitat", "boulder", "lander"],
    far: ["boulder", "lander", "dish", "habitat", "rover", "boulder", "boulder"],
    gravity: 0.3, hills: MOON_HILLS, hillStyle: "crater", helmets: true, terrain: "craters", skyline: "moon",
    wall: hex("#9aa0aa"), relief: 3, landforms: ["rim"], hazard: "chasm",
  },
];
