// The race HUD, drawn straight into the framebuffer: lap and time, position, speed, drift
// charge, standings, a minimap that shows the circuit being dreamed, and the big banners.

import type { PixelFont } from "../core/font";
import { H, W, hex, mix, type Screen, type Sprite } from "../core/gfx";
import type { Kart } from "../race/kart";
import { LAPS, type Race } from "../race/race";
import { ITEM_KINDS, type ItemKind } from "../race/items";
import { LIVERIES, itemIcons } from "../render/sprites";
import { N, polarPoint } from "../world/track";

const WHITE = 0xffffffff;
const INK = hex("#0b0b14");
const GOLD = hex("#ffd23f");
const SILVER = hex("#d9e1ea");
const BRONZE = hex("#e8955a");
const DREAM = hex("#c79bff");
const RED = hex("#ff4d4d");
const GREEN = hex("#5dff7a");

export function formatTime(t: number): string {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t * 100) % 100);
  return `${m}'${String(s).padStart(2, "0")}"${String(c).padStart(2, "0")}`;
}

const ordinal = (n: number) => (n === 1 ? "ST" : n === 2 ? "ND" : n === 3 ? "RD" : "TH");

export interface Banner {
  text: string;
  sub?: string;
  color: number;
  until: number; // race clock
  blink?: boolean;
}

export class Hud {
  banners: Banner[] = [];
  private mapBox: [number, number, number, number] | null = null;
  private readonly icons: Record<ItemKind, Sprite> = itemIcons();

  constructor(private readonly font: PixelFont) {}

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

    // left: standings
    if (race.karts.length > 1) {
      race.standings.forEach((k, i) => {
        const y = 54 + i * 10;
        const isMe = k.isPlayer;
        scr.fillRect(10, y + 1, 6, 6, LIVERIES[k.livery].body);
        f.draw(scr, `${i + 1} ${k.name}`, 20, y, { color: isMe ? GOLD : SILVER, outline: INK });
      });
    }

    // bottom left: speedometer and drift charge
    const kmh = Math.round(Math.abs(p.v) * 3.6);
    f.draw(scr, String(kmh).padStart(3, " "), 10, H - 30, { scale: 2, color: WHITE, outline: INK });
    f.draw(scr, "KM/H", 62, H - 22, { color: SILVER, outline: INK });
    const frac = Math.min(1, Math.abs(p.v) / (race.cls.vmax * 1.28));
    scr.fillRect(10, H - 12, 92, 5, INK);
    scr.fillRect(11, H - 11, Math.round(90 * frac), 3, p.boostTime > 0 ? hex("#63c8ff") : mix(GREEN, RED, frac));
    if (p.drifting) {
      const c = p.boostLevel === 2 ? hex("#ffb347") : p.boostLevel === 1 ? hex("#63c8ff") : SILVER;
      f.draw(scr, p.boostLevel ? "BOOST READY" : "DRIFT", 108, H - 12, { color: c, outline: INK });
    }

    this.minimap(scr, race, now);
    this.dreamStatus(scr, race, now);
    this.itemSlot(scr, p, now);

    // banners
    this.banners = this.banners.filter((b) => b.until > race.clock || race.phase === "countdown");
    for (const b of this.banners) {
      if (b.blink && Math.floor(now * 4) % 2) continue;
      // a ribbon behind the big text: it spans the screen, so it lies over the standings
      scr.dimRect(0, 79, W, b.sub ? 46 : 33, INK, 0.62);
      f.draw(scr, b.text, W / 2, 84, { scale: 3, color: b.color, outline: INK, align: "center" });
      if (b.sub) f.draw(scr, b.sub, W / 2, 112, { color: WHITE, outline: INK, align: "center" });
    }
    if (p.wrongWay > 45 && Math.floor(now * 3) % 2 === 0) {
      f.draw(scr, "WRONG WAY!", W / 2, 120, { scale: 2, color: RED, outline: INK, align: "center" });
    }
    if (race.phase === "countdown") this.countdown(scr, race);
  }

  /** The item slot: icons cycle while the roulette spins, then the item waits for E. */
  private itemSlot(scr: Screen, p: Kart, now: number): void {
    const x = W - 46, y = 44, size = 36;
    const ready = !!p.item && p.roulette <= 0;
    scr.fillRect(x - 1, y - 1, size + 2, size + 2, INK);
    scr.fillRect(x, y, size, size, ready ? GOLD : DREAM);
    scr.dimRect(x + 2, y + 2, size - 4, size - 4, INK, 0.82);
    const kind = p.roulette > 0 ? ITEM_KINDS[Math.floor(now * 14) % ITEM_KINDS.length] : p.item;
    if (kind) {
      const icon = this.icons[kind];
      const w = icon.w * 2, h = icon.h * 2;
      scr.blitScaled(icon, x + (size - w) / 2, y + (size - h) / 2, w, h);
    }
    if (ready) this.font.draw(scr, "E", x + size / 2, y + size + 3, { color: SILVER, outline: INK, align: "center" });
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
  }

  private dreamStatus(scr: Screen, race: Race, now: number): void {
    const f = this.font;
    if (!race.track.locked && race.live) {
      const frac = race.dreamProgress;
      const x = W / 2 - 70, y = 8;
      f.draw(scr, race.live.busy ? "AI DREAMING THE CIRCUIT" : "CIRCUIT FORMING", W / 2, y, {
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
    const size = 74, x0 = W - size - 8, y0 = H - size - 8;
    // fit the designer's whole-circuit guess (or the locked circuit) into the box
    const radii = race.live?.preview ?? (t.locked ? t.radii : null);
    if (radii) {
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let j = 0; j < N; j++) {
        const [x, y] = polarPoint(radii[j], j);
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
        const [ax, ay] = polarPoint(pv[j], j);
        const [bx, by] = polarPoint(pv[(j + 1) % N], j + 1);
        for (let s = 0; s < 4; s++) {
          if ((j * 4 + s + Math.floor(now * 8)) % 3) continue;
          const [px, py] = map(ax + ((bx - ax) * s) / 4, ay + ((by - ay) * s) / 4);
          scr.fillRect(px, py, 1, 1, DREAM);
        }
      }
    }
    // committed road
    for (let i = 0; i < t.count; i += 3) {
      const [px, py] = map(t.xs[i], t.ys[i]);
      scr.fillRect(px - 1, py - 1, 2, 2, SILVER);
    }
    if (t.startIndex >= 0) {
      const [sx, sy] = map(t.xs[t.startIndex], t.ys[t.startIndex]);
      scr.fillRect(sx - 2, sy - 2, 4, 4, WHITE);
    }
    const dot = (k: Kart, r: number, c: number) => {
      const [px, py] = map(k.x, k.y);
      scr.fillRect(px - r, py - r, 2 * r + 1, 2 * r + 1, c);
    };
    for (const k of race.karts) if (!k.isPlayer) dot(k, 1, LIVERIES[k.livery].body);
    dot(race.player, 2, INK);
    dot(race.player, 1, Math.floor(now * 4) % 2 ? WHITE : LIVERIES[0].body);
  }
}

function fillCircle(scr: Screen, cx: number, cy: number, r: number, c: number): void {
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y));
    scr.fillRect(cx - w, cy + y, 2 * w + 1, 1, c);
  }
}
