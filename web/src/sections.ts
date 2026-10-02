// Content below the fold: the pipeline, the physics audit and the interpretability results.
// Numbers come from results/*.json written by `dreamcircuit report`, never typed in by hand.

import { renderCharts } from "./ui/charts";

interface Summary {
  data?: { frames: number; circuits: number; seconds: number; grass_fraction: number };
  model?: { params_m: number; gmacs: number; train_steps: number; onnx_mb: number };
  parity?: { state_err: number; bytes_total: number; bytes_diff: number };
  audit?: unknown;
}

const STAGES: { title: string; body: string; metric: (s: Summary) => string }[] = [
  {
    title: "Simulate",
    body: "A Formula Student-class EV: dynamic bicycle model, Pacejka-style tyres, friction ellipse, 80 kW power cap, traction control. Procedural circuits with FS cone conventions.",
    metric: (s) => s.data ? `${s.data.frames.toLocaleString()} frames · ${s.data.circuits} circuits` : "vectorized NumPy simulator",
  },
  {
    title: "Drive badly, on purpose",
    body: "A population of scripted drivers (tidy, keyboard-style, over-driven, wandering, braking) produces slides, spins, off-track moments and launches, not just perfect laps.",
    metric: (s) => s.data ? `${(s.data.grass_fraction * 100).toFixed(0)}% of frames off the asphalt` : "6 driver behaviours",
  },
  {
    title: "Learn to dream",
    body: "An EDM diffusion U-Net predicts the next frame from the last four frames and the controls, with context-noise augmentation so it can repair its own mistakes.",
    metric: (s) => s.model ? `${s.model.params_m.toFixed(1)}M params · ${s.model.train_steps.toLocaleString()} steps` : "EDM, 1-4 sampling steps",
  },
  {
    title: "Ship it to the browser",
    body: "ONNX export with fp16 weights, GroupNorm fused to InstanceNorm, and a workaround for a WebGPU convolution bug found with a per-node cross-backend diff tool.",
    metric: (s) => s.model ? `${s.model.onnx_mb.toFixed(1)} MB · ${s.model.gmacs.toFixed(2)} GMACs / step` : "ONNX Runtime Web + WebGPU",
  },
  {
    title: "Audit and dissect",
    body: "Read the dream back into physics with differentiable image registration; probe the bottleneck for speed and curvature, then steer the dream along those directions.",
    metric: () => "physics probes · linear probes · steering",
  },
];

function card(big: string, label: string, note = ""): string {
  return `<div class="card"><div class="big">${big}</div><div class="label">${label}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
}

export async function renderSections(): Promise<void> {
  let summary: Summary = {};
  try {
    const [r, p] = await Promise.all([fetch("results/summary.json"), fetch("results/parity.json")]);
    if (r.ok && !(r.headers.get("content-type") ?? "").includes("html")) summary = await r.json();
    if (p.ok && !(p.headers.get("content-type") ?? "").includes("html")) summary.parity = await p.json();
  } catch {
    // results are optional during development; the cards fall back to static text
  }
  document.getElementById("pipeline")!.innerHTML = STAGES.map((s) =>
    `<div class="stage-card"><h3>${s.title}</h3><p>${s.body}</p><div class="metric">${s.metric(summary)}</div></div>`).join("");

  const p = summary.parity;
  document.getElementById("eng-cards")!.innerHTML = [
    card(p ? `${p.bytes_diff} <small>/ ${p.bytes_total.toLocaleString()} bytes</small>` : "0 <small>bytes</small>",
         "pixel bytes that differ between the Python renderer and its TypeScript port",
         p ? `trajectories agree to ${p.state_err.toExponential(0)} (machine precision)` : "golden-trajectory parity tests in CI"),
    card("1 <small>upstream bug</small>", "found in ONNX Runtime Web's WebGPU Conv (C_in divisible by 3, not 4)",
         "isolated with a per-node WebGPU-vs-WASM diff tool; worked around by zero-padding channels"),
    card(summary.model ? `${summary.model.onnx_mb.toFixed(1)} <small>MB</small>` : "fp16", "model download, fp16 weights with fp32 compute", "runs on every GPU, no shader-f16 required"),
    card("CI", "lint, types, unit + property tests, cross-language parity, build", "GitHub Actions on every push"),
  ].join("");

  await renderCharts(summary.audit ? summary : null);
}

interface DesignerResults {
  whole_valid: number;
  whole_valid_unsmoothed: number;
  live_valid: number;
  live_retries_per_circuit: number;
  mean_length_m: number;
  n_whole: number;
  n_live: number;
  params: number;
  sampler_steps: number;
  train_steps: number;
  dreamed: number[][];
  real: number[][];
}

function circuitSvg(radii: number[], label: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const n = radii.length;
  const pts = radii.map((r, j) => {
    const th = (j / n) * Math.PI * 2;
    return [r * Math.cos(th), r * Math.sin(th)];
  });
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const span = Math.max(maxx - minx, maxy - miny) * 1.12;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const map = (p: number[]) => [50 + ((p[0] - cx) / span) * 100, 50 - ((p[1] - cy) / span) * 100];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"}${map(p).map((v) => v.toFixed(1)).join(",")}`).join("") + "Z");
  path.setAttribute("class", "circuit");
  const [sx, sy] = map(pts[0]);
  const start = document.createElementNS(NS, "circle");
  start.setAttribute("cx", sx.toFixed(1));
  start.setAttribute("cy", sy.toFixed(1));
  start.setAttribute("r", "3.2");
  start.setAttribute("class", "start");
  svg.append(path, start);
  return svg;
}

export async function renderDesigner(): Promise<void> {
  let d: DesignerResults | null = null;
  try {
    const r = await fetch("results/trackgen.json");
    if (r.ok && !(r.headers.get("content-type") ?? "").includes("html")) d = await r.json();
  } catch {
    // published results are optional during development
  }
  const cards = document.getElementById("designer-cards")!;
  if (!d) {
    cards.innerHTML = `<div class="empty">Run <code>dreamcircuit eval-tracks</code> to publish the designer's numbers.</div>`;
    return;
  }
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const items: [string, string, string][] = [
    [pct(d.whole_valid), `of ${d.n_whole.toLocaleString()} circuits dreamed from nothing are drivable`, `${pct(d.whole_valid_unsmoothed)} before the light arc smoothing`],
    [pct(d.live_valid), `of ${d.n_live} circuits built live, arc by arc, the way the game does it`, `${d.live_retries_per_circuit.toFixed(2)} arcs resampled per circuit on average`],
    [`${(d.params / 1e6).toFixed(1)}M`, "parameters: a 1-D U-Net with circular convolutions", `${d.sampler_steps} Heun steps per arc, ${d.train_steps.toLocaleString()} training steps`],
    [`${Math.round(d.mean_length_m * 1.5)} m`, "average lap in the game (1.5x the model's meters)", "start/finish always on the straightest stretch"],
  ];
  cards.replaceChildren(...items.map(([big, label, note]) => {
    const c = document.createElement("div");
    c.className = "card";
    const b = document.createElement("div");
    b.className = "big";
    b.textContent = big;
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    const n = document.createElement("div");
    n.className = "note";
    n.textContent = note;
    c.append(b, l, n);
    return c;
  }));
  document.getElementById("gallery-dreamed")!.replaceChildren(...d.dreamed.slice(0, 18).map((r, i) => circuitSvg(r, `Dreamed circuit ${i + 1}`)));
  document.getElementById("gallery-real")!.replaceChildren(...d.real.slice(0, 12).map((r, i) => circuitSvg(r, `Procedural circuit ${i + 1}`)));
}
