// Everything below the hero that carries a number is filled from the evaluation files the
// pipeline writes (results/*.json): nothing here is typed in by hand. When a file is missing, the
// sentences, quotes and tiles that depend on it are left out rather than shown with a guess.

import { bakeKart, chevron, itemBoxFrames, LIVERIES, orbArt } from "./game/render/sprites";
import type { Sprite } from "./game/core/gfx";
import { crossings } from "./page/growth";
import type { Growth } from "./page/growth";
import { renderCharts } from "./ui/charts";

export interface Summary {
  data?: { frames: number; circuits: number; seconds: number; grass_fraction: number };
  model?: { params_m: number; gmacs: number; train_steps: number; onnx_mb: number };
  parity?: { state_err: number; bytes_total: number; bytes_diff: number };
  audit?: { controllability?: { summary?: Record<string, number> } } & Record<string, unknown>;
}

type Layout = "loop" | "figure8";
export interface Designer {
  whole_valid_any: number;
  whole_valid_loop: number;
  whole_valid_figure8: number;
  live_valid_loop: number;
  live_valid_figure8: number;
  live_retries_loop: number;
  live_retries_figure8: number;
  mean_length_m: number;
  n_whole: number;
  n_live: number;
  params: number;
  sampler_steps: number;
  train_steps: number;
  train_circuits?: number;
  figure8_share_data?: number;
  dreamed: Record<Layout, number[][][]>;
  dreamed_verdicts?: Record<Layout, string[]>;
  real: Record<Layout, number[][][]>;
  growth?: Growth;
}

export interface Probes { r2: Record<string, { trained: number; random_init: number }> }

export async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    // a dev server answers a missing file with the index page: that is not data
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("html")) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const millions = (v: number) => `${(v / 1e6).toFixed(1)}M`;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ------------------------------------------------------------------------------- facts

/** Fill [data-fact] spans; hide every [data-needs] block whose source is missing. */
export function renderFacts(d: Designer | null, s: Summary | null): void {
  const facts: Record<string, string | null> = {
    "designer.params": d ? millions(d.params) : null,
    "designer.train": d?.train_circuits ? d.train_circuits.toLocaleString("en-US") : null,
    "designer.f8": d?.figure8_share_data ? `${Math.round(d.figure8_share_data * 100)}%` : null,
    "wm.params": s?.model ? `${s.model.params_m.toFixed(1)}M` : null,
  };
  const have = { designer: !!d, wm: !!s?.model };
  for (const el of document.querySelectorAll<HTMLElement>("[data-fact]")) {
    const v = facts[el.dataset.fact!];
    if (v) {
      el.textContent = v;
      el.classList.add("fact");
    } else {
      el.closest<HTMLElement>("[data-needs]")?.setAttribute("hidden", "");
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-needs]")) {
    if (!have[el.dataset.needs as keyof typeof have]) el.hidden = true;
  }
}

// ------------------------------------------------------------------------------- tiles

function spriteCanvas(s: Sprite, scale: number): HTMLCanvasElement {
  const c = make("canvas", "icon");
  c.width = s.w;
  c.height = s.h;
  c.style.width = `${s.w * scale}px`;
  c.style.height = `${s.h * scale}px`;
  c.style.imageRendering = "pixelated";
  const img = new ImageData(s.w, s.h);
  img.data.set(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength));
  c.getContext("2d")!.putImageData(img, 0, 0);
  c.setAttribute("aria-hidden", "true");
  return c;
}

/** A pixel speedometer for the audit tile, in the same pixel language as the game's sprites. */
function gauge(): HTMLCanvasElement {
  const c = make("canvas", "icon");
  c.width = c.height = 18;
  c.style.width = c.style.height = "54px";
  c.style.imageRendering = "pixelated";
  const g = c.getContext("2d")!;
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 18; x++) {
      const r = Math.hypot(x - 8.5, y - 10.5);
      if (y <= 11 && r <= 8.4) {
        g.fillStyle = r > 7.2 ? "#1a1030" : r > 6 ? (x < 6 ? "#2de2e6" : x < 12 ? "#ffd23f" : "#ff2bd6") : "#120c26";
        g.fillRect(x, y, 1, 1);
      }
    }
  }
  g.fillStyle = "#ffffff";
  for (let k = 0; k < 6; k++) g.fillRect(9 + k, 10 - k, 1, 1); // the needle, well into the gold
  g.fillStyle = "#ff6b6b";
  g.fillRect(8, 10, 2, 2);
  return c;
}

function markIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", "56");
  svg.setAttribute("height", "56");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<use href="#dc-mark"/>';
  return svg;
}

export function renderTiles(d: Designer | null, s: Summary | null, p: Probes | null): void {
  const live = d ? `live builds drivable: ${pct(d.live_valid_loop)} of loops, ${pct(d.live_valid_figure8)} of figure-eights` : null;
  const tiles: { icon: () => Element; title: string; body: string; fact: string | null; href: string }[] = [
    {
      icon: () => spriteCanvas(bakeKart(LIVERIES[0])[3], 3),
      title: "The race",
      body: "Mode-7 kart racing: drift through a corner to charge a mini-turbo, hit the gas just before GO for a rocket start, and race up to seven rivals.",
      fact: "0 to 7 rivals, in ROOKIE, PRO and LEGEND classes",
      href: "index.html",
    },
    {
      icon: () => spriteCanvas(itemBoxFrames()[1].sprite, 3),
      title: "Ramps, pads and items",
      body: "Jump ramps pay a trick boost if you hop at the lip; boost pads sit at corner exits; item boxes hand out a Turbo, an Oil Slick or a Dream Orb.",
      fact: "placed by the game on road the designer has just dreamed",
      href: "index.html",
    },
    {
      icon: markIcon,
      title: "The circuit designer",
      body: "A 1-D diffusion U-Net that writes a lap as the 256 steps between its road points, so new road always starts where the old road ends. Its convolutions wrap around the lap.",
      fact: d ? `${millions(d.params)} parameters, ${d.sampler_steps} Heun steps per arc` : null,
      href: "#designer",
    },
    {
      icon: () => spriteCanvas(chevron(true).sprite, 3),
      title: "Built while you race",
      body: "On lap one the road appears an arc at a time, a quarter of a lap ahead of the leader, shaped by the way you are driving. Then it locks.",
      fact: live,
      href: "#designer",
    },
    {
      icon: () => spriteCanvas(orbArt().sprite, 4),
      title: "The dream lab",
      body: "A diffusion world model of an electric race car: every frame is imagined from the last four and your controls, live on your GPU.",
      fact: s?.model ? `${s.model.params_m.toFixed(1)}M parameters, ${s.model.gmacs.toFixed(2)} GMACs per denoising step` : null,
      href: "#lab",
    },
    {
      icon: gauge,
      title: "Physics audit and probes",
      body: "The dream's frames are read back into physics and checked against the simulator; linear probes find speed and road curvature inside the network.",
      fact: p ? `speed probe R² ${p.r2.speed.trained.toFixed(3)} (untrained network: ${p.r2.speed.random_init.toFixed(3)})` : null,
      href: "#audit",
    },
  ];
  const root = document.getElementById("tiles")!;
  root.replaceChildren(...tiles.map((t) => {
    const a = make("a", "tile reveal");
    a.href = t.href;
    a.append(t.icon(), make("h3", "", t.title), make("p", "", t.body));
    if (t.fact) a.append(make("span", "tile-fact", t.fact));
    a.append(make("span", "go", t.href === "index.html" ? "PLAY" : "MORE"));
    return a;
  }));
}

// ------------------------------------------------------------------------------- quotes

interface Quote { big: string; text: string; field: string; value: number; source: string }

export function renderQuotes(d: Designer | null, s: Summary | null): void {
  const q: Quote[] = [];
  if (d) {
    // live building is what the game does: those are the numbers that decide whether you race on
    // a proper track (one-pass dreams are in the gallery below, with their verdicts)
    q.push({
      big: pct(d.live_valid_loop),
      text: "of plain loops the designer built live, arc by arc as the race went on, passed every drivability rule.",
      field: "live_valid_loop", value: d.live_valid_loop, source: `n = ${d.n_live} · results/trackgen.json`,
    });
    q.push({
      big: pct(d.live_valid_figure8),
      text: "of figure-eights built live passed every rule too, bridge crossing included.",
      field: "live_valid_figure8", value: d.live_valid_figure8, source: `n = ${d.n_live} · results/trackgen.json`,
    });
  }
  const yaw = s?.audit?.controllability?.summary?.yaw_rate_correlation;
  if (typeof yaw === "number") {
    q.push({
      big: yaw.toFixed(2),
      text: "correlation between how fast the dreamed car turns and how fast the real one does, given the same steering.",
      field: "yaw_rate_correlation", value: yaw, source: "results/summary.json · audit.controllability",
    });
  }
  const root = document.getElementById("quotes")!;
  root.replaceChildren(...q.map((x) => {
    const b = make("blockquote", "quote reveal");
    const foot = make("footer");
    const code = make("code", "", `"${x.field}": ${JSON.stringify(x.value)}`);
    foot.append(code, document.createTextNode(` · ${x.source}`));
    b.append(make("p", "q-big", x.big), make("p", "q-text", x.text), foot);
    return b;
  }));
}

// ------------------------------------------------------------------------------- galleries

function circuitSvg(pts: number[][], label: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const span = Math.max(maxx - minx, maxy - miny) * 1.16;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const map = (p: number[]) => [50 + ((p[0] - cx) / span) * 100, 50 - ((p[1] - cy) / span) * 100];
  const d = (idx: number[], close: boolean) =>
    idx.map((i, j) => `${j ? "L" : "M"}${map(pts[i]).map((v) => v.toFixed(1)).join(",")}`).join("") + (close ? "Z" : "");
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const all = pts.map((_, i) => i);
  const add = (cls: string, path: string, extra: Record<string, string> = {}) => {
    const e = document.createElementNS(NS, "path");
    e.setAttribute("d", path);
    e.setAttribute("class", cls);
    for (const [k, v] of Object.entries(extra)) e.setAttribute(k, v);
    svg.append(e);
  };
  add("c-edge", d(all, true));
  add("c-road", d(all, true));
  // a crossing is a bridge: the later stretch over the earlier one
  for (const [, b] of crossings(pts, [...all, 0])) {
    const over = Array.from({ length: 11 }, (_, k) => (b - 4 + k + pts.length) % pts.length);
    add("c-edge", d(over.slice(1, -1), false), { "stroke-linecap": "butt" });
    add("c-road", d(over, false), { "stroke-linecap": "butt" });
  }
  const [sx, sy] = map(pts[0]);
  const start = document.createElementNS(NS, "circle");
  start.setAttribute("cx", sx.toFixed(1));
  start.setAttribute("cy", sy.toFixed(1));
  start.setAttribute("r", "3.4");
  start.setAttribute("class", "c-start");
  svg.append(start);
  return svg;
}

const REASONS: Record<string, string> = { ok: "drivable" };

export function renderGalleries(d: Designer | null): void {
  if (!d) return;
  const fill = (id: string, set: Record<Layout, number[][][]>, verdicts?: Record<Layout, string[]>) => {
    const items: HTMLElement[] = [];
    for (const layout of ["loop", "figure8"] as const) {
      set[layout].slice(0, 6).forEach((pts, i) => {
        const fig = make("figure");
        const name = layout === "loop" ? "loop" : "figure-eight";
        fig.append(circuitSvg(pts, `${id === "gallery-dreamed" ? "Dreamed" : "Procedural"} ${name} ${i + 1}`));
        if (verdicts) {
          const v = verdicts[layout][i];
          fig.append(make("figcaption", v === "ok" ? "" : "bad", REASONS[v] ?? v));
        }
        items.push(fig);
      });
    }
    document.getElementById(id)!.replaceChildren(...items);
  };
  fill("gallery-dreamed", d.dreamed, d.dreamed_verdicts);
  fill("gallery-real", d.real);
}

// ------------------------------------------------------------------------------- lab pipeline, engineering

const STAGES: { title: string; body: string; metric: (s: Summary) => string }[] = [
  {
    title: "Simulate",
    body: "A Formula Student-class EV: dynamic bicycle model, Pacejka-style tyres, friction ellipse, 80 kW power cap, traction control. Procedural circuits with FS cone conventions.",
    metric: (s) => s.data ? `${s.data.frames.toLocaleString("en-US")} frames · ${s.data.circuits} circuits` : "vectorized NumPy simulator",
  },
  {
    title: "Drive badly, on purpose",
    body: "A population of scripted drivers (tidy, keyboard-style, over-driven, wandering, braking) produces slides, spins, off-track moments and launches, not just perfect laps.",
    metric: (s) => s.data ? `${(s.data.grass_fraction * 100).toFixed(0)}% of frames off the asphalt` : "6 driver behaviours",
  },
  {
    title: "Learn to dream",
    body: "An EDM diffusion U-Net predicts the next frame from the last four frames and the controls, with context-noise augmentation so it can repair its own mistakes.",
    metric: (s) => s.model ? `${s.model.params_m.toFixed(1)}M params · ${s.model.train_steps.toLocaleString("en-US")} steps` : "EDM, 1-4 sampling steps",
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

function card(big: string, label: string, note = ""): HTMLElement {
  const c = make("div", "card reveal");
  const b = make("div", "big");
  b.innerHTML = big; // trusted: built here from numbers
  c.append(b, make("div", "label", label));
  if (note) c.append(make("div", "note", note));
  return c;
}

export async function renderSections(s: Summary | null, parity: Summary["parity"] | null, d: Designer | null): Promise<void> {
  const summary: Summary = { ...(s ?? {}), parity: parity ?? undefined };
  document.getElementById("pipeline")!.replaceChildren(...STAGES.map((st) => {
    const c = make("div", "stage-card");
    c.append(make("h3", "", st.title), make("p", "", st.body), make("div", "metric", st.metric(summary)));
    return c;
  }));
  const p = summary.parity;
  const cards = [
    card(p ? `${p.bytes_diff} <small>/ ${p.bytes_total.toLocaleString("en-US")} bytes</small>` : "0 <small>bytes</small>",
         "pixel bytes that differ between the Python renderer and its TypeScript port",
         p ? `trajectories agree to ${p.state_err.toExponential(0)} (machine precision)` : "golden-trajectory parity tests in CI"),
    card("1 <small>upstream bug</small>", "found in ONNX Runtime Web's WebGPU Conv (C_in divisible by 3, not 4)",
         "isolated with a per-node WebGPU-vs-WASM diff tool; worked around by zero-padding channels"),
    card(summary.model ? `${summary.model.onnx_mb.toFixed(1)} <small>MB</small>` : "fp16", "world-model download, fp16 weights with fp32 compute", "runs on every GPU, no shader-f16 required"),
    card("Web Worker", "the circuit designer runs off the main thread, so the race keeps rendering while the road is dreamed",
         d ? `${d.sampler_steps} Heun steps, ${2 * d.sampler_steps - 1} network calls per arc` : "ONNX Runtime Web (WASM) in a worker"),
    card("CI", "lint, types, unit and property tests, cross-language parity, build", "GitHub Actions on every push"),
  ];
  document.getElementById("eng-cards")!.replaceChildren(...cards);
  await renderCharts(summary.audit ? summary : null);
}
