// The designer section's figure: one figure-eight the designer built live during an evaluation
// run (results/trackgen.json, "growth"), shown arc by arc as the reader scrolls through the
// steps. After each arc: the road built so far (gold), the newest arc (cyan, drawn in), and the
// designer's guess at the rest of the lap at that moment (dashed). A crossing is drawn as a bridge:
// the later stretch passes over the earlier one, as in the game.

export interface Growth {
  layout: string;
  tries: number;
  retries: number;
  steps: { arc: [number, number]; known: number; guess: number[][] }[];
  final: number[][];
}

const NS = "http://www.w3.org/2000/svg";
const LOOKAHEAD = 72; // points of road the game keeps dreamed ahead of the leader

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

function segmentsCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Index pairs (i < j) where the open polyline through ``idx`` crosses itself. */
export function crossings(pts: number[][], idx: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 0; a + 1 < idx.length; a++) {
    for (let b = a + 8; b + 1 < idx.length; b++) {
      if (segmentsCross(pts[idx[a]], pts[idx[a + 1]], pts[idx[b]], pts[idx[b + 1]])) out.push([a, b]);
    }
  }
  return out;
}

export function renderGrowth(g: Growth, figure: HTMLElement, steps: HTMLElement[], count: HTMLElement): void {
  const svg = figure.querySelector("svg")!;
  const n = g.final.length;
  const first = g.steps[0].arc[0]; // the build starts behind the start line
  const order = (i: number) => (i - first + n) % n;
  const built = (k: number) => g.steps[k].known;
  const at = (o: number) => (first + o) % n; // point index at build order o

  // one frame for every snapshot, so the figure never jumps
  const all = g.steps.flatMap((s) => s.guess).concat(g.final);
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const span = Math.max(maxx - minx, maxy - miny) * 1.08;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  // the drawing sits below a band kept clear at the top for the CIRCUIT LOCKED label, so the
  // label never lands on the road
  const map = (p: number[]) => [50 + ((p[0] - cx) / span) * 86, 56 - ((p[1] - cy) / span) * 86];
  const path = (pts: number[][], idx: number[], close = false) =>
    idx.map((i, j) => `${j ? "L" : "M"}${map(pts[i]).map((v) => v.toFixed(2)).join(" ")}`).join("") + (close ? "Z" : "");
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, k) => at(a + k));

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let shown = -1;
  const show = (k: number, locked: boolean) => {
    if (k === shown && !locked === !svg.dataset.locked) return;
    const grew = k > shown;
    shown = k;
    svg.dataset.locked = locked ? "1" : "";
    svg.replaceChildren();
    const snap = g.steps[k];
    const pts = k === g.steps.length - 1 ? g.final : snap.guess;
    const done = built(k);
    const prev = k > 0 ? built(k - 1) : 0;
    const road = range(0, done + (done >= n ? 1 : 0));
    // the rest of the lap as the designer imagines it right now
    if (done < n) el("path", { d: path(snap.guess, range(done - 1, n + 1)), class: "guess", "stroke-width": 0.55 }, svg);
    el("path", { d: path(pts, road), class: "road-edge", "stroke-width": 3.4 }, svg);
    el("path", { d: path(pts, road), class: "road", "stroke-width": 1.9 }, svg);
    // bridges: the later stretch drawn again on top, with an ink gap through the road below
    for (const [, b] of crossings(pts, road)) {
      const over = road.slice(Math.max(0, b - 4), b + 6);
      el("path", { d: path(pts, over), class: "road-edge", "stroke-width": 3.4, "stroke-linecap": "butt" }, svg);
      el("path", { d: path(pts, road.slice(Math.max(0, b - 5), b + 7)), class: "road", "stroke-width": 1.9, "stroke-linecap": "butt" }, svg);
    }
    const fresh = el("path", { d: path(pts, range(Math.max(0, prev - 1), done + (done >= n ? 1 : 0))), class: "newest", "stroke-width": 1.9 }, svg);
    if (grew && !reduce.matches) {
      const len = fresh.getTotalLength();
      fresh.style.strokeDasharray = `${len}`;
      fresh.style.strokeDashoffset = `${len}`;
      fresh.getBoundingClientRect(); // commit the start state before transitioning
      fresh.style.transition = "stroke-dashoffset 0.9s cubic-bezier(0.2, 0.8, 0.2, 1)";
      fresh.style.strokeDashoffset = "0";
    }
    // the start line, and the pack: on the grid before the countdown, then just behind the frontier
    const [sx, sy] = map(pts[0]);
    el("circle", { cx: sx.toFixed(2), cy: sy.toFixed(2), r: 1.6, class: "start", "stroke-width": 0.6 }, svg);
    const leader = k === 0 ? order(0) - 3 : Math.max(order(0), done - LOOKAHEAD);
    [0, 3, 6].forEach((back, j) => {
      const [kx, ky] = map(pts[at(Math.max(0, leader - back))]);
      el("circle", { cx: kx.toFixed(2), cy: ky.toFixed(2), r: 0.95, fill: ["#ffffff", "#ff8c42", "#2de2e6"][j], stroke: "#0b0b14", "stroke-width": 0.4 }, svg);
    });
    if (locked) {
      const t = el("text", { x: 50, y: 7, class: "lock", "text-anchor": "middle" }, svg);
      t.textContent = "CIRCUIT LOCKED";
    }
    const arcs = g.steps.length;
    // the trace is the first build of the evaluation run that passed every rule: say if it was not the first
    const earlier = g.tries > 1 ? ` The ${g.tries - 1} ${g.tries === 2 ? "build" : "builds"} before it broke a rule.` : "";
    count.textContent = locked
      ? `Locked: ${arcs} arcs, ${n} road points. ${g.retries} ${g.retries === 1 ? "arc was" : "arcs were"} dreamed again after failing a rule.${earlier}`
      : `Arc ${k + 1} of ${arcs}: ${Math.min(done, n)} of ${n} road points built.`;
  };

  // which snapshot each step of the story shows
  const last = g.steps.length - 1;
  let firstCross = last;
  for (let k = 0; k <= last; k++) {
    const pts = k === last ? g.final : g.steps[k].guess;
    if (crossings(pts, range(0, built(k))).length) {
      firstCross = k;
      break;
    }
  }
  // the bridges step shows the first arc with a crossing, and never repeats the step before it
  const plan = [0, Math.min(2, last), Math.min(3, last), Math.min(4, last), Math.min(last, Math.max(5, firstCross)), last];
  const activate = (i: number) => {
    steps.forEach((s, j) => s.classList.toggle("active", j === i));
    show(plan[Math.min(i, plan.length - 1)], i >= plan.length - 1);
  };
  // a step takes over as it crosses the middle of the screen; on a phone the figure is pinned
  // over the top half, so the line sits below it instead
  const band = window.matchMedia("(max-width: 900px)").matches ? "-70% 0px -22% 0px" : "-45% 0px -45% 0px";
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) activate(steps.indexOf(e.target as HTMLElement));
  }, { rootMargin: band });
  steps.forEach((s) => io.observe(s));
  activate(0);
}
