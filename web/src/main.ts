import "./style.css";
import "@fontsource/press-start-2p/400.css";
import { App, type MindDirection } from "./app";
import { DreamEngine } from "./dream/engine";
import { Policy } from "./dream/policy";
import { renderDesigner, renderSections } from "./sections";
import type { SimConfig, SpriteData } from "./sim/config";
import { Track } from "./sim/track";

export const REPO_URL = "https://github.com/nilayd2007/dreamcircuit";

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

async function main(): Promise<void> {
  (document.getElementById("gh-link") as HTMLAnchorElement).href = REPO_URL;
  void renderSections();
  void renderDesigner();
  // The lab loads a 20 MB world model and runs it on the GPU: start it only when it is in view.
  await new Promise<void>((resolve) => {
    const lab = document.getElementById("lab")!;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        resolve();
      }
    }, { rootMargin: "200px" });
    io.observe(lab);
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
    for (const t of index.slice(1)) tracks.push(await Track.load("assets/tracks", t.id));
  } catch (e) {
    console.error(e);
    setOverlay(`Could not start the dream: ${(e as Error).message}. ` +
               "A recent Chrome, Edge, Safari or Firefox with WebGPU gives the best experience.", true);
  }
}

void main();
