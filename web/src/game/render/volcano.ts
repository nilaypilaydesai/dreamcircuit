// Inside the volcano: embers rising through the air on the heat of the lava, flickering as they
// go, and the lava's warm light coming up from the bottom of the view.

import { H, Rand, W, hex, mix, type Screen } from "../core/gfx";

const EMBER = [hex("#ffe08a"), hex("#ffb03a"), hex("#ff6a1a"), hex("#d8360e")];
const GLOW = hex("#ff5a14");

/** Embers and the lava's glow, drawn over the whole view at time ``t``. */
export function emberOverlay(scr: Screen, t: number): void {
  const buf = scr.buf;
  // the glow: strongest at the bottom edge, gone by a third of the way up
  const from = Math.round(H * 0.66);
  for (let y = from; y < H; y++) {
    const a = 0.1 * ((y - from) / (H - from)) ** 1.5;
    for (let x = 0, i = y * W; x < W; x++, i++) buf[i] = mix(buf[i], GLOW, a);
  }
  const rng = new Rand(11);
  for (let k = 0; k < 52; k++) {
    const x0 = rng.next() * W, speed = 9 + rng.next() * 24, off = rng.next() * (H + 40);
    const big = rng.next() > 0.82, phase = rng.next() * 6.3;
    const y = Math.round(H + 20 - ((t * speed + off) % (H + 40)));
    const x = Math.round(x0 + Math.sin(t * 1.3 + phase) * 5 + Math.sin(t * 3.7 + k) * 1.5);
    if (x < 1 || x >= W - 2 || y < 1 || y >= H - 2) continue;
    // each ember cools as it rises, and flickers
    const heat = Math.min(EMBER.length - 1, Math.floor((1 - y / H) * 3 + (Math.sin(t * 11 + phase) > 0.6 ? 0 : 1)));
    const c = EMBER[heat];
    buf[y * W + x] = mix(buf[y * W + x], c, 0.9);
    if (big) {
      buf[y * W + x + 1] = mix(buf[y * W + x + 1], c, 0.6);
      buf[(y + 1) * W + x] = mix(buf[(y + 1) * W + x], c, 0.6);
    }
  }
}
