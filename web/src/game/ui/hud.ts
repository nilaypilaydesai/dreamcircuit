// The race HUD, drawn straight into the framebuffer: lap and time, position, speed, drift
// charge, standings, a minimap that shows the circuit being dreamed (and its bridges), what the
// designer is dreaming for you, small pop-ups (tricks, rocket starts) and the big banners.

import { TUBE_LOOP_SPEED, TUBE_WALL_SPEED } from "../world/tube";
import type { PixelFont } from "../core/font";
import { H, W, hex, mix, type Screen, type Sprite } from "../core/gfx";
import type { Kart } from "../race/kart";
import { LAPS, type Race } from "../race/race";
import {
  AIMED, FLARES_TIME, GOLD_TIME, GRAB_TIME, ITEM_KINDS, ITEM_NAMES, type ItemKind, PHANTOM_TIME, PRISM_TIME, ROCKET_TIME,
  TRAILS,
} from "../race/items";
import { paintOf } from "../race/parts";
import { coinFrames, itemIcons } from "../render/sprites";
import { N } from "../world/track";

const WHITE = 0xffffffff;
const INK = hex("#0b0b14");
const GOLD = hex("#ffd23f");
const SILVER = hex("#d9e1ea");
const BRONZE = hex("#e8955a");
const DREAM = hex("#c79bff");
const RED = hex("#ff4d4d");
const GREEN = hex("#5dff7a");
// warnings (the police on the player's tail, too slow for the tube's wall) go up in the sky, under
// where the rear-view mirror hangs: at the foot of the screen they were printed over the kart
const WARN_Y = 50;

export function formatTime(t: number): string {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t * 100) % 100);
  return `${m}'${String(s).padStart(2, "0")}"${String(c).padStart(2, "0")}`;
}

const ordinal = (n: number) => (n === 1 ? "ST" : n === 2 ? "ND" : n === 3 ? "RD" : "TH");

/** What the designer is dreaming, from the style it was asked for. */
export function styleWord(style: number | null): string {
  if (style === null) return "THE CIRCUIT";
  return style < 0.3 ? "CALM ROAD" : style < 0.55 ? "FLOWING ROAD" : style < 0.78 ? "TECHNICAL ROAD" : "WILD ROAD";
}

interface Popup {
  text: string;
  color: number;
  at: number; // race clock
}

export interface Banner {
  text: string;
  sub?: string;
  color: number;
  until: number; // race clock
  blink?: boolean;
}

/** A kart's colour swatch: its paint. */
export const kartColor = (k: Kart): number => hex(paintOf(k.build).color);

export class Hud {
  banners: Banner[] = [];
  popups: Popup[] = [];
  /** The player drives by touch: the item slot says ITEM instead of E. */
  touch = false;
  private mapBox: [number, number, number, number] | null = null;
  private mapFor: unknown = null; // the track the box was fitted to
  private readonly icons: Record<ItemKind, Sprite> = itemIcons();
  private readonly coin: Sprite = coinFrames(0.85)[0].sprite;

  constructor(private readonly font: PixelFont) {}

  /** A short message rising over the player's kart (tricks, rocket starts, boost pads). */
  popup(text: string, clock: number, color = GOLD): void {
    this.popups = this.popups.filter((q) => clock - q.at < 0.9);
    this.popups.push({ text, color, at: clock });
  }

  banner(text: string, clock: number, color = WHITE, seconds = 1.6, sub?: string, blink = false): void {
    this.banners = this.banners.filter((b) => b.until > clock);
    this.banners.push({ text, sub, color, until: clock + seconds, blink });
  }

  draw(scr: Screen, race: Race, now: number): void {
    const f = this.font;
    const p = race.player;
    const o = { outline: INK };

    // top left: lap + race time
    f.draw(scr, "LAP", 10, 10, { ...o, color: SILVER });
    f.draw(scr, `${race.lapForHud}/${LAPS}`, 38, 6, { ...o, scale: 2, color: WHITE });
    f.draw(scr, formatTime(race.clock), 10, 26, { ...o, color: WHITE });
    if (p.lapTimes.length) f.draw(scr, `BEST ${formatTime(Math.min(...p.lapTimes))}`, 10, 37, { ...o, color: SILVER });

    // top right: position
    const pc = p.place === 1 ? GOLD : p.place === 2 ? SILVER : p.place === 3 ? BRONZE : WHITE;
    const ptxt = String(p.place || 1);
    f.draw(scr, ptxt, W - 46, 6, { scale: 4, color: pc, outline: INK, align: "right" });
    f.draw(scr, ordinal(p.place || 1), W - 44, 8, { ...o, scale: 1, color: pc });
    f.draw(scr, `/${race.karts.length}`, W - 44, 26, { ...o, color: SILVER });

    // left: standings (on a phone that corner holds the minimap instead, clear of the thumbs)
    if (race.karts.length > 1 && !this.touch) {
      race.standings.forEach((k, i) => {
        const y = 54 + i * 10;
        const isMe = k.isPlayer;
        scr.fillRect(10, y + 1, 6, 6, kartColor(k));
        f.draw(scr, `${i + 1} ${k.name}`, 20, y, { color: isMe ? GOLD : SILVER, outline: INK });
      });
    }

    // bottom left: speedometer and drift charge
    const kmh = Math.round(Math.abs(p.v) * 3.6);
    f.draw(scr, String(kmh).padStart(3, " "), 10, H - 30, { scale: 2, color: WHITE, outline: INK });
    f.draw(scr, "KM/H", 62, H - 22, { color: SILVER, outline: INK });
    // coins: each one a little top speed (ten at most)
    scr.blit(this.coin, 10, H - 46);
    f.draw(scr, `x${p.coins}`, 24, H - 44, { color: p.coins >= 10 ? GOLD : SILVER, outline: INK });
    const frac = Math.min(1, Math.abs(p.v) / (race.cls.vmax * 1.28));
    scr.fillRect(10, H - 12, 92, 5, INK);
    scr.fillRect(11, H - 11, Math.round(90 * frac), 3, p.boostTime > 0 ? hex("#63c8ff") : mix(GREEN, RED, frac));
    if (p.drifting) {
      const c = p.boostLevel === 2 ? hex("#ffb347") : p.boostLevel === 1 ? hex("#63c8ff") : SILVER;
      f.draw(scr, p.boostLevel ? "BOOST READY" : "DRIFT", 108, H - 12, { color: c, outline: INK });
    }
    // in the neon tunnel's tube: how fast is fast enough, to hold onto a wall and to loop right
    // round over the ceiling (ticks on the speed bar, words that light up), and a warning when the
    // kart is sliding back down
    if (race.setup.theme.tube) {
      const v = Math.abs(p.v), top = race.cls.vmax * 1.28;
      for (const need of [TUBE_WALL_SPEED, TUBE_LOOP_SPEED]) scr.fillRect(11 + Math.round((90 * need) / top), H - 14, 1, 7, WHITE);
      f.draw(scr, "WALL", 104, H - 22, { color: v >= TUBE_WALL_SPEED ? hex("#2de2e6") : hex("#5a5470"), outline: INK });
      const loop = v >= TUBE_LOOP_SPEED;
      f.draw(scr, "LOOP", 144, H - 22, {
        color: loop ? (Math.floor(now * 6) % 2 ? hex("#ff2bd6") : WHITE) : hex("#5a5470"), outline: INK,
      });
      if (p.slipping && Math.floor(now * 5) % 2 === 0) {
        f.draw(scr, "TOO SLOW!", W / 2, WARN_Y, { color: hex("#ff6b6b"), outline: INK, align: "center" });
      }
    }

    this.minimap(scr, race, now);
    this.dreamStatus(scr, race, now);
    const mid = Math.round(H * 0.39); // the band the big messages use
    for (const q of this.popups) {
      const age = race.clock - q.at;
      if (age < 0 || age > 0.9) continue;
      if (age > 0.6 && Math.floor(now * 12) % 2) continue;
      f.draw(scr, q.text, W / 2, mid + 34 - age * 26, { scale: 2, color: q.color, outline: INK, align: "center" });
    }
    this.itemSlot(scr, p, now);
    // a police car after the player: red and blue flashing at the top of the screen
    if (race.obstacles.chasing) {
      const red = Math.floor(now * 4) % 2 === 0;
      f.draw(scr, "POLICE", W / 2, WARN_Y, { color: red ? hex("#ff2a2a") : hex("#4a8cff"), outline: INK, align: "center" });
    }
    if (p.rocket > 0) this.meter(scr, "ROCKET", p.rocket / ROCKET_TIME, hex("#ff8a1f"));
    else if (p.prism > 0) this.meter(scr, "PRISM", p.prism / PRISM_TIME, hex("#c79bff"));
    else if (p.phantom > 0) this.meter(scr, "PHANTOM", p.phantom / PHANTOM_TIME, hex("#c9b8ff"));
    else if (p.gold > 0) this.meter(scr, "GOLD", p.gold / GOLD_TIME, GOLD);
    else if (p.flares > 0) this.meter(scr, "FLARES", p.flares / FLARES_TIME, hex("#ff8a1f"));
    else if (p.grab > 0) this.meter(scr, "GRABBER", p.grab / GRAB_TIME, hex("#ffcf3a"));
    // a comet on its way to the player (the leader): its icon flashes at the top of the screen
    if (race.items.comets.some((c) => c.target === p) && Math.floor(now * 6) % 2 === 0) {
      const icon = this.icons.comet;
      scr.blit(icon, Math.round(W / 2 - icon.w / 2), 30);
    }

    // banners: only the newest (two at once would print over each other), as big as fits
    this.banners = this.banners.filter((b) => b.until > race.clock || race.phase === "countdown");
    const b = this.banners[this.banners.length - 1];
    if (b && !(b.blink && Math.floor(now * 4) % 2)) {
      const scale = Math.max(1, Math.min(3, Math.floor((W - 12) / f.width(b.text))));
      const th = 8 * scale;
      // a ribbon behind the big text: it spans the screen, so it lies over the standings
      scr.dimRect(0, mid - 5, W, th + 9 + (b.sub ? 13 : 0), INK, 0.62);
      f.draw(scr, b.text, W / 2, mid, { scale, color: b.color, outline: INK, align: "center" });
      if (b.sub) f.draw(scr, b.sub, W / 2, mid + th + 4, { color: WHITE, outline: INK, align: "center" });
    }
    if (p.wrongWay > 45 && Math.floor(now * 3) % 2 === 0) {
      f.draw(scr, "WRONG WAY!", W / 2, mid + 36, { scale: 2, color: RED, outline: INK, align: "center" });
    }
    if (race.phase === "countdown") this.countdown(scr, race);
  }

  /** A draining bar under the item slot while a prism or a rocket lasts. */
  private meter(scr: Screen, label: string, frac: number, color: number): void {
    const x = W - 46, y = 96;
    this.font.draw(scr, label, x + 18, y, { color, outline: INK, align: "center" });
    scr.fillRect(x - 1, y + 10, 38, 5, INK);
    scr.fillRect(x, y + 11, Math.round(36 * Math.max(0, Math.min(1, frac))), 3, color);
  }

  /** The item slot: icons cycle while the roulette spins, then the item waits for the button,
   * with its name for a moment and how many shots are left. */
  private itemSlot(scr: Screen, p: Kart, now: number): void {
    const x = W - 46, y = 44, size = 36;
    const ready = !!p.item && p.roulette <= 0;
    scr.fillRect(x - 1, y - 1, size + 2, size + 2, INK);
    scr.fillRect(x, y, size, size, ready ? (p.trailing ? hex("#63c8ff") : GOLD) : DREAM);
    scr.dimRect(x + 2, y + 2, size - 4, size - 4, INK, 0.82);
    const kind = p.roulette > 0 ? ITEM_KINDS[Math.floor(now * 14) % ITEM_KINDS.length] : p.item;
    if (kind) { // (drawn pixel for pixel: the icons are made the slot's size)
      const icon = this.icons[kind];
      scr.blit(icon, x + Math.floor((size - icon.w) / 2), y + Math.floor((size - icon.h) / 2));
    }
    const count = p.jackpot.length || p.uses;
    if (ready && count > 1) this.font.draw(scr, `x${count}`, x + size - 2, y + size - 9, { color: WHITE, outline: INK, align: "right" });
    if (ready && p.item) {
      // aimed items take two presses (aim, then throw), in front (E) or behind (R); oil and orbs
      // can be held out behind
      const key = this.touch ? "ITEM" : "E";
      const aimed = p.aimLocked === null ? (this.touch ? "AIM" : "E/R AIM")
        : this.touch ? "THROW" : Math.cos(p.aimLocked) < 0 ? "R THROW" : "E THROW";
      const label = p.itemAge < 1.6 ? ITEM_NAMES[p.item]
        : AIMED.has(p.item) ? aimed
          : p.trailing ? "LET GO" : TRAILS.has(p.item) ? `HOLD ${key}` : key;
      this.font.draw(scr, label, Math.min(x + size / 2 + this.font.width(label) / 2, W - 4), y + size + 3,
                     { color: p.itemAge < 1.6 ? GOLD : SILVER, outline: INK, align: "right" });
    }
  }

  private countdown(scr: Screen, race: Race): void {
    const n = Math.ceil(race.countdown - 1);
    const lights = 3;
    const x0 = W / 2 - 34, y0 = 40;
    scr.fillRect(x0 - 4, y0 - 4, 76, 26, INK);
    for (let i = 0; i < lights; i++) {
      const lit = n <= 0 ? GREEN : i <= lights - n ? RED : hex("#3b1b1b");
      fillCircle(scr, x0 + 10 + i * 24, y0 + 9, 8, lit);
    }
    const label = n > 0 ? String(n) : "GO!";
    this.font.draw(scr, label, W / 2, 76, { scale: 5, color: n > 0 ? WHITE : GREEN, outline: INK, align: "center" });
    // the track type, and what it is sure to have, on a soft band
    const t = race.type;
    const promise = t.id === "classic" ? t.promise : `CONFIRMED: ${t.promise}`;
    const lines = this.font.wrap(promise, W - 40).slice(0, 2);
    scr.dimRect(0, 120, W, 16 + lines.length * 10, INK, 0.5);
    this.font.draw(scr, t.name, W / 2, 124, { color: GOLD, outline: INK, align: "center" });
    lines.forEach((line, i) => this.font.draw(scr, line, W / 2, 135 + i * 10, { color: WHITE, outline: INK, align: "center" }));
  }

  private dreamStatus(scr: Screen, race: Race, now: number): void {
    const f = this.font;
    if (!race.track.locked && race.live) {
      const frac = race.dreamProgress;
      const x = W / 2 - 70, y = 8;
      f.draw(scr, race.live.busy ? `DREAMING ${styleWord(race.live.style)}` : "CIRCUIT FORMING", W / 2, y, {
        color: Math.floor(now * 3) % 2 && race.live.busy ? hex("#ffffff") : DREAM, outline: INK, align: "center",
      });
      scr.fillRect(x, y + 11, 140, 6, INK);
      scr.fillRect(x + 1, y + 12, Math.round(138 * frac), 4, DREAM);
      if (race.live.busy) scr.fillRect(x + 1 + Math.round(138 * frac), y + 12, Math.round(8 * race.live.denoise), 4, WHITE);
    } else if (race.lockedAt >= 0 && race.clock - race.lockedAt < 3.5 && race.live) {
      if (Math.floor(now * 5) % 2 === 0) {
        f.draw(scr, "CIRCUIT LOCKED", W / 2, 8, { color: GOLD, outline: INK, align: "center", scale: 1 });
      }
    }
  }

  private minimap(scr: Screen, race: Race, now: number): void {
    const t = race.track;
    if (this.mapFor !== t) {
      this.mapFor = t; // a new race: never draw it in the last circuit's frame
      this.mapBox = null;
    }
    // bottom right; on a phone, top left under the timer (the DRIFT and ITEM buttons sit bottom right)
    const size = this.touch ? 60 : 74;
    const x0 = this.touch ? 10 : W - size - 8, y0 = this.touch ? 48 : H - size - 8;
    // fit the designer's whole-circuit guess (or the locked circuit) into the box
    const pts = race.live?.preview ?? (t.locked ? t.points : null);
    if (pts) {
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let j = 0; j < N; j++) {
        const x = pts[2 * j], y = pts[2 * j + 1];
        minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      }
      if (!this.mapBox || !t.locked) this.mapBox = [minx, miny, maxx, maxy];
    }
    if (!this.mapBox) return;
    const [minx, miny, maxx, maxy] = this.mapBox;
    const span = Math.max(maxx - minx, maxy - miny, 1) * 1.08;
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const map = (x: number, y: number): [number, number] => [
      Math.round(x0 + size / 2 + ((x - cx) / span) * size),
      Math.round(y0 + size / 2 - ((y - cy) / span) * size),
    ];
    scr.dimRect(x0 - 3, y0 - 3, size + 6, size + 6, INK, 0.55);
    // the dream: the designer's current guess for road that does not exist yet
    if (race.live && !t.locked && race.live.preview) {
      const pv = race.live.preview;
      for (let j = 0; j < N; j++) {
        if (t.known[j]) continue;
        const ax = pv[2 * j], ay = pv[2 * j + 1];
        const bx = pv[2 * ((j + 1) % N)], by = pv[2 * ((j + 1) % N) + 1];
        for (let s = 0; s < 4; s++) {
          if ((j * 4 + s + Math.floor(now * 8)) % 3) continue;
          const [px, py] = map(ax + ((bx - ax) * s) / 4, ay + ((by - ay) * s) / 4);
          scr.fillRect(px, py, 1, 1, DREAM);
        }
      }
    }
    // committed road, then bridges drawn over the road they cross (with a dark edge)
    for (let i = 0; i < t.count; i += 3) {
      if (t.bridgeAt(i) > 2) continue;
      const [px, py] = map(t.xs[i], t.ys[i]);
      scr.fillRect(px - 1, py - 1, 2, 2, SILVER);
    }
    for (let i = 0; i < t.count; i += 2) {
      if (t.bridgeAt(i) <= 2) continue;
      const [px, py] = map(t.xs[i], t.ys[i]);
      scr.fillRect(px - 2, py - 2, 4, 4, INK);
    }
    for (let i = 0; i < t.count; i += 2) {
      if (t.bridgeAt(i) <= 2) continue;
      const [px, py] = map(t.xs[i], t.ys[i]);
      scr.fillRect(px - 1, py - 1, 2, 2, GOLD);
    }
    if (t.startIndex >= 0) {
      const [sx, sy] = map(t.xs[t.startIndex], t.ys[t.startIndex]);
      scr.fillRect(sx - 2, sy - 2, 4, 4, WHITE);
    }
    const dot = (k: Kart, r: number, c: number) => {
      const [px, py] = map(k.x, k.y);
      scr.fillRect(px - r, py - r, 2 * r + 1, 2 * r + 1, c);
    };
    for (const k of race.karts) if (!k.isPlayer) dot(k, 1, kartColor(k));
    dot(race.player, 2, INK);
    dot(race.player, 1, Math.floor(now * 4) % 2 ? WHITE : kartColor(race.player));
  }
}

function fillCircle(scr: Screen, cx: number, cy: number, r: number, c: number): void {
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y));
    scr.fillRect(cx - w, cy + y, 2 * w + 1, 1, c);
  }
}
