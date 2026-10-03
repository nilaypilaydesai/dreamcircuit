// Game logic: circuits that grow while they are dreamed, bridge their own crossings, lock into
// loops and count laps; jumps, tricks and boost pads; rivals and items, in headless races.

import { describe, expect, it } from "vitest";
import { Rand } from "../src/game/core/gfx";
import { RivalDriver } from "../src/game/race/ai";
import { Features, RAMP_LEN, TUNNEL_LEN } from "../src/game/race/features";
import {
  AIM_MAX, BOMB_BLAST, BOX_SPACING, COMET_BLAST, type Field, GOLD_TIME, HORN_R, ITEM_KINDS, ITEM_NAMES, Items, JACKPOT,
  ROCKET_TIME, ROULETTE, STATIC_TIME, rocketPasses,
} from "../src/game/race/items";
import { ROCKET_GAP, type Standing, itemOdds, pickItem, tierOf } from "../src/game/race/odds";
import { heldArt, itemIcons } from "../src/game/render/sprites";
import { Cup, type Entrant, POINTS } from "../src/game/race/cup";
import { CLASSES, COIN_SPEED, FALL_RELEASE, FALL_SWAP, Kart, REVERSE_SPEED, collideKarts } from "../src/game/race/kart";
import { CALM_BAND, TRACK_TYPES, type TrackTypeId, WILD_BAND, surpriseType, trackType } from "../src/game/race/tracktypes";
import {
  ACCENTS, BODIES, DEFAULT_BUILD, EXHAUSTS, NEUTRAL, NOTE_MAX, PAINTS, SPOILERS, STAT_KEYS, STAT_MAX, WHEELS, buildScore,
  cleanBuild, perfOf, rivalBuild, statsOf,
} from "../src/game/race/parts";
import { stickControls } from "../src/game/core/input";
import { screenSize } from "../src/game/core/gfx";
import { LAPS, Race, takesControls } from "../src/game/race/race";
import { THEMES } from "../src/game/themes";
import {
  BRIDGE_DECK, BRIDGE_HEIGHT, BRIDGE_RAMP, HALF_WIDTH, N, SPACING, Track, bridgeLift, checkLap, crSegment,
} from "../src/game/world/track";
import {
  CHUNK, type Designer, INITIAL, LiveCircuit, STEP_SCALE, arcStyle, bandMiss, fromSteps, smoothArc, stepMask, toModel, toSteps,
} from "../src/game/world/trackgen";
import { BANK_EDGE } from "../src/game/world/texture";
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

/** A field for item tests: the leader is the first kart given, the rest stand behind it. */
function fieldOf(karts: Kart[]): Field {
  return {
    leader: () => karts.filter((k) => !k.finished).sort((a, b) => b.dist - a.dist)[0] ?? null,
    standing: (k: Kart): Standing => ({ behind: 0, last: false, gapAhead: 0, field: karts.length, player: k.isPlayer }),
  };
}

const at = (behind: number, more: Partial<Standing> = {}): Standing =>
  ({ behind, last: false, gapAhead: 10, field: 8, player: true, ...more });

describe("items", () => {
  it("are twenty-two, each with a name, an icon and the art a kart carries it with", () => {
    expect(new Set(ITEM_KINDS).size).toBe(22);
    const icons = itemIcons(), held = heldArt();
    for (const k of ITEM_KINDS) {
      expect(ITEM_NAMES[k].length).toBeLessThanOrEqual(13);
      expect(icons[k].w).toBeLessThanOrEqual(32); // fits the HUD's slot, pixel for pixel
      expect(icons[k].h).toBeLessThanOrEqual(32);
      expect(held[k].sprite.data.some((c) => c !== 0)).toBe(true);
    }
  });

  it("come out of a box with the classic's odds, by how far a kart is behind the leader", () => {
    for (const player of [true, false]) {
      for (const behind of [0, 5, 15, 30, 60, 100, 150, 250, 500, 2000]) {
        const p = itemOdds(at(behind, { player, last: true, gapAhead: 80 }));
        expect(ITEM_KINDS.reduce((s, k) => s + p[k], 0)).toBeCloseTo(1, 9);
        for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(0);
      }
    }
    // the leader: coins, oil and pucks, as in the classic's first tier
    const lead = itemOdds(at(0));
    expect(lead.coin).toBeCloseTo(0.35, 9);
    expect(lead.oil).toBeCloseTo(0.325, 9);
    expect(lead.puck).toBeCloseTo(0.25, 9);
    expect(lead.comet + lead.prism + lead.rocket + lead.shock + lead.gold + lead.triple).toBe(0);
    // just behind: orbs; further back: turbos and prisms; far back: the big ones
    expect(itemOdds(at(20)).orb).toBeGreaterThan(0.2);
    const back = itemOdds(at(400));
    expect(back.triple + back.prism + back.gold + back.shock).toBeGreaterThan(0.5);
    expect(back.oil + back.puck + back.coin).toBe(0);
    // the comet only for karts well back, never for the leader
    expect(itemOdds(at(0)).comet).toBe(0);
    expect(itemOdds(at(120)).comet).toBeGreaterThan(0);
    // the tiers: the player's and the computer drivers' start in different places
    expect([tierOf(0, true), tierOf(9, true), tierOf(11, true), tierOf(1000, true)]).toEqual([0, 0, 1, 8]);
    expect(tierOf(9, false)).toBe(1);
    // computer drivers get their own table: more oil, fewer orbs
    expect(itemOdds(at(20, { player: false })).orb).toBeLessThan(itemOdds(at(20)).orb + 0.05);
  });

  it("only hand the rocket to the last kart, and only when it has fallen well behind", () => {
    const far = (more: Partial<Standing>) => itemOdds(at(250, { last: true, gapAhead: ROCKET_GAP + 20, ...more })).rocket;
    expect(far({})).toBeGreaterThan(0.1);
    expect(far({ gapAhead: ROCKET_GAP - 1 })).toBe(0); // last, but close behind the kart ahead
    expect(far({ last: false })).toBe(0); // far behind, but not last
    expect(far({ field: 2 })).toBe(0); // second of two: a rocket could only win it
    expect(itemOdds(at(0, { last: true, gapAhead: 500 })).rocket).toBe(0); // the leader's tier never has one
  });

  it("leave out what cannot be had right now, and share its odds out", () => {
    const p = itemOdds(at(120), new Set(["comet", "shock"]));
    expect(p.comet + p.shock).toBe(0);
    expect(ITEM_KINDS.reduce((s, k) => s + p[k], 0)).toBeCloseTo(1, 9);
    const rng = new Rand(11);
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const k = pickItem(itemOdds(at(0)), rng.next());
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect((counts.get("coin") ?? 0) / 4000).toBeGreaterThan(0.32);
    expect((counts.get("coin") ?? 0) / 4000).toBeLessThan(0.38);
    expect(counts.get("rocket") ?? 0).toBe(0);
  });

  it("let a rocket pass two karts at most, and never into the lead", () => {
    expect(rocketPasses(8)).toBe(2);
    expect(rocketPasses(4)).toBe(2);
    expect(rocketPasses(3)).toBe(1);
    expect(rocketPasses(2)).toBe(0);
  });

  it("come in rows of boxes along the road, with lines of coins between, clear of the run to the line", () => {
    const t = Track.fromPoints(calm());
    const items = new Items(new Rand(1));
    items.onCommit(t, 0, t.count);
    expect(items.boxes.length % 4).toBe(0);
    expect(items.boxes.length / 4).toBeGreaterThanOrEqual(Math.floor(t.length / BOX_SPACING) - 1);
    expect(items.coins.length).toBeGreaterThanOrEqual(4 * (Math.floor(t.length / BOX_SPACING) - 2));
    for (const b of [...items.boxes, ...items.coins]) {
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
    items.update(1 / 60, t, [rival], fieldOf([rival]));
    expect(rival.item).not.toBeNull();
    expect(items.boxes[0].respawn).toBeGreaterThan(0);
    const me = new Kart(0, "YOU", 0, true);
    [me.x, me.y] = [items.boxes[1].x, items.boxes[1].y];
    items.update(1 / 60, t, [me], fieldOf([me]));
    expect(me.roulette).toBeGreaterThan(0);
    expect(items.use(me, [me])).toBe(false); // not while the slot is still spinning
    for (let i = 0; i < Math.ceil(ROULETTE * 60) + 2; i++) items.update(1 / 60, t, [me], fieldOf([me]));
    expect(items.events.some((e) => e.kind === "got" && e.kart === me)).toBe(true);
    expect(me.uses).toBe(1); // the leader's items are all single shots
    expect(items.use(me, [me], fieldOf([me]))).toBe(true);
    expect(me.item).toBeNull();
  });

  it("oil spins out whoever drives through it, but spares its owner at first", () => {
    const t = Track.fromPoints(calm());
    const items = new Items(new Rand(3));
    const owner = new Kart(1, "A", 1, false), other = new Kart(2, "B", 2, false);
    owner.placeOn(t, t.startIndex + 50, 0);
    owner.v = 20;
    owner.item = "oil";
    owner.uses = 1;
    items.use(owner, [owner, other]);
    const sl = items.slicks[0];
    [owner.x, owner.y] = [sl.x, sl.y];
    items.update(1 / 60, t, [owner], fieldOf([owner]));
    expect(owner.spin).toBe(0);
    [other.x, other.y] = [sl.x, sl.y];
    other.v = 25;
    items.update(1 / 60, t, [owner, other], fieldOf([owner, other]));
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
    items.grant(shooter, "orb");
    items.use(shooter, [shooter, target]);
    expect(items.orbs[0].target).toBe(target);
    const f = fieldOf([target, shooter]);
    for (let i = 0; i < 60 * 4 && target.spin <= 0; i++) items.update(1 / 60, t, [shooter, target], f);
    expect(target.spin).toBeGreaterThan(0);
    expect(items.orbs.length).toBe(0);
  });

  it("fire on the press of the button, not while it is held, in a real race", async () => {
    const race = new Race({ rivals: 5, difficulty: "pro", theme: THEMES[0], seed: 7, replay: twisty() }, null, () => {});
    await race.prepare();
    const pilot = new RivalDriver(new Rand(9), race.player, 0);
    let rivalUses = 0;
    const use = race.items.use.bind(race.items);
    race.items.use = (k, karts, field) => {
      const ok = use(k, karts, field);
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
  it("throw a boomerang where the arrow was locked: one press locks it, the next throws", () => {
    const { t, items, a, b } = duel(20, 0);
    const c = new Kart(3, "C", 3, false);
    // two karts 20 m up the road, one 5 m to the left and one 5 m to the right
    const ahead = t.wrap(t.startIndex + 20 + Math.round(20 / SPACING));
    b.placeOn(t, ahead, 5);
    c.placeOn(t, ahead, -5);
    items.grant(a, "boomerang");
    expect(a.uses).toBe(3);
    a.aim = Math.atan2(5, 20); // the arrow, on the left one
    expect(items.press(a, [a, b, c])).toBe(true); // the first press locks it
    expect(a.aimLocked).toBeCloseTo(Math.atan2(5, 20), 9);
    expect(items.boomerangs.length).toBe(0);
    a.aim = -0.5; // (the sweep would have moved on; the lock holds)
    expect(items.release(a, [a, b, c])).toBe(false); // letting go does nothing
    expect(items.press(a, [a, b, c])).toBe(true); // the second throws
    expect(a.uses).toBe(2);
    expect(a.aimLocked).toBeNull(); // the arrow sweeps again for the next one
    let caught = false;
    const f = fieldOf([b, c, a]);
    for (let i = 0; i < 60 * 5 && !caught; i++) {
      items.update(1 / 60, t, [a, b, c], f);
      caught = items.boomerangs.length === 0;
    }
    expect(b.spin).toBeGreaterThan(0);
    expect(c.spin).toBe(0); // the arrow was not pointing at it
    expect(caught).toBe(true); // back in the thrower's hand
    expect(a.spin).toBe(0); // and it never hits its own thrower
  });

  it("send a bomb after the racer one place ahead; its blast catches everyone near them", () => {
    const { t, items, a, b } = duel(30);
    const leader = new Kart(3, "C", 3, false), beside = new Kart(4, "D", 4, false);
    leader.placeOn(t, t.wrap(t.startIndex + 20 + Math.round(70 / SPACING)), 0);
    beside.placeOn(t, t.wrap(t.startIndex + 20 + Math.round(30 / SPACING)), 3); // right next to the target
    a.place = 3; b.place = 2; leader.place = 1; beside.place = 4;
    a.v = 20;
    const all = [a, b, leader, beside];
    items.grant(a, "bomb");
    a.aim = 0.6; // even thrown off to the side, it finds its target
    expect(items.press(a, all)).toBe(true); // the first press locks the arrow; the bomb rides behind
    expect(a.trailing).toBe(true);
    expect(items.bombs.length).toBe(0);
    expect(items.press(a, all)).toBe(true); // the second throws it
    expect(items.bombs[0].target).toBe(b);
    let booms = 0;
    const f = fieldOf([leader, b, beside, a]);
    for (let i = 0; i < 60 * 4; i++) {
      items.update(1 / 60, t, all, f);
      booms += items.events.filter((e) => e.kind === "boom").length;
      items.events = [];
    }
    expect(booms).toBe(1);
    expect(b.spin).toBeGreaterThan(0);
    expect(beside.spin).toBeGreaterThan(0); // 3 m away: inside the blast
    expect(leader.spin).toBe(0); // 40 m away: not
    expect(a.spin).toBe(0);
  });

  it("let the leader's bomb land where it was aimed and wait there, even for its thrower", () => {
    const { t, items, a, b } = duel(80);
    a.place = 1; b.place = 2;
    a.v = 20;
    items.grant(a, "bomb");
    a.aim = 0;
    items.press(a, [a, b]);
    items.press(a, [a, b]);
    expect(items.bombs[0].target).toBeNull();
    const f = fieldOf([b, a]);
    for (let i = 0; i < 60 * 2; i++) items.update(1 / 60, t, [a, b], f);
    const mine = items.bombs[0];
    expect(mine.landed).toBe(true); // sitting on the track ahead of where it was thrown
    expect(Math.hypot(mine.x - a.x, mine.y - a.y)).toBeGreaterThan(10);
    expect(b.spin).toBe(0); // nobody has come near it yet
    [a.x, a.y] = [mine.x + 1, mine.y]; // the thrower drives into its own bomb
    items.update(1 / 60, t, [a, b], f);
    expect(items.bombs.length).toBe(0);
    expect(a.spin).toBeGreaterThan(0);
    expect(Math.hypot(b.x - mine.x, b.y - mine.y)).toBeGreaterThan(BOMB_BLAST); // and b was far away
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
    const f = fieldOf([b, a]);
    for (let i = 0; i < 60 * 4 && items.orbs.length; i++) items.update(1 / 60, t, [a, b], f);
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

  it("shock everyone else: they spin, shrink and lose their items; a full-size kart flattens them", () => {
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
    b.spin = 0;
    [a.x, a.y] = [b.x - 1.4, b.y];
    const { spun } = collideKarts([a, b]);
    expect(spun).toEqual([[b, a]]); // the shrunk one is run over
    expect(a.spin).toBe(0);
  });

  it("block an orb from behind with an item held out as a shield", () => {
    const { t, items, a, b } = duel(30);
    items.grant(b, "oil");
    items.press(b, [a, b]); // held out behind: trailing
    expect(b.trailing).toBe(true);
    items.grant(a, "orb");
    items.use(a, [a, b]);
    expect(items.orbs[0].target).toBe(b);
    const f = fieldOf([b, a]);
    for (let i = 0; i < 60 * 4 && items.orbs.length; i++) items.update(1 / 60, t, [a, b], f);
    expect(b.spin).toBe(0); // the oil took the hit
    expect(b.item).toBeNull();
    expect(items.events.some((e) => e.kind === "blocked" && e.kart === b)).toBe(true);
  });

  it("slide a puck along the locked arrow, bouncing off the edge of the road, into the first kart", () => {
    const { t, items, a, b } = duel(30, 0);
    a.v = 20;
    items.grant(a, "puck");
    a.aim = 0.45; // off to the left: it hits the edge of the road and comes back across it
    items.press(a, [a, b]);
    expect(a.trailing).toBe(true); // locked, it rides behind as a shield
    items.press(a, [a, b]);
    expect(items.pucks.length).toBe(1);
    let bounces = 0;
    const f = fieldOf([b, a]);
    for (let i = 0; i < 60 * 3 && b.spin <= 0; i++) {
      items.update(1 / 60, t, [a, b], f);
      bounces += items.events.filter((e) => e.kind === "bounce").length;
      items.events = [];
      const p = items.pucks[0];
      if (p) expect(Math.abs(t.offset(p.x, p.y, p.idx))).toBeLessThan(HALF_WIDTH + 2.5);
    }
    expect(bounces).toBeGreaterThan(0);
    expect(a.spin).toBe(0);
  });

  it("take items out against each other: a puck and an orb, a puck and an oil slick", () => {
    const { t, items, a, b } = duel(40, 0);
    const f = fieldOf([b, a]);
    // b drops oil behind it; a's puck, thrown straight, runs into it
    items.grant(b, "oil");
    items.use(b, [a, b]);
    items.grant(a, "puck");
    a.aim = 0;
    items.press(a, [a, b]);
    items.press(a, [a, b]);
    for (let i = 0; i < 60 * 3 && items.pucks.length; i++) items.update(1 / 60, t, [a, b], f);
    expect(items.pucks.length).toBe(0);
    expect(items.slicks.length).toBe(0);
    expect(b.spin).toBe(0);
    // an orb of b's, sitting on the road 6 m ahead, meets a's puck head on
    items.events = [];
    items.grant(a, "puck");
    items.press(a, [a, b]);
    items.press(a, [a, b]);
    const ahead = t.wrap(a.idx + Math.round(6 / SPACING));
    items.orbs.push({ idx: ahead, carry: 0, x: t.xs[ahead], y: t.ys[ahead], offset: 0, v: 0, ttl: 5, owner: b, target: null });
    for (let i = 0; i < 30 && items.pucks.length + items.orbs.length; i++) items.update(1 / 60, t, [a, b], f);
    expect(items.pucks.length + items.orbs.length).toBe(0);
    expect(items.events.some((e) => e.kind === "clash")).toBe(true);
  });

  it("let a triple puck or orb circling a kart block a hit, one each", () => {
    const { t, items, a, b } = duel(30);
    items.grant(b, "puck3");
    items.grant(a, "orb");
    items.use(a, [a, b]);
    const f = fieldOf([b, a]);
    for (let i = 0; i < 60 * 4 && items.orbs.length; i++) items.update(1 / 60, t, [a, b], f);
    expect(b.spin).toBe(0);
    expect(b.uses).toBe(2); // one of the three took it
  });

  it("send a comet to the leader: it comes down on them, and its blast takes whoever is near", () => {
    const t = Track.fromPoints(calm());
    const items = new Items(new Rand(5));
    const back = new Kart(1, "A", 1, false), lead = new Kart(2, "B", 2, false), near = new Kart(3, "C", 3, false);
    const far = new Kart(4, "D", 4, false);
    back.placeOn(t, t.startIndex + 10, 0);
    lead.placeOn(t, t.wrap(t.startIndex + 10 + Math.round(200 / SPACING)), 0);
    near.placeOn(t, t.wrap(t.startIndex + 10 + Math.round(197 / SPACING)), 2);
    far.placeOn(t, t.wrap(t.startIndex + 10 + Math.round(100 / SPACING)), 0);
    const all = [back, lead, near, far];
    for (const k of all) k.updateProgress(t);
    const f = fieldOf([lead, near, far, back]);
    items.grant(back, "comet");
    items.use(back, all, f);
    expect(items.comets.length).toBe(1);
    expect(items.unavailable().has("comet")).toBe(true); // one at a time
    for (let i = 0; i < 60 * 6 && items.comets.length; i++) items.update(1 / 60, t, all, f);
    expect(items.comets.length).toBe(0);
    expect(lead.spin).toBeGreaterThan(1.5); // the leader takes the worst of it
    expect(near.spin).toBeGreaterThan(0); // 3 m away: inside the blast
    expect(far.spin).toBe(0); // passed on the way: untouched
    expect(Math.hypot(near.x - lead.x, near.y - lead.y)).toBeLessThan(COMET_BLAST);
  });

  it("knock a comet out of the air with a horn, and spin the karts close by", () => {
    const { t, items, a, b } = duel(5);
    const f = fieldOf([b, a]);
    items.grant(a, "comet");
    items.use(a, [a, b], f);
    for (let i = 0; i < 30; i++) items.update(1 / 60, t, [a, b], f); // on its way
    const c = items.comets[0];
    [c.x, c.y] = [b.x + 5, b.y]; // right over b
    items.grant(b, "horn");
    items.press(b, [a, b], f);
    expect(items.comets.length).toBe(0);
    expect(a.spin).toBeGreaterThan(0); // a was 5 m behind
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(HORN_R);
    expect(b.spin).toBe(0);
  });

  it("fill the screens of everyone ahead with static, and nobody's behind", () => {
    const { items, a, b } = duel(30);
    const c = new Kart(3, "C", 3, false);
    c.dist = a.dist - 20; // behind
    items.grant(a, "static");
    items.press(a, [a, b, c]);
    expect(b.staticT).toBe(STATIC_TIME);
    expect(c.staticT).toBe(0);
    expect(a.staticT).toBe(0);
  });

  it("put a grabber in front of the kart that bites karts and items, a boost with every bite", () => {
    const { t, items, a, b } = duel(3);
    const f = fieldOf([b, a]);
    items.grant(a, "grabber");
    items.press(a, [a, b], f);
    expect(a.grab).toBeGreaterThan(0);
    for (let i = 0; i < 40 && b.spin <= 0; i++) items.update(1 / 60, t, [a, b], f);
    expect(b.spin).toBeGreaterThan(0);
    expect(a.boostTime).toBeGreaterThan(0);
    expect(items.events.some((e) => e.kind === "bite")).toBe(true);
  });

  it("set a jackpot's eight circling, then use them one press at a time", () => {
    const { items, a, b } = duel(30);
    items.grant(a, "jackpot");
    items.press(a, [a, b]);
    expect(a.jackpot).toEqual(JACKPOT);
    const used: number[] = [];
    for (let k = 0; k < 8; k++) {
      a.itemAge = 5;
      expect(items.press(a, [a, b])).toBe(true);
      used.push(a.jackpot.length);
    }
    expect(used).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(a.item).toBeNull();
    expect(items.slicks.length + items.bombs.length + items.pucks.length + items.orbs.length).toBe(4);
    expect(a.prism).toBeGreaterThan(0); // the last of the eight
  });

  it("give coins that add top speed, up to ten, and lose three of them in a spin", () => {
    const { items, a, b } = duel(30);
    const cls = CLASSES.pro, before = a.topSpeed(cls);
    items.grant(a, "coin");
    items.press(a, [a, b]);
    expect(a.coins).toBe(2);
    a.coins = 12;
    for (let k = 0; k < 2; k++) {
      items.grant(a, "coin");
      items.press(a, [a, b]);
    }
    expect(a.coins).toBe(10);
    expect(a.topSpeed(cls)).toBeCloseTo(before * (1 + 10 * COIN_SPEED), 9);
    a.spinOut();
    expect(a.coins).toBe(7);
  });

  it("make a phantom untouchable and steal it the item of a kart ahead", () => {
    const { t, items, a, b } = duel(30);
    const f = fieldOf([b, a]);
    items.grant(b, "prism");
    items.grant(a, "phantom");
    items.press(a, [a, b], f);
    expect(a.phantom).toBeGreaterThan(0);
    expect(b.item).toBeNull(); // taken
    expect(a.item).toBeNull();
    for (let i = 0; i < 70; i++) items.update(1 / 60, t, [a, b], f);
    expect(a.item).toBe("prism"); // arrived
    expect(a.spinOut()).toBe(false); // nothing touches a phantom
    b.x = a.x + 0.5;
    b.y = a.y;
    expect(collideKarts([a, b]).hits.length).toBe(0); // karts pass through it
  });

  it("boost on every press of a gold turbo until it runs out, then it is gone", () => {
    const { t, items, a, b } = duel(30);
    const f = fieldOf([b, a]);
    items.grant(a, "gold");
    let boosts = 0;
    for (let i = 0; i < 60 * (GOLD_TIME + 1); i++) {
      if (i % 30 === 0 && a.item === "gold") {
        a.boostTime = 0;
        items.press(a, [a, b], f);
        if (a.boostTime > 0) boosts++;
      }
      items.update(1 / 60, t, [a, b], f);
    }
    expect(boosts).toBeGreaterThanOrEqual(14);
    expect(a.item).toBeNull();
  });

  it("throw a fireball on every press while flares last, and they spin the kart they hit", () => {
    const { t, items, a, b } = duel(14);
    const f = fieldOf([b, a]);
    a.v = 15;
    items.grant(a, "flares");
    items.press(a, [a, b], f);
    expect(items.pucks.filter((p) => p.kind === "flare").length).toBe(1);
    expect(items.press(a, [a, b], f)).toBe(false); // not again so soon
    for (let i = 0; i < 60 * 2 && b.spin <= 0; i++) items.update(1 / 60, t, [a, b], f);
    expect(b.spin).toBeGreaterThan(0);
    expect(a.item).toBe("flares"); // still burning
  });

  it("turn the last kart into a rocket that flies itself up the road, past two karts at most", async () => {
    const race = new Race({ rivals: 7, difficulty: "pro", theme: THEMES[0], seed: 5, replay: twisty() }, null, () => {});
    await race.prepare();
    const coast = { steer: 0, throttle: 1, brake: 0, drift: false };
    const stay = { steer: 0, throttle: 0, brake: 0, drift: false };
    for (let i = 0; i < 60 * 9; i++) race.update(1 / 60, i < 60 * 3 ? coast : stay); // the pack drives off
    const p = race.player;
    expect(p.place).toBe(8);
    race.items.grant(p, "rocket");
    const start = p.dist, from = p.place;
    race.update(1 / 60, { ...stay, item: true });
    expect(p.rocket).toBeGreaterThan(0);
    let over = false, worst = 0, best = from, flown = 0;
    for (let i = 0; i < 60 * 7; i++) {
      const flying = p.rocket > 0;
      race.update(1 / 60, { steer: flying ? 1 : 0, throttle: 1, brake: 0, drift: false }); // the wheel is ignored
      if (flying) {
        worst = Math.max(worst, Math.abs(p.offset));
        best = Math.min(best, p.place);
        flown += 1 / 60;
      }
      over ||= race.events.some((e) => e.kind === "rocketOver");
      race.events = [];
    }
    expect(over).toBe(true);
    expect(p.spin).toBe(0);
    expect(worst).toBeLessThan(HALF_WIDTH); // it stays on the road
    expect(flown).toBeLessThanOrEqual(ROCKET_TIME + 0.05);
    expect(from - best).toBeLessThanOrEqual(2); // two karts passed at most
    expect(best).toBeGreaterThan(1); // never into the lead
    expect(p.dist - start).toBeGreaterThan(CLASSES.pro.vmax * flown * 1.1); // faster than driving while it lasts
  });

  it("are all used by rivals in a race", async () => {
    // seven rivals at a time, each handed a different item, in a race of their own (the shock,
    // which knocks every item out of every hand, in a round of its own)
    const kinds = ITEM_KINDS.filter((k) => k !== "rocket" && k !== "shock");
    const rounds = [kinds.slice(0, 7), kinds.slice(7, 14), kinds.slice(14), ["shock"]];
    const used = new Set<string>();
    for (const [n, round] of rounds.entries()) {
      const race = new Race({ rivals: 7, difficulty: "legend", theme: THEMES[0], seed: 8 + n, replay: twisty() }, null, () => {});
      await race.prepare();
      race.phase = "racing";
      const pilot = new RivalDriver(new Rand(3), race.player, 0);
      const use = race.items.use.bind(race.items);
      race.items.use = (k, karts, field) => {
        const item = k.item;
        const ok = use(k, karts, field);
        if (ok && item && !k.isPlayer) used.add(item);
        return ok;
      };
      for (let i = 0; i < 60 * 4; i++) race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, race.player, race.karts));
      race.karts.filter((k) => !k.isPlayer).forEach((k, i) => { if (i < round.length) race.items.grant(k, round[i] as never); });
      for (let i = 0; i < 60 * 14; i++) {
        race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, race.player, race.karts, race.items));
        race.events = [];
      }
    }
    expect([...kinds, "shock"].filter((k) => !used.has(k))).toEqual([]);
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
    const back = stickControls(-0.6, 0.62, false); // pulled back on a diagonal: reverse, steering
    expect(back.brake).toBe(1);
    expect(back.steer).toBeGreaterThan(0.3);
    expect(stickControls(0.92, 0.5, false).brake).toBe(0); // a hard turn with the thumb low is not a brake
  });
});

describe("aiming", () => {
  it("sweeps the arrow while an aimed item is ready, stops it on the first press, throws on the second", async () => {
    const race = new Race({ rivals: 3, difficulty: "pro", theme: THEMES[0], seed: 6, replay: twisty() }, null, () => {});
    await race.prepare();
    const coast = { steer: 0, throttle: 1, brake: 0, drift: false };
    for (let i = 0; i < 60 * 5; i++) race.update(1 / 60, coast);
    race.items.grant(race.player, "boomerang");
    const aims: number[] = [];
    for (let i = 0; i < 120; i++) {
      race.update(1 / 60, coast);
      aims.push(race.player.aim);
    }
    expect(Math.max(...aims) - Math.min(...aims)).toBeGreaterThan(1); // it really sweeps
    for (const a of aims) expect(Math.abs(a)).toBeLessThanOrEqual(AIM_MAX + 1e-9);
    const p = race.player;
    race.update(1 / 60, { ...coast, item: true }); // press: locked
    const locked = p.aimLocked!;
    expect(locked).not.toBeNull();
    for (let i = 0; i < 40; i++) race.update(1 / 60, coast); // let go and wait: it stays put
    expect(p.aimLocked).toBe(locked);
    expect(race.items.boomerangs.length).toBe(0);
    race.update(1 / 60, { ...coast, item: true }); // press again: thrown
    const b = race.items.boomerangs[0];
    const off = Math.atan2(b.vy, b.vx) - (p.heading + locked);
    expect(Math.abs(Math.atan2(Math.sin(off), Math.cos(off)))).toBeLessThan(1e-6); // along the locked arrow
  });
});

describe("the grand prix", () => {
  const e = (id: number, isPlayer = false): Entrant => ({ id, name: `K${id}`, livery: id, build: DEFAULT_BUILD, isPlayer });

  it("pays points by place, ranks by points then total time, and ends after every world", () => {
    expect(POINTS.slice(0, 4)).toEqual([15, 12, 10, 8]);
    const cup = new Cup(THEMES.slice(0, 3), 1);
    const [a, b, c] = [e(0, true), e(1), e(2)];
    cup.award([{ entrant: a, time: 100 }, { entrant: b, time: 101 }, { entrant: c, time: 102 }]);
    expect([cup.points.get(0), cup.points.get(1), cup.points.get(2)]).toEqual([15, 12, 10]);
    // a and b tie on 27; b has the lower total time (200 s against 203 s)
    const rows = cup.award([{ entrant: b, time: 99 }, { entrant: a, time: 103 }, { entrant: c, time: 104 }]);
    expect(rows.map((r) => r.entrant.id)).toEqual([1, 0, 2]);
    expect([rows[0].gained, rows[0].before, rows[0].points, rows[0].rankBefore]).toEqual([15, 12, 27, 2]);
    expect(cup.done).toBe(false);
    cup.award([{ entrant: c, time: 90 }, { entrant: a, time: 95 }, { entrant: b, time: 99 }]);
    expect(cup.done).toBe(true);
    expect(cup.podium().map((x) => x.id)).toEqual([0, 1, 2]); // 39, 37, 35
  });

  it("runs through every world, the reef, the mountains, the volcano, the building site and the moon too", () => {
    const ids = THEMES.map((t) => t.id);
    expect(ids).toEqual(["valley", "neon", "mesa", "reef", "mountain", "volcano", "construction", "moon"]);
    expect(THEMES.find((t) => t.id === "reef")!.underwater).toBe(true);
    expect(THEMES.find((t) => t.id === "volcano")!.volcano).toBe(true);
    expect(THEMES.find((t) => t.id === "moon")!.gravity).toBeLessThan(0.5);
  });
});

describe("the mountains", () => {
  const mountain = THEMES.find((t) => t.mountain)!;

  it("climb over hills, gently, and the whole field races them to the finish", async () => {
    const race = new Race({ rivals: 5, difficulty: "pro", theme: mountain, seed: 3, replay: twisty() }, null, () => {});
    await race.prepare();
    const t = race.track;
    expect(t.hills.length).toBeGreaterThan(0);
    expect(Math.max(...t.elev)).toBeGreaterThan(3);
    let steepest = 0;
    for (let i = 1; i < t.count; i++) {
      steepest = Math.max(steepest, Math.abs(t.elev[i] - t.elev[i - 1]) / Math.max(1e-6, t.s[i] - t.s[i - 1]));
    }
    expect(steepest).toBeLessThan(0.23); // a mountain road: never steeper than about 22%
    const pilot = new RivalDriver(new Rand(2), race.player, 0);
    let climbing = 0;
    for (let i = 0; i < 60 * 240 && race.phase !== "done"; i++) {
      race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, race.player, race.karts));
      race.events = [];
      if (race.player.elev > 2) climbing++;
      for (const k of race.karts) expect(Number.isFinite(k.x) && Number.isFinite(k.elev)).toBe(true);
    }
    expect(race.player.finished).toBe(true);
    expect(climbing).toBeGreaterThan(60); // the player really drove over them
  });

  it("keep their climbs clear of a figure-eight's bridge and the road under it", async () => {
    for (const seed of [4, 5, 6]) {
      const race = new Race({ rivals: 3, difficulty: "pro", theme: mountain, seed, replay: figure8() }, null, () => {});
      await race.prepare();
      const t = race.track;
      expect(t.bridges.length).toBe(1);
      const b = t.bridges[0], under = t.s[b.lower];
      for (const h of t.hills) {
        for (const [c, clear] of [[b.centerS, 95], [under, 80]]) expect(h.s0 > c + clear || h.s0 + h.len < c - clear).toBe(true);
      }
      expect(t.elev[b.lower]).toBe(0); // the road under the bridge is on the ground
    }
  });

  it("bore tunnels on straights, whose walls keep a kart on the road", () => {
    const t = Track.fromPoints(calm());
    const f = new Features(true);
    f.onCommit(t, 0, t.count, () => false, () => 0.5);
    expect(f.tunnels.length).toBeGreaterThan(0);
    expect(new Features(false).tunnels.length).toBe(0);
    const tn = f.tunnels[0];
    const k = new Kart(1, "K", 1, false);
    k.placeOn(t, t.wrap(tn.start + 10), HALF_WIDTH - 0.5);
    k.heading += 0.6; // aimed at the wall
    k.v = 22;
    for (let i = 0; i < 40; i++) {
      k.walled = f.inTunnel(t, k);
      k.update(1 / 60, { steer: 0, throttle: 1, brake: 0, drift: false }, t, CLASSES.pro);
      if (f.tunnelAt(t.s[k.idx])) expect(Math.abs(k.offset)).toBeLessThanOrEqual(HALF_WIDTH + 0.05);
    }
    expect(TUNNEL_LEN).toBeGreaterThan(40);
  });
});

describe("the soundtrack", () => {
  it("has a song of its own for every world, every bar of it whole", async () => {
    const { SONGS, chord, midi } = await import("../src/game/core/music");
    for (const t of THEMES) expect(SONGS[t.id], t.id).toBeDefined();
    for (const [name, song] of Object.entries(SONGS)) {
      for (const bar of song.lead) {
        const toks = bar.split(/\s+/);
        expect(toks.length, `${name}: ${bar}`).toBe(16);
        for (const tok of toks) if (tok !== "-" && tok !== ".") expect(() => midi(tok), `${name}: ${tok}`).not.toThrow();
      }
      for (const c of song.chords) expect(chord(c).length).toBeGreaterThanOrEqual(3);
      for (const d of Object.values(song.drums)) expect(d.length).toBe(16);
    }
    expect(new Set(THEMES.map((t) => SONGS[t.id].lead.join("|"))).size).toBe(THEMES.length);
  });

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

describe("reversing", () => {
  const still = (lateral = 0) => {
    const t = Track.fromPoints(calm());
    const k = new Kart(0, "P", 0, true);
    k.placeOn(t, t.startIndex + 60, lateral);
    return { t, k };
  };

  it("backs the kart up while the brake is held, even with the gas down too", () => {
    const { t, k } = still();
    for (let i = 0; i < 90; i++) k.update(1 / 60, { steer: 0, throttle: 1, brake: 1, drift: false }, t, CLASSES.pro);
    expect(k.v).toBeLessThan(-REVERSE_SPEED * 0.9);
    expect(k.v).toBeGreaterThanOrEqual(-REVERSE_SPEED - 1e-9);
    for (let i = 0; i < 30; i++) k.update(1 / 60, { steer: 0, throttle: 1, brake: 0, drift: false }, t, CLASSES.pro);
    expect(k.v).toBeGreaterThan(0); // and the gas takes it straight out of reverse
  });

  it("backs out of the grass too", () => {
    const { t, k } = still(HALF_WIDTH + 6);
    const x0 = k.x, y0 = k.y;
    for (let i = 0; i < 120; i++) k.update(1 / 60, { steer: 0, throttle: 0, brake: 1, drift: false }, t, CLASSES.pro);
    expect(k.surface).toBe("grass");
    expect(k.v).toBeLessThan(-3);
    expect(Math.hypot(k.x - x0, k.y - y0)).toBeGreaterThan(4);
  });
});

describe("track types", () => {
  it("each have their own id, a short name, and a promise that fits the setup screens", () => {
    expect(new Set(TRACK_TYPES.map((t) => t.id)).size).toBe(TRACK_TYPES.length);
    for (const t of TRACK_TYPES) {
      expect(t.name.length).toBeLessThanOrEqual(14);
      expect(t.promise.length).toBeLessThanOrEqual(64);
      for (let arc = 0; arc < 8; arc++) {
        const s = t.style(arc, 0.5);
        expect(s >= 0 && s <= 1).toBe(true);
      }
    }
    expect(trackType("figure8").layout).toBe("figure8");
    expect(trackType("stunt").layout).toBe("figure8");
    expect(trackType(undefined).id).toBe("classic");
  });

  it("are all raced once in a grand prix of surprises before any comes back", () => {
    const rng = new Rand(9);
    const seen: TrackTypeId[] = [];
    for (let i = 0; i < TRACK_TYPES.length; i++) seen.push(surpriseType(rng, seen));
    expect(new Set(seen).size).toBe(TRACK_TYPES.length);
  });

  it("measure the style of new road the way the designer was trained to read it", () => {
    // each arc of the reference circuits, as src/dreamcircuit/trackgen/train.py measures it
    const python: Record<string, number[]> = {
      twisty: [0.62, 0.45, 0.75, 1.0, 0.15, 0.8], calm: [0.31, 0.27, 0.45, 0.21, 0.48, 0.14],
      figure8: [0.53, 0.33, 0.6, 0, 0, 1],
    };
    for (const [name, pts] of [["twisty", twisty()], ["calm", calm()], ["figure8", figure8()]] as const) {
      liveArcs().slice(1).forEach((arc, i) => {
        expect(Math.abs(arcStyle(pts, new Set(arc)) - python[name][i])).toBeLessThan(0.06);
      });
    }
    expect(bandMiss(0.3, CALM_BAND)).toBe(0);
    expect(bandMiss(0.5, WILD_BAND)).toBeCloseTo(0.1, 9);
  });

  it("dream an arc again when it misses its style band, then keep the closest drivable one", async () => {
    let calls = 0;
    const d = fakeDesigner(() => false); // always the calm circuit, which is never wild
    const spy: Designer = { sample: (req) => { calls++; return d.sample(req); } };
    const live = new LiveCircuit(spy, new Rand(7));
    live.bandSource = (arc) => (arc === 0 ? null : WILD_BAND);
    await live.start();
    await driveLap(live);
    const arcs = liveArcs().length;
    expect(live.track.locked).toBe(true);
    expect(live.stats.offBand).toBe(arcs - 1);
    expect(live.stats.fallbacks).toBe(0);
    expect(calls).toBe(1 + (arcs - 1) * 4); // every arc after the first dreamed four times
    expect(live.styles.length).toBe(arcs);
  });

  it("keep an arc at once when it lands in its band", async () => {
    let calls = 0;
    const d = fakeDesigner(() => false);
    const spy: Designer = { sample: (req) => { calls++; return d.sample(req); } };
    const live = new LiveCircuit(spy, new Rand(8));
    live.bandSource = () => ({ lo: 0, hi: 0.6 });
    await live.start();
    await driveLap(live);
    expect(calls).toBe(liveArcs().length);
    expect(live.stats.offBand).toBe(0);
  });
});

describe("what a track type confirms", () => {
  const raced = (type: TrackTypeId, pts: Float64Array, seed = 3, theme = THEMES[0]) =>
    new Race({ rivals: 3, difficulty: "pro", theme, seed, replay: pts, trackType: type }, null, () => {});

  it("climbs and drops on a roller coaster, in any world, clear of the grid and the line", () => {
    for (const [pts, seed] of [[calm(), 1], [twisty(), 2], [figure8(), 3]] as const) {
      const r = raced("coaster", pts, seed);
      const t = r.track;
      expect(t.hills.length).toBeGreaterThanOrEqual(4);
      const s0 = t.s[t.startIndex];
      for (const h of t.hills) {
        expect(h.s0 - s0).toBeGreaterThan(40);
        expect(h.s0 + h.len - s0).toBeLessThan(t.length - 80);
      }
      const sorted = [...t.hills].sort((a, b) => a.s0 - b.s0);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].s0).toBeGreaterThanOrEqual(sorted[i - 1].s0 + sorted[i - 1].len);
    }
    // elsewhere a circuit climbs only as its world does: the valley rolls over its meadows, and a
    // world without climbs of its own stays flat
    const valley = raced("classic", calm()).track.hills;
    expect(valley.length).toBeGreaterThan(0);
    expect(valley.every((h) => h.style === "meadow")).toBe(true);
    expect(raced("classic", calm(), 3, { ...THEMES[0], hills: undefined }).track.hills.length).toBe(0);
  });

  it("jumps and pads on the straights of a speedway", () => {
    for (const [pts, seed] of [[calm(), 4], [twisty(), 5]] as const) {
      const r = raced("speedway", pts, seed);
      expect(r.features.ramps.length).toBeGreaterThanOrEqual(2);
      expect(r.features.pads.length).toBeGreaterThanOrEqual(3);
      for (const ramp of r.features.ramps) {
        // a jump's flight bends gently and never starts under a bridge or on raised road
        for (let j = ramp.start; j < ramp.start + Math.round(45 / SPACING); j += 3) {
          expect(Math.abs(r.track.curvature(j))).toBeLessThan(1 / 85);
          expect(r.track.elev[j]).toBe(0);
        }
      }
    }
  });

  it("a bridge and three jumps in a stunt park, kept away from the bridge", () => {
    const r = raced("stunt", figure8(), 6);
    expect(r.track.bridges.length).toBe(1);
    expect(r.features.ramps.length).toBeGreaterThanOrEqual(3);
    const b = r.track.bridges[0];
    for (const ramp of r.features.ramps) {
      expect(Math.abs(ramp.s0 - b.centerS)).toBeGreaterThan(60);
      expect(Math.abs(ramp.s0 - r.track.s[b.lower])).toBeGreaterThan(60);
    }
  });

  it("pads out of the corners of a technical track", () => {
    const r = raced("technical", twisty(), 7);
    expect(r.features.pads.length).toBeGreaterThanOrEqual(4);
  });

  it("builds what it confirms when the lap locks only where no kart is", async () => {
    const race = new Race({ rivals: 5, difficulty: "pro", theme: THEMES[0], seed: 9, replay: null, trackType: "coaster" },
                          fakeDesigner(() => false), () => {});
    await race.prepare();
    const pilot = new RivalDriver(new Rand(3), race.player, 0);
    let hills = 0;
    for (let i = 0; i < 60 * 120 && !race.track.locked; i++) {
      hills = race.track.hills.length;
      race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, race.player, race.karts));
      race.events = [];
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
    expect(race.track.locked).toBe(true);
    const t = race.track;
    expect(t.hills.length).toBeGreaterThanOrEqual(4);
    // the climbs added at the lock: none under a kart or just ahead of one
    for (const h of t.hills.slice(hills)) {
      for (const k of race.karts) {
        const d = (((t.s[k.idx] - h.s0) % t.length) + t.length) % t.length; // m the kart is past the foot
        expect(d > h.len + 20 && d < t.length - 60).toBe(true);
      }
    }
  });
});

describe("the lie of the land", () => {
  it("gives every world climbs of its own: meadows, a neon skyway, mesas and dunes, coral, basalt", { timeout: 60000 }, async () => {
    const want: Record<string, string[]> = {
      valley: ["meadow"], neon: ["skyway", "wave"], mesa: ["dune", "mesa"], reef: ["coral"], volcano: ["basalt"],
    };
    for (const [id, styles] of Object.entries(want)) {
      const seen = new Set<string>();
      for (const seed of [3, 4]) {
        const race = new Race({ rivals: 0, difficulty: "pro", theme: THEMES.find((t) => t.id === id)!, seed, replay: calm() },
                              null, () => {});
        await race.prepare();
        for (const h of race.track.hills) seen.add(h.style!);
      }
      expect([...seen].sort(), id).toEqual(styles);
    }
  });

  it("leaves the jumps their straights: climbs go elsewhere, never over a jump or where it lands", async () => {
    for (const id of ["valley", "neon", "mesa", "reef", "volcano"]) {
      const theme = THEMES.find((t) => t.id === id)!;
      for (const pts of [calm, twisty]) {
        const hilly = new Race({ rivals: 0, difficulty: "pro", theme, seed: 3, replay: pts() }, null, () => {});
        const flat = new Race({ rivals: 0, difficulty: "pro", theme: { ...theme, hills: undefined }, seed: 3, replay: pts() },
                              null, () => {});
        await hilly.prepare();
        await flat.prepare();
        expect(hilly.track.hills.length, id).toBeGreaterThan(0);
        expect(hilly.features.ramps.length, id).toBe(flat.features.ramps.length);
        for (const r of hilly.features.ramps) {
          for (const h of hilly.track.hills) expect(r.s0 + 45 < h.s0 || r.s0 > h.s0 + h.len, id).toBe(true);
        }
      }
    }
  });

  it("sets out landforms beyond the fence, with nothing growing inside them", { timeout: 60000 }, async () => {
    const { LANDFORM_CLEAR, onLandform, reach } = await import("../src/game/world/landforms");
    for (const theme of THEMES) {
      const race = new Race({ rivals: 0, difficulty: "pro", theme, seed: 5, replay: twisty() }, null, () => {});
      await race.prepare();
      const t = race.track, forms = race.scenery.landforms;
      expect(forms.length, theme.id).toBeGreaterThan(5);
      for (const l of forms) {
        expect(theme.landforms).toContain(l.kind);
        let near = Infinity;
        for (let i = 0; i < t.count; i += 3) near = Math.min(near, Math.hypot(t.xs[i] - l.x, t.ys[i] - l.y));
        expect(near - reach(l), theme.id).toBeGreaterThanOrEqual(LANDFORM_CLEAR - 0.5);
        expect(race.scenery.items.some((it) => onLandform(l, it.x, it.y))).toBe(false);
      }
    }
  });

  it("shades the ground as if it rose and fell, where the world says so", async () => {
    const { WorldTexture } = await import("../src/game/world/texture");
    const valley = THEMES[0];
    const rolling = new WorldTexture(valley, 3).levels[0], flat = new WorldTexture({ ...valley, relief: 0 }, 3).levels[0];
    let lighter = 0, darker = 0;
    const { channels } = await import("../src/game/core/gfx");
    for (let i = 0; i < rolling.length; i += 997) {
      const a = channels(rolling[i])[1], b = channels(flat[i])[1];
      if (a > b * 1.12) lighter++;
      if (a < b * 0.88) darker++;
    }
    expect(lighter).toBeGreaterThan(200); // slopes to the sun
    expect(darker).toBeGreaterThan(200); // and away from it
  });
});

describe("the mountain pass, driven on", () => {
  const mountain = THEMES.find((t) => t.id === "mountain")!;

  it("builds its climbs as rocky mountainsides and as ledges along cliffs", async () => {
    const styles = new Set<string>();
    for (const seed of [3, 4, 5, 6]) {
      const race = new Race({ rivals: 0, difficulty: "pro", theme: mountain, seed, replay: twisty() }, null, () => {});
      await race.prepare();
      for (const h of race.track.hills) {
        styles.add(h.style!);
        if (h.style === "cliff") {
          expect(h.shape).toBe("plateau"); // a level ledge, cut into the rock
          expect([1, -1]).toContain(h.side);
        }
      }
    }
    expect([...styles].sort()).toEqual(["cliff", "rock"]);
  });
});

describe("the construction zone", () => {
  const site = THEMES.find((t) => t.id === "construction")!;
  const middle = (t: Track, h: { s0: number; len: number }) => t.s.findIndex((s) => s >= h.s0 + h.len / 2);

  it("builds its climbs as foundations, scaffolds and girders, a tower crane by every girder", async () => {
    const styles = new Set<string>();
    let girders = 0, cranes = 0;
    for (const seed of [3, 4, 5, 6]) {
      const race = new Race({ rivals: 0, difficulty: "pro", theme: site, seed, replay: twisty() }, null, () => {});
      await race.prepare();
      const t = race.track;
      for (const h of t.hills) {
        styles.add(h.style!);
        expect(h.shape).toBe("plateau");
        if (h.style !== "girder") continue;
        girders++;
        expect(h.h).toBeGreaterThan(6); // high up on the crane's arm
        const i = middle(t, h);
        const by = race.scenery.items.some((it) => Math.abs(Math.hypot(it.x - t.xs[i], it.y - t.ys[i]) - (HALF_WIDTH + 5)) < 0.01);
        if (by) cranes++;
      }
    }
    expect([...styles].sort()).toEqual(["foundation", "girder", "scaffold"]);
    expect(girders).toBeGreaterThan(0);
    expect(cranes).toBe(girders);
  });

  it("runs its tunnels through the steel frames of buildings", async () => {
    let tunnels = 0;
    for (const seed of [3, 4]) {
      const race = new Race({ rivals: 0, difficulty: "pro", theme: site, seed, replay: calm() }, null, () => {});
      await race.prepare();
      tunnels += race.features.tunnels.length;
    }
    expect(site.tunnels).toBe("frame");
    expect(tunnels).toBeGreaterThan(0);
  });

  it("is raced to the finish up on the structures, nobody falling through or off them", async () => {
    const race = new Race({ rivals: 5, difficulty: "pro", theme: site, seed: 3, replay: twisty() }, null, () => {});
    await race.prepare();
    const pilot = new RivalDriver(new Rand(2), race.player, 0);
    let up = 0;
    for (let i = 0; i < 60 * 240 && race.phase !== "done"; i++) {
      race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, race.player, race.karts));
      race.events = [];
      if (race.player.elev > 1.5) up++;
      for (const k of race.karts) {
        expect(Number.isFinite(k.x) && Number.isFinite(k.elev)).toBe(true);
        if (!k.air && !k.falling) expect(k.elev).toBeGreaterThan(k.ground - 0.05);
        if (!k.air && k.ground > 0.8) expect(Math.abs(k.offset)).toBeLessThanOrEqual(HALF_WIDTH - 0.69);
      }
    }
    expect(race.player.finished).toBe(true);
    expect(up).toBeGreaterThan(120); // the player really drove up on them
  });
});

describe("the moon", () => {
  const moon = THEMES.find((t) => t.id === "moon")!;
  /** Frames the player spends floating off a crater's rim (a crest, not a ramp) in a race. */
  const floating = async (theme: typeof moon) => {
    const race = new Race({ rivals: 0, difficulty: "pro", theme, seed: 3, replay: twisty() }, null, () => {});
    await race.prepare();
    const p = race.player, pilot = new RivalDriver(new Rand(2), p, 0);
    let frames = 0, launches = 0, crest = false;
    for (let i = 0; i < 60 * 240 && race.phase !== "done"; i++) {
      const was = p.air;
      race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, p, race.karts));
      race.events = [];
      if (!was && p.air) {
        crest = p.rampU < 0;
        if (crest) launches++;
      }
      if (p.air && crest) frames++;
      expect(Number.isFinite(p.elev)).toBe(true);
    }
    return { frames, launches, finished: p.finished, gravity: p.gravity, craters: race.track.hills.length };
  };

  it("has low gravity: karts float off the tops of crater rims, and still finish", async () => {
    const low = await floating(moon);
    const earth = await floating({ ...moon, gravity: 1 });
    expect(low.gravity).toBeCloseTo(26 * 0.3, 5);
    expect(low.craters).toBeGreaterThan(3);
    expect(low.launches).toBeGreaterThan(2);
    expect(low.frames).toBeGreaterThan(Math.max(30, 4 * earth.frames)); // the same rims, hardly a hop at home
    expect(low.finished).toBe(true);
  });

  it("puts every driver in a helmet", () => {
    expect(moon.helmets).toBe(true);
  });
});

describe("drawing the worlds", () => {
  const scene = async () => {
    const { makeCamera } = await import("../src/game/render/mode7");
    const gfx = await import("../src/game/core/gfx");
    const cam = makeCamera();
    const scr = { buf: new Uint32Array(gfx.W * gfx.H) } as unknown as import("../src/game/core/gfx").Screen;
    const faces: { z: number; draw: () => void }[] = [];
    return { cam, scr, faces, painter: { cam, scr, fog: gfx.hex("#000000"), faces } };
  };
  const look = (cam: { x: number; y: number; heading: number }, t: Track, i: number) => {
    const [tx, ty] = t.tangent(i);
    cam.x = t.xs[i] - tx * 6;
    cam.y = t.ys[i] - ty * 6;
    cam.heading = Math.atan2(ty, tx);
  };

  it("builds every style of climb out of faces, and draws them", async () => {
    const { hillFaces } = await import("../src/game/render/structures");
    for (const style of ["earth", "rock", "cliff", "foundation", "girder", "scaffold", "crater", "meadow", "skyway", "wave",
                         "mesa", "dune", "coral", "basalt"] as const) {
      const t = Track.fromPoints(calm());
      const plateau = ["cliff", "foundation", "girder", "scaffold", "skyway", "mesa", "basalt"].includes(style);
      t.addHill({ s0: 200, len: 160, h: 6, shape: plateau ? "plateau" : "sine", style, side: 1 });
      const { cam, scr, faces, painter } = await scene();
      look(cam, t, t.s.findIndex((s) => s >= 215));
      hillFaces(painter, t, THEMES[0]);
      expect(faces.length, style).toBeGreaterThan(40);
      for (const f of faces) f.draw();
      expect(scr.buf.some((c) => c !== 0), style).toBe(true);
    }
  });

  it("builds every kind of landform out of lit faces", async () => {
    const { landformFaces } = await import("../src/game/render/landforms");
    const { LANDFORM_SIZE } = await import("../src/game/world/landforms");
    for (const kind of Object.keys(LANDFORM_SIZE) as (keyof typeof LANDFORM_SIZE)[]) {
      const { cam, scr, faces, painter } = await scene();
      cam.x = 0; cam.y = -80; cam.heading = Math.PI / 2; // looking north at it
      const theme = THEMES.find((t) => t.landforms?.includes(kind))!;
      landformFaces(painter, [{ kind, x: 0, y: 0, r: 20, stretch: 1.3, rot: 0.4, h: 12, seed: 7 }], theme);
      expect(faces.length, kind).toBeGreaterThan(4);
      for (const f of faces) f.draw();
      expect(scr.buf.some((c) => c !== 0), kind).toBe(true);
      const { faces: behind, painter: back } = await scene();
      back.cam.x = 0; back.cam.y = -80; back.cam.heading = -Math.PI / 2; // looking away: nothing
      landformFaces(back, [{ kind, x: 0, y: 0, r: 20, stretch: 1.3, rot: 0.4, h: 12, seed: 7 }], theme);
      expect(behind.length, kind).toBe(0);
    }
  });

  it("builds a tunnel through rock, or through a building's steel frame", async () => {
    const { tunnelFaces } = await import("../src/game/render/structures");
    const t = Track.fromPoints(calm());
    const f = new Features(true);
    f.onCommit(t, 0, t.count, () => false, () => 0.5);
    const counts: number[] = [];
    for (const theme of [THEMES.find((x) => x.id === "mountain")!, THEMES.find((x) => x.id === "construction")!]) {
      const { cam, faces, painter } = await scene();
      look(cam, t, f.tunnels[0].start);
      tunnelFaces(painter, t, f, theme);
      for (const face of faces) face.draw();
      counts.push(faces.length);
    }
    expect(counts[0]).toBeGreaterThan(20);
    expect(counts[1]).toBeGreaterThan(counts[0]); // columns, slabs and glass: more parts than rock
  });

  it("paints a city of towers and tower cranes behind the building site, and the Earth in the moon's sky", async () => {
    const { Sky } = await import("../src/game/render/sky");
    const { channels } = await import("../src/game/core/gfx");
    const sees = async (id: string, test: (r: number, g: number, b: number) => boolean) => {
      const sky = new Sky(THEMES.find((x) => x.id === id)!, 74, 5);
      const { scr } = await scene();
      for (let k = 0; k < 24; k++) {
        sky.draw(scr, (k * Math.PI) / 12);
        if (scr.buf.some((c) => test(...channels(c)))) return true;
      }
      return false;
    };
    const crane = (r: number, g: number, b: number) => r > 180 && g > 120 && b < 90;
    const sea = (r: number, _g: number, b: number) => b > 110 && b > r + 60;
    expect(await sees("construction", crane)).toBe(true);
    expect(await sees("moon", sea)).toBe(true);
    expect(await sees("moon", crane)).toBe(false);
  });
});

describe("the volcano", () => {
  const volcano = THEMES.find((t) => t.volcano)!;
  const none = { steer: 0, throttle: 0, brake: 0, drift: false };
  const racing = async (seed = 3, rivals = 0) => {
    const race = new Race({ rivals, difficulty: "pro", theme: volcano, seed, replay: calm() }, null, () => {});
    await race.prepare();
    race.phase = "racing";
    return race;
  };

  it("is a lake of lava, with the road on a bank of rock", async () => {
    const race = await racing();
    const t = race.track, tex = race.tex;
    let road = 0, bank = 0, lava = 0, n = 0;
    for (let i = 0; i < t.count; i += 37) {
      if (t.elev[i] > 0.25) continue;
      const [tx, ty] = t.tangent(i);
      for (const side of [1, -1]) {
        const at = (off: number) => tex.lavaAt(t.xs[i] - ty * off * side, t.ys[i] + tx * off * side);
        n++;
        if (!at(0) && !at(HALF_WIDTH - 0.5) && !at(HALF_WIDTH + 1.5)) road++;
        if (!at(BANK_EDGE - 0.8)) bank++;
        if (at(BANK_EDGE + 3)) lava++;
      }
    }
    expect(road).toBe(n);
    expect(bank).toBe(n);
    expect(lava / n).toBeGreaterThan(0.9); // (unless another stretch of road runs that close)
    expect(tex.lavaAt(500, 500)).toBe(true); // and the lake goes on past the edge of the world
    expect(new Race({ rivals: 0, difficulty: "pro", theme: THEMES[0], seed: 3, replay: calm() }, null, () => {})
      .tex.lavaAt(500, 500)).toBe(false);
  });

  it("swallows a kart that drives off the rock; a drone sets it back on the road and lets it go", async () => {
    const race = await racing();
    const p = race.player;
    for (let i = 0; i < 180; i++) race.update(1 / 60, { ...none, throttle: 1 });
    const seen: string[] = [];
    for (let i = 0; i < 900 && p.fall < 0; i++) {
      race.update(1 / 60, { ...none, throttle: 1, steer: 1 });
      seen.push(...race.events.map((e) => e.kind));
      race.events = [];
    }
    expect(seen).toContain("lava");
    expect(race.tex.lavaAt(p.fallX, p.fallY)).toBe(true);
    const fellAt = race.clock;
    let rescuedAt = -1, releasedAt = -1;
    for (let i = 0; i < 60 * 2.5 && releasedAt < 0; i++) {
      race.update(1 / 60, { ...none, throttle: 1, steer: 1 }); // the controls do nothing meanwhile
      if (race.events.some((e) => e.kind === "rescued")) rescuedAt = race.clock;
      race.events = [];
      if (p.falling) expect(p.v).toBe(0);
      else releasedAt = race.clock;
    }
    expect(rescuedAt - fellAt).toBeCloseTo(FALL_SWAP, 1);
    expect(releasedAt - fellAt).toBeCloseTo(FALL_RELEASE, 1);
    // set down on the middle of the road, facing up it, just over it
    expect(Math.abs(p.offset)).toBeLessThan(0.5);
    const [tx, ty] = race.track.tangent(p.idx);
    expect(Math.cos(p.heading) * tx + Math.sin(p.heading) * ty).toBeGreaterThan(0.99);
    expect(p.elev - p.ground).toBeGreaterThan(0.2);
    const pilot = new RivalDriver(new Rand(2), p, 0);
    for (let i = 0; i < 60 * 4; i++) race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, p, race.karts));
    expect(p.fall).toBe(-1);
    expect(p.v).toBeGreaterThan(15); // driving on
  });

  it("pays a trick for a fresh hop as the drone lets go, not for a hop held all through the rescue", async () => {
    const drop = async (hop: (fall: number) => boolean) => {
      const race = await racing();
      const p = race.player, t = race.track;
      const i = t.wrap(p.idx + 150), [tx, ty] = t.tangent(i);
      p.x = t.xs[i] - ty * (BANK_EDGE + 3);
      p.y = t.ys[i] + tx * (BANK_EDGE + 3);
      p.idx = i;
      race.update(1 / 60, none);
      expect(p.falling).toBe(true);
      let trick = -1;
      for (let k = 0; k < 60 * 3; k++) {
        race.update(1 / 60, { ...none, drift: hop(p.fall) });
        for (const e of race.events) if (e.kind === "land") trick = e.trick;
        race.events = [];
      }
      return { trick, boost: p.boostTime };
    };
    const fresh = await drop((f) => f >= FALL_RELEASE && f < FALL_RELEASE + 0.05);
    expect(fresh.trick).toBe(2);
    const held = await drop(() => true);
    expect(held.trick).toBe(0);
  });

  it("keeps the bank safe: a kart on the rock beside the road does not go in", async () => {
    const race = await racing();
    const p = race.player, t = race.track;
    const i = t.wrap(p.idx + 120), [tx, ty] = t.tangent(i);
    p.x = t.xs[i] - ty * (BANK_EDGE - 1);
    p.y = t.ys[i] + tx * (BANK_EDGE - 1);
    p.idx = i;
    for (let k = 0; k < 30; k++) race.update(1 / 60, none);
    expect(p.fall).toBe(-1);
  });

  it("counts the laps right when the drone puts a kart back behind the line", async () => {
    const race = await racing(5, 3);
    const p = race.player, pilot = new RivalDriver(new Rand(2), p, 0);
    let pushed = 0, best = p.crossings;
    for (let i = 0; i < 60 * 300 && race.phase !== "done"; i++) {
      race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, p, race.karts));
      race.events = [];
      if (p.crossings > best && p.crossings > 1 && !p.falling && pushed < 2) {
        // just over the line: shove it into the lava (it was last on the road before the line)
        const [tx, ty] = race.track.tangent(p.idx);
        p.x -= ty * (BANK_EDGE + 2);
        p.y += tx * (BANK_EDGE + 2);
        pushed++;
      }
      best = Math.max(best, p.crossings);
    }
    expect(pushed).toBe(2);
    expect(p.finished).toBe(true);
    expect(p.lapTimes.length).toBe(LAPS);
  });

  it("leaves a kart in the lava alone: nothing spins it, it bumps nothing, it cannot fire", () => {
    const t = Track.fromPoints(calm());
    const k = new Kart(1, "K", 1, false), o = new Kart(2, "O", 2, false);
    k.placeOn(t, 50, 0);
    o.placeOn(t, 50, 0.5);
    k.fallIn();
    expect(k.falling).toBe(true);
    expect(k.spinOut()).toBe(false);
    expect(collideKarts([k, o]).hits.length).toBe(0);
    const items = new Items(new Rand(1));
    items.grant(k, "turbo");
    expect(items.press(k, [k, o])).toBe(false);
  });

  it("is a fair fight: the whole field finishes, and rivals seldom end up in the lava", async () => {
    const race = await racing(7, 7);
    const p = race.player, pilot = new RivalDriver(new Rand(2), p, 0);
    let falls = 0;
    for (let i = 0; i < 60 * 300 && race.phase !== "done"; i++) {
      race.update(1 / 60, pilot.act(1 / 60, race.track, race.cls, p, race.karts));
      race.events = [];
      falls += race.karts.filter((k) => k.fall === 0).length;
    }
    expect(race.karts.every((k) => k.finished)).toBe(true);
    expect(falls).toBeLessThan(race.karts.length); // fewer than one fall a kart in three laps
  });
});

describe("the garage", () => {
  it("has a one-line note for every part", () => {
    for (const part of [...BODIES, ...WHEELS, ...SPOILERS, ...EXHAUSTS]) expect(part.note.length).toBeLessThanOrEqual(NOTE_MAX);
  });
});
