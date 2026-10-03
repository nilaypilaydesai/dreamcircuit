// Game logic: circuits that grow while they are dreamed, bridge their own crossings, lock into
// loops and count laps; jumps, tricks and boost pads; rivals and items, in headless races.

import { describe, expect, it } from "vitest";
import { Rand } from "../src/game/core/gfx";
import { RivalDriver } from "../src/game/race/ai";
import { Features, RAMP_LEN } from "../src/game/race/features";
import { BOMB_BLAST, BOX_SPACING, ITEM_KINDS, Items, LAST_ROCKET, ROULETTE, itemOdds, rollItem } from "../src/game/race/items";
import { CLASSES, Kart, collideKarts } from "../src/game/race/kart";
import {
  ACCENTS, BODIES, DEFAULT_BUILD, EXHAUSTS, NEUTRAL, PAINTS, SPOILERS, STAT_KEYS, STAT_MAX, WHEELS, buildScore,
  cleanBuild, perfOf, rivalBuild, statsOf,
} from "../src/game/race/parts";
import { stickControls } from "../src/game/core/input";
import { screenSize } from "../src/game/core/gfx";
import { Race, takesControls } from "../src/game/race/race";
import { THEMES } from "../src/game/themes";
import {
  BRIDGE_DECK, BRIDGE_HEIGHT, BRIDGE_RAMP, HALF_WIDTH, N, SPACING, Track, bridgeLift, checkLap, crSegment,
} from "../src/game/world/track";
import {
  CHUNK, type Designer, INITIAL, LiveCircuit, STEP_SCALE, fromSteps, smoothArc, stepMask, toModel, toSteps,
} from "../src/game/world/trackgen";
import circuits from "./circuits.json";

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => (((a + k) % N) + N) % N);
const all = () => new Set(range(0, N));
const twisty = () => Float64Array.from(circuits.twisty);
const calm = () => Float64Array.from(circuits.calm);
const figure8 = () => Float64Array.from(circuits.figure8);

/** The live schedule: the grid and first stretch, then CHUNK-sized arcs until the loop closes. */
function liveArcs(): number[][] {
  const [a, b] = INITIAL;
  const arcs = [range(a, b)];
  for (let p = b; p < N + a; p += CHUNK) arcs.push(range(p, Math.min(p + CHUNK, N + a)));
  return arcs;
}

describe("Catmull-Rom segments", () => {
  it("start exactly at their first control point and are evenly spaced", () => {
    const pts = [[0, 0], [10, 0], [20, 5], [30, 5]];
    const seg = crSegment(pts[0], pts[1], pts[2], pts[3]);
    expect(seg[0][0]).toBeCloseTo(10, 9);
    expect(seg[0][1]).toBeCloseTo(0, 9);
    for (let i = 1; i < seg.length; i++) {
      const d = Math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]);
      expect(d).toBeLessThan(SPACING * 1.6);
    }
  });
});

describe("a circuit that is still being dreamed", () => {
  it("commits road in driving order and never moves committed road", () => {
    const pts = twisty();
    const t = new Track();
    const arcs = liveArcs();
    t.addKnown(arcs[0], pts);
    expect(t.startIndex).toBeGreaterThan(0); // grid road exists behind the line
    expect(t.locked).toBe(false);
    const snapshot = t.xs.slice();
    for (const arc of arcs.slice(1, -1)) {
      t.addKnown(arc, pts);
      expect(t.xs.slice(0, snapshot.length)).toEqual(snapshot);
    }
    expect(t.locked).toBe(false);
    t.addKnown(arcs.at(-1)!, pts);
    expect(t.locked).toBe(true);
    expect(t.committedFraction).toBe(1);
  });

  it("closes into a loop that starts at the start line", () => {
    const t = Track.fromPoints(twisty());
    const n = t.count;
    expect(Math.hypot(t.xs[0] - t.xs[n - 1], t.ys[0] - t.ys[n - 1])).toBeLessThan(SPACING * 1.6);
    expect(t.length).toBeGreaterThan(900);
    expect(t.fromStart(t.startIndex)).toBe(0);
    expect(t.fromStart(t.wrap(t.startIndex - 20))).toBeLessThan(0);
    expect(Math.hypot(t.xs[t.startIndex], t.ys[t.startIndex])).toBeLessThan(0.5); // point 0 is the line
  });

  it("measures lateral offset with the right sign", () => {
    const t = Track.fromPoints(calm());
    const i = t.startIndex + 300;
    const [tx, ty] = t.tangent(i);
    const x = t.xs[i] - ty * 3, y = t.ys[i] + tx * 3; // 3 m to the left of the centerline
    expect(t.offset(x, y, i)).toBeCloseTo(3, 1);
    expect(t.nearest(x, y, i - 5)).toBe(i);
  });
});

describe("bridges", () => {
  it("are built where a figure-eight crosses itself, high over the road below", () => {
    const t = Track.fromPoints(figure8());
    expect(t.bridges.length).toBe(1);
    const b = t.bridges[0];
    expect(t.elev[b.center]).toBeCloseTo(BRIDGE_HEIGHT, 6);
    expect(t.elev[b.lower]).toBe(0); // the earlier stretch stays on the ground
    expect(b.center).toBeGreaterThan(b.lower); // the later stretch is the bridge
    // the deck is long and level, the ramps ease in and out
    expect(bridgeLift(0)).toBe(BRIDGE_HEIGHT);
    expect(bridgeLift(200)).toBe(0);
    expect(bridgeLift(30)).toBeGreaterThan(0);
    expect(bridgeLift(30)).toBeLessThan(BRIDGE_HEIGHT);
  });

  it("are not built on plain loops", () => {
    expect(Track.fromPoints(twisty()).bridges.length).toBe(0);
  });

  it("lift road that was already committed when the crossing is dreamed later", () => {
    const pts = figure8();
    const t = new Track();
    let raised = false;
    for (const arc of liveArcs()) {
      t.addKnown(arc, pts);
      raised ||= t.raised !== null;
    }
    expect(t.bridges.length).toBe(1);
    expect(raised).toBe(true);
    const whole = Track.fromPoints(pts);
    // the same road and the same heights as building it in one go
    expect(t.count).toBe(whole.count);
    for (let i = 0; i < t.count; i += 97) expect(t.elev[i]).toBeCloseTo(whole.elev[i], 6);
  });

  it("keep a kart on its own deck and stop it falling off the side", () => {
    const t = Track.fromPoints(figure8());
    const b = t.bridges[0];
    const k = new Kart(1, "K", 1, false);
    k.placeOn(t, b.center - 40, HALF_WIDTH - 0.2);
    k.heading += 0.5; // aimed at the rail
    k.v = 20;
    for (let s = 0; s < 30; s++) {
      k.ground = t.elev[k.idx];
      k.update(1 / 60, { steer: 0, throttle: 1, brake: 0, drift: false }, t, CLASSES.pro);
      expect(Math.abs(k.offset)).toBeLessThanOrEqual(HALF_WIDTH + 0.05);
    }
    expect(k.elev).toBeGreaterThan(3);
    expect(Math.abs(k.idx - b.center)).toBeLessThan(200); // never snapped to the road below
  });
});

describe("drivability checks", () => {
  it("accept real circuits and the layout they were asked for", () => {
    expect(checkLap(twisty(), all(), "loop", true).ok).toBe(true);
    expect(checkLap(calm(), all(), "any", true).ok).toBe(true);
    expect(checkLap(figure8(), all(), "figure8", true).ok).toBe(true);
    expect(checkLap(figure8(), all(), "loop").reason).toBe("crossings");
    expect(checkLap(twisty(), all(), "figure8").reason).toBe("crossings");
  });

  it("reject a kink and a lap that is too small", () => {
    const kinked = calm();
    kinked[2 * 120 + 1] += 28; // shove one point sideways
    const r = checkLap(kinked, new Set(range(110, 130)), "any");
    expect(r.ok).toBe(false);
    expect(["too tight", "too close to itself"]).toContain(r.reason);
    const small = calm().map((v) => v * 0.4);
    expect(checkLap(small, all(), "any").reason).toBe("length");
  });
});

describe("arc smoothing", () => {
  it("only touches the new arc, in both coordinate rows", () => {
    const u = Float32Array.from({ length: 2 * N }, (_, j) => (j % 2 ? 1 : -1));
    const arc = range(10, 20);
    const s = smoothArc(u, arc, 1.0);
    for (let r = 0; r < 2; r++) {
      for (let j = 0; j < N; j++) {
        if (arc.includes(j)) expect(Math.abs(s[r * N + j])).toBeLessThan(0.5);
        else expect(s[r * N + j]).toBe(u[r * N + j]);
      }
    }
  });
});

describe("lap counting", () => {
  it("counts crossings of the start line, and un-counts backing over it", () => {
    const t = Track.fromPoints(calm());
    const k = new Kart(0, "TEST", 0, true);
    k.placeOn(t, t.wrap(t.startIndex - 10), 0);
    const drive = (steps: number, dir = 1) => {
      for (let s = 0; s < steps; s++) {
        k.idx = t.wrap(k.idx + dir * 4);
        k.x = t.xs[k.idx];
        k.y = t.ys[k.idx];
        k.updateProgress(t);
      }
    };
    drive(5); // over the line from the grid: lap 1 begins
    expect(k.crossings).toBe(1);
    drive(Math.ceil(t.count / 4)); // one full lap
    expect(k.crossings).toBe(2);
    drive(8, -1); // back over the line
    expect(k.crossings).toBe(1);
    expect(k.dist).toBeGreaterThan(t.length * 0.8);
  });

  it("keeps a stationary kart on the road, and the classes ordered by pace", () => {
    expect(CLASSES.rookie.vmax).toBeLessThan(CLASSES.pro.vmax);
    expect(CLASSES.pro.vmax).toBeLessThan(CLASSES.legend.vmax);
    const t = Track.fromPoints(calm());
    const k = new Kart(0, "TEST", 0, true);
    k.placeOn(t, t.startIndex, HALF_WIDTH / 2);
    k.update(1 / 60, { steer: 0, throttle: 0, brake: 0, drift: false }, t, CLASSES.pro);
    expect(k.surface).toBe("road");
  });
});

describe("jumps and boost pads", () => {
  const onRamp = () => {
    const t = Track.fromPoints(calm());
    const f = new Features();
    f.onCommit(t, 0, t.count, () => false, () => 0.5);
    expect(f.ramps.length).toBeGreaterThan(0);
    return { t, f, r: f.ramps[0] };
  };
  const jump = (hopAt: number | null) => {
    const { t, f, r } = onRamp();
    const k = new Kart(0, "K", 0, true);
    k.placeOn(t, t.wrap(r.start - Math.round(30 / SPACING)), 0);
    k.v = CLASSES.pro.vmax;
    let wasAir = false, landed = -1, peak = 0, steps = 0, launchStep = -1;
    while (landed < 0 && steps++ < 600) {
      const ramp = f.rampUnder(t, k);
      k.ground = t.elev[k.idx] + ramp.height;
      k.rampU = ramp.u;
      const hop = hopAt !== null && launchStep < 0 && ramp.u > hopAt;
      const res = k.update(1 / 60, { steer: 0, throttle: 1, brake: 0, drift: hop }, t, CLASSES.pro);
      if (k.air && !wasAir) launchStep = steps;
      wasAir = k.air;
      peak = Math.max(peak, k.elev);
      if (res.landed !== -1) landed = res.landed;
    }
    return { landed, peak, boost: k.boostTime };
  };

  it("are placed on the long straights, clear of the start", () => {
    const { t, r } = onRamp();
    expect(t.fromStart(r.start)).toBeGreaterThan(100);
    for (let k = 0; k < Math.round(RAMP_LEN / SPACING); k++) {
      expect(Math.abs(t.curvature(t.wrap(r.start + k)))).toBeLessThan(1 / 200);
    }
  });

  it("launch a fast kart into the air and bring it back down", () => {
    const { landed, peak } = jump(null);
    expect(landed).toBe(0); // no trick
    expect(peak).toBeGreaterThan(2.5);
  });

  it("reward a hop at the lip with a trick boost on landing", () => {
    const good = jump(0.75);
    expect(good.landed).toBeGreaterThan(0);
    expect(good.boost).toBeGreaterThan(0.5);
    const late = jump(null);
    expect(late.boost).toBe(0);
  });
});

describe("jumps and bridges", () => {
  it("never put a jump on a bridge, its approach ramps or the road beneath it", async () => {
    let checked = 0;
    for (const seed of [3, 4, 5]) {
      const race = new Race({ rivals: 3, difficulty: "pro", theme: THEMES[1], seed, replay: figure8() }, null, () => {});
      await race.prepare();
      const t = race.track;
      expect(t.bridges.length).toBe(1);
      const span = BRIDGE_DECK / 2 + BRIDGE_RAMP; // road raised either side of the crossing
      for (const r of race.features.ramps) {
        for (const b of t.bridges) {
          const near = (s: number) => Math.min(Math.abs(r.s0 - s), Math.abs(r.s0 + RAMP_LEN - s));
          expect(near(b.centerS)).toBeGreaterThan(span);
          expect(near(t.s[b.lower])).toBeGreaterThan(40);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // the figure-eight does have jumps to check
  });
});

describe("rival drivers", () => {
  it("lap a twisty dreamed-style circuit cleanly and drift its tight corners", () => {
    const t = Track.fromPoints(twisty());
    const k = new Kart(1, "RIVAL", 1, false);
    k.placeOn(t, t.wrap(t.startIndex - 8), 0);
    const driver = new RivalDriver(new Rand(4), k, 1);
    const dt = 1 / 60;
    let steps = 0, grass = 0, drifts = 0, boosts = 0, was = false;
    while (k.crossings < 4 && steps < 60 * 400) {
      const { boosted } = k.update(dt, driver.act(dt, t, CLASSES.pro, k, [k]), t, CLASSES.pro);
      k.updateProgress(t);
      if (k.surface === "grass") grass++;
      if (k.drifting && !was) drifts++;
      was = k.drifting;
      if (boosted) boosts++;
      steps++;
    }
    expect(k.crossings - 1).toBe(3);
    expect(grass / steps).toBeLessThan(0.03);
    expect(drifts).toBeGreaterThanOrEqual(3);
    expect(boosts).toBeGreaterThanOrEqual(1);
  });
});

describe("items", () => {
  it("favor defense at the front of the field and the big items at the back", () => {
    const lead = itemOdds(1, 8), last = itemOdds(8, 8), mid = itemOdds(4, 8);
    for (const p of [lead, last, mid, itemOdds(7, 8), itemOdds(1, 1)]) {
      expect(ITEM_KINDS.reduce((s, k) => s + p[k], 0)).toBeCloseTo(1, 9);
      for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(lead.oil).toBeGreaterThan(lead.turbo);
    expect(lead.rocket + lead.prism + lead.shock).toBe(0); // no big items for the leader
    expect(mid.rocket).toBeLessThan(0.05);
    expect(last.rocket).toBeCloseTo(LAST_ROCKET, 9); // dead last: the rocket, nine times in ten
    expect(itemOdds(1, 1).rocket).toBeLessThan(0.05); // racing alone is not being last
  });

  it("really do hand the last kart a rocket nine times in ten", () => {
    const rng = new Rand(11);
    let rockets = 0;
    for (let i = 0; i < 4000; i++) if (rollItem(6, 6, rng) === "rocket") rockets++;
    expect(rockets / 4000).toBeGreaterThan(0.87);
    expect(rockets / 4000).toBeLessThan(0.93);
  });

  it("come in rows of boxes along the road, clear of the run to the line", () => {
    const t = Track.fromPoints(calm());
    const items = new Items(new Rand(1));
    items.onCommit(t, 0, t.count);
    expect(items.boxes.length % 4).toBe(0);
    expect(items.boxes.length / 4).toBeGreaterThanOrEqual(Math.floor(t.length / BOX_SPACING) - 1);
    for (const b of items.boxes) {
      const s = t.fromStart(t.nearest(b.x, b.y, 0));
      expect(s).toBeGreaterThan(BOX_SPACING * 0.5);
      expect(s).toBeLessThan(t.length - 60);
    }
  });

  it("hand rivals an item at once and give the player a roulette first", () => {
    const t = Track.fromPoints(calm());
    const items = new Items(new Rand(2));
    items.onCommit(t, 0, t.count);
    const rival = new Kart(1, "RIVAL", 1, false);
    [rival.x, rival.y] = [items.boxes[0].x, items.boxes[0].y];
    items.update(1 / 60, t, [rival], () => 1);
    expect(rival.item).not.toBeNull();
    expect(items.boxes[0].respawn).toBeGreaterThan(0);
    const me = new Kart(0, "YOU", 0, true);
    [me.x, me.y] = [items.boxes[1].x, items.boxes[1].y];
    items.update(1 / 60, t, [me], () => 1);
    expect(me.roulette).toBeGreaterThan(0);
    expect(items.use(me, [me])).toBe(false); // not while the slot is still spinning
    for (let i = 0; i < Math.ceil(ROULETTE * 60) + 2; i++) items.update(1 / 60, t, [me], () => 1);
    expect(items.events.some((e) => e.kind === "got" && e.kart === me)).toBe(true);
    const uses = me.uses;
    expect(uses).toBeGreaterThanOrEqual(1);
    expect(items.use(me, [me])).toBe(true);
    if (uses === 1) expect(me.item).toBeNull();
    else expect(me.uses).toBe(uses - 1); // a triple turbo or a boomerang has shots left
  });

  it("oil spins out whoever drives through it, but spares its owner at first", () => {
    const t = Track.fromPoints(calm());
    const items = new Items(new Rand(3));
    const owner = new Kart(1, "A", 1, false), other = new Kart(2, "B", 2, false);
    owner.placeOn(t, t.startIndex + 50, 0);
    owner.v = 20;
    owner.item = "oil";
    items.use(owner, [owner, other]);
    const sl = items.slicks[0];
    [owner.x, owner.y] = [sl.x, sl.y];
    items.update(1 / 60, t, [owner], () => 1);
    expect(owner.spin).toBe(0);
    [other.x, other.y] = [sl.x, sl.y];
    other.v = 25;
    items.update(1 / 60, t, [owner, other], () => 1);
    expect(other.spin).toBeGreaterThan(0);
    expect(other.v).toBeLessThan(15);
    expect(items.slicks.length).toBe(0);
  });

  it("send a dream orb up the road to catch the kart ahead", () => {
    const t = Track.fromPoints(calm());
    const items = new Items(new Rand(4));
    const shooter = new Kart(1, "A", 1, false), target = new Kart(2, "B", 2, false);
    shooter.placeOn(t, t.startIndex + 10, -2);
    target.placeOn(t, t.startIndex + 10 + Math.round(45 / SPACING), 2.5);
    for (const k of [shooter, target]) k.updateProgress(t);
    shooter.item = "orb";
    items.use(shooter, [shooter, target]);
    expect(items.orbs[0].target).toBe(target);
    for (let i = 0; i < 60 * 4 && target.spin <= 0; i++) items.update(1 / 60, t, [shooter, target], () => 1);
    expect(target.spin).toBeGreaterThan(0);
    expect(items.orbs.length).toBe(0);
  });

  it("fire on the press of the button, not while it is held, in a real race", async () => {
    const race = new Race({ rivals: 5, difficulty: "pro", theme: THEMES[0], seed: 7, replay: twisty() }, null, () => {});
    await race.prepare();
    const pilot = new RivalDriver(new Rand(9), race.player, 0);
    let rivalUses = 0;
    const use = race.items.use.bind(race.items);
    race.items.use = (k, karts) => {
      const ok = use(k, karts);
      if (ok && !k.isPlayer) rivalUses++;
      return ok;
    };
    let playerUses = 0, rolls = 0;
    for (let i = 0; i < 60 * 80; i++) {
      const c = pilot.act(1 / 60, race.track, race.cls, race.player, race.karts);
      race.update(1 / 60, { ...c, item: true }); // the button is held the whole time
      playerUses += race.events.filter((e) => e.kind === "use").length;
      rolls += race.events.filter((e) => e.kind === "roll").length;
      race.events = [];
    }
    expect(rolls).toBeGreaterThan(0); // the player drove through boxes
    expect(playerUses).toBeLessThanOrEqual(1); // holding never re-fires
    expect(rivalUses).toBeGreaterThan(0); // rivals use their items
  });
});

describe("the start", () => {
  const start = async (throttleFrom: number) => {
    const race = new Race({ rivals: 3, difficulty: "pro", theme: THEMES[0], seed: 4, replay: twisty() }, null, () => {});
    await race.prepare();
    const kinds: string[] = [];
    // countdown is 4 at the start and GO comes at 1: hold the throttle from ``throttleFrom`` on
    for (let i = 0; i < 60 * 4 && race.phase === "countdown"; i++) {
      expect(takesControls(race.phase)).toBe(true); // the game passes the keys on, even now
      const gas = race.countdown <= throttleFrom ? 1 : 0;
      race.update(1 / 60, { steer: 0, throttle: gas, brake: 0, drift: false });
      kinds.push(...race.events.map((e) => e.kind));
      race.events = [];
    }
    return kinds;
  };
  it("gives a rocket start for gas pressed just before GO", async () => {
    expect(await start(1.3)).toContain("rocket");
  });
  it("spins the wheels when the gas is held through the countdown", async () => {
    const kinds = await start(4);
    expect(kinds).toContain("burnout");
    expect(kinds).not.toContain("rocket");
  });
  it("gives neither for a plain start", async () => {
    const kinds = await start(0);
    expect(kinds).not.toContain("rocket");
    expect(kinds).not.toContain("burnout");
  });
});

describe("a crowded race", () => {
  it("never flings a kart past its class's boosted top speed, even in pile-ups", async () => {
    for (const seed of [7, 8, 9]) {
      const race = new Race({ rivals: 7, difficulty: "pro", theme: THEMES[0], seed, replay: twisty() }, null, () => {});
      await race.prepare();
      const pilot = new RivalDriver(new Rand(9), race.player, 0);
      let fastest = 0;
      for (let i = 0; i < 60 * 60; i++) {
        race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, race.player, race.karts));
        race.events = [];
        // relative to each kart's own top speed (its build, a prism); a rocket is meant to be fast
        for (const k of race.karts) if (k.rocket <= 0) fastest = Math.max(fastest, Math.abs(k.v) / k.topSpeed(race.cls));
      }
      // before the fix, bumps at the start pumped one kart to 88 m/s and shoved another to -55
      expect(fastest).toBeLessThan(1.3);
    }
  });

  it("races a figure-eight over its bridge: everyone finishes, nobody falls off", async () => {
    const race = new Race({ rivals: 5, difficulty: "pro", theme: THEMES[1], seed: 3, replay: figure8() }, null, () => {});
    await race.prepare();
    const pilot = new RivalDriver(new Rand(2), race.player, 0);
    let onDeck = 0;
    for (let i = 0; i < 60 * 240 && race.phase !== "done"; i++) {
      race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, race.player, race.karts));
      race.events = [];
      for (const k of race.karts) {
        if (k.elev > BRIDGE_HEIGHT - 0.5) onDeck++;
        expect(Number.isFinite(k.x) && Number.isFinite(k.elev)).toBe(true);
      }
    }
    expect(race.player.finished).toBe(true);
    expect(onDeck).toBeGreaterThan(100); // karts really drove over the deck
  });
});

/** A stand-in designer that always "dreams" the steps of one fixed circuit (keeping the known
 * steps), so the live procedure itself is under test; ``fail`` decides which calls throw. */
function fakeDesigner(fail: (call: number) => boolean, circuit = calm()): Designer {
  let calls = 0;
  const target = toSteps(toModel(circuit), new Float32Array(N).fill(1), STEP_SCALE);
  return {
    sample: async (req) => {
      if (fail(calls++)) throw new Error("simulated runtime failure");
      const out = Float32Array.from(target);
      for (let j = 0; j < N; j++) {
        if (req.mask[j] > 0) {
          out[j] = req.known[j];
          out[N + j] = req.known[N + j];
        }
      }
      return out;
    },
  };
}

async function driveLap(live: LiveCircuit, frames = 400): Promise<void> {
  for (let i = 0; i < frames && !live.track.locked; i++) {
    live.update((live.track.frontierSeg - 1 + N) % N); // the leader is always right at the frontier
    for (let k = 0; k < 5; k++) await Promise.resolve();
  }
}

describe("the designer's steps", () => {
  const lap = () => toModel(twisty());
  it("round-trip a whole lap, which starts at the origin", () => {
    const pts = lap();
    const back = fromSteps(toSteps(pts, new Float32Array(N).fill(1), STEP_SCALE), pts, new Float32Array(N), STEP_SCALE);
    for (let j = 0; j < 2 * N; j++) expect(back[j]).toBeCloseTo(pts[j] - pts[j < N ? 0 : N], 4); // float32 steps
  });
  it("leave known road exactly in place and land dreamed runs on the road after them", () => {
    const pts = lap();
    const mask = new Float32Array(N);
    for (let j = 232; j < 232 + 100; j++) mask[j % N] = 1;
    // a dreamed run that has drifted: every step a little long and turned
    const u = toSteps(pts, new Float32Array(N).fill(1), STEP_SCALE).map((v, j) => v * 1.05 + (j < N ? 0.02 : -0.02));
    const out = fromSteps(u, pts, mask, STEP_SCALE);
    for (let j = 0; j < N; j++) {
      if (!mask[j]) continue;
      expect(out[j]).toBe(pts[j]);
      expect(out[N + j]).toBe(pts[N + j]);
    }
    // no jump where the run meets the known road at either end
    const step = (a: number, b: number) => Math.hypot(out[b] - out[a], out[N + b] - out[N + a]);
    const typical = step(10, 11);
    expect(step(75, 76)).toBeLessThan(typical * 1.25);
    expect(step(230, 231)).toBeLessThan(typical * 1.25);
    expect(step(231, 232)).toBeLessThan(typical * 1.25);
  });
  it("know a step only when both of its points are road", () => {
    const mask = new Float32Array(N);
    mask[5] = mask[6] = mask[7] = 1;
    const m = stepMask(mask);
    expect([m[4], m[5], m[6], m[7]]).toEqual([0, 1, 1, 0]);
  });
});

describe("live circuit generation", () => {
  it("builds the lap arc by arc and locks it", async () => {
    const live = new LiveCircuit(fakeDesigner(() => false), new Rand(1));
    await live.start();
    expect(live.track.locked).toBe(false);
    await driveLap(live);
    expect(live.track.locked).toBe(true);
    expect(live.stats.arcs).toBe(liveArcs().length);
    expect(live.stats.fallbacks).toBe(0);
  });

  it("builds a bridge when the dream crosses itself", async () => {
    const live = new LiveCircuit(fakeDesigner(() => false, figure8()), new Rand(5), "figure8");
    const raised: number[][] = [];
    live.onRaise = (a, b) => raised.push([a, b]);
    await live.start();
    await driveLap(live);
    expect(live.track.locked).toBe(true);
    expect(live.track.bridges.length).toBe(1);
    expect(raised.length).toBeLessThanOrEqual(1);
  });

  it("asks each arc for the style the race wants", async () => {
    const asked: (number | null)[] = [];
    const d = fakeDesigner(() => false);
    const spy: Designer = { sample: (req) => { asked.push(req.style); return d.sample(req); } };
    const live = new LiveCircuit(spy, new Rand(6));
    let s = 0.2;
    live.styleSource = () => (s += 0.1);
    await live.start();
    await driveLap(live);
    expect(asked.length).toBe(liveArcs().length);
    expect(asked[1]).toBeGreaterThan(asked[0]!);
  });

  it("retries an arc that failed instead of wedging the race", async () => {
    const live = new LiveCircuit(fakeDesigner((c) => c % 3 === 1), new Rand(2));
    await live.start();
    await driveLap(live);
    expect(live.track.locked).toBe(true);
    expect(live.closedWithoutDesigner).toBe(false);
    expect(live.busy).toBe(false);
  });

  it("closes the lap from its last guess if the designer keeps failing", async () => {
    const live = new LiveCircuit(fakeDesigner((c) => c > 0), new Rand(3));
    await live.start(); // the opening stretch works, then every call fails
    await driveLap(live);
    expect(live.track.locked).toBe(true);
    expect(live.closedWithoutDesigner).toBe(true);
  });

  it("reports a designer that cannot dream the opening stretch", async () => {
    const live = new LiveCircuit(fakeDesigner(() => true), new Rand(4));
    await expect(live.start()).rejects.toThrow("opening stretch");
  });
});

/** Two karts on the calm circuit, ``gap`` m apart along the road, and a fresh item box set. */
function duel(gap: number, lateral = 0) {
  const t = Track.fromPoints(calm());
  const items = new Items(new Rand(8));
  const a = new Kart(1, "A", 1, false), b = new Kart(2, "B", 2, false);
  a.placeOn(t, t.startIndex + 20, lateral);
  b.placeOn(t, t.wrap(t.startIndex + 20 + Math.round(gap / SPACING)), lateral);
  for (const k of [a, b]) k.updateProgress(t);
  return { t, items, a, b };
}

describe("the new items", () => {
  it("throw a boomerang up the road that spins the kart ahead and comes home", () => {
    const { t, items, a, b } = duel(20);
    items.grant(a, "boomerang");
    expect(a.uses).toBe(3);
    expect(items.press(a, [a, b])).toBe(true); // a boomerang flies at once
    expect(a.uses).toBe(2);
    expect(a.item).toBe("boomerang");
    let caught = false;
    for (let i = 0; i < 60 * 5 && !caught; i++) {
      items.update(1 / 60, t, [a, b], () => 1);
      caught = items.boomerangs.length === 0;
    }
    expect(b.spin).toBeGreaterThan(0);
    expect(caught).toBe(true); // back in the thrower's hand
    expect(a.spin).toBe(0); // and it never hits its own thrower
  });

  it("lob a bomb that blows up near a kart and spins everyone close to it", () => {
    const { t, items, a, b } = duel(22);
    const far = new Kart(3, "C", 3, false);
    far.placeOn(t, t.wrap(t.startIndex + 20 + Math.round(70 / SPACING)), 0);
    a.v = 20;
    items.grant(a, "bomb");
    expect(items.press(a, [a, b, far])).toBe(true); // held out behind first
    expect(a.trailing).toBe(true);
    expect(items.release(a, [a, b, far])).toBe(true); // let go: it is thrown
    expect(items.bombs.length).toBe(1);
    let booms = 0;
    for (let i = 0; i < 60 * 4; i++) {
      items.update(1 / 60, t, [a, b, far], () => 1);
      booms += items.events.filter((e) => e.kind === "boom").length;
      items.events = [];
    }
    expect(booms).toBe(1);
    expect(items.blasts.length + items.bombs.length).toBe(0);
    expect(b.spin).toBeGreaterThan(0); // caught in the blast
    expect(far.spin).toBe(0); // well outside it
    expect(Math.hypot(far.x - b.x, far.y - b.y)).toBeGreaterThan(BOMB_BLAST);
  });

  it("make a prism kart untouchable, and spin whoever it rams", () => {
    const { t, items, a, b } = duel(30); // a behind, b ahead
    items.grant(b, "prism");
    items.press(b, [a, b]);
    expect(b.prism).toBeGreaterThan(0);
    expect(b.invincible).toBe(true);
    // an orb fired at it is simply used up
    items.grant(a, "orb");
    items.use(a, [a, b]);
    expect(items.orbs[0].target).toBe(b);
    for (let i = 0; i < 60 * 4 && items.orbs.length; i++) items.update(1 / 60, t, [a, b], () => 1);
    expect(items.orbs.length).toBe(0);
    expect(b.spin).toBe(0);
    // ramming: the prism kart barges into the other one, spins it, and is not slowed itself
    a.x = b.x - 1.2;
    a.y = b.y;
    a.v = 20;
    b.v = 25;
    const { spun } = collideKarts([a, b], CLASSES.pro.vmax * 1.3);
    expect(spun).toEqual([[a, b]]);
    expect(a.spin).toBeGreaterThan(0);
    expect(b.v).toBe(25);
  });

  it("shock everyone else: they spin, shrink and lose their items, the user does not", () => {
    const { items, a, b } = duel(30);
    const c = new Kart(3, "C", 3, false);
    items.grant(b, "orb");
    c.prism = 3; // invincible: shrugs it off
    items.grant(a, "shock");
    items.press(a, [a, b, c]);
    expect(b.spin).toBeGreaterThan(0);
    expect(b.shrink).toBeGreaterThan(0);
    expect(b.item).toBeNull();
    expect(c.shrink).toBe(0);
    expect(a.spin + a.shrink).toBe(0);
    expect(items.events.some((e) => e.kind === "shock")).toBe(true);
  });

  it("block an orb from behind with an item held out as a shield", () => {
    const { t, items, a, b } = duel(30);
    items.grant(b, "oil");
    items.press(b, [a, b]); // held out behind: trailing
    expect(b.trailing).toBe(true);
    items.grant(a, "orb");
    items.use(a, [a, b]);
    expect(items.orbs[0].target).toBe(b);
    for (let i = 0; i < 60 * 4 && items.orbs.length; i++) items.update(1 / 60, t, [a, b], () => 1);
    expect(b.spin).toBe(0); // the oil took the hit
    expect(b.item).toBeNull();
    expect(items.events.some((e) => e.kind === "blocked" && e.kart === b)).toBe(true);
  });

  it("turn the player into a rocket that flies itself up the road and past the pack", async () => {
    const race = new Race({ rivals: 5, difficulty: "pro", theme: THEMES[0], seed: 5, replay: twisty() }, null, () => {});
    await race.prepare();
    const coast = { steer: 0, throttle: 1, brake: 0, drift: false };
    for (let i = 0; i < 60 * 5; i++) race.update(1 / 60, coast); // through the countdown and away
    race.items.grant(race.player, "rocket");
    const start = race.player.dist;
    race.update(1 / 60, { ...coast, item: true });
    expect(race.player.rocket).toBeGreaterThan(0);
    let over = false, worst = 0;
    for (let i = 0; i < 60 * 7; i++) {
      const flying = race.player.rocket > 0;
      race.update(1 / 60, { steer: flying ? 1 : 0, throttle: 1, brake: 0, drift: false }); // the wheel is ignored
      if (flying) worst = Math.max(worst, Math.abs(race.player.offset));
      over ||= race.events.some((e) => e.kind === "rocketOver");
      race.events = [];
    }
    expect(over).toBe(true);
    expect(race.player.spin).toBe(0);
    expect(worst).toBeLessThan(HALF_WIDTH); // it stays on the road
    expect(race.player.dist - start).toBeGreaterThan(CLASSES.pro.vmax * 6 * 1.3); // much faster than driving
  });
});

describe("the garage", () => {
  it("lists real-world-style parts with short names and unique ids", () => {
    for (const list of [BODIES, WHEELS, SPOILERS, EXHAUSTS, PAINTS, ACCENTS]) {
      expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
      for (const p of list) expect(p.name.length).toBeLessThanOrEqual(14);
    }
    expect(BODIES.length).toBeGreaterThanOrEqual(12);
    expect(WHEELS.length + SPOILERS.length + EXHAUSTS.length).toBeGreaterThanOrEqual(30);
  });

  it("adds up six stats within 0..20, and the classic kart is neutral", () => {
    expect(perfOf(statsOf(DEFAULT_BUILD))).toEqual(NEUTRAL);
    const rng = new Rand(3);
    for (let i = 0; i < 200; i++) {
      const s = statsOf(rivalBuild(rng, "pro"));
      for (const k of STAT_KEYS) {
        expect(s[k]).toBeGreaterThanOrEqual(0);
        expect(s[k]).toBeLessThanOrEqual(STAT_MAX);
      }
    }
    expect(statsOf({ ...DEFAULT_BUILD, body: "hyper" }).speed).toBeGreaterThan(statsOf(DEFAULT_BUILD).speed);
    expect(statsOf({ ...DEFAULT_BUILD, wheels: "offroad" }).traction).toBeGreaterThan(10);
    expect(cleanBuild({ body: "nope", paint: "rosso" })).toEqual({ ...DEFAULT_BUILD, paint: "rosso" });
  });

  it("gives harder classes better rival karts", () => {
    const avg = (d: "rookie" | "pro" | "legend") => {
      const rng = new Rand(21);
      let sum = 0;
      for (let i = 0; i < 300; i++) sum += buildScore(rivalBuild(rng, d));
      return sum / 300;
    };
    const rookie = avg("rookie"), pro = avg("pro"), legend = avg("legend");
    expect(rookie).toBeLessThan(pro);
    expect(pro).toBeLessThan(legend);
  });

  it("puts the stats on the road: a fast build is faster, a heavy one wins the bump", () => {
    const t = Track.fromPoints(calm());
    const top = (b: typeof DEFAULT_BUILD) => {
      const k = new Kart(0, "K", 0, true).equip(b);
      k.placeOn(t, t.startIndex, 0);
      for (let i = 0; i < 60 * 20; i++) {
        k.update(1 / 60, { steer: 0, throttle: 1, brake: 0, drift: false }, t, CLASSES.pro);
        k.x = t.xs[k.idx]; k.y = t.ys[k.idx]; k.heading = Math.atan2(t.tangent(k.idx)[1], t.tangent(k.idx)[0]);
      }
      return k.v;
    };
    const fast = { ...DEFAULT_BUILD, body: "hyper", wheels: "turbofan", exhaust: "turboback" };
    expect(top(fast)).toBeGreaterThan(top(DEFAULT_BUILD) * 1.04);
    const heavy = new Kart(1, "H", 1, false).equip({ ...DEFAULT_BUILD, body: "pony", wheels: "steelies" });
    const light = new Kart(2, "L", 2, false).equip({ ...DEFAULT_BUILD, body: "kei", wheels: "carbon" });
    heavy.x = 0; heavy.y = 0; heavy.heading = 0; heavy.v = 20;
    light.x = 1.5; light.y = 0; light.heading = Math.PI; light.v = 20; // head on
    collideKarts([heavy, light], 40);
    expect(heavy.v).toBeGreaterThan(light.v);
  });
});

describe("the screen", () => {
  it("covers the window at a whole-number scale near 216 rows", () => {
    const sizes = [[1920, 1080], [1440, 900], [2560, 1440], [844, 390], [1280, 720], [1000, 557], [1366, 768],
                   [1536, 864], [932, 430], [667, 375], [3440, 1440]];
    for (const [vw, vh] of sizes) {
      const s = screenSize(vw, vh);
      expect(Number.isInteger(s.scale)).toBe(true);
      expect(s.w * s.scale).toBeGreaterThanOrEqual(vw);
      expect(s.h * s.scale).toBeGreaterThanOrEqual(vh);
      expect(s.w * s.scale - vw).toBeLessThan(s.scale);
      expect(s.h).toBeGreaterThanOrEqual(180);
      expect(s.h).toBeLessThanOrEqual(260);
    }
    expect(screenSize(1920, 1080)).toEqual({ w: 384, h: 216, scale: 5 });
    const tall = screenSize(390, 844); // a phone held upright: fit the width
    expect(tall.w).toBe(320);
    expect(tall.w * tall.scale).toBeCloseTo(390, 6);
  });
});

describe("the touch joystick", () => {
  it("steers with a dead zone, drifts when pushed all the way over, and brakes when pulled back", () => {
    expect(stickControls(0.05, 0, false)).toEqual({ steer: 0, brake: 0, drift: false });
    const right = stickControls(1, 0, false);
    expect(right.steer).toBeCloseTo(-1, 9); // the game's steer is + = left
    expect(right.drift).toBe(true);
    expect(stickControls(-0.5, 0, false).steer).toBeGreaterThan(0);
    expect(stickControls(-0.5, 0, false).steer).toBeLessThan(0.5);
    expect(stickControls(0.8, 0, false).drift).toBe(false); // not far enough to start one
    expect(stickControls(0.8, 0, true).drift).toBe(true); // but enough to keep one going
    expect(stickControls(0.1, 0.9, false).brake).toBe(1);
  });
});

describe("the soundtrack", () => {
  it("parses its notes and chords", async () => {
    const { chord, midi } = await import("../src/game/core/music");
    expect(midi("A4")).toBe(69);
    expect(midi("C4")).toBe(60);
    expect(midi("A#4")).toBe(70);
    expect(chord("Am")).toEqual([57, 60, 64]);
    expect(chord("Bb")).toEqual([58, 62, 65]);
    expect(chord("Fmaj7")).toEqual([53, 57, 60, 64]);
  });
});
