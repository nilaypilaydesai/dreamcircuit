// Press Start 2P (OFL) rasterized once into 1-bit 8x8 glyphs, then blitted into the framebuffer
// with optional outline and drop shadow: hard-edged retro text at any integer scale.

import "@fontsource/press-start-2p/400.css";
import { type Screen, W, H } from "./gfx";

const CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

export interface TextStyle {
  scale?: number;
  color?: number;
  outline?: number; // packed color, 0 = none
  shadow?: number; // packed color, 0 = none
  align?: "left" | "center" | "right";
  rows?: number[]; // per-glyph-row colors (8): vertical gradients for logos
}

export class PixelFont {
  private readonly glyphs = new Map<string, Uint8Array>();

  static async load(): Promise<PixelFont> {
    try {
      await document.fonts.load('8px "Press Start 2P"');
    } catch {
      // falls back to the browser's monospace; text stays legible, just less retro
    }
    const f = new PixelFont();
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    for (const ch of CHARS) {
      ctx.clearRect(0, 0, 8, 8);
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textBaseline = "top";
      ctx.fillStyle = "#fff";
      ctx.fillText(ch, 0, 0);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      const m = new Uint8Array(64);
      for (let i = 0; i < 64; i++) m[i] = d[4 * i + 3] > 110 ? 1 : 0;
      f.glyphs.set(ch, m);
    }
    return f;
  }

  width(text: string, scale = 1): number {
    return text.length * 8 * scale;
  }

  private glyph(screen: Screen, m: Uint8Array, x: number, y: number, s: number, color: number,
                rows?: number[]) {
    const buf = screen.buf;
    for (let gy = 0; gy < 8; gy++) {
      const c = rows ? rows[gy] : color;
      for (let gx = 0; gx < 8; gx++) {
        if (!m[gy * 8 + gx]) continue;
        for (let py = 0; py < s; py++) {
          const yy = y + gy * s + py;
          if (yy < 0 || yy >= H) continue;
          for (let px = 0; px < s; px++) {
            const xx = x + gx * s + px;
            if (xx >= 0 && xx < W) buf[yy * W + xx] = c;
          }
        }
      }
    }
  }

  draw(screen: Screen, text: string, x: number, y: number, style: TextStyle = {}): void {
    const s = style.scale ?? 1;
    const color = style.color ?? 0xffffffff;
    const w = this.width(text, s);
    let x0 = Math.round(x);
    if (style.align === "center") x0 = Math.round(x - w / 2);
    else if (style.align === "right") x0 = Math.round(x - w);
    const y0 = Math.round(y);
    const passes: [number, number, number, boolean][] = [];
    if (style.shadow) passes.push([s, s, style.shadow, false]);
    if (style.outline) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        passes.push([dx * Math.max(1, s >> 1), dy * Math.max(1, s >> 1), style.outline, false]);
      }
    }
    passes.push([0, 0, color, true]);
    for (const [dx, dy, c, top] of passes) {
      let cx = x0 + dx;
      for (const ch of text) {
        const m = this.glyphs.get(ch) ?? this.glyphs.get("?")!;
        this.glyph(screen, m, cx, y0 + dy, s, c, top ? style.rows : undefined);
        cx += 8 * s;
      }
    }
  }
}

/** Draw text into a sprite (for painted signage such as the start gantry banner). */
export function drawTextToSprite(f: PixelFont, s: { w: number; h: number; data: Uint32Array },
                                 text: string, x: number, y: number, color: number): void {
  // render through a tiny proxy screen whose buffer is the sprite's own pixels
  const proxy = { buf: new Uint32Array(W * H) } as unknown as Screen;
  f.draw(proxy, text, 0, 0, { color });
  const w = f.width(text);
  for (let yy = 0; yy < 8; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const c = proxy.buf[yy * W + xx];
      const dx = x + xx, dy = y + yy;
      if (c && dx >= 0 && dy >= 0 && dx < s.w && dy < s.h) s.data[dy * s.w + dx] = c;
    }
  }
}
