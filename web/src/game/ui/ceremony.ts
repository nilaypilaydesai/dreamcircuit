// The Grand Prix's screens: the standings after each race (points pop in, totals count up, and
// the rows slide into their new order, as in the classics), and the award ceremony at the end: a
// camera that finds third, second and first on their pedestals, each racer in their kart with
// their name floating over it, then pulls back for fireworks, confetti and sweeping spotlights.

import type { Sound } from "../core/audio";
import type { PixelFont } from "../core/font";
import { H, Rand, type Screen, W, hex, mix } from "../core/gfx";
import { Cup, type CupRow, type Entrant } from "../race/cup";
import { paintOf } from "../race/parts";
import { LIVERIES, Turntable, kartModel } from "../render/sprites";

const INK = hex("#0b0b14");
const GOLD = hex("#ffd23f");
const SILVER = hex("#d9e1ea");
const BRONZE = hex("#e8955a");
const WHITE = 0xffffffff;
const DIM = hex("#8f87b8");
const DREAM = hex("#c79bff");
const LOGO_ROWS = ["#ffe66d", "#ffd23f", "#ffb347", "#ff8c42", "#ff6b6b", "#f25f9c", "#c77dff", "#9d6bff"].map(hex);
const MEDAL = [GOLD, SILVER, BRONZE];

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const ordinal = (n: number) => `${n}${n === 1 ? "ST" : n === 2 ? "ND" : n === 3 ? "RD" : "TH"}`;

/** Seconds until the standings have counted up and slid into their new order. */
export const STANDINGS_SETTLE = 2.7;

/** The standings after a race, animated over ``t`` seconds since they opened. */
export function drawStandings(scr: Screen, f: PixelFont, cup: Cup, rows: CupRow[], t: number): void {
  scr.dimRect(0, 0, W, H, INK, 0.7);
  const final = cup.done;
  const title = final ? "FINAL STANDINGS" : `RACE ${cup.index} OF ${cup.worlds.length}`;
  f.draw(scr, "GRAND PRIX", W / 2, 6, { scale: 2, rows: LOGO_ROWS, outline: INK, align: "center" });
  f.draw(scr, `${title}  ${cup.worlds[cup.index - 1]?.name ?? ""}`, W / 2, 26, { color: DREAM, outline: INK, align: "center" });
  const c0 = Math.round(W / 2), y0 = 40, rowH = Math.min(13, Math.floor((H - 112) / Math.max(1, rows.length)));
  f.draw(scr, "RACE", c0 + 34, y0 - 1, { color: DIM, align: "right" });
  f.draw(scr, "PTS", c0 + 150, y0 - 1, { color: DIM, align: "right" });
  const count = ease((t - 0.9) / 1.0); // totals count up
  const slide = ease((t - 2.0) / 0.7); // then the rows move to their new places
  const drawn = rows.map((r) => ({ r, y: y0 + 10 + ((r.rankBefore - 1) * (1 - slide) + (r.rank - 1) * slide) * rowH }));
  drawn.sort((a, b) => a.y - b.y);
  for (const { r, y } of drawn) {
    const me = r.entrant.isPlayer;
    if (me) scr.dimRect(c0 - 158, y - 2, 316, rowH - 1, GOLD, 0.22);
    const rank = slide > 0.5 ? r.rank : r.rankBefore;
    const c = me ? GOLD : WHITE;
    f.draw(scr, String(rank), c0 - 146, y, { color: rank <= 3 ? MEDAL[rank - 1] : c, align: "right", outline: INK });
    scr.fillRect(c0 - 138, y + 1, 6, 6, hex(paintOf(r.entrant.build).color));
    f.draw(scr, r.entrant.name, c0 - 126, y, { color: c, outline: INK });
    f.draw(scr, ordinal(r.place), c0 + 34, y, { color: DIM, align: "right", outline: INK });
    if (t > 0.6 + r.place * 0.06) f.draw(scr, `+${r.gained}`, c0 + 90, y, { color: GOLD, align: "right", outline: INK });
    const shown = Math.round(r.before + (r.points - r.before) * count);
    f.draw(scr, String(shown), c0 + 150, y, { color: c, align: "right", outline: INK });
  }
}

interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number; c: number }
interface Rocket { x: number; y: number; vy: number; burst: number; c: number }
interface Flake { x: number; y: number; vx: number; vy: number; ph: number; c: number }

/** The award ceremony. */
export class Ceremony {
  private t = 0;
  private readonly tables = [new Turntable(), new Turntable(), new Turntable()];
  private readonly models: Map<number, number>[];
  private readonly keys: string[];
  private sparks: Spark[] = [];
  private rockets: Rocket[] = [];
  private confetti: Flake[] = [];
  private readonly rng = new Rand(42);
  private nextRocket = 3.4;
  private cues = new Set<string>();
  readonly playerPlace: number; // where the player finished the cup (1-based)

  constructor(readonly top3: Entrant[], playerPlace: number) {
    this.playerPlace = playerPlace;
    this.models = top3.map((e) => kartModel(e.build, LIVERIES[e.livery % LIVERIES.length]));
    this.keys = top3.map((e) => `${e.id}:${JSON.stringify(e.build)}`);
  }

  get elapsed(): number {
    return this.t;
  }

  /** The celebration grows with how the player did: a win gets the most fireworks. */
  private get rate(): number {
    return this.playerPlace === 1 ? 0.35 : this.playerPlace <= 3 ? 0.55 : 0.85;
  }

  update(dt: number, sound: Sound): void {
    this.t += dt;
    const once = (key: string, at: number, fn: () => void) => {
      if (this.t >= at && !this.cues.has(key)) {
        this.cues.add(key);
        fn();
      }
    };
    once("fanfare", 0.15, () => sound.fanfare());
    once("third", 1.5, () => sound.reveal(3));
    once("second", 3.0, () => sound.reveal(2));
    once("first", 4.5, () => sound.reveal(1));
    once("cheer", 4.6, () => sound.cheer());
    // fireworks: rockets climb, then burst into sparks
    if (this.t > this.nextRocket) {
      this.nextRocket = this.t + this.rate * (0.6 + this.rng.next());
      const c = this.rng.pick(["#ffd23f", "#ff5fa2", "#63c8ff", "#5dff7a", "#c79bff", "#ff8a3d"].map(hex));
      this.rockets.push({ x: this.rng.range(0.12, 0.88) * W, y: H, vy: -this.rng.range(120, 170), burst: this.rng.range(0.18, 0.42) * H, c });
      sound.whistle();
    }
    for (const r of this.rockets) {
      r.y += r.vy * dt;
      if (r.y <= r.burst) {
        const n = 34 + this.rng.int(0, 20);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2, sp = this.rng.range(30, 70);
          this.sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: this.rng.range(1.0, 1.6), age: 0,
                             c: this.rng.next() > 0.8 ? WHITE : r.c });
        }
        sound.firework(r.y < H * 0.3);
      }
    }
    this.rockets = this.rockets.filter((r) => r.y > r.burst);
    for (const s of this.sparks) {
      s.age += dt;
      s.vy += 40 * dt;
      s.vx *= Math.exp(-1.2 * dt);
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    this.sparks = this.sparks.filter((s) => s.age < s.life);
    // confetti once the winner is revealed
    if (this.t > 4.5 && this.confetti.length < 110) {
      const colors = this.playerPlace === 1 ? ["#ffd23f", "#ffe66d", "#ffffff"] : ["#ff5fa2", "#63c8ff", "#5dff7a", "#ffd23f", "#c79bff"];
      this.confetti.push({ x: this.rng.next() * W, y: -4, vx: this.rng.range(-8, 8), vy: this.rng.range(18, 34),
                           ph: this.rng.range(0, 6), c: hex(this.rng.pick(colors)) });
    }
    for (const c of this.confetti) {
      c.x += (c.vx + Math.sin(this.t * 3 + c.ph) * 10) * dt;
      c.y += c.vy * dt;
      if (c.y > H + 4) c.y = -4;
    }
  }

  draw(scr: Screen, f: PixelFont, touch = false): void {
    const t = this.t;
    // the night sky, warmer when the player won
    const top = this.playerPlace === 1 ? hex("#2a0f4a") : hex("#0b0420");
    const low = this.playerPlace === 1 ? hex("#ff8a3d") : hex("#5d2a7a");
    for (let y = 0; y < H; y++) scr.fillRect(0, y, W, 1, mix(top, low, Math.min(1, (y / H) * 1.25)));
    const stars = new Rand(9);
    for (let k = 0; k < 70; k++) {
      const x = stars.int(0, W), y = stars.int(0, Math.floor(H * 0.6));
      if ((Math.floor(t * 3) + k) % 7) scr.fillRect(x, y, 1, 1, WHITE);
    }
    // a stadium skyline with lit windows
    const sky = new Rand(3);
    const floor = Math.round(H * 0.8);
    for (let x = 0; x < W;) {
      const w = sky.int(14, 34), h = sky.int(18, 52);
      scr.fillRect(x, floor - h, w - 2, h, hex("#160c30"));
      for (let wy = floor - h + 4; wy < floor - 4; wy += 6) {
        for (let wx = x + 3; wx < x + w - 5; wx += 5) if (sky.next() > 0.55) scr.fillRect(wx, wy, 2, 2, hex("#ffd98a"));
      }
      x += w;
    }
    // spotlights sweeping up from the stage
    for (const [x0, ph] of [[W * 0.18, 0], [W * 0.82, 2.2]] as const) {
      const a = -Math.PI / 2 + Math.sin(t * 0.7 + ph) * 0.5;
      for (let r = 0; r < H; r += 1) {
        const cx = x0 + Math.cos(a) * r, cy = floor + Math.sin(a) * r, half = 2 + r * 0.12;
        if (cy < 0) break;
        scr.dimRect(cx - half, cy, half * 2, 1, hex("#e9dcff"), 0.07);
      }
    }
    for (const s of this.sparks) {
      const fade = 1 - s.age / s.life;
      scr.dimRect(s.x, s.y, s.age < 0.3 ? 2 : 1, s.age < 0.3 ? 2 : 1, s.c, Math.max(0.15, fade));
    }
    for (const r of this.rockets) scr.fillRect(r.x, r.y, 1, 3, hex("#ffe27a"));
    // the stage floor
    scr.fillRect(0, floor, W, H - floor, hex("#1a0d38"));
    for (let k = -10; k <= 10; k++) {
      for (let y = floor; y < H; y++) {
        const x = W / 2 + k * 22 * (0.3 + (y - floor) / (H - floor));
        if (x >= 0 && x < W) scr.dimRect(x, y, 1, 1, hex("#7b3cff"), 0.3);
      }
    }
    // the camera finds third, second, then first, and pulls back to show the podium
    const spots = [{ x: 0, h: 50 }, { x: -92, h: 35 }, { x: 92, h: 24 }];
    const focus = (i: number, z: number) => ({ x: spots[i].x, y: floor - spots[i].h - 22, z });
    const keys = [
      { at: 0, ...focus(2, 1.75) }, { at: 1.5, ...focus(2, 1.75) }, { at: 3.0, ...focus(1, 1.75) },
      { at: 4.5, ...focus(0, 1.9) }, { at: 5.6, ...focus(0, 1.9) }, { at: 7.0, x: 0, y: H * 0.52, z: 1 },
    ];
    let k = 0;
    while (k < keys.length - 2 && t > keys[k + 1].at) k++;
    const a = keys[k], b = keys[k + 1];
    const u = ease((t - a.at) / Math.max(0.01, b.at - a.at));
    const cam = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
    const sx = (x: number) => W / 2 + (x - cam.x) * cam.z, sy = (y: number) => H / 2 + (y - cam.y) * cam.z;
    const reveal = [4.5, 3.0, 1.5]; // when each place is shown
    spots.forEach((sp, i) => {
      const color = MEDAL[i];
      const x0 = sx(sp.x - 36), x1 = sx(sp.x + 36), yTop = sy(floor - sp.h), yBot = sy(floor);
      scr.fillRect(x0, yTop, x1 - x0, yBot - yTop, mix(color, INK, 0.45));
      scr.fillRect(x0, yTop, x1 - x0, Math.max(2, 4 * cam.z), color);
      scr.fillRect(x0, yTop, Math.max(1, 2 * cam.z), yBot - yTop, mix(color, INK, 0.25));
      const sc = Math.max(1, Math.round(2.4 * cam.z));
      f.draw(scr, String(i + 1), (x0 + x1) / 2, yTop + 8 * cam.z, { scale: sc, color, outline: INK, align: "center" });
      const e = this.top3[i];
      if (!e || t < reveal[i] - 0.2) return;
      // the racer in their kart, turning a little to show it off
      const kx = sx(sp.x), ky = sy(floor - sp.h) - 1;
      this.tables[i].draw(scr, this.models[i], this.keys[i], kx, ky, Math.PI + 0.55 * Math.sin(t * 0.6 + i), 1.75 * cam.z);
      const bob = Math.sin(t * 2.4 + i) * 2;
      const label = e.isPlayer ? "YOU" : e.name;
      f.draw(scr, label, kx, ky - 44 * cam.z + bob, { scale: cam.z > 1.4 ? 2 : 1, color: e.isPlayer ? GOLD : WHITE, outline: INK, align: "center" });
    });
    for (const c of this.confetti) scr.fillRect(c.x, c.y, 2, Math.sin(this.t * 6 + c.ph) > 0 ? 2 : 1, c.c);
    // the headline
    if (t > 4.6) {
      const p = this.playerPlace;
      const head = p === 1 ? "YOU WIN THE GRAND PRIX!" : p <= 3 ? `YOU FINISHED ${ordinal(p)}!` : `${this.top3[0]?.name ?? ""} WINS THE GRAND PRIX`;
      const lines = f.wrap(head, W - 16, 1);
      lines.forEach((line, i) => f.draw(scr, line, W / 2, 8 + i * 10, { color: p <= 3 ? GOLD : WHITE, outline: INK, align: "center" }));
      if (p > 3) f.draw(scr, `YOU FINISHED ${ordinal(p)}`, W / 2, 10 + lines.length * 10, { color: DIM, outline: INK, align: "center" });
    }
    if (t > 7.5 && Math.floor(t * 2) % 2 === 0) {
      f.draw(scr, touch ? "TAP TO CONTINUE" : "PRESS ENTER", W / 2, H - 12, { color: WHITE, outline: INK, align: "center" });
    }
  }
}
