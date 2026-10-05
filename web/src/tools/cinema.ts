// The trailer, and the DATA page's hero video (and the stills and GIF frames for the README),
// filmed in the game itself, in one pass, as two cuts:
//   the trailer: it opens on the designer's real denoising of a circuit (the noisy lap after each
//     of its 24 steps, recorded from the model), a scribble that untangles into a figure-eight,
//     and the game's logo over it; then that circuit raced in Dream Valley, from the countdown to
//     a fly-by at the start, the jump, under and over its bridge, and a world after world, a
//     caption naming each; the garage, the items and the Grand Prix podium; and an end card. Hard
//     cuts, every shot a whole number of bars of the music (rendered from the game's own songs:
//     the title song under the opening, the countdown's beeps, and Dream Valley's from GO), which
//     is sent alongside as a WAV to be laid under the video.
//   the hero video: the same shots without the opening, the captions or the end card, cross-faded,
//     the last back into the first, so it loops behind the DATA page's title without a seam.
// It drives races through the dev hook (window.__dc) on circuits the designer dreamed and films
// clean, HUD-free shots from scripted cameras. Every 384x216 frame is upscaled with
// nearest-neighbour sampling (the pixel art stays crisp) and encoded as it is filmed, with
// WebCodecs, into H.264 MP4s, one per output size; the posters are their first frames. Files go
// to a local capture server (scripts/capture_frames.py), which writes them to disk.
//
// In the browser console on the dev server (http://localhost:5173/):
//   const { film } = await import("/src/tools/cinema.ts"); await film({ figure8, loops, opening, dream })

import { Music, SONGS } from "../game/core/music";
import { Encoder } from "./mp4";

interface Kart {
  x: number; y: number; heading: number; elev: number; ground: number; air: boolean; idx: number; v: number; boostTime: number;
  place: number; dist: number; isPlayer: boolean; finished: boolean; drifting: boolean; boostLevel: number;
  offset: number; fall: number; dropX: number; dropY: number; dropZ: number; // (the volcano's lava)
  slope: number; // how the road climbs under it
  staticT: number; // s left with a rival's static over its screen
  wings: number; // s left with a wing pad's wings (the tunnel: its walls are for winged karts)
  rampU: number; // 0..1 up a jump's ramp, -1 off it
  driftDir: number; // which way it is drifting (1: left)
}
interface Hill { s0: number; len: number; h: number; style?: string; side?: number }
interface Track {
  xs: number[]; ys: number[]; s: number[]; elev: number[]; count: number; length: number; startIndex: number;
  bridges: { center: number; lower: number; centerS: number }[]; hills: Hill[];
  tangent(i: number): [number, number];
  curvature(i: number): number;
  wrap(i: number): number;
  fromStart(i: number): number;
  nearest(x: number, y: number, hint: number, window?: number): number;
  offset(x: number, y: number, i: number): number;
}
interface Race {
  track: Track; player: Kart; standings: Kart[]; karts: Kart[]; phase: string; countdown: number;
  scenery: { items: { x: number; y: number; art: { solid: boolean } }[] };
  features: { ramps: { start: number }[]; tunnels: { s0: number }[]; pads: { start: number; offset: number; wing?: boolean }[] };
  items: { blasts: unknown[]; rowS: number[]; comets: { phase: string; x: number; y: number; z: number; target: Kart | null }[] };
  aimPhase: number; // the player's aiming arrow (where it is in its sweep)
  obstacles: { list: { kind: string; state: number; t: number; wait: number; s: number; offset: number; idx: number; x: number; y: number }[] };
  hazards: { kind: string; x: number; y: number; rx: number; ry: number }[]; // what a kart can drive into off the road
}
interface Scr {
  buf: Uint32Array;
  present(): void;
  fillRect(x: number, y: number, w: number, h: number, c: number): void;
  dimRect(x: number, y: number, w: number, h: number, c: number, a: number): void;
}
interface Font {
  draw(scr: Scr, text: string, x: number, y: number, style?: Record<string, unknown>): void;
}
interface Game {
  race: Race | null;
  time: number;
  cam: { heading: number };
  sky: { earthAt: number } | null;
  garage: { menu: { index: number; items: { right?: () => void }[] }; set(b: Record<string, string>): void };
  ceremony: { update(dt: number, sound: unknown): void } | null;
  sound: unknown;
  scr: Scr; // (the game's framebuffer and pixel font: TypeScript-private, there at runtime)
  font: Font;
  render(): void;
}
interface Dc {
  step(n: number, keys?: string[], draw?: boolean, dt?: number): void; // (dt: each step's length, for slow motion)
  shot(cam: Record<string, number>): void;
  state(): Record<string, unknown>;
  race(points: number[], theme?: number, rivals?: number, type?: string): void;
  hold(on?: boolean): void;
  pin(size: [number, number] | null): void;
  give(item: string): void;
  go(mode: string): void;
  cup(ceremony?: boolean, place?: number): void;
  game: Game;
}

export interface Variant { name: string; w: number; h: number; bitrate: number }

export interface FilmOptions {
  url?: string; // capture server
  figure8: number[]; // a figure-eight (game meters): the tunnel's wing pad and the loop round its roof
  // ten plain loops: three for the items (Sunset Mesa, one with a canyon), the reef, the tunnel's
  // traffic, the valley, the volcano, the building site, the moon and Tokyo
  loops: number[][];
  opening: number[]; // the circuit the opening dreams (game meters), raced in Dream Valley
  // and its dream: the noisy lap after each of the designer's 24 Heun steps (the first pure
  // noise), as steps between its points (x row, then y row, network units), and their scale
  dream: { states: number[][]; scale: number };
  fps?: number;
  fade?: number; // frames of cross-fade between shots (the hero video)
  every?: number; // also save every nth frame at game resolution (the README's GIF and stills)
}

export const VARIANTS: Variant[] = [
  { name: "hero", w: 1920, h: 1080, bitrate: 3_000_000 },
  { name: "hero-648", w: 1152, h: 648, bitrate: 1_400_000 }, // exactly 3x: small screens
];
export const TRAILER: Variant[] = [
  { name: "trailer", w: 1920, h: 1080, bitrate: 3_200_000 },
  { name: "trailer-648", w: 1152, h: 648, bitrate: 1_600_000 },
];

// the aiming arrow's sweep (race/items.ts)
const AIM_MAX = 0.75, AIM_RATE = 3.1;
const THEME = { valley: 0, tunnel: 1, mesa: 2, reef: 3, tokyo: 4, volcano: 5, construction: 6, moon: 7 };
const POLICE_CHASE = 1, POLICE_LUNGE = 4, GEYSER_QUIET = 0; // (race/obstacles.ts)
const FALL_SWAP = 0.72; // into the lava: lifted out (race/kart.ts)
const PAN = 1536, FRAME_W = 384; // the sky's panorama for a full turn, and the film's width (render/sky.ts)
const W = 384, H = 216;
const HALF_WIDTH = 6.5; // m (world/track.ts)

// the music: the title song under the opening (and the end card), Dream Valley's from GO; every
// shot from GO on is a whole number of its bars (at 150 bpm and 30 fps, 48 frames each)
const TITLE_BAR = (4 * 60) / SONGS.title.bpm; // s
const BAR = (4 * 60) / SONGS.valley.bpm; // s

const tick = () => new Promise<void>((r) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => r();
  ch.port2.postMessage(0);
});
const smooth = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// colors, packed as the framebuffer's (0xAABBGGRR, as core/gfx.ts packs them)
const rgb = (r: number, g: number, b: number): number => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
const hex = (s: string): number => {
  const v = parseInt(s.slice(1), 16);
  return rgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
};
const mix = (a: number, b: number, t: number): number =>
  rgb((a & 255) + (((b & 255) - (a & 255)) * t) | 0, ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * t) | 0,
      ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * t) | 0);
const INK = hex("#0b0b14"), WHITE = 0xffffffff, HOT = hex("#ffd23f"), DREAM = hex("#c79bff"), DIM = hex("#8f87b8");
const GO_GREEN = hex("#5dff7a"), SKY_TOP = hex("#0b0420"), SKY_LOW = hex("#24103f");
const LOGO_ROWS = ["#ffe66d", "#ffd23f", "#ffb347", "#ff8c42", "#ff6b6b", "#f25f9c", "#c77dff", "#9d6bff"].map(hex); // (the title screen's)

/** A cut as it is shot: cross-fades between shots (or hard cuts, with no fade), every frame
 * upscaled and encoded at once (nothing but a cross-fade's worth of frames is held in memory),
 * and, for a loop, the last shot faded back into the first. */
class Reel {
  readonly shots: { name: string; start: number }[] = []; // the first clean frame of each shot
  private readonly low: OffscreenCanvas;
  private readonly lg: OffscreenCanvasRenderingContext2D;
  private head: ImageBitmap[] = []; // the first shot's opening frames: the loop fades into them
  private tail: ImageBitmap[] = []; // the previous shot's closing frames, fading into this shot
  // A shot's frames are held back by `fade` frames, so whenever the shot ends, its last `fade`
  // frames are still unemitted and become the cross-fade into the next shot.
  private pending: ImageBitmap[] = [];
  private index = -1;
  private k = 0;
  private emitted = 0;
  private poster: Blob | null = null;
  private readonly posts: Promise<unknown>[] = [];

  private constructor(private readonly canvas: HTMLCanvasElement, private readonly fps: number,
                      private readonly fade: number, private readonly every: number, private readonly loop: boolean,
                      private readonly prefix: string,
                      private readonly outs: { v: Variant; big: OffscreenCanvas; g: OffscreenCanvasRenderingContext2D; enc: Encoder }[],
                      private readonly post: (name: string, blob: Blob) => Promise<unknown>) {
    this.low = new OffscreenCanvas(canvas.width, canvas.height);
    this.lg = this.low.getContext("2d")!;
  }

  static async open(canvas: HTMLCanvasElement, o: { fps: number; fade: number; every: number; loop: boolean; prefix: string },
                    variants: Variant[], post: (name: string, blob: Blob) => Promise<unknown>): Promise<Reel> {
    const outs = [];
    for (const v of variants) {
      const big = new OffscreenCanvas(v.w, v.h);
      const g = big.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      outs.push({ v, big, g, enc: new Encoder(v.w, v.h, o.fps, await Encoder.pick(v.w, v.h, o.fps), v.bitrate) });
    }
    return new Reel(canvas, o.fps, o.fade, o.every, o.loop, o.prefix, outs, post);
  }

  /** Frames emitted so far (the time, in frames, of the next). */
  get frames(): number {
    return this.emitted + this.pending.length;
  }

  private async emit(a: CanvasImageSource, b?: CanvasImageSource, alpha = 0): Promise<void> {
    this.lg.globalAlpha = 1;
    this.lg.drawImage(a, 0, 0);
    if (b) {
      this.lg.globalAlpha = alpha;
      this.lg.drawImage(b, 0, 0);
      this.lg.globalAlpha = 1;
    }
    for (const o of this.outs) {
      o.g.drawImage(this.low, 0, 0, o.v.w, o.v.h);
      await o.enc.add(o.big);
      if (!this.poster) this.poster = await o.big.convertToBlob({ type: "image/jpeg", quality: 0.86 });
    }
    if (this.every && this.emitted % this.every === 0) {
      const png = await this.low.convertToBlob({ type: "image/png" });
      this.posts.push(this.post(`${this.prefix}${String(this.emitted).padStart(4, "0")}.png`, png));
    }
    this.emitted += 1;
  }

  begin(name: string): void {
    this.index += 1;
    this.k = 0;
    this.tail = this.pending;
    this.pending = [];
    this.shots.push({ name, start: this.emitted + (this.index === 0 ? 0 : this.fade) });
  }

  /** Film the frame on the game's canvas as the next frame of the current shot. */
  async save(): Promise<void> {
    const k = this.k++;
    const bmp = await createImageBitmap(this.canvas);
    if (k < this.fade) {
      if (this.index === 0) {
        if (this.loop) this.head.push(bmp);
        else {
          await this.emit(bmp);
          bmp.close();
        }
      } else {
        const from = this.tail[k];
        await this.emit(from ?? bmp, bmp, (k + 1) / (this.fade + 1));
        from?.close();
        bmp.close();
      }
    } else {
      this.pending.push(bmp);
      if (this.pending.length > this.fade) {
        const oldest = this.pending.shift()!;
        await this.emit(oldest);
        oldest.close();
      }
    }
  }

  /** Finish the files and send them: a loop's last shot fades back into its first; otherwise the
   * last frames still held back go out as they are. */
  async finish(): Promise<Record<string, number>> {
    if (this.loop) {
      for (let k = 0; k < this.fade; k++) {
        await this.emit(this.pending[k] ?? this.head[k], this.head[k], (k + 1) / (this.fade + 1));
      }
    } else {
      for (const b of this.pending) await this.emit(b);
    }
    for (const b of [...this.head, ...this.pending, ...this.tail]) b.close();
    const sizes: Record<string, number> = {};
    for (const o of this.outs) {
      const video = await o.enc.finish();
      sizes[o.v.name] = video.size;
      await this.post(`${o.v.name}.mp4`, video);
    }
    if (this.poster) await this.post(`${this.outs[0].v.name}.jpg`, this.poster);
    await Promise.all(this.posts);
    const manifest = { fps: this.fps, fade: this.fade, every: this.every, frames: this.emitted, shots: this.shots };
    await this.post(`${this.outs[0].v.name}_manifest.json`, new Blob([JSON.stringify(manifest)], { type: "text/plain" }));
    return { ...sizes, frames: this.emitted };
  }
}

/** The noisy lap after ``k`` of the dream's Heun steps (fractional: between two steps' states), as
 * screen points: the steps integrated into a loop as from_steps does with nothing known (the
 * closing gap spread over every step), fitted around (cx, cy) at ``r`` pixels from its middle on
 * average. */
function lapAt(dream: FilmOptions["dream"], k: number, cx: number, cy: number, r: number): [number, number][] {
  const S = dream.states, n = S[0].length / 2;
  const a = Math.max(0, Math.min(S.length - 1, Math.floor(k))), b = Math.min(S.length - 1, a + 1), w = clamp01(k - a);
  const u = (j: number) => (S[a][j] * (1 - w) + S[b][j] * w) * dream.scale;
  let gx = 0, gy = 0;
  for (let j = 0; j < n; j++) { gx += u(j); gy += u(n + j); }
  const pts: [number, number][] = [[0, 0]];
  for (let j = 1; j < n; j++) {
    const [px, py] = pts[j - 1];
    pts.push([px + u(j - 1) - gx / n, py + u(n + j - 1) - gy / n]);
  }
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x / n; my += y / n; }
  let rms = 0;
  for (const [x, y] of pts) rms += ((x - mx) ** 2 + (y - my) ** 2) / n;
  const f = r / (Math.sqrt(rms) || 1);
  return pts.map(([x, y]) => [cx + (x - mx) * f, cy - (y - my) * f]);
}

export async function film(o: FilmOptions): Promise<Record<string, number>> {
  const dc = (window as unknown as { __dc: Dc }).__dc;
  const g = dc.game;
  const url = o.url ?? "http://127.0.0.1:8765";
  const fps = o.fps ?? 30;
  const fade = o.fade ?? 12;
  const per = Math.round(60 / fps); // simulation steps per filmed frame
  const post = (name: string, blob: Blob) =>
    fetch(`${url}/save/${name}`, { method: "POST", body: blob, headers: { "Content-Type": "text/plain" } });
  dc.pin([W, H]); // the film is composed for the classic 16:9 framebuffer, whatever the window
  dc.hold(true);
  // every take starts from the same kart (the garage shot changes it, and the browser keeps it)
  dc.game.garage.set({ body: "classic", wheels: "standard", spoiler: "none", exhaust: "stock", paint: "sunset", accent: "cream" });
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const hero = await Reel.open(canvas, { fps, fade, every: o.every ?? 0, loop: true, prefix: "f_" }, VARIANTS, post);
  const trailer = await Reel.open(canvas, { fps, fade: 0, every: o.every ?? 0, loop: false, prefix: "t_" }, TRAILER, post);
  const race = () => dc.game.race!;
  const frames = (seconds: number) => Math.round(fps * seconds);
  const bars = (n: number) => Math.round(fps * BAR * n);
  const counts: Record<string, number> = {};
  // when the music changes: GO (Dream Valley's song from here), the end card (the title song
  // again), and the countdown's beeps, in trailer frames
  const cue = { go: -1, end: -1, beeps: [] as number[] };

  // ---------------------------------------------------------------- the two cuts
  // Every frame goes into the trailer; the hero video takes the shots that are not the opening's
  // or the end card's, and none of the trailer's writing (it is filmed before the captions go on).
  let inHero = true;
  const begin = (name: string, heroToo = true) => {
    inHero = heroToo;
    if (heroToo) hero.begin(name);
    trailer.begin(name);
  };
  const save = async (name: string, dress?: () => void) => {
    counts[name] = (counts[name] ?? 0) + 1;
    if (inHero) await hero.save();
    if (dress) {
      dress();
      g.scr.present();
    }
    await trailer.save();
  };

  // ---------------------------------------------------------------- writing over the picture
  /** Draw with ``draw`` over the frame at ``a`` (0..1) of full strength. */
  const faded = (a: number, draw: () => void) => {
    if (a <= 0) return;
    if (a >= 1) return draw();
    const base = g.scr.buf.slice();
    draw();
    const b = g.scr.buf;
    for (let i = 0; i < b.length; i++) if (b[i] !== base[i]) b[i] = mix(base[i], b[i], a);
  };
  /** In from 0 to 1 over ``ramp`` frames from frame ``at``, and back out by frame ``until``. */
  const swell = (f: number, at: number, until: number, ramp = 8) => clamp01(Math.min((f - at + 1) / ramp, (until - f) / ramp));
  const text = (s: string, x: number, y: number, style: Record<string, unknown>) => g.font.draw(g.scr, s, x, y, style);
  /** A world's name, low on the left, with a bar of gold beside it. */
  const caption = (name: string, f: number, at = 6, len = 62) => faded(swell(f, at, at + len), () => {
    g.scr.fillRect(12, H - 27, 2, 12, HOT);
    text(name, 19, H - 25, { color: WHITE, outline: INK });
  });
  /** An item's name, low on the right, as it is used. */
  const label = (name: string, f: number, at = 6, len = 44) => faded(swell(f, at, at + len), () =>
    text(name, W - 14, H - 25, { color: HOT, outline: INK, align: "right" }));
  /** The picture in blocks of ``b`` x ``b`` pixels, each the colour of its top left corner (the
   * classics' mosaic). */
  const mosaic = (b: number) => {
    if (b <= 1) return;
    const buf = g.scr.buf;
    for (let y0 = 0; y0 < H; y0 += b) {
      for (let x0 = 0; x0 < W; x0 += b) {
        const c = buf[y0 * W + x0];
        for (let y = y0; y < Math.min(H, y0 + b); y++) buf.fill(c, y * W + x0, y * W + Math.min(W, x0 + b));
      }
    }
  };
  /** What a stretch of the trailer shows, bigger, high in the middle (over the sky, clear of the
   * karts low in the picture). */
  const banner = (s: string, f: number, at = 4, len = 66) => faded(swell(f, at, at + len), () =>
    text(s, W / 2, 22, { scale: 2, color: WHITE, outline: INK, align: "center" }));
  const black = (a: number) => { if (a > 0) g.scr.dimRect(0, 0, W, H, rgb(0, 0, 0), clamp01(a)); };
  const backdrop = () => {
    for (let y = 0; y < H; y++) g.scr.fillRect(0, y, W, 1, mix(SKY_TOP, SKY_LOW, y / H));
  };
  /** The dream's lap after ``k`` steps, a line of light (``glow``: how bright, 0..1). */
  const drawLap = (k: number, glow: number, color: number, cx = W / 2, cy = H / 2, r = 50) => {
    const pts = lapAt(o.dream, k, cx, cy, r), b = g.scr.buf;
    const plot = (x: number, y: number, c: number, a: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      b[y * W + x] = mix(b[y * W + x], c, a);
    };
    for (let j = 0; j < pts.length; j++) {
      const [ax, ay] = pts[j], [bx, by] = pts[(j + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 1.5));
      for (let s = 0; s < steps; s++) {
        const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) plot(x + dx, y + dy, color, 0.3 * glow);
      }
    }
    for (let j = 0; j < pts.length; j++) {
      const [ax, ay] = pts[j], [bx, by] = pts[(j + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 1.5));
      for (let s = 0; s < steps; s++) plot(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, color, glow);
    }
  };


  // ---------------------------------------------------------------- driving, and the cameras
  // the autopilot drives (and leaves the items to the script); at a start it waits, then hits the
  // gas just before GO: a rocket start
  const keys = (extra: string[] = []) => {
    const r = race();
    if (r.phase !== "countdown") return ["auto", "noitems", ...extra];
    return r.countdown <= 1.35 ? ["gas"] : [];
  };
  /** The race on by ``steps`` steps of ``dt`` s (shorter than the usual 1/60: slow motion). */
  const advance = (steps: number, extra: string[] = [], dt = 1 / 60) => {
    dc.step(steps, keys(extra), false, dt);
    // (the player is never filmed under a rival's static: it fills the screen, and the autopilot
    // would drive half blind)
    race().player.staticT = 0;
  };
  const until = async (done: () => boolean, limit: number, extra: () => string[] = () => []) => {
    for (let guard = 0; !done() && guard < limit; guard++) {
      advance(1, extra());
      if (guard % 200 === 0) await tick();
    }
  };
  const start = async (points: number[], theme: number, rivals: number, type = "classic") => {
    dc.race(points, theme, rivals, type);
    // (the game shows its dreaming screen for a frame before it sets the race out: wait by the
    // clock, since a count of ticks, each far quicker than a frame, could run out before it came)
    const t0 = performance.now();
    while (!(dc.state().mode === "race" && dc.game.race?.phase === "countdown")) {
      if (performance.now() - t0 > 120_000) throw new Error("the race was never set out");
      await new Promise((r) => setTimeout(r, 4));
    }
  };
  const ready = async (points: number[], theme: number, meters: number, field = 7) => {
    await start(points, theme, field);
    await until(() => race().phase === "racing" && race().player.dist > meters, 60 * 30);
  };
  const heading = (i: number) => {
    const [tx, ty] = race().track.tangent(i);
    return Math.atan2(ty, tx);
  };
  // arc length from kart k forward to dense index i, on the locked circuit
  const ahead = (k: Kart, i: number) => {
    const t = race().track;
    const d = t.s[i] - t.s[k.idx];
    return d < 0 ? d + t.length : d;
  };
  /** The dense index ``m`` m along the road from index i (back, for m < 0). */
  const along = (i: number, m: number) => race().track.wrap(i + Math.round(m / 0.58));
  /** Where ``off`` m left of the road at index i is. */
  const beside = (i: number, off: number): [number, number] => {
    const t = race().track, [tx, ty] = t.tangent(i);
    return [t.xs[i] - ty * off, t.ys[i] + tx * off];
  };
  // the climb kart k is on, if any
  const climb = (k: Kart): Hill | undefined => {
    const s = race().track.s[k.idx];
    return race().track.hills.find((h) => s >= h.s0 && s <= h.s0 + h.len);
  };
  // a kart's distance and bearing (off the player's heading) from the player
  const seen = (k: Kart) => {
    const p = race().player;
    const dx = k.x - p.x, dy = k.y - p.y;
    return { d: Math.hypot(dx, dy), off: wrapAngle(Math.atan2(dy, dx) - p.heading) };
  };
  const rivals = () => race().karts.filter((k) => !k.isPlayer && !k.finished);
  /** The rival right in front of the player, between ``near`` and ``far`` m up the road and
   * within ``wide`` m of its line, if one is. */
  const inFront = (near: number, far: number, wide = 3) => rivals().filter((k) => {
    const d = k.dist - race().player.dist, s = seen(k);
    return d > near && d < far && Math.abs(Math.sin(s.off) * s.d) < wide;
  }).sort((a, b) => a.dist - b.dist)[0];
  // shots that ride with a kart: a tracking shot from ahead and to the side (side 1: the left), its
  // heading smoothed (a drifting kart's heading swings, and a camera hung off it swung with it)
  let calm: number | null = null; // the smoothed heading the riding cameras hang off
  const steady = (k: Kart, rate = 5) => {
    calm = calm === null ? k.heading : calm + wrapAngle(k.heading - calm) * Math.min(1, rate / fps);
    return calm;
  };
  const track = (k: Kart, side = 1, d = 6.5, h = 2.3, focal = 250) => {
    const hd = steady(k), c = Math.cos(hd), sn = Math.sin(hd);
    const x = k.x + c * d - sn * d * side, y = k.y + sn * d + c * d * side;
    dc.shot({ x, y, heading: Math.atan2(k.y - y, k.x - x), height: h + k.elev, focal, fx: 0, clear: 3 });
  };
  /** Behind the kart, ``back`` m and ``h`` m up, the view tipped down to keep the kart low in the
   * picture (raised, the game's own camera lost the kart off the foot of the screen). */
  const behind = (k: Kart, back = 7, h = 3.6, row = 176) => {
    const hd = steady(k, 4), x = k.x - Math.cos(hd) * back, y = k.y - Math.sin(hd) * back;
    dc.shot({ x, y, heading: hd, height: k.ground + h, focal: 250, fx: 0, clear: 2.5, horizon: Math.round(row - (h / back) * 250) });
  };
  /** Out in front of kart ``k``, ``d`` m up the road and ``side`` m to its left, looking back at
   * ``at`` (default: the kart): the shot of a kart coming at the camera, and of one passing another. */
  const lead = (k: Kart, d = 10, side = 2, h = 1.4, at?: [number, number]) => {
    const hd = steady(k, 4), c = Math.cos(hd), sn = Math.sin(hd);
    const x = k.x + c * d - sn * side, y = k.y + sn * d + c * side;
    stand(x, y, k.ground + h, at ?? [k.x, k.y], 250, 84, 8);
  };
  /** A camera standing at (x, y), ``h`` m up, turning to follow whatever ``at`` gives (smoothly:
   * a pan, not a snap; fast as a fly-by goes past, as a real one would be). */
  let aim: number | null = null;
  const stand = (x: number, y: number, h: number, at: [number, number], focal = 250, horizon = 74, rate = 7) => {
    const want = Math.atan2(at[1] - y, at[0] - x);
    aim = aim === null ? want : aim + wrapAngle(want - aim) * Math.min(1, rate / fps);
    dc.shot({ x, y, heading: aim, height: h, focal, fx: 0, clear: 2, horizon });
  };
  /** A shot of ``n`` frames: the race goes on (``extra``: keys pressed; ``slow``: how many times
   * slower than life, 1 for not at all) while ``shoot`` frames it. */
  const film = async (name: string, n: number, shoot: (f: number, n: number) => void,
                      opt: { extra?: (f: number) => string[]; dress?: (f: number, n: number) => void; slow?: (f: number) => number;
                             hero?: boolean } = {}) => {
    begin(name, opt.hero ?? true);
    calm = null;
    aim = null;
    for (let f = 0; f < n; f++) {
      const slow = opt.slow?.(f) ?? 1, extra = opt.extra?.(f) ?? [];
      if (slow > 1) advance(1, extra, 1 / (fps * slow));
      else advance(per, extra);
      shoot(f, n);
      await save(name, opt.dress ? () => opt.dress!(f, n) : undefined);
    }
  };
  /** The road point nearest (x, y) on the stretch ahead of the player. */
  const footAhead = (x: number, y: number) => race().track.nearest(x, y, race().player.idx, 260);
  /** Into a hazard of ``kind`` beside the road, and out again under the rescue drone: the player
   * steers off the road at the nearest one ahead (off camera) and is filmed from across the road
   * as it plunges in, the view darkening; then beside where the drone sets it down. */
  const rescue = async (name: string, kind: string, n: number, dress?: (f: number, n: number) => void) => {
    const t = race().track;
    const pick = () => race().hazards.filter((h) => h.kind === kind).map((h) => {
      const i = footAhead(h.x, h.y);
      return { h, i, d: ahead(race().player, i), off: t.offset(h.x, h.y, i) };
    }).filter((q) => q.d > 26 && q.d < 60 && Math.abs(q.off) < 24 && Math.abs(t.curvature(q.i)) < 1 / 35)
      .sort((a, b) => a.d - b.d)[0];
    await until(() => race().phase === "racing" && race().player.v > 14 && !!pick(), 60 * 150);
    const q = pick();
    if (!q) return false;
    const hz = q.h, steer = () => {
      const k = race().player;
      if (k.fall >= 0) return [];
      const a = wrapAngle(Math.atan2(hz.y - k.y, hz.x - k.x) - k.heading);
      return ["gas", ...(a > 0.04 ? ["left"] : a < -0.04 ? ["right"] : [])];
    };
    // (steered at it, off the camera, until it is about to go in)
    const close = () => Math.hypot(hz.x - race().player.x, hz.y - race().player.y) < Math.max(hz.rx, hz.ry) + 12;
    for (let guard = 0; !close() && race().player.fall < 0 && guard < 60 * 6; guard++) dc.step(1, steer(), false);
    const side = Math.sign(q.off) || 1, [cx, cy] = beside(q.i, -side * 9);
    begin(name);
    calm = null;
    aim = null;
    for (let f = 0; f < n; f++) {
      const k = race().player;
      dc.step(per, steer(), false);
      k.staticT = 0;
      if (k.fall < FALL_SWAP) stand(cx, cy, 2.4 + (t.elev[q.i] ?? 0), [k.x, k.y], 250, 80, 9);
      else {
        // beside where the drone sets it down (high enough to keep the drone in the picture)
        const [tx, ty] = t.tangent(t.wrap(k.idx));
        const x = k.dropX + tx * 4 - ty * 9.5 * -side, y = k.dropY + ty * 4 + tx * 9.5 * -side;
        dc.shot({ x, y, heading: Math.atan2(k.dropY - y, k.dropX - x), height: 3.6 + k.dropZ, focal: 250, fx: 0, clear: 3 });
      }
      await save(name, dress ? () => dress(f, n) : undefined);
    }
    return true;
  };

  // ================================================================ the opening: a dream
  // 1. The designer dreaming a figure-eight: its noisy lap after each Heun step, from pure noise (a
  //    scribble) to the circuit, untangling as the noise comes off. (Interpolated between steps;
  //    the steps' states are the model's own.) The name comes at the end.
  {
    const n = Math.round(fps * TITLE_BAR * 2);
    const kAt = (u: number) => (u < 0.1 ? 0 : u < 0.84 ? 19 * smooth((u - 0.1) / 0.74) : 19 + 5 * smooth((u - 0.84) / 0.16));
    begin("t_dream", false);
    for (let f = 0; f < n; f++) {
      const u = f / (n - 1), k = kAt(u);
      backdrop();
      drawLap(k, 1, mix(DREAM, HOT, smooth(clamp01((k - 13) / 11))));
      faded(swell(f, 6, n - 2, 14), () =>
        text("EVERY TRACK IS DREAMED BY AN AI", W / 2, 16, { color: DREAM, outline: INK, align: "center" }));
      faded(swell(f, 6, n - 2, 14), () =>
        text(`DENOISING ${Math.round((k / 24) * 100)}%`, W / 2, H - 24, { color: DIM, outline: INK, align: "center" }));
      faded(smooth(clamp01((f - (n - 26)) / 14)), () =>
        text("AS YOU RACE IT", W / 2, H - 38, { color: WHITE, outline: INK, align: "center" }));
      black(Math.max(1 - f / 10, (f - (n - 8)) / 8));
      g.scr.present();
      await save("t_dream");
    }
  }

  // ================================================================ Dream Valley: the dream, raced
  await start(o.opening, THEME.valley, 7);
  const opening = race().track;
  // 2. The countdown: a crane up from behind the grid, rising and tipping down so the whole grid
  //    stays in the picture and the road beyond the gantry comes into it, as the lights count down.
  {
    await until(() => race().countdown <= 3.98, 600); // (from the 3: the beeps a second apart)
    const t = opening, si = t.startIndex, h0 = heading(si);
    begin("a_grid");
    let f = 0, shown = 4;
    while (race().phase === "countdown" && f < frames(5)) {
      advance(per);
      const u = smooth(clamp01(f / frames(2.6)));
      const back = 46 - 6 * u, x = t.xs[si] - Math.cos(h0) * back, y = t.ys[si] - Math.sin(h0) * back;
      dc.shot({ x, y, heading: h0, height: 2 + 9 * u, focal: 250, fx: 0, clear: 3, horizon: Math.round(74 - 30 * u) });
      const n = Math.ceil(race().countdown - 1);
      if (n !== shown) {
        shown = n;
        if (n > 0) cue.beeps.push(trailer.frames); // (GO's is the next shot's)
      }
      const fresh = clamp01((race().countdown - 1 - (n - 1)) * 3); // (each number pops in, then fades)
      await save("a_grid", () => {
        faded(n > 0 ? Math.min(1, fresh * 1.5) : 0, () => text(String(n), W / 2, 70, { scale: 5, color: WHITE, outline: INK, align: "center" }));
        black(1 - f / 8);
      });
      f++;
    }
  }
  // 3. GO: a fly-by on the start straight, low beside the road; the pack comes at the camera and
  //    past it, the camera swinging round to watch it go. (The music comes in.)
  {
    cue.go = trailer.frames;
    cue.beeps.push(trailer.frames);
    const t = opening, si = t.startIndex, at = along(si, 30), [x, y] = beside(at, 7.5);
    await film("a_launch", bars(2), () => {
      const p = race().player, lead0 = race().standings[0];
      stand(x, y, 0.9 + (t.elev[at] ?? 0), [p.x * 0.5 + lead0.x * 0.5, p.y * 0.5 + lead0.y * 0.5], 250, 82, 9);
    }, { dress: (f) => {
      faded(1 - f / 12, () => text("GO!", W / 2, 70, { scale: 5, color: GO_GREEN, outline: INK, align: "center" }));
      caption("DREAM VALLEY", f, 20, 66);
    } });
  }
  /** Off the jump at ``lip``, from beside where karts land, looking back at it: the player hops right
   * at the lip (a trick: it spins in the air), slowed ``slow`` times while it is in the air. */
  const trickJump = async (name: string, lip: number, n: number, slow: number, dress?: (f: number, n: number) => void,
                           hero = true, from = 27, off = 5.5, h = 1.0) => {
    await until(() => race().phase === "racing" && ahead(race().player, lip) / Math.max(race().player.v, 10) < 0.9 &&
                      ahead(race().player, lip) < 60, 60 * 60);
    const [x, y] = beside(along(lip, from), off), z = race().track.elev[lip] ?? 0;
    let hopped = false;
    await film(name, n, () => {
      const k = race().player;
      stand(x, y, h + z, [k.x, k.y], 250, 88, 10);
    }, {
      hero, dress,
      slow: () => (race().player.air ? slow : 1),
      extra: () => {
        const k = race().player;
        if (!hopped && k.rampU > 0.9) {
          hopped = true;
          return ["hop"];
        }
        return [];
      },
    });
  };
  // 4. A trick: off the jump, a hop right at the lip, the kart spinning through the air in slow
  //    motion as it flies at the camera.
  {
    const p = race().player;
    const ramp = race().features.ramps.map((q) => q.start).sort((a, b) => ahead(p, a) - ahead(p, b))[0];
    if (ramp !== undefined) {
      await trickJump("a_jump", along(ramp, 11), bars(2), 3, (f) => banner("TRICKS", f, 14, bars(2) - 16));
    }
  }
  // 5. Under the bridge: on the road that passes under the deck, beyond it, the pack coming
  //    through underneath.
  {
    const b = opening.bridges[0];
    if (b) {
      const under = b.lower;
      await until(() => { const d = ahead(race().player, under); return d > 18 && d < 32; }, 60 * 60);
      const [x, y] = beside(along(under, 22), 7.5);
      await film("a_under", bars(1), () => {
        const k = race().player;
        stand(x, y, 1.5, [k.x, k.y], 250, 96, 6);
      });
    }
  }

  // ================================================================ the Harbor Tunnel
  // 6. Round the tube: over a wing pad (its walls are for winged karts), and on the gas (and a
  //    boost), the player turns up the wall, holds a line slanting round over the roof and down the
  //    other wall, and straightens out on the floor; the chase camera rolls round with it.
  await start(o.figure8, THEME.tunnel, 7);
  {
    const pad = () => {
      const k = race().player, wing = race().features.pads.filter((q) => q.wing);
      return wing.sort((a, b) => ahead(k, a.start) - ahead(k, b.start))[0];
    };
    const near = () => {
      const k = race().player, q = pad();
      return race().phase === "racing" && !!q && k.wings <= 0 && k.v > 20 && !k.air && ahead(k, q.start) / Math.max(k.v, 10) < 1.2;
    };
    await until(near, 60 * 60);
    let over = false, last = race().player.offset;
    const to = pad(), t = race().track, n = bars(3);
    begin("n_loop");
    for (let f = 0; f < n; f++) {
      const k = race().player;
      let press: string[];
      if (k.wings <= 0 && to) { // (on to the pad: aimed at its middle, a little way along it)
        const i = t.wrap(to.start + 5), [tx, ty] = t.tangent(i);
        const gx = t.xs[i] - ty * to.offset, gy = t.ys[i] + tx * to.offset;
        const aimAt = wrapAngle(Math.atan2(gy - k.y, gx - k.x) - k.heading);
        press = aimAt > 0.04 ? ["left"] : aimAt < -0.04 ? ["right"] : [];
      } else {
        k.boostTime = Math.max(k.boostTime, 0.5);
        const rel = wrapAngle(k.heading - heading(k.idx));
        if (Math.sign(k.offset) !== Math.sign(last) && Math.abs(k.offset) > 15) over = true;
        const back = over && Math.abs(k.offset) < 12; // (straightening from low on the far wall, to land on the floor straight)
        const want = back ? 0 : 0.85;
        press = rel < want - 0.06 ? ["left"] : rel > want + 0.06 ? ["right"] : [];
      }
      last = k.offset;
      dc.step(per, ["gas", ...press], false);
      dc.shot({ clear: 2.5 });
      await save("n_loop", () => {
        caption("HARBOR TUNNEL", f);
        banner("WING PADS", f, 30, 80);
      });
    }
  }
  // 7. Through the traffic: on the game's chase camera, a car close ahead, overtaken.
  {
    await start(o.loops[4], THEME.tunnel, 7);
    const cars = () => race().obstacles.list.filter((q) => {
      const d = (q.s - race().track.s[race().player.idx] + race().track.length) % race().track.length;
      return q.kind === "traffic" && d > 14 && d < 26;
    });
    await until(() => race().phase === "racing" && race().player.dist > 120 && cars().length > 0, 60 * 120);
    await film("n_traffic", bars(2), () => dc.shot({ clear: 2.5 }));
  }

  // ================================================================ Sunset Mesa
  // 8. Down a red-rock canyon: alongside the player between its walls.
  {
    await start(o.loops[1], THEME.mesa, 7);
    const banks = (race() as unknown as { features: { banks: { s0: number; len: number }[] } }).features.banks;
    const inCanyon = () => {
      const s0 = race().track.s[race().player.idx];
      return banks.some((b) => s0 > b.s0 + 6 && s0 < b.s0 + b.len - 20);
    };
    if (banks.length) {
      await until(() => race().phase === "racing" && inCanyon(), 60 * 120);
      await film("t_canyon", bars(1), (f, n) => track(race().player, 1, 5.5 + 1.5 * (f / n), 2.2), {
        dress: (f) => caption("SUNSET MESA", f, 4, 42),
      });
    }
  }
  // 9. A boomerang: the arrow locked on the rival up the road, the throw, and the hit, filmed from
  //    in front of the rival as it comes round, spins it, and goes home.
  {
    await ready(o.loops[1], THEME.mesa, 60);
    const inSights = () => rivals().filter((k) => {
      const s = seen(k);
      return s.d > 9 && s.d < 22 && Math.abs(s.off) < 0.4;
    }).sort((a, b) => seen(a).d - seen(b).d)[0];
    await until(() => !!inSights(), 60 * 40);
    const target = inSights();
    dc.give("boomerang");
    let locked = -1;
    await film("i_boomerang", bars(2), () => (target ? track(target, 1, 9, 2.4) : dc.shot({ clear: 2.5 })), {
      extra: (f) => {
        if (!target || f < frames(0.3)) return [];
        if (locked < 0) {
          // steer the sweep onto the rival, then press: the arrow locks there
          const off = Math.max(-AIM_MAX * 0.98, Math.min(AIM_MAX * 0.98, seen(target).off));
          race().aimPhase = Math.asin(off / AIM_MAX) - AIM_RATE / 60;
          locked = f;
          return ["item"];
        }
        return f === locked + 3 ? ["item"] : []; // let go, and press again: it flies along the arrow
      },
      dress: (f) => { banner("22 ITEMS", f, 4, 60); label("BOOMERANG", f, 10); },
    });
  }
  // 10. Into the quicksand, and out under the rescue drone.
  await rescue("m_sand", "quicksand", bars(2), (f) => banner("RESCUE DRONE", f, 18, 66));

  // ================================================================ Coral Reef
  // 11. Alongside the pack over a ridge of coral: bubble helmets, rays of light, schools of fish.
  await start(o.loops[3], THEME.reef, 7);
  await until(() => race().phase === "racing" && climb(race().player)?.style === "coral" && race().player.elev > 0.8 &&
                    race().player.slope > 0, 60 * 150);
  dc.give("triple"); // three turbo cells circling the kart
  await film("w_reef", bars(2), (f, n) => track(race().player, -1, 6 + 1.5 * (f / n), 1.9), {
    dress: (f) => caption("CORAL REEF", f),
  });
  // 12. A shock: filmed from in front of the pack, looking back at it: the white flash, and
  //     everyone else spun, shrunk and slowed.
  {
    await ready(o.loops[3], THEME.reef, 30);
    const close = () => rivals().filter((k) => { const d = k.dist - race().player.dist; return d > 4 && d < 26; });
    await until(() => close().length >= 3, 60 * 30);
    const ahead0 = close().sort((a, b) => b.dist - a.dist)[0];
    dc.give("shock");
    const at = frames(0.5);
    await film("i_shock", bars(2), (f) => {
      lead(ahead0 ?? race().player, 9, -1.5, 2.6, [race().player.x, race().player.y]);
      const t = (f - at) / fps; // the game's own flash: white, gone in a fifth of a second
      if (t >= 0 && t < 0.22) g.scr.dimRect(0, 0, W, H, WHITE, Math.min(0.85, (0.22 - t) * 4));
      g.scr.present();
    }, { extra: (f) => (f === at ? ["item"] : []), dress: (f) => label("SHOCK", f, 6) });
  }
  // 13. A drift: low beside the kart, sideways through a bend, the sparks charging a mini-turbo.
  {
    await until(() => race().player.drifting && race().player.boostLevel >= 1, 60 * 60);
    const k = race().player, side = k.driftDir || 1;
    await film("w_drift", bars(1), () => track(race().player, -side, 5, 1.0), { dress: (f) => label("DRIFT", f, 4, 36) });
  }

  // ================================================================ Tokyo Nights
  await start(o.loops[9], THEME.tokyo, 7);
  // 14. Up on the expressway: alongside the pack on the deck, the city's lit towers behind.
  // (high up: lower down, the shot opened on the side of the deck's ramp)
  await until(() => race().phase === "racing" && climb(race().player)?.style === "expressway" && race().player.elev > 4.5 &&
                    race().player.slope >= 0, 60 * 150);
  await film("e_express", bars(2), (f, n) => track(race().player, 1, 11 + 3 * (f / n), 3.6 + 1.2 * (f / n)), {
    dress: (f) => caption("TOKYO NIGHTS", f),
  });
  // 15. The police on the player's tail: filmed from ahead, looking back down the street.
  {
    const cop = () => race().obstacles.list.find((q) => q.kind === "police" && (q.state === POLICE_CHASE || q.state === POLICE_LUNGE));
    const tail = () => {
      const c = cop();
      if (!c) return -1;
      const t = race().track;
      return (t.s[race().player.idx] - c.s + t.length) % t.length;
    };
    await until(() => { const d = tail(); return d > 5 && d < 13; }, 60 * 240);
    if (cop()) {
      await film("e_police", bars(1), () => {
        const k = race().player, hd = steady(k), c = Math.cos(hd), sn = Math.sin(hd);
        dc.shot({ x: k.x + c * 9, y: k.y + sn * 9, heading: hd + Math.PI, height: 2.3 + k.ground, focal: 250, fx: 0, clear: 2 });
      });
    }
  }
  // 16. An overtake: a turbo, and the player pulls out from behind the rival in front and past it,
  //     filmed from up the road, the pair coming at the camera.
  {
    await until(() => race().phase === "racing" && !!inFront(4, 10, 2.5) && race().player.v > 18, 60 * 60);
    const rival = inFront(4, 10, 2.5);
    if (rival) {
      dc.give("turbo");
      await film("t_pass", bars(2), () => {
        const p = race().player;
        lead(rival, 11, 2.2, 1.3, [(p.x + rival.x) / 2, (p.y + rival.y) / 2]);
      }, { extra: (f) => (f === frames(0.35) ? ["item"] : []), dress: (f) => label("TURBO", f, 8) });
    }
  }

  // ================================================================ Construction Zone
  await start(o.loops[7], THEME.construction, 7);
  // 17. High on a crane's girder: alongside the pack on the steel deck, the city going up behind.
  // (high up: lower down, the shot opened on the girder's lattice)
  await until(() => race().phase === "racing" && climb(race().player)?.style === "girder" && race().player.elev > 4 &&
                    race().player.slope > 0, 60 * 150);
  await film("k_girder", bars(2), (f, n) => track(race().player, 1, 13 + 4 * (f / n), 4.6 + 1.6 * (f / n)), {
    dress: (f) => caption("CONSTRUCTION ZONE", f),
  });
  // 18. The wrecking ball, swinging across the road under its crane's jib.
  {
    const ball = () => race().obstacles.list.find((q) => {
      if (q.kind !== "wrecker") return false;
      const t = race().track, d = (q.s - t.s[race().player.idx] + t.length) % t.length;
      return d > 26 && d < 36;
    });
    await until(() => !!ball(), 60 * 200);
    if (ball()) await film("k_wreck", bars(1), () => behind(race().player, 7.5, 4.2));
  }
  // 19. A bomb: lobbed at the kart in front, filmed from beside it as it lands and the blast
  //     catches everyone near.
  {
    await ready(o.loops[7], THEME.construction, 50);
    const next = () => race().karts.find((k) => k.place === race().player.place - 1);
    const gap = () => { const a = next(); return a ? a.dist - race().player.dist : -1; };
    await until(() => race().player.place > 1 && gap() > 8 && gap() < 18, 60 * 40);
    const target = next();
    dc.give("bomb");
    await film("i_bomb", bars(2), () => (target ? track(target, -1, 10, 3.2) : dc.shot({ clear: 2.5 })), {
      extra: (f) => (f === frames(0.2) || f === frames(0.6) ? ["item"] : []), dress: (f) => label("BOMB", f, 8),
    });
  }

  // ================================================================ Moon Base
  await start(o.loops[8], THEME.moon, 7);
  // 20. A jump in the low gravity, the Earth in the black sky behind it: the camera set where the
  //     Earth is behind the flight, the flight (and a trick) in slow motion.
  {
    const at = dc.game.sky?.earthAt ?? -1;
    const toEarth = at >= 0 ? -((at - FRAME_W / 2) * Math.PI * 2) / PAN : 0;
    const ex = Math.cos(toEarth), ey = Math.sin(toEarth);
    const t = race().track, p = race().player;
    const ramp = race().features.ramps.map((q) => q.start).filter((i) => ahead(p, i) > 150)
      .sort((a, b) => ahead(p, a) - ahead(p, b))[0];
    if (ramp !== undefined) {
      const lip = along(ramp, 11), [tx, ty] = t.tangent(lip), across = tx * ey - ty * ex, toward = tx * ex + ty * ey;
      const ground = t.elev[lip] ?? 0;
      let x: number, y: number, side = false;
      if (Math.abs(across) > 0.55) {
        const [mx, my] = beside(along(lip, 20), 0);
        [x, y] = [mx - ex * 14, my - ey * 14];
        side = true;
      } else if (toward < 0) [x, y] = beside(along(lip, 34), 4);
      else [x, y] = beside(along(lip, -16), 3);
      await until(() => race().phase === "racing" && ahead(race().player, lip) / Math.max(race().player.v, 10) < 0.55 &&
                        ahead(race().player, lip) < 40, 60 * 120);
      let hopped = false;
      await film("l_jump", bars(2), () => {
        const k = race().player;
        if (side) dc.shot({ x, y, heading: toEarth, height: ground + 1.4, focal: 250, fx: 0, clear: 8, horizon: 100 });
        else stand(x, y, ground + 1.3, [k.x, k.y], 250, 100, 6);
      }, {
        slow: () => (race().player.air ? 2 : 1),
        extra: () => {
          if (!hopped && race().player.rampU > 0.9) {
            hopped = true;
            return ["hop"];
          }
          return [];
        },
        dress: (f) => caption("MOON BASE", f),
      });
    }
  }
  // 21. A rocket: the kart flies itself up the road, past the pack, filmed alongside.
  {
    await ready(o.loops[8], THEME.moon, 30);
    dc.give("rocket");
    await film("i_rocket", bars(1), () => track(race().player, 1, 9, 2.0), {
      extra: (f) => (f === 1 ? ["item"] : []), dress: (f) => label("ROCKET", f, 4, 36),
    });
  }
  // 22. Off the road into a chasm, and out again under the rescue drone.
  await rescue("l_chasm", "chasm", bars(2));

  // ================================================================ Volcano Core
  await start(o.loops[6], THEME.volcano, 7);
  // 23. A geyser blowing a column of lava and fire across the road as the player comes up to it.
  {
    const vent = () => race().obstacles.list.find((q) => {
      if (q.kind !== "geyser" || q.state !== GEYSER_QUIET || q.t < q.wait - 0.5) return false;
      const t = race().track, d = (q.s - t.s[race().player.idx] + t.length) % t.length;
      return d > 26 && d < 50;
    });
    await until(() => race().phase === "racing" && !!vent(), 60 * 200);
    if (vent()) {
      await film("x_geyser", bars(1), () => behind(race().player, 7.5, 3.6), { dress: (f) => caption("VOLCANO CORE", f, 2, 44) });
    }
  }
  // 24. A comet: fired from the back, it flies up the road to the leader, hangs over them, and
  //     comes down; filmed beside the leader as it arrives.
  {
    await ready(o.loops[6], THEME.volcano, 120);
    await until(() => race().player.place >= 4, 60 * 40);
    dc.give("comet");
    advance(per, ["item"]);
    const comet = () => race().items.comets[0];
    await until(() => !comet() || comet().phase !== "fly" ||
                      Math.hypot(comet().x - race().standings[0].x, comet().y - race().standings[0].y) < 60, 60 * 20);
    await film("i_comet", bars(2), () => {
      const leader = comet()?.target ?? race().standings[0];
      track(leader, -1, 9, 3.4);
    }, { dress: (f) => label("COMET", f, 4) });
  }
  // 25. Into the lava: the player steers off the rock bank (off the camera) and in; the view goes
  //     dark red, and the rescue drone lowers the kart back onto the road and lets it go.
  {
    await start(o.loops[6], THEME.volcano, 7);
    const t = race().track;
    const fwd = (m: number) => t.wrap(race().player.idx + Math.round(m / 0.6));
    const straight = () => [0, 15, 30, 45].every((m) => Math.abs(t.curvature(fwd(m))) < 1 / 160);
    const noRamp = () => race().features.ramps.every((q) => (t.s[q.start] - t.s[race().player.idx] + t.length) % t.length > 90);
    const flat = () => [0, 10, 20, 30, 40, 50].every((m) => t.elev[fwd(m)] < 0.05);
    const clear = () => [10, 14, 18, 22, 26, 30, 34, 38].every((m) => {
      const i = fwd(m), [tx, ty] = t.tangent(i);
      return [6, 8.5, 11].every((off) => {
        const x = t.xs[i] + ty * off, y = t.ys[i] - tx * off; // right of the road
        return !race().scenery.items.some((it) => it.art.solid && Math.hypot(it.x - x, it.y - y) < 3.2);
      });
    });
    await until(() => race().phase === "racing" && straight() && noRamp() && flat() && clear() && race().player.v > 18, 60 * 90);
    // (off the road onto the rock, off the camera)
    for (let guard = 0; Math.abs(race().player.offset) < HALF_WIDTH + 1.5 && guard < 120; guard++) dc.step(1, ["gas", "right"], false);
    begin("x_rescue");
    for (let f = 0, n = bars(2); f < n; f++) {
      const k = race().player;
      const steer = k.fall < 0 && Math.abs(k.offset) < 8 ? ["right"] : [];
      dc.step(per, k.fall < 0 ? ["gas", ...steer] : [], false);
      if (k.fall < FALL_SWAP) {
        const h = dc.game.cam.heading;
        dc.shot({ x: k.x - Math.cos(h) * 9, y: k.y - Math.sin(h) * 9, height: 4.1 + k.ground, clear: 2.5 });
      } else {
        const [tx, ty] = t.tangent(t.wrap(k.idx));
        const x = k.dropX + tx * 4 - ty * 9.5, y = k.dropY + ty * 4 + tx * 9.5;
        dc.shot({ x, y, heading: Math.atan2(k.dropY - y, k.dropX - x), height: 3.6 + k.dropZ, focal: 250, fx: 0, clear: 3 });
      }
      await save("x_rescue");
    }
  }

  // ================================================================ the garage, the Grand Prix
  // 26. Building a kart: a part on every half bar, on the snare.
  {
    dc.go("garage");
    const menu = g.garage.menu;
    const rows = [0, 4, 2, 0]; // a body, a paint job, a spoiler, a body (on the snare, beats two and four)
    const every = bars(0.5), n = bars(2);
    begin("g_garage");
    for (let f = 0; f < n; f++) {
      if (f % every === every / 2 && rows[f / every - 0.5] !== undefined) {
        const row = rows[f / every - 0.5];
        menu.index = row;
        menu.items[row].right?.();
      }
      g.time += 1 / fps;
      g.render();
      // (between the screen's name and its menu, the one clear strip on it)
      await save("g_garage", () => faded(swell(f, 4, n - 2, 10), () =>
        text("BUILD YOUR KART", 142, 4, { color: HOT, outline: INK, align: "center" })));
    }
  }
  // 27. The award ceremony: the top three on the podium, fireworks and confetti.
  {
    dc.cup(true, 1);
    for (let i = 0; i < Math.round(60 * 5.6); i++) g.ceremony?.update(1 / 60, g.sound);
    const n = bars(2);
    begin("p_podium");
    for (let f = 0; f < n; f++) {
      g.ceremony?.update(1 / fps, g.sound);
      g.time += 1 / fps;
      g.render();
      await save("p_podium");
    }
  }

  // ================================================================ the end: the name, in slow motion
  // 28. Off Dream Valley's jump once more, the pack in the air, eight times slower than life: the
  //     name over it, and where to play; then the whole picture breaks into ever bigger pixels
  //     until it is gone.
  {
    await start(o.opening, THEME.valley, 7);
    const p = race().player;
    const ramp = race().features.ramps.map((q) => q.start).sort((a, b) => ahead(p, a) - ahead(p, b))[0];
    cue.end = trailer.frames;
    const n = Math.round(fps * TITLE_BAR * 3);
    if (ramp !== undefined) {
      const lip = along(ramp, 11);
      await until(() => race().phase === "racing" && ahead(race().player, lip) / Math.max(race().player.v, 10) < 0.35 &&
                        ahead(race().player, lip) < 40, 60 * 60);
      const [x, y] = beside(along(lip, 30), 6.5), z = race().track.elev[lip] ?? 0;
      let hopped = false;
      await film("t_end", n, () => {
        const k = race().player;
        stand(x, y, 0.9 + z, [k.x, k.y], 250, 120, 3);
      }, {
        hero: false,
        slow: () => 8,
        extra: () => {
          if (!hopped && race().player.rampU > 0.9) {
            hopped = true;
            return ["hop"];
          }
          return [];
        },
        dress: (f) => {
          const shade = smooth(clamp01((f - 6) / 30));
          g.scr.dimRect(0, 0, W, H, SKY_TOP, 0.28 * shade); // (the picture sinks a little behind the name)
          faded(smooth(clamp01((f - 10) / 16)), () => {
            text("DREAM", W / 2, 22, { scale: 5, rows: LOGO_ROWS, outline: INK, shadow: hex("#2a0f4a"), align: "center" });
            text("CIRCUIT", W / 2, 66, { scale: 5, rows: LOGO_ROWS, outline: INK, shadow: hex("#2a0f4a"), align: "center" });
          });
          faded(smooth(clamp01((f - 30) / 14)), () =>
            text("THE KART RACER AN AI DREAMS AS YOU DRIVE", W / 2, 114, { color: WHITE, outline: INK, align: "center" }));
          faded(smooth(clamp01((f - 46) / 14)), () => {
            text("PLAY FREE IN YOUR BROWSER", W / 2, H - 34, { color: WHITE, outline: INK, align: "center" });
            text("nilaypilaydesai.github.io/dreamcircuit", W / 2, H - 21, { color: HOT, outline: INK, align: "center" });
          });
          // the last second and a half: the whole screen breaks up, as the classics' mosaic did,
          // into ever bigger blocks, and goes dark
          const u = clamp01((f - (n - 46)) / 40);
          if (u > 0) {
            mosaic(Math.max(1, Math.round(2 ** (u * 6.5))));
            black(smooth(clamp01((u - 0.45) / 0.55)));
          }
        },
      });
    }
    // and a moment of black
    begin("t_black", false);
    for (let f = 0; f < 10; f++) {
      g.scr.dimRect(0, 0, W, H, rgb(0, 0, 0), 1);
      g.scr.present();
      await save("t_black");
    }
  }

  const heroOut = await hero.finish();
  const trailerOut = await trailer.finish();
  await post("trailer.wav", await soundtrack(trailerOut.frames, fps, cue));
  await post("trailer_cues.json", new Blob([JSON.stringify({ fps, ...cue, frames: trailerOut.frames })], { type: "text/plain" }));
  dc.hold(false);
  return {
    ...counts, ...Object.fromEntries(Object.entries(heroOut).map(([k, v]) => [`hero:${k}`, v])),
    ...Object.fromEntries(Object.entries(trailerOut).map(([k, v]) => [`trailer:${k}`, v])),
  };
}

/** The trailer's music, rendered from the game's own sequencer and songs: the title song under the
 * opening (dying away as the countdown starts), the countdown's beeps and GO's, Dream Valley's
 * song from GO, and the title song again under the end card, fading out with it. A WAV (16-bit,
 * stereo, 48 kHz). ``cue``: in frames of the trailer. */
async function soundtrack(total: number, fps: number, cue: { go: number; end: number; beeps: number[] }): Promise<Blob> {
  const rate = 48000, seconds = total / fps + 0.5;
  const ac = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const master = ac.createGain();
  master.gain.value = 0.5; // (the game's master level)
  master.connect(ac.destination);
  type Seq = { setup(ac: BaseAudioContext): void; playStep(ac: BaseAudioContext, song: unknown, step: number, t: number, dur: number): void; out: GainNode };
  /** Play ``name`` from ``t0`` to ``t1`` s at ``level``, fading in over ``fadeIn`` s and out to
   * silence by ``t1``. */
  const play = (name: keyof typeof SONGS, t0: number, t1: number, fadeIn: number, fadeOut: number, level = 1) => {
    const bus = ac.createGain();
    bus.connect(master);
    const m = new Music(() => ac as unknown as AudioContext, () => bus) as unknown as Seq;
    m.setup(ac);
    const song = SONGS[name], six = 60 / song.bpm / 4;
    for (let step = 0, t = t0; t < t1; step++, t += six) m.playStep(ac, song, step % (song.chords.length * 16), t, six);
    bus.gain.setValueAtTime(fadeIn > 0 ? 0.0001 : level, t0);
    if (fadeIn > 0) bus.gain.exponentialRampToValueAtTime(level, t0 + fadeIn);
    bus.gain.setValueAtTime(level, Math.max(t0 + fadeIn, t1 - fadeOut));
    bus.gain.linearRampToValueAtTime(0, t1);
  };
  const go = cue.go / fps, end = cue.end / fps;
  const firstBeep = (cue.beeps[0] ?? cue.go) / fps;
  play("title", 0, firstBeep + 0.6, 0.4, 1.2, 1.4); // (its pads are quiet against Dream Valley's drums)
  play("valley", go, end + 0.25, 0, 0.25);
  play("title", end, seconds, 0.3, 1.6, 1.4);
  // the countdown (core/audio.ts: count() and go())
  const tone = (f: number, dur: number, vol: number, at: number) => {
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(f, at);
    gain.gain.setValueAtTime(vol, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  };
  for (const b of cue.beeps) {
    if (b === cue.go) tone(880, 0.6, 0.16, b / fps);
    else tone(440, 0.22, 0.14, b / fps);
  }
  const buf = await ac.startRendering();
  // (mixed for the game, the music sat under the engine and the effects, peaking at a quarter of
  // full scale: on its own, brought up to just under it)
  let peak = 1e-6;
  for (let c = 0; c < 2; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const gain = 0.9 / peak;
  const n = buf.length, data = new DataView(new ArrayBuffer(44 + n * 4));
  const word = (o: number, s: string) => { for (let i = 0; i < 4; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  word(0, "RIFF"); data.setUint32(4, 36 + n * 4, true); word(8, "WAVE"); word(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 2, true); data.setUint32(24, rate, true);
  data.setUint32(28, rate * 4, true); data.setUint16(32, 4, true); data.setUint16(34, 16, true); word(36, "data");
  data.setUint32(40, n * 4, true);
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    data.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i] * gain)) * 32767, true);
    data.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i] * gain)) * 32767, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}
