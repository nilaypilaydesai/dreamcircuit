// The DATA page's hero video, filmed in the game itself. Drives a race through the dev hook and
// films clean, HUD-free shots: a drone ahead of the grid at the launch, the game's own chase
// camera through a jump, an orbit around the bridge, a tracking shot alongside the player, and a
// crane reveal. Every 384x216 frame is upscaled with nearest-neighbour sampling (the pixel art
// stays crisp) and encoded right here with WebCodecs into H.264 MP4s, one per output size.
// Shots cross-fade, and the last fades back into the first, so the video loops without a seam
// and can open on any shot; the poster is the video's first frame. Files go to a local capture
// server (scripts/capture_frames.py) that writes them to disk.
//
// In the browser console on the dev server (http://localhost:5173/):
//   const { film } = await import("/src/tools/cinema.ts"); await film({ points })

import { Encoder } from "./mp4";

interface Kart { x: number; y: number; heading: number; elev: number; ground: number; air: boolean; idx: number; v: number }
interface Track {
  xs: number[]; ys: number[]; s: number[]; count: number; length: number; startIndex: number;
  bridges: { center: number; lower: number }[]; tangent(i: number): [number, number];
}
interface Race {
  track: Track; player: Kart; standings: Kart[]; karts: Kart[]; phase: string; countdown: number;
  features: { ramps: { start: number }[] };
}
interface Dc {
  step(n: number, keys?: string[], draw?: boolean): void;
  shot(cam: Record<string, number>): void;
  state(): Record<string, unknown>;
  race(points: number[], theme?: number, rivals?: number): void;
  hold(on?: boolean): void;
  pin(size: [number, number] | null): void;
  game: { race: Race | null };
}

export interface Variant { name: string; w: number; h: number; bitrate: number }

export interface FilmOptions {
  url?: string; // capture server
  points: number[]; // the circuit (game meters), e.g. one the designer dreamed
  theme?: number;
  rivals?: number;
  fps?: number;
  fade?: number; // frames of cross-fade between shots
  variants?: Variant[];
  stills?: Record<string, number[]>; // shot name -> frame numbers to also save as 1080p PNGs
  open?: string; // the shot the video opens on (default: the bridge)
  // also save a stretch of the film as numbered PNG frames at game resolution, for a GIF
  gif?: { from: string; seconds: number; every: number };
}

export const VARIANTS: Variant[] = [
  { name: "hero", w: 1920, h: 1080, bitrate: 5_000_000 },
  { name: "hero-648", w: 1152, h: 648, bitrate: 2_200_000 }, // exactly 3x: small screens
];

const tick = () => new Promise<void>((r) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => r();
  ch.port2.postMessage(0);
});
const smooth = (u: number) => u * u * (3 - 2 * u);

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
  dc.race(o.points, o.theme ?? 1, o.rivals ?? 7);
  for (let i = 0; i < 4000 && dc.state().phase !== "countdown"; i++) await tick();
  const race = () => dc.game.race!;
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const counts: Record<string, number> = {};

  // Pass 1 films every frame at the game's resolution, cross-fades included; pass 2 upscales and
  // encodes them, starting wherever the video should open (the loop is seamless, so any frame
  // works as the first).
  const low = new OffscreenCanvas(canvas.width, canvas.height);
  const lg = low.getContext("2d")!;
  const film: ImageBitmap[] = [];
  const opens: Record<string, number> = {}; // first clean (not cross-fading) frame of each shot
  const head: ImageBitmap[] = []; // the first shot's opening frames: the loop fades into them
  let tail: ImageBitmap[] = []; // the previous shot's closing frames, fading into this shot
  // A shot's frames are held back by `fade` frames, so whenever the shot ends, its last `fade`
  // frames are still unemitted and become the cross-fade into the next shot. Shots can then end
  // on an event (a landing) instead of a timer.
  let pending: ImageBitmap[] = [];
  let shotIndex = -1, shotFrame = 0;
  const emit = (a: CanvasImageSource, b?: CanvasImageSource, alpha = 0) => {
    lg.globalAlpha = 1;
    lg.drawImage(a, 0, 0);
    if (b) {
      lg.globalAlpha = alpha;
      lg.drawImage(b, 0, 0);
    }
    film.push(low.transferToImageBitmap());
  };
  const begin = () => {
    shotIndex += 1;
    shotFrame = 0;
    tail = pending;
    pending = [];
  };
  const save = async (shot: string) => {
    counts[shot] = (counts[shot] ?? 0) + 1;
    const k = shotFrame++;
    if (o.stills?.[shot]?.includes(k)) {
      const big = new OffscreenCanvas(1920, 1080);
      const g = big.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      g.drawImage(canvas, 0, 0, 1920, 1080);
      await post(`${shot}_${k}.png`, await big.convertToBlob({ type: "image/png" }));
    }
    if (k === fade) opens[shot] = film.length;
    const bmp = await createImageBitmap(canvas);
    if (k < fade) {
      if (shotIndex === 0) {
        head.push(bmp);
      } else {
        emit(tail[k], bmp, (k + 1) / (fade + 1));
        bmp.close();
      }
    } else {
      pending.push(bmp);
      if (pending.length > fade) {
        const oldest = pending.shift()!;
        emit(oldest);
        oldest.close();
      }
    }
  };
  // the autopilot drives; at the start it waits, then hits the gas just before GO: a rocket start
  const keys = () => {
    const r = race();
    if (r.phase !== "countdown") return ["auto"];
    return r.countdown <= 1.35 ? ["gas"] : [];
  };
  const advance = (steps: number) => dc.step(steps, keys(), false);
  const until = async (done: () => boolean, limit: number) => {
    for (let guard = 0; !done() && guard < limit; guard++) {
      advance(1);
      if (guard % 200 === 0) await tick();
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
  const frames = (seconds: number) => Math.round(fps * seconds);

  // 1. The launch: a drone ahead of the grid, drifting back and up as the pack rockets off.
  {
    await until(() => race().countdown <= 2.15, 600);
    const t = race().track, si = t.startIndex;
    const h = heading(si);
    const n = frames(4.2);
    begin();
    for (let f = 0; f < n; f++) {
      advance(per);
      const u = f / n;
      const d = 30 + 26 * smooth(u);
      dc.shot({ x: t.xs[si] + Math.cos(h) * d, y: t.ys[si] + Math.sin(h) * d, heading: h + Math.PI,
                height: 3.2 + 4.5 * smooth(u), focal: 250, fx: 0, clear: 6 });
      await save("a_launch");
    }
  }
  // 2. The game's chase camera through the first jump: up the ramp, a trick in the air, and the
  // boost on landing.
  {
    const r = race(), p = r.player;
    const ramp = r.features.ramps.map((q) => q.start).sort((a, b) => ahead(p, a) - ahead(p, b))[0];
    if (ramp !== undefined) {
      const lip = ramp + 18; // 11 m of ramp at 0.6 m per point
      // timed by speed, not distance: 1.7 s of run-up, then the flight and the landing boost,
      // all clear of the cross-fades at either end
      const eta = (k: Kart) => ahead(k, lip) / Math.max(Math.abs(k.v), 10);
      await until(() => eta(race().player) < 1.7, 60 * 120);
      begin();
      let flew = false, landed = -1;
      for (let f = 0; f < frames(8); f++) {
        advance(per);
        dc.shot({ clear: 2.5 });
        await save("b_jump");
        const k = race().player;
        if (k.air) flew = true;
        else if (flew && landed < 0) landed = f;
        // 1.3 s of the landing boost on screen, then the fade (the held-back frames)
        if (landed >= 0 && f - landed >= frames(1.3) + fade) break;
      }
    }
  }
  // 3. An orbit around the bridge as the pack crosses over and under it.
  if (race().track.bridges.length) {
    const t = race().track, b = t.bridges[0];
    const cx = t.xs[b.center], cy = t.ys[b.center];
    await until(() => race().standings.some((k) => {
      const d = Math.min(ahead(k, b.center), ahead(k, b.lower));
      return d < 70;
    }), 60 * 200);
    const a0 = heading(b.center) + Math.PI * 0.62;
    const n = frames(4.8);
    begin();
    for (let f = 0; f < n; f++) {
      advance(per);
      const a = a0 + (f / fps) * 0.28, r = 44;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      dc.shot({ x, y, heading: Math.atan2(cy - y, cx - x), height: 10.5, focal: 255, fx: 0, clear: 14 });
      await save("c_bridge");
    }
  }
  // 4. A tracking shot alongside the player, looking back at the kart from ahead and to the side.
  {
    const n = frames(3.0);
    begin();
    for (let f = 0; f < n; f++) {
      advance(per);
      const k = race().player;
      const c = Math.cos(k.heading), sn = Math.sin(k.heading);
      const x = k.x + c * 6.5 - sn * 6.5, y = k.y + sn * 6.5 + c * 6.5;
      dc.shot({ x, y, heading: Math.atan2(k.y - y, k.x - x), height: 2.3 + k.elev, focal: 250, fx: 0, clear: 3 });
      await save("d_track");
    }
  }
  // 5. A crane up and back from the leader, revealing the circuit.
  {
    const n = frames(4.2);
    begin();
    for (let f = 0; f < n; f++) {
      advance(per);
      const k = race().standings[0];
      const e = smooth(Math.min(1, f / n));
      const back = 7 + 26 * e; // high enough to read the circuit, low enough to keep it in frame
      dc.shot({ x: k.x - Math.cos(k.heading) * back, y: k.y - Math.sin(k.heading) * back,
                heading: k.heading, height: 3 + k.ground + 17 * e, focal: 250, fx: 0, clear: 5 + 10 * e });
      await save("e_crane");
    }
  }
  // close the loop: the last shot fades back into the first
  for (let k = 0; k < fade; k++) emit(pending[k], head[k], (k + 1) / (fade + 1));

  if (o.gif) {
    const lowc = new OffscreenCanvas(canvas.width, canvas.height);
    const gc = lowc.getContext("2d")!;
    const from = opens[o.gif.from] ?? 0;
    for (let k = 0, i = 0; k < o.gif.seconds * fps; k += o.gif.every, i++) {
      gc.drawImage(film[(from + k) % film.length], 0, 0);
      await post(`gif_${String(i).padStart(3, "0")}.png`, await lowc.convertToBlob({ type: "image/png" }));
    }
  }
  // pass 2: encode every size, opening on the chosen shot
  const first = opens[o.open ?? "c_bridge"] ?? 0;
  const sizes: Record<string, number> = {};
  let poster: Blob | null = null;
  for (const v of o.variants ?? VARIANTS) {
    const big = new OffscreenCanvas(v.w, v.h);
    const g = big.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    const enc = new Encoder(v.w, v.h, fps, await Encoder.pick(v.w, v.h, fps), v.bitrate);
    for (let i = 0; i < film.length; i++) {
      g.drawImage(film[(first + i) % film.length], 0, 0, v.w, v.h);
      await enc.add(big);
      if (!poster) poster = await big.convertToBlob({ type: "image/jpeg", quality: 0.86 });
    }
    const video = await enc.finish();
    sizes[v.name] = video.size;
    await post(`${v.name}.mp4`, video);
  }
  if (poster) await post(`${(o.variants ?? VARIANTS)[0].name}.jpg`, poster);
  for (const b of [...film, ...head, ...pending]) b.close();
  dc.hold(false);
  return { ...counts, ...sizes };
}
