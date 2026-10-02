// Canvas-drawn menus in the retro style: a framed panel, a blinking cursor, and option rows that
// cycle with left/right. Works with keyboard, gamepad, mouse and touch.

import type { PixelFont } from "../core/font";
import { hex, type Screen } from "../core/gfx";
import type { MenuEvent } from "../core/input";
import type { Sound } from "../core/audio";

export interface MenuItem {
  label: string;
  value?: () => string;
  left?: () => void;
  right?: () => void;
  action?: () => void;
  hint?: string;
}

const PANEL = hex("#0c0a1d");
const EDGE = hex("#c79bff");
const INK = hex("#0b0b14");
const TEXT = hex("#e9e6ff");
const DIM = hex("#8f87b8");
const HOT = hex("#ffd23f");

export class Menu {
  index = 0;
  private rects: [number, number, number, number][] = [];

  constructor(public title: string, public items: MenuItem[], public width = 260) {}

  handle(ev: MenuEvent, sound: Sound): "back" | null {
    const it = this.items[this.index];
    if (ev === "up" || ev === "down") {
      this.index = (this.index + (ev === "up" ? -1 : 1) + this.items.length) % this.items.length;
      sound.move();
    } else if (ev === "left" && it.left) {
      it.left();
      sound.move();
    } else if (ev === "right" && it.right) {
      it.right();
      sound.move();
    } else if (ev === "confirm") {
      sound.select();
      if (it.action) it.action();
      else if (it.right) it.right();
    } else if (ev === "back") {
      return "back";
    }
    return null;
  }

  click(x: number, y: number, sound: Sound): void {
    this.rects.forEach(([rx, ry, rw, rh], i) => {
      if (x < rx || x > rx + rw || y < ry || y > ry + rh) return;
      this.index = i;
      const it = this.items[i];
      sound.select();
      if (it.value && it.left && x < rx + rw * 0.5 && x > rx + rw * 0.3) it.left();
      else if (it.action) it.action();
      else if (it.right) it.right();
    });
  }

  draw(scr: Screen, f: PixelFont, cx: number, top: number, now: number): void {
    const rowH = 16;
    const head = this.title ? 30 : 12; // untitled panels (results) start straight at the items
    const h = head + this.items.length * rowH + 4;
    const x = Math.round(cx - this.width / 2);
    scr.dimRect(x, top, this.width, h, PANEL, 0.86);
    scr.fillRect(x, top, this.width, 1, EDGE);
    scr.fillRect(x, top + h - 1, this.width, 1, EDGE);
    scr.fillRect(x, top, 1, h, EDGE);
    scr.fillRect(x + this.width - 1, top, 1, h, EDGE);
    if (this.title) f.draw(scr, this.title, cx, top + 9, { color: HOT, outline: INK, align: "center" });
    this.rects = [];
    this.items.forEach((it, i) => {
      const y = top + head + i * rowH;
      const on = i === this.index;
      this.rects.push([x + 4, y - 4, this.width - 8, rowH]);
      if (on) {
        scr.dimRect(x + 4, y - 4, this.width - 8, rowH - 2, EDGE, 0.18);
        if (Math.floor(now * 3) % 2 === 0) f.draw(scr, ">", x + 10, y, { color: HOT });
      }
      f.draw(scr, it.label, x + 24, y, { color: on ? TEXT : DIM });
      if (it.value) {
        const v = it.value();
        const arrows = it.left || it.right;
        f.draw(scr, arrows ? `< ${v} >` : v, x + this.width - 12, y, { color: on ? HOT : DIM, align: "right" });
      }
    });
    const hint = this.items[this.index]?.hint;
    if (hint) f.draw(scr, hint, cx, top + h + 8, { color: DIM, align: "center", outline: INK });
  }
}
