// The sky's art (race/air.ts), drawn pixel by pixel like everything else: an airliner side on, the
// balloons that mark out either side of the course, clouds, the specks of an updraft rising, and
// oil let go in the air, a cloud of black smoke.

import { type Sprite, hex, makeSprite, shade } from "../core/gfx";
import type { SceneryArt } from "./sprites";

const px = (s: Sprite, x: number, y: number, c: number) => {
  if (x >= 0 && y >= 0 && x < s.w && y < s.h) s.data[(y | 0) * s.w + (x | 0)] = c;
};
const rect = (s: Sprite, x0: number, y0: number, x1: number, y1: number, c: number) => {
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(s.h, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(s.w, Math.round(x1)); x++) s.data[y * s.w + x] = c;
  }
};
const blob = (s: Sprite, cx: number, cy: number, rx: number, ry: number, c: (x: number, y: number, d: number) => number) => {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1) px(s, x, y, c(x, y, d));
    }
  }
};
/** A dark line round everything drawn, as every sprite in the game has. */
function outline(s: Sprite, color: number): void {
  const src = s.data.slice();
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (src[y * s.w + x] >>> 24) continue;
      const near = (dx: number, dy: number) => {
        const a = x + dx, b = y + dy;
        return a >= 0 && b >= 0 && a < s.w && b < s.h && src[b * s.w + a] >>> 24 !== 0;
      };
      if (near(1, 0) || near(-1, 0) || near(0, 1) || near(0, -1)) s.data[y * s.w + x] = color;
    }
  }
}

const LIVERY = [hex("#2f6fd8"), hex("#d8402e"), hex("#1f9e7a"), hex("#7b4fd8")];

/** An airliner side on, nose to the right: a long white fuselage with a stripe in its airline's
 * colour and a row of windows, a tall fin at the back, the near wing swept back under it with two
 * engines hung from it, and a red beacon on top that blinks (two frames). About 30 m long. */
export function airlinerArt(): SceneryArt[][] {
  return LIVERY.map((paint) => [0, 1].map((f): SceneryArt => {
    const s = makeSprite(150, 44);
    const white = hex("#f4f6fa"), shadow = hex("#c9d0dc"), glass = hex("#1d2a44"), metal = hex("#9aa3b2");
    // the fin and the tailplane
    for (let y = 2; y < 20; y++) rect(s, 6 + (20 - y) * 0.35, y, 22 + (20 - y) * 0.2, y + 1, y < 6 ? shade(paint, 1.2) : paint);
    rect(s, 2, 18, 24, 21, shade(paint, 0.85));
    // the fuselage: rounded at the nose, tapering up to the tail
    for (let x = 10; x < 146; x++) {
      const top = x < 30 ? 16 + (30 - x) * 0.12 : x > 132 ? 16 + (x - 132) * 0.32 : 16;
      const bottom = x < 30 ? 30 - (30 - x) * 0.42 : x > 136 ? 30 - (x - 136) * 0.6 : 30;
      for (let y = Math.round(top); y < Math.round(bottom); y++) px(s, x, y, y > bottom - 4 ? shadow : white);
    }
    rect(s, 14, 24, 140, 26, paint); // the stripe
    for (let x = 36; x < 128; x += 4) rect(s, x, 19, x + 2, 21, glass); // windows
    rect(s, 134, 18, 141, 21, glass); // the cockpit
    // the near wing, swept back, and its two engines
    for (let y = 27; y < 37; y++) rect(s, 62 + (y - 27) * 1.6, y, 96 + (y - 27) * 0.8, y + 1, y > 34 ? shadow : hex("#e2e7ef"));
    for (const ex of [70, 90]) {
      rect(s, ex, 31, ex + 14, 37, metal);
      rect(s, ex + 11, 31, ex + 14, 37, hex("#2a2f38")); // its intake
    }
    if (f === 0) rect(s, 78, 13, 81, 16, hex("#ff3030")); // the beacon
    outline(s, hex("#101018"));
    return { sprite: s, height: 8.2, solid: false };
  }));
}

/** A balloon that marks the edge of the course: blue on its left, orange on its right, a little
 * shine on it and a string hanging below, bobbing (two frames). */
export function balloonArt(): { left: SceneryArt[]; right: SceneryArt[] } {
  const make = (c: number) => [0, 1].map((f): SceneryArt => {
    const s = makeSprite(14, 24);
    blob(s, 7, 7, 6, 7, (x, y) => (x < 6 && y < 5 ? shade(c, 1.35) : y > 10 ? shade(c, 0.8) : c));
    px(s, 7, 14, shade(c, 0.7));
    for (let y = 15; y < 24; y++) px(s, 7 + (f && y % 4 < 2 ? 1 : 0), y, hex("#e8e8ee"));
    outline(s, hex("#101018"));
    return { sprite: s, height: 2.4, solid: false };
  });
  return { left: make(hex("#3b8cff")), right: make(hex("#ff8a1f")) };
}

/** A cloud: a heap of puffs, lit from above, grey underneath (three shapes). */
export function cloudArt(): SceneryArt[] {
  return [0, 1, 2].map((v) => {
    const s = makeSprite(100, 46);
    const puffs = [[22, 30, 18, 13], [44, 22, 22, 17], [68, 26, 20, 14], [84, 32, 13, 10], [50, 34, 34, 11]];
    for (const [cx, cy, rx, ry] of puffs) {
      const ox = v === 1 ? -6 : v === 2 ? 4 : 0;
      blob(s, cx + ox * (cx / 50), cy - (v === 2 && cx > 40 ? 4 : 0), rx, ry, (_x, y) =>
        y > 36 ? hex("#c9d6e6") : y > 28 ? hex("#e6eef8") : hex("#ffffff"));
    }
    return { sprite: s, height: 16, solid: false };
  });
}

/** A speck of air rising in an updraft, a short pale streak, bright at its head. (Taller, a crowd of
 * them read as white sticks standing in the air.) */
export function updraftArt(): SceneryArt {
  const s = makeSprite(1, 6);
  for (let y = 0; y < 6; y++) px(s, 0, y, y < 2 ? hex("#ffffff") : hex("#cfeeff"));
  return { sprite: s, height: 0.55, solid: false };
}

/** Oil let go in the sky: it hangs in the air as a cloud of black smoke (two frames, churning). */
export function smokeArt(): SceneryArt[] {
  return [0, 1].map((f) => {
    const s = makeSprite(28, 22);
    for (const [cx, cy, r] of [[9, 12, 7], [17, 9, 7], [19, 15, 6], [12, 16, 6]]) {
      blob(s, cx + (f ? 1 : 0), cy - (f ? 1 : 0), r, r * 0.9, (x, y) => ((x + y + f) % 5 === 0 ? hex("#3a3442") : hex("#18151d")));
    }
    outline(s, hex("#060508"));
    return { sprite: s, height: 3, solid: false };
  });
}
