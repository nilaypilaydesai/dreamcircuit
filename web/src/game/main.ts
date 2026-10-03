// DREAM CIRCUIT: the retro kart racer whose circuit is dreamed live by a diffusion model.
// Screens: title (with an AI attract race behind it), main menu, the garage, quick race setup, the
// Grand Prix (setup, a race in every world, the standings after each, the award ceremony), how to
// play, the "dreaming" intro, the race itself, pause and results. DATA and DREAM LAB open data.html.

import "./game.css";
import { Sound } from "./core/audio";
import { PixelFont, drawTextToSprite } from "./core/font";
import { H, Rand, Screen, W, hex, mix, type Sprite } from "./core/gfx";
import { GameInput, type MenuEvent } from "./core/input";
import { RivalDriver } from "./race/ai";
import { Cup, type CupRow, type Entrant } from "./race/cup";
import { AIMED, type ItemKind, BLAST_TIME } from "./race/items";
import { CLASSES, type Controls, type Difficulty, type Kart } from "./race/kart";
import { type Build, DEFAULT_BUILD, bodyOf, cleanBuild, rivalBuild } from "./race/parts";
import { Race, takesControls, type RaceEvent, type RaceSetup } from "./race/race";
import { type WorldSprite, drawWorldSprites } from "./render/billboards";
import { type Camera, drawGround, fitCamera, makeCamera, viewScale } from "./render/mode7";
import type { Face } from "./render/poly";
import { aimArrow, bridgeFaces, hillFaces, padFaces, rampFaces, tunnelFaces } from "./render/structures";
import { Sky } from "./render/sky";
import {
  LIVERIES, type SceneryArt, blastFrames, bombFrames, boomerangFrames, heldArt, itemBoxFrames, kartSprites, orbArt,
  slickArt,
} from "./render/sprites";
import { THEMES } from "./themes";
import { CAUSTIC, caustics, fishSprites, makeSchools, waterOverlay } from "./render/underwater";
import { Ceremony, STANDINGS_SETTLE, drawStandings } from "./ui/ceremony";
import { Garage } from "./ui/garage";
import { Hud, formatTime, kartColor } from "./ui/hud";
import { Menu } from "./ui/menus";
import { type Layout, N, checkLap } from "./world/track";
import { CircuitDesigner, fromSteps, smoothArc, toGame } from "./world/trackgen";

type Mode = "boot" | "title" | "main" | "garage" | "setup" | "cupSetup" | "howto" | "dreaming" | "race" | "pause"
  | "results" | "standings" | "podium";

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
const ENGINE_LEVELS = [{ label: "LOW", level: 0.18 }, { label: "OFF", level: 0 }];
const SAVE = "dreamcircuit.v3"; // the garage build and the engine setting (this browser only)

interface Attract {
  race: Race;
  sky: Sky;
  cam: Camera;
  driver: RivalDriver;
}

/** Read the saved garage build and settings; storage can be missing or blocked. */
function loadSaved(): { build: Build; engine: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE) ?? "{}") as { build?: unknown; engine?: unknown };
    return { build: cleanBuild(raw.build), engine: raw.engine === 1 ? 1 : 0 };
  } catch {
    return { build: DEFAULT_BUILD, engine: 0 }; // private window or blocked storage: defaults
  }
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
  private readonly boxArt: SceneryArt[] = itemBoxFrames();
  private readonly slickArt: SceneryArt = slickArt();
  private readonly orbArt: SceneryArt = orbArt();
  private readonly boomArt: SceneryArt[] = boomerangFrames();
  private readonly bombArt: SceneryArt[] = bombFrames();
  private readonly blastArt: SceneryArt[] = blastFrames();
  private readonly held: Record<ItemKind, SceneryArt> = heldArt();
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
  private flash = 0; // s of white flash left (a shock)
  private time = 0;
  private settings = { rivals: 5, diff: 1, theme: 0, circuit: 0, layout: 0, engine: 0 };
  private build: Build = DEFAULT_BUILD;
  private garage!: Garage;
  private garageReturn: Mode = "main";
  private menus!: Record<"main" | "setup" | "cupSetup" | "pause" | "pauseCup" | "results" | "standings", Menu>;
  private cup: Cup | null = null; // a Grand Prix in progress
  private cupRows: CupRow[] = []; // the standings after its last race
  private standingsAt = 0; // when they were shown (they animate)
  private ceremony: Ceremony | null = null;

  constructor() {
    const canvas = document.getElementById("game") as HTMLCanvasElement;
    this.scr = new Screen(canvas);
    this.input = new GameInput(canvas, document.getElementById("touch")!);
    this.input.onMute = () => this.sound.toggleMute();
    this.scr.onResize = () => this.refit();
    const saved = loadSaved();
    this.build = saved.build;
    this.settings.engine = saved.engine;
    this.sound.engineLevel = ENGINE_LEVELS[saved.engine].level;
  }

  private save(): void {
    try {
      localStorage.setItem(SAVE, JSON.stringify({ build: this.build, engine: this.settings.engine }));
    } catch {
      // storage blocked: the build lasts until the tab closes, which is fine
    }
  }

  /** The screen changed shape: re-frame the cameras and repaint the skies for the new horizon. */
  private refit(): void {
    fitCamera(this.cam);
    if (this.race && this.sky) this.sky = new Sky(this.race.setup.theme, this.cam.horizon, this.seed + 3);
    const a = this.attract;
    if (a) {
      fitCamera(a.cam);
      a.sky = new Sky(a.race.setup.theme, a.cam.horizon, this.seed + 3);
    }
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
    this.buildMenus();
    this.garage = new Garage(this.build, (b) => { this.build = b; this.save(); }, () => this.go(this.garageReturn));
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
        { label: "QUICK RACE", action: () => this.go("setup"), hint: "ONE RACE, 3 LAPS, ON A CIRCUIT THE AI DREAMS FOR YOU" },
        { label: "GRAND PRIX", action: () => this.go("cupSetup"), hint: "A RACE IN EVERY WORLD, POINTS FOR EVERY FINISH, AND A PODIUM" },
        { label: "GARAGE", action: () => this.openGarage("main"), hint: "BUILD YOUR KART: BODY, WHEELS, SPOILER, EXHAUST, PAINT" },
        { label: "DREAM LAB", action: () => { location.href = "data.html#lab"; }, hint: "DRIVE INSIDE THE NEURAL WORLD MODEL" },
        { label: "DATA", action: () => { location.href = "data.html"; }, hint: "THE MODELS, THE PHYSICS AUDIT, THE CHARTS" },
        { label: "HOW TO PLAY", action: () => this.go("howto") },
        { label: "SOUND", value: () => (this.sound.muted ? "OFF" : "ON"), action: () => this.sound.toggleMute(), hint: "M TOGGLES SOUND ANYTIME" },
        { label: "ENGINE", value: () => ENGINE_LEVELS[s.engine].label, hint: "THE ENGINE HUM UNDER THE MUSIC",
          left: () => this.setEngine(), right: () => this.setEngine() },
      ]),
      setup: new Menu("QUICK RACE", [
        { label: "RIVALS", value: () => String(s.rivals), left: () => { s.rivals = Math.max(0, s.rivals - 1); }, right: () => { s.rivals = Math.min(7, s.rivals + 1); }, hint: "HOW MANY AI KARTS RACE YOU (0-7)" },
        { label: "DIFFICULTY", value: () => CLASSES[DIFFS[s.diff]].label, left: () => { s.diff = (s.diff + 2) % 3; }, right: () => { s.diff = (s.diff + 1) % 3; }, hint: "SPEED CLASS, HOW SHARP THE RIVALS DRIVE AND HOW GOOD THEIR KARTS ARE" },
        { label: "WORLD", value: () => (s.theme === THEMES.length ? "RANDOM" : THEMES[s.theme].name), left: () => { s.theme = (s.theme + THEMES.length) % (THEMES.length + 1); }, right: () => { s.theme = (s.theme + 1) % (THEMES.length + 1); } },
        { label: "LAYOUT", value: () => LAYOUTS[s.layout].label, left: () => { s.layout = (s.layout + LAYOUTS.length - 1) % LAYOUTS.length; }, right: () => { s.layout = (s.layout + 1) % LAYOUTS.length; }, hint: "LOOP, OR A FIGURE 8 THAT CROSSES ITSELF ON A BRIDGE" },
        { label: "CIRCUIT", value: () => (s.circuit === 0 || !this.lastCircuit ? "NEW DREAM" : "LAST ONE"), left: () => { s.circuit = s.circuit ? 0 : 1; }, right: () => { s.circuit = s.circuit ? 0 : 1; }, hint: "A FRESH DREAM, OR RE-RACE YOUR LAST LOCKED CIRCUIT" },
        { label: "KART", value: () => bodyOf(this.build).name, action: () => this.openGarage("setup"), hint: "OPEN THE GARAGE" },
        { label: "START RACE", action: () => void this.startRace(s.circuit === 1 && !!this.lastCircuit) },
        { label: "BACK", action: () => this.go("main") },
      ], 300),
      cupSetup: new Menu("GRAND PRIX", [
        { label: "RIVALS", value: () => String(s.rivals), left: () => { s.rivals = Math.max(1, s.rivals - 1); }, right: () => { s.rivals = Math.min(7, s.rivals + 1); }, hint: "THE SAME RIVALS IN THE SAME KARTS ALL THE WAY (1-7)" },
        { label: "DIFFICULTY", value: () => CLASSES[DIFFS[s.diff]].label, left: () => { s.diff = (s.diff + 2) % 3; }, right: () => { s.diff = (s.diff + 1) % 3; }, hint: "SPEED CLASS, HOW SHARP THE RIVALS DRIVE AND HOW GOOD THEIR KARTS ARE" },
        { label: "LAYOUT", value: () => LAYOUTS[s.layout].label, left: () => { s.layout = (s.layout + LAYOUTS.length - 1) % LAYOUTS.length; }, right: () => { s.layout = (s.layout + 1) % LAYOUTS.length; }, hint: "LOOP, OR A FIGURE 8 THAT CROSSES ITSELF ON A BRIDGE" },
        { label: "KART", value: () => bodyOf(this.build).name, action: () => this.openGarage("cupSetup"), hint: "OPEN THE GARAGE" },
        { label: "START GRAND PRIX", action: () => void this.startCup(), hint: `${THEMES.length} WORLDS. POINTS BY PLACE: 15 12 10 8 6 4 2 1` },
        { label: "BACK", action: () => this.go("main") },
      ], 300),
      pause: new Menu("PAUSED", [
        { label: "RESUME", action: () => this.go("race") },
        { label: "RESTART", action: () => this.raceAgain(), hint: "SAME CIRCUIT, FRESH START" },
        { label: "QUIT TO MENU", action: () => this.quitToMenu() },
      ]),
      pauseCup: new Menu("PAUSED", [
        { label: "RESUME", action: () => this.go("race") },
        { label: "QUIT GRAND PRIX", action: () => this.quitToMenu(), hint: "THE POINTS SO FAR ARE LOST" },
      ]),
      standings: new Menu("", [
        { label: "NEXT RACE", action: () => this.nextInCup() },
        { label: "QUIT GRAND PRIX", action: () => this.quitToMenu() },
      ], 240),
      results: new Menu("", [
        { label: "RACE AGAIN", action: () => this.raceAgain(), hint: "SAME CIRCUIT" },
        { label: "NEW DREAM CIRCUIT", action: () => void this.startRace(false) },
        { label: "MAIN MENU", action: () => this.quitToMenu() },
      ], 240),
    };
  }

  private setEngine(): void {
    this.settings.engine = (this.settings.engine + 1) % ENGINE_LEVELS.length;
    this.sound.engineLevel = ENGINE_LEVELS[this.settings.engine].level;
    this.save();
  }

  private openGarage(from: Mode): void {
    this.garageReturn = from;
    this.garage.menu.index = 0;
    this.go("garage");
  }

  private go(m: Mode): void {
    this.mode = m;
    if (m === "setup") this.menus.setup.index = this.menus.setup.items.length - 2;
    if (m === "cupSetup") this.menus.cupSetup.index = this.menus.cupSetup.items.length - 2;
    if (m === "pause") this.sound.setEngine(0, false, false);
    if (m !== "pause") this.autoPaused = false;
    this.input.setRacing(m === "race", m === "race" || m === "dreaming");
    this.music();
  }

  /** The soundtrack follows the screen: the title loop in menus, the world's loop in a race. */
  private music(): void {
    const mu = this.sound.music;
    if (["pause", "results", "boot", "standings", "podium"].includes(this.mode)) mu.stop();
    else if (this.mode === "race" || this.mode === "dreaming") {
      const id = this.race?.setup.theme.id ?? "valley";
      mu.play(id);
    } else mu.play("title");
  }

  private quitToMenu(): void {
    this.race = null;
    this.cup = null;
    this.ceremony = null;
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
    const race = new Race({ rivals: 5, difficulty: "pro", theme, seed: this.seed + 7, replay: pts, build: this.build },
                          null, (s) => this.banner(s));
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
    void this.startRace(false, { ...r.setup, replay, build: this.build });
  }

  private async startRace(sameCircuit: boolean, again?: RaceSetup): Promise<void> {
    this.raceError = "";
    const live = again ? !again.replay : !(sameCircuit && this.lastCircuit);
    if (live && !this.designer) {
      // A quick player can press START before the designer has loaded: start once it has.
      if (this.waitingForDesigner) return;
      const from = this.mode;
      this.waitingForDesigner = true;
      await this.designerReady;
      this.waitingForDesigner = false;
      if (!this.designer || this.mode !== from) return;
    }
    const s = this.settings;
    const theme = s.theme === THEMES.length ? THEMES[(Math.random() * THEMES.length) | 0] : THEMES[s.theme];
    // a live race with the same seed dreams the same circuit again
    const setup: RaceSetup = again ?? {
      rivals: s.rivals, difficulty: DIFFS[s.diff], theme, seed: (Math.random() * 1e9) | 0,
      replay: sameCircuit && this.lastCircuit ? this.lastCircuit : null, layout: LAYOUTS[s.layout].id, build: this.build,
    };
    this.seed = setup.seed;
    const race = new Race(setup, this.designer, (sp) => this.banner(sp));
    this.race = race;
    this.sky = new Sky(setup.theme, this.cam.horizon, this.seed + 3);
    this.hud.banners = [];
    this.flash = 0;
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
      this.go(this.cup ? "cupSetup" : "setup");
      this.cup = null;
      return;
    }
    if (this.race !== race) return; // the player backed out while it was dreaming
    this.snapCamera(this.cam, race);
    this.go("race");
  }

  // ----------------------------------------------------------------------------------------
  // the Grand Prix

  /** A Grand Prix: one race in every world, the same rivals in the same karts throughout. */
  private async startCup(): Promise<void> {
    this.cup = new Cup(THEMES.slice(), (Math.random() * 1e9) | 0);
    await this.startCupRace();
  }

  private async startCupRace(): Promise<void> {
    const cup = this.cup;
    if (!cup) return;
    const s = this.settings;
    await this.startRace(false, {
      rivals: Math.max(1, s.rivals), difficulty: DIFFS[s.diff], theme: cup.world,
      seed: (cup.seed + 7919 * (cup.index + 1)) | 0, replay: null, layout: LAYOUTS[s.layout].id,
      build: this.build, rivalSeed: cup.seed,
    });
  }

  private entrant(k: Kart): Entrant {
    return { id: k.id, name: k.name, livery: k.livery, build: k.build, isPlayer: k.isPlayer };
  }

  /** A Grand Prix race is over: score it and show the standings. */
  private finishCupRace(r: Race): void {
    const cup = this.cup!;
    this.cupRows = cup.award(r.results().map((row) => ({ entrant: this.entrant(row.kart), time: row.time })));
    this.standingsAt = this.time;
    const next = this.menus.standings;
    next.items[0].label = cup.done ? "AWARD CEREMONY" : `NEXT: ${cup.world.name}`;
    next.index = 0;
    this.go("standings");
  }

  private nextInCup(): void {
    const cup = this.cup;
    if (!cup) return;
    if (!cup.done) {
      void this.startCupRace();
      return;
    }
    const place = cup.ranking().findIndex((e) => e.isPlayer) + 1;
    this.ceremony = new Ceremony(cup.podium(), place);
    this.race = null;
    this.go("podium");
  }

  /** The standings are still animating (their menu is not up yet). */
  private standingsSettling(): boolean {
    return this.mode === "standings" && this.time - this.standingsAt < STANDINGS_SETTLE;
  }

  /** The ceremony is over (after the camera has pulled back): back to the main menu. */
  private endCeremony(): void {
    if ((this.ceremony?.elapsed ?? 99) < 7.5) return;
    this.quitToMenu();
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
    cam.heading += d * (1 - Math.exp(-dt * (p.rocket > 0 ? 9 : 6.5)));
    const jitter = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.04 : 0;
    const back = p.rocket > 0 ? 7.4 : 6.2;
    cam.x = p.x - Math.cos(cam.heading) * back;
    cam.y = p.y - Math.sin(cam.heading) * back;
    cam.heading += jitter;
    // ride up onto bridges with the kart; on a jump, rise only partway for a sense of air
    const lift = p.ground + (p.elev - p.ground) * 0.55;
    cam.lift += (lift - cam.lift) * (1 - Math.exp(-dt * (p.air ? 5 : 9)));
    cam.height = BASE_HEIGHT + cam.lift;
    // speed: a wider view and speed lines while boosting (and much more as a rocket)
    const fx = p.rocket > 0 ? 1.6 : p.boostTime > 0 || p.prism > 0 ? 1 : 0;
    cam.fx += (fx - cam.fx) * (1 - Math.exp(-dt * 6));
    cam.focal = BASE_FOCAL * viewScale() * (1 - 0.12 * cam.fx);
  }

  /** White streaks rushing past the edges of the screen while boosting. */
  private speedLines(cam: Camera): void {
    if (cam.fx < 0.05) return;
    const scr = this.scr;
    const t = this.time;
    const k0 = viewScale();
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2 + Math.sin(k * 7.3) * 0.2;
      const phase = (t * 3.2 + k * 0.37) % 1;
      const r0 = (120 + phase * 90) * k0, r1 = r0 + (18 + 14 * cam.fx) * k0;
      for (let r = r0; r < r1; r += 1.5) {
        const x = W / 2 + Math.cos(a) * r * 1.25 * (W / 384 / k0), y = cam.horizon + 20 * k0 + Math.sin(a) * r * 0.62;
        if (x >= 0 && x < W && y >= 0 && y < H) scr.dimRect(x, y, 1, 1, 0xffffffff, Math.min(1, 0.55 * cam.fx));
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
      else if (e.kind === "use") this.useSound(e.item, now);
      else if (e.kind === "spun") { this.sound.spin(); this.shake = 0.35; }
      else if (e.kind === "hit") this.sound.hit();
      else if (e.kind === "blocked") { this.sound.blocked(); this.hud.popup("BLOCKED!", now, hex("#63c8ff")); }
      else if (e.kind === "boom") { this.sound.explode(e.near); if (e.near) this.shake = Math.max(this.shake, 0.4); }
      else if (e.kind === "shock") { this.sound.shock(); this.flash = 0.22; }
      else if (e.kind === "rocketOver") this.hud.popup("ROCKET SPENT", now, DIM);
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

  private useSound(item: ItemKind, now: number): void {
    switch (item) {
      case "turbo": case "triple": this.sound.boost(); break;
      case "oil": this.sound.oil(); break;
      case "orb": this.sound.orb(); break;
      case "boomerang": this.sound.boomerang(); break;
      case "bomb": this.sound.bombThrow(); break;
      case "prism": this.sound.prism(); this.hud.popup("PRISM!", now, DREAM); break;
      case "shock": break; // the shock event plays it, for everyone's shocks
      case "rocket": this.sound.rocketGo(); this.hud.popup("ROCKET!", now, hex("#ff8a1f")); break;
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
    const menuFor: Partial<Record<Mode, Menu>> = {
      main: this.menus.main, setup: this.menus.setup, cupSetup: this.menus.cupSetup,
      pause: this.cup ? this.menus.pauseCup : this.menus.pause, results: this.menus.results,
      standings: this.menus.standings, garage: this.garage.menu,
    };
    for (const e of evs) this.onEvent(e, menuFor[this.mode]);
    if (click) {
      if (this.mode === "title") this.go("main");
      else if (this.mode === "howto") this.go("main");
      else if (this.mode === "podium") this.endCeremony();
      else if (this.standingsSettling()) this.standingsAt = this.time - STANDINGS_SETTLE;
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
    if (this.mode === "podium") {
      if (e === "confirm" || e === "back" || e === "pause") this.endCeremony();
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
      if (e === "back" || e === "cancel" || e === "pause") this.quitToMenu(); // pause: the touch II button
      return;
    }
    if (this.standingsSettling()) {
      // still counting up (and a drift or gas press from the finish must not skip them): a press
      // jumps to the final order, and the menu takes input once it shows
      if (e === "confirm") this.standingsAt = this.time - STANDINGS_SETTLE;
      return;
    }
    if (menu) {
      const r = menu.handle(e, this.sound);
      if (r === "back") {
        if (this.mode === "pause") this.go("race");
        else if (this.mode === "setup" || this.mode === "cupSetup") this.go("main");
        else if (this.mode === "main") this.go("title");
        else if (this.mode === "garage") this.go(this.garageReturn);
      }
    }
  }

  private update(dt: number): void {
    if (this.shake > 0) this.shake -= dt;
    if (this.mode === "podium") this.ceremony?.update(dt, this.sound);
    if (this.flash > 0) this.flash -= dt;
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
      const c: Controls = takesControls(r.phase) ? this.input.drive(r.phase === "countdown")
        : { steer: 0, throttle: 0, brake: 0, drift: false };
      r.update(dt, c);
      this.handleEvents(r, r.events);
      r.events = [];
      this.follow(this.cam, r, dt);
      const p = r.player;
      this.sound.setEngine(Math.abs(p.v) / r.cls.vmax, r.phase !== "done", p.surface === "grass");
      if (r.phase === "done" && this.mode === "race") {
        this.sound.setEngine(0, false, false);
        if (this.cup) this.finishCupRace(r);
        else {
          this.menus.results.index = 0;
          this.go("results");
        }
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
    const theme = race.setup.theme;
    drawGround(this.scr, cam, race.tex, theme.fog, mist,
               theme.underwater ? { color: CAUSTIC, at: caustics(this.time) } : undefined);
    const extras: WorldSprite[] = [];
    const now = this.time;
    const it = race.items;
    it.boxes.forEach((b, i) => {
      if (b.respawn > 0) return;
      const art = this.boxArt[(Math.floor(now * 6) + i) % this.boxArt.length];
      extras.push({ x: b.x, y: b.y, art, lift: 0.3 + 0.12 * Math.sin(now * 3 + i), base: b.elev });
    });
    for (const sl of it.slicks) extras.push({ x: sl.x, y: sl.y, art: this.slickArt, base: sl.elev });
    for (const o of it.orbs) {
      extras.push({ x: o.x, y: o.y, art: this.orbArt, lift: 0.45 + 0.1 * Math.sin(now * 9), base: t.elev[o.idx] ?? 0 });
    }
    for (const b of it.boomerangs) {
      extras.push({ x: b.x, y: b.y, art: this.boomArt[Math.floor(now * 16) % this.boomArt.length], lift: 0.4, base: b.z - 0.9 });
    }
    for (const b of it.bombs) {
      const ground = t.elev[b.idx] ?? 0;
      extras.push({ x: b.x, y: b.y, art: this.bombArt[Math.floor(now * 8) % 2], lift: Math.max(0, b.z - ground), base: ground });
    }
    for (const b of it.blasts) {
      const f = Math.min(this.blastArt.length - 1, Math.floor((b.age / BLAST_TIME) * this.blastArt.length));
      extras.push({ x: b.x, y: b.y, art: this.blastArt[f], base: b.z });
    }
    if (theme.underwater) extras.push(...fishSprites(this.schools(race), now, cam.heading));
    const faces: Face[] = [];
    const painter = { cam, scr: this.scr, fog: race.setup.theme.fog, faces };
    bridgeFaces(painter, t, race.setup.theme);
    hillFaces(painter, t, theme);
    tunnelFaces(painter, t, race.features);
    rampFaces(painter, t, race.features, race.setup.theme);
    padFaces(painter, t, race.features, now);
    // the player's aiming arrow while a boomerang or a bomb is ready (locked, it turns blue)
    const me = race.player;
    if (me.item && AIMED.has(me.item) && me.roulette <= 0 && me.rocket <= 0 && race === this.race) {
      aimArrow(painter, me, me.trailing ? me.aimLocked ?? me.aim : me.aim, me.trailing ? hex("#63c8ff") : HOT);
    }
    drawWorldSprites(this.scr, cam, race.scenery.items, race.karts, {
      sprites: (k: Kart) => kartSprites(k.build, LIVERIES[k.livery], k.rocket > 0),
      sparks: (k: Kart) => (k.drifting ? Math.max(1, k.boostLevel) : 0),
      held: (k: Kart) => (k.item && k.roulette <= 0 ? this.held[k.item] : null),
      dome: !!theme.underwater,
    }, theme.fog, extras, faces);
    if (theme.underwater) waterOverlay(this.scr, now);
    // inside a tunnel the light drops
    if (race.features.tunnels.length) {
      const ci = t.nearest(cam.x, cam.y, race.player.idx);
      if (race.features.tunnelAt(t.s[ci]) && Math.abs(t.offset(cam.x, cam.y, ci)) < 7) {
        this.scr.dimRect(0, 0, W, H, hex("#0b0b14"), 0.34);
      }
    }
  }

  private readonly fish = new WeakMap<Race, ReturnType<typeof makeSchools>>();

  /** The reef's schools of fish, made once per race, scattered over the world around the lap. */
  private schools(race: Race): ReturnType<typeof makeSchools> {
    let s = this.fish.get(race);
    if (!s) {
      s = makeSchools(race.setup.seed + 5, (rng) => [rng.range(-180, 180), rng.range(-180, 180)]);
      this.fish.set(race, s);
    }
    return s;
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
    this.hud.touch = this.input.touchMode;
    switch (this.mode) {
      case "boot":
        scr.clear(INK);
        break;
      case "title": {
        background();
        const oy = Math.max(-12, Math.round((H - 216) / 2)); // centred on taller and shorter screens
        f.draw(scr, "DREAM", W / 2, 38 + oy, { scale: 5, rows: LOGO_ROWS, outline: INK, shadow: hex("#2a0f4a"), align: "center" });
        f.draw(scr, "CIRCUIT", W / 2, 82 + oy, { scale: 5, rows: LOGO_ROWS, outline: INK, shadow: hex("#2a0f4a"), align: "center" });
        f.wrap("THE KART RACER AN AI DREAMS AS YOU DRIVE", W - 16).forEach((line, i) =>
          f.draw(scr, line, W / 2, 132 + oy + i * 10, { color: DREAM, outline: INK, align: "center" }));
        if (Math.floor(now * 2) % 2 === 0) {
          const prompt = this.input.touchMode ? "TAP TO START" : "PRESS ENTER";
          f.draw(scr, this.designer ? prompt : this.designerError || "WAKING THE DREAMER...", W / 2, 160 + oy, { scale: 1, color: 0xffffffff, outline: INK, align: "center" });
        }
        f.draw(scr, "A DIFFUSION MODEL DESIGNS EVERY TRACK", W / 2, H - 14, { color: DIM, outline: INK, align: "center" });
        break;
      }
      case "main":
      case "setup":
      case "cupSetup": {
        background();
        const menu = this.mode === "main" ? this.menus.main : this.mode === "setup" ? this.menus.setup : this.menus.cupSetup;
        const logo = H < 214 ? 6 : 16;
        f.draw(scr, "DREAM CIRCUIT", W / 2, logo, { scale: 2, rows: LOGO_ROWS, outline: INK, align: "center" });
        // the panel and its hint (up to two lines) sit in the space under the logo; on the setup
        // screen, a designer that is still loading (or a failed dream) takes the hint's place
        const top = Math.max(logo + 22, Math.min(46, Math.round((H - menu.height() - 24 + logo + 22) / 2)));
        const err = this.raceError || this.designerError;
        const note = this.mode !== "main" && (!this.designer || this.raceError)
          ? { text: err || "WAKING THE DREAMER...", color: err ? HOT : DREAM } : undefined;
        menu.draw(scr, f, W / 2, top, now, note);
        break;
      }
      case "garage":
        this.garage.draw(scr, f, now);
        break;
      case "howto":
        background();
        this.howTo();
        break;
      case "dreaming":
        this.dreamingScreen();
        break;
      case "podium":
        this.ceremony?.draw(scr, f, this.input.touchMode);
        break;
      case "race":
      case "pause":
      case "results":
      case "standings": {
        const r = this.race;
        if (!r || !this.sky) break;
        this.drawWorld(r, this.sky, this.cam);
        this.speedLines(this.cam);
        if (this.flash > 0) scr.dimRect(0, 0, W, H, 0xffffffff, Math.min(0.85, this.flash * 4));
        if (this.mode === "race") this.hud.draw(scr, r, now);
        if (this.mode === "pause") {
          scr.dimRect(0, 0, W, H, INK, 0.45);
          const pm = this.cup ? this.menus.pauseCup : this.menus.pause;
          pm.draw(scr, f, W / 2, Math.max(20, Math.round((H - pm.height()) / 2) - 10), now);
        }
        if (this.mode === "results") this.results(r);
        if (this.mode === "standings" && this.cup) {
          drawStandings(scr, f, this.cup, this.cupRows, now - this.standingsAt);
          const sm = this.menus.standings;
          if (now - this.standingsAt >= STANDINGS_SETTLE) sm.draw(scr, f, W / 2, H - sm.height() - 4, now);
        }
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
        return { ...a, item: held.has("item") || !!a.item };
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
    this.cup = null;
    void this.startRace(false, {
      rivals, difficulty: "pro", theme: THEMES[theme], seed: 1234, replay: Float64Array.from(points), layout: "any",
      build: this.build,
    });
  }

  /** Dev only: a made-up Grand Prix, to see its standings (over the current race) or, with
   * ``ceremony``, its award ceremony. */
  debugCup(ceremony: boolean, playerPlace = 1): void {
    const cup = new Cup(THEMES.slice(), 7);
    const rng = new Rand(3);
    const field: Entrant[] = LIVERIES.slice(0, 6).map((l, i) => ({
      id: i, name: l.name, livery: i, build: i ? rivalBuild(rng, "legend") : this.build, isPlayer: i === 0,
    }));
    const races = ceremony ? THEMES.length : 2;
    for (let r = 0; r < races; r++) {
      const order = [...field].sort((a, b) => (a.isPlayer ? playerPlace - 0.5 : a.id) - (b.isPlayer ? playerPlace - 0.5 : b.id))
        .map((e, i) => ({ entrant: e, time: 110 + i * 2.5 + r }));
      this.cupRows = cup.award(order);
    }
    this.cup = cup;
    if (ceremony) {
      this.nextInCup();
      return;
    }
    this.standingsAt = this.time;
    this.menus.standings.items[0].label = `NEXT: ${cup.world.name}`;
    this.go("standings");
  }

  /** Dev only: hand the player an item, as if from a box. */
  debugGive(item: ItemKind): void {
    const r = this.race;
    if (r) r.items.grant(r.player, item);
  }

  /** Dev only: pin the framebuffer size (the film tool records at 384x216). */
  debugPin(size: [number, number] | null): void {
    this.scr.pin(size);
  }

  /** Dev only: open a screen (garage, howto, ...). */
  debugGo(mode: Mode): void {
    if (mode === "garage") this.openGarage("main");
    else this.go(mode);
  }

  debugState(): Record<string, unknown> {
    const r = this.race;
    return {
      mode: this.mode,
      size: [W, H],
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
      item: r?.player.item ?? null,
      rocket: r ? r.player.rocket > 0 : false,
      build: this.build,
      stats: r?.live?.stats,
      busy: r?.live?.busy ?? false,
      length: r?.track.locked ? Math.round(r.track.length) : null,
    };
  }

  private howTo(): void {
    const f = this.font, scr = this.scr;
    const x0 = Math.max(8, Math.round(W / 2 - 176)), right = Math.min(W - 8, Math.round(W / 2 + 176));
    scr.dimRect(x0, 8, right - x0, H - 16, hex("#0c0a1d"), 0.88);
    f.draw(scr, "HOW TO PLAY", W / 2, 14, { color: HOT, outline: INK, align: "center" });
    const rows: [string, string][] = [
      ["DRIVE", "ARROWS OR W A S D"],
      ["DRIFT", "HOLD SHIFT OR SPACE IN A TURN, LET GO FOR A MINI-TURBO"],
      ["ITEM", "E: TAP TO USE. HOLD TO KEEP OIL, ORBS OR A BOMB BEHIND YOU AS A SHIELD"],
      ["AIM", "BOOMERANGS AND BOMBS GO WHERE THE SWEEPING ARROW POINTS WHEN YOU PRESS E"],
      ["RAMP", "SPACE AT THE LIP FOR A TRICK BOOST"],
      ["START", "GAS JUST BEFORE GO: ROCKET START"],
      ["TOUCH", "THE STICK STEERS. PUSH IT ALL THE WAY OVER TO DRIFT, PULL BACK TO BRAKE"],
      ["PAD", "A GAS  B BRAKE  RB DRIFT  Y ITEM"],
      ["PAUSE", "ESC    SOUND M"],
    ];
    const kx = x0 + 10, vx = kx + 52;
    let y = 30;
    for (const [k, v] of rows) {
      f.draw(scr, k, kx, y, { color: DREAM });
      for (const line of f.wrap(v, right - vx - 8)) {
        f.draw(scr, line, vx, y, { color: 0xffffffff });
        y += 9;
      }
      y += 1;
    }
    y += 4;
    const story = "NOBODY DESIGNED YOUR CIRCUIT: A DIFFUSION MODEL DREAMS THE ROAD AHEAD OF THE PACK ON LAP 1, THEN IT LOCKS. THE GRAND PRIX RACES EVERY WORLD FOR POINTS.";
    for (const line of f.wrap(story, right - x0 - 20)) {
      if (y > H - 30) break;
      f.draw(scr, line, W / 2, y, { color: DIM, align: "center" });
      y += 9;
    }
    f.draw(scr, this.input.touchMode ? "TAP TO GO BACK" : "PRESS ANY KEY", W / 2, H - 20, { color: 0xffffffff, align: "center" });
  }

  private dreamingScreen(): void {
    const scr = this.scr, f = this.font, now = this.time;
    for (let y = 0; y < H; y++) scr.fillRect(0, y, W, 1, mix(hex("#0b0420"), hex("#2a0f4a"), y / H));
    const r = this.race;
    const pv = r?.live?.preview;
    f.draw(scr, "THE AI IS DREAMING YOUR CIRCUIT", W / 2, 22, { color: DREAM, outline: INK, align: "center" });
    if (r) {
      const where = this.cup ? `GRAND PRIX RACE ${this.cup.index + 1} OF ${this.cup.worlds.length}: ` : "";
      f.draw(scr, where + r.setup.theme.name, W / 2, 34, { color: HOT, outline: INK, align: "center" });
    }
    if (pv && r) {
      // the designer's current whole-circuit guess, sharpening with every denoising step
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      const pts = Array.from({ length: N }, (_, j) => [pv[2 * j], pv[2 * j + 1]]);
      for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      const span = Math.max(maxx - minx, maxy - miny) || 1;
      const size = Math.min(130, H - 86), cx = W / 2, cy = Math.round(H / 2) + 4;
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
    f.draw(scr, this.input.touchMode ? "II TO CANCEL" : "ESC TO CANCEL", W / 2, H - 18, { color: DIM, align: "center" });
  }

  private results(r: Race): void {
    const scr = this.scr, f = this.font;
    scr.dimRect(0, 0, W, H, INK, 0.6);
    const c0 = Math.round(W / 2);
    f.draw(scr, "RESULTS", W / 2, 6, { scale: 2, rows: LOGO_ROWS, outline: INK, align: "center" });
    f.draw(scr, "TIME", c0 + 70, 28, { color: DIM, align: "right" });
    f.draw(scr, "BEST LAP", c0 + 154, 28, { color: DIM, align: "right" });
    const rows = r.results();
    rows.forEach((row, i) => {
      const y = 39 + i * 10;
      const me = row.kart.isPlayer;
      const c = me ? HOT : 0xffffffff;
      f.draw(scr, `${i + 1}`, c0 - 140, y, { color: c, align: "right", outline: INK });
      scr.fillRect(c0 - 132, y + 1, 6, 6, kartColor(row.kart));
      f.draw(scr, row.kart.name, c0 - 120, y, { color: c, outline: INK });
      f.draw(scr, (row.estimated ? "~" : "") + formatTime(row.time), c0 + 70, y, { color: c, align: "right", outline: INK });
      f.draw(scr, row.best ? formatTime(row.best) : "--", c0 + 154, y, { color: DIM, align: "right", outline: INK });
    });
    const st = r.live?.stats;
    if (st) {
      const resampled = st.retries === 1 ? "1 ARC RESAMPLED" : `${st.retries} ARCS RESAMPLED`;
      f.wrap(`CIRCUIT DREAMED LIVE IN ${st.arcs} ARCS, ${resampled}`, W - 16).forEach((line, i) =>
        f.draw(scr, line, W / 2, 41 + rows.length * 10 + i * 10, { color: DREAM, align: "center", outline: INK }));
    }
    this.menus.results.draw(scr, f, W / 2, H - this.menus.results.height() - 2, this.time);
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
    give: (item: ItemKind) => game.debugGive(item),
    pin: (size: [number, number] | null) => game.debugPin(size),
    go: (mode: Mode) => game.debugGo(mode),
    cup: (ceremony = false, place = 1) => game.debugCup(ceremony, place),
  };
}
