// Game loop and modes: Dream (drive inside the network), Reality vs Dream (same inputs, side by
// side), and Real or Dream? (a human Turing test on 3-second clips).

import { DreamEngine, chwToRgb } from "./dream/engine";
import type { Policy } from "./dream/policy";
import type { SimConfig, SpriteData } from "./sim/config";
import { CarEnv } from "./sim/env";
import { expertAction } from "./sim/expert";
import type { Track } from "./sim/track";
import { Input } from "./ui/input";
import { Screen, drawSpark, psnr } from "./ui/screen";

export type Mode = "dream" | "split" | "turing";
const HZ = 15;
const CLIP_FRAMES = 45;
const TURING_ROUNDS = 10;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface History {
  frames: Uint8Array[];
  actions: [number, number][];
}

export interface MindDirection {
  name: string;
  label: string;
  vector: number[];
  scale: number;
}

export class App {
  mode: Mode = "dream";
  private env: CarEnv;
  private trackIdx = 0;
  private readonly real: Screen;
  private readonly dream: Screen;
  private readonly strip: Screen[] = [];
  private readonly input: Input;
  private autopilot = false;
  private history: History = { frames: [], actions: [] };
  private divergence: number[] = [];
  private msAvg = 0;
  private fpsAvg = 0;
  private lastTick = 0;
  private frames = 0;
  private adapted = false;
  private busy = false;
  private mind: { dir: MindDirection; value: number }[] = [];
  private turing = { round: 0, correct: 0, truth: "" as "" | "real" | "dream", playing: false };
  private clipToken = 0; // bumped to cancel a Turing clip that is still being generated
  private reseedSplit = false; // reality respawned: re-seed the dream once history refills

  constructor(private readonly engine: DreamEngine, private readonly tracks: Track[],
              private readonly cfg: SimConfig, private readonly sprite: SpriteData,
              private readonly policy: Policy | null) {
    this.env = new CarEnv(tracks[0], cfg, sprite);
    this.real = new Screen($("real-canvas"));
    this.dream = new Screen($("dream-canvas"));
    this.input = new Input($("touch"), $("screens"));
    this.input.onAction = (a) => this.onAction(a);
    this.buildStrip();
    this.bindControls();
  }

  // ------------------------------------------------------------------------------------------
  // setup

  private buildStrip(): void {
    const root = $("strip");
    root.innerHTML = "";
    this.strip.length = 0;
    const n = this.engine.steps + 1;
    root.style.setProperty("--n", String(n));
    for (let i = 0; i < n; i++) {
      const fig = document.createElement("figure");
      const c = document.createElement("canvas");
      const cap = document.createElement("figcaption");
      cap.textContent = i === 0 ? "noise" : i === n - 1 ? "frame" : `step ${i}`;
      fig.append(c, cap);
      root.append(fig);
      this.strip.push(new Screen(c));
    }
  }

  private bindControls(): void {
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) =>
      t.addEventListener("click", () => this.setMode(t.dataset.mode as Mode)));
    const steps = $<HTMLInputElement>("steps");
    steps.addEventListener("input", () => this.setSteps(Number(steps.value)));
    const aug = $<HTMLInputElement>("aug");
    aug.addEventListener("input", () => {
      this.engine.augSigma = Number(aug.value);
      $("aug-out").textContent = Number(aug.value).toFixed(2);
    });
    $("btn-wake").addEventListener("click", () => this.wake());
    $("btn-auto").addEventListener("click", () => this.toggleAutopilot());
    $("btn-track").addEventListener("click", () => this.nextTrack());
    $("btn-turing-next").addEventListener("click", () => void this.playClip());
    $("btn-guess-real").addEventListener("click", () => this.guess("real"));
    $("btn-guess-dream").addEventListener("click", () => this.guess("dream"));
    if (!this.policy) {
      const b = $<HTMLButtonElement>("btn-auto");
      b.title = "Autopilot model not bundled in this build";
      b.textContent = "Autopilot (reality only)";
    }
  }

  setMind(directions: MindDirection[]): void {
    if (directions.length === 0) return;
    $("panel-mind").hidden = false;
    const root = $("mind-sliders");
    root.replaceChildren();
    this.mind = directions.map((dir) => ({ dir, value: 0 }));
    this.mind.forEach((m, k) => {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("label");
      const out = document.createElement("output");
      out.textContent = "0.0";
      label.append(document.createTextNode(`${m.dir.label} `), out);
      const input = document.createElement("input");
      Object.assign(input, { type: "range", min: "-3", max: "3", step: "0.1", value: "0" });
      input.setAttribute("aria-label", m.dir.label);
      row.append(label, input);
      input.addEventListener("input", () => {
        this.mind[k].value = Number(input.value);
        out.textContent = Number(input.value).toFixed(1);
        this.applyMind();
      });
      root.append(row);
    });
  }

  private applyMind(): void {
    const bias = this.engine.midBias;
    bias.fill(0);
    for (const m of this.mind) {
      for (let i = 0; i < bias.length; i++) bias[i] += m.value * m.dir.scale * m.dir.vector[i];
    }
  }

  private setSteps(n: number): void {
    this.engine.steps = n;
    $("steps-out").textContent = String(n);
    $<HTMLInputElement>("steps").value = String(n);
    this.buildStrip();
  }

  private onAction(a: string): void {
    if (this.mode === "turing") return; // shortcuts would reseed the dream mid-clip
    if (a === "autopilot") this.toggleAutopilot();
    else if (a === "wake") this.wake();
    else if (a === "track") this.nextTrack();
    else if (a.startsWith("steps:")) this.setSteps(Number(a.slice(6)));
  }

  private toggleAutopilot(): void {
    if (this.mode === "turing") return;
    this.setAutopilot(!this.autopilot);
  }

  private setAutopilot(on: boolean): void {
    if (on && this.mode === "dream" && !this.policy) return; // nothing can see the dream
    this.autopilot = on;
    $("btn-auto").setAttribute("aria-pressed", String(on));
    $("drive-hint").textContent = on
      ? "AI driving. Press any arrow key or W A S D to take the wheel."
      : "You are driving. Space hands the wheel back to the AI.";
  }

  setMode(m: Mode): void {
    const leaving = this.mode;
    this.mode = m;
    // Cancel a clip in progress and give every mode a clean world: same circuit, no history
    // recorded somewhere else.
    this.clipToken += 1;
    this.reseedSplit = false;
    this.turing.playing = false;
    $<HTMLButtonElement>("btn-turing-next").disabled = false;
    $<HTMLButtonElement>("btn-guess-real").disabled = true;
    $<HTMLButtonElement>("btn-guess-dream").disabled = true;
    if (leaving === "turing" || this.env.track !== this.tracks[this.trackIdx]) {
      this.env = new CarEnv(this.tracks[this.trackIdx], this.cfg, this.sprite);
    }
    this.history = { frames: [], actions: [] };
    $("screens").dataset.mode = m;
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
      const on = t.dataset.mode === m;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    $("panel-turing").hidden = m !== "turing";
    $("panel-controls").hidden = m === "turing";
    $("panel-imagination").hidden = m === "turing";
    $("panel-mind").hidden = m === "turing" || this.mind.length === 0;
    $("drive-hint").hidden = m === "turing";
    $("pill-div").hidden = m !== "split";
    $("spark").hidden = m !== "split";
    if (m === "turing") {
      this.turing = { round: 0, correct: 0, truth: "", playing: false };
      this.updateTuringText("Each clip is 3 seconds of driving: either the real simulator, or the network dreaming it. Press Play clip.");
    } else {
      this.wake();
    }
  }

  // ------------------------------------------------------------------------------------------
  // seeding

  /** Restart reality somewhere on the lap and drive L-1 expert frames to seed the dream. */
  private seedFromFreshReality(): History {
    const tr = this.env.track;
    const start = Math.floor(Math.random() * tr.n);
    this.env.reset(start, 8 + Math.random() * 6, 0);
    const frames = [this.env.render().slice()];
    const actions: [number, number][] = [];
    for (let i = 0; i < this.engine.L - 1; i++) {
      const a = expertAction(this.env, 0.75);
      this.env.step(a[0], a[1]);
      frames.push(this.env.render().slice());
      actions.push(a);
    }
    return { frames, actions };
  }

  /** Wake up: re-synchronize the dream with reality. */
  wake(): void {
    if (this.mode === "split" && this.history.frames.length >= this.engine.L) {
      this.engine.setContext(this.history.frames, this.history.actions);
    } else {
      this.history = this.seedFromFreshReality();
      this.engine.setContext(this.history.frames, this.history.actions);
    }
    this.divergence = [];
    const last = this.history.frames[this.history.frames.length - 1];
    this.dream.drawRGB(last);
    this.real.drawRGB(last);
  }

  nextTrack(): void {
    this.trackIdx = (this.trackIdx + 1) % this.tracks.length;
    this.env = new CarEnv(this.tracks[this.trackIdx], this.cfg, this.sprite);
    this.history = { frames: [], actions: [] };
    this.wake();
  }

  // ------------------------------------------------------------------------------------------
  // main loop

  start(): void {
    this.wake();
    this.setAutopilot(true);
    const loop = async () => {
      const t0 = performance.now();
      if (!this.busy && this.mode !== "turing") {
        this.busy = true;
        try {
          await this.tick();
        } catch (e) {
          console.error(e);
        } finally {
          this.busy = false;
        }
      }
      const spent = performance.now() - t0;
      setTimeout(loop, Math.max(0, 1000 / HZ - spent));
    };
    void loop();
  }

  private async decideControls(): Promise<[number, number]> {
    // Attract mode: the AI drives until the visitor touches a control, then hands over.
    if (this.autopilot && this.input.active) this.setAutopilot(false);
    if (this.autopilot) {
      if (this.mode === "dream") {
        if (this.policy) return this.policy.actCHW(this.engine.contextFrames);
        this.setAutopilot(false);
      }
      if (this.mode === "split") {
        return this.policy ? this.policy.act(this.history.frames) : expertAction(this.env, 0.8);
      }
    }
    const c = this.input.read();
    return [c.steer, c.pedal];
  }

  private async tick(): Promise<void> {
    const [steer, pedal] = await this.decideControls();

    let realFrame: Uint8Array | null = null;
    if (this.mode === "split") {
      this.env.step(steer, pedal);
      if (this.env.lost) {
        this.env.reset(this.env.idx, 6);
        this.history = { frames: [], actions: [] };
        this.reseedSplit = true; // the dream must restart from the respawned car
      }
      realFrame = this.env.render().slice();
      this.history.frames.push(realFrame);
      this.history.actions.push([steer, pedal]);
      if (this.history.frames.length > this.engine.L) {
        this.history.frames.shift();
        this.history.actions.shift();
      }
      this.real.drawRGB(realFrame);
      if (this.history.frames.length < this.engine.L) return;
      if (this.reseedSplit) {
        // The window ends at the frame reality is showing now, so the dream joins it from the
        // next tick on (stepping it now would put the dream one frame ahead).
        this.engine.setContext(this.history.frames, this.history.actions);
        this.reseedSplit = false;
        this.divergence = [];
        this.dream.drawRGB(realFrame);
        return;
      }
    }

    const x = await this.engine.step(steer, pedal);
    if (!x) return; // re-seeded while this frame was being imagined
    const dreamRgb = chwToRgb(x, 64);
    this.dream.drawRGB(dreamRgb);
    this.drawStrip();

    if (realFrame) {
      const d = psnr(realFrame, dreamRgb);
      this.divergence.push(d);
      if (this.divergence.length > 150) this.divergence.shift();
      $("pill-div").textContent = `match ${d.toFixed(1)} dB`;
      drawSpark($<HTMLCanvasElement>("spark"), this.divergence);
    }
    this.updateStats();
  }

  private drawStrip(): void {
    const traj = this.engine.trajectory;
    if (!traj.length) return;
    const noise = new Float32Array(traj[0].length).map(() => (Math.random() * 2 - 1) * 0.9);
    this.strip[0]?.drawCHW(noise);
    traj.forEach((x0, i) => this.strip[i + 1]?.drawCHW(x0));
  }

  private updateStats(): void {
    const now = performance.now();
    if (this.lastTick) {
      const fps = 1000 / (now - this.lastTick);
      this.fpsAvg = this.fpsAvg ? 0.9 * this.fpsAvg + 0.1 * fps : fps;
    }
    this.lastTick = now;
    this.msAvg = this.msAvg ? 0.9 * this.msAvg + 0.1 * this.engine.lastMs : this.engine.lastMs;
    // Adaptive quality: a slow device (phones, WASM) drops to one denoising step to hold 15 fps.
    this.frames += 1;
    if (!this.adapted && this.frames > 45 && this.engine.steps > 1 && this.msAvg > 0.9 * (1000 / HZ)) {
      this.adapted = true;
      this.setSteps(1);
      $("drive-hint").textContent = "This device is a little slow, so the dream switched to 1 denoising step to keep 15 fps.";
    }
    $("pill-ms").textContent = `${this.msAvg.toFixed(1)} ms / frame (${this.engine.steps} step${this.engine.steps > 1 ? "s" : ""})`;
    $("pill-fps").textContent = `${this.fpsAvg.toFixed(1)} fps`;
    const led = $("led");
    led.classList.toggle("ok", this.fpsAvg >= HZ * 0.85);
    led.classList.toggle("slow", this.fpsAvg < HZ * 0.85);
  }

  // ------------------------------------------------------------------------------------------
  // Real or Dream?

  private updateTuringText(s: string): void {
    $("turing-text").textContent = s;
    $("turing-score").textContent = `${this.turing.correct} / ${this.turing.round}`;
  }

  private async playClip(): Promise<void> {
    if (this.turing.playing) return;
    if (this.turing.round >= TURING_ROUNDS) {
      this.turing = { round: 0, correct: 0, truth: "", playing: false };
    }
    const token = ++this.clipToken;
    const live = () => token === this.clipToken && this.mode === "turing";
    this.turing.playing = true;
    $<HTMLButtonElement>("btn-turing-next").disabled = true;
    this.updateTuringText("Generating clip...");
    try {
      const env = new CarEnv(this.tracks[Math.floor(Math.random() * this.tracks.length)], this.cfg,
                             this.sprite);
      this.env = env;
      const seed = this.seedFromFreshReality();
      const isDream = Math.random() < 0.5;
      const frames: Uint8Array[] = [];
      if (isDream) this.engine.setContext(seed.frames, seed.actions);
      const aggr = 0.6 + Math.random() * 0.3;
      for (let t = 0; t < CLIP_FRAMES; t++) {
        const a = expertAction(env, aggr);
        env.step(a[0], a[1]);
        if (isDream) {
          const act = this.policy ? await this.policy.actCHW(this.engine.contextFrames) : a;
          const x = await this.engine.step(act[0], act[1]);
          if (!live()) return; // the visitor left the test: setMode already reset the panel
          if (!x) throw new Error("the dream was re-seeded mid-clip");
          frames.push(chwToRgb(x, 64));
        } else {
          frames.push(env.render().slice());
        }
      }
      this.updateTuringText("Watch closely. Real or dream?");
      $("dream-canvas").scrollIntoView({ behavior: "smooth", block: "nearest" });
      for (const f of frames) {
        if (!live()) return;
        this.dream.drawRGB(f);
        await new Promise((r) => setTimeout(r, 1000 / HZ));
      }
      if (!live()) return;
      this.turing.truth = isDream ? "dream" : "real";
      $<HTMLButtonElement>("btn-guess-real").disabled = false;
      $<HTMLButtonElement>("btn-guess-dream").disabled = false;
    } catch (e) {
      console.error(e);
      if (!live()) return;
      this.turing.playing = false;
      $<HTMLButtonElement>("btn-turing-next").disabled = false;
      this.updateTuringText("That clip could not be generated. Press Play clip to try another.");
    }
  }

  private guess(g: "real" | "dream"): void {
    if (!this.turing.truth) return;
    const ok = g === this.turing.truth;
    this.turing.round += 1;
    if (ok) this.turing.correct += 1;
    const was = this.turing.truth === "dream" ? "dreamed by the network" : "the real simulator";
    const done = this.turing.round >= TURING_ROUNDS;
    this.turing.truth = "";
    this.turing.playing = false;
    $<HTMLButtonElement>("btn-guess-real").disabled = true;
    $<HTMLButtonElement>("btn-guess-dream").disabled = true;
    $<HTMLButtonElement>("btn-turing-next").disabled = false;
    this.updateTuringText(done
      ? `Final: ${this.turing.correct} / ${TURING_ROUNDS}. Guessing at random scores 5. Press Play clip to go again.`
      : `${ok ? "Correct" : "Fooled you"}: that clip was ${was}.`);
  }
}
