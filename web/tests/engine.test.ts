// The browser's sampler math must match the Python world model's.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Rng, chwToRgb, karrasSigmas, rgbToChw } from "../src/dream/engine";

const golden = JSON.parse(readFileSync(resolve(__dirname, "fixtures/golden.json")).toString());
const edm = { ...golden.edm, sigma_data: 0.5, aug_max: 0.3 };

describe("EDM sampler", () => {
  it("uses the same Karras noise schedule as Python", () => {
    for (const n of [1, 2, 3, 4]) {
      const want: number[] = golden.sigmas[String(n)];
      const got = karrasSigmas(n, edm);
      expect(got).toHaveLength(want.length);
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 5)); // Python side is float32
    }
  });

  it("ends every schedule at exactly zero noise", () => {
    for (const n of [1, 2, 3, 4]) expect(karrasSigmas(n, edm).at(-1)).toBe(0);
  });
});

describe("frame conversions", () => {
  it("round-trips RGB bytes through CHW floats exactly", () => {
    const rgb = new Uint8Array(64 * 64 * 3).map((_, i) => (i * 37) % 256);
    expect(chwToRgb(rgbToChw(rgb, 64), 64)).toEqual(rgb);
  });

  it("maps 0 and 255 to the model's [-1, 1] range", () => {
    const chw = rgbToChw(new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]), 2);
    expect(Math.min(...chw)).toBe(-1);
    expect(Math.max(...chw)).toBe(1);
  });
});

describe("noise generator", () => {
  it("is deterministic per seed and standard normal", () => {
    const a = new Rng(7), b = new Rng(7);
    const xs = Array.from({ length: 100_000 }, () => a.normal());
    expect(xs.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b.normal()));
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(sd - 1)).toBeLessThan(0.02);
  });
});
