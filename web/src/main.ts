import "./style.css";
import "@fontsource/press-start-2p/400.css";
import { App, type MindDirection } from "./app";
import { DreamEngine } from "./dream/engine";
import { Policy } from "./dream/policy";
import { renderGrowth } from "./page/growth";
import { paintHorizons } from "./page/horizon";
import { startParallax } from "./page/parallax";
import {
  type Designer, loadJson, type Probes, renderFacts, renderGalleries, renderQuotes, renderSections,
  renderTiles, type Summary,
} from "./sections";
import type { SimConfig, SpriteData } from "./sim/config";
import { Track } from "./sim/track";

export const REPO_URL = "https://github.com/nilaypilaydesai/dreamcircuit";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

function setOverlay(text: string | null, error = false): void {
  const overlay = document.getElementById("overlay")!;
  if (text === null) {
    overlay.classList.add("hidden");
    return;
  }
  overlay.classList.remove("hidden");
  document.getElementById("overlay-text")!.textContent = text;
  if (error) overlay.querySelector(".spinner")?.remove();
}

/** The hero film: muted autoplay on a loop, paused off screen, never autoplayed for anyone who
 * asked for reduced motion (they get the poster and a play button), and pausable by anyone. */
function heroVideo(): void {
  const video = document.getElementById("hero-video") as HTMLVideoElement;
  const toggle = document.getElementById("hero-toggle") as HTMLButtonElement;
  let userPaused = reduceMotion.matches;
  let visible = true;
  const label = () => {
    toggle.textContent = video.paused ? "Play video" : "Pause video";
  };
  const sync = () => {
    if (userPaused || !visible) video.pause();
    else void video.play().catch(() => label()); // autoplay refused (e.g. low-power mode): poster stays
  };
  if (reduceMotion.matches) {
    video.removeAttribute("autoplay");
    video.pause();
  }
  video.addEventListener("play", label);
  video.addEventListener("pause", label);
  toggle.addEventListener("click", () => {
    userPaused = !video.paused;
    sync();
  });
  new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting; // batched changes: the latest one counts
    sync();
  }).observe(video);
  label();
}

/** The trailer, over the page (a dialog): it plays with sound when opened (the hero film behind it
 * pauses meanwhile) and stops when closed; a link to #trailer opens it, ready to play. */
function trailer(): void {
  const dialog = document.getElementById("trailer") as HTMLDialogElement | null;
  const video = document.getElementById("trailer-video") as HTMLVideoElement | null;
  const hero = document.getElementById("hero-video") as HTMLVideoElement;
  if (!dialog || !video || typeof dialog.showModal !== "function") return; // (no dialogs: the link plays the file)
  let heroWasPlaying = false;
  const open = (play: boolean) => {
    if (dialog.open) return;
    heroWasPlaying = !hero.paused;
    hero.pause();
    dialog.showModal();
    if (play) void video.play().catch(() => { /* (refused without a gesture: the controls stay up) */ });
  };
  document.getElementById("trailer-open")?.addEventListener("click", (e) => {
    e.preventDefault();
    open(true);
  });
  document.getElementById("trailer-close")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // (outside the film)
  dialog.addEventListener("close", () => {
    video.pause();
    if (heroWasPlaying) void hero.play().catch(() => { /* (the hero's own toggle can start it again) */ });
    if (location.hash === "#trailer") history.replaceState(null, "", location.pathname + location.search);
  });
  if (location.hash === "#trailer") open(false);
}

/** Solid nav once the hero scrolls away; the link for the section in view is marked. */
function nav(): void {
  const bar = document.getElementById("nav")!;
  const onScroll = () => bar.classList.toggle("solid", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  const links = new Map([...bar.querySelectorAll<HTMLAnchorElement>("nav a")].map((a) => [a.hash.slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const [id, a] of links) a.classList.toggle("here", id === e.target.id);
    }
  }, { rootMargin: "-40% 0px -55% 0px" });
  for (const id of links.keys()) {
    const s = document.getElementById(id);
    if (s) io.observe(s);
  }
}

/** Fade sections in as they arrive; everything is visible at once under reduced motion. */
function reveals(): void {
  const els = [...document.querySelectorAll<HTMLElement>(".reveal")];
  if (reduceMotion.matches) {
    for (const el of els) el.classList.add("in");
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  for (const el of els) io.observe(el);
}

async function content(): Promise<void> {
  const [raw, summary, parity, probes] = await Promise.all([
    loadJson<Designer>("results/trackgen.json"),
    loadJson<Summary>("results/summary.json"),
    loadJson<Summary["parity"]>("results/parity.json"),
    loadJson<Probes>("results/probes.json"),
  ]);
  // results from an older designer (points, not steps) do not carry these fields: leave them out
  const designer = raw && typeof raw.live_valid_figure8 === "number" && raw.dreamed?.loop ? raw : null;
  renderFacts(designer, summary);
  renderTiles(designer, summary, probes);
  renderQuotes(designer, summary);
  renderGalleries(designer);
  const growth = designer?.growth;
  const figure = document.getElementById("growth")!;
  if (growth) {
    renderGrowth(growth, figure, [...document.querySelectorAll<HTMLElement>("#steps .step")],
                 document.getElementById("growth-count")!);
  } else {
    figure.hidden = true;
  }
  reveals();
  await renderSections(summary, parity, designer);
}

/** The lab loads a 20 MB world model and runs it on the GPU: it starts only once it is in view. */
async function lab(): Promise<void> {
  await new Promise<void>((resolve) => {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        resolve();
      }
    }, { rootMargin: "200px" });
    io.observe(document.getElementById("lab")!);
  });
  try {
    setOverlay("Loading the simulator...");
    const [cfg, sprite, index] = await Promise.all([
      fetchJson<SimConfig>("assets/sim_config.json"),
      fetchJson<SpriteData>("assets/sprite.json"),
      fetchJson<{ id: string }[]>("assets/tracks/index.json"),
    ]);
    const first = await Track.load("assets/tracks", index[0].id);
    const engine = await DreamEngine.create("models", (s) => setOverlay(s));
    const policy = await Policy.tryCreate("models", engine.backend);
    const tracks = [first];
    const app = new App(engine, tracks, cfg, sprite, policy);

    document.getElementById("pill-backend")!.textContent =
      engine.backend === "webgpu" ? "WebGPU" : "WASM (no WebGPU: slower)";
    try {
      const probes = await fetchJson<{ directions: MindDirection[] }>("models/probes.json");
      app.setMind(probes.directions);
    } catch {
      // probes.json ships with trained models only; the mind panel simply stays hidden
    }
    setOverlay(null);
    app.start();
    // Remaining circuits load in the background; "New circuit" cycles through what has arrived.
    // A failure here costs one circuit, not the running lab.
    for (const t of index.slice(1)) {
      try {
        tracks.push(await Track.load("assets/tracks", t.id));
      } catch (err) {
        console.warn(`circuit ${t.id} could not load`, err);
      }
    }
  } catch (e) {
    console.error(e);
    setOverlay(`Could not start the dream: ${(e as Error).message}. ` +
               "A recent Chrome, Edge, Safari or Firefox with WebGPU gives the best experience.", true);
  }
}

function main(): void {
  for (const id of ["gh-link", "repo-link"]) (document.getElementById(id) as HTMLAnchorElement).href = REPO_URL;
  (document.getElementById("issues-link") as HTMLAnchorElement).href = `${REPO_URL}/issues`;
  heroVideo();
  trailer();
  nav();
  const parallax = startParallax();
  paintHorizons(() => parallax.refresh());
  void content().then(() => parallax.refresh());
  void lab();
}

main();
