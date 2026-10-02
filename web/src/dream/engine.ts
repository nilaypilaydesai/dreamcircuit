// The neural game engine. Holds the last L frames + actions and imagines the next frame with the
// EDM Euler sampler around the exported denoiser D(x; sigma | context, actions).

import * as ort from "onnxruntime-web/webgpu";
import { exclusive } from "../ort-queue";

export interface DenoiserInfo {
  file: string;
  bytes: number;
  context_frames: number;
  mid_channels: number;
  edm: { sigma_min: number; sigma_max: number; rho: number; sigma_data: number; aug_max: number };
}

export type Backend = "webgpu" | "wasm";

/** Small, fast, seedable PRNG (mulberry32) + Box-Muller Gaussian. */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed = 1) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

export function karrasSigmas(steps: number, e: DenoiserInfo["edm"]): number[] {
  if (steps === 1) return [e.sigma_max, 0];
  const lo = e.sigma_min ** (1 / e.rho);
  const hi = e.sigma_max ** (1 / e.rho);
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push((hi + (i / (steps - 1)) * (lo - hi)) ** e.rho);
  out.push(0);
  return out;
}

/** HWC RGB bytes -> CHW float in [-1, 1]. */
export function rgbToChw(rgb: Uint8Array, size: number,
                         out: Float32Array = new Float32Array(3 * size * size)): Float32Array {
  const hw = size * size;
  for (let i = 0; i < hw; i++) {
    out[i] = rgb[3 * i] / 127.5 - 1;
    out[hw + i] = rgb[3 * i + 1] / 127.5 - 1;
    out[2 * hw + i] = rgb[3 * i + 2] / 127.5 - 1;
  }
  return out;
}

/** CHW float in [-1, 1] -> HWC RGB bytes. */
export function chwToRgb(chw: Float32Array, size: number,
                         out: Uint8Array = new Uint8Array(3 * size * size)): Uint8Array {
  const hw = size * size;
  for (let i = 0; i < hw; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (Math.min(Math.max(chw[c * hw + i], -1), 1) + 1) * 127.5;
      out[3 * i + c] = Math.round(v);
    }
  }
  return out;
}

export class DreamEngine {
  readonly L: number;
  readonly size = 64;
  steps = 2;
  augSigma = 0.0;
  readonly midBias: Float32Array;
  /** x0 estimate after each denoising step of the last frame (for the "imagination" strip). */
  trajectory: Float32Array[] = [];
  lastMs = 0;
  private context: Float32Array; // L frames, CHW each, oldest first
  private actions: Float32Array; // L-1 past actions (steer, pedal)
  private readonly rng = new Rng(1234);

  private constructor(private readonly session: ort.InferenceSession, readonly info: DenoiserInfo,
                      readonly backend: Backend) {
    this.L = info.context_frames;
    this.context = new Float32Array(this.L * 3 * this.size * this.size);
    this.actions = new Float32Array((this.L - 1) * 2);
    this.midBias = new Float32Array(info.mid_channels);
  }

  static async create(baseUrl: string, onStatus?: (s: string) => void): Promise<DreamEngine> {
    const meta = await fetch(`${baseUrl}/denoiser.json`);
    if (!meta.ok || (meta.headers.get("content-type") ?? "").includes("html")) {
      throw new Error("the world model is not bundled with this build");
    }
    const info = (await meta.json()) as DenoiserInfo;
    const hasGpu = "gpu" in navigator && !!(await (navigator as any).gpu?.requestAdapter());
    const order: Backend[] = hasGpu ? ["webgpu", "wasm"] : ["wasm"];
    let lastErr: unknown;
    for (const backend of order) {
      try {
        onStatus?.(`loading ${(info.bytes / 1e6).toFixed(1)} MB model on ${backend}...`);
        const session = await ort.InferenceSession.create(`${baseUrl}/${info.file}`, {
          executionProviders: [backend],
          graphOptimizationLevel: "all",
        });
        const engine = new DreamEngine(session, info, backend);
        await engine.warmup();
        return engine;
      } catch (e) {
        lastErr = e;
        console.warn(`backend ${backend} failed`, e);
      }
    }
    throw lastErr;
  }

  private async warmup(): Promise<void> {
    for (let i = 0; i < 2; i++) await this.denoise(new Float32Array(3 * 64 * 64), 1.0);
  }

  /** The dream's own last L frames (CHW floats, oldest first): what an agent "inside" sees. */
  get contextFrames(): Float32Array {
    return this.context;
  }

  /** Seed the dream with real frames (RGB bytes, oldest first) and the L-1 actions between them. */
  setContext(frames: Uint8Array[], actions: [number, number][]): void {
    this.generation += 1; // any frame still being imagined belongs to the old dream
    const n = 3 * this.size * this.size;
    frames.slice(-this.L).forEach((f, i) => rgbToChw(f, this.size, this.context.subarray(i * n, (i + 1) * n)));
    actions.slice(-(this.L - 1)).forEach(([s, p], i) => {
      this.actions[2 * i] = s;
      this.actions[2 * i + 1] = p;
    });
  }

  private async denoise(x: Float32Array, sigma: number, acts?: Float32Array): Promise<Float32Array> {
    const s = this.size;
    const feeds = {
      x: new ort.Tensor("float32", x, [1, 3, s, s]),
      sigma: new ort.Tensor("float32", Float32Array.of(sigma), [1]),
      context: new ort.Tensor("float32", this.context, [1, 3 * this.L, s, s]),
      actions: new ort.Tensor("float32", acts ?? new Float32Array(2 * this.L), [1, this.L, 2]),
      aug_sigma: new ort.Tensor("float32", Float32Array.of(this.augSigma), [1]),
      mid_bias: new ort.Tensor("float32", this.midBias, [1, this.midBias.length]),
    };
    const out = await exclusive(() => this.session.run(feeds));
    return out.x0.data as Float32Array;
  }

  /** Imagine the frame that follows ``(steer, pedal)``; returns it as CHW floats in [-1, 1],
   * or ``null`` if the dream was re-seeded while the frame was being imagined. Calls are
   * serialized: ONNX Runtime Web does not support overlapping runs on one session. */
  step(steer: number, pedal: number): Promise<Float32Array | null> {
    const run = this.queue.then(() => this.stepNow(steer, pedal));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  private async stepNow(steer: number, pedal: number): Promise<Float32Array | null> {
    const t0 = performance.now();
    const gen = this.generation;
    const n = 3 * this.size * this.size;
    const acts = new Float32Array(2 * this.L);
    acts.set(this.actions);
    acts[2 * (this.L - 1)] = steer;
    acts[2 * (this.L - 1) + 1] = pedal;

    const steps = this.steps; // snapshot: the slider may move while this frame is in flight
    const sig = karrasSigmas(steps, this.info.edm);
    let x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = this.rng.normal() * sig[0];
    const trajectory: Float32Array[] = [];
    for (let i = 0; i < steps; i++) {
      const x0 = await this.denoise(x, sig[i], acts);
      if (gen !== this.generation) return null; // re-seeded mid-frame: discard
      trajectory.push(x0);
      if (sig[i + 1] === 0) {
        x = Float32Array.from(x0);
      } else {
        const k = (sig[i + 1] - sig[i]) / sig[i];
        const nx = new Float32Array(n);
        for (let j = 0; j < n; j++) nx[j] = x[j] + (x[j] - x0[j]) * k;
        x = nx;
      }
    }
    for (let j = 0; j < n; j++) x[j] = Math.min(Math.max(x[j], -1), 1);
    this.trajectory = trajectory;

    // Slide the window: drop the oldest frame/action, append the new ones.
    this.context.copyWithin(0, n);
    this.context.set(x, (this.L - 1) * n);
    this.actions.copyWithin(0, 2);
    this.actions[2 * (this.L - 2)] = steer;
    this.actions[2 * (this.L - 2) + 1] = pedal;
    this.lastMs = performance.now() - t0;
    return x;
  }
}
