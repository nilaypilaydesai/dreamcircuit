// The DATA page's hero video (and the stills and GIF frames for the README), filmed in the game
// itself: a trailer that cuts between the five worlds, the items, the garage and the Grand Prix
// podium. It drives races through the dev hook (window.__dc) on circuits the designer dreamed and
// films clean, HUD-free shots from scripted cameras: a drone over the grid at the launch, the
// chase camera through a jump, an orbit around a bridge, tracking shots, cranes, and close-ups of
// items in use; the garage and the podium are filmed as the game draws them. Every 384x216 frame
// is upscaled with nearest-neighbour sampling (the pixel art stays crisp) and encoded as it is
// filmed, with WebCodecs, into H.264 MP4s, one per output size. Shots cross-fade, and the last
// fades back into the first, so the video loops without a seam; the poster is its first frame.
// Files go to a local capture server (scripts/capture_frames.py), which writes them to disk.
//
// In the browser console on the dev server (http://localhost:5173/):
//   const { film } = await import("/src/tools/cinema.ts"); await film({ figure8, loops })

import { Encoder } from "./mp4";

interface Kart {
  x: number; y: number; heading: number; elev: number; ground: number; air: boolean; idx: number; v: number;
  place: number; dist: number; isPlayer: boolean; finished: boolean; drifting: boolean; boostLevel: number;
}
interface Track {
  xs: number[]; ys: number[]; s: number[]; elev: number[]; count: number; length: number; startIndex: number;
  bridges: { center: number; lower: number }[]; hills: { s0: number; len: number; h: number }[];
  tangent(i: number): [number, number];
}
interface Race {
  track: Track; player: Kart; standings: Kart[]; karts: Kart[]; phase: string; countdown: number;
  features: { ramps: { start: number }[]; tunnels: { s0: number }[] };
  items: { blasts: unknown[] };
  aimPhase: number; // the player's aiming arrow (where it is in its sweep)
}
interface Game {
  race: Race | null;
  time: number;
  garage: { menu: { index: number; items: { right?: () => void }[] } };
  ceremony: { update(dt: number, sound: unknown): void } | null;
  sound: unknown;
  render(): void;
}
interface Dc {
  step(n: number, keys?: string[], draw?: boolean): void;
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
  figure8: number[]; // a figure-eight (game meters) with a bridge and a jump: the launch, the jump, the bridge
  loops: number[][]; // six plain loops: three for the items (Sunset Mesa), the reef, the mountains, the valley
  fps?: number;
  fade?: number; // frames of cross-fade between shots
  variants?: Variant[];
  every?: number; // also save every nth frame at game resolution (the README's GIF and stills)
}

export const VARIANTS: Variant[] = [
  { name: "hero", w: 1920, h: 1080, bitrate: 3_600_000 },
  { name: "hero-648", w: 1152, h: 648, bitrate: 1_700_000 }, // exactly 3x: small screens
];

// the aiming arrow's sweep (race/items.ts)
const AIM_MAX = 0.75, AIM_RATE = 3.1;
const THEME = { valley: 0, neon: 1, mesa: 2, reef: 3, mountain: 4 };

const tick = () => new Promise<void>((r) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => r();
  ch.port2.postMessage(0);
});
const smooth = (u: number) => u * u * (3 - 2 * u);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The film as it is shot: cross-fades between shots, every frame upscaled and encoded at once
 * (nothing but a cross-fade's worth of frames is held in memory), and the loop closed at the end. */
class Reel {
  readonly counts: Record<string, number> = {};
  readonly shots: { name: string; start: number }[] = []; // the first clean frame of each shot
  private readonly low: OffscreenCanvas;
  private readonly lg: OffscreenCanvasRenderingContext2D;
  private head: ImageBitmap[] = []; // the first shot's opening frames: the loop fades into them
  private tail: ImageBitmap[] = []; // the previous shot's closing frames, fading into this shot
  // A shot's frames are held back by `fade` frames, so whenever the shot ends, its last `fade`
  // frames are still unemitted and become the cross-fade into the next shot. Shots can then end
  // on an event (a landing, a blast) instead of a timer.
  private pending: ImageBitmap[] = [];
  private index = -1;
  private name = "";
  private k = 0;
  private emitted = 0;
  private poster: Blob | null = null;
  private readonly posts: Promise<unknown>[] = [];

  private constructor(private readonly canvas: HTMLCanvasElement, private readonly fps: number,
                      private readonly fade: number, private readonly every: number,
                      private readonly outs: { v: Variant; big: OffscreenCanvas; g: OffscreenCanvasRenderingContext2D; enc: Encoder }[],
                      private readonly post: (name: string, blob: Blob) => Promise<unknown>) {
    this.low = new OffscreenCanvas(canvas.width, canvas.height);
    this.lg = this.low.getContext("2d")!;
  }

  static async open(canvas: HTMLCanvasElement, fps: number, fade: number, every: number, variants: Variant[],
                    post: (name: string, blob: Blob) => Promise<unknown>): Promise<Reel> {
    const outs = [];
    for (const v of variants) {
      const big = new OffscreenCanvas(v.w, v.h);
      const g = big.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      outs.push({ v, big, g, enc: new Encoder(v.w, v.h, fps, await Encoder.pick(v.w, v.h, fps), v.bitrate) });
    }
    return new Reel(canvas, fps, fade, every, outs, post);
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
      this.posts.push(this.post(`f_${String(this.emitted).padStart(4, "0")}.png`, png));
    }
    this.emitted += 1;
  }

  begin(name: string): void {
    this.index += 1;
    this.name = name;
    this.k = 0;
    this.tail = this.pending;
    this.pending = [];
    this.shots.push({ name, start: this.emitted + (this.index === 0 ? 0 : this.fade) });
  }

  /** Film the frame on the game's canvas as the next frame of the current shot. */
  async save(): Promise<void> {
    this.counts[this.name] = (this.counts[this.name] ?? 0) + 1;
    const k = this.k++;
    const bmp = await createImageBitmap(this.canvas);
    if (k < this.fade) {
      if (this.index === 0) {
        this.head.push(bmp);
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

  /** Close the loop (the last shot fades back into the first), finish the files and send them. */
  async finish(): Promise<Record<string, number>> {
    for (let k = 0; k < this.fade; k++) {
      await this.emit(this.pending[k] ?? this.head[k], this.head[k], (k + 1) / (this.fade + 1));
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
    const manifest = { fps: this.fps, fade: this.fade, every: this.every, frames: this.emitted, shots: this.shots, counts: this.counts };
    await this.post("manifest.json", new Blob([JSON.stringify(manifest)], { type: "text/plain" }));
    return { ...sizes, frames: this.emitted };
  }
}

export async function film(o: FilmOptions): Promise<Record<string, number>> {
  const dc = (window as unknown as { __dc: Dc }).__dc;
  const url = o.url ?? "http://127.0.0.1:8765";
  const fps = o.fps ?? 30;
  const fade = o.fade ?? 12;
  const per = Math.round(60 / fps); // simulation steps per filmed frame
  const post = (name: string, blob: Blob) =>
    fetch(`${url}/save/${name}`, { method: "POST", body: blob, headers: { "Content-Type": "text/plain" } });
  dc.pin([384, 216]); // the film is composed for the classic 16:9 framebuffer, whatever the window
  dc.hold(true);
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const reel = await Reel.open(canvas, fps, fade, o.every ?? 0, o.variants ?? VARIANTS, post);
  const race = () => dc.game.race!;
  const frames = (seconds: number) => Math.round(fps * seconds);

  // the autopilot drives; at a start it waits, then hits the gas just before GO: a rocket start
  const keys = (extra: string[] = []) => {
    const r = race();
    if (r.phase !== "countdown") return ["auto", ...extra];
    return r.countdown <= 1.35 ? ["gas"] : [];
  };
  const advance = (steps: number, extra: string[] = []) => dc.step(steps, keys(extra), false);
  const until = async (done: () => boolean, limit: number) => {
    for (let guard = 0; !done() && guard < limit; guard++) {
      advance(1);
      if (guard % 200 === 0) await tick();
    }
  };
  const start = async (points: number[], theme: number, rivals: number, type = "classic") => {
    dc.race(points, theme, rivals, type);
    for (let i = 0; i < 4000 && !(dc.state().mode === "race" && race().phase === "countdown"); i++) await tick();
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
  // a kart's distance and bearing (off the player's heading) from the player
  const seen = (k: Kart) => {
    const p = race().player;
    const dx = k.x - p.x, dy = k.y - p.y;
    return { d: Math.hypot(dx, dy), off: wrapAngle(Math.atan2(dy, dx) - p.heading) };
  };
  const rivals = () => race().karts.filter((k) => !k.isPlayer && !k.finished);
  // shots that ride with a kart: the game's chase camera (raised a little), a tracking shot from
  // ahead and to the side, and a crane up and back from it
  const chase = (lift = 0) => dc.shot({ height: 2.9 + race().player.ground + lift, clear: 2.5 });
  const track = (k: Kart, side = 1, d = 6.5, h = 2.3) => {
    const c = Math.cos(k.heading), sn = Math.sin(k.heading);
    const x = k.x + c * d - sn * d * side, y = k.y + sn * d + c * d * side;
    dc.shot({ x, y, heading: Math.atan2(k.y - y, k.x - x), height: h + k.elev, focal: 250, fx: 0, clear: 3 });
  };
  const film = async (name: string, seconds: number, shoot: (f: number, n: number) => void, extra?: (f: number) => string[]) => {
    const n = frames(seconds);
    reel.begin(name);
    for (let f = 0; f < n; f++) {
      advance(per, extra?.(f) ?? []);
      shoot(f, n);
      await reel.save();
    }
  };

  // ---------------------------------------------------------------- Neon Night: a figure-eight
  await start(o.figure8, THEME.neon, 7);
  // 1. The launch: a drone ahead of the grid, drifting back and up as the pack rockets off.
  {
    await until(() => race().countdown <= 2.15, 600);
    const t = race().track, si = t.startIndex;
    const h = heading(si);
    await film("a_launch", 4.2, (f, n) => {
      const u = smooth(f / n), d = 30 + 26 * u;
      dc.shot({ x: t.xs[si] + Math.cos(h) * d, y: t.ys[si] + Math.sin(h) * d, heading: h + Math.PI,
                height: 3.2 + 4.5 * u, focal: 250, fx: 0, clear: 6 });
    });
  }
  // 2. The game's chase camera through the first jump: up the ramp, a trick in the air, and the
  // boost on landing.
  {
    const r = race(), p = r.player;
    const ramp = r.features.ramps.map((q) => q.start).sort((a, b) => ahead(p, a) - ahead(p, b))[0];
    if (ramp !== undefined) {
      const lip = ramp + 18; // 11 m of ramp at 0.6 m per point
      // timed by speed, not distance: 1.7 s of run-up, then the flight and the landing boost
      const eta = (k: Kart) => ahead(k, lip) / Math.max(Math.abs(k.v), 10);
      await until(() => eta(race().player) < 1.7, 60 * 120);
      reel.begin("b_jump");
      let flew = false, landed = -1;
      for (let f = 0; f < frames(7); f++) {
        advance(per);
        dc.shot({ clear: 2.5 });
        await reel.save();
        const k = race().player;
        if (k.air) flew = true;
        else if (flew && landed < 0) landed = f;
        if (landed >= 0 && f - landed >= frames(1.2) + fade) break;
      }
    }
  }
  // 3. An orbit around the bridge as the pack crosses over and under it.
  if (race().track.bridges.length) {
    const t = race().track, b = t.bridges[0];
    const cx = t.xs[b.center], cy = t.ys[b.center];
    await until(() => race().standings.some((k) => Math.min(ahead(k, b.center), ahead(k, b.lower)) < 70), 60 * 200);
    const a0 = heading(b.center) + Math.PI * 0.62;
    await film("c_bridge", 4.4, (f) => {
      const a = a0 + (f / fps) * 0.28, r = 44;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      dc.shot({ x, y, heading: Math.atan2(cy - y, cx - x), height: 10.5, focal: 255, fx: 0, clear: 14 });
    });
  }

  // 4. A prism, back on the grid: rainbow and invincible, barging through the karts ahead.
  await start(o.figure8, THEME.neon, 7);
  await until(() => race().phase === "racing" && race().player.dist > 30, 60 * 20);
  dc.give("prism");
  await film("i_prism", 3.0, () => track(race().player, 1, 6.5, 2.4), (f) => (f === 1 ? ["item"] : []));

  // ---------------------------------------------------------------- the garage
  // 5. Building a kart: bodies, wheels, a spoiler, an exhaust and a paint job, on the turntable.
  {
    dc.go("garage");
    const g = dc.game, menu = g.garage.menu;
    const rows = [0, 0, 0, 1, 2, 2, 3, 4, 4]; // body x3, wheels, spoiler x2, exhaust, paint x2
    const every = frames(0.5);
    const n = frames(0.6) + rows.length * every;
    reel.begin("g_garage");
    for (let f = 0; f < n; f++) {
      const m = f - frames(0.6);
      if (m >= 0 && m % every === 0) {
        const row = rows[m / every];
        menu.index = row;
        menu.items[row].right?.();
      }
      g.time += 1 / fps;
      g.render();
      await reel.save();
    }
  }

  // ---------------------------------------------------------------- Sunset Mesa: the items
  // Each item is filmed in a fresh race, a little after the start, while the pack is close.
  const ready = async (points: number[], theme: number, meters: number) => {
    await start(points, theme, 7);
    await until(() => race().phase === "racing" && race().player.dist > meters, 60 * 30);
  };
  // 6. A rocket from mid-pack (it burns out once it has passed two karts): the kart flies itself
  // up the road, scattering whoever is in the way.
  await ready(o.loops[0], THEME.mesa, 18);
  dc.give("rocket");
  await film("i_rocket", 3.2, () => dc.shot({ clear: 2.5 }), (f) => (f === 1 ? ["item"] : []));
  // 7. A boomerang: the arrow sweeps, locks onto the rival straight up the road, and the
  // boomerang goes out, spins it, and comes home.
  {
    await ready(o.loops[1], THEME.mesa, 60);
    const inSights = () => rivals().filter((k) => {
      const s = seen(k);
      return s.d > 9 && s.d < 24 && Math.abs(s.off) < 0.4;
    }).sort((a, b) => seen(a).d - seen(b).d)[0];
    await until(() => !!inSights(), 60 * 40);
    const target = inSights();
    dc.give("boomerang");
    let thrown = false;
    await film("i_boomerang", 3.2, () => chase(0.9), (f) => {
      if (thrown || f < frames(0.5) || !target) return [];
      // aim the sweep at the rival, then press: the arrow locks and the boomerang flies along it
      const off = Math.max(-AIM_MAX * 0.98, Math.min(AIM_MAX * 0.98, seen(target).off));
      race().aimPhase = Math.asin(off / AIM_MAX) - AIM_RATE / 60;
      thrown = true;
      return ["item"];
    });
  }
  // 8. A bomb: lobbed at the racer one place ahead, it chases them down and goes off.
  {
    await ready(o.loops[2], THEME.mesa, 50);
    const next = () => race().karts.find((k) => k.place === race().player.place - 1);
    const gap = () => { const a = next(); return a ? a.dist - race().player.dist : -1; };
    await until(() => race().player.place > 1 && gap() > 8 && gap() < 20, 60 * 40);
    dc.give("bomb");
    const blasts = race().items.blasts.length;
    let blown = -1;
    reel.begin("i_bomb");
    for (let f = 0; f < frames(5.5); f++) {
      // hold the button for a moment (the bomb rides behind the kart), then let go: it flies
      advance(per, f >= frames(0.3) && f < frames(0.6) ? ["item"] : []);
      chase(1.2);
      await reel.save();
      if (blown < 0 && race().items.blasts.length > blasts) blown = f;
      if (blown >= 0 && f - blown >= frames(1.0) + fade) break;
    }
  }

  // ---------------------------------------------------------------- Coral Reef
  // 9. A shock under the sea: a white flash, and everyone else spins, shrinks and slows.
  {
    await ready(o.loops[3], THEME.reef, 30);
    const close = () => rivals().filter((k) => { const d = k.dist - race().player.dist; return d > 4 && d < 28; }).length;
    await until(() => close() >= 3, 60 * 30);
    dc.give("shock");
    const at = frames(0.6), screen = canvas.getContext("2d")!;
    await film("i_shock", 2.8, (f) => {
      chase(1.2);
      const t = (f - at) / fps; // the game's own flash: white, gone in a fifth of a second
      if (t >= 0 && t < 0.22) {
        screen.fillStyle = `rgba(255, 255, 255, ${Math.min(0.85, (0.22 - t) * 4)})`;
        screen.fillRect(0, 0, canvas.width, canvas.height);
      }
    }, (f) => (f === at ? ["item"] : []));
  }
  // 10. Alongside the pack: bubble helmets, rays of light, schools of fish.
  await ready(o.loops[3], THEME.reef, 120);
  dc.give("triple"); // three turbo cells circling the kart
  await film("w_reef", 3.6, (f, n) => track(race().player, -1, 6 + 1.5 * (f / n), 1.9));

  // ---------------------------------------------------------------- Mountain Pass
  await start(o.loops[4], THEME.mountain, 6);
  {
    const t = race().track, tunnels = race().features.tunnels;
    // 11. Into a tunnel through the rock, on the game's chase camera.
    if (tunnels.length) {
      const before = (s: number) => tunnels.some((tn) => tn.s0 - s > 22 && tn.s0 - s < 30);
      await until(() => race().phase === "racing" && before(t.s[race().player.idx]), 60 * 90);
      await film("m_tunnel", 3.2, () => dc.shot({ clear: 2.5 }));
    }
    // 12. A crane over a climb, the snowy ridges behind.
    const climbing = () => race().player.elev > 1.2;
    await until(() => climbing(), 60 * 60);
    await film("m_hill", 3.2, (f, n) => {
      const k = race().player, e = smooth(f / n);
      const back = 9 + 12 * e;
      dc.shot({ x: k.x - Math.cos(k.heading) * back, y: k.y - Math.sin(k.heading) * back, heading: k.heading,
                height: 4 + k.elev + 7 * e, focal: 250, fx: 0, clear: 4 });
    });
  }

  // ---------------------------------------------------------------- Dream Valley: a roller coaster
  await start(o.loops[5], THEME.valley, 7, "coaster");
  // 13. A drift: sideways through a bend, the sparks charging a mini-turbo.
  await until(() => race().phase === "racing" && race().player.drifting && race().player.boostLevel >= 1, 60 * 60);
  await film("v_drift", 2.6, () => {
    const k = race().player;
    dc.shot({ x: k.x - Math.cos(k.heading) * 5.4, y: k.y - Math.sin(k.heading) * 5.4, heading: k.heading,
              height: 1.7 + k.ground, focal: 250, fx: 0, clear: 2 });
  });
  // 14. A crane up and back from the leader, the climbs and the circuit below.
  await film("e_crane", 4.0, (f, n) => {
    const k = race().standings[0];
    const e = smooth(Math.min(1, f / n));
    const back = 7 + 26 * e;
    dc.shot({ x: k.x - Math.cos(k.heading) * back, y: k.y - Math.sin(k.heading) * back,
              heading: k.heading, height: 3 + k.ground + 17 * e, focal: 250, fx: 0, clear: 5 + 10 * e });
  });

  // ---------------------------------------------------------------- the Grand Prix podium
  // 15. The award ceremony: the top three on the podium, fireworks and confetti. (It fades back
  // into the launch.)
  {
    dc.cup(true, 1);
    const g = dc.game;
    for (let i = 0; i < Math.round(60 * 5.6); i++) g.ceremony?.update(1 / 60, g.sound);
    const n = frames(4.4);
    reel.begin("p_podium");
    for (let f = 0; f < n; f++) {
      g.ceremony?.update(1 / fps, g.sound);
      g.time += 1 / fps;
      g.render();
      await reel.save();
    }
  }

  const out = await reel.finish();
  dc.hold(false);
  return { ...reel.counts, ...out };
}
