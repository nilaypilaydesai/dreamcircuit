// DREAM CIRCUIT: the retro kart racer whose circuit is dreamed live by a diffusion model.
// Screens: title (with an AI attract race behind it), main menu, race setup, how to play, the
// "dreaming" intro, the race itself, pause and results. DATA and DREAM LAB open data.html.

import "./game.css";
import { Sound } from "./core/audio";
import { PixelFont, drawTextToSprite } from "./core/font";
import { H, Rand, Screen, W, hex, mix, type Sprite } from "./core/gfx";
import { GameInput, type MenuEvent } from "./core/input";
import { RivalDriver } from "./race/ai";
import { CLASSES, type Controls, type Difficulty } from "./race/kart";
import { Race, takesControls, type RaceEvent, type RaceSetup } from "./race/race";
import { type WorldSprite, drawWorldSprites } from "./render/billboards";
import { type Camera, drawGround, makeCamera } from "./render/mode7";
import type { Face } from "./render/poly";
import { bridgeFaces, padFaces, rampFaces } from "./render/structures";
import { Sky } from "./render/sky";
import { LIVERIES, type SceneryArt, bakeKart, itemBoxFrames, orbArt, slickArt } from "./render/sprites";
import { THEMES } from "./themes";
import { Hud, formatTime } from "./ui/hud";
import { Menu } from "./ui/menus";
import { type Layout, N, checkLap } from "./world/track";
import { CircuitDesigner, fromSteps, smoothArc, toGame } from "./world/trackgen";

type Mode = "boot" | "title" | "main" | "setup" | "howto" | "dreaming" | "race" | "pause" | "results";

const INK = hex("#0b0b14");
const HOT = hex("#ffd23f");
const DREAM = hex("#c79bff");
const DIM = hex("#8f87b8");
const LOGO_ROWS = ["#ffe66d", "#ffd23f", "#ffb347", "#ff8c42", "#ff6b6b", "#f25f9c", "#c77dff", "#9d6bff"].map(hex);
const DIFFS: Difficulty[] = ["rookie", "pro", "legend"];
const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "any", label: "SURPRISE ME" }, { id: "loop", label: "LOOP" }, { id: "figure8", label: "FIGURE 8" },
];
const BASE_HEIGHT = 2.9; // m, camera over the player's kart
const BASE_FOCAL = 250;

interface Attract {
  race: Race;
  sky: Sky;
  cam: Camera;
  driver: RivalDriver;
}

class Game {
  private readonly scr: Screen;
  private readonly sound = new Sound();
  private readonly input: GameInput;
  private hud!: Hud;
  private font!: PixelFont;
  private designer: CircuitDesigner | null = null;
  private designerError = "";
  private designerReady: Promise<void> = Promise.resolve();
  private waitingForDesigner = false;
  private kartSprites: Sprite[][] = [];
  private readonly boxArt: SceneryArt[] = itemBoxFrames();
  private readonly slickArt: SceneryArt = slickArt();
  private readonly orbArt: SceneryArt = orbArt();
  private mode: Mode = "boot";
  private race: Race | null = null;
  private sky: Sky | null = null;
  private cam: Camera = makeCamera();
  private attract: Attract | null = null;
  private attractPending = false; // a new attract race is being dreamed
  private attractRuns = 0;
  private autoPaused = false; // paused because the tab was hidden
  private raceError = "";
  private lastCircuit: Float64Array | null = null;
  private seed = (Math.random() * 1e9) | 0;
  private shake = 0;
  private time = 0;
  private settings = { rivals: 5, diff: 1, theme: 0, circuit: 0, layout: 0 };
  private menus!: Record<"main" | "setup" | "pause" | "results", Menu>;

  constructor() {
    const canvas = document.getElementById("game") as HTMLCanvasElement;
    this.scr = new Screen(canvas);
    this.input = new GameInput(canvas, document.getElementById("touch")!);
    this.input.onMute = () => this.sound.toggleMute();
  }

  private watchVisibility(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (this.mode === "race" && this.race?.phase !== "done") {
          this.go("pause");
          this.autoPaused = true;
        }
        this.sound.suspend();
      } else {
        this.sound.resume();
      }
    });
  }

  async boot(): Promise<void> {
    this.watchVisibility();
    this.font = await PixelFont.load();
    this.hud = new Hud(this.font);
    this.kartSprites = LIVERIES.map((l) => bakeKart(l));
    this.buildMenus();
    this.mode = "title";
    requestAnimationFrame((t) => this.frame(t));
    this.designerReady = CircuitDesigner.create("models").then(
      (d) => { this.designer = d; },
      (e) => {
        console.error(e);
        this.designerError = "COULD NOT LOAD THE CIRCUIT DESIGNER";
      });
    await this.designerReady;
    if (!this.designer) return;
    try {
      await this.startAttract();
    } catch (e) {
      console.error("attract race unavailable", e); // the title screen works without it
    }
  }

  private banner(s: Sprite): void {
    drawTextToSprite(this.font, s, "DREAM CIRCUIT", 8, 7, hex("#ffd23f"));
  }

  // ----------------------------------------------------------------------------------------
  // menus

  private buildMenus(): void {
    const s = this.settings;
    this.menus = {
      main: new Menu("MAIN MENU", [
        { label: "GRAND PRIX", action: () => this.go("setup"), hint: "3 LAPS ON A CIRCUIT THE AI DREAMS FOR YOU" },
        { label: "DREAM LAB", action: () => { location.href = "data.html#lab"; }, hint: "DRIVE INSIDE THE NEURAL WORLD MODEL" },
        { label: "DATA", action: () => { location.href = "data.html"; }, hint: "THE MODELS, THE PHYSICS AUDIT, THE CHARTS" },
        { label: "HOW TO PLAY", action: () => this.go("howto") },
        { label: "SOUND", value: () => (this.sound.muted ? "OFF" : "ON"), action: () => this.sound.toggleMute(), hint: "M TOGGLES SOUND ANYTIME" },
      ]),
      setup: new Menu("GRAND PRIX", [
        { label: "RIVALS", value: () => String(s.rivals), left: () => { s.rivals = Math.max(0, s.rivals - 1); }, right: () => { s.rivals = Math.min(7, s.rivals + 1); }, hint: "HOW MANY AI KARTS RACE YOU (0-7)" },
        { label: "DIFFICULTY", value: () => CLASSES[DIFFS[s.diff]].label, left: () => { s.diff = (s.diff + 2) % 3; }, right: () => { s.diff = (s.diff + 1) % 3; }, hint: "SPEED CLASS AND HOW SHARP THE RIVALS DRIVE" },
        { label: "WORLD", value: () => (s.theme === THEMES.length ? "RANDOM" : THEMES[s.theme].name), left: () => { s.theme = (s.theme + THEMES.length) % (THEMES.length + 1); }, right: () => { s.theme = (s.theme + 1) % (THEMES.length + 1); } },
        { label: "LAYOUT", value: () => LAYOUTS[s.layout].label, left: () => { s.layout = (s.layout + LAYOUTS.length - 1) % LAYOUTS.length; }, right: () => { s.layout = (s.layout + 1) % LAYOUTS.length; }, hint: "WHAT THE DREAM SHOULD BE: FIGURE 8S CROSS OVER A BRIDGE" },
        { label: "CIRCUIT", value: () => (s.circuit === 0 || !this.lastCircuit ? "NEW DREAM" : "LAST ONE"), left: () => { s.circuit = s.circuit ? 0 : 1; }, right: () => { s.circuit = s.circuit ? 0 : 1; }, hint: "A FRESH DREAM, OR RE-RACE YOUR LAST LOCKED CIRCUIT" },
        { label: "START RACE", action: () => void this.startRace(s.circuit === 1 && !!this.lastCircuit) },
        { label: "BACK", action: () => this.go("main") },
      ], 300),
      pause: new Menu("PAUSED", [
        { label: "RESUME", action: () => this.go("race") },
        { label: "RESTART", action: () => this.raceAgain(), hint: "SAME CIRCUIT, FRESH START" },
        { label: "QUIT TO MENU", action: () => this.quitToMenu() },
      ]),
      results: new Menu("", [
        { label: "RACE AGAIN", action: () => this.raceAgain(), hint: "SAME CIRCUIT" },
        { label: "NEW DREAM CIRCUIT", action: () => void this.startRace(false) },
        { label: "MAIN MENU", action: () => this.quitToMenu() },
      ], 240),
    };
  }

  private go(m: Mode): void {
    this.mode = m;
    if (m === "setup") this.menus.setup.index = this.menus.setup.items.length - 2;
    if (m === "pause") this.sound.setEngine(0, false, false);
    if (m !== "pause") this.autoPaused = false;
    this.music();
  }

  /** The soundtrack follows the screen: the title loop in menus, the world's loop in a race. */
  private music(): void {
    const mu = this.sound.music;
    if (this.mode === "pause" || this.mode === "results" || this.mode === "boot") mu.stop();
    else if (this.mode === "race" || this.mode === "dreaming") {
      const id = this.race?.setup.theme.id ?? "valley";
      mu.play(id);
    } else mu.play("title");
  }

  private quitToMenu(): void {
    this.race = null;
    this.go("main");
    this.sound.setEngine(0, false, false);
  }

  // ----------------------------------------------------------------------------------------
  // circuits and races

  /** One whole circuit from the designer (used for the title-screen attract race). */
  private async dreamWholeCircuit(rng: Rand, layout: Layout): Promise<Float64Array> {
    const d = this.designer!;
    const all = Array.from({ length: N }, (_, j) => j);
    let best: Float64Array | null = null;
    for (let k = 0; k < 6; k++) {
      const none = new Float32Array(N);
      const x = await d.sample({ mask: none, known: new Float32Array(2 * N), style: null,
                                 layout, seed: rng.int(1, 2 ** 31) });
      best = toGame(smoothArc(fromSteps(x, new Float64Array(2 * N), none, d.scale), all, 1.0));
      if (checkLap(best, new Set(all), layout, true).ok) break;
    }
    return best!;
  }

  private async startAttract(): Promise<void> {
    const rng = new Rand(this.seed + 99 + 7919 * this.attractRuns++); // a new circuit each time
    const theme = THEMES[rng.int(0, THEMES.length)];
    const pts = await this.dreamWholeCircuit(rng, rng.next() < 0.5 ? "figure8" : "loop");
    const race = new Race({ rivals: 5, difficulty: "pro", theme, seed: this.seed + 7, replay: pts }, null,
                          (s) => this.banner(s));
    await race.prepare();
    race.phase = "racing";
    const cam = makeCamera();
    this.snapCamera(cam, race);
    this.attract = { race, sky: new Sky(theme, cam.horizon, this.seed + 3), cam, driver: new RivalDriver(rng, race.player, 2) };
  }

  /** Once per finished attract race (the update loop would otherwise start one per frame). */
  private restartAttract(): void {
    this.attractPending = true;
    this.startAttract()
      .catch((e) => {
        console.error("attract race unavailable", e);
        this.attract = null; // the title screen works without it
      })
      .finally(() => { this.attractPending = false; });
  }

  /** RESTART and RACE AGAIN: the same circuit (or, mid lap 1, the same dream) and world. */
  private raceAgain(): void {
    const r = this.race;
    if (!r) return;
    const replay = r.track.locked ? Float64Array.from(r.track.points) : r.setup.replay;
    void this.startRace(false, { ...r.setup, replay });
  }

  private async startRace(sameCircuit: boolean, again?: RaceSetup): Promise<void> {
    this.raceError = "";
    if (!again && !this.designer && !(sameCircuit && this.lastCircuit)) {
      // A quick player can press START before the designer has loaded: start once it has.
      if (this.waitingForDesigner) return;
      this.waitingForDesigner = true;
      await this.designerReady;
      this.waitingForDesigner = false;
      if (!this.designer || this.mode !== "setup") return;
    }
    const s = this.settings;
    const theme = s.theme === THEMES.length ? THEMES[(Math.random() * THEMES.length) | 0] : THEMES[s.theme];
    // a live race with the same seed dreams the same circuit again
    const setup: RaceSetup = again ?? {
      rivals: s.rivals, difficulty: DIFFS[s.diff], theme, seed: (Math.random() * 1e9) | 0,
      replay: sameCircuit && this.lastCircuit ? this.lastCircuit : null, layout: LAYOUTS[s.layout].id,
    };
    this.seed = setup.seed;
    const race = new Race(setup, this.designer, (sp) => this.banner(sp));
    this.race = race;
    this.sky = new Sky(setup.theme, this.cam.horizon, this.seed + 3);
    this.hud.banners = [];
    this.sound.setEngine(0, false, false);
    this.go("dreaming");
    this.sound.ensure();
    try {
      await race.prepare();
    } catch (e) {
      console.error(e);
      if (this.race !== race) return;
      this.race = null;
      this.raceError = "THE DREAM FAILED. TRY AGAIN";
      this.go("setup");
      return;
    }
    if (this.race !== race) return; // the player backed out while it was dreaming
    this.snapCamera(this.cam, race);
    this.go("race");
  }

  private snapCamera(cam: Camera, race: Race): void {
    const p = race.player;
    cam.heading = p.heading;
    cam.x = p.x - Math.cos(cam.heading) * 6.2;
    cam.y = p.y - Math.sin(cam.heading) * 6.2;
  }

  private follow(cam: Camera, race: Race, dt: number): void {
    const p = race.player;
    const target = p.heading + p.slip * 0.45;
    let d = target - cam.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    cam.heading += d * (1 - Math.exp(-dt * 6.5));
    const jitter = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.04 : 0;
    cam.x = p.x - Math.cos(cam.heading) * 6.2;
    cam.y = p.y - Math.sin(cam.heading) * 6.2;
    cam.heading += jitter;
    // ride up onto bridges with the kart; on a jump, rise only partway for a sense of air
    const lift = p.ground + (p.elev - p.ground) * 0.55;
    cam.lift += (lift - cam.lift) * (1 - Math.exp(-dt * (p.air ? 5 : 9)));
    cam.height = BASE_HEIGHT + cam.lift;
    // speed: a wider view and speed lines while boosting
    cam.fx += ((p.boostTime > 0 ? 1 : 0) - cam.fx) * (1 - Math.exp(-dt * 6));
    cam.focal = BASE_FOCAL * (1 - 0.12 * cam.fx);
  }

  /** White streaks rushing past the edges of the screen while boosting. */
  private speedLines(cam: Camera): void {
    if (cam.fx < 0.05) return;
    const scr = this.scr;
    const t = this.time;
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2 + Math.sin(k * 7.3) * 0.2;
      const phase = (t * 3.2 + k * 0.37) % 1;
      const r0 = 120 + phase * 90, r1 = r0 + 18 + 14 * cam.fx;
      for (let r = r0; r < r1; r += 1.5) {
        const x = W / 2 + Math.cos(a) * r * 1.25, y = cam.horizon + 20 + Math.sin(a) * r * 0.62;
        if (x >= 0 && x < W && y >= 0 && y < H) scr.dimRect(x, y, 1, 1, 0xffffffff, 0.55 * cam.fx);
      }
    }
  }

  private handleEvents(race: Race, events: RaceEvent[]): void {
    const now = race.clock;
    for (const e of events) {
      if (e.kind === "count") this.sound.count();
      else if (e.kind === "go") {
        this.sound.go();
        this.hud.banner("GO!", now, hex("#5dff7a"), 1.0);
      } else if (e.kind === "lap") {
        if (e.final) {
          this.sound.finalLap();
          this.hud.banner("FINAL LAP!", now, HOT, 2.2);
          this.sound.music.setTempo(1.14); // the classic final-lap speed-up
        }
        else { this.sound.lap(); this.hud.banner(`LAP ${e.lap}`, now, 0xffffffff, 1.6); }
      } else if (e.kind === "locked") {
        if (race.live) { // a re-raced circuit is locked from the start: no fanfare
          this.sound.locked();
          this.hud.banner("CIRCUIT LOCKED", now, HOT, 2.6, "THE DREAM IS NOW YOUR TRACK");
        }
        this.lastCircuit = Float64Array.from(race.track.points);
      } else if (e.kind === "finish") {
        this.sound.finish(e.place);
        const ord = ["1ST", "2ND", "3RD"][e.place - 1] ?? `${e.place}TH`;
        this.hud.banner("FINISH!", now, HOT, 4, `YOU PLACED ${ord}`);
      } else if (e.kind === "boost") this.sound.boost();
      else if (e.kind === "bump") { this.sound.bump(); this.shake = 0.25; }
      else if (e.kind === "roll") this.sound.roll();
      else if (e.kind === "item") this.sound.itemGet();
      else if (e.kind === "use") {
        if (e.item === "turbo") this.sound.boost();
        else if (e.item === "oil") this.sound.oil();
        else this.sound.orb();
      } else if (e.kind === "spun") { this.sound.spin(); this.shake = 0.35; }
      else if (e.kind === "hit") this.sound.hit();
      else if (e.kind === "jump") this.sound.jump();
      else if (e.kind === "land") {
        this.sound.land();
        this.shake = Math.max(this.shake, 0.18);
        if (e.trick === 2) { this.sound.trick(true); this.hud.popup("PERFECT TRICK!", now, HOT); }
        else if (e.trick === 1) { this.sound.trick(false); this.hud.popup("TRICK!", now, hex("#63c8ff")); }
      } else if (e.kind === "pad") this.sound.boost();
      else if (e.kind === "rocket") { this.sound.rocket(); this.hud.popup("ROCKET START!", now, HOT); }
      else if (e.kind === "burnout") { this.sound.burnout(); this.hud.popup("TOO EARLY!", now, hex("#ff6b6b")); }
      else if (e.kind === "bridge") this.hud.popup("BRIDGE AHEAD!", now, DREAM);
    }
  }

  // ----------------------------------------------------------------------------------------
  // frame loop

  private last = 0;
  private acc = 0;

  /** Dev only: the test harness drives the simulation itself and holds the live loop. */
  debugHold = false;

  private frame(t: number): void {
    const dt = Math.min(0.1, this.last ? (t - this.last) / 1000 : 0);
    this.last = t;
    if (!this.debugHold) {
      this.time += dt;
      this.handleInput();
      this.acc += dt;
      const step = 1 / 60;
      while (this.acc >= step) {
        this.update(step);
        this.acc -= step;
      }
    }
    // a holding harness draws its own frames (step with draw, or shot): never paint over them
    if (!this.debugHold) this.render();
    requestAnimationFrame((tt) => this.frame(tt));
  }

  private handleInput(): void {
    const evs = this.input.takeEvents();
    const click = this.input.takeClick();
    if (evs.length || click) {
      this.sound.ensure(); // the first key press unlocks audio: start the soundtrack too
      this.music();
    }
    const menuFor: Partial<Record<Mode, Menu>> = { main: this.menus.main, setup: this.menus.setup, pause: this.menus.pause, results: this.menus.results };
    for (const e of evs) this.onEvent(e, menuFor[this.mode]);
    if (click) {
      if (this.mode === "title") this.go("main");
      else if (this.mode === "howto") this.go("main");
      else menuFor[this.mode]?.click(click.x, click.y, this.sound);
    }
  }

  private onEvent(e: MenuEvent, menu?: Menu): void {
    if (this.mode === "title") {
      if (e === "confirm" || e === "pause") this.go("main");
      return;
    }
    if (this.mode === "howto") {
      this.go("main");
      return;
    }
    if (this.mode === "race") {
      if (e === "back" || e === "pause") this.go("pause");
      return;
    }
    if (this.mode === "pause" && e === "pause") {
      this.go("race"); // P or Start toggle
      return;
    }
    if (this.mode === "dreaming") {
      if (e === "back" || e === "cancel") this.quitToMenu();
      return;
    }
    if (menu) {
      const r = menu.handle(e, this.sound);
      if (r === "back") {
        if (this.mode === "pause") this.go("race");
        else if (this.mode === "setup") this.go("main");
        else if (this.mode === "main") this.go("title");
      }
    }
  }

  private update(dt: number): void {
    if (this.shake > 0) this.shake -= dt;
    const a = this.attract;
    if (a && (this.mode === "title" || this.mode === "main" || this.mode === "setup" || this.mode === "howto")) {
      const c = a.driver.act(dt, a.race.track, a.race.cls, a.race.player, a.race.karts);
      a.race.update(dt, c);
      a.race.events = [];
      this.follow(a.cam, a.race, dt);
      if (a.race.phase === "done" && !this.attractPending) this.restartAttract();
    }
    const r = this.race;
    if (!r) return;
    if (this.mode === "race" || (this.mode === "dreaming" && r.phase !== "dreaming")) {
      const c: Controls = takesControls(r.phase) ? this.input.drive() : { steer: 0, throttle: 0, brake: 0, drift: false };
      r.update(dt, c);
      this.handleEvents(r, r.events);
      r.events = [];
      this.follow(this.cam, r, dt);
      const p = r.player;
      this.sound.setEngine(Math.abs(p.v) / r.cls.vmax, r.phase !== "done", p.surface === "grass");
      if (r.phase === "done" && this.mode === "race") {
        this.sound.setEngine(0, false, false);
        this.menus.results.index = 0;
        this.go("results");
      }
    }
  }

  // ----------------------------------------------------------------------------------------
  // rendering

  private drawWorld(race: Race, sky: Sky, cam: Camera): void {
    const t = race.track;
    sky.draw(this.scr, cam.heading);
    let mist: ((x: number, y: number) => number) | undefined;
    if (!t.locked && t.count > 0) {
      // the frontier of the dream: road beyond this point has not been imagined yet
      const fx = t.xs[t.count - 1], fy = t.ys[t.count - 1];
      const ph = this.time * 2.3;
      mist = (x, y) => {
        const d = Math.hypot(x - fx, y - fy);
        if (d > 46) return 0;
        return (1 - d / 46) * (0.45 + 0.25 * Math.sin(ph + x * 0.37 + y * 0.29));
      };
    }
    drawGround(this.scr, cam, race.tex, race.setup.theme.fog, mist);
    const extras: WorldSprite[] = [];
    const now = this.time;
    race.items.boxes.forEach((b, i) => {
      if (b.respawn > 0) return;
      const art = this.boxArt[(Math.floor(now * 6) + i) % this.boxArt.length];
      extras.push({ x: b.x, y: b.y, art, lift: 0.3 + 0.12 * Math.sin(now * 3 + i) });
    });
    for (const sl of race.items.slicks) extras.push({ x: sl.x, y: sl.y, art: this.slickArt, base: sl.elev });
    for (const o of race.items.orbs) {
      extras.push({ x: o.x, y: o.y, art: this.orbArt, lift: 0.45 + 0.1 * Math.sin(now * 9), base: t.elev[o.idx] ?? 0 });
    }
    const faces: Face[] = [];
    const painter = { cam, scr: this.scr, fog: race.setup.theme.fog, faces };
    bridgeFaces(painter, t, race.setup.theme);
    rampFaces(painter, t, race.features, race.setup.theme);
    padFaces(painter, t, race.features, now);
    drawWorldSprites(this.scr, cam, race.scenery.items, race.karts, this.kartSprites, race.setup.theme.fog,
                     (k) => (k.drifting ? Math.max(1, k.boostLevel) : 0), extras, faces);
  }

  private render(): void {
    const scr = this.scr, f = this.font, now = this.time;
    const a = this.attract;
    const background = () => {
      if (a) {
        this.drawWorld(a.race, a.sky, a.cam);
        scr.dimRect(0, 0, W, H, hex("#0b0420"), 0.45);
      } else {
        for (let y = 0; y < H; y++) scr.fillRect(0, y, W, 1, mix(hex("#140a35"), hex("#5d2a7a"), y / H));
      }
    };
    switch (this.mode) {
      case "boot":
        scr.clear(INK);
        break;
      case "title": {
        background();
        f.draw(scr, "DREAM", W / 2, 38, { scale: 5, rows: LOGO_ROWS, outline: INK, shadow: hex("#2a0f4a"), align: "center" });
        f.draw(scr, "CIRCUIT", W / 2, 82, { scale: 5, rows: LOGO_ROWS, outline: INK, shadow: hex("#2a0f4a"), align: "center" });
        f.draw(scr, "THE KART RACER AN AI DREAMS AS YOU DRIVE", W / 2, 132, { color: DREAM, outline: INK, align: "center" });
        if (Math.floor(now * 2) % 2 === 0) {
          f.draw(scr, this.designer ? "PRESS ENTER" : this.designerError || "WAKING THE DREAMER...", W / 2, 160, { scale: 1, color: 0xffffffff, outline: INK, align: "center" });
        }
        f.draw(scr, "A DIFFUSION MODEL DESIGNS EVERY TRACK", W / 2, H - 14, { color: DIM, outline: INK, align: "center" });
        break;
      }
      case "main":
      case "setup":
        background();
        f.draw(scr, "DREAM CIRCUIT", W / 2, 16, { scale: 2, rows: LOGO_ROWS, outline: INK, align: "center" });
        (this.mode === "main" ? this.menus.main : this.menus.setup).draw(scr, f, W / 2, 46, now);
        if (this.mode === "setup" && (!this.designer || this.raceError)) {
          const err = this.raceError || this.designerError;
          f.draw(scr, err || "WAKING THE DREAMER...", W / 2, H - 12,
                 { color: err ? HOT : DREAM, outline: INK, align: "center" });
        }
        break;
      case "howto":
        background();
        this.howTo();
        break;
      case "dreaming":
        this.dreamingScreen();
        break;
      case "race":
      case "pause":
      case "results": {
        const r = this.race;
        if (!r || !this.sky) break;
        this.drawWorld(r, this.sky, this.cam);
        this.speedLines(this.cam);
        if (this.mode === "race") this.hud.draw(scr, r, now);
        if (this.mode === "pause") {
          scr.dimRect(0, 0, W, H, INK, 0.45);
          this.menus.pause.draw(scr, f, W / 2, 60, now);
        }
        if (this.mode === "results") this.results(r);
        break;
      }
    }
    scr.present();
  }

  private debugPilot: RivalDriver | null = null;

  /** Dev only: advance n fixed steps with the given drive keys held, then render once. */
  debugStep(n: number, keys: string[], draw = true): void {
    const held = new Set(keys);
    const c = {
      steer: (held.has("left") ? 1 : 0) - (held.has("right") ? 1 : 0),
      throttle: held.has("gas") ? 1 : 0, brake: held.has("brake") ? 1 : 0, drift: held.has("drift"),
      item: held.has("item"),
    };
    const original = this.input.drive.bind(this.input);
    const r = this.race;
    if (held.has("auto") && r) {
      if (this.debugPilot?.kart !== r.player) this.debugPilot = new RivalDriver(new Rand(5), r.player, 0);
      this.input.drive = () => {
        const a = this.debugPilot!.act(1 / 60, r.track, r.cls, r.player, r.karts);
        return { ...a, item: !!a.item };
      };
    } else {
      this.input.drive = () => c;
    }
    if (this.autoPaused) this.go("race"); // the harness hides the tab; that is not a pause
    this.handleInput(); // queued menu presses (rAF, which normally handles them, may be paused)
    for (let i = 0; i < n; i++) {
      this.update(1 / 60);
      this.time += 1 / 60;
    }
    this.input.drive = original;
    if (draw) this.render();
  }

  /** Dev only (the cinema tool): render the current race from a scripted camera, no HUD. */
  debugShot(shot: Partial<Camera>): void {
    const r = this.race;
    if (!r || !this.sky) return;
    const cam = { ...this.cam, ...shot };
    this.drawWorld(r, this.sky, cam);
    this.speedLines(cam);
    this.scr.present();
  }

  /** Dev only: race a given circuit (game meters, x0 y0 x1 y1 ...) without the designer. */
  debugRace(points: number[], theme = 0, rivals = 5): void {
    void this.startRace(false, {
      rivals, difficulty: "pro", theme: THEMES[theme], seed: 1234, replay: Float64Array.from(points), layout: "any",
    });
  }

  debugState(): Record<string, unknown> {
    const r = this.race;
    return {
      mode: this.mode,
      designer: !!this.designer,
      attract: !!this.attract,
      attractRuns: this.attractRuns,
      // fingerprint of the road so far: equal for equal circuits
      radiiSum: r ? Math.round(Array.from(r.track.points).reduce((a: number, v: number, j: number) =>
        a + (r.track.known[j >> 1] ? Math.abs(v) * ((j >> 1) + 1) : 0), 0)) : null,
      bridges: r?.track.bridges.length ?? 0,
      ramps: r?.features.ramps.length ?? 0,
      pads: r?.features.pads.length ?? 0,
      style: r?.live?.style ?? null,
      elev: r ? Math.round(r.player.elev * 10) / 10 : 0,
      air: r?.player.air ?? false,
      phase: r?.phase,
      clock: r?.clock,
      locked: r?.track.locked,
      dream: r?.dreamProgress,
      place: r?.player.place,
      lap: r?.lapForHud,
      speed: r ? Math.round(Math.abs(r.player.v) * 3.6) : 0,
      surface: r?.player.surface,
      stats: r?.live?.stats,
      busy: r?.live?.busy ?? false,
      length: r?.track.locked ? Math.round(r.track.length) : null,
    };
  }

  private howTo(): void {
    const f = this.font, scr = this.scr;
    scr.dimRect(24, 18, W - 48, H - 36, hex("#0c0a1d"), 0.88);
    f.draw(scr, "HOW TO PLAY", W / 2, 28, { color: HOT, outline: INK, align: "center" });
    const lines: [string, string][] = [
      ["DRIVE", "ARROWS OR W A S D"],
      ["DRIFT", "HOLD SHIFT OR SPACE IN A TURN"],
      ["", "RELEASE FOR A MINI-TURBO BOOST"],
      ["ITEM", "E OR C: TURBO, OIL OR DREAM ORB"],
      ["RAMP", "SPACE AT THE LIP: TRICK BOOST"],
      ["START", "GAS RIGHT BEFORE GO: ROCKET"],
      ["PAUSE", "ESC          SOUND  M"],
      ["PAD", "A GAS B BRAKE RB DRIFT Y ITEM"],
    ];
    lines.forEach(([k, v], i) => {
      f.draw(scr, k, 40, 46 + i * 10, { color: DREAM });
      f.draw(scr, v, 104, 46 + i * 10, { color: 0xffffffff });
    });
    const story = [
      "NOBODY DESIGNED YOUR CIRCUIT.",
      "A DIFFUSION MODEL DREAMS THE ROAD",
      "AHEAD OF THE PACK DURING LAP 1.",
      "WHEN THE LOOP CLOSES, IT LOCKS:",
      "LAPS 2 AND 3 RACE ON YOUR DREAM.",
    ];
    story.forEach((s, i) => f.draw(scr, s, W / 2, 128 + i * 10, { color: i === 0 ? HOT : DIM, align: "center" }));
    f.draw(scr, "PRESS ANY KEY", W / 2, H - 30, { color: 0xffffffff, align: "center" });
  }

  private dreamingScreen(): void {
    const scr = this.scr, f = this.font, now = this.time;
    for (let y = 0; y < H; y++) scr.fillRect(0, y, W, 1, mix(hex("#0b0420"), hex("#2a0f4a"), y / H));
    const r = this.race;
    const pv = r?.live?.preview;
    f.draw(scr, "THE AI IS DREAMING YOUR CIRCUIT", W / 2, 22, { color: DREAM, outline: INK, align: "center" });
    if (pv && r) {
      // the designer's current whole-circuit guess, sharpening with every denoising step
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      const pts = Array.from({ length: N }, (_, j) => [pv[2 * j], pv[2 * j + 1]]);
      for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      const span = Math.max(maxx - minx, maxy - miny) || 1;
      const size = 130, cx = W / 2, cy = 112;
      for (let j = 0; j < N; j++) {
        const [ax, ay] = pts[j], [bx, by] = pts[(j + 1) % N];
        const known = r.track.known[j];
        for (let s = 0; s < 8; s++) {
          const x = ax + ((bx - ax) * s) / 8, y = ay + ((by - ay) * s) / 8;
          const px = cx + ((x - (minx + maxx) / 2) / span) * size;
          const py = cy - ((y - (miny + maxy) / 2) / span) * size;
          if (known) scr.fillRect(px - 1, py - 1, 3, 3, HOT);
          else if ((j * 8 + s + Math.floor(now * 10)) % 3 === 0) scr.fillRect(px, py, 1, 1, DREAM);
        }
      }
      f.draw(scr, `DENOISING ${Math.round((r.live?.denoise ?? 0) * 100)}%`, W / 2, H - 34, { color: 0xffffffff, align: "center" });
    } else if (r && !r.live) {
      f.draw(scr, "LOADING YOUR LOCKED CIRCUIT", W / 2, H / 2, { color: 0xffffffff, align: "center" });
    }
    f.draw(scr, "ESC TO CANCEL", W / 2, H - 18, { color: DIM, align: "center" });
  }

  private results(r: Race): void {
    const scr = this.scr, f = this.font;
    scr.dimRect(0, 0, W, H, INK, 0.6);
    f.draw(scr, "RESULTS", W / 2, 6, { scale: 2, rows: LOGO_ROWS, outline: INK, align: "center" });
    f.draw(scr, "TIME", 262, 28, { color: DIM, align: "right" });
    f.draw(scr, "BEST LAP", 346, 28, { color: DIM, align: "right" });
    const rows = r.results();
    rows.forEach((row, i) => {
      const y = 39 + i * 10;
      const me = row.kart.isPlayer;
      const c = me ? HOT : 0xffffffff;
      f.draw(scr, `${i + 1}`, 52, y, { color: c, align: "right", outline: INK });
      scr.fillRect(60, y + 1, 6, 6, LIVERIES[row.kart.livery].body);
      f.draw(scr, row.kart.name, 72, y, { color: c, outline: INK });
      f.draw(scr, (row.estimated ? "~" : "") + formatTime(row.time), 262, y, { color: c, align: "right", outline: INK });
      f.draw(scr, row.best ? formatTime(row.best) : "--", 346, y, { color: DIM, align: "right", outline: INK });
    });
    const st = r.live?.stats;
    if (st) {
      const resampled = st.retries === 1 ? "1 ARC RESAMPLED" : `${st.retries} ARCS RESAMPLED`;
      f.draw(scr, `CIRCUIT DREAMED LIVE IN ${st.arcs} ARCS, ${resampled}`, W / 2, 41 + rows.length * 10,
             { color: DREAM, align: "center", outline: INK });
    }
    this.menus.results.draw(scr, f, W / 2, H - 66, this.time);
  }
}

const game = new Game();
void game.boot();
if (import.meta.env.DEV) {
  // test hook: drive the simulation deterministically even when the tab is not painting
  (window as unknown as { __dc: unknown }).__dc = {
    step: (n: number, keys: string[] = [], draw = true) => game.debugStep(n, keys, draw),
    shot: (cam: Partial<Camera>) => game.debugShot(cam),
    game,
    state: () => game.debugState(),
    race: (points: number[], theme = 0, rivals = 5) => game.debugRace(points, theme, rivals),
    hold: (on = true) => { game.debugHold = on; },
  };
}
