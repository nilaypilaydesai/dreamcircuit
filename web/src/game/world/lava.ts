// Lava, for the volcano. The ground texture marks a lava texel with a phase and a crust level in
// place of a colour, and the Mode-7 renderer looks each mark up in a palette that cycles with
// time (the old colour-cycling trick): the whole lake pulses and flows at the cost of one table
// lookup a pixel. The marks survive into the mip levels, and a kart checks the mark under it to
// know when it has driven off the rock and into the lava.

import { hex, mix } from "../core/gfx";

const MARK = 0x7e; // the alpha byte of a marked texel (every real colour is opaque, 0xff)
export const PHASES = 64;
/** Crust levels: molten lava, a cooled plate floating on it, lava in the shadow of raised road,
 * and the glowing cracks in the rock bank (rock, not lava: safe to drive on). */
export const MOLTEN = 0, CRUST = 1, SHADOW = 2, CRACK = 3;

export const lavaMark = (phase: number, crust: number): number =>
  ((MARK << 24) | ((crust & 3) << 8) | (phase & (PHASES - 1))) >>> 0;
export const isMark = (c: number): boolean => c >>> 24 === MARK;
/** A texel a kart sinks into: lava, crusted or in shadow (a crack in the rock is not). */
export const isLava = (c: number): boolean => c >>> 24 === MARK && ((c >> 8) & 3) !== CRACK;

/** Four palettes of PHASES colours: a slow swell between dark and bright with a thin hot band
 * running through it. */
export const LAVA_LUT: Uint32Array = (() => {
  const lut = new Uint32Array(4 * PHASES);
  for (let k = 0; k < PHASES; k++) {
    const u = k / PHASES;
    const swell = 0.5 + 0.5 * Math.cos(2 * Math.PI * u);
    const d = Math.min(u, 1 - u); // distance to the hot band (it sits at phase 0)
    const band = Math.exp(-((d / 0.07) ** 2));
    const molten = mix(mix(hex("#a3200a"), hex("#ff5a14"), swell), hex("#ffd86a"), band * 0.9);
    lut[MOLTEN * PHASES + k] = molten;
    lut[CRUST * PHASES + k] = mix(mix(hex("#260c0a"), hex("#4f170d"), swell * 0.7), hex("#9a2c10"), band * 0.45);
    lut[SHADOW * PHASES + k] = mix(mix(hex("#4a0f06"), hex("#8a2a0c"), swell), hex("#b8501a"), band * 0.5);
    lut[CRACK * PHASES + k] = mix(mix(hex("#a8300c"), hex("#ff7a1e"), swell), hex("#ffc85a"), band * 0.7);
  }
  return lut;
})();

/** The colour of a marked texel ``c`` with the cycle advanced ``shift`` steps. */
export function lavaColor(c: number, shift: number): number {
  return LAVA_LUT[((c >> 8) & 3) * PHASES + (((c & (PHASES - 1)) + shift) & (PHASES - 1))];
}

/** Where the cycle is at time ``t`` (s): about one full swell every five seconds. */
export const lavaShift = (t: number): number => Math.floor(t * 13) & (PHASES - 1);
