// The retro framebuffer: everything in the game is drawn into one low-resolution pixel buffer
// (about 216 rows, SNES-like density), then scaled up by a whole number with nearest-neighbor so
// every pixel stays crisp. The buffer takes the window's shape, so the game fills the screen:
// W and H change when the window does (ES module bindings are live, so readers see the new size).

export let W = 384;
export let H = 216;

const ROWS = 225; // the framebuffer height the integer scale aims for
const MIN_ROWS = 180; // fewer rows than this crowds the HUD
const MIN_W = 320, MAX_W = 800, MAX_H = 300;

/** Framebuffer size and display scale for a window of ``vw`` x ``vh`` CSS pixels. A whole-number
 * scale makes the buffer cover the window edge to edge (at most scale-1 px is cropped), picked so
 * the buffer is as close to ROWS tall as it can be; a window narrower than MIN_W game pixels (a
 * phone held upright) fits the width and leaves bands above and below, and very wide windows are
 * capped at MAX_W. */
export function screenSize(vw: number, vh: number): { w: number; h: number; scale: number } {
  if (!(vw > 0 && vh > 0)) return { w: 384, h: 216, scale: 1 };
  const lo = Math.max(1, Math.floor(vh / ROWS)), hi = lo + 1;
  let scale = vh / hi >= MIN_ROWS && Math.abs(vh / hi - ROWS) < Math.abs(vh / lo - ROWS) ? hi : lo;
  let w = Math.ceil(vw / scale), h = Math.ceil(vh / scale);
  if (w < MIN_W) {
    scale = vw / MIN_W;
    w = MIN_W;
    h = Math.min(MAX_H, Math.floor(vh / scale));
  }
  return { w: Math.min(w, MAX_W), h, scale };
}

/** Pack an opaque color for the little-endian Uint32 view of ImageData (0xAABBGGRR). */
export const rgb = (r: number, g: number, b: number): number =>
  (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

export const hex = (s: string): number => {
  const v = parseInt(s.replace("#", ""), 16);
  return rgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
};

export const channels = (c: number): [number, number, number] => [c & 255, (c >> 8) & 255, (c >> 16) & 255];

/** Linear blend of two packed colors, t in [0, 1]. */
export function mix(a: number, b: number, t: number): number {
  const ar = a & 255, ag = (a >> 8) & 255, ab = (a >> 16) & 255;
  const br = b & 255, bg = (b >> 8) & 255, bb = (b >> 16) & 255;
  return rgb(ar + (br - ar) * t | 0, ag + (bg - ag) * t | 0, ab + (bb - ab) * t | 0);
}

export const shade = (c: number, f: number): number => {
  const [r, g, b] = channels(c);
  return rgb(Math.min(255, r * f) | 0, Math.min(255, g * f) | 0, Math.min(255, b * f) | 0);
};

export interface Sprite {
  w: number;
  h: number;
  data: Uint32Array; // 0 = transparent
}

export function makeSprite(w: number, h: number): Sprite {
  return { w, h, data: new Uint32Array(w * h) };
}

/** Run ``draw`` against a framebuffer of ``w`` x ``h`` of its own (the renderers read W and H as
 * they draw): a rear-view mirror. The screen it is given has the drawing methods, no canvas. */
export function drawSized(w: number, h: number, buf: Uint32Array, draw: (scr: Screen) => void): void {
  const w0 = W, h0 = H;
  W = w;
  H = h;
  try {
    const scr = Object.create(Screen.prototype) as Screen;
    scr.buf = buf;
    draw(scr);
  } finally {
    W = w0;
    H = h0;
  }
}

export class Screen {
  readonly ctx: CanvasRenderingContext2D;
  image!: ImageData;
  buf!: Uint32Array;
  /** Called after the framebuffer changes size (cameras and skies depend on it). */
  onResize: (() => void) | null = null;
  /** A pinned size (the film tool records at exactly 384x216), or null to follow the window. */
  private pinned: [number, number] | null = null;
  /** While set, sprites and rectangles are drawn turned ``a`` radians (clockwise) about (x, y): a
   * kart up the wall of the tunnel's tube, seen from the floor. */
  pivot: { x: number; y: number; a: number } | null = null;

  /** Where (x, y) goes, turned about the pivot. */
  private turned(x: number, y: number): [number, number] {
    const p = this.pivot!, c = Math.cos(p.a), s = Math.sin(p.a), dx = x - p.x, dy = y - p.y;
    return [p.x + dx * c - dy * s, p.y + dx * s + dy * c];
  }

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.alloc(W, H);
    window.addEventListener("resize", () => this.fit());
    window.visualViewport?.addEventListener("resize", () => this.fit());
    this.fit();
  }

  private alloc(w: number, h: number): void {
    W = w;
    H = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.buf = new Uint32Array(this.image.data.buffer);
  }

  /** Size the framebuffer to the window and scale it up to cover it. */
  fit(): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = this.pinned
      ? { w: this.pinned[0], h: this.pinned[1], scale: Math.min(vw / this.pinned[0], vh / this.pinned[1]) }
      : screenSize(vw, vh);
    if (s.w !== W || s.h !== H) {
      this.alloc(s.w, s.h);
      this.onResize?.();
    }
    this.canvas.style.width = `${Math.round(s.w * s.scale)}px`;
    this.canvas.style.height = `${Math.round(s.h * s.scale)}px`;
  }

  /** Pin the framebuffer to one size (null: follow the window again). */
  pin(size: [number, number] | null): void {
    this.pinned = size;
    this.fit();
  }

  present(): void {
    this.ctx.putImageData(this.image, 0, 0);
  }

  clear(color: number): void {
    this.buf.fill(color);
  }

  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    if (this.pivot) [x, y] = this.turned(x + w / 2, y + h / 2).map((v, k) => v - (k ? h : w) / 2) as [number, number];
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(W, (x + w) | 0), y1 = Math.min(H, (y + h) | 0);
    for (let yy = y0; yy < y1; yy++) this.buf.fill(color, yy * W + x0, yy * W + x1);
  }

  /** Alpha-blend a rectangle (dims the scene behind HUD panels). */
  dimRect(x: number, y: number, w: number, h: number, color: number, alpha: number): void {
    if (this.pivot) [x, y] = this.turned(x + w / 2, y + h / 2).map((v, k) => v - (k ? h : w) / 2) as [number, number];
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(W, (x + w) | 0), y1 = Math.min(H, (y + h) | 0);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = yy * W + xx;
        this.buf[i] = mix(this.buf[i], color, alpha);
      }
    }
  }

  /** Blit a sprite at integer scale-free size (1:1) with transparency. */
  blit(s: Sprite, x: number, y: number, flip = false): void {
    x |= 0;
    y |= 0;
    for (let sy = 0; sy < s.h; sy++) {
      const dy = y + sy;
      if (dy < 0 || dy >= H) continue;
      for (let sx = 0; sx < s.w; sx++) {
        const dx = x + sx;
        if (dx < 0 || dx >= W) continue;
        const c = s.data[sy * s.w + (flip ? s.w - 1 - sx : sx)];
        if (c) this.buf[dy * W + dx] = c;
      }
    }
  }

  /** Nearest-neighbor scaled blit; (x, y) is the destination top-left, (w, h) the size. ``ghost``
   * leaves every other pixel out, in a checkerboard: see-through, the 16-bit way. */
  blitScaled(s: Sprite, x: number, y: number, w: number, h: number, flip = false,
             tint = 0, tintAmount = 0, clipBottom = H, ghost = false): void {
    if (w < 1 || h < 1) return;
    if (this.pivot && this.pivot.a) {
      this.blitTurned(s, x, y, w, h, flip, tint, tintAmount, ghost);
      return;
    }
    const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(W, Math.ceil(x + w));
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(clipBottom, Math.ceil(y + h));
    const kx = s.w / w, ky = s.h / h;
    for (let dy = y0; dy < y1; dy++) {
      const sy = Math.min(s.h - 1, ((dy - y + 0.5) * ky) | 0);
      if (sy < 0) continue;
      const row = sy * s.w;
      for (let dx = x0; dx < x1; dx++) {
        if (ghost && ((dx + dy) & 1) === 0) continue;
        let sx = ((dx - x + 0.5) * kx) | 0;
        if (sx < 0 || sx >= s.w) continue;
        if (flip) sx = s.w - 1 - sx;
        const c = s.data[row + sx];
        if (c) this.buf[dy * W + dx] = tintAmount > 0 ? mix(c, tint, tintAmount) : c;
      }
    }
  }
  /** blitScaled's rectangle turned about the pivot: every pixel of its turned outline looks back
   * into the sprite. */
  private blitTurned(s: Sprite, x: number, y: number, w: number, h: number, flip: boolean, tint: number,
                     tintAmount: number, ghost: boolean): void {
    const p = this.pivot!, c = Math.cos(p.a), sn = Math.sin(p.a);
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const [qx, qy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
      const [rx, ry] = this.turned(qx, qy);
      bx0 = Math.min(bx0, rx); bx1 = Math.max(bx1, rx); by0 = Math.min(by0, ry); by1 = Math.max(by1, ry);
    }
    const x0 = Math.max(0, Math.floor(bx0)), x1 = Math.min(W, Math.ceil(bx1));
    const y0 = Math.max(0, Math.floor(by0)), y1 = Math.min(H, Math.ceil(by1));
    const kx = s.w / w, ky = s.h / h;
    for (let dy = y0; dy < y1; dy++) {
      for (let dx = x0; dx < x1; dx++) {
        if (ghost && ((dx + dy) & 1) === 0) continue;
        const ox = dx + 0.5 - p.x, oy = dy + 0.5 - p.y;
        const ux = p.x + ox * c + oy * sn, uy = p.y - ox * sn + oy * c; // back to the unturned frame
        let sx = ((ux - x) * kx) | 0;
        const sy = ((uy - y) * ky) | 0;
        if (sx < 0 || sy < 0 || sx >= s.w || sy >= s.h || ux < x || uy < y) continue;
        if (flip) sx = s.w - 1 - sx;
        const col = s.data[sy * s.w + sx];
        if (col) this.buf[dy * W + dx] = tintAmount > 0 ? mix(col, tint, tintAmount) : col;
      }
    }
  }

}

/** Small, fast, seedable PRNG (mulberry32). */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
}

/** Cheap deterministic 2-D hash noise in [0, 1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) at a given cell size. */
export function valueNoise(x: number, y: number, cell: number, seed = 0): number {
  const gx = x / cell, gy = y / cell;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
