// Interactive SVG charts for the audit and interpretability sections, rendered from
// results/summary.json. Follows the dataviz method: validated categorical slots 1-3 (dark steps,
// all-pairs CVD-safe on this surface), 2px lines, >= 8px markers with a surface ring, hairline
// grid, selective direct labels, a legend for >= 2 series, hover tooltips that never gate (every
// chart has a table view), and text in text tokens only.

const SVG_NS = "http://www.w3.org/2000/svg";
const S = ["#3987e5", "#d95926", "#199e70"];
const NEUTRAL = "#898781";

interface Series {
  name: string;
  color: string;
  points: [number, number][];
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>,
                                                   parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

function text(parent: Element, x: number, y: number, s: string, cls: string,
              anchor = "start"): SVGTextElement {
  const t = el("text", { x, y, class: cls, "text-anchor": anchor }, parent);
  t.textContent = s;
  return t;
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function fmt(v: number, digits = 2): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(digits);
}

/** Card shell: title, subtitle, legend, the svg, a tooltip and a table view. */
function shell(root: HTMLElement, title: string, subtitle: string, series: { name: string; color: string; kind: "line" | "dot" | "bar" }[]) {
  const fig = document.createElement("figure");
  fig.className = "chart";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = subtitle;
  fig.append(h, p);
  if (series.length >= 2) {
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const s of series) {
      const item = document.createElement("span");
      const key = document.createElement("i");
      key.className = `key ${s.kind}`;
      key.style.background = s.color;
      item.append(key, document.createTextNode(s.name));
      legend.append(item);
    }
    fig.append(legend);
  }
  const wrap = document.createElement("div");
  wrap.className = "plot";
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  wrap.append(tip);
  fig.append(wrap);
  root.append(fig);
  return { fig, wrap, tip };
}

function table(fig: HTMLElement, head: string[], rows: (string | number)[][]): void {
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = "Table view";
  const t = document.createElement("table");
  const tr = t.insertRow();
  for (const hcell of head) {
    const th = document.createElement("th");
    th.textContent = hcell;
    tr.append(th);
  }
  for (const r of rows) {
    const row = t.insertRow();
    for (const c of r) row.insertCell().textContent = typeof c === "number" ? fmt(c) : c;
  }
  det.append(sum, t);
  fig.append(det);
}

function showTip(tip: HTMLDivElement, wrap: HTMLElement, x: number, y: number,
                 rows: { label: string; value: string; color?: string }[]): void {
  tip.replaceChildren();
  for (const r of rows) {
    const line = document.createElement("div");
    if (r.color) {
      const key = document.createElement("i");
      key.className = "key line";
      key.style.background = r.color;
      line.append(key);
    }
    const v = document.createElement("strong");
    v.textContent = r.value;
    line.append(v, document.createTextNode(` ${r.label}`));
    tip.append(line);
  }
  tip.hidden = false;
  const w = wrap.clientWidth;
  tip.style.left = `${Math.min(Math.max(x + 14, 0), w - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.max(y - tip.offsetHeight - 10, 0)}px`;
}

interface Frame {
  W: number; H: number; L: number; R: number; T: number; B: number;
  x: (v: number) => number; y: (v: number) => number;
}

function frame(svg: SVGSVGElement, xd: [number, number], yd: [number, number], xLabel: string,
               yLabel: string, right = 150): Frame {
  const W = 600, H = 320, L = 52, R = right, T = 12, B = 44;
  const x = (v: number) => L + ((v - xd[0]) / (xd[1] - xd[0])) * (W - L - R);
  const y = (v: number) => H - B - ((v - yd[0]) / (yd[1] - yd[0])) * (H - T - B);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  for (const v of niceTicks(yd[0], yd[1])) {
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }, svg);
    text(svg, L - 8, y(v) + 4, fmt(v, v % 1 ? 1 : 0), "tick", "end");
  }
  for (const v of niceTicks(xd[0], xd[1], 6)) {
    text(svg, x(v), H - B + 18, fmt(v, v % 1 ? 1 : 0), "tick", "middle");
  }
  el("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, class: "axis" }, svg);
  text(svg, (L + W - R) / 2, H - 4, xLabel, "axis-label", "middle");
  const yl = text(svg, 12, (T + H - B) / 2, yLabel, "axis-label", "middle");
  yl.setAttribute("transform", `rotate(-90 12 ${(T + H - B) / 2})`);
  return { W, H, L, R, T, B, x, y };
}

function lineChart(root: HTMLElement, title: string, subtitle: string, series: Series[],
                   xLabel: string, yLabel: string, unit: string, markers = false,
                   right = 170): void {
  const { fig, wrap, tip } = shell(root, title, subtitle,
                                   series.map((s) => ({ name: s.name, color: s.color, kind: "line" })));
  const svg = el("svg", { role: "img", "aria-label": title }, wrap);
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = series.flatMap((s) => s.points.map((p) => p[1]));
  const ylo = Math.min(...ys), yhi = Math.max(...ys);
  const pad = (yhi - ylo) * 0.08;
  const lastYs = series.map((s) => s.points[s.points.length - 1][1]).sort((p, q) => p - q);
  const spread = (yhi - ylo + 2 * pad) || 1;
  const willLabel = series.length > 1 && lastYs.every((v, i) => i === 0 || ((v - lastYs[i - 1]) / spread) * 264 >= 18);
  const f = frame(svg, [Math.min(...xs), Math.max(...xs)], [ylo - pad, yhi + pad], xLabel, yLabel,
                  willLabel ? right : 30);
  // Direct end-labels only when they separate; converging lines fall back to the legend.
  const ends = series.map((s) => f.y(s.points[s.points.length - 1][1])).sort((p, q) => p - q);
  const labelsFit = series.length > 1 && ends.every((v, i) => i === 0 || v - ends[i - 1] >= 18);
  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${f.x(p[0]).toFixed(1)},${f.y(p[1]).toFixed(1)}`).join("");
    el("path", { d, class: "line", stroke: s.color }, svg);
    if (markers) {
      for (const p of s.points) el("circle", { cx: f.x(p[0]), cy: f.y(p[1]), r: 4.5, fill: s.color, class: "dot" }, svg);
    }
    if (labelsFit) {
      const last = s.points[s.points.length - 1];
      text(svg, f.x(last[0]) + 8, f.y(last[1]) + 4, s.name, "end-label");
    }
  }
  // Crosshair + one tooltip for every series at the nearest x.
  const cross = el("line", { y1: f.T, y2: f.H - f.B, class: "cross", visibility: "hidden" }, svg);
  const hit = el("rect", { x: f.L, y: f.T, width: f.W - f.L - f.R, height: f.H - f.T - f.B, fill: "transparent" }, svg);
  const xsU = [...new Set(series[0].points.map((p) => p[0]))];
  const move = (ev: PointerEvent) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * f.W;
    let best = xsU[0];
    for (const v of xsU) if (Math.abs(f.x(v) - px) < Math.abs(f.x(best) - px)) best = v;
    cross.setAttribute("x1", String(f.x(best)));
    cross.setAttribute("x2", String(f.x(best)));
    cross.setAttribute("visibility", "visible");
    const rows: { label: string; value: string; color?: string }[] = series.map((s) => {
      const pt = s.points.find((p) => p[0] === best)!;
      return { label: s.name, value: `${fmt(pt[1])} ${unit}`, color: s.color };
    });
    rows.unshift({ label: "", value: `${xLabel}: ${fmt(best)}` });
    showTip(tip, wrap, ((f.x(best)) / f.W) * wrap.clientWidth, ev.clientY - box.top, rows);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  table(fig, [xLabel, ...series.map((s) => `${s.name} (${unit})`)],
        series[0].points.filter((_, i, a) => a.length <= 12 || i % Math.ceil(a.length / 12) === 0 || i === a.length - 1)
          .map((p) => [fmt(p[0]), ...series.map((s) => s.points.find((q) => q[0] === p[0])![1])]));
}

function scatterChart(root: HTMLElement, title: string, subtitle: string, series: Series[],
                      xLabel: string, yLabel: string, unit: string): void {
  const { fig, wrap, tip } = shell(root, title, subtitle,
                                   series.map((s) => ({ name: s.name, color: s.color, kind: "dot" })));
  const svg = el("svg", { role: "img", "aria-label": title }, wrap);
  const all = series.flatMap((s) => s.points.flat());
  const lim = Math.max(...all.map(Math.abs)) * 1.1;
  const f = frame(svg, [-lim, lim], [-lim, lim], xLabel, yLabel, 24);
  el("line", { x1: f.x(-lim), y1: f.y(-lim), x2: f.x(lim), y2: f.y(lim), class: "ref" }, svg);
  text(svg, f.x(lim * 0.35), f.y(lim * 0.12), "dream = reality", "ref-label");
  const pts: { x: number; y: number; s: Series; p: [number, number] }[] = [];
  for (const s of series) {
    for (const p of s.points) {
      el("circle", { cx: f.x(p[0]), cy: f.y(p[1]), r: 5, fill: s.color, class: "dot" }, svg);
      pts.push({ x: f.x(p[0]), y: f.y(p[1]), s, p });
    }
  }
  const hit = el("rect", { x: f.L, y: f.T, width: f.W - f.L - f.R, height: f.H - f.T - f.B, fill: "transparent" }, svg);
  hit.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * f.W;
    const py = ((ev.clientY - box.top) / box.height) * f.H;
    let best = pts[0];
    let bd = Infinity;
    for (const q of pts) {
      const d = (q.x - px) ** 2 + (q.y - py) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    if (bd > 40 ** 2) { tip.hidden = true; return; }  // nearest-point layer, 40px reach
    showTip(tip, wrap, (best.x / f.W) * wrap.clientWidth, (best.y / f.H) * wrap.clientHeight, [
      { label: best.s.name, value: "", color: best.s.color },
      { label: "real", value: `${fmt(best.p[0])} ${unit}` },
      { label: "dream", value: `${fmt(best.p[1])} ${unit}` },
    ]);
  });
  hit.addEventListener("pointerleave", () => { tip.hidden = true; });
  table(fig, ["Command", `Real (${unit})`, `Dream (${unit})`],
        series.flatMap((s) => s.points.map((p) => [s.name, p[0], p[1]])));
}

function barChart(root: HTMLElement, title: string, subtitle: string, cats: string[],
                  series: { name: string; color: string; values: number[] }[]): void {
  const { fig, wrap, tip } = shell(root, title, subtitle,
                                   series.map((s) => ({ name: s.name, color: s.color, kind: "bar" })));
  const svg = el("svg", { role: "img", "aria-label": title }, wrap);
  const W = 600, L = 230, R = 44, T = 6, bar = 10, gap = 2, group = series.length * (bar + gap) + 16;
  const H = T + cats.length * group + 28;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const x = (v: number) => L + Math.max(v, 0) * (W - L - R);
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    el("line", { x1: x(v), x2: x(v), y1: T, y2: H - 22, class: "grid" }, svg);
    text(svg, x(v), H - 6, v.toFixed(2), "tick", "middle");
  }
  cats.forEach((c, i) => {
    const y0 = T + i * group;
    text(svg, L - 10, y0 + (series.length * (bar + gap)) / 2 + 3, c, "cat-label", "end");
    series.forEach((s, j) => {
      const v = s.values[i];
      const y = y0 + j * (bar + gap);
      const w = Math.max(x(v) - L, 1.5);
      // 4px rounded data-end, square at the baseline
      const r = Math.min(4, w / 2, bar / 2);
      const d = `M${L},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${bar - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
      const path = el("path", { d, fill: s.color, class: "bar" }, svg);
      if (j === 0) text(svg, L + w + 6, y + bar - 1, fmt(v), "value-label");
      el("rect", { x: L, y: y - gap / 2, width: W - L - R, height: bar + gap, fill: "transparent" }, svg)
        .addEventListener("pointermove", (ev) => {
          path.classList.add("hover");
          const box = svg.getBoundingClientRect();
          showTip(tip, wrap, ev.clientX - box.left, ev.clientY - box.top, [
            { label: c, value: "" }, { label: s.name, value: `R² ${s.values[i].toFixed(3)}`, color: s.color },
          ]);
        });
      svg.lastElementChild!.addEventListener("pointerleave", () => { path.classList.remove("hover"); tip.hidden = true; });
    });
  });
  table(fig, ["Quantity", ...series.map((s) => s.name)], cats.map((c, i) => [c, ...series.map((s) => s.values[i])]));
}

function cards(root: HTMLElement, items: { big: string; small?: string; label: string; note?: string }[]): void {
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card";
    const big = document.createElement("div");
    big.className = "big";
    big.textContent = it.big;
    if (it.small) {
      const sm = document.createElement("small");
      sm.textContent = ` ${it.small}`;
      big.append(sm);
    }
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = it.label;
    card.append(big, label);
    if (it.note) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = it.note;
      card.append(note);
    }
    root.append(card);
  }
}

// ----------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function renderCharts(summary: any | null): Promise<void> {
  const auditRoot = document.getElementById("audit-charts")!;
  const mindRoot = document.getElementById("mind-charts")!;
  const auditCards = document.getElementById("audit-cards")!;
  if (!summary?.audit) {
    for (const el2 of [auditRoot, mindRoot]) {
      el2.innerHTML = `<div class="empty">Results appear here after <code>make report</code> runs the evaluation harness.</div>`;
    }
    return;
  }
  const a = summary.audit;
  const ph = a.physics;
  const ctrl = a.controllability.summary;
  cards(auditCards, [
    { big: ph.speed_mae_1s.toFixed(2), small: "m/s", label: "speed error after 1 s of dreaming", note: `${ph.speed_mae_3s.toFixed(2)} m/s averaged over 3 s` },
    { big: `${(ctrl.steer_sign_agreement * 100).toFixed(0)}%`, label: "counterfactual steering turns the right way", note: `yaw-rate correlation with reality ${ctrl.yaw_rate_correlation.toFixed(2)}` },
    { big: ph.hud_consistency_mae.dream.toFixed(2), small: "m/s", label: "dreamed speedometer vs. dreamed motion", note: `the instrument's floor on real frames: ${ph.hud_consistency_mae.reality.toFixed(2)} m/s` },
    { big: `${(ph.friction_violation_rate.dream * 100).toFixed(1)}%`, label: "dreamed moments that exceed tyre grip", note: `reality, same instrument: ${(ph.friction_violation_rate.reality * 100).toFixed(1)}%` },
  ]);

  const f = a.fidelity;
  const hz = 15;
  const pts = (ys: number[]): [number, number][] => ys.map((v, i) => [(i + 1) / hz, v]);
  lineChart(auditRoot, "Dream fidelity, circuits never seen in training",
            "PSNR to the true future frames, dreamed from 4 real frames and the real controls.",
            [{ name: "Dream (2 steps)", color: S[0], points: pts(f.steps_2.psnr) },
             { name: "Copy last frame", color: NEUTRAL, points: pts(f.copy_last.psnr) }],
            "seconds", "PSNR (dB)", "dB");
  lineChart(auditRoot, "How fast does the dream drift from real physics?",
            "Mean absolute error between dreamed and true speed, both read from pixels.",
            [{ name: "Speed error", color: S[0], points: ph.time_s.map((t: number, i: number) => [t, ph.speed_mae_vs_time[i]]) }],
            "seconds", "m/s", "m/s");
  const fut = a.controllability.futures;
  scatterChart(auditRoot, "Steer the dream and it turns like the real car",
               "Same starting frames, three steering commands held for 1 s. Yaw rate read from pixels.",
               ["left", "straight", "right"].map((k, i) => ({
                 name: `Steer ${k}`, color: S[i],
                 points: fut[k].yaw_rate_real.map((v: number, j: number) => [v, fut[k].yaw_rate_dream[j]]),
               })),
               "real yaw rate", "dreamed yaw rate", "rad/s");

  const pr = summary.probes;
  const show = ["yaw_rate", "steer", "lateral_speed", "curvature_10", "curvature_30", "offset", "heading_error"];
  barChart(mindRoot, "What the network knows that the pixels don't say",
           "Held-out R² of linear probes. Negative R² (worse than guessing the mean) is drawn at 0.",
           show.map((k) => pr.labels[k]),
           [{ name: "Trained world model", color: S[0], values: show.map((k) => pr.r2[k].trained) },
            { name: "Raw pixels", color: S[1], values: show.map((k) => pr.r2[k].raw_pixels) },
            { name: "Same network, random weights", color: S[2], values: show.map((k) => pr.r2[k].random_init) }]);
  const st = summary.steering;
  const sp = st.effects.speed;
  lineChart(mindRoot, "Push one direction, and the dream speeds up",
            "Dreamed speed with the controls held neutral, while the bottleneck is nudged every step.",
            [{ name: "Mass-mean direction", color: S[0], points: st.alphas.map((x: number, i: number) => [x, sp.mass_mean.dream_speed[i]]) },
             { name: "Ridge-probe direction", color: S[1], points: st.alphas.map((x: number, i: number) => [x, sp.ridge.dream_speed[i]]) }],
            "push (alpha)", "m/s", "m/s", true);
}
