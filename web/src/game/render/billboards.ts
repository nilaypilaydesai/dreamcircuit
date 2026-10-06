// Billboards: scenery and karts projected into the Mode-7 view, scaled with nearest-neighbor
// (the SNES look), with soft shadows under the karts on whatever surface they are over. They are
// depth sorted together with the 3D faces of bridges, ramps and pads (render/poly.ts).
// Karts show what they carry: the item they will use next floats over the driver's head, spare
// shots circle the kart, and one held as a shield drags on the road behind it; boosts and rockets
// breathe fire, a prism shimmers through the rainbow and a shocked kart is drawn small. In the
// volcano a kart that goes into the lava sinks in a splash and a puff of smoke, and comes back
// hanging under the rescue drone.

import { H, W, hex, mix, type Screen } from "../core/gfx";
import { FALL_END, FALL_RELEASE, FALL_SINK, FALL_SWAP, type Kart, WALL_GRAB } from "../race/kart";
import { ORBITS, type ItemKind } from "../race/items";
import type { FallKind } from "../world/hazards";
import type { Placed } from "../world/scenery";
import type { Camera } from "./mode7";
import { type Face, toCamera } from "./poly";
import { KART_ANCHOR, KART_PX, KART_VIEWS, type KartViews, type SceneryArt } from "./sprites";
import { drawDome } from "./underwater";

/** Moving or animated objects drawn like scenery: item boxes, oil slicks, dream orbs. */
export interface WorldSprite {
  x: number;
  y: number;
  art: SceneryArt;
  lift?: number; // m above the surface under it (it casts a shadow when floating)
  base?: number; // m, height of that surface (a bridge deck)
  flip?: boolean; // mirrored (a fish swimming the other way)
  draw?: (sx: number, gy: number, ppm: number) => void; // drawn by hand instead (a horn's ring)
  idx?: number; // the road point it is by (in the tube, which pass of a figure-eight it is on)
}

/** How to draw each kart: its 16 views, its drift sparks, and what it carries. */
export interface KartLook {
  sprites: (k: Kart) => KartViews;
  sparks: (k: Kart) => number;
  held: (k: Kart) => SceneryArt | null;
  art?: (item: ItemKind) => SceneryArt; // any item's art (the jackpot's eight circling a kart)
  grabber?: SceneryArt[]; // the grabber: idle, wide open, snapped shut
  dome?: boolean; // every driver wears a clear helmet (under the sea, on the moon)
  underDeck?: (x: number, y: number) => boolean; // whether a spot on the ground is under a bridge's deck
  hide?: Kart; // a kart not to draw (the player's own, seen past in the rear-view mirror)
  drone?: SceneryArt[]; // the rescue drone's frames (the volcano)
  /** Inside the tunnel's tube: where a point given in the race's flat terms (x, y, and h m up)
   * really is, round the tube, and how far its surface is turned (``hint``: a road point near it). */
  tube?: (x: number, y: number, h: number, hint?: number) => { X: number; Y: number; Z: number; n: [number, number, number] } | null;
  viewOf?: (k: Kart) => number; // in the tube: which way the camera sees kart k from (an angle in flat terms), to pick its view
}

interface Item {
  z: number;
  sx: number;
  gy: number;
  ppm: number; // pixels per meter at this depth
  rot?: number; // radians it is drawn turned (up a wall of the tunnel's tube, from the camera's)
  draw: () => void;
}

const NEAR_SEEN = 4, NEAR_GONE = 2.2; // m from the camera in the tunnel: a sprite nearer is drawn see-through, or not at all
const RAINBOW = ["#ff5fa2", "#ffd23f", "#5dff7a", "#63c8ff", "#c79bff"].map(hex);

export function drawWorldSprites(scr: Screen, cam: Camera, scenery: Placed[], karts: Kart[], look: KartLook,
                                 fog: number, extras: WorldSprite[] = [], faces: Face[] = []): void {
  const fx = Math.cos(cam.heading), fy = Math.sin(cam.heading);
  const rx = Math.sin(cam.heading), ry = -Math.cos(cam.heading);
  const items: Item[] = [];
  const now = performance.now() / 1000;
  const tube = look.tube;
  const project = (x: number, y: number, h = 0, hint?: number): Projected | null => {
    if (tube) {
      // round the tube, seen by a camera turned with it: a sprite there is drawn turned as much
      const q = tube(x, y, h, hint);
      if (!q) return null; // (on the other pass of a crossing, whose tube is not drawn)
      const [z, lat, up] = toCamera(cam, q.X, q.Y, q.Z);
      if (z < 1.2 || z > cam.far) return null;
      const ppm = cam.focal / z, sx = W / 2 + lat * ppm;
      if (sx < -200 || sx > W + 200) return null;
      // its surface's up, as the camera sees it: how far to turn it on the screen
      const B = cam.basis, n = q.n;
      const rot = B ? Math.atan2(n[0] * B.r[0] + n[1] * B.r[1] + n[2] * B.r[2], n[0] * B.u[0] + n[1] * B.u[1] + n[2] * B.u[2]) : 0;
      return { z, sx, gy: cam.horizon - up * ppm, ppm, rot };
    }
    const dx = x - cam.x, dy = y - cam.y;
    const z = dx * fx + dy * fy;
    if (z < 1.2 || z > cam.far) return null;
    const lat = dx * rx + dy * ry;
    const ppm = cam.focal / z;
    const sx = W / 2 + lat * ppm;
    if (sx < -200 || sx > W + 200) return null;
    return { z, sx, gy: cam.horizon + (cam.height - h) * ppm, ppm };
  };
  /** ``draw`` turned about q's point, as q is round the tube from the camera. */
  const turn = (q: Projected, draw: () => void) => (!q.rot ? draw : () => {
    scr.pivot = { x: q.sx, y: q.gy, a: q.rot! };
    draw();
    scr.pivot = null;
  });
  // things at ground level under a bridge's deck, seen from up on it, must be drawn before the deck
  // (only there: a kart coming down a ramp, under a camera still up on the deck, is not under it)
  const lowAt = (x: number, y: number, z: number) => (cam.height - z > 3 && look.underDeck?.(x, y) ? 2.5 : 0);
  const fogAt = (z: number) => (z > cam.far * 0.45 ? Math.min(1, (z - cam.far * 0.45) / (cam.far * 0.55)) ** 1.5 : 0);
  /** A floating sprite at (x, y), ``lift`` m over a surface at height ``base``. */
  const billboard = (art: SceneryArt, x: number, y: number, base: number, lift: number, bias: number, shadowed = true,
                     size = 1, flip = false, hint?: number) => {
    const p = project(x, y, base, hint);
    // (in the tunnel, going by close to the camera, behind the kart it follows: drawn see-through,
    // and right by it not at all, or riding a wall past the traffic, a car swept across the screen)
    if (!p || (tube && p.z < NEAR_GONE)) return;
    const h = art.height * size * p.ppm;
    if (h < 1) return;
    const w = (h * art.sprite.w) / art.sprite.h;
    const up = lift * p.ppm;
    items.push({
      ...p,
      z: p.z + bias,
      draw: turn(p, () => {
        if (up > 0 && shadowed) shadow(scr, p.sx, p.gy, w * 0.42, Math.max(1, w * 0.12), p.rot ?? 0);
        scr.blitScaled(art.sprite, p.sx - w / 2, p.gy - h - up, w, h, flip, fog, fogAt(p.z), H, !!tube && p.z < NEAR_SEEN);
      }),
    });
  };

  for (const it of scenery) {
    const p = project(it.x, it.y);
    if (!p || (cam.clear && p.z < cam.clear)) continue;
    const h = it.art.height * p.ppm;
    if (h < 1.5) continue;
    const w = (h * it.art.sprite.w) / it.art.sprite.h;
    items.push({ ...p, z: p.z + lowAt(it.x, it.y, 0),
      draw: turn(p, () => scr.blitScaled(it.art.sprite, p.sx - w / 2, p.gy - h, w, h, it.flip, fog, fogAt(p.z))) });
  }
  for (const it of extras) {
    const base = it.base ?? 0;
    const draw = it.draw;
    if (draw) {
      const p = project(it.x, it.y, base + (it.lift ?? 0), it.idx);
      if (p) items.push({ ...p, z: p.z + (base > 1 ? -0.5 : lowAt(it.x, it.y, base)), draw: turn(p, () => draw(p.sx, p.gy, p.ppm)) });
      continue;
    }
    billboard(it.art, it.x, it.y, base, it.lift ?? 0, base > 1 ? -0.5 : lowAt(it.x, it.y, base), true, 1, it.flip, it.idx);
  }
  for (const k of karts) {
    if (k === look.hide) continue;
    const drop = k.fallKind === "drop"; // (falling off raised road: down past the deck, to the ground)
    const offWall = k.fallKind === "wall"; // (off a wall of the tube: in its air, and seen all the way)
    if (k.fall >= 0) {
      const low = lowAt(k.x, k.y, k.ground);
      if (!drop && !offWall) splash(k, project, (q, z, draw) => items.push({ ...q, z: z + low, draw }), scr, now);
      if (look.drone) rescueDrone(k, look.drone, project, (q, z, draw) => items.push({ ...q, z, draw }), scr, now, low);
      if (k.fall >= FALL_SINK && k.fall < FALL_SWAP && !drop && !offWall) continue; // under the surface
    }
    const falling = (drop && k.fall >= 0 && k.fall < FALL_SWAP) || k.inside !== null;
    const p = project(k.x, k.y, k.elev, k.idx);
    const ps = project(k.x, k.y, falling ? 0 : k.ground, k.idx);
    if (!p || !ps) continue;
    const sprites = look.sprites(k);
    const view = look.viewOf?.(k) ?? Math.atan2(k.y - cam.y, k.x - cam.x); // camera -> kart, world frame
    let rel = view - (k.heading + k.slip + k.visualSpin);
    if (k.isPlayer) rel -= k.steer * 0.18; // lean into the steer
    const vi = (((Math.round((rel / (Math.PI * 2)) * KART_VIEWS) % KART_VIEWS) + KART_VIEWS) % KART_VIEWS);
    const s = sprites[vi];
    const size = k.shrink > 0 ? 0.62 : k.rocket > 0 ? 1.12 : 1;
    const h = 1.75 * p.ppm * (s.h / KART_PX) * size;
    const w = (h * s.w) / s.h;
    const bounce = k.surface === "grass" && Math.abs(k.v) > 3 ? Math.round(Math.sin(performance.now() / 45 + k.id)) : 0;
    const air = Math.max(0, k.elev - k.ground);
    const shrink = (1 / (1 + air * 0.35)) * size;
    const prism = k.prism > 0;
    // sinking into the lava it glows hot (and the lava hides what is under its surface); hanging
    // under the drone it cools off
    const sinking = k.fall >= 0 && k.fall < FALL_SINK && !drop && !offWall, carried = k.falling && k.fall >= FALL_SWAP;
    const hot = k.fallKind === "lava"; // (only the lava makes it glow)
    const heat = !hot ? 0 : sinking ? 0.25 + 0.5 * (k.fall / FALL_SINK)
      : carried ? 0.4 * (1 - (k.fall - FALL_SWAP) / (FALL_RELEASE - FALL_SWAP)) : 0;
    const tint = prism ? RAINBOW[Math.floor(now * 14 + k.id) % RAINBOW.length] : heat > 0 ? LAVA_GLOW : fog;
    const tintAmount = prism ? (k.prism < 1.5 && Math.floor(now * 10) % 2 ? 0 : 0.42) : heat > 0 ? heat : fogAt(p.z);
    // on raised road (a deck, a climb, a ramp) a kart is drawn over the road it stands on
    const bias = k.ground > 0.05 || k.elev > 1 ? -0.5 : lowAt(k.x, k.y, k.elev);
    // (a wing pad's wings: which way, on the screen, a vapour trail streams back from the kart, as
    // the body is drawn: unturned, round the tube)
    let trail: [number, number] | null = null;
    if (k.wings > 0 && Math.abs(k.v) > 12 && k.rocket <= 0 && !k.falling) {
      const b = project(k.x - Math.cos(k.heading) * 1.6, k.y - Math.sin(k.heading) * 1.6, k.elev + 0.37, k.idx);
      if (b) { // (from the tips, 0.37 m up)
        const a = -(p.rot ?? 0), dx = b.sx - p.sx, dy = b.gy - p.gy;
        trail = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a) + 0.37 * p.ppm];
      }
    }
    // (round the tube, the kart and its shadow are drawn turned with the surface they are on)
    const body = () => {
      const top = p.gy - h * KART_ANCHOR + bounce;
      scr.blitScaled(s, p.sx - w / 2, top, w, h, false, k.phantom > 0 ? hex("#c9b8ff") : tint,
                     k.phantom > 0 ? 0.35 : tintAmount, sinking ? Math.round(ps.gy + 0.2 * ps.ppm) : H, k.phantom > 0);
      const head = look.dome && k.rocket <= 0 ? sprites.heads?.[vi] : undefined;
      if (head) drawDome(scr, p.sx - w / 2 + (head[0] * w) / s.w, top + (head[1] * h) / s.h, (5.6 * 1.55 * h) / s.h);
      const sp = look.sparks(k);
      if (sp) drawSparks(scr, p.sx, p.gy, p.ppm, sp, k.driftDir);
      // winged, at speed: a vapour trail streams back off each wing tip
      if (trail && sprites.tips) {
        const dot = Math.max(1, Math.round(p.ppm * 0.05));
        for (const [tx, ty] of sprites.tips[vi]) vapour(scr, p.sx - w / 2 + (tx * w) / s.w, top + (ty * h) / s.h, trail[0], trail[1], dot);
      }
    };
    items.push({
      ...p,
      z: p.z + bias,
      draw: () => {
        // (in the tube, the shadow lies turned with the surface under it, as the kart is)
        if (!sinking && !falling) shadow(scr, ps.sx, ps.gy, 1.0 * ps.ppm * shrink, 0.32 * ps.ppm * shrink, ps.rot ?? 0);
        turn(p, body)();
      },
    });
    // fire from the exhaust while boosting (the flamethrower always shows off), and the rocket's plume
    const c = Math.cos(k.heading), sn = Math.sin(k.heading);
    const flames = k.rocket > 0 ? 3 : k.boostTime > 0 ? (k.build.exhaust === "flame" ? 2 : 1) : 0;
    if (flames) {
      const back = k.rocket > 0 ? 2.6 : 1.3;
      const q = project(k.x - c * back, k.y - sn * back, k.elev + (k.rocket > 0 ? 0.55 : 0.3), k.idx);
      if (q) items.push({ ...q, z: q.z + bias - 0.05, draw: turn(q, () => drawFlames(scr, q.sx, q.gy, q.ppm, flames)) });
    }
    // what it carries: the item it will use next floats over the driver's head, spare shots (a
    // triple turbo, boomerangs) circle the kart slowly, and oil, an orb or a bomb held out behind
    // (button down) drags on the road behind it
    const art = look.held(k);
    const small = k.shrink > 0 ? 0.62 : 1;
    const circle = (a: SceneryArt, count: number, at: number, size: number) => {
      for (let n = 0; n < count; n++) {
        const ang = now * 1.6 + k.id + (n / count) * Math.PI * 2;
        billboard(a, k.x + Math.cos(ang) * 1.8 * small, k.y + Math.sin(ang) * 1.8 * small, k.elev, at * small, bias - 0.01,
                  false, size * small, false, k.idx);
      }
    };
    if (k.jackpot.length && look.art && k.rocket <= 0 && !k.falling) {
      // the jackpot: what is left of its eight, circling the kart
      const count = k.jackpot.length;
      k.jackpot.forEach((item, n) => {
        const ang = now * 1.6 + k.id + (n / count) * Math.PI * 2;
        billboard(look.art!(item), k.x + Math.cos(ang) * 2 * small, k.y + Math.sin(ang) * 2 * small, k.elev, 0.55 * small,
                  bias - 0.01, false, 0.55 * small, false, k.idx);
      });
    } else if (art && k.rocket <= 0 && !k.falling && k.item) {
      if (ORBITS.has(k.item)) {
        circle(art, k.uses, 0.45, 0.8); // every shot of a triple puck or orb circles the kart
      } else if (k.item === "oil3") {
        for (let n = 0; n < k.uses; n++) { // three barrels trailing in a line
          const back = 1.7 + n * 1.1;
          billboard(art, k.x - c * back, k.y - sn * back, k.elev, 0.03, bias - 0.02 + n * 0.01, false, 0.7 * small, false, k.idx);
        }
      } else if (k.trailing) {
        billboard(art, k.x - c * 1.7, k.y - sn * 1.7, k.elev, 0.03, bias - 0.02, false, 0.8 * small, false, k.idx);
      } else {
        // (a kart is about 0.8 m tall to the top of the helmet)
        billboard(art, k.x, k.y, k.elev, (1.0 + 0.05 * Math.sin(now * 4 + k.id)) * small, bias - 0.03, false, 0.8 * small, false, k.idx);
        if (k.item === "triple") circle(art, Math.max(0, k.uses - 1), 0.6, 0.64);
        if (k.item === "boomerang") circle(art, Math.max(0, k.uses - 1), 0.6, 0.64);
      }
    }
    // the grabber rides in front of the kart, and lunges when it bites
    if (k.grab > 0 && look.grabber && !k.falling) {
      const lunge = k.bite > 0 ? Math.sin((k.bite / 0.3) * Math.PI) * 1.6 : 0;
      const frame = k.bite > 0.15 ? 1 : k.bite > 0 ? 2 : 0;
      const ahead = (1.9 + lunge) * small;
      billboard(look.grabber[frame], k.x + c * ahead, k.y + sn * ahead, k.elev, 0.25 * small, bias - 0.04, false, small, false, k.idx);
    }
  }
  const all: { z: number; draw: () => void }[] = [...items, ...faces];
  all.sort((a, b) => b.z - a.z);
  for (const it of all) it.draw();
}

const LAVA_GLOW = hex("#ff6a1a");
const SPLASH = ["#fff0a0", "#ffb03a", "#ff6a1a", "#c2300c"].map(hex);
type Projected = { z: number; sx: number; gy: number; ppm: number; rot?: number };
type Project = (x: number, y: number, h?: number) => Projected | null;
type Push = (q: Projected, z: number, draw: () => void) => void;

/** Where a kart went into the lava: blobs of lava thrown up on short arcs, then a puff of smoke
 * that rises and spreads as it thins. */
function lavaSplash(k: Kart, project: Project, push: Push, scr: Screen, now: number): void {
  const u = k.fall;
  if (u > 1.5) return;
  for (let j = 0; j < 14; j++) {
    const t = u - (j % 5) * 0.035;
    if (t <= 0) continue;
    const a = j * 2.39996 + k.id, out = 1.6 + (j % 4) * 1.1, vz = 4 + (j % 3) * 1.8;
    const z = k.fallZ + vz * t - 9 * t * t;
    if (z < k.fallZ) continue; // fallen back into the lake
    const q = project(k.fallX + Math.cos(a) * out * t, k.fallY + Math.sin(a) * out * t, z);
    if (!q) continue;
    const c = SPLASH[Math.min(SPLASH.length - 1, Math.floor(t * 5))];
    const r = Math.max(1, Math.round(q.ppm * (j % 3 ? 0.11 : 0.16)));
    push(q, q.z, () => scr.fillRect(Math.round(q.sx - r / 2), Math.round(q.gy - r / 2), r, r, c));
  }
  for (let j = 0; j < 5; j++) {
    const t = u - 0.12 - j * 0.1;
    if (t <= 0) continue;
    const q = project(k.fallX + Math.cos(j * 2.1) * 0.5 * t, k.fallY + Math.sin(j * 2.1) * 0.5 * t, k.fallZ + 0.3 + t * 1.8);
    if (!q) continue;
    const r = q.ppm * (0.3 + t * 0.55), a = Math.max(0, 0.6 - t * 0.45);
    push(q, q.z - 0.01, () => puff(scr, q.sx + Math.sin(now * 3 + j) * 0.1 * q.ppm, q.gy, r, a));
  }
}

/** Drops thrown up as a kart goes in, in the colours of what it went into (lava with smoke over
 * it; water, sand; a hole throws up dust). */
function splash(k: Kart, project: Project, push: Push, scr: Screen, now: number): void {
  if (k.fallKind === "lava") {
    lavaSplash(k, project, push, scr, now);
    return;
  }
  const colors = SPLASHES[k.fallKind] ?? DUST, u = k.fall;
  if (u > 1.2) return;
  for (let j = 0; j < 12; j++) {
    const t = u - (j % 4) * 0.04;
    if (t <= 0) continue;
    const a = j * 2.39996 + k.id, out = 1.4 + (j % 4) * 0.9, vz = 3.5 + (j % 3) * 1.6;
    const z = k.fallZ + vz * t - 9 * t * t;
    if (z < k.fallZ) continue;
    const q = project(k.fallX + Math.cos(a) * out * t, k.fallY + Math.sin(a) * out * t, z);
    if (!q) continue;
    const c = colors[Math.min(colors.length - 1, Math.floor(t * 4))];
    const r = Math.max(1, Math.round(q.ppm * (j % 3 ? 0.1 : 0.15)));
    push(q, q.z, () => scr.fillRect(Math.round(q.sx - r / 2), Math.round(q.gy - r / 2), r, r, c));
  }
}

const WATER = ["#ffffff", "#bfe6ff", "#63a7e6", "#2f6fb0"].map(hex);
const DUST = ["#e8e2d4", "#b9ad94", "#8a7f6a", "#5a5244"].map(hex);
const SPLASHES: Partial<Record<FallKind, number[]>> = {
  pond: WATER, trench: WATER, quicksand: ["#f0cf94", "#d9a35b", "#b07b44", "#7a5430"].map(hex),
  canal: ["#ffffff", "#ffc1e3", "#5fd3e6", "#2f6fb0"].map(hex),
  chasm: ["#e6e7ec", "#b3b4b8", "#8d8e93", "#5a5c66"].map(hex),
};

/** The rescue drone: comes down with the kart hanging under it on a cable, lets it go just over
 * the road, and flies off. */
function rescueDrone(k: Kart, art: SceneryArt[], project: Project, push: Push, scr: Screen, now: number,
                     lowBias: number): void {
  if (k.fall < FALL_SWAP || k.fall >= FALL_END) return;
  const gone = k.fall >= FALL_RELEASE;
  // (it hovers 1.3 m over the kart's floor while carrying, then climbs away from where it let go; a
  // kart on its roof in the tube it comes down to first, and hooks by its underside, uppermost)
  const x = gone ? k.dropX : k.x, y = gone ? k.dropY : k.y;
  const base = gone ? k.dropZ + 0.55 + (k.fall - FALL_RELEASE) * 7 : k.elev;
  const air = gone ? null : k.inside;
  const top = air ? 0.05 + 0.75 * Math.max(0, Math.cos(air.roll)) : 0.8; // the top of the kart, over its wheels
  const coming = air ? Math.max(0, 1 - (k.fall - FALL_SWAP) / (WALL_GRAB - FALL_SWAP)) : 0;
  const over = top + 0.5 + coming * 3.5;
  const q = project(x, y, base + over);
  if (!q) return;
  const sp = art[Math.floor(now * 20) % art.length];
  const h = sp.height * q.ppm, w = (h * sp.sprite.w) / sp.sprite.h;
  const hook = gone ? null : project(x, y, base + (coming > 0 ? over - 0.5 : top)); // (still coming: its hook hangs)
  push(q, q.z + (base > 1 ? -0.5 : lowBias) - 0.04, () => {
    if (hook) { // the cable: steel, with a dark edge so it reads over the road and the lava
      const cw = Math.max(1, Math.round(q.ppm * 0.035)), cx = Math.round(q.sx - cw / 2);
      for (let yy = Math.round(q.gy); yy < Math.round(hook.gy); yy++) {
        scr.fillRect(cx - 1, yy, cw + 2, 1, hex("#1a1c22"));
        scr.fillRect(cx, yy, cw, 1, hex("#c9d1de"));
      }
    }
    scr.blitScaled(sp.sprite, q.sx - w / 2, q.gy - h, w, h);
  });
}

/** A soft round puff of smoke. */
function puff(scr: Screen, cx: number, cy: number, r: number, alpha: number): void {
  const buf = scr.buf, c = hex("#4a3c3c");
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    if (y < 0 || y >= H) continue;
    const half = Math.sqrt(Math.max(0, r * r - (y - cy) ** 2));
    for (let x = Math.floor(cx - half); x <= cx + half; x++) {
      if (x >= 0 && x < W) buf[y * W + x] = mix(buf[y * W + x], c, alpha);
    }
  }
}

function shadow(scr: Screen, cx: number, cy: number, rx: number, ry: number, a = 0): void {
  const buf = scr.buf;
  if (a) { // turned on the screen with the surface it lies on (round the tube)
    const c = Math.cos(a), sn = Math.sin(a), R = Math.max(rx, ry);
    for (let y = Math.floor(cy - R); y <= cy + R; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = Math.floor(cx - R); x <= cx + R; x++) {
        if (x < 0 || x >= W) continue;
        const dx = x - cx, dy = y - cy, u = dx * c + dy * sn, v = dy * c - dx * sn;
        if ((u / rx) ** 2 + (v / ry) ** 2 <= 1) buf[y * W + x] = mix(buf[y * W + x], 0xff000000, 0.35);
      }
    }
    return;
  }
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    if (y < 0 || y >= H) continue;
    const half = rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / ry) ** 2));
    for (let x = Math.floor(cx - half); x <= cx + half; x++) {
      if (x < 0 || x >= W) continue;
      buf[y * W + x] = mix(buf[y * W + x], 0xff000000, 0.35);
    }
  }
}

function drawSparks(scr: Screen, cx: number, gy: number, ppm: number, level: number, dir: number): void {
  const colors = level === 2 ? [0xff2b8cff, 0xff63c8ff, 0xffffffff] : [0xffffb347, 0xffffe0a0, 0xffffffff];
  const t = performance.now() / 60;
  for (let k = 0; k < 7; k++) {
    const side = k & 1 ? 1 : -1;
    const x = cx + side * 0.75 * ppm + Math.sin(t + k * 1.7) * 0.4 * ppm - dir * 0.2 * ppm;
    const y = gy - (0.1 + ((t * 0.37 + k * 0.29) % 0.6)) * ppm;
    const c = colors[k % 3];
    const r = Math.max(1, Math.round(ppm * 0.06));
    scr.fillRect(x - r / 2, y - r / 2, r, r, c);
  }
}

const FLAME = ["#fff6c8", "#ffd23f", "#ff8a1f", "#ff4d2e"].map(hex);
const VAPOUR = hex("#f2f6ff");

/** A wing tip's vapour trail: from (x, y), thinning out along (dx, dy) on the screen, in dots
 * ``size`` pixels across. */
function vapour(scr: Screen, x: number, y: number, dx: number, dy: number, size: number): void {
  const n = Math.max(3, Math.min(24, Math.round(Math.hypot(dx, dy) / Math.max(1.5, size))));
  for (let k = 1; k <= n; k++) {
    const u = k / n;
    scr.dimRect(Math.round(x + dx * u - size / 2), Math.round(y + dy * u - size / 2), size, size, VAPOUR, 0.7 * (1 - u * 0.85));
  }
}

/** Exhaust fire: small flickering sparks that cool from white to red as they stream away,
 * more of them for the flamethrower and a plume for a rocket. */
function drawFlames(scr: Screen, cx: number, cy: number, ppm: number, size: number): void {
  const t = performance.now() / 50;
  const n = 5 + size * 5;
  const spread = 0.12 + 0.1 * size;
  for (let k = 0; k < n; k++) {
    const u = (t * 0.23 + k * 0.618) % 1; // age of this spark
    const x = cx + Math.sin(t * 0.9 + k * 2.4) * spread * ppm * (0.4 + u);
    const y = cy + u * 0.18 * ppm * size - Math.cos(t * 0.6 + k) * 0.06 * ppm;
    const r = Math.max(1, Math.round(ppm * (0.035 + 0.02 * size) * (1.2 - u)));
    scr.fillRect(x - r / 2, y - r / 2, r, r, FLAME[Math.min(FLAME.length - 1, Math.floor(u * FLAME.length))]);
  }
}
