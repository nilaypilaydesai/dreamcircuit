// Mode-7 ground: every scanline below the horizon is a line across the ground plane at a
// distance set by the camera height and focal length. Sampled nearest-neighbor from the mip
// level that matches each row's footprint, with distance fog into the horizon.

import { H, W, mix, type Screen } from "../core/gfx";
import { isMark, lavaColor } from "../world/lava";
import { RES, type WorldTexture } from "../world/texture";

export interface Camera {
  x: number;
  y: number;
  heading: number; // radians, world frame
  height: number; // m above ground
  focal: number; // px
  horizon: number; // screen row of the horizon
  far: number; // m, draw distance
  lift: number; // m, smoothed height of the ground under the kart being followed
  fx: number; // 0..1, speed effects (wider view, speed lines) while boosting
  clear?: number; // m: scenery nearer than this is not drawn (scripted film cameras only)
}

/** The screen's height relative to the 216 rows the view was composed for: the horizon and the
 * focal length scale with it, so a taller or shorter window keeps the same vertical framing
 * (and a wider one simply sees more to the sides). */
export const viewScale = (): number => H / 216;

export function makeCamera(): Camera {
  return { x: 0, y: 0, heading: 0, height: 2.9, focal: 250 * viewScale(), horizon: Math.round(74 * viewScale()),
           far: 240, lift: 0, fx: 0 };
}

/** Re-frame a camera after the screen changed size. */
export function fitCamera(cam: Camera): void {
  cam.horizon = Math.round(74 * viewScale());
  cam.focal = 250 * viewScale();
}

/** What else the ground shows, at world (x, y). */
export interface GroundFx {
  mist?: (x: number, y: number) => number; // the shimmer at the edge of road not dreamed yet (0..1)
  light?: { color: number; at: (x: number, y: number) => number }; // light on it (the reef's caustics, 0..1)
  lava?: number; // where the lava's colour cycle is (world/lava.ts), for a texture with lava in it
  paint?: (x: number, y: number, c: number) => number; // things lying flat on it (oil slicks)
}

export function drawGround(scr: Screen, cam: Camera, tex: WorldTexture, fog: number, fx: GroundFx = {}): void {
  const cycles = tex.lava, lava = fx.lava ?? 0, { mist, light, paint } = fx, HALF = tex.half;
  const buf = scr.buf;
  const fwx = Math.cos(cam.heading), fwy = Math.sin(cam.heading);
  const rx = Math.sin(cam.heading), ry = -Math.cos(cam.heading); // right of the view direction
  const fogStart = cam.far * 0.45;
  for (let y = cam.horizon + 1; y < H; y++) {
    const dy = y - cam.horizon;
    const z = (cam.height * cam.focal) / dy;
    const row = y * W;
    if (z > cam.far) {
      buf.fill(fog, row, row + W);
      continue;
    }
    // texel footprint of one screen pixel at this distance picks the mip level
    const foot = z / cam.focal / RES;
    const level = Math.max(0, Math.min(tex.levels.length - 1, Math.floor(Math.log2(Math.max(foot, 1)))));
    const data = tex.levels[level];
    const size = tex.size >> level;
    const scale = 1 / (RES * (1 << level));
    const lat = z / cam.focal; // meters per pixel sideways
    const cx = cam.x + fwx * z, cy = cam.y + fwy * z;
    let wx = cx + rx * lat * (0.5 - W / 2);
    let wy = cy + ry * lat * (0.5 - W / 2);
    const sx = rx * lat, sy = ry * lat;
    const fogT = z > fogStart ? Math.min(1, (z - fogStart) / (cam.far - fogStart)) ** 1.5 : 0;
    for (let x = 0; x < W; x++) {
      const tx = ((wx + HALF) * scale) | 0;
      const ty = ((HALF - wy) * scale) | 0;
      let c = tx >= 0 && ty >= 0 && tx < size && ty < size ? data[ty * size + tx] : data[0];
      if (cycles && isMark(c)) c = lavaColor(c, lava);
      if (paint) c = paint(wx, wy, c);
      if (fogT > 0) c = mix(c, fog, fogT);
      const m = mist ? mist(wx, wy) : 0;
      if (m > 0) c = mix(c, 0xffd9a8f5, m);
      if (light) {
        const l = light.at(wx, wy);
        if (l > 0) c = mix(c, light.color, l * (1 - fogT));
      }
      buf[row + x] = c;
      wx += sx;
      wy += sy;
    }
  }
}
