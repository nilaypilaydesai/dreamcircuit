// The garage: build your kart. A showroom with the kart turning slowly on a lit pedestal, the
// part pickers (body, wheels, spoiler, exhaust, paint, accent) and the six stat bars, which show
// what the last change gained (green) or cost (red) for a moment.

import type { PixelFont } from "../core/font";
import { H, W, hex, mix, type Screen } from "../core/gfx";
import {
  ACCENTS, type Build, PAINTS, SLOTS, STAT_KEYS, STAT_LABELS, STAT_MAX, type Stats, accentOf, paintOf, statsOf,
} from "../race/parts";
import { LIVERIES, Turntable, kartModel } from "../render/sprites";
import { Menu } from "./menus";

const INK = hex("#0b0b14");
const DIM = hex("#8f87b8");
const GAIN = hex("#5dff7a");
const LOSS = hex("#ff4d4d");
const BAR = hex("#c79bff");

export class Garage {
  readonly menu: Menu;
  private readonly table = new Turntable();
  private shown: Stats;
  private before: Stats;
  private changedAt = -9;
  private now = 0;
  private model: Map<number, number> | null = null;
  private modelKey = "";

  constructor(private build: Build, private readonly onChange: (b: Build) => void, done: () => void) {
    this.shown = this.before = statsOf(build);
    const cycle = <T extends { id: string }>(list: readonly T[], id: string, d: number) =>
      list[(list.findIndex((p) => p.id === id) + d + list.length) % list.length].id;
    const part = (slot: (typeof SLOTS)[number]) => ({
      label: slot.label,
      value: () => slot.parts.find((p) => p.id === this.build[slot.key])?.name ?? "",
      left: () => this.set({ [slot.key]: cycle(slot.parts, this.build[slot.key], -1) } as Partial<Build>),
      right: () => this.set({ [slot.key]: cycle(slot.parts, this.build[slot.key], 1) } as Partial<Build>),
      hint: () => slot.parts.find((p) => p.id === this.build[slot.key])?.note ?? "",
    });
    this.menu = new Menu("GARAGE", [
      ...SLOTS.map(part),
      { label: "PAINT", value: () => paintOf(this.build).name, hint: "PAINT IS JUST FOR LOOKS",
        left: () => this.set({ paint: cycle(PAINTS, this.build.paint, -1) }),
        right: () => this.set({ paint: cycle(PAINTS, this.build.paint, 1) }) },
      { label: "ACCENT", value: () => accentOf(this.build).name, hint: "STRIPES, WINGS AND TRIM",
        left: () => this.set({ accent: cycle(ACCENTS, this.build.accent, -1) }),
        right: () => this.set({ accent: cycle(ACCENTS, this.build.accent, 1) }) },
      { label: "DONE", action: done, hint: "RIVALS BUILD THEIR OWN: BETTER KARTS IN HARDER CLASSES" },
    ], 184, true);
  }

  get current(): Build {
    return this.build;
  }

  private set(change: Partial<Build>): void {
    this.before = this.shown;
    this.build = { ...this.build, ...change };
    this.shown = statsOf(this.build);
    this.changedAt = this.now;
    this.onChange(this.build);
  }

  draw(scr: Screen, f: PixelFont, now: number): void {
    this.now = now;
    backdrop(scr);
    // side by side on a landscape screen (the showroom on the left, two-line rows on the right);
    // on a phone held upright, the showroom on top and one-line rows under it
    const wide = W >= 360;
    this.menu.stacked = wide;
    this.menu.width = wide ? 184 : W - 12;
    const panel = this.menu.width;
    const left = wide ? W - panel - 10 : W; // width of the showroom
    const cx = Math.round(left / 2) + (wide ? 3 : 0);
    const stage = wide ? Math.round(H * 0.4) : 54;
    // the pedestal and the kart on it, turning slowly
    const rx = wide ? Math.min(left * 0.4, 78) : 46, ry = Math.max(7, rx * 0.26);
    spotlight(scr, cx, stage, rx);
    pedestal(scr, cx, stage, rx, ry, now * 0.55);
    const scale = Math.min(3.4, (rx * 2) / 31);
    const key = JSON.stringify(this.build);
    if (key !== this.modelKey || !this.model) {
      this.model = kartModel(this.build, LIVERIES[0]);
      this.modelKey = key;
    }
    this.table.draw(scr, this.model, key, cx, stage + 2, now * 0.55 + Math.PI / 2, scale);
    // the stats under it
    const sx = wide ? Math.max(6, cx - 92) : Math.round(W / 2 - 92);
    const sy = stage + Math.round(ry) + (wide ? 14 : 10);
    const gap = wide ? 9 : 8;
    const barX = sx + 84, barW = 96;
    const fresh = now - this.changedAt < 1.6;
    STAT_KEYS.forEach((k, i) => {
      const y = sy + i * gap;
      f.draw(scr, STAT_LABELS[k], sx, y, { color: DIM, outline: INK });
      scr.fillRect(barX - 1, y, barW + 2, 7, INK);
      const v = this.shown[k], was = this.before[k];
      const px = (s: number) => Math.round((barW * s) / STAT_MAX);
      scr.fillRect(barX, y + 1, px(v), 5, BAR);
      if (fresh && v > was) scr.fillRect(barX + px(was), y + 1, px(v) - px(was), 5, GAIN);
      if (fresh && v < was) scr.fillRect(barX + px(v), y + 1, px(was) - px(v), 5, LOSS);
      for (let t = 1; t < 4; t++) scr.fillRect(barX + px(t * 5), y + 1, 1, 5, INK); // quarter ticks
    });
    // the parts, and a line about the one picked
    this.menu.hintWidth = panel - 8;
    this.menu.hintLines = H >= 214 ? 3 : 2;
    const below = 7 + this.menu.hintLines * 10;
    const top = wide ? Math.max(4, Math.round((H - this.menu.height() - below) / 2)) : sy + 6 * gap + 4;
    this.menu.draw(scr, f, wide ? W - panel / 2 - 5 : W / 2, top, now);
    if (wide) f.draw(scr, "BUILD YOUR KART", cx, 6, { color: DIM, outline: INK, align: "center" });
  }
}

/** A soft cone of light from above onto the pedestal. */
function spotlight(scr: Screen, cx: number, stage: number, rx: number): void {
  for (let y = 0; y < stage; y++) {
    const half = 8 + (rx * 1.15 - 8) * (y / stage);
    scr.dimRect(cx - half, y, half * 2, 1, hex("#e9dcff"), 0.05 + 0.05 * (y / stage));
  }
}

/** The showroom: a dark room with a lit floor grid. */
function backdrop(scr: Screen): void {
  const floor = Math.round(H * 0.42);
  for (let y = 0; y < H; y++) {
    const c = y < floor ? mix(hex("#0b0420"), hex("#2a1450"), y / floor) : mix(hex("#1a0d38"), hex("#0b0420"), (y - floor) / (H - floor));
    scr.fillRect(0, y, W, 1, c);
  }
  // perspective floor lines
  for (let k = -12; k <= 12; k++) {
    for (let y = floor; y < H; y += 1) {
      const x = W / 2 + k * 18 * (0.25 + (y - floor) / (H - floor));
      if (x >= 0 && x < W) scr.dimRect(x, y, 1, 1, hex("#5b3fa0"), 0.35);
    }
  }
  for (let y = floor, g = 3; y < H; y += g, g += 2) scr.dimRect(0, y, W, 1, hex("#5b3fa0"), 0.3);
}

/** A round pedestal that turns: a top face, a lit side band, and rim lights going round. */
function pedestal(scr: Screen, cx: number, cy: number, rx: number, ry: number, rot: number): void {
  const band = Math.max(5, Math.round(ry * 0.6));
  // glow on the floor
  ellipse(scr, cx, cy + band + 2, rx * 1.25, ry * 1.25, (x) => mix(hex("#2a1450"), hex("#7b3cff"), 0.25 + 0.1 * Math.cos(x)), 0.5);
  ellipse(scr, cx, cy + band, rx, ry, () => hex("#2a2350"));
  scr.fillRect(cx - rx, cy, rx * 2, band, hex("#3d3370"));
  for (let x = Math.floor(cx - rx); x < cx + rx; x++) { // light along the side band, brightest at the front
    const t = (x - cx) / rx;
    scr.dimRect(x, cy + 1, 1, band - 2, hex("#c79bff"), 0.35 * (1 - t * t));
  }
  ellipse(scr, cx, cy, rx, ry, (x, y) => {
    const a = Math.atan2((y - cy) / ry, (x - cx) / rx) - rot;
    return mix(hex("#5a4c9c"), hex("#8270c8"), 0.5 + 0.5 * Math.cos(a * 4)); // the turning top
  });
  for (let k = 0; k < 18; k++) {
    const a = rot + (k / 18) * Math.PI * 2;
    const x = cx + Math.cos(a) * rx * 0.93, y = cy + Math.sin(a) * ry * 0.93;
    const front = Math.sin(a) > 0;
    scr.fillRect(Math.round(x), Math.round(y), front ? 2 : 1, 1, k % 2 ? hex("#2de2e6") : hex("#ff2bd6"));
  }
}

function ellipse(scr: Screen, cx: number, cy: number, rx: number, ry: number,
                 color: (x: number, y: number) => number, alpha = 1): void {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    if (y < 0 || y >= H) continue;
    const half = rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / ry) ** 2));
    for (let x = Math.ceil(cx - half); x <= cx + half; x++) {
      if (x < 0 || x >= W) continue;
      if (alpha >= 1) scr.buf[y * W + x] = color(x, y);
      else scr.buf[y * W + x] = mix(scr.buf[y * W + x], color(x, y), alpha);
    }
  }
}
