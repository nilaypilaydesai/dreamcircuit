// Canvas-drawn menus in the retro style: a framed panel, a blinking cursor, and option rows that
// cycle with left/right. Works with keyboard, gamepad, mouse and touch. The panel shrinks to fit
// narrow screens and long hints wrap onto a second line instead of running off the edges.

import type { PixelFont } from "../core/font";
import { H, W, hex, type Screen } from "../core/gfx";
import type { MenuEvent } from "../core/input";
import type { Sound } from "../core/audio";

export interface MenuItem {
  label: string;
  value?: () => string;
  left?: () => void;
  right?: () => void;
  action?: () => void;
  hint?: string | (() => string);
  preview?: () => ArrayLike<number> | null; // a circuit's road points (x0, y0, ...): drawn beside the hint
  fixed?: () => boolean; // its value is set by another row for now: shown dim, without arrows, and left/right do nothing
}

const PANEL = hex("#0c0a1d");
const EDGE = hex("#c79bff");
const INK = hex("#0b0b14");
const TEXT = hex("#e9e6ff");
const DIM = hex("#8f87b8");
const HOT = hex("#ffd23f");

export class Menu {
  index = 0;
  /** Where each row was drawn (x, y, w, h), for clicks and taps. A screen that draws its rows
   * itself (the garage) fills these in. */
  rects: [number, number, number, number][] = [];

  /** How wide (pixels) and how many lines the hint under the panel may take (default: the
   * screen's width, two lines). */
  hintWidth = 0;
  hintLines = 2;

  /** ``stacked``: each row puts its value on a second line under the label (narrow panels). */
  constructor(public title: string, public items: MenuItem[], public width = 260, public stacked = false) {}

  /** Rows are a little tighter on short screens (a phone on its side), and in long menus, so the
   * panel and a two-line hint always fit under the logo. */
  get rowH(): number {
    if (this.stacked) return H < 214 ? 18 : 20;
    if (this.items.length >= 8) return H < 214 ? 13 : H < 240 ? 14 : 16;
    return H < 214 ? 14 : 16;
  }

  /** Height of the panel itself (the hint goes below it). */
  height(): number {
    return (this.title ? 30 : 12) + this.items.length * this.rowH + 4;
  }

  handle(ev: MenuEvent, sound: Sound): "back" | null {
    const it = this.items[this.index];
    const fixed = it.fixed?.() ?? false;
    if (ev === "up" || ev === "down") {
      this.index = (this.index + (ev === "up" ? -1 : 1) + this.items.length) % this.items.length;
      sound.move();
    } else if (ev === "left" && it.left && !fixed) {
      it.left();
      sound.move();
    } else if (ev === "right" && it.right && !fixed) {
      it.right();
      sound.move();
    } else if (ev === "confirm") {
      sound.select();
      if (it.action) it.action();
      else if (it.right && !fixed) it.right();
    } else if (ev === "back" || ev === "cancel") {
      return "back";
    }
    return null;
  }

  click(x: number, y: number, sound: Sound): void {
    // the first row hit (rows touch: a click on the line between two must not act on both)
    const i = this.rects.findIndex(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y < ry + rh);
    if (i < 0) return;
    const [rx, , rw] = this.rects[i];
    this.index = i;
    const it = this.items[i];
    sound.select();
    if (it.fixed?.()) return;
    const onLeft = this.stacked ? x < rx + rw * 0.4 : x < rx + rw * 0.5 && x > rx + rw * 0.3;
    if (it.value && it.left && onLeft) it.left();
    else if (it.action) it.action();
    else if (it.right) it.right();
  }

  /** ``note``: a status line shown where the hint goes, instead of it (e.g. a loading message). */
  draw(scr: Screen, f: PixelFont, cx: number, top: number, now: number, note?: { text: string; color: number }): void {
    const rowH = this.rowH;
    const width = Math.min(this.width, W - 12);
    const head = this.title ? 30 : 12; // untitled panels (results) start straight at the items
    const h = this.height();
    const x = Math.round(cx - width / 2);
    scr.dimRect(x, top, width, h, PANEL, 0.86);
    scr.fillRect(x, top, width, 1, EDGE);
    scr.fillRect(x, top + h - 1, width, 1, EDGE);
    scr.fillRect(x, top, 1, h, EDGE);
    scr.fillRect(x + width - 1, top, 1, h, EDGE);
    if (this.title) f.draw(scr, this.title, cx, top + 9, { color: HOT, outline: INK, align: "center" });
    this.rects = [];
    this.items.forEach((it, i) => {
      const y = top + head + i * rowH;
      const on = i === this.index;
      this.rects.push([x + 4, y - 4, width - 8, rowH]);
      if (on) {
        scr.dimRect(x + 4, y - 4, width - 8, rowH - 2, EDGE, 0.18);
        if (Math.floor(now * 3) % 2 === 0) f.draw(scr, ">", x + 10, y + (this.stacked ? 4 : 0), { color: HOT });
      }
      f.draw(scr, it.label, x + 24, y, { color: on ? TEXT : DIM });
      if (it.value) {
        const v = it.value();
        const fixed = it.fixed?.() ?? false;
        const arrows = (it.left || it.right) && !fixed;
        const color = on && !fixed ? HOT : DIM;
        if (this.stacked) f.draw(scr, arrows && on ? `< ${v} >` : v, x + 24, y + 9, { color });
        else f.draw(scr, arrows ? `< ${v} >` : v, x + width - 12, y, { color, align: "right" });
      }
    });
    const raw = this.items[this.index]?.hint;
    const hint = note?.text ?? (typeof raw === "function" ? raw() : raw);
    const pts = note ? null : this.items[this.index]?.preview?.() ?? null;
    if (pts && pts.length >= 6) {
      // the circuit's shape in a small box, and the hint beside it
      const bw = 44, bh = 26, bx = Math.round(cx - Math.min(width, W - 24) / 2), by = top + h + 3;
      scr.dimRect(bx, by, bw, bh, PANEL, 0.8);
      outline(scr, pts, bx + 3, by + 3, bw - 6, bh - 6);
      if (hint) {
        f.wrap(hint, Math.min(width, W - 24) - bw - 8).slice(0, this.hintLines).forEach((line, i) => {
          f.draw(scr, line, bx + bw + 6, by + 4 + i * 10, { color: DIM, outline: INK });
        });
      }
    } else if (hint) {
      f.wrap(hint, this.hintWidth || W - 24).slice(0, this.hintLines).forEach((line, i) => {
        f.draw(scr, line, cx, top + h + 7 + i * 10, { color: note?.color ?? DIM, align: "center", outline: INK });
      });
    }
  }
}

/** A circuit's road points drawn as a closed line, fitted into the box at (x, y), w by h, with its
 * start line marked. */
function outline(scr: Screen, pts: ArrayLike<number>, x: number, y: number, w: number, h: number): void {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  const k = Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0));
  const ox = x + (w - (x1 - x0) * k) / 2, oy = y + (h - (y1 - y0) * k) / 2;
  const at = (i: number): [number, number] => [ox + (pts[i] - x0) * k, oy + (y1 - pts[i + 1]) * k];
  const n = pts.length / 2;
  for (let j = 0; j < n; j++) {
    const [ax, ay] = at(2 * j), [bx, by] = at(2 * ((j + 1) % n));
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let s = 0; s < steps; s++) scr.fillRect(Math.round(ax + ((bx - ax) * s) / steps), Math.round(ay + ((by - ay) * s) / steps), 1, 1, HOT);
  }
  const [sx, sy] = at(0);
  scr.fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 3, 3, TEXT);
}
