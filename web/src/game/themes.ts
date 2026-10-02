// Visual themes: palettes and scenery mixes. All art in the game is original and procedural.

import { hex } from "./core/gfx";

export type SceneryKind =
  | "pine" | "oak" | "bush" | "rock" | "flowers" | "cactus" | "palm" | "crystal" | "neonpalm"
  | "mesa" | "lamp" | "tire" | "cone" | "chevron";

export interface Theme {
  id: string;
  name: string;
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
}

export const THEMES: Theme[] = [
  {
    id: "valley", name: "DREAM VALLEY",
    skyTop: hex("#3a6fd8"), skyHorizon: hex("#b9e4ff"), fog: hex("#cfeaff"), sun: 0, stars: false,
    farHills: hex("#7b8ccf"), nearHills: hex("#3f9a52"), clouds: hex("#ffffff"),
    ground: [hex("#4caf50"), hex("#43a047")], groundSpeck: hex("#66bb6a"),
    shoulder: hex("#c8b27a"), road: hex("#5b5f6b"), roadSpeck: hex("#666b77"),
    edge: hex("#f2f2f2"), kerb: [hex("#e53935"), hex("#f5f5f5")], barrier: hex("#2e3b2f"),
    grid: 0,
    near: ["bush", "oak", "pine", "flowers", "rock", "tire", "cone"],
    far: ["oak", "pine", "pine", "bush", "rock", "flowers"],
  },
  {
    id: "neon", name: "NEON NIGHT",
    skyTop: hex("#0b0420"), skyHorizon: hex("#6d1b7b"), fog: hex("#3b1650"), sun: hex("#ff6ad5"),
    stars: true, farHills: hex("#2a0f4a"), nearHills: hex("#16082e"), clouds: 0,
    ground: [hex("#140a26"), hex("#170c2c")], groundSpeck: hex("#24123f"),
    shoulder: hex("#2b1748"), road: hex("#22202e"), roadSpeck: hex("#2b2938"),
    edge: hex("#2de2e6"), kerb: [hex("#ff2bd6"), hex("#2de2e6")], barrier: hex("#ff2bd6"),
    grid: hex("#3d1f6b"),
    near: ["neonpalm", "crystal", "lamp", "cone", "crystal"],
    far: ["crystal", "neonpalm", "crystal", "lamp"],
  },
  {
    id: "mesa", name: "SUNSET MESA",
    skyTop: hex("#5a2a7a"), skyHorizon: hex("#ffb463"), fog: hex("#f6b27a"), sun: hex("#ffd36b"),
    stars: false, farHills: hex("#a4506a"), nearHills: hex("#c86a3c"), clouds: hex("#ffd1a1"),
    ground: [hex("#d9a35b"), hex("#d29b52")], groundSpeck: hex("#e4b46c"),
    shoulder: hex("#b5763c"), road: hex("#5e534c"), roadSpeck: hex("#6a5f57"),
    edge: hex("#fff3d6"), kerb: [hex("#ff7043"), hex("#fff3d6")], barrier: hex("#6b3b1f"),
    grid: 0,
    near: ["cactus", "rock", "palm", "tire", "cone", "rock"],
    far: ["mesa", "cactus", "rock", "cactus", "palm"],
  },
];
