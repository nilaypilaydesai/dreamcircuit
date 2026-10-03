// The circuit designer, live. A masked-conditional diffusion model (ONNX, WASM, in a worker)
// dreams laps as N points along the road. During lap 1 it generates the road ahead of the race
// leader one arc at a time, conditioned on everything already built, on the layout asked for
// (any, plain loop, figure-eight) and on a style that follows how the player is driving. Then it
// closes the loop and the circuit locks: laps 2 and 3 run on exactly the same road.
// The network dreams the steps between consecutive road points rather than the points: a new
// arc then starts exactly where the road ends, by construction (see fromSteps).
// Mirrors live_generate() in src/dreamcircuit/trackgen/train.py.

import { Rand } from "../core/gfx";
import type { StyleBand } from "../race/tracktypes";
import { type Layout, N, SCALE, Track, checkLap, loopCurvature, previewLoop } from "./track";

export interface DesignerInfo {
  file: string;
  bytes: number;
  n: number;
  dims: number;
  representation?: string; // "steps": the network dreams steps between road points
  scale: number; // model meters per network unit of a step
  sigma_min: number;
  sigma_max: number;
  rho: number;
  sigma_data: number;
  style_scale?: [number, number]; // raw style at the 5th and 95th percentiles of training arcs
}

export const STEP_SCALE = 2; // model meters per network unit, unless the designer says otherwise
export const STYLE_SCALE: [number, number] = [0, 0.447]; // the exported designer's, unless it says otherwise
const CORNER_REF = 15; // m: a corner this tight counts as fully technical (CORNER_REF in train.py)

export const INITIAL: [number, number] = [-24, 40]; // grid + first stretch, before the countdown
export const CHUNK = 32; // points per arc during lap 1 (about 130 m of game road)
export const LOOKAHEAD = 72; // points of road kept ahead of the leader (~28% of a lap)
const STEPS = 24; // Heun steps (47 network calls) per arc
const ARC_SMOOTH = 1.0; // light smoothing of new points (in point spacings)
const RETRIES = 3;
const ONE_HOT: Record<Layout, number[]> = { any: [1, 0, 0], loop: [0, 1, 0], figure8: [0, 0, 1] };

export interface SampleRequest {
  mask: Float32Array;
  known: Float32Array; // (2, N) network units, x row then y row
  style: number | null; // 0 calm .. 1 wild; null: don't care
  layout: Layout;
  seed: number;
  onStep?: (x0: Float32Array, frac: number) => void;
}

/** What a live circuit needs from a designer (tests use a stand-in). ``sample`` takes and
 * returns steps in network units (x row, then y row); ``scale`` is meters per unit;
 * ``styleScale`` maps measured raw style to the 0..1 style the designer is asked for. */
export interface Designer {
  sample(req: SampleRequest): Promise<Float32Array>;
  readonly scale?: number;
  readonly styleScale?: [number, number];
}

/** How technical the new road in a whole-lap guess (game meters) is, on the designer's own 0..1
 * style scale: the mean over the arc's points of min(1, 15 |curvature|), curvature in model
 * meters as in training, mapped by the scale (the 5th and 95th percentiles of training arcs).
 * Mirrors raw_style() and StyleScale in src/dreamcircuit/trackgen/train.py. */
export function arcStyle(pts: ArrayLike<number>, arc: Set<number>, scale: [number, number] = STYLE_SCALE): number {
  const loop = previewLoop(pts);
  let sum = 0, n = 0;
  for (let i = 0; i < loop.length; i++) {
    if (!arc.has(loop[i][2])) continue;
    sum += Math.min(1, loopCurvature(loop, i, 3) * SCALE * CORNER_REF);
    n += 1;
  }
  const raw = n ? sum / n : 0;
  return Math.max(0, Math.min(1, (raw - scale[0]) / Math.max(scale[1] - scale[0], 1e-6)));
}

/** How far a measured style is outside a band (0 inside it). */
export function bandMiss(style: number, band: StyleBand): number {
  return Math.max(0, band.lo - style, style - band.hi);
}

/** Model meters (x row, y row) -> game meters, interleaved (x0, y0, x1, y1, ...). */
export function toGame(u: ArrayLike<number>): Float64Array {
  const out = new Float64Array(2 * N);
  for (let j = 0; j < N; j++) {
    out[2 * j] = u[j] * SCALE;
    out[2 * j + 1] = u[N + j] * SCALE;
  }
  return out;
}

/** Game meters (interleaved) -> model meters (x row, y row). */
export function toModel(pts: ArrayLike<number>): Float64Array {
  const out = new Float64Array(2 * N);
  for (let j = 0; j < N; j++) {
    out[j] = pts[2 * j] / SCALE;
    out[N + j] = pts[2 * j + 1] / SCALE;
  }
  return out;
}

const wrap = (j: number) => ((j % N) + N) % N;

/** A step (point j to j+1) is known when both of its points are. */
export function stepMask(mask: ArrayLike<number>): Float32Array {
  const out = new Float32Array(N);
  for (let j = 0; j < N; j++) out[j] = mask[j] > 0 && mask[wrap(j + 1)] > 0 ? 1 : 0;
  return out;
}

/** Lap points (model meters, x row then y row) -> the steps between them in network units;
 * steps that are not known (``mask``: points) are left at zero. Mirrors to_steps(). */
export function toSteps(pts: ArrayLike<number>, mask: ArrayLike<number>, scale: number): Float32Array {
  const known = stepMask(mask);
  const out = new Float32Array(2 * N);
  for (let j = 0; j < N; j++) {
    if (!known[j]) continue;
    out[j] = (pts[wrap(j + 1)] - pts[j]) / scale;
    out[N + j] = (pts[N + wrap(j + 1)] - pts[N + j]) / scale;
  }
  return out;
}

/** Steps (network units) -> lap points (model meters). Known points stay where they are; each
 * run of dreamed steps from one known point to the next is corrected evenly so that it lands
 * on the known point at its end; with nothing known, the lap starts at the origin and the
 * closing gap is spread over every step. Mirrors from_steps() in trackgen/model.py. */
export function fromSteps(u: ArrayLike<number>, pts: ArrayLike<number>, mask: ArrayLike<number>,
                          scale: number): Float64Array {
  const out = new Float64Array(2 * N);
  let any = false;
  for (let j = 0; j < N; j++) any ||= mask[j] > 0;
  if (!any) {
    let gx = 0, gy = 0;
    for (let j = 0; j < N; j++) {
      gx += u[j] * scale;
      gy += u[N + j] * scale;
    }
    for (let j = 1; j < N; j++) {
      out[j] = out[j - 1] + u[j - 1] * scale - gx / N;
      out[N + j] = out[N + j - 1] + u[N + j - 1] * scale - gy / N;
    }
    return out;
  }
  for (let j = 0; j < N; j++) {
    if (mask[j] > 0) {
      out[j] = pts[j];
      out[N + j] = pts[N + j];
    }
  }
  for (let s = 0; s < N; s++) {
    if (!(mask[s] > 0) || mask[wrap(s + 1)] > 0) continue; // a run starts at a known point
    const run = [s];
    while (!(mask[wrap(run[run.length - 1] + 1)] > 0)) run.push(wrap(run[run.length - 1] + 1));
    const end = wrap(run[run.length - 1] + 1);
    let sx = 0, sy = 0;
    for (const j of run) {
      sx += u[j] * scale;
      sy += u[N + j] * scale;
    }
    const cx = (pts[end] - pts[s] - sx) / run.length, cy = (pts[N + end] - pts[N + s] - sy) / run.length;
    let px = pts[s], py = pts[N + s];
    for (let k = 1; k < run.length; k++) {
      px += u[run[k - 1]] * scale + cx;
      py += u[N + run[k - 1]] * scale + cy;
      out[run[k]] = px;
      out[N + run[k]] = py;
    }
  }
  return out;
}

export class CircuitDesigner implements Designer {
  private readonly pending = new Map<number, {
    resolve: (x: Float32Array) => void;
    reject: (e: Error) => void;
    onStep?: (x0: Float32Array, frac: number) => void;
  }>();
  private nextId = 1;

  get scale(): number {
    return this.info.scale;
  }

  get styleScale(): [number, number] {
    return this.info.style_scale ?? STYLE_SCALE;
  }

  private constructor(private readonly worker: Worker, readonly info: DesignerInfo) {
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.kind === "progress") p.onStep?.(m.x0 as Float32Array, m.frac as number);
      else if (m.kind === "done") {
        this.pending.delete(m.id);
        p.resolve(m.x as Float32Array);
      } else if (m.kind === "error") {
        this.pending.delete(m.id);
        p.reject(new Error(m.message));
      }
    };
  }

  static async create(baseUrl: string): Promise<CircuitDesigner> {
    const meta = await fetch(`${baseUrl}/trackgen.json`);
    if (!meta.ok) throw new Error(`could not load the circuit designer (${meta.status})`);
    const info = (await meta.json()) as DesignerInfo;
    if (info.representation !== "steps") {
      throw new Error("this circuit designer predates the steps representation: re-export it");
    }
    const res = await fetch(`${baseUrl}/${info.file}`);
    if (!res.ok) throw new Error(`could not load the circuit designer (${res.status})`);
    const bytes = await res.arrayBuffer();
    const worker = new Worker(new URL("./designer.worker.ts", import.meta.url), { type: "module" });
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent) => {
        if (ev.data.kind === "ready") resolve();
        else if (ev.data.kind === "error") reject(new Error(ev.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || "the designer worker failed to start"));
      worker.postMessage({ kind: "init", info, bytes }, [bytes]);
    });
    return new CircuitDesigner(worker, info);
  }

  sample(req: SampleRequest): Promise<Float32Array> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStep: req.onStep });
      this.worker.postMessage({
        kind: "sample", id, mask: req.mask, known: req.known, style: req.style ?? 0,
        styleOn: req.style === null ? 0 : 1, layout: Float32Array.from(ONE_HOT[req.layout]),
        seed: req.seed, steps: STEPS,
      });
    });
  }
}

export interface LiveStats {
  arcs: number;
  retries: number;
  fallbacks: number;
  offBand: number; // arcs that never landed in their band (the closest drivable one was kept)
  ms: number;
}

/** Generates a Track arc by arc, paced by the race leader, then locks it. */
export class LiveCircuit {
  readonly track = new Track();
  /** The designer's current whole-circuit guess (game meters), drawn faintly on the minimap. */
  preview: Float64Array | null = null;
  denoise = 0; // progress of the arc being dreamed, 0..1
  busy = false;
  /** The style asked of the arc being dreamed (or last dreamed), for the HUD. */
  style: number | null = null;
  stats: LiveStats = { arcs: 0, retries: 0, fallbacks: 0, offBand: 0, ms: 0 };
  /** The measured style of each arc as it was committed (0..1). */
  readonly styles: number[] = [];
  onCommit: ((from: number, to: number) => void) | null = null;
  onRaise: ((from: number, to: number) => void) | null = null;
  onLock: (() => void) | null = null;
  /** Called before each arc (0 is the grid and first stretch): the style to ask for (null: don't
   * care), and the band its measured style must land in (null: anything drivable). */
  styleSource: ((arc: number) => number | null) | null = null;
  bandSource: ((arc: number) => StyleBand | null) | null = null;
  /** True if the designer kept failing mid-race and the lap was closed from its last guess. */
  closedWithoutDesigner = false;
  private failures = 0; // arcs in a row that failed to generate
  private readonly arcs: number[][] = [];
  private readonly mask = new Float32Array(N); // which points are road
  private readonly known = new Float64Array(2 * N); // the road so far, model meters
  private readonly scale: number;
  private readonly styleScale: [number, number];

  constructor(private readonly designer: Designer, private readonly rng: Rand,
              readonly layout: Layout = "any") {
    this.scale = designer.scale ?? STEP_SCALE;
    this.styleScale = designer.styleScale ?? STYLE_SCALE;
    const [a, b] = INITIAL;
    this.arcs.push(range(a, b));
    for (let p = b; p < N + a; p += CHUNK) this.arcs.push(range(p, Math.min(p + CHUNK, N + a)));
  }

  get remainingArcs(): number {
    return this.arcs.length;
  }

  /** Generate the grid and the opening stretch (awaited before the countdown). */
  async start(): Promise<void> {
    for (let attempt = 0; attempt < 3 && this.stats.arcs === 0; attempt++) await this.next();
    if (this.stats.arcs === 0) throw new Error("the circuit designer could not dream the opening stretch");
  }

  /** Call every frame with the leader's point index; dreams the next arc when needed. */
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
      let chosen: Float64Array;
      try {
        chosen = await this.dream(arc, this.stats.arcs === 0);
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

  /** Sample an arc until it passes the checks in context and lands in its style band (or the
   * retries run out: then the drivable sample closest to the band is kept). */
  private async dream(arc: number[], first: boolean): Promise<Float64Array> {
    const arcSet = new Set(arc);
    const index = this.stats.arcs;
    this.style = this.styleSource?.(index) ?? null;
    const band = this.bandSource?.(index) ?? null;
    const mask = stepMask(this.mask), known = toSteps(this.known, this.mask, this.scale);
    let best: { lap: Float64Array; miss: number; style: number } | null = null;
    for (let attempt = 0; ; attempt++) {
      const sample = await this.designer.sample({
        mask, known, style: this.style, layout: this.layout, seed: this.rng.int(1, 2 ** 31),
        onStep: (x0, frac) => {
          this.preview = toGame(fromSteps(x0, this.known, this.mask, this.scale));
          this.denoise = frac;
        },
      });
      const lap = fromSteps(sample, this.known, this.mask, this.scale);
      const smoothed = smoothArc(lap, arc, ARC_SMOOTH);
      const game = toGame(smoothed);
      if (checkLap(game, arcSet, this.layout, first).ok) {
        const style = arcStyle(game, arcSet, this.styleScale);
        const miss = band ? bandMiss(style, band) : 0;
        if (miss === 0) return this.measured(smoothed, style);
        if (!best || miss < best.miss) best = { lap: smoothed, miss, style };
      }
      if (attempt < RETRIES) {
        this.stats.retries += 1;
        continue;
      }
      if (best) {
        this.stats.offBand += 1;
        return this.measured(best.lap, best.style);
      }
      this.stats.fallbacks += 1;
      const ironed = smoothArc(lap, arc, 2.0); // last resort: iron out the wiggle and keep racing
      return this.measured(ironed, arcStyle(toGame(ironed), arcSet, this.styleScale));
    }
  }

  private measured(lap: Float64Array, style: number): Float64Array {
    this.styles.push(style);
    return lap;
  }

  /** Write an arc's points (model meters) into the known lap and turn them into road. */
  private commit(arc: number[], c: ArrayLike<number>): void {
    for (const j of arc) {
      const k = wrap(j);
      this.known[k] = c[k];
      this.known[N + k] = c[N + k];
      this.mask[k] = 1;
    }
    this.preview = toGame(c);
    const [from, to] = this.track.addKnown(arc, toGame(this.known));
    if (this.track.raised) this.onRaise?.(this.track.raised[0], this.track.raised[1]);
    if (to > from) this.onCommit?.(from, to);
    if (this.track.locked) this.onLock?.();
  }

  /** The designer failed repeatedly: finish the lap from its last whole-circuit guess. */
  private closeFromGuess(): void {
    const rest = this.arcs.splice(0).flat();
    const guess = this.preview ? toModel(this.preview) : new Float64Array(2 * N);
    const u = Float64Array.from(this.known);
    for (const j of rest) {
      u[j] = guess[j];
      u[N + j] = guess[N + j];
    }
    this.closedWithoutDesigner = true;
    this.commit(rest, smoothArc(u, rest, 2.0));
  }
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let j = a; j < b; j++) out.push(((j % N) + N) % N);
  return out;
}

/** Circular Gaussian smoothing of the points in ``arc`` only, both coordinate rows (existing
 * road never moves); mirrors smooth_arc() in src/dreamcircuit/trackgen/train.py. */
export function smoothArc(u: ArrayLike<number>, arc: number[], sigma: number): Float64Array {
  const w = [-3, -2, -1, 0, 1, 2, 3].map((k) => Math.exp(-0.5 * (k / sigma) ** 2));
  const total = w.reduce((a, b) => a + b, 0);
  const out = Float64Array.from(u);
  const rows = u.length / N;
  for (let r = 0; r < rows; r++) {
    for (const j of arc) {
      let v = 0;
      for (let k = -3; k <= 3; k++) v += w[k + 3] * u[r * N + ((((j + k) % N) + N) % N)];
      out[r * N + j] = v / total;
    }
  }
  return out;
}
