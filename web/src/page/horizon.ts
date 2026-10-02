// Pixel-art horizons for the data page, drawn in the game's own visual language (NEON NIGHT's
// ridges, striped sun, crystals, neon palms and lamps): far, middle and near layers, each its own
// low-resolution canvas scaled up by a whole number so every pixel stays square. The layers move
// at different speeds while scrolling (see parallax.ts).

type Kind = "dusk" | "night" | "sunset" | "hero";

interface Palette {
  ground: string; // the near layer's ground: the background of whatever comes next
  far: string;
  mid: string;
  sun: string | null;
  stars: boolean;
  props: ("crystal" | "palm" | "lamp" | "mesa")[];
}

const PALETTES: Record<Kind, Palette> = {
  dusk: { ground: "#0b0420", far: "#2a0f4a", mid: "#1b0a37", sun: "#ff6ad5", stars: true, props: ["crystal", "palm", "crystal", "lamp"] },
  night: { ground: "#08031a", far: "#24103f", mid: "#150829", sun: null, stars: true, props: ["crystal", "lamp", "palm", "crystal"] },
  sunset: { ground: "#0b0b14", far: "#5a2a5f", mid: "#3a1a3f", sun: "#ffd36b", stars: false, props: ["mesa", "palm", "crystal"] },
  hero: { ground: "#0b0420", far: "", mid: "", sun: null, stars: false, props: ["crystal", "palm", "crystal", "lamp", "palm"] },
};

const CRYSTALS: [string, string][] = [["#7ff6f8", "#2de2e6"], ["#c9a8ff", "#9d6bff"], ["#ff8fe6", "#ff2bd6"]];
const INK = "#0b0b14";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seamless 1-D fractal profile in [-1, 1]: sums of sines with whole-number frequencies. */
function profile(r: () => number, octaves: number): (u: number) => number {
  const comps = Array.from({ length: octaves * 3 }, (_, k) => ({
    f: 1 + Math.floor(r() * (4 + k * 3)), a: (0.4 + 0.6 * r()) / (1 + k), p: r() * Math.PI * 2,
  }));
  const norm = comps.reduce((s, c) => s + c.a, 0);
  return (u) => comps.reduce((s, c) => s + c.a * Math.sin(c.f * u * Math.PI * 2 + c.p), 0) / norm;
}

function ridge(g: CanvasRenderingContext2D, w: number, h: number, base: number, amp: number, color: string,
               r: () => number, octaves: number): void {
  const f = profile(r, octaves);
  g.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const top = Math.round(h * base - f(x / w) * amp);
    g.fillRect(x, top, 1, h - top);
  }
}

function sun(g: CanvasRenderingContext2D, cx: number, cy: number, rad: number, color: string): void {
  for (let y = -rad; y <= rad; y++) {
    // synthwave stripes across the lower half, wider toward the bottom, as in the game's sky
    if (y > 0 && y % 5 < 1 + y / 12) continue;
    const half = Math.round(Math.sqrt(rad * rad - y * y));
    g.fillStyle = color;
    g.fillRect(cx - half, cy + y, half * 2, 1);
  }
}

function crystal(g: CanvasRenderingContext2D, x: number, ground: number, w: number, h: number, light: string, dark: string): void {
  const tip = Math.max(2, Math.round(w / 2));
  for (let y = 0; y < h; y++) {
    const half = y < tip ? Math.max(1, Math.round((y / tip) * (w / 2))) : Math.round(w / 2);
    const top = ground - h + y;
    g.fillStyle = INK;
    g.fillRect(x - half - 1, top, half * 2 + 2, 1);
    g.fillStyle = light;
    g.fillRect(x - half, top, half, 1);
    g.fillStyle = dark;
    g.fillRect(x, top, half, 1);
  }
}

function palm(g: CanvasRenderingContext2D, x: number, ground: number, h: number, r: () => number): void {
  const lean = (r() - 0.5) * 0.5;
  let tx = x;
  for (let y = 0; y < h; y++) {
    tx = x + Math.round(lean * y * (y / h));
    g.fillStyle = y % 3 === 0 ? "#b0168f" : "#ff2bd6";
    g.fillRect(tx, ground - y, 2, 1);
  }
  const top = ground - h;
  g.fillStyle = "#2de2e6";
  for (const dir of [-1, 1]) {
    for (const reach of [0.9, 0.55]) {
      const len = Math.round(h * 0.55 * reach) + 3;
      for (let i = 0; i < len; i++) {
        const fx = tx + 1 + dir * i, fy = top + Math.round((i * i) / (len * 1.4)) - (reach > 0.8 ? 0 : 2);
        g.fillRect(fx, fy, 1, 1);
        if (i % 2 === 0) g.fillRect(fx, fy + 1, 1, 1);
      }
    }
  }
  g.fillRect(tx, top - 2, 2, 3);
}

function lamp(g: CanvasRenderingContext2D, x: number, ground: number, h: number): void {
  g.fillStyle = "#4b3f6b";
  g.fillRect(x, ground - h, 1, h);
  g.fillStyle = "rgba(45, 226, 230, 0.35)";
  g.fillRect(x - 2, ground - h - 2, 5, 5);
  g.fillStyle = "#e9fdff";
  g.fillRect(x - 1, ground - h - 1, 3, 3);
}

function mesa(g: CanvasRenderingContext2D, x: number, ground: number, w: number, h: number): void {
  g.fillStyle = "#7a3b2e";
  for (let y = 0; y < h; y++) {
    const half = Math.round(w / 2 + (y > h * 0.25 ? (y - h * 0.25) * 0.6 : 0));
    g.fillRect(x - half, ground - h + y, half * 2, 1);
  }
  g.fillStyle = "#b5563c";
  g.fillRect(x - Math.round(w / 2), ground - h, w, 2);
}

function scaleFor(width: number): number {
  return width >= 1280 ? 5 : width >= 760 ? 4 : 3;
}

function layerCanvas(host: HTMLElement, w: number, h: number, s: number, depth: number): CanvasRenderingContext2D {
  const wrap = document.createElement("div");
  wrap.className = "layer";
  wrap.dataset.depth = String(depth);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.style.width = `${w * s}px`;
  c.style.height = `${h * s}px`;
  c.style.imageRendering = "pixelated";
  c.style.display = "block";
  wrap.append(c);
  host.append(wrap);
  return c.getContext("2d")!;
}

function draw(host: HTMLElement, kind: Kind, seed: number): void {
  host.replaceChildren();
  const pal = PALETTES[kind];
  const rect = host.getBoundingClientRect();
  const s = scaleFor(window.innerWidth) + (kind === "hero" ? 1 : 0);
  const w = Math.ceil(rect.width / s) + 2, h = Math.ceil(rect.height / s);
  const r = rng(seed);
  if (kind !== "hero") {
    const glow = document.createElement("div");
    glow.className = "glow";
    host.append(glow);
    const far = layerCanvas(host, w, h, s, 0.16);
    if (pal.stars) {
      for (let k = 0; k < w / 3; k++) {
        far.fillStyle = r() > 0.75 ? "#ffffff" : "#c8b8ff";
        far.fillRect(Math.floor(r() * w), Math.floor(r() * h * 0.45), 1, 1);
      }
    }
    if (pal.sun) sun(far, Math.round(w * (0.62 + 0.2 * (r() - 0.5))), Math.round(h * 0.52), Math.round(Math.min(h * 0.34, 26)), pal.sun);
    ridge(far, w, h, 0.62, h * 0.16, pal.far, r, 3);
    const mid = layerCanvas(host, w, h, s, 0.08);
    ridge(mid, w, h, 0.78, h * 0.1, pal.mid, r, 4);
  }
  const near = layerCanvas(host, w, h, s, kind === "hero" ? -0.22 : 0);
  // the hero's ground runs 200px below the fold, so it can rise with the scroll without a gap
  const groundTop = kind === "hero" ? h - Math.ceil(212 / s) : Math.round(h * 0.76);
  near.fillStyle = pal.ground;
  near.fillRect(0, groundTop, w, h - groundTop);
  if (kind === "hero") {
    // the hero's foreground frames the film: a few props at each side, none behind the words
    for (const [from, to] of [[0, 0.2], [0.8, 1]]) {
      let x = Math.round(w * from) + 3 + Math.floor(r() * 6);
      while (x < w * to - 2) {
        const what = pal.props[Math.floor(r() * pal.props.length)];
        if (what === "palm") palm(near, x, groundTop + 1, Math.round(14 + r() * 8), r);
        else if (what === "lamp") lamp(near, x, groundTop + 1, Math.round(10 + r() * 4));
        else {
          const [light, dark] = CRYSTALS[Math.floor(r() * CRYSTALS.length)];
          crystal(near, x, groundTop + 1, Math.round(3 + r() * 2) * 2, Math.round(8 + r() * 9), light, dark);
        }
        x += Math.round(10 + r() * 14);
      }
    }
    return;
  }
  // props stand on the ground in two rows: the back row smaller and dimmer
  for (const row of [0, 1]) {
    const y = groundTop + (row ? 1 : -1);
    let x = Math.floor(r() * 14);
    while (x < w) {
      const kindOf = pal.props[Math.floor(r() * pal.props.length)];
      const big = row === 1 ? 1 : 0.62;
      near.globalAlpha = row === 1 ? 1 : 0.7;
      if (kindOf === "crystal") {
        const [light, dark] = CRYSTALS[Math.floor(r() * CRYSTALS.length)];
        crystal(near, x, y, Math.round((3 + r() * 2) * big) * 2, Math.round((7 + r() * 8) * big), light, dark);
      } else if (kindOf === "palm") {
        palm(near, x, y, Math.round((10 + r() * 7) * big), r);
      } else if (kindOf === "lamp") {
        lamp(near, x, y, Math.round((8 + r() * 4) * big));
      } else {
        mesa(near, x, y, Math.round((10 + r() * 8) * big), Math.round((6 + r() * 5) * big));
      }
      x += Math.round((row ? 26 : 18) + r() * (row ? 34 : 22));
    }
  }
  near.globalAlpha = 1;
}

/** Paint every [data-horizon] element (and the hero's foreground), and repaint on resize. */
export function paintHorizons(onPainted: () => void): void {
  const hosts = [...document.querySelectorAll<HTMLElement>("[data-horizon]")];
  const paint = () => {
    hosts.forEach((el, i) => draw(el, el.dataset.horizon as Kind, 1009 + i * 7919));
    onPainted();
  };
  paint();
  let width = window.innerWidth;
  let timer = 0;
  window.addEventListener("resize", () => {
    if (Math.abs(window.innerWidth - width) < 24) return; // mobile URL bars resize height only
    width = window.innerWidth;
    clearTimeout(timer);
    timer = window.setTimeout(paint, 180);
  });
}
