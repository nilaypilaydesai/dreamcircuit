// The circuit designer's sampler, off the main thread. Holds one ONNX Runtime Web session (WASM)
// and runs the whole EDM Heun loop for each request, posting the running whole-circuit guess a
// few times along the way (the minimap shows it) and the finished sample at the end.

import * as ort from "onnxruntime-web/wasm";

interface Info {
  n: number;
  dims: number;
  sigma_min: number;
  sigma_max: number;
  rho: number;
  self_cond?: boolean; // the graph also takes "prev", the sampler's latest estimate
}

export interface SampleRequest {
  kind: "sample";
  id: number;
  mask: Float32Array; // (N)
  known: Float32Array; // (dims * N), network units
  style: number;
  styleOn: number;
  layout: Float32Array; // one-hot (3)
  seed: number;
  steps: number;
}

let session: ort.InferenceSession | null = null;
let info: Info | null = null;

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmas(steps: number, i: Info): number[] {
  const lo = i.sigma_min ** (1 / i.rho), hi = i.sigma_max ** (1 / i.rho);
  const out: number[] = [];
  for (let k = 0; k < steps; k++) out.push((hi + (k / (steps - 1)) * (lo - hi)) ** i.rho);
  out.push(0);
  return out;
}

async function denoise(x: Float32Array, sigma: number, r: SampleRequest, prev: Float32Array): Promise<Float32Array<ArrayBuffer>> {
  const { n, dims } = info!;
  const feeds: Record<string, ort.Tensor> = {
    x: new ort.Tensor("float32", x, [1, dims, n]),
    sigma: new ort.Tensor("float32", Float32Array.of(sigma), [1]),
    mask: new ort.Tensor("float32", r.mask, [1, 1, n]),
    known: new ort.Tensor("float32", r.known, [1, dims, n]),
    style: new ort.Tensor("float32", Float32Array.of(r.style), [1]),
    style_on: new ort.Tensor("float32", Float32Array.of(r.styleOn), [1]),
    layout: new ort.Tensor("float32", r.layout, [1, 3]),
  };
  if (info!.self_cond) feeds.prev = new ort.Tensor("float32", prev, [1, dims, n]);
  const out = await session!.run(feeds);
  return Float32Array.from(out.x0.data as Float32Array);
}

async function sample(r: SampleRequest): Promise<Float32Array> {
  const { n, dims } = info!;
  const m = n * dims;
  const sig = sigmas(r.steps, info!);
  const next = rand(r.seed);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  // the road that already exists starts (and, since the network returns it unchanged, stays)
  // exactly where it is; only the rest begins as noise
  let x = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const noise = gauss() * sig[0];
    x[i] = r.mask[i % n] > 0 ? r.known[i] : noise;
  }
  let prev: Float32Array = new Float32Array(m); // self-conditioning: the latest estimate (none yet)
  for (let k = 0; k < r.steps; k++) {
    const s = sig[k], s1 = sig[k + 1];
    const x0 = await denoise(x, s, r, prev);
    prev = x0;
    if (k % 4 === 3 || k === r.steps - 1) {
      (self as unknown as Worker).postMessage({ kind: "progress", id: r.id, frac: (k + 1) / r.steps, x0 });
    }
    const d = new Float32Array(m), xn = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      d[i] = (x[i] - x0[i]) / s;
      xn[i] = x[i] + (s1 - s) * d[i];
    }
    if (s1 > 0) {
      const x02 = await denoise(xn, s1, r, prev);
      prev = x02;
      for (let i = 0; i < m; i++) xn[i] = x[i] + (s1 - s) * 0.5 * (d[i] + (xn[i] - x02[i]) / s1);
    }
    x = xn;
  }
  // paste the known road back exactly
  for (let c = 0; c < dims; c++) {
    for (let i = 0; i < n; i++) if (r.mask[i] > 0) x[c * n + i] = r.known[c * n + i];
  }
  return x;
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.kind === "init") {
      ort.env.wasm.numThreads = 1; // no cross-origin isolation on static hosting
      info = msg.info as Info;
      session = await ort.InferenceSession.create(new Uint8Array(msg.bytes as ArrayBuffer), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      (self as unknown as Worker).postMessage({ kind: "ready" });
    } else if (msg.kind === "sample") {
      const x = await sample(msg as SampleRequest);
      (self as unknown as Worker).postMessage({ kind: "done", id: msg.id, x }, [x.buffer]);
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({ kind: "error", id: msg.id ?? -1, message: String((e as Error)?.message ?? e) });
  }
};
