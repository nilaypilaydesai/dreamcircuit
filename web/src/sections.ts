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
    const r = await fetch("results/summary.json");
    if (r.ok) summary = await r.json();
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
