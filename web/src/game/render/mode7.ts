// Mode-7 ground: every scanline below the horizon is a line across the ground plane at a
// distance set by the camera height and focal length. Sampled nearest-neighbor from the mip
// level that matches each row's footprint, with distance fog into the horizon.

import { H, W, mix, type Screen } from "../core/gfx";
import { RES, TEX, HALF, type WorldTexture } from "../world/texture";

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

export function drawGround(scr: Screen, cam: Camera, tex: WorldTexture, fog: number,
                           mist: (x: number, y: number) => number = () => 0): void {
  const buf = scr.buf;
  const fx = Math.cos(cam.heading), fy = Math.sin(cam.heading);
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
    const size = TEX >> level;
    const scale = 1 / (RES * (1 << level));
    const lat = z / cam.focal; // meters per pixel sideways
    const cx = cam.x + fx * z, cy = cam.y + fy * z;
    let wx = cx + rx * lat * (0.5 - W / 2);
    let wy = cy + ry * lat * (0.5 - W / 2);
    const sx = rx * lat, sy = ry * lat;
    const fogT = z > fogStart ? Math.min(1, (z - fogStart) / (cam.far - fogStart)) ** 1.5 : 0;
    for (let x = 0; x < W; x++) {
      const tx = ((wx + HALF) * scale) | 0;
      const ty = ((HALF - wy) * scale) | 0;
      let c = tx >= 0 && ty >= 0 && tx < size && ty < size ? data[ty * size + tx] : data[0];
      if (fogT > 0) c = mix(c, fog, fogT);
      const m = mist(wx, wy);
      if (m > 0) c = mix(c, 0xffd9a8f5, m);
      buf[row + x] = c;
      wx += sx;
      wy += sy;
    }
  }
}
