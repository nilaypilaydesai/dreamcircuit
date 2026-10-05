// DREAM CIRCUIT: the retro kart racer whose circuit is dreamed live by a diffusion model.
// Screens: title (with an AI attract race behind it), main menu, the garage, quick race setup, the
// Grand Prix (setup, a race in every world, the standings after each, the award ceremony), how to
// play, the "dreaming" intro, the race itself, pause and results. DATA and DREAM LAB open data.html.

import "./game.css";
import { Sound } from "./core/audio";
import { PixelFont, drawTextToSprite } from "./core/font";
import { H, Rand, Screen, W, drawSized, hex, mix, type Sprite } from "./core/gfx";
import { GameInput, type MenuEvent } from "./core/input";
import { RivalDriver } from "./race/ai";
import { Cup, type CupRow, type Entrant } from "./race/cup";
import { AIMED, BLAST_TIME, type ItemKind, RING_TIME, STATIC_TIME, THROWN_BACK } from "./race/items";
import { CLASSES, type Controls, type Difficulty, FALL_SWAP, type Kart } from "./race/kart";
import { type Build, DEFAULT_BUILD, bodyOf, cleanBuild, rivalBuild } from "./race/parts";
import { Race, takesControls, type RaceEvent, type RaceSetup } from "./race/race";
import { TRACK_TYPES, type TrackTypeId, surpriseType, trackType } from "./race/tracktypes";
import { FALL_TINT } from "./world/hazards";
import { type GameMap, SHOWCASE } from "./world/maps";
import { type WorldSprite, drawWorldSprites } from "./render/billboards";
import { type Camera, drawGround, fitCamera, makeCamera, viewScale } from "./render/mode7";
import type { Face, P3 } from "./render/poly";
import { aimArrow, bankFaces, bridgeFaces, hillFaces, padFaces, rampFaces, tunnelFaces } from "./render/structures";
import { type ObstacleArt, obstacleArt, obstacleFaces, obstacleSprites } from "./render/obstacles";
import { elevBetween, kartPlace, tubeBetween, tubeFaces, tubeFrame, tubeHides, tubePlace, tubeView } from "./render/tube";
import type { ObstacleSound } from "./race/obstacles";
import { landformFaces } from "./render/landforms";
import { Sky } from "./render/sky";
import {
  LIVERIES, type SceneryArt, blastFrames, bombFrames, boomerangFrames, coinFrames, cometArt, droneFrames, flareFrames,
  grabberFrames, heldArt, itemBoxFrames, kartSprites, orbArt, puckFrames, trailArt,
} from "./render/sprites";
import { hornRing, staticOverlay } from "./render/screenfx";
import { THEMES } from "./themes";
import { CAUSTIC, caustics, fishSprites, makeSchools, waterOverlay } from "./render/underwater";
import { slickDecal, slickPaint, slickRaised } from "./render/decals";
import { emberOverlay } from "./render/volcano";
import { lavaShift } from "./world/lava";
import { Ceremony, STANDINGS_SETTLE, drawStandings } from "./ui/ceremony";
import { Garage } from "./ui/garage";
import { HOWTO_PAGES, drawHowTo } from "./ui/howto";
import { Hud, formatTime, kartColor } from "./ui/hud";
import { Menu } from "./ui/menus";
import { HALF_WIDTH, type Layout, N, checkLap } from "./world/track";
import { CircuitDesigner, fromSteps, smoothArc, toGame } from "./world/trackgen";

type Mode = "boot" | "title" | "main" | "garage" | "setup" | "cupSetup" | "howto" | "dreaming" | "race" | "pause"
  | "results" | "standings" | "podium";

const INK = hex("#0b0b14");
const HOT = hex("#ffd23f");
const DREAM = hex("#c79bff");
const DIM = hex("#8f87b8");
const SKY = hex("#63c8ff"); // a wing pad's wings
const LOGO_ROWS = ["#ffe66d", "#ffd23f", "#ffb347", "#ff8c42", "#ff6b6b", "#f25f9c", "#c77dff", "#9d6bff"].map(hex);
const MY_MAPS = 8; // the player's own maps kept
const BACK_AIM = hex("#ffb347"); // the arrow sweeping behind the kart, in the mirror
const DIFFS: Difficulty[] = ["rookie", "intermediate", "pro", "legend"];
/** The TRACK row: a random type, or one of the track types (race/tracktypes.ts). */
const TRACKS: { id: TrackTypeId | "surprise"; name: string }[] = [
  { id: "surprise", name: "SURPRISE ME" }, ...TRACK_TYPES.map((t) => ({ id: t.id, name: t.name })),
];
/** What the TRACK row's hint says for a choice. */
function trackHint(i: number): string {
  const c = TRACKS[i];
  if (c.id === "surprise") return "A RANDOM TRACK TYPE, REVEALED AS THE DREAM BEGINS";
  const t = trackType(c.id);
  return t.id === "classic" ? t.promise : `CONFIRMED: ${t.promise}`;
}
const BASE_HEIGHT = 2.9; // m, camera over the player's kart
const BASE_FOCAL = 250;
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const SWING = 0.45; // s for the chase camera in the tunnel to swing round behind a kart turned round

/** A chase camera's ride in the tunnel's tube: which way down the tube it looks (``dir``), how far
 * it turns from there toward where the kart heads (``yaw``), how high it rides with the kart off the
 * tube (up a jump's ramp, partway into the air: ``lift``), and, the kart turned round, how far it
 * has still to swing round behind it (``swing``, from ``from`` over ``swung`` of SWING s). */
interface TubeRide { dir: number; yaw: number; lift: number; swing: number; from: number; swung: number }
const ENGINE_LEVELS = [{ label: "LOW", level: 0.18 }, { label: "OFF", level: 0 }];
const SAVE = "dreamcircuit.v3"; // the garage build and the engine setting (this browser only)

interface Attract {
  race: Race;
  sky: Sky;
  cam: Camera;
  driver: RivalDriver;
}

/** Read the saved garage build, settings and the player's maps; storage can be missing or blocked. */
function loadSaved(): { build: Build; engine: number; maps: GameMap[]; dreams: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE) ?? "{}") as { build?: unknown; engine?: unknown; maps?: unknown; dreams?: unknown };
    const maps = Array.isArray(raw.maps) ? raw.maps.flatMap((m): GameMap[] => {
      const { name, type, world, p } = (m ?? {}) as { name?: unknown; type?: unknown; world?: unknown; p?: unknown };
      if (typeof name !== "string" || !Array.isArray(p) || p.length !== 2 * N || !p.every((v) => typeof v === "number")) return [];
      const id = TRACK_TYPES.some((t) => t.id === type) ? (type as TrackTypeId) : "classic";
      return [{ name: name.slice(0, 14), type: id, world: typeof world === "string" ? world : undefined, mine: true,
                points: Float64Array.from(p as number[], (v) => v / 10) }];
    }).slice(0, MY_MAPS) : [];
    return { build: cleanBuild(raw.build), engine: raw.engine === 1 ? 1 : 0, maps, dreams: Number(raw.dreams) || maps.length };
  } catch {
    return { build: DEFAULT_BUILD, engine: 0, maps: [], dreams: 0 }; // private window or blocked storage: defaults
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
  private readonly orbArt: SceneryArt = orbArt();
  private readonly boomArt: SceneryArt[] = boomerangFrames();
  private readonly bombArt: SceneryArt[] = bombFrames();
  private readonly blastArt: SceneryArt[] = blastFrames();
  private readonly bigBlastArt: SceneryArt[] = blastFrames(4.6);
  private readonly droneArt: SceneryArt[] = droneFrames();
  private readonly puckArt: SceneryArt[] = puckFrames();
  private readonly flareArt: SceneryArt[] = flareFrames();
  private readonly cometArt: SceneryArt = cometArt();
  private readonly trailArt: SceneryArt = trailArt();
  private readonly coinArt: SceneryArt[] = coinFrames();
  private readonly grabArt: SceneryArt[] = grabberFrames();
  private readonly obstacleArt: ObstacleArt = obstacleArt();
  private sirenAt = 0; // when the police siren next wails (while a car is after the player)
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
  private myMaps: GameMap[] = []; // the circuits the player dreamed, newest first (kept on this device)
  private dreams = 0; // how many the player has dreamed (each map is named for its number)
  private surprised = false; // the race's track type was a SURPRISE ME pick (the dream says so)
  private seed = (Math.random() * 1e9) | 0;
  private shake = 0;
  private flash = 0; // s of white flash left (a shock)
  private time = 0;
  private settings = { rivals: 5, diff: 2, theme: 0, circuit: 0, track: 0, engine: 0 };
  private build: Build = DEFAULT_BUILD;
  private garage!: Garage;
  private garageReturn: Mode = "main";
  private howtoPage = 0;
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
    this.myMaps = saved.maps;
    this.dreams = saved.dreams;
    this.sound.engineLevel = ENGINE_LEVELS[saved.engine].level;
  }

  private save(): void {
    try {
      const maps = this.myMaps.map((m) => ({ name: m.name, type: m.type, world: m.world, p: Array.from(m.points, (v) => Math.round(v * 10)) }));
      localStorage.setItem(SAVE, JSON.stringify({ build: this.build, engine: this.settings.engine, maps, dreams: this.dreams }));
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
        { label: "HOW TO PLAY", action: () => { this.howtoPage = 0; this.go("howto"); } },
        { label: "SOUND", value: () => (this.sound.muted ? "OFF" : "ON"), action: () => this.sound.toggleMute(), hint: "M TOGGLES SOUND ANYTIME" },
        { label: "ENGINE", value: () => ENGINE_LEVELS[s.engine].label, hint: "THE ENGINE HUM UNDER THE MUSIC",
          left: () => this.setEngine(), right: () => this.setEngine() },
      ]),
      setup: new Menu("QUICK RACE", [
        { label: "RIVALS", value: () => String(s.rivals), left: () => { s.rivals = Math.max(0, s.rivals - 1); }, right: () => { s.rivals = Math.min(7, s.rivals + 1); }, hint: "HOW MANY AI KARTS RACE YOU (0-7)" },
        { label: "DIFFICULTY", value: () => CLASSES[DIFFS[s.diff]].label, left: () => { s.diff = (s.diff + DIFFS.length - 1) % DIFFS.length; }, right: () => { s.diff = (s.diff + 1) % DIFFS.length; }, hint: "SPEED CLASS, HOW SHARP THE RIVALS DRIVE AND HOW GOOD THEIR KARTS ARE" },
        { label: "WORLD", value: () => (s.theme === THEMES.length ? "RANDOM" : THEMES[s.theme].name), left: () => { s.theme = (s.theme + THEMES.length) % (THEMES.length + 1); }, right: () => { s.theme = (s.theme + 1) % (THEMES.length + 1); }, hint: () => (s.theme === THEMES.length ? "A WORLD PICKED AT RANDOM" : THEMES[s.theme].blurb) },
        { label: "TRACK", value: () => { const m = this.pickedMap(); return m ? trackType(m.type).name : TRACKS[s.track].name; },
          left: () => { s.track = (s.track + TRACKS.length - 1) % TRACKS.length; }, right: () => { s.track = (s.track + 1) % TRACKS.length; },
          hint: () => (this.pickedMap() ? "THE MAP SETS IT. PICK NEW DREAM TO CHOOSE ONE" : trackHint(s.track)),
          fixed: () => !!this.pickedMap() },
        { label: "MAP", value: () => this.pickedMap()?.name ?? "NEW DREAM",
          left: () => { s.circuit = (s.circuit + this.maps().length) % (this.maps().length + 1); },
          right: () => { s.circuit = (s.circuit + 1) % (this.maps().length + 1); },
          hint: () => { const m = this.pickedMap(); return !m ? "A FRESH CIRCUIT, DREAMED AS YOU RACE IT"
            : m.mine ? `YOUR ${trackType(m.type).name} FROM ${m.world ?? "A DREAM"}, RACED AGAIN` : `DREAMED BY THE DESIGNER: ${trackType(m.type).name}`; },
          preview: () => this.pickedMap()?.points ?? null },
        { label: "KART", value: () => bodyOf(this.build).name, action: () => this.openGarage("setup"), hint: "OPEN THE GARAGE" },
        { label: "START RACE", action: () => void this.startRace(this.pickedMap()) },
        { label: "BACK", action: () => this.go("main") },
      ], 300),
      cupSetup: new Menu("GRAND PRIX", [
        { label: "RIVALS", value: () => String(s.rivals), left: () => { s.rivals = Math.max(1, s.rivals - 1); }, right: () => { s.rivals = Math.min(7, s.rivals + 1); }, hint: "THE SAME RIVALS IN THE SAME KARTS ALL THE WAY (1-7)" },
        { label: "DIFFICULTY", value: () => CLASSES[DIFFS[s.diff]].label, left: () => { s.diff = (s.diff + DIFFS.length - 1) % DIFFS.length; }, right: () => { s.diff = (s.diff + 1) % DIFFS.length; }, hint: "SPEED CLASS, HOW SHARP THE RIVALS DRIVE AND HOW GOOD THEIR KARTS ARE" },
        { label: "TRACK", value: () => TRACKS[s.track].name, left: () => { s.track = (s.track + TRACKS.length - 1) % TRACKS.length; }, right: () => { s.track = (s.track + 1) % TRACKS.length; }, hint: () => trackHint(s.track) },
        { label: "KART", value: () => bodyOf(this.build).name, action: () => this.openGarage("cupSetup"), hint: "OPEN THE GARAGE" },
        { label: "START GRAND PRIX", action: () => void this.startCup(), hint: `${THEMES.length} WORLDS. POINTS: 15 12 10 8 6 4 2 1` },
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
        { label: "NEW DREAM CIRCUIT", action: () => void this.startRace() },
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
      if (this.race) mu.play(this.race.setup.theme.id); // (until the race is set out, what was playing goes on)
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
    const replay = r.track.locked ? r.layout() : r.setup.replay;
    void this.startRace(undefined, { ...r.setup, replay, build: this.build });
  }

  /** A circuit the player dreamed has locked: keep it as a map (the newest first, MY_MAPS of them). */
  private keepMap(race: Race): void {
    this.dreams += 1;
    const points = race.layout();
    this.myMaps = [{ name: `MY DREAM ${this.dreams}`, type: race.type.id, world: race.setup.theme.name, mine: true, points },
                   ...this.myMaps].slice(0, MY_MAPS);
    this.settings.circuit = 0;
    this.save();
  }

  /** Every map Quick Race can race: the player's own, newest first, then the showcase. */
  private maps(): GameMap[] {
    return [...this.myMaps, ...SHOWCASE];
  }

  /** The map picked on the setup screen, or undefined for a fresh dream. */
  private pickedMap(): GameMap | undefined {
    const s = this.settings;
    if (s.circuit > this.maps().length) s.circuit = 0;
    return s.circuit ? this.maps()[s.circuit - 1] : undefined;
  }

  /** ``map``: race that map (no dreaming); none, a fresh dream. ``again``: this setup again. */
  private async startRace(map?: GameMap, again?: RaceSetup): Promise<void> {
    this.raceError = "";
    const live = again ? !again.replay : !map;
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
    const seed = (Math.random() * 1e9) | 0;
    const choice = TRACKS[s.track].id, replay = map ? Float64Array.from(map.points) : null;
    // a live race with the same seed dreams the same circuit again; a re-raced one keeps its type
    const setup: RaceSetup = again ?? {
      rivals: s.rivals, difficulty: DIFFS[s.diff], theme, seed, replay, build: this.build,
      trackType: map ? map.type : choice === "surprise" ? surpriseType(new Rand(seed + 5)) : choice,
    };
    if (!again) this.surprised = !replay && choice === "surprise";
    this.seed = setup.seed;
    // the dreaming screen first: setting out a race (painting its ground) takes a moment, more on
    // the moon's bigger ground, and the menu must not sit frozen meanwhile
    this.race = null;
    this.hud.banners = [];
    this.flash = 0;
    this.sound.setEngine(0, false, false);
    this.go("dreaming");
    this.sound.ensure();
    await new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    if (this.mode !== "dreaming" || this.race) return; // backed out, or another race started
    const race = new Race(setup, this.designer, (sp) => this.banner(sp));
    this.race = race;
    this.sky = new Sky(setup.theme, this.cam.horizon, this.seed + 3);
    this.music(); // the world's own song
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
    const seed = (cup.seed + 7919 * (cup.index + 1)) | 0, choice = TRACKS[s.track].id;
    // SURPRISE ME: a different track type for every race of the cup (while there are new ones)
    const type = choice === "surprise" ? surpriseType(new Rand(seed + 5), cup.types) : choice;
    cup.types[cup.index] = type;
    this.surprised = choice === "surprise";
    await this.startRace(undefined, {
      rivals: Math.max(1, s.rivals), difficulty: DIFFS[s.diff], theme: cup.world, seed, replay: null,
      trackType: type, build: this.build, rivalSeed: cup.seed,
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
    this.tubeChase.delete(cam);
    if (race.setup.theme.tube) this.chaseTube(cam, race, 0);
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
    // ride up onto bridges and climbs with the kart, ahead of it on a slope by as much as following
    // lags (lagging, the kart sank to the foot of the screen coming down a climb); on a jump, rise
    // only partway for a sense of air (no more than at the top of a jump at home: the moon's flights
    // go twice as high, out of the picture); and never more than 0.3 m over the kart (landing a
    // jump, it dropped out of the bottom of the picture)
    const rate = p.air ? 5 : 9, [tx, ty] = race.track.tangent(p.idx);
    const lead = p.air ? 0 : (p.v * (Math.cos(p.heading) * tx + Math.sin(p.heading) * ty) * p.slope) / rate;
    const lift = p.elev + lead - Math.min((p.elev - p.ground) * 0.45, 1.8);
    cam.lift += (lift - cam.lift) * (1 - Math.exp(-dt * rate));
    cam.lift = Math.min(cam.lift, p.elev + 0.3);
    cam.height = BASE_HEIGHT + cam.lift;
    // speed: a wider view and speed lines while boosting (and much more as a rocket)
    const fx = p.rocket > 0 ? 1.6 : p.boostTime > 0 || p.prism > 0 ? 1 : 0;
    cam.fx += (fx - cam.fx) * (1 - Math.exp(-dt * 6));
    cam.focal = BASE_FOCAL * viewScale() * (1 - 0.12 * cam.fx);
    if (race.setup.theme.tube) this.chaseTube(cam, race, dt);
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
        if (race.live && !this.cup) this.keepMap(race);
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
      else if (e.kind === "boom") {
        this.sound.explode(e.near, e.big);
        if (e.near) this.shake = Math.max(this.shake, e.big ? 0.6 : 0.4);
      }
      else if (e.kind === "shock") { this.sound.shock(); this.flash = 0.22; }
      else if (e.kind === "rocketOver") this.hud.popup("ROCKET SPENT", now, DIM);
      else if (e.kind === "jump") this.sound.jump();
      else if (e.kind === "land") {
        this.sound.land();
        this.shake = Math.max(this.shake, 0.18);
        if (e.trick === 2) { this.sound.trick(true); this.hud.popup("PERFECT TRICK!", now, HOT); }
        else if (e.trick === 1) { this.sound.trick(false); this.hud.popup("TRICK!", now, hex("#63c8ff")); }
      } else if (e.kind === "pad") this.sound.boost();
      else if (e.kind === "wings") {
        this.sound.wings();
        if (e.first) this.hud.banner("WINGS!", now, SKY, 1.8, "RIDE THE WALLS, LOOP THE ROOF");
        else this.hud.popup("WINGS!", now, SKY);
      } else if (e.kind === "wingsOff") { this.sound.wingsOff(); this.hud.popup("WINGS GONE", now, DIM); }
      else if (e.kind === "needWings") {
        if (e.first) this.hud.banner("NO WINGS", now, SKY, 2.2, "THE BLUE PADS GIVE YOU WINGS");
        else this.hud.popup("NEED WINGS!", now, SKY);
      }
      else if (e.kind === "rocket") { this.sound.rocket(); this.hud.popup("ROCKET START!", now, HOT); }
      else if (e.kind === "burnout") { this.sound.burnout(); this.hud.popup("TOO EARLY!", now, hex("#ff6b6b")); }
      else if (e.kind === "bridge") this.hud.popup("BRIDGE AHEAD!", now, DREAM);
      else if (e.kind === "lava") { this.sound.lava(); this.shake = Math.max(this.shake, 0.3); }
      else if (e.kind === "fell") {
        if (e.into === "pond" || e.into === "trench" || e.into === "quicksand" || e.into === "canal") this.sound.splash();
        else this.sound.fall();
        this.shake = Math.max(this.shake, 0.25);
      }
      else if (e.kind === "aimLocked") this.sound.lock();
      else if (e.kind === "coin") this.sound.coin();
      else if (e.kind === "static") { this.sound.staticHit(); this.hud.popup("STATIC!", now, hex("#c9c3ec")); }
      else if (e.kind === "comet") {
        this.sound.comet(e.you);
        if (e.you) this.hud.banner("COMET!", now, hex("#7cc4ff"), 1.8, "IT IS COMING FOR THE LEADER", true);
      }
      else if (e.kind === "stolen") { this.sound.steal(); this.hud.popup("ITEM STOLEN!", now, hex("#c79bff")); }
      else if (e.kind === "steal") { this.sound.steal(); this.hud.popup("STOLEN!", now, hex("#c79bff")); }
      else if (e.kind === "clash" && e.near) this.sound.clash();
      else if (e.kind === "horn") this.sound.horn(e.near);
      else if (e.kind === "bite") this.sound.bite();
      else if (e.kind === "bounce" && e.near) this.sound.bounce();
      else if (e.kind === "rescued") { this.snapCamera(this.cam, race); this.sound.rescue(); }
      else if (e.kind === "obstacle") this.obstacleEvent(e.sound, e.near, now);
    }
  }

  /** Something in the way did something: its sound, and a word on the screen when it was the
   * player it got. */
  private obstacleEvent(sound: ObstacleSound, near: boolean, now: number): void {
    const said = (text: string, color: number) => { if (near) this.hud.popup(text, now, color); };
    switch (sound) {
      case "moo": this.sound.moo(); said("MOO!", hex("#f2efe8")); break;
      case "puff": this.sound.puff(); break;
      case "zap": this.sound.zap(); said("STUNG!", hex("#ff8fd0")); break;
      case "siren":
        this.sound.siren();
        this.sirenAt = this.time + 0.9;
        this.hud.banner("POLICE!", now, hex("#ff2a2a"), 1.6, "THEY ARE AFTER YOU: SHAKE THEM OFF", true);
        break;
      case "ram": this.sound.ram(); this.shake = Math.max(this.shake, 0.3); said("RAMMED!", hex("#ff6b6b")); break;
      case "geyser": this.sound.geyser(); if (near) this.shake = Math.max(this.shake, 0.25); break;
      case "clang": this.sound.clang(); this.shake = Math.max(this.shake, 0.4); said("WRECKED!", hex("#ffd23f")); break;
      case "impact": this.sound.explode(near); if (near) this.shake = Math.max(this.shake, 0.35); break;
      case "honk": this.sound.honk(); break;
      case "spun": this.sound.hit(); said("GOT 'EM!", hex("#7dff9a")); break;
      case "shaken": this.sound.lock(); said("SHAKEN OFF!", hex("#7dff9a")); break;
    }
  }

  private useSound(item: ItemKind, now: number): void {
    switch (item) {
      case "turbo": case "triple": case "gold": this.sound.boost(); break;
      case "oil": case "oil3": this.sound.oil(); break;
      case "orb": case "orb3": this.sound.orb(); break;
      case "puck": case "puck3": this.sound.puck(); break;
      case "boomerang": this.sound.boomerang(); break;
      case "bomb": this.sound.bombThrow(); break;
      case "prism": this.sound.prism(); this.hud.popup("PRISM!", now, DREAM); break;
      case "shock": case "horn": case "static": case "comet": break; // their own events play them, for everyone's
      case "rocket": this.sound.rocketGo(); this.hud.popup("ROCKET!", now, hex("#ff8a1f")); break;
      case "flares": this.sound.flare(); break;
      case "grabber": this.sound.bite(); this.hud.popup("GRABBER!", now, hex("#ffcf3a")); break;
      case "jackpot": this.sound.itemGet(); break;
      case "coin": break; // (the coin event)
      case "phantom": this.sound.phantom(); this.hud.popup("PHANTOM!", now, hex("#c9b8ff")); break;
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
      else if (this.mode === "howto") { // a tap turns the page; past the last, back to the menu
        if (++this.howtoPage >= HOWTO_PAGES.length) this.go("main");
      }
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
      if (e === "left" || e === "right") {
        const n = HOWTO_PAGES.length;
        this.howtoPage = (this.howtoPage + (e === "left" ? n - 1 : 1)) % n;
        this.sound.move();
      } else this.go("main");
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
      const c = a.driver.act(dt, a.race.track, a.race.cls, a.race.player, a.race.karts, a.race.items, [], a.race.features.pads);
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
      // the police siren wails on while a car is after the player
      if (r.obstacles.chasing && this.time > this.sirenAt) {
        this.sound.siren();
        this.sirenAt = this.time + 0.9;
      }
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

  /** Each chase camera's ride in the tunnel's tube (the game's own, the attract race's). */
  private readonly tubeChase = new WeakMap<Camera, TubeRide>();

  /** Where the player's kart is along the road in the tube: the road point before it and how far on. */
  private kartSpot(race: Race): [number, number] {
    const q = kartPlace(race.track, race.player);
    return [q.i, q.w];
  }

  /** The chase camera's ride in the tube, as it follows the kart. It looks down the tube the way the
   * kart is going (and turns round when the kart does: left looking the other way, a kart turned
   * round drove off where the camera could not see), and turns only a little from there toward where
   * the kart heads, so that from straight behind the kart it always shows the way on (turned well
   * round toward a kart crossing the tube, it swung round the curve of the wall, close in, and lost
   * the kart off the foot of the screen); and it rises with the kart up a jump's ramp and partway
   * into the air. (Where it is round the tube is the kart's own place, exactly: following behind,
   * even closely, it lagged a meter and more round the tube when the kart crossed it fast, and drew
   * the kart off to one side, tipped over.) */
  private chaseTube(cam: Camera, race: Race, dt: number): void {
    const p = race.player, [tx, ty] = race.track.tangent(p.idx);
    const rel = wrapAngle(p.heading + p.slip * 0.45 - Math.atan2(ty, tx));
    // (rising with the kart up a jump's ramp, and partway into the air; easing to it, so the
    // camera does not drop at the lip, where the ramp under the kart gives way to air)
    const ground = elevBetween(race.track, ...this.kartSpot(race)), ramp = Math.max(0, p.ground - ground);
    const air = Math.max(0, p.elev - p.ground), lift = ramp + air - Math.min(air * 0.45, 1.8);
    let st = this.tubeChase.get(cam);
    if (!st) {
      st = { dir: Math.cos(rel) >= 0 ? 1 : -1, yaw: 0, lift, swing: 0, from: 0, swung: SWING };
      this.tubeChase.set(cam, st);
    }
    // which way down the tube: turned round past 115 degrees from it, the other way, swinging round
    // behind the kart the way it turned (at a cut, the whole tube turned about in a frame)
    const off = st.dir > 0 ? rel : wrapAngle(rel - Math.PI);
    if (Math.abs(off) > (115 * Math.PI) / 180) {
      const was = (st.dir > 0 ? 0 : Math.PI) + st.yaw + st.swing; // (where it looks, off the way along)
      st.dir = -st.dir;
      st.yaw = 0;
      const kart = st.dir > 0 ? rel : wrapAngle(rel - Math.PI);
      let from = wrapAngle(was - (st.dir > 0 ? 0 : Math.PI));
      if (Math.abs(kart) > 0.05 && Math.sign(from) !== Math.sign(kart)) from -= Math.sign(from) * 2 * Math.PI;
      st.from = from;
      st.swung = 0;
    }
    st.swung = Math.min(SWING, st.swung + dt);
    const e = st.swung / SWING;
    st.swing = st.from * (1 - e * e * (3 - 2 * e));
    const want = Math.max(-0.15, Math.min(0.15, (st.dir > 0 ? rel : wrapAngle(rel - Math.PI)) * 0.25));
    st.yaw += (want - st.yaw) * (1 - Math.exp(-dt * 6.5));
    st.lift += (lift - st.lift) * (1 - Math.exp(-dt * (p.air ? 5 : 9)));
    st.lift = Math.min(st.lift, ramp + air + 0.3);
  }

  /** Inside the tunnel's tube: where the camera really is and which way it looks; the road point
   * it is at; where a point of the race's flat terms seen by it is, in those terms (to pick which
   * side of each kart is seen); and where anything given in flat terms really is round the tube (or
   * null, where the tube is left out at a crossing). The chase camera (``chase``, its ride) rides
   * behind the kart along the tube at the kart's place round it, turned with the kart's surface: so
   * the kart stays upright at the foot of the screen and the tube turns about it as it climbs a
   * wall or loops over the ceiling (put where its flat terms said, behind the kart as the flat terms
   * measure it, the camera lagged far round the tube, looked at walls and saw the kart turned every
   * which way). The rear-view mirror (``mirror``) rides just ahead of the kart looking back, and any
   * other camera (a film's) goes where its flat terms say. */
  private tubeCamera(race: Race, flat: Camera, chase?: TubeRide, mirror = false): {
    cam: Camera; idx: number; back: boolean; behind: number; view: (k: Kart) => number;
    at: (x: number, y: number, h: number, hint?: number) => { X: number; Y: number; Z: number; n: [number, number, number] } | null;
  } {
    const t = race.track, p = race.player;
    let hides: (s: number) => boolean = () => false;
    const at = (x: number, y: number, h: number, hint?: number) => {
      // (a kart by its own place round the tube: found again from its place in flat terms, it
      // could come out meters off, round the inside of a tight bend high up, where they fold over)
      const k = race.karts.find((o) => o.x === x && o.y === y);
      const q = k ? kartPlace(t, k) : tubePlace(t, x, y, hint ?? p.idx);
      if (hides(q.s)) return null;
      const r = tubeBetween(t, q.i, q.w, q.u, h - elevBetween(t, q.i, q.w));
      return { X: r.p[0], Y: r.p[1], Z: r.p[2], n: r.n };
    };
    const look = (fr: { along: P3; round: P3; up: P3 }, ahead: number, round: number): { f: P3; r: P3; u: P3 } => {
      const up = fr.up, g: P3 = [fr.along[0] * ahead + fr.round[0] * round, fr.along[1] * ahead + fr.round[1] * round,
                                 fr.along[2] * ahead + fr.round[2] * round];
      const d = g[0] * up[0] + g[1] * up[1] + g[2] * up[2], f0: P3 = [g[0] - d * up[0], g[1] - d * up[1], g[2] - d * up[2]];
      const l = Math.hypot(f0[0], f0[1], f0[2]) || 1, f: P3 = [f0[0] / l, f0[1] / l, f0[2] / l];
      return { f, r: [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]], u: up };
    };
    if (chase) {
      // fixed to the kart's own frame round the tube (as far behind and as high as at home), so the
      // kart keeps its place on the screen however the tube turns, climbs or dips under it (set on
      // the tube's surface behind the kart, the camera tipped with the road where it was, not where
      // the kart was, and over a crest lost the kart off the foot of the screen); and where the kart
      // really is round the tube (its offset is a step behind when it is shoved). The mirror looks
      // back from just ahead of the kart, the other way from the camera.
      const k = kartPlace(t, p), uK = k.u;
      const way = mirror ? -chase.dir : chase.dir, yaw = mirror ? 0 : chase.yaw + chase.swing;
      const ahead = way * Math.cos(yaw), round = way * Math.sin(yaw);
      // (swinging round, closer in and lower, so the kart keeps its place on the screen: 6.2 m to
      // the side of a kart up a wall, the camera would be out through it)
      const near = mirror ? 1 : 1 - 0.6 * Math.sin(chase.swing) ** 2;
      const back = mirror ? 2.5 : (Math.hypot(flat.x - p.x, flat.y - p.y) || 6.2) * near;
      const h = ((mirror ? 3.4 : BASE_HEIGHT) + chase.lift) * near; // (as high off the tube as over the road at home)
      const basis = look(tubeFrame(t, k.i, k.w, uK), ahead, round);
      const at0 = tubeBetween(t, k.i, k.w, uK, 0).p, f = basis.f, up = basis.u;
      const pos: P3 = [at0[0] - f[0] * back + up[0] * h, at0[1] - f[1] * back + up[1] * h, at0[2] - f[2] * back + up[2] * h];
      // the road point it is at, and where it is round the tube (to pick each kart's side seen)
      const c = t.stepAlong(k.i, k.w * t.between(k.i, t.wrap(k.i + 1)) - back * ahead);
      const sC = t.s[c.i] + c.w * t.between(c.i, t.wrap(c.i + 1)), uC = uK - back * round;
      hides = tubeHides(t, t.s[c.i]);
      return { cam: { ...flat, x: pos[0], y: pos[1], height: pos[2], basis }, idx: c.i, back: ahead < 0,
               behind: Math.abs(ahead) < 0.75 ? 80 : 20, view: (o: Kart) => tubeView(t, sC, uC, o), at }; // (side on, the tube both ways)
    }
    const q = tubePlace(t, flat.x, flat.y, p.idx);
    const pos = tubeBetween(t, q.i, q.w, q.u, flat.height - elevBetween(t, q.i, q.w)).p;
    const [tx, ty] = t.tangent(q.i), psi = wrapAngle(flat.heading - Math.atan2(ty, tx));
    const basis = look(tubeFrame(t, q.i, q.w, q.u), Math.cos(psi), Math.sin(psi));
    hides = tubeHides(t, t.s[q.i]);
    return { cam: { ...flat, x: pos[0], y: pos[1], height: pos[2], basis }, idx: q.i, back: Math.abs(psi) > Math.PI / 2,
             behind: Math.abs(Math.cos(psi)) < 0.75 ? 80 : 20, view: (o: Kart) => tubeView(t, q.s, q.u, o), at };
  }

  /** Draw the world from ``cam`` into ``scr`` (the screen, or with ``mirror`` a rear-view mirror:
   * the ratio of the screen's focal length to the mirror's and the screen's width, for the sky). */
  private drawWorld(race: Race, sky: Sky, flat: Camera, scr: Screen = this.scr,
                    mirror?: { ratio: number; fullW: number }): void {
    const t = race.track;
    // inside the tunnel's tube there is no sky and no ground, only the tube: the camera (given
    // in the race's flat terms) is put where it really is round the tube, turned to match
    const inTube = race.setup.theme.tube
      ? this.tubeCamera(race, flat, this.tubeChase.get(mirror ? this.cam : flat), !!mirror) : null;
    const cam = inTube?.cam ?? flat;
    if (inTube) scr.clear(race.setup.theme.fog);
    // (a camera with a horizon of its own, as the film's are, gets the sky down to it: drawn only to
    // the sky's own horizon, the rows between were left as the frame before had them)
    else if (mirror) sky.draw(scr, cam.heading, { horizon: cam.horizon, ratio: mirror.ratio, fullW: mirror.fullW });
    else sky.draw(scr, cam.heading, cam.horizon !== sky.horizon ? { horizon: cam.horizon, ratio: 1, fullW: W } : undefined);
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
    const now = this.time;
    const it = race.items;
    // oil lies flat on the road: painted into the ground where the road is the ground, and laid on
    // the road as faces where it is not (a deck, a climb, a jump ramp, round the tube)
    const laid = it.slicks.filter((sl) => inTube || slickRaised(t, race.features, sl));
    if (!inTube) {
      drawGround(scr, cam, race.tex, theme.fog, {
        mist, light: theme.underwater ? { color: CAUSTIC, at: caustics(now) } : undefined, lava: lavaShift(now),
        paint: slickPaint(it.slicks.filter((sl) => !laid.includes(sl)), now, cam.heading),
      });
    }
    const extras: WorldSprite[] = [];
    it.boxes.forEach((b, i) => {
      if (b.respawn > 0) return;
      const art = this.boxArt[(Math.floor(now * 10) + i * 3) % this.boxArt.length];
      extras.push({ x: b.x, y: b.y, art, lift: 0.3 + 0.12 * Math.sin(now * 3 + i), base: b.elev, idx: b.idx });
    });
    for (const o of it.orbs) {
      extras.push({ x: o.x, y: o.y, art: this.orbArt, lift: 0.45 + 0.1 * Math.sin(now * 9), base: t.elev[o.idx] ?? 0, idx: o.idx });
    }
    for (const b of it.boomerangs) {
      extras.push({ x: b.x, y: b.y, art: this.boomArt[Math.floor(now * 24) % this.boomArt.length], lift: 0.4, base: b.z - 0.9, idx: b.idx });
    }
    for (const b of it.bombs) {
      const ground = t.elev[b.idx] ?? 0;
      extras.push({ x: b.x, y: b.y, art: this.bombArt[Math.floor(now * 8) % 2], lift: Math.max(0, b.z - ground), base: ground, idx: b.idx });
    }
    for (const b of it.blasts) {
      const set = b.size > 1.05 ? this.bigBlastArt : this.blastArt;
      const f = Math.min(set.length - 1, Math.floor((b.age / BLAST_TIME) * set.length));
      extras.push({ x: b.x, y: b.y, art: set[f], base: b.z });
    }
    for (const p of it.pucks) {
      const ground = t.elev[p.idx] ?? 0;
      const art = p.kind === "puck" ? this.puckArt[Math.floor(now * 14 + p.t * 9) % this.puckArt.length]
        : p.kind === "orb" ? this.orbArt : this.flareArt[Math.floor(now * 12) % this.flareArt.length];
      extras.push({ x: p.x, y: p.y, art, base: ground, lift: p.kind === "flare" ? Math.max(0.05, p.z - ground) : p.kind === "orb" ? 0.45 : 0.02, idx: p.idx });
    }
    for (const c of it.comets) {
      const ground = t.elev[c.idx] ?? 0;
      extras.push({ x: c.x, y: c.y, art: this.cometArt, base: ground, lift: c.z - ground, idx: c.idx });
      if (c.phase === "fly") { // its tail, streaming back down the road
        for (let j = 1; j <= 6; j++) {
          const i = t.wrap(c.idx - j * 5);
          extras.push({ x: t.xs[i], y: t.ys[i], art: this.trailArt, base: t.elev[i] ?? 0, lift: c.z - ground + 0.3 * Math.sin(now * 20 + j), idx: i });
        }
      }
    }
    it.coins.forEach((c, i) => {
      if (c.respawn > 0) return;
      const art = this.coinArt[(Math.floor(now * 10) + i) % this.coinArt.length];
      extras.push({ x: c.x, y: c.y, art, lift: 0.3 + 0.08 * Math.sin(now * 4 + i), base: c.elev, idx: c.idx });
    });
    for (const r of it.rings) {
      const u = r.age / RING_TIME, k = r.kart;
      extras.push({ x: k.x, y: k.y, art: this.trailArt, base: k.ground, draw: (sx, gy, ppm) => hornRing(scr, sx, gy, ppm, u), idx: k.idx });
    }
    if (theme.underwater) extras.push(...fishSprites(this.schools(race), now, cam.heading));
    const faces: Face[] = [];
    const painter = { cam, scr, fog: race.setup.theme.fog, faces };
    if (inTube) {
      tubeFaces(painter, t, theme, inTube.idx, race.features, now, inTube.back, inTube.behind);
      rampFaces(painter, t, race.features, race.setup.theme);
    } else {
      landformFaces(painter, race.scenery.landforms, theme);
      bankFaces(painter, t, race.features.banks, theme);
      bridgeFaces(painter, t, race.setup.theme);
      hillFaces(painter, t, theme, race.features.pads, now);
      tunnelFaces(painter, t, race.features, theme);
      rampFaces(painter, t, race.features, race.setup.theme);
      padFaces(painter, t, race.features, now);
      obstacleFaces(painter, race.obstacles, t, now);
    }
    for (const sl of laid) slickDecal(painter, t, race.features, sl, now, cam.heading, !!inTube);
    // the player's aiming arrows while an aimed item is ready: sweeping in front (on the screen)
    // and, mirrored, behind (in the mirror); a press locks one and it turns blue. Something the
    // back button throws straight back gets a straight arrow in the mirror.
    extras.push(...obstacleSprites(race.obstacles, t, cam, now, this.obstacleArt));
    const me = race.player;
    // (in the tube, on the floor only: an arrow is drawn on flat road)
    if (me.item && me.roulette <= 0 && me.rocket <= 0 && !me.falling && race === this.race &&
        (!inTube || Math.abs(me.offset) < HALF_WIDTH)) {
      if (AIMED.has(me.item)) {
        const locked = me.aimLocked;
        const reach = mirror ? 1.6 : 1;
        if (locked === null) aimArrow(painter, me, mirror ? Math.PI - me.aim : me.aim, mirror ? BACK_AIM : HOT, reach);
        else if (Math.cos(locked) < 0 === !!mirror) aimArrow(painter, me, locked, hex("#63c8ff"), reach);
      } else if (mirror && THROWN_BACK.has(me.item)) {
        aimArrow(painter, me, Math.PI, BACK_AIM, 1.6);
      }
    }
    drawWorldSprites(scr, cam, race.scenery.items, race.karts, {
      sprites: (k: Kart) => kartSprites(k.build, LIVERIES[k.livery], k.rocket > 0, k.wings > 0),
      sparks: (k: Kart) => (k.drifting ? Math.max(1, k.boostLevel) : 0),
      held: (k: Kart) => (k.item && k.roulette <= 0 ? this.held[k.item] : null),
      art: (item: ItemKind) => this.held[item],
      grabber: this.grabArt,
      dome: !!(theme.underwater || theme.helmets),
      drone: this.droneArt,
      underDeck: inTube ? undefined
        : (x: number, y: number) => t.bridges.some((b) => (x - t.xs[b.lower]) ** 2 + (y - t.ys[b.lower]) ** 2 < 24 * 24),
      hide: mirror ? race.player : undefined,
      tube: inTube?.at,
      viewOf: inTube?.view,
    }, theme.fog, extras, faces);
    if (mirror) return; // (the screen's own overlays are not seen in the mirror)
    if (theme.underwater) waterOverlay(this.scr, now);
    if (theme.volcano) emberOverlay(this.scr, now);
    // static over the player's screen: it comes in fast and clears over the last second
    if (me.staticT > 0 && race === this.race) {
      staticOverlay(this.scr, now, Math.min(1, (STATIC_TIME - me.staticT) / 0.3, me.staticT / 1));
    }
    // into the lava (dark red), water (dark blue), a hole (black)...: the view goes dark while the
    // drone lifts the kart out
    const f = me.fall;
    if (f >= 0 && f < FALL_SWAP + 0.3 && race === this.race) {
      const a = Math.max(0, 1 - Math.abs(f - FALL_SWAP) / 0.26);
      if (a > 0) this.scr.dimRect(0, 0, W, H, FALL_TINT[me.fallKind], 0.92 * a);
    }
    // inside a tunnel the light drops
    if (race.features.tunnels.length) {
      const ci = t.nearest(cam.x, cam.y, race.player.idx);
      if (race.features.tunnelAt(t.s[ci]) && Math.abs(t.offset(cam.x, cam.y, ci)) < 7) {
        // (a building's frame is open to the light; under a building in Tokyo, the sodium lamps glow orange)
        if (theme.tunnels === "frame") this.scr.dimRect(0, 0, W, H, hex("#0b0b14"), 0.14);
        else this.scr.dimRect(0, 0, W, H, hex("#2a1404"), 0.3);
      }
    }
  }

  private mirror: { w: number; h: number; buf: Uint32Array } | null = null;

  /** A rear-view mirror at the top of the screen while the player holds something the back button
   * throws behind: the road behind the kart (the chase camera cannot see it), whoever is on its
   * tail, and the arrow sweeping across it. Flipped as a mirror is: the kart's left on the left. */
  private drawMirror(race: Race, sky: Sky): void {
    const p = race.player;
    if (!p.item || !THROWN_BACK.has(p.item) || p.roulette > 0 || p.rocket > 0 || p.falling || p.finished) return;
    const w = Math.round((W * 0.36) / 2) * 2, h = Math.round(w * 0.3);
    if (!this.mirror || this.mirror.w !== w || this.mirror.h !== h) this.mirror = { w, h, buf: new Uint32Array(w * h) };
    // from up and a little ahead of the kart (which it does not draw), so the road just behind it,
    // where the arrow sweeps, is in the picture
    const m = this.mirror, hd = p.heading, focal = h * 1.2;
    const cam: Camera = { x: p.x + Math.cos(hd) * 2.5, y: p.y + Math.sin(hd) * 2.5, heading: hd + Math.PI,
                          height: p.elev + 3.4, focal, horizon: Math.round(h * 0.3), far: 160, lift: 0, fx: 0 };
    const view = { ratio: this.cam.focal / focal, fullW: W };
    drawSized(w, h, m.buf, (scr) => this.drawWorld(race, sky, cam, scr, view));
    const x0 = Math.round((W - w) / 2), y0 = 4, scr = this.scr;
    scr.fillRect(x0 - 2, y0 - 2, w + 4, h + 4, hex("#0b0b14"));
    scr.fillRect(x0 - 1, y0 - 1, w + 2, 1, hex("#8f87b8"));
    for (let y = 0; y < h; y++) {
      const row = (y0 + y) * W + x0, src = y * w;
      for (let x = 0; x < w; x++) scr.buf[row + x] = m.buf[src + (w - 1 - x)];
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
        const below = 28; // room for a two-line hint, outline and all
        const top = Math.max(logo + 20, Math.min(46, Math.round((H - menu.height() - 24 + logo + 22) / 2), H - menu.height() - below));
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
        drawHowTo(scr, f, this.howtoPage, this.input.touchMode, now);
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
        if (this.mode === "race") this.drawMirror(r, this.sky);
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
  debugStep(n: number, keys: string[], draw = true, dt = 1 / 60): void {
    // (``dt``: each step's length; shorter than a frame, the film tool's slow motion. "hop" hops,
    // for a trick, without the drift; with "auto", "flat" keeps the gas down and the brake off, as
    // the autopilot, holding its own pace, braked a turbo's speed away)
    const held = new Set(keys);
    const c = {
      steer: (held.has("left") ? 1 : 0) - (held.has("right") ? 1 : 0),
      throttle: held.has("gas") ? 1 : 0, brake: held.has("brake") ? 1 : 0, drift: held.has("drift"),
      hop: held.has("drift") || held.has("hop"), item: held.has("item"), back: held.has("back"),
    };
    const original = this.input.drive.bind(this.input);
    const r = this.race;
    if (held.has("auto") && r) {
      if (this.debugPilot?.kart !== r.player) this.debugPilot = new RivalDriver(new Rand(5), r.player, 0);
      this.input.drive = () => {
        const a = this.debugPilot!.act(1 / 60, r.track, r.cls, r.player, r.karts, r.items, [], r.features.pads);
        // ("noitems": the autopilot drives but leaves the items to the script)
        const flat = held.has("flat");
        return { ...a, throttle: flat ? 1 : a.throttle, brake: flat ? 0 : a.brake,
                 hop: !!a.hop || held.has("hop"), item: held.has("item") || (!held.has("noitems") && !!a.item),
                 back: held.has("back") || (!held.has("noitems") && !!a.back) };
      };
    } else {
      this.input.drive = () => c;
    }
    if (this.autoPaused) this.go("race"); // the harness hides the tab; that is not a pause
    this.handleInput(); // queued menu presses (rAF, which normally handles them, may be paused)
    for (let i = 0; i < n; i++) {
      this.update(dt);
      this.time += dt;
    }
    this.input.drive = original;
    if (draw) this.render();
  }

  /** Dev only (the cinema tool): render the current race from a scripted camera, no HUD. */
  debugShot(shot: Partial<Camera>): void {
    const r = this.race;
    if (!r || !this.sky) return;
    const cam = { ...this.cam, ...shot };
    // (a shot from the game's own camera, only raised or zoomed, rides round the tube as it does)
    const ride = this.tubeChase.get(this.cam);
    if (ride && shot.x === undefined && shot.y === undefined && shot.heading === undefined) this.tubeChase.set(cam, ride);
    this.drawWorld(r, this.sky, cam);
    this.speedLines(cam);
    this.scr.present();
  }

  /** Dev only: race a given circuit (game meters, x0 y0 x1 y1 ...) without the designer. */
  debugRace(points: number[], theme = 0, rivals = 5, type: TrackTypeId = "classic"): void {
    this.cup = null;
    this.ceremony = null; // (the film goes from the podium to a race: the winners stood on in it)
    this.surprised = false;
    void this.startRace(undefined, {
      rivals, difficulty: "pro", theme: THEMES[theme], seed: 1234, replay: Float64Array.from(points), layout: "any",
      trackType: type, build: this.build,
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

  private dreamingScreen(): void {
    const scr = this.scr, f = this.font, now = this.time;
    for (let y = 0; y < H; y++) scr.fillRect(0, y, W, 1, mix(hex("#0b0420"), hex("#2a0f4a"), y / H));
    const r = this.race;
    const pv = r?.live?.preview;
    f.draw(scr, "THE AI IS DREAMING YOUR CIRCUIT", W / 2, 22, { color: DREAM, outline: INK, align: "center" });
    let top = 46;
    if (r) {
      const where = this.cup ? `GRAND PRIX RACE ${this.cup.index + 1} OF ${this.cup.worlds.length}: ` : "";
      let title = where + r.setup.theme.name;
      if (this.cup && f.width(title) > W - 16) title = `RACE ${this.cup.index + 1}/${this.cup.worlds.length}: ${r.setup.theme.name}`;
      f.draw(scr, title, W / 2, 34, { color: HOT, outline: INK, align: "center" });
      // the track type, and what it is sure to have
      const t = r.type;
      f.draw(scr, `${this.surprised ? "SURPRISE! " : ""}${t.name}`, W / 2, 46, { color: 0xffffffff, outline: INK, align: "center" });
      const lines = f.wrap(t.id === "classic" ? t.promise : `CONFIRMED: ${t.promise}`, W - 24).slice(0, 2);
      lines.forEach((line, i) => f.draw(scr, line, W / 2, 57 + i * 10, { color: DREAM, outline: INK, align: "center" }));
      top = 57 + lines.length * 10;
    }
    if (pv && r) {
      // the designer's current whole-circuit guess, sharpening with every denoising step
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      const pts = Array.from({ length: N }, (_, j) => [pv[2 * j], pv[2 * j + 1]]);
      for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      const span = Math.max(maxx - minx, maxy - miny) || 1;
      const size = Math.max(40, Math.min(130, H - top - 50)), cx = W / 2, cy = Math.round(top + 4 + size / 2);
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
    let y = 41 + rows.length * 10;
    const st = r.live?.stats;
    if (st) {
      const resampled = st.retries === 1 ? "1 ARC RESAMPLED" : `${st.retries} ARCS RESAMPLED`;
      for (const line of f.wrap(`CIRCUIT DREAMED LIVE IN ${st.arcs} ARCS, ${resampled}`, W - 16)) {
        f.draw(scr, line, W / 2, y, { color: DREAM, align: "center", outline: INK });
        y += 10;
      }
    }
    // the track type, and what was built on the circuit
    const t = r.track, ft = r.features;
    const built = ([[t.bridges.length, "BRIDGE"], [t.hills.length, "CLIMB"], [ft.tunnels.length, "TUNNEL"],
                    [ft.ramps.length, "JUMP"], [ft.pads.length, "PAD"]] as [number, string][])
      .filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n > 1 ? "S" : ""}`).join("  ");
    for (const line of f.wrap(`${r.type.name}: ${built || "A PLAIN CIRCUIT"}`, W - 16).slice(0, 2)) {
      f.draw(scr, line, W / 2, y, { color: DIM, align: "center", outline: INK });
      y += 10;
    }
    this.menus.results.draw(scr, f, W / 2, H - this.menus.results.height() - 2, this.time);
  }
}

const game = new Game();
void game.boot();
if (import.meta.env.DEV) {
  // test hook: drive the simulation deterministically even when the tab is not painting
  (window as unknown as { __dc: unknown }).__dc = {
    step: (n: number, keys: string[] = [], draw = true, dt = 1 / 60) => game.debugStep(n, keys, draw, dt),
    shot: (cam: Partial<Camera>) => game.debugShot(cam),
    game,
    state: () => game.debugState(),
    race: (points: number[], theme = 0, rivals = 5, type: TrackTypeId = "classic") => game.debugRace(points, theme, rivals, type),
    hold: (on = true) => { game.debugHold = on; },
    give: (item: ItemKind) => game.debugGive(item),
    pin: (size: [number, number] | null) => game.debugPin(size),
    go: (mode: Mode) => game.debugGo(mode),
    cup: (ceremony = false, place = 1) => game.debugCup(ceremony, place),
  };
}
