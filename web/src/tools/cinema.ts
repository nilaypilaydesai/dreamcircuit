// The DATA page's hero video (and the stills and GIF frames for the README), filmed in the game
// itself: a trailer that cuts between the eight worlds, the items, the garage and the Grand Prix
// podium. It drives races through the dev hook (window.__dc) on circuits the designer dreamed and
// films clean, HUD-free shots from scripted cameras: a drone over the grid inside the harbor
// tunnel, the chase camera through a jump and round the tube over its roof, traffic in the
// tunnel, tracking shots along Tokyo's expressway and a crane's girder, a police car on the player's
// tail, cows crossing the valley road, a wrecking ball, a meteor, a geyser, a kart floating off a
// crater's rim under the Earth, a red-rock canyon, close-ups of items in use, and a kart going
// into the volcano's lava and coming back out under the rescue drone; the garage and the podium
// are filmed as the game draws them.
// Every 384x216 frame is upscaled with nearest-neighbour sampling (the pixel art stays crisp) and
// encoded as it is filmed, with WebCodecs, into H.264 MP4s, one per output size. Shots cross-fade,
// and the last fades back into the first, so the video loops without a seam; the poster is its
// first frame. Files go to a local capture server (scripts/capture_frames.py), which writes them
// to disk.
//
// In the browser console on the dev server (http://localhost:5173/):
//   const { film } = await import("/src/tools/cinema.ts"); await film({ figure8, loops })

import { Encoder } from "./mp4";

interface Kart {
  x: number; y: number; heading: number; elev: number; ground: number; air: boolean; idx: number; v: number; boostTime: number;
  place: number; dist: number; isPlayer: boolean; finished: boolean; drifting: boolean; boostLevel: number;
  offset: number; fall: number; dropX: number; dropY: number; dropZ: number; // (the volcano's lava)
  slope: number; // how the road climbs under it
  staticT: number; // s left with a rival's static over its screen
}
interface Hill { s0: number; len: number; h: number; style?: string; side?: number }
interface Track {
  xs: number[]; ys: number[]; s: number[]; elev: number[]; count: number; length: number; startIndex: number;
  bridges: { center: number; lower: number }[]; hills: Hill[];
  tangent(i: number): [number, number];
  curvature(i: number): number;
  wrap(i: number): number;
}
interface Race {
  track: Track; player: Kart; standings: Kart[]; karts: Kart[]; phase: string; countdown: number;
  scenery: { items: { x: number; y: number; art: { solid: boolean } }[] };
  features: { ramps: { start: number }[]; tunnels: { s0: number }[] };
  items: { blasts: unknown[]; rowS: number[]; comets: { phase: string; x: number; y: number; z: number; target: Kart | null }[] };
  aimPhase: number; // the player's aiming arrow (where it is in its sweep)
  obstacles: { list: { kind: string; state: number; t: number; wait: number; s: number; offset: number; idx: number; x: number; y: number }[] };
}
interface Game {
  race: Race | null;
  time: number;
  cam: { heading: number };
  sky: { earthAt: number } | null;
  garage: { menu: { index: number; items: { right?: () => void }[] }; set(b: Record<string, string>): void };
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
  figure8: number[]; // a figure-eight (game meters) with a jump: the launch, the jump and the loop in the tube
  // ten plain loops: three for the items (Sunset Mesa, one with a canyon), the reef, the tunnel's
  // traffic, the valley, the volcano, the building site, the moon and Tokyo
  loops: number[][];
  fps?: number;
  fade?: number; // frames of cross-fade between shots
  variants?: Variant[];
  every?: number; // also save every nth frame at game resolution (the README's GIF and stills)
}

export const VARIANTS: Variant[] = [
  { name: "hero", w: 1920, h: 1080, bitrate: 3_000_000 },
  { name: "hero-648", w: 1152, h: 648, bitrate: 1_400_000 }, // exactly 3x: small screens
];

// the aiming arrow's sweep (race/items.ts)
const AIM_MAX = 0.75, AIM_RATE = 3.1;
const THEME = { valley: 0, tunnel: 1, mesa: 2, reef: 3, tokyo: 4, volcano: 5, construction: 6, moon: 7 };
const COW_WALK = 1, POLICE_CHASE = 1, POLICE_LUNGE = 4, GEYSER_QUIET = 0, METEOR_FALL = 0; // (race/obstacles.ts)
const FALL_SWAP = 0.72, FALL_RELEASE = 2.0; // into the lava: lifted out, let go (race/kart.ts)
const PAN = 1536, FRAME_W = 384; // the sky's panorama for a full turn, and the film's width (render/sky.ts)

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
  // every take starts from the same kart (the garage shot changes it, and the browser keeps it)
  dc.game.garage.set({ body: "classic", wheels: "standard", spoiler: "none", exhaust: "stock", paint: "sunset", accent: "cream" });
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const reel = await Reel.open(canvas, fps, fade, o.every ?? 0, o.variants ?? VARIANTS, post);
  const race = () => dc.game.race!;
  const frames = (seconds: number) => Math.round(fps * seconds);

  // the autopilot drives (and leaves the items to the script); at a start it waits, then hits the
  // gas just before GO: a rocket start
  const keys = (extra: string[] = []) => {
    const r = race();
    if (r.phase !== "countdown") return ["auto", "noitems", ...extra];
    return r.countdown <= 1.35 ? ["gas"] : [];
  };
  const advance = (steps: number, extra: string[] = []) => {
    dc.step(steps, keys(extra), false);
    // (the player is never filmed under a rival's static: it fills the screen, and the autopilot
    // would drive half blind)
    race().player.staticT = 0;
  };
  const until = async (done: () => boolean, limit: number) => {
    for (let guard = 0; !done() && guard < limit; guard++) {
      advance(1);
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
  // shots that ride with a kart: the game's chase camera (raised a little), a tracking shot from
  // ahead and to the side (side 1: the left), and a crane up and back from it
  const chase = (lift = 0) => dc.shot({ height: 2.9 + race().player.ground + lift, clear: 2.5 });
  const track = (k: Kart, side = 1, d = 6.5, h = 2.3) => {
    const c = Math.cos(k.heading), sn = Math.sin(k.heading);
    const x = k.x + c * d - sn * d * side, y = k.y + sn * d + c * d * side;
    dc.shot({ x, y, heading: Math.atan2(k.y - y, k.x - x), height: h + k.elev, focal: 250, fx: 0, clear: 3 });
  };
  const crane = (k: Kart, e: number, back = 26, up = 17) => {
    const b = 7 + back * e;
    dc.shot({ x: k.x - Math.cos(k.heading) * b, y: k.y - Math.sin(k.heading) * b,
              heading: k.heading, height: 3 + k.ground + up * e, focal: 250, fx: 0, clear: 5 + 10 * e });
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
  const ready = async (points: number[], theme: number, meters: number, field = 7) => {
    await start(points, theme, field);
    await until(() => race().phase === "racing" && race().player.dist > meters, 60 * 30);
  };

  // ---------------------------------------------------------------- the Harbor Tunnel: a figure-eight
  await start(o.figure8, THEME.tunnel, 7);
  // 1. The launch: a drone ahead of the grid, inside the tube, drifting back and up as the pack
  // rockets off.
  {
    await until(() => race().countdown <= 2.15, 600);
    const t = race().track, si = t.startIndex;
    const h = heading(si);
    await film("a_launch", 4.2, (f, n) => {
      const u = smooth(f / n), d = 30 + 26 * u;
      dc.shot({ x: t.xs[si] + Math.cos(h) * d, y: t.ys[si] + Math.sin(h) * d, heading: h + Math.PI,
                height: 3.0 + 2.2 * u, focal: 250, fx: 0, clear: 6 });
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
  // 3. Round the tube: on the gas (and a boost), the player turns up the wall, holds a line
  // slanting round over the roof and down the other wall, and straightens out on the floor;
  // the chase camera rolls round with it.
  {
    await until(() => race().player.v > 24 && !race().player.air, 60 * 20);
    let over = false, last = race().player.offset;
    reel.begin("n_loop");
    for (let f = 0; f < frames(5); f++) {
      const k = race().player;
      k.boostTime = Math.max(k.boostTime, 0.5);
      const rel = wrapAngle(k.heading - heading(k.idx));
      if (Math.sign(k.offset) !== Math.sign(last) && Math.abs(k.offset) > 15) over = true;
      last = k.offset;
      const back = over && Math.abs(k.offset) < 12; // (straightening from low on the far wall, to land on the floor straight)
      const want = back ? 0 : 0.85;
      dc.step(per, ["gas", ...(rel < want - 0.06 ? ["left"] : rel > want + 0.06 ? ["right"] : [])], false);
      dc.shot({ clear: 2.5 });
      await reel.save();
      if (back && Math.abs(rel) < 0.1 && f > frames(1.5)) break;
    }
  }
  // 4. Traffic in the tube: on the game's chase camera, the pack weaves through the cars, and
  // rides the walls past them.
  {
    await start(o.loops[4], THEME.tunnel, 7);
    const cars = () => race().obstacles.list.filter((q) => q.kind === "traffic" &&
      (q.s - race().track.s[race().player.idx] + race().track.length) % race().track.length < 40);
    await until(() => race().phase === "racing" && race().player.dist > 120 && cars().length > 0, 60 * 120);
    await film("n_traffic", 3.6, () => dc.shot({ clear: 2.5 }));
  }

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
  // 6. A rocket from mid-pack (it burns out once it has passed two karts): the kart flies itself
  // up the road, scattering whoever is in the way.
  await ready(o.loops[0], THEME.mesa, 18);
  dc.give("rocket");
  await film("i_rocket", 3.0, () => dc.shot({ clear: 2.5 }), (f) => (f === 1 ? ["item"] : []));
  // 7. A boomerang: the arrow sweeps; one press locks it onto the rival straight up the road, the
  // next throws, and the boomerang goes out, spins the rival, and comes home.
  {
    await ready(o.loops[1], THEME.mesa, 60);
    const inSights = () => rivals().filter((k) => {
      const s = seen(k);
      return s.d > 9 && s.d < 24 && Math.abs(s.off) < 0.4;
    }).sort((a, b) => seen(a).d - seen(b).d)[0];
    await until(() => !!inSights(), 60 * 40);
    const target = inSights();
    dc.give("boomerang");
    let locked = -1;
    await film("i_boomerang", 3.2, () => chase(0.9), (f) => {
      if (!target || f < frames(0.4)) return [];
      if (locked < 0) {
        // steer the sweep onto the rival, then press: the arrow locks there
        const off = Math.max(-AIM_MAX * 0.98, Math.min(AIM_MAX * 0.98, seen(target).off));
        race().aimPhase = Math.asin(off / AIM_MAX) - AIM_RATE / 60;
        locked = f;
        return ["item"];
      }
      return f === locked + 3 ? ["item"] : []; // let go, and press again: it flies along the arrow
    });
  }
  // 8. A bomb: one press locks the arrow (the bomb rides behind the kart), the next lobs it at the
  // racer ahead, and its blast catches everyone near.
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
      const press = f === frames(0.3) || f === frames(0.9);
      advance(per, press ? ["item"] : []);
      chase(1.2);
      await reel.save();
      if (blown < 0 && race().items.blasts.length > blasts) blown = f;
      if (blown >= 0 && f - blown >= frames(1.0) + fade) break;
    }
  }
  // 9. A comet: fired from the back, it flies up the road to the leader, hangs over them, and
  // comes down; filmed beside the leader as it arrives.
  {
    await ready(o.loops[2], THEME.mesa, 120);
    await until(() => race().player.place >= 4, 60 * 40);
    dc.give("comet");
    advance(per, ["item"]);
    const comet = () => race().items.comets[0];
    await until(() => !comet() || comet().phase !== "fly" ||
                      Math.hypot(comet().x - race().standings[0].x, comet().y - race().standings[0].y) < 70, 60 * 20);
    let landed = -1;
    reel.begin("i_comet");
    for (let f = 0; f < frames(4.5); f++) {
      advance(per);
      const lead = comet()?.target ?? race().standings[0];
      track(lead, -1, 9, 3.4);
      await reel.save();
      if (landed < 0 && !comet()) landed = f;
      if (landed >= 0 && f - landed >= frames(1.0) + fade) break;
    }
  }
  // 10. Down a red-rock canyon: alongside the player between its walls, beds of rock in red and
  // ochre either side, a tumbleweed blowing across if one comes.
  {
    await start(o.loops[1], THEME.mesa, 7);
    const banks = (race() as unknown as { features: { banks: { s0: number; len: number }[] } }).features.banks;
    const inCanyon = () => {
      const s0 = race().track.s[race().player.idx];
      return banks.some((b) => s0 > b.s0 + 6 && s0 < b.s0 + b.len - 30);
    };
    if (banks.length) {
      await until(() => race().phase === "racing" && inCanyon(), 60 * 120);
      await film("t_canyon", 3.4, (f, n) => track(race().player, 1, 5.5 + 2 * (f / n), 2.2));
    }
  }

  // ---------------------------------------------------------------- Coral Reef
  // 11. A shock under the sea: a white flash, and everyone else spins, shrinks and slows.
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
  // 12. Alongside the pack over a ridge of coral: bubble helmets, rays of light, schools of fish.
  await start(o.loops[3], THEME.reef, 7);
  await until(() => race().phase === "racing" && climb(race().player)?.style === "coral" && race().player.elev > 0.8 &&
                    race().player.slope > 0, 60 * 150);
  dc.give("triple"); // three turbo cells circling the kart
  await film("w_reef", 3.6, (f, n) => track(race().player, -1, 6 + 1.5 * (f / n), 1.9));

  // ---------------------------------------------------------------- Tokyo Nights
  await start(o.loops[9], THEME.tokyo, 7);
  // 13. Up on the expressway: alongside the pack on the deck, its lamps over the road, the city's
  // lit towers and the lattice tower behind.
  await until(() => race().phase === "racing" && climb(race().player)?.style === "expressway" && race().player.elev > 3 &&
                    race().player.slope >= 0, 60 * 150);
  await film("e_express", 4.0, (f, n) => track(race().player, 1, 8 + 4 * (f / n), 2.6 + 1.4 * (f / n)));
  // 14. The police on the player's tail: out of an alley and after them, lights flashing; filmed
  // from ahead, looking back down the street at the chase.
  {
    const cop = () => race().obstacles.list.find((q) => q.kind === "police" && (q.state === POLICE_CHASE || q.state === POLICE_LUNGE));
    const behind = () => {
      const c = cop();
      if (!c) return -1;
      const t = race().track;
      return (t.s[race().player.idx] - c.s + t.length) % t.length;
    };
    // (right on the player's tail: it gains on them only slowly now, and filmed from 26 m back it
    // was a small car far down the street)
    await until(() => { const d = behind(); return d > 5 && d < 13; }, 60 * 240);
    if (cop()) {
      await film("e_police", 3.4, () => {
        const k = race().player, c = Math.cos(k.heading), sn = Math.sin(k.heading);
        dc.shot({ x: k.x + c * 9, y: k.y + sn * 9, heading: k.heading + Math.PI, height: 2.3 + k.ground, focal: 250, fx: 0, clear: 2 });
      });
    }
  }

  // ---------------------------------------------------------------- Dream Valley: a roller coaster
  await start(o.loops[5], THEME.valley, 7, "coaster");
  // 15. Cows crossing: one ambles across the road in front of the player, who steers round it.
  {
    const cow = () => race().obstacles.list.find((q) => {
      if (q.kind !== "cow" || q.state !== COW_WALK || Math.abs(q.offset) > 5) return false;
      const t = race().track, d = (q.s - t.s[race().player.idx] + t.length) % t.length;
      return d > 26 && d < 48;
    });
    await until(() => race().phase === "racing" && !!cow(), 60 * 200);
    if (cow()) await film("v_cows", 2.8, () => dc.shot({ height: 3.4 + race().player.ground, clear: 2.5 }));
  }
  // 16. A drift: sideways through a bend, the sparks charging a mini-turbo.
  await until(() => race().phase === "racing" && race().player.drifting && race().player.boostLevel >= 1, 60 * 60);
  await film("v_drift", 2.6, () => {
    const k = race().player;
    dc.shot({ x: k.x - Math.cos(k.heading) * 5.4, y: k.y - Math.sin(k.heading) * 5.4, heading: k.heading,
              height: 1.7 + k.ground, focal: 250, fx: 0, clear: 2 });
  });
  // 16. A crane up and back from the leader: the climbs over the meadows, the knolls around them.
  await film("e_crane", 3.6, (f, n) => crane(race().standings[0], smooth(Math.min(1, f / n))));

  // ---------------------------------------------------------------- Construction Zone
  await start(o.loops[7], THEME.construction, 7);
  // 17. High on a crane's girder: alongside the pack on the steel deck, the crane beside it and
  // the city going up behind.
  await until(() => race().phase === "racing" && climb(race().player)?.style === "girder" && race().player.elev > 2.5 &&
                    race().player.slope > 0, 60 * 150);
  await film("k_girder", 4.2, (f, n) => track(race().player, 1, 9 + 6 * (f / n), 2.6 + 2.4 * (f / n)));
  // The wrecking ball: swinging across the road under its crane's jib as the player comes up to it.
  {
    const ball = () => race().obstacles.list.find((q) => {
      if (q.kind !== "wrecker") return false;
      const t = race().track, d = (q.s - t.s[race().player.idx] + t.length) % t.length;
      return d > 34 && d < 46;
    });
    await until(() => !!ball(), 60 * 200);
    if (ball()) await film("k_wreck", 3.0, () => dc.shot({ height: 4.2 + race().player.ground, clear: 2.5 }));
  }
  // 18. Through the steel frame of a building going up, on the game's chase camera.
  {
    const t = race().track, tunnels = race().features.tunnels;
    if (tunnels.length) {
      const before = (s: number) => tunnels.some((tn) => tn.s0 - s > 20 && tn.s0 - s < 28);
      await until(() => before(t.s[race().player.idx]), 60 * 120);
      await film("k_frame", 3.0, () => dc.shot({ clear: 2.5 }));
    }
  }

  // ---------------------------------------------------------------- Moon Base
  await start(o.loops[8], THEME.moon, 7);
  // 19. Floating off a crater's rim in the low gravity, the Earth hanging in the black sky: at a
  // rim where the road runs across the line to the Earth, the camera rides alongside the kart,
  // looking past it at the Earth, as it floats off the top and drifts back down.
  {
    const at = dc.game.sky?.earthAt ?? -1;
    const toEarth = at >= 0 ? -((at - FRAME_W / 2) * Math.PI * 2) / PAN : 0;
    const ex = Math.cos(toEarth), ey = Math.sin(toEarth);
    const t = race().track;
    const indexAt = (s: number) => {
      let lo = 0, hi = t.count - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t.s[mid] < s) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const across = (h: Hill, need: number) => {
      const [tx, ty] = t.tangent(indexAt(h.s0 + h.len / 2));
      return Math.abs(ex * ty - ey * tx) > need;
    };
    const need = t.hills.some((h) => h.style === "crater" && across(h, 0.8)) ? 0.8 : 0;
    const crest = () => {
      const k = race().player, h = climb(k);
      if (!h || h.style !== "crater" || !across(h, need)) return Infinity;
      const s = t.s[k.idx], top = h.s0 + h.len / 2;
      return s < top ? (top - s) / Math.max(k.v, 1) : Infinity;
    };
    await until(() => race().phase === "racing" && race().player.v > 22 && crest() < 0.7, 60 * 200);
    await film("l_float", 3.0, () => {
      const k = race().player;
      dc.shot({ x: k.x - ex * 12, y: k.y - ey * 12, heading: toEarth, height: k.ground + 1.7, focal: 250, fx: 0, clear: 3 });
    });
  }
  // A meteor: the red ring on the road ahead, and the rock coming down onto it at a slant. Filmed
  // from behind the kart while it is on the ground (a flight here carries it out of the picture),
  // when no crest stands between it and the ring, the camera turned to the ring.
  {
    const rock = () => race().obstacles.list.find((q) => {
      const k = race().player, t = race().track;
      if (q.kind !== "meteor" || q.state !== METEOR_FALL || q.t > 0.35 || k.air) return false;
      const d = (q.s - t.s[k.idx] + t.length) % t.length;
      if (d < 45 || d > 85) return false;
      const z0 = t.elev[k.idx] ?? 0, z1 = t.elev[q.idx] ?? 0;
      for (let i = k.idx, n = 0; n < 400; n++, i = t.wrap(i + 4)) {
        const m = (t.s[i] - t.s[k.idx] + t.length) % t.length;
        if (m >= d) break;
        if ((t.elev[i] ?? 0) > z0 + (z1 - z0) * (m / d) + 0.6) return false; // (a crest in the way)
      }
      return true;
    });
    await until(() => !!rock(), 60 * 200);
    const m = rock();
    if (m) {
      await film("l_meteor", 2.8, () => {
        const k = race().player, c = Math.cos(k.heading), sn = Math.sin(k.heading);
        const x = k.x - c * 10, y = k.y - sn * 10;
        dc.shot({ x, y, heading: Math.atan2(m.y - y, m.x - x), height: k.ground + 4.5, focal: 330, fx: 0, clear: 2.5 });
      });
    }
  }

  // ---------------------------------------------------------------- Volcano Core
  await start(o.loops[6], THEME.volcano, 7);
  // 21. Alongside the pack on the rock across the lava, the crater's walls and its cones behind.
  await until(() => race().phase === "racing" && race().player.dist > 90, 60 * 30);
  await film("x_lava", 3.4, (f, n) => track(race().player, 1, 7.5 + 2.5 * (f / n), 3.4));
  // A geyser: its vent glows and bubbles, and it blows a column of lava and fire across the road
  // as the player comes up to it.
  {
    const vent = () => race().obstacles.list.find((q) => {
      if (q.kind !== "geyser" || q.state !== GEYSER_QUIET || q.t < q.wait - 0.5) return false;
      const t = race().track, d = (q.s - t.s[race().player.idx] + t.length) % t.length;
      return d > 40 && d < 75;
    });
    await until(() => !!vent(), 60 * 200);
    if (vent()) await film("x_geyser", 2.8, () => dc.shot({ height: 3.6 + race().player.ground, clear: 2.5 }));
  }
  // 23. Into the lava: the player turns off a straight, across the rock bank and in; the view goes
  // dark red, and the rescue drone lowers the kart back onto the road and lets it go.
  {
    const t = race().track;
    const ahead = (m: number) => t.wrap(race().player.idx + Math.round(m / 0.6));
    const straight = () => [0, 15, 30, 45].every((m) => Math.abs(t.curvature(ahead(m))) < 1 / 160);
    // no jump or climb coming up, and nothing solid on the bank where it will leave the road (a
    // rock would stop it short of the lava)
    const noRamp = () => race().features.ramps.every((q) => (t.s[q.start] - t.s[race().player.idx] + t.length) % t.length > 90);
    const flat = () => [0, 10, 20, 30, 40, 50].every((m) => t.elev[ahead(m)] < 0.05);
    const clear = () => [10, 14, 18, 22, 26, 30, 34, 38].every((m) => {
      const i = ahead(m), [tx, ty] = t.tangent(i);
      return [6, 8.5, 11].every((off) => {
        const x = t.xs[i] + ty * off, y = t.ys[i] - tx * off; // right of the road
        return !race().scenery.items.some((it) => it.art.solid && Math.hypot(it.x - x, it.y - y) < 3.2);
      });
    });
    await until(() => straight() && noRamp() && flat() && clear() && race().player.v > 18, 60 * 90);
    const side = -1; // off to the right (positive offsets are to the left of the road)
    reel.begin("x_rescue");
    for (let f = 0; f < frames(5); f++) {
      const k = race().player;
      // steer off until well onto the rock bank, then straight on into the lava
      const steer = k.fall < 0 && Math.abs(k.offset) < 8 ? (side > 0 ? ["left"] : ["right"]) : [];
      dc.step(per, k.fall < 0 ? ["gas", ...steer] : [], false);
      if (k.fall < FALL_SWAP) {
        // the driver's view, from a little higher and further back: off the road, over the rock and in
        const h = dc.game.cam.heading;
        dc.shot({ x: k.x - Math.cos(h) * 9, y: k.y - Math.sin(h) * 9, height: 4.1 + k.ground, clear: 2.5 });
      } else {
        // beside where the drone sets it down (high enough to keep the drone in the picture)
        const [tx, ty] = t.tangent(t.wrap(k.idx));
        const x = k.dropX + tx * 4 - ty * 9.5, y = k.dropY + ty * 4 + tx * 9.5;
        dc.shot({ x, y, heading: Math.atan2(k.dropY - y, k.dropX - x), height: 3.6 + k.dropZ, focal: 250, fx: 0, clear: 3 });
      }
      await reel.save();
      if (k.fall >= FALL_RELEASE + 0.55) break;
    }
  }

  // ---------------------------------------------------------------- the Grand Prix podium
  // 24. The award ceremony: the top three on the podium, fireworks and confetti. (It fades back
  // into the launch.)
  {
    dc.cup(true, 1);
    const g = dc.game;
    for (let i = 0; i < Math.round(60 * 5.6); i++) g.ceremony?.update(1 / 60, g.sound);
    const n = frames(4.0);
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
