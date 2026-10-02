// The circuit designer, live. A masked-conditional diffusion model (ONNX, WASM backend) dreams
// polar radius profiles; during lap 1 it generates the road ahead of the race leader one arc at
// a time, conditioned on everything already built, and finally closes the loop. The circuit
// then locks: laps 2 and 3 run on exactly the same road. Mirrors live_generate() in
// src/dreamcircuit/trackgen/train.py.

import * as ort from "onnxruntime-web/wasm";
import { exclusive } from "../../ort-queue";
import { Rand } from "../core/gfx";
import { N, Track, checkGuess } from "./track";

export interface DesignerInfo {
  file: string;
  n: number;
  sigma_min: number;
  sigma_max: number;
  rho: number;
  sigma_data: number;
  r_mean: number;
  r_std: number;
}

export const INITIAL: [number, number] = [-12, 24]; // grid + first stretch, before the countdown
export const CHUNK = 16;
export const LOOKAHEAD = 34; // polar samples of road kept ahead of the leader (~27% of a lap)
const STEPS = 24; // Heun steps (47 network calls) per arc
const ARC_SMOOTH = 1.0; // light smoothing of new radii (angle samples): no too-tight wiggles
const RETRIES = 3;

// Yield to the renderer between network calls. A hidden page draws nothing and gets no animation
// frames (and its timers are throttled), so there the sampler simply runs on to finish the arc.
const nextFrame = (): Promise<void> => {
  if (typeof document !== "undefined" && document.hidden) return Promise.resolve();
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
};

function gaussian(rng: Rand): number {
  let u = 0;
  while (u === 0) u = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

export class CircuitDesigner {
  private constructor(private readonly session: ort.InferenceSession, readonly info: DesignerInfo) {}

  static async create(baseUrl: string): Promise<CircuitDesigner> {
    // Main-thread WASM: the model is tiny, and during a race sample() yields a frame between
    // network calls so dreaming the next arc never stalls the game.
    const meta = await fetch(`${baseUrl}/trackgen.json`);
    if (!meta.ok) throw new Error(`could not load the circuit designer (${meta.status})`);
    const info = (await meta.json()) as DesignerInfo;
    const res = await fetch(`${baseUrl}/${info.file}`);
    if (!res.ok) throw new Error(`could not load the circuit designer (${res.status})`);
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    return new CircuitDesigner(session, info);
  }

  sigmas(steps: number): number[] {
    const { sigma_min: lo0, sigma_max: hi0, rho } = this.info;
    const lo = lo0 ** (1 / rho), hi = hi0 ** (1 / rho);
    const out: number[] = [];
    for (let i = 0; i < steps; i++) out.push((hi + (i / (steps - 1)) * (lo - hi)) ** rho);
    out.push(0);
    return out;
  }

  private async denoise(x: Float32Array, sigma: number, mask: Float32Array,
                        known: Float32Array): Promise<Float32Array> {
    const n = this.info.n;
    const feeds = {
      x: new ort.Tensor("float32", x, [1, 1, n]),
      sigma: new ort.Tensor("float32", Float32Array.of(sigma), [1]),
      mask: new ort.Tensor("float32", mask, [1, 1, n]),
      known: new ort.Tensor("float32", known, [1, 1, n]),
    };
    const out = await exclusive(() => this.session.run(feeds));
    return out.x0.data as Float32Array;
  }

  /** Heun sampler (EDM Algorithm 1). ``onStep`` receives the running x0 estimate. */
  async sample(mask: Float32Array, known: Float32Array, rng: Rand,
               onStep?: (x0: Float32Array, frac: number) => void,
               pace = false): Promise<Float32Array> {
    const n = this.info.n;
    const sig = this.sigmas(STEPS);
    let x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = gaussian(rng) * sig[0];
    for (let i = 0; i < STEPS; i++) {
      const s = sig[i], s1 = sig[i + 1];
      if (pace) await nextFrame();
      const x0 = await this.denoise(x, s, mask, known);
      onStep?.(x0, (i + 1) / STEPS);
      const d = new Float32Array(n);
      const xn = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        d[k] = (x[k] - x0[k]) / s;
        xn[k] = x[k] + (s1 - s) * d[k];
      }
      if (s1 > 0) {
        if (pace) await nextFrame();
        const x02 = await this.denoise(xn, s1, mask, known);
        for (let k = 0; k < n; k++) {
          const d2 = (xn[k] - x02[k]) / s1;
          xn[k] = x[k] + (s1 - s) * 0.5 * (d[k] + d2);
        }
      }
      x = xn;
    }
    for (let k = 0; k < n; k++) if (mask[k] > 0) x[k] = known[k];
    return x;
  }

  toMeters(u: ArrayLike<number>): Float64Array {
    const r = new Float64Array(u.length);
    for (let i = 0; i < u.length; i++) r[i] = u[i] * this.info.r_std + this.info.r_mean;
    return r;
  }

  toStandard(r: ArrayLike<number>): Float32Array {
    const u = new Float32Array(r.length);
    for (let i = 0; i < r.length; i++) u[i] = (r[i] - this.info.r_mean) / this.info.r_std;
    return u;
  }
}

export interface LiveStats {
  arcs: number;
  retries: number;
  fallbacks: number;
  ms: number;
}

/** Generates a Track arc by arc, paced by the race leader, then locks it. */
export class LiveCircuit {
  readonly track = new Track();
  /** The designer's current full guess (meters), drawn faintly on the minimap. */
  preview: Float64Array | null = null;
  denoise = 0; // progress of the arc being dreamed, 0..1
  busy = false;
  stats: LiveStats = { arcs: 0, retries: 0, fallbacks: 0, ms: 0 };
  onCommit: ((from: number, to: number) => void) | null = null;
  onLock: (() => void) | null = null;
  private readonly arcs: number[][] = [];
  private readonly mask = new Float32Array(N);
  private readonly known = new Float32Array(N);

  constructor(private readonly designer: CircuitDesigner, private readonly rng: Rand) {
    const [a, b] = INITIAL;
    this.arcs.push(range(a, b));
    for (let p = b; p < N + a; p += CHUNK) this.arcs.push(range(p, Math.min(p + CHUNK, N + a)));
  }

  get remainingArcs(): number {
    return this.arcs.length;
  }

  /** True if the designer kept failing mid-race and the lap was closed from its last guess. */
  closedWithoutDesigner = false;
  private failures = 0; // arcs in a row that failed to generate

  /** Generate the grid and the opening stretch (awaited before the countdown). */
  async start(): Promise<void> {
    for (let attempt = 0; attempt < 3 && this.stats.arcs === 0; attempt++) await this.next();
    if (this.stats.arcs === 0) throw new Error("the circuit designer could not dream the opening stretch");
  }

  /** Call every frame with the leader's polar segment; dreams the next arc when needed. */
  update(leaderSeg: number): void {
    if (this.busy || this.arcs.length === 0) return;
    const ahead = (this.track.frontierSeg - leaderSeg + N) % N;
    if (ahead < LOOKAHEAD) void this.next().catch((e) => console.error("could not commit an arc", e));
  }

  private async next(): Promise<void> {
    const arc = this.arcs.shift();
    if (!arc) return;
    this.busy = true;
    const t0 = performance.now();
    try {
      let chosen: Float32Array;
      try {
        chosen = await this.dream(arc);
      } catch (e) {
        // Keep the race alive: put the arc back for the next frame to retry, and after a few
        // failures in a row close the lap from the designer's last guess.
        console.error("the circuit designer failed on an arc", e);
        this.arcs.unshift(arc);
        this.failures += 1;
        if (this.failures >= 3 && this.stats.arcs > 0) this.closeFromGuess();
        return;
      }
      this.failures = 0;
      this.stats.arcs += 1;
      this.stats.ms += performance.now() - t0;
      this.commit(arc, chosen);
    } finally {
      this.busy = false;
      this.denoise = 0;
    }
  }

  /** Sample an arc until it passes the checks in context (or the retries run out). */
  private async dream(arc: number[]): Promise<Float32Array> {
    const arcSet = new Set(arc);
    const pace = this.stats.arcs > 0; // the opening arc runs flat out, before the countdown
    for (let attempt = 0; ; attempt++) {
      const sample = await this.designer.sample(this.mask, this.known, this.rng, (x0, frac) => {
        this.preview = this.designer.toMeters(x0);
        this.denoise = frac;
      }, pace);
      const smoothed = smoothArc(sample, arc, ARC_SMOOTH);
      if (checkGuess(this.designer.toMeters(smoothed), arcSet).ok) return smoothed;
      if (attempt < RETRIES) {
        this.stats.retries += 1;
        continue;
      }
      this.stats.fallbacks += 1;
      return smoothArc(sample, arc, 2.0); // last resort: iron out the wiggle and keep racing
    }
  }

  /** Write an arc's samples into the known profile and turn them into road. */
  private commit(arc: number[], c: Float32Array): void {
    for (const j of arc) {
      const k = ((j % N) + N) % N;
      this.known[k] = c[k];
      this.mask[k] = 1;
    }
    this.preview = this.designer.toMeters(c);
    const [from, to] = this.track.addKnown(arc, this.designer.toMeters(this.known));
    if (to > from) this.onCommit?.(from, to);
    if (this.track.locked) this.onLock?.();
  }

  /** The designer failed repeatedly: finish the lap from its last whole-circuit guess. */
  private closeFromGuess(): void {
    const rest = this.arcs.splice(0).flat();
    const guess = this.preview ? this.designer.toStandard(this.preview) : new Float32Array(N);
    const u = Float32Array.from(this.known);
    for (const j of rest) u[j] = guess[j];
    this.closedWithoutDesigner = true;
    this.commit(rest, smoothArc(u, rest, 2.0));
  }
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let j = a; j < b; j++) out.push(((j % N) + N) % N);
  return out;
}

/** Circular Gaussian smoothing of the samples in ``arc`` only (existing road never moves);
 * mirrors smooth_arc() in src/dreamcircuit/trackgen/train.py. */
export function smoothArc(u: Float32Array, arc: number[], sigma: number): Float32Array {
  const w = [-3, -2, -1, 0, 1, 2, 3].map((k) => Math.exp(-0.5 * (k / sigma) ** 2));
  const total = w.reduce((a, b) => a + b, 0);
  const out = Float32Array.from(u);
  for (const j of arc) {
    let v = 0;
    for (let k = -3; k <= 3; k++) v += w[k + 3] * u[(((j + k) % N) + N) % N];
    out[j] = v / total;
  }
  return out;
}
