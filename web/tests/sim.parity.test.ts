// The TypeScript simulator must reproduce the Python simulator: same physics trajectory, same
// track localization, same pixels. Golden data comes from `dreamcircuit export-web`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { SimConfig, SpriteData } from "../src/sim/config";
import { CarEnv } from "../src/sim/env";
import { decodePng } from "../src/sim/png";
import { Track } from "../src/sim/track";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p));
const golden = JSON.parse(read("tests/fixtures/golden.json").toString());
const cfg: SimConfig = JSON.parse(read("public/assets/sim_config.json").toString());
const sprite: SpriteData = JSON.parse(read("public/assets/sprite.json").toString());
const nodeInflate = async (d: Uint8Array) => new Uint8Array(inflateSync(d));

async function loadTrack(): Promise<Track> {
  return Track.load("public/assets/tracks", golden.track, nodeInflate,
                    async (url) => { const b = read(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
}

describe("PNG decoder", () => {
  it("decodes the track texture to the expected size", async () => {
    const img = await decodePng(new Uint8Array(read(`public/assets/tracks/${golden.track}.png`)), nodeInflate);
    expect(img.channels).toBe(3);
    expect(img.width * img.height).toBeGreaterThan(500_000);
  });
});

describe("simulator parity with Python", () => {
  const cars = golden.init_state.length as number;
  const steps = golden.actions.length as number;

  it("reproduces vehicle trajectories and localization", async () => {
    const track = await loadTrack();
    for (let c = 0; c < cars; c++) {
      const env = new CarEnv(track, cfg, sprite);
      env.setState(golden.init_state[c], golden.init_idx[c]);
      let maxErr = 0;
      for (let t = 0; t < steps; t++) {
        const [steer, pedal] = golden.actions[t][c];
        env.step(steer, pedal);
        const want: number[] = golden.states[t + 1][c];
        for (let k = 0; k < 7; k++) maxErr = Math.max(maxErr, Math.abs(env.state[k] - want[k]));
        expect(env.idx).toBe(golden.idx[t + 1][c]);
      }
      expect(maxErr).toBeLessThan(1e-9); // observed: ~1e-15 (machine precision)
    }
  });

  it("renders the same frames", async () => {
    const track = await loadTrack();
    let total = 0, mismatched = 0, worst = 0;
    for (let c = 0; c < cars; c++) {
      for (const k of golden.frame_steps as number[]) {
        const env = new CarEnv(track, cfg, sprite);
        env.setState(golden.states[k][c], golden.idx[k][c]);
        const got = env.render();
        const want = Buffer.from(golden.frames[String(k)][c], "base64");
        for (let i = 0; i < want.length; i++) {
          const d = Math.abs(got[i] - want[i]);
          total++;
          if (d !== 0) mismatched++;
          worst = Math.max(worst, d);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
    expect(mismatched / total).toBeLessThan(1e-4); // observed: 0 of 258,048 bytes differ
  });
});
