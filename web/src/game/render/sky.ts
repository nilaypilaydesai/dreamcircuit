// A 360-degree parallax backdrop per theme: gradient sky, stars or clouds, a sun, and two hill
// silhouettes that scroll at different rates as the camera turns. Inside the volcano the hills
// are the crater's walls: dark basalt lit red from below, with lava falling down them. Behind
// the building site they are a city's towers, with half-built frames and tower cranes in front;
// on the moon, grey ridges under a black sky with the Earth hanging in it; over Tokyo, lit towers
// at night, a lattice tower, and Fuji far off under the moon.

import { H, Rand, W, hex, mix, shade, type Screen, valueNoise } from "../core/gfx";
import type { Theme } from "../themes";

const PAN = 1536; // panorama width in px for a full turn

export class Sky {
  private readonly far: Uint32Array;
  private readonly near: Uint32Array;
  /** The panorama column the Earth hangs over, on the moon (-1 elsewhere): the trailer points a
   * camera at it. */
  earthAt = -1;
  constructor(readonly theme: Theme, readonly horizon: number, seed: number) {
    const rng = new Rand(seed);
    const h = horizon + 1;
    this.far = new Uint32Array(PAN * h);
    this.near = new Uint32Array(PAN * h);
    const t = theme;
    for (let y = 0; y < h; y++) {
      const c = mix(t.skyTop, t.skyHorizon, (y / h) ** 1.4);
      this.far.fill(c, y * PAN, (y + 1) * PAN);
    }
    if (t.stars) {
      for (let k = 0; k < 220; k++) {
        const x = rng.int(0, PAN), y = rng.int(0, Math.floor(h * 0.7));
        this.far[y * PAN + x] = rng.next() > 0.8 ? 0xffffffff : 0xffc8b8ff;
      }
    }
    if (t.sun) this.drawSun(rng, h);
    if (t.clouds) {
      for (let k = 0; k < 14; k++) this.cloud(rng, rng.int(0, PAN), rng.int(6, Math.floor(h * 0.55)));
    }
    if (t.volcano) {
      this.crater(this.far, rng, h, t.farHills, 0.6, t.farAmp ?? 26, 4, 9);
      this.crater(this.near, rng, h, t.nearHills, 0.84, 13, 5, 0);
      return;
    }
    if (t.skyline === "city") {
      this.city(this.far, rng, h, mix(t.farHills, t.skyHorizon, 0.5), 0.6, (t.farAmp ?? 26) * 1.15);
      this.city(this.far, rng, h, t.farHills, 0.68, t.farAmp ?? 26);
      this.site(this.near, rng, h, t);
      return;
    }
    if (t.skyline === "moon") {
      this.earth(rng, h);
      this.hills(this.far, rng, h, t.farHills, 0.62, t.farAmp ?? 26, 3, true);
      this.hills(this.near, rng, h, t.nearHills, 0.86, 7, 4);
      return;
    }
    if (t.skyline === "tokyo") {
      this.tokyo(rng, h, t);
      return;
    }
    this.hills(this.far, rng, h, t.farHills, 0.62, t.farAmp ?? 26, 3);
    this.hills(this.near, rng, h, t.nearHills, 0.82, 12, 5);
  }

  /** A crater wall: a jagged ridge of basalt in strata, glowing red toward its foot (the lava's
   * light), with ``falls`` streams of lava pouring down it from notches in the rim. */
  private crater(dst: Uint32Array, rng: Rand, h: number, color: number, base: number, amp: number,
                 octaves: number, falls: number): void {
    const comps = Array.from({ length: octaves * 3 }, (_, k) => ({
      f: 1 + rng.int(1, 4 + k * 4), a: rng.range(0.4, 1) / (1 + k * 0.8), p: rng.range(0, Math.PI * 2),
    }));
    const norm = comps.reduce((s, c) => s + c.a, 0);
    const tops = new Int32Array(PAN);
    for (let x = 0; x < PAN; x++) {
      const th = (x / PAN) * Math.PI * 2;
      let v = 0;
      for (const c of comps) v += c.a * Math.sin(c.f * th + c.p);
      const n = 0.3 - 1.2 * Math.abs(v / norm); // ridged: sharp crags
      tops[x] = Math.max(0, Math.floor(h * base - n * amp - amp * 0.4));
      for (let y = tops[x]; y < h; y++) {
        const u = (y - tops[x]) / Math.max(1, h - tops[x]);
        const strata = (y + ((x * 7) >> 5)) % 6 === 0 ? 0.8 : 1;
        dst[y * PAN + x] = y === tops[x] ? shade(color, 1.5)
          : mix(shade(color, strata), hex("#7a2410"), Math.max(0, u - 0.35) * 0.9);
      }
    }
    // lava falls: from a notch in the rim, a bright core with a glow either side, wavering down
    for (let k = 0; k < falls; k++) {
      let x0 = rng.int(0, PAN);
      for (let j = 0; j < 40; j++) { // the lowest point nearby: the notch the lava spills from
        const xx = (x0 + j - 20 + PAN) % PAN;
        if (tops[xx] > tops[x0]) x0 = xx;
      }
      const width = rng.int(1, 3);
      for (let y = tops[x0] + 1; y < h; y++) {
        const wob = Math.round(Math.sin(y * 0.35 + k) * 1.2 + (y - tops[x0]) * 0.04);
        for (let dx = -width - 2; dx <= width + 2; dx++) {
          const x = (x0 + wob + dx + PAN) % PAN;
          if (y < tops[x]) continue;
          const i = y * PAN + x, core = Math.abs(dx) <= width >> 1;
          dst[i] = core ? ((y + k) % 5 === 0 ? hex("#fff0a0") : hex("#ffc04a"))
            : Math.abs(dx) <= width ? hex("#ff6a1a") : mix(dst[i], hex("#d63a10"), 0.45);
        }
      }
      // where it lands, a pool of light at the foot of the wall
      for (let dx = -8; dx <= 8; dx++) {
        for (let y = h - 3; y < h; y++) {
          const i = y * PAN + ((x0 + dx + PAN) % PAN);
          dst[i] = mix(dst[i], hex("#ff8a2a"), 0.5 * (1 - Math.abs(dx) / 9));
        }
      }
    }
  }

  private drawSun(rng: Rand, h: number): void {
    const cx = rng.int(200, PAN - 200), cy = Math.floor(h * 0.62), r = 22;
    for (let y = cy - r - 8; y <= cy + r; y++) {
      for (let x = cx - r - 8; x <= cx + r + 8; x++) {
        if (y < 0 || y >= h) continue;
        const d = Math.hypot(x - cx, y - cy);
        const i = y * PAN + ((x + PAN) % PAN);
        if (d <= r) {
          // synthwave stripes across the lower half of the sun
          const stripe = y > cy && ((y - cy) % 5) < 1 + (y - cy) / 12;
          if (!stripe) this.far[i] = mix(this.theme.sun, 0xffffffff, Math.max(0, (cy - y) / r) * 0.5);
        } else if (d <= r + 8) {
          this.far[i] = mix(this.far[i], this.theme.sun, 0.25 * (1 - (d - r) / 8));
        }
      }
    }
  }

  private cloud(rng: Rand, cx: number, cy: number): void {
    const puffs = rng.int(3, 6);
    for (let p = 0; p < puffs; p++) {
      const px = cx + p * rng.int(7, 11), py = cy - rng.int(0, 4), r = rng.int(4, 8);
      for (let y = py - r; y <= cy + 2; y++) {
        for (let x = px - r; x <= px + r; x++) {
          if (y < 0 || Math.hypot(x - px, y - py) > r) continue;
          const i = y * PAN + ((x + PAN) % PAN);
          this.far[i] = y > cy - 1 ? shade(this.theme.clouds, 0.9) : this.theme.clouds;
        }
      }
    }
  }

  /** A city skyline: a row of towers, glass ones banded with their floors and concrete ones dotted
   * with windows, each lit down one edge, a few with an antenna. */
  private city(dst: Uint32Array, rng: Rand, h: number, color: number, base: number, amp: number): void {
    const set = (x: number, y: number, c: number) => {
      if (y >= 0 && y < h) dst[y * PAN + (((x % PAN) + PAN) % PAN)] = c;
    };
    for (let x = rng.int(0, 12); x < PAN;) {
      const w = rng.int(9, 30), top = Math.floor(h * base - rng.range(0.2, 1) * amp), glass = rng.next() < 0.45;
      for (let dx = 0; dx < w; dx++) {
        for (let y = top; y < h; y++) {
          const r = y - top;
          let c = r === 0 ? shade(color, 1.25) : dx < 2 ? shade(color, 1.16) : dx === w - 1 ? shade(color, 0.85) : color;
          if (r > 1 && dx >= 2 && dx < w - 1 && (glass ? r % 3 === 0 : r % 4 === 2 && dx % 3 === 1)) {
            c = shade(color, glass ? 1.1 : 0.78);
          }
          set(x + dx, y, c);
        }
      }
      if (rng.next() < 0.3) for (let y = top - rng.int(3, 9); y < top; y++) set(x + (w >> 1), y, shade(color, 0.9));
      x += w + rng.int(-3, 9);
    }
  }

  /** In front of the city: heaps of spoil, the frames of buildings going up (columns and floors with
   * the sky between them, a few floors closed in), and tower cranes reaching out over it all. */
  private site(dst: Uint32Array, rng: Rand, h: number, t: Theme): void {
    this.hills(dst, rng, h, shade(t.ground[0], 0.62), 0.92, 5, 3);
    const set = (x: number, y: number, c: number) => {
      if (y >= 0 && y < h) dst[y * PAN + (((x % PAN) + PAN) % PAN)] = c;
    };
    const line = (x0: number, y0: number, x1: number, y1: number, c: number) => {
      const n = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let k = 0; k <= n; k++) set(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), c);
    };
    const ground = h - 2;
    for (let k = 0; k < 8; k++) {
      const x0 = rng.int(0, PAN), w = rng.int(18, 44), floors = rng.int(2, 6), storey = 5, top = ground - floors * storey;
      const closed = rng.int(0, floors - 1); // floors from the bottom with their walls on
      for (let y = top; y < ground; y++) {
        const f = Math.floor((ground - y) / storey);
        for (let dx = 0; dx < w; dx++) {
          const slab = (ground - y) % storey === 0, column = dx % 8 === 0 || dx === w - 1;
          if (slab) set(x0 + dx, y, shade(t.nearHills, 1.2));
          else if (column) set(x0 + dx, y, t.nearHills);
          else if (f < closed) set(x0 + dx, y, (y + dx) % 4 === 0 ? shade(t.nearHills, 1.3) : shade(t.nearHills, 0.8));
        }
      }
    }
    const yellow = hex("#e2a72a"), dark = hex("#9a6f18"), weight = hex("#4a4d55");
    for (let k = 0; k < 6; k++) {
      const x0 = rng.int(0, PAN), top = ground - rng.int(Math.floor(h * 0.45), Math.floor(h * 0.78));
      for (let y = top; y <= ground; y++) { // the mast: a lattice two pixels wide
        set(x0, y, yellow);
        set(x0 + 2, y, yellow);
        if ((y + x0) % 3 === 0) set(x0 + 1, y, dark);
      }
      const dir = rng.next() < 0.5 ? 1 : -1, jib = rng.int(28, 56), counter = rng.int(9, 15), mid = x0 + 1;
      for (let d = 0; d <= jib; d++) { // the jib: a lattice of two chords and a zigzag
        set(mid + dir * d, top, yellow);
        set(mid + dir * d, top + 2, yellow);
        if (d % 2 === 0) set(mid + dir * d, top + 1, dark);
      }
      for (let d = 1; d <= counter; d++) set(mid - dir * d, top, yellow);
      for (let y = top + 1; y <= top + 3; y++) for (let d = counter - 3; d <= counter; d++) set(mid - dir * d, y, weight);
      line(mid, top - 6, mid + dir * Math.round(jib * 0.7), top, dark); // the ties from the apex
      line(mid, top - 6, mid - dir * counter, top, dark);
      for (let y = top + 3; y <= top + 5; y++) for (let d = 1; d <= 3; d++) set(mid + dir * d, y, shade(yellow, 0.8)); // the cab
      const hook = mid + dir * rng.int(10, jib - 2), drop = rng.int(6, Math.max(8, ground - top - 8));
      line(hook, top + 3, hook, top + 3 + drop, weight);
      set(hook - 1, top + 4 + drop, weight);
      set(hook + 1, top + 4 + drop, weight);
    }
  }

  /** Tokyo at night: a full moon over Fuji (its snow catching the moonlight) far off across a low
   * skyline of lit windows, a red and white lattice tower lit up above it all, and nearer towers
   * with neon on their roofs and red lights blinking on top. */
  private tokyo(rng: Rand, h: number, t: Theme): void {
    const far = this.far, set = (dst: Uint32Array, x: number, y: number, c: number) => {
      if (y >= 0 && y < h) dst[y * PAN + (((x % PAN) + PAN) % PAN)] = c;
    };
    // the moon, and Fuji below it to one side
    const mx = rng.int(0, PAN), my = Math.floor(h * 0.22), mr = 7;
    for (let y = my - mr - 5; y <= my + mr + 5; y++) {
      for (let x = mx - mr - 5; x <= mx + mr + 5; x++) {
        const d = Math.hypot(x - mx, y - my);
        if (d <= mr) set(far, x, y, (x * 7 + y * 3) % 11 === 0 && d < mr - 2 ? hex("#d9dbe6") : hex("#f4f2e6"));
        else if (d <= mr + 5 && y >= 0 && y < h) {
          const i = y * PAN + (((x % PAN) + PAN) % PAN);
          far[i] = mix(far[i], hex("#b9b6d8"), 0.3 * (1 - (d - mr) / 5));
        }
      }
    }
    const fx = mx + rng.int(60, 140) * (rng.next() < 0.5 ? 1 : -1), half = 170, peak = Math.floor(h * 0.3);
    for (let x = fx - half; x <= fx + half; x++) {
      const d = Math.abs(x - fx) / half, rise = (h - peak) * Math.min(1, ((1 - d) / 0.96) ** 1.7);
      const top = Math.round(h - rise), snowline = peak + (h - peak) * 0.24 + Math.round(Math.sin(x * 0.9) * 2 + Math.sin(x * 0.37) * 3);
      for (let y = top; y < h; y++) {
        const lit = x < fx ? 1 : 0.84;
        set(far, x, y, y < snowline ? shade(hex("#c9d3ea"), lit) : shade(hex("#262c46"), lit * (1 - 0.3 * ((y - top) / Math.max(1, h - top)))));
      }
    }
    // the lattice tower: a tapering red and white frame, two lit decks, lights up its legs
    const tx = fx + rng.int(220, 520), tTop = Math.floor(h * 0.18), tBase = h;
    for (let y = tTop; y < tBase; y++) {
      const u = (y - tTop) / (tBase - tTop), w = Math.round(1 + u * u * 16);
      const band = Math.floor((y - tTop) / 4) & 1 ? hex("#e8e8ec") : hex("#d8402e");
      for (let dx = -w; dx <= w; dx++) {
        const edge = Math.abs(dx) >= w - 1, lace = (dx + y) % 4 === 0 || (dx - y) % 4 === 0;
        if (edge || lace) set(far, tx + dx, y, edge ? band : shade(band, 0.7));
      }
    }
    for (const [u, w] of [[0.42, 5], [0.62, 8]]) {
      const y = Math.floor(tTop + u * (tBase - tTop));
      for (let dx = -w; dx <= w; dx++) for (let k = 0; k < 2; k++) set(far, tx + dx, y + k, k ? hex("#ffd98a") : hex("#e8e8ec"));
    }
    for (let y = tTop - 6; y < tTop; y++) set(far, tx, y, hex("#e8e8ec"));
    set(far, tx, tTop - 7, hex("#ff2a2a"));
    // the city: a low skyline far off, then nearer and taller towers, every window that is lit a dot
    this.nightCity(far, rng, h, t.farHills, 0.84, 16, 0.28, false);
    this.nightCity(this.near, rng, h, t.nearHills, 0.95, (t.farAmp ?? 26) * 0.95, 0.4, true);
  }

  /** A night skyline: towers of ``color`` side by side (gaps between some), their windows lit (a
   * share ``lit`` of them, warm or cool), a red light on the tall ones, and with ``neon`` a glowing
   * sign on some roofs. */
  private nightCity(dst: Uint32Array, rng: Rand, h: number, color: number, base: number, amp: number, lit: number,
                    neon: boolean): void {
    const set = (x: number, y: number, c: number) => {
      if (y >= 0 && y < h) dst[y * PAN + (((x % PAN) + PAN) % PAN)] = c;
    };
    const signs = [hex("#ff3fa4"), hex("#2de2e6"), hex("#ffd23f"), hex("#9d6bff")];
    for (let x = rng.int(0, 10); x < PAN;) {
      const w = rng.int(neon ? 10 : 6, neon ? 26 : 18), top = Math.floor(h * base - rng.range(0.25, 1) * amp);
      for (let dx = 0; dx < w; dx++) {
        for (let y = top; y < h; y++) {
          const r = y - top, win = r > 1 && dx > 0 && dx < w - 1 && r % 3 === 1 && dx % 2 === 1;
          const c = win && rng.next() < lit ? (rng.next() < 0.65 ? hex("#ffd98a") : hex("#dfe8ff"))
            : dx === 0 ? shade(color, 1.4) : color;
          set(x + dx, y, c);
        }
      }
      if (top < h * base - amp * 0.6) set(x + (w >> 1), top - 1, hex("#ff2a2a"));
      if (neon && rng.next() < 0.35) {
        const c = rng.pick(signs), sw = Math.min(w - 2, rng.int(5, 10));
        for (let dx = 1; dx <= sw; dx++) for (let y = top - 4; y < top - 1; y++) set(x + dx, y, y === top - 3 ? shade(c, 1.3) : c);
      }
      x += w + (rng.next() < 0.3 ? rng.int(3, 12) : 0);
    }
  }

  /** The Earth hanging in the moon's black sky: blue seas, green and brown land, ice at the poles
   * and swirls of cloud, lit from one side with the night side faint, a thin blue rim of air. */
  private earth(rng: Rand, h: number): void {
    const cx = rng.int(120, PAN - 120), cy = Math.floor(h * 0.3), r = 12;
    this.earthAt = cx;
    const lx = 0.78, ly = -0.42, lz = 0.46; // where the sunlight comes from (right, above, in front)
    const seed = rng.int(0, 9999);
    for (let y = cy - r - 2; y <= cy + r + 2; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = cx - r - 2; x <= cx + r + 2; x++) {
        const dx = (x - cx) / r, dy = (y - cy) / r, d2 = dx * dx + dy * dy;
        const i = y * PAN + ((x + PAN) % PAN);
        if (d2 > 1) {
          if (d2 < 1.3 && dx * lx + dy * ly > 0.1) this.far[i] = mix(this.far[i], hex("#6fb6ff"), 0.55 * (1.3 - d2) / 0.3);
          continue;
        }
        const dz = Math.sqrt(1 - d2), lon = Math.atan2(dx, dz), lat = Math.asin(Math.max(-1, Math.min(1, dy)));
        const land = valueNoise(lon * 40, lat * 40, 9, seed) * 0.7 + valueNoise(lon * 40, lat * 40, 4, seed + 1) * 0.3;
        const cloud = valueNoise(lon * 40 + 7, lat * 60, 6, seed + 2);
        let c = Math.abs(lat) > 1.15 ? hex("#eef4ff") : land > 0.56 ? (land > 0.66 ? hex("#a3875a") : hex("#4f8f3c")) : hex("#2a64c8");
        if (cloud > 0.64) c = mix(c, hex("#ffffff"), Math.min(1, (cloud - 0.64) * 5));
        const light = dx * lx + dy * ly + dz * lz;
        this.far[i] = light > 0.05 ? shade(c, 0.5 + 0.7 * Math.min(1, light)) : mix(hex("#04060d"), c, 0.14);
      }
    }
  }

  private hills(dst: Uint32Array, rng: Rand, h: number, color: number, base: number, amp: number,
                octaves: number, ridged = false): void {
    // a periodic 1-D fractal profile: sums of sines with integer frequencies wrap seamlessly
    const comps = Array.from({ length: octaves * 3 }, (_, k) => ({
      f: 1 + rng.int(1, 4 + k * 3), a: rng.range(0.4, 1) / (1 + k), p: rng.range(0, Math.PI * 2),
    }));
    const norm = comps.reduce((s, c) => s + c.a, 0);
    for (let x = 0; x < PAN; x++) {
      const th = (x / PAN) * Math.PI * 2;
      let v = 0;
      for (const c of comps) v += c.a * Math.sin(c.f * th + c.p);
      let n = v / norm;
      // ridges are sharp, a peak wherever the sum crosses zero, not rolling hills
      if (ridged) n = 0.3 - 1.2 * Math.abs(n);
      const top = Math.floor(h * base - n * amp - amp * 0.4);
      for (let y = Math.max(0, top); y < h; y++) {
        dst[y * PAN + x] = y === top ? shade(color, 1.25) : shade(color, 1 - 0.25 * ((y - top) / Math.max(1, h - top)));
      }
    }
  }

  /** Draw the sky for a camera facing ``heading``. ``view``: a smaller view than the one the sky
   * was made for (a rear-view mirror), with its own horizon row, the ratio of the full view's focal
   * length to its own, and the full view's width. */
  draw(scr: Screen, heading: number, view?: { horizon: number; ratio: number; fullW: number }): void {
    const buf = scr.buf;
    const h = this.horizon + 1;
    const off = (layer: number) => Math.floor((-heading / (Math.PI * 2)) * PAN * layer);
    const of = off(1), on = off(1.6);
    if (view) {
      const centre = view.fullW / 2;
      for (let y = 0; y <= Math.min(view.horizon, H - 1); y++) {
        const sy = Math.max(0, Math.min(h - 1, Math.round(this.horizon - (view.horizon - y) * view.ratio)));
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const col = centre + (x - W / 2) * view.ratio;
          const n = this.near[sy * PAN + ((((Math.round(col + on)) % PAN) + PAN) % PAN)];
          buf[row + x] = n || this.far[sy * PAN + ((((Math.round(col + of)) % PAN) + PAN) % PAN)];
        }
      }
      return;
    }
    for (let y = 0; y < Math.min(h, H); y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const n = this.near[y * PAN + ((((x + on) % PAN) + PAN) % PAN)];
        buf[row + x] = n || this.far[y * PAN + ((((x + of) % PAN) + PAN) % PAN)];
      }
    }
  }
}
