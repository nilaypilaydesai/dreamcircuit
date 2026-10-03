// The garage: build your kart. A showroom with the kart turning slowly on a lit pedestal and its
// six stats on a card under it (a bar and a total out of 20 each), the part pickers (body,
// wheels, spoiler, exhaust, paint, accent) in a panel beside it, and a line about the part picked
// in a bar along the bottom. Spaced to the screen: side by side when it is wide enough, stacked
// on a phone held upright, with room between everything either way.

import type { PixelFont } from "../core/font";
import { H, W, hex, mix, type Screen } from "../core/gfx";
import {
  ACCENTS, type Build, PAINTS, SLOTS, STAT_KEYS, STAT_LABELS, STAT_MAX, type StatKey, type Stats, accentOf, paintOf,
  statsOf,
} from "../race/parts";
import { LIVERIES, Turntable, kartModel } from "../render/sprites";
import { Menu } from "./menus";

const INK = hex("#0b0b14");
const PANEL = hex("#0c0a1d");
const EDGE = hex("#c79bff");
const DIM = hex("#8f87b8");
const VALUE = hex("#cfc8f2");
const TEXT = hex("#f1eeff");
const HOT = hex("#ffd23f");
const BAR = hex("#c79bff");
const TRACK = hex("#1d1838");
const M = 8; // px kept clear around the edges of the screen
const GUTTER = 12; // px between the showroom and the parts panel
/** The stat names, short enough for a narrow card. */
const SHORT: Record<StatKey, string> = {
  speed: "SPEED", accel: "ACCEL", weight: "WEIGHT", handling: "HANDLE", traction: "GRIP", turbo: "TURBO",
};
const PAINT_HINT = "PAINT IS JUST FOR LOOKS";
const ACCENT_HINT = "STRIPES, WINGS AND TRIM";
const DONE_HINT = "RIVALS BUILD BETTER KARTS IN HARDER CLASSES";

export class Garage {
  readonly menu: Menu;
  private readonly table = new Turntable();
  private shown: Stats;
  private model: Map<number, number> | null = null;
  private modelKey = "";
  private fit: [number, number] = [-1, 1]; // [width, lines]: the most lines any hint wraps to

  constructor(private build: Build, private readonly onChange: (b: Build) => void, done: () => void) {
    this.shown = statsOf(build);
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
      { label: "PAINT", value: () => paintOf(this.build).name, hint: PAINT_HINT,
        left: () => this.set({ paint: cycle(PAINTS, this.build.paint, -1) }),
        right: () => this.set({ paint: cycle(PAINTS, this.build.paint, 1) }) },
      { label: "ACCENT", value: () => accentOf(this.build).name, hint: ACCENT_HINT,
        left: () => this.set({ accent: cycle(ACCENTS, this.build.accent, -1) }),
        right: () => this.set({ accent: cycle(ACCENTS, this.build.accent, 1) }) },
      { label: "DONE", action: done, hint: DONE_HINT },
    ], 184, true); // stacked: a click on the left of a row picks the previous part
  }

  get current(): Build {
    return this.build;
  }

  private set(change: Partial<Build>): void {
    this.build = { ...this.build, ...change };
    this.shown = statsOf(this.build);
    this.onChange(this.build);
  }

  draw(scr: Screen, f: PixelFont, now: number): void {
    backdrop(scr);
    // the bar along the bottom, as tall as the longest line about any part needs (so the layout
    // above it never jumps from one part to the next)
    const hintW = W - 2 * M - 8;
    const lines = this.hintLines(f, hintW);
    const barH = 6 + 10 * lines, barY = H - barH;
    if (W < 360 && H >= 260) this.upright(scr, f, now, barY);
    else this.wide(scr, f, now, barY);
    scr.dimRect(0, barY, W, barH, INK, 0.6);
    scr.dimRect(0, barY, W, 1, EDGE, 0.35);
    const raw = this.menu.items[this.menu.index]?.hint;
    const text = f.wrap(typeof raw === "function" ? raw() : raw ?? "", hintW).slice(0, lines);
    const y0 = barY + Math.round((barH - (10 * text.length - 2)) / 2);
    text.forEach((line, i) => f.draw(scr, line, W / 2, y0 + i * 10, { color: VALUE, outline: INK, align: "center" }));
  }

  /** Side by side: the showroom (title, kart, stats card) on the left, the parts on the right. */
  private wide(scr: Screen, f: PixelFont, now: number, barY: number): void {
    const pw = Math.max(150, Math.min(196, Math.round(W * 0.42)));
    const px = W - M - pw, lw = px - GUTTER - M;
    // the parts panel, its rows as roomy as the height allows (a part's name and what is fitted
    // sit 2 px apart, the parts 4-8 px apart), centred above the bar
    const room = barY - 12;
    const rowH = Math.max(22, Math.min(26, Math.floor((room - 18 - 35) / 5)));
    const ph = partsHeight(rowH, 18);
    const py = Math.max(6, Math.round(6 + (room - ph) / 2));
    this.parts(scr, f, px, py, pw, rowH, 2, now);
    // the stats card along the bottom of the showroom column, level with the panel; the title in
    // its top corner, level with the first part, leaves the middle to the kart
    const rowS = H >= 230 ? 13 : H >= 208 ? 12 : 11;
    const ch = 5 * rowS + 24, cy = py + ph - ch;
    this.stats(scr, f, M, cy, lw, rowS);
    this.showroom(scr, Math.round(M + lw / 2), 6, cy - 6, lw, now);
    f.draw(scr, "GARAGE", M + 8, py + 8, { color: HOT, outline: INK }); // over a long kart's tail
  }

  /** A phone held upright: the kart, the stats card, then the parts in one-line rows. */
  private upright(scr: Screen, f: PixelFont, now: number, barY: number): void {
    const w = W - 2 * M;
    const rowH = H >= 290 ? 14 : 13;
    const ph = partsHeight(rowH, 8);
    const py = barY - 6 - ph;
    this.parts(scr, f, M, py, w, rowH, 0, now);
    const rowS = 11, ch = 5 * rowS + 24, cy = py - 6 - ch;
    this.stats(scr, f, M, cy, w, rowS);
    this.showroom(scr, Math.round(W / 2), 6, cy - 6, w, now);
  }

  /** The kart turning slowly on its pedestal, as big as fits between ``top`` and ``bottom``. */
  private showroom(scr: Screen, cx: number, top: number, bottom: number, width: number, now: number): void {
    // the pedestal takes about 0.48 rx under its centre, and the kart up to 1.2 rx over it (the
    // tallest wing; most karts about 0.8 rx)
    const rx = Math.max(20, Math.min(width * 0.36, 70, (bottom - top - 4) / 1.6));
    const ry = Math.max(7, rx * 0.26), band = Math.max(5, Math.round(ry * 0.6));
    const cy = Math.round(bottom - band - 2 - 1.25 * ry);
    spotlight(scr, cx, cy, rx);
    pedestal(scr, cx, cy, rx, ry, now * 0.55);
    const key = JSON.stringify(this.build);
    if (key !== this.modelKey || !this.model) {
      this.model = kartModel(this.build, LIVERIES[0]);
      this.modelKey = key;
    }
    this.table.draw(scr, this.model, key, cx, cy + 2, now * 0.55 + Math.PI / 2, Math.min(4, (rx * 2) / 31));
  }

  /** The six stats on a card: name, a bar out of 20 with quarter ticks, and the total. */
  private stats(scr: Screen, f: PixelFont, x: number, y: number, w: number, rowS: number): void {
    card(scr, x, y, w, 5 * rowS + 24);
    const full = w - 16 - 80 - 8 - 6 - 16 >= 56; // room for the full names (MINI-TURBO is the longest)
    const barX = x + 8 + (full ? 80 : 48) + 8, numR = x + w - 8;
    const barW = numR - 16 - 6 - barX;
    const px = (s: number) => Math.round((barW * s) / STAT_MAX);
    STAT_KEYS.forEach((k, i) => {
      const yy = y + 8 + i * rowS, v = this.shown[k];
      f.draw(scr, full ? STAT_LABELS[k] : SHORT[k], x + 8, yy, { color: DIM });
      scr.fillRect(barX, yy, barW, 7, TRACK);
      scr.fillRect(barX, yy + 1, px(v), 5, BAR);
      scr.fillRect(barX, yy + 1, px(v), 1, mix(BAR, 0xffffffff, 0.45)); // a lit top edge
      for (let t = 1; t < 4; t++) scr.fillRect(barX + px(t * 5), yy + 1, 1, 5, INK); // quarter ticks
      f.draw(scr, String(v), numR, yy, { color: TEXT, align: "right" });
    });
  }

  /** The parts panel: a row per part (its name and what is fitted, the fitted part under the
   * name when ``lg`` > 0, else on the same line), a rule, and DONE. Fills in the menu's hit areas. */
  private parts(scr: Screen, f: PixelFont, x: number, y: number, w: number, rowH: number, lg: number,
                now: number): void {
    const two = lg > 0, textH = two ? 16 + lg : 8;
    const ph = partsHeight(rowH, textH), pad = Math.max(2, Math.min(4, Math.floor((rowH - textH) / 2)));
    card(scr, x, y, w, ph);
    const menu = this.menu, nudge = Math.floor(now * 2.5) % 2; // the arrows beckon
    menu.rects = [];
    const parts = menu.items.length - 1;
    for (let i = 0; i < parts; i++) {
      const it = menu.items[i], on = i === menu.index;
      const ty = y + 8 + i * rowH;
      menu.rects.push([x + 3, ty - Math.floor((rowH - textH) / 2), w - 6, rowH]);
      if (on) scr.dimRect(x + 3, ty - pad, w - 6, textH + 2 * pad, EDGE, 0.16);
      f.draw(scr, it.label, x + 16, ty, { color: on ? TEXT : DIM });
      const v = it.value?.() ?? "";
      const vy = two ? ty + 8 + lg : ty;
      const vx = two ? x + 16 : x + w - 16 - f.width(v);
      f.draw(scr, v, vx, vy, { color: on ? HOT : VALUE });
      if (on) {
        arrow(scr, (two ? x + 7 : vx - 10) - nudge, vy, -1, HOT);
        arrow(scr, x + w - 11 + nudge, vy, 1, HOT);
      }
    }
    // a rule, then DONE, centred
    const dy = y + 8 + (parts - 1) * rowH + textH + 5;
    scr.dimRect(x + 10, dy, w - 20, 1, EDGE, 0.3);
    const done = parts, on = menu.index === done, ty = dy + 6;
    menu.rects.push([x + 3, ty - 5, w - 6, 18]);
    if (on) scr.dimRect(x + 3, ty - 4, w - 6, 16, EDGE, 0.16);
    f.draw(scr, menu.items[done].label, x + w / 2, ty, { color: on ? HOT : VALUE, align: "center" });
  }

  /** The most lines any hint wraps to at ``width`` px (at most two). */
  private hintLines(f: PixelFont, width: number): number {
    if (this.fit[0] !== width) {
      const all = [...SLOTS.flatMap((s) => s.parts.map((p) => p.note)), PAINT_HINT, ACCENT_HINT, DONE_HINT];
      this.fit = [width, Math.min(2, Math.max(...all.map((h) => f.wrap(h, width).length)))];
    }
    return this.fit[1];
  }
}

/** Height of a parts panel with rows ``rowH`` apart whose text is ``textH`` tall. */
function partsHeight(rowH: number, textH: number): number {
  return 8 + 5 * rowH + textH + 5 + 6 + 8 + 8;
}

/** A panel: dark glass with a lit edge. */
function card(scr: Screen, x: number, y: number, w: number, h: number): void {
  scr.dimRect(x, y, w, h, PANEL, 0.86);
  scr.fillRect(x, y, w, 1, EDGE);
  scr.fillRect(x, y + h - 1, w, 1, EDGE);
  scr.fillRect(x, y, 1, h, EDGE);
  scr.fillRect(x + w - 1, y, 1, h, EDGE);
}

/** A small solid arrowhead, 4 x 7 px, at (x, y), pointing left (-1) or right (1). */
function arrow(scr: Screen, x: number, y: number, dir: -1 | 1, c: number): void {
  for (let k = 0; k < 4; k++) scr.fillRect(dir < 0 ? x + k : x + 3 - k, y + 3 - k, 1, 2 * k + 1, c);
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
