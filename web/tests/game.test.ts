// Game logic: circuits that grow while they are dreamed, lock into loops, and count laps.

import { describe, expect, it } from "vitest";
import { Rand } from "../src/game/core/gfx";
import { RivalDriver } from "../src/game/race/ai";
import { BOX_SPACING, Items, ROULETTE, itemOdds } from "../src/game/race/items";
import { CLASSES, Kart } from "../src/game/race/kart";
import { Race } from "../src/game/race/race";
import { THEMES } from "../src/game/themes";
import { HALF_WIDTH, N, SCALE, SPACING, Track, checkGuess, crSegment, polarPoint } from "../src/game/world/track";
import { CHUNK, INITIAL, smoothArc } from "../src/game/world/trackgen";

const circle = (r = 77) => Float64Array.from({ length: N }, () => r);
const wavy = () => Float64Array.from({ length: N }, (_, j) => 80 + 12 * Math.sin((j / N) * Math.PI * 2 * 3));
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => (((a + k) % N) + N) % N);

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
    const radii = wavy();
    const t = new Track();
    const arcs = liveArcs();
    t.addKnown(arcs[0], radii);
    expect(t.startIndex).toBeGreaterThan(0); // grid road exists behind the line
    expect(t.locked).toBe(false);
    const snapshot = t.xs.slice();
    for (const arc of arcs.slice(1, -1)) {
      t.addKnown(arc, radii);
      expect(t.xs.slice(0, snapshot.length)).toEqual(snapshot);
    }
    expect(t.locked).toBe(false);
    t.addKnown(arcs.at(-1)!, radii);
    expect(t.locked).toBe(true);
    expect(t.committedFraction).toBe(1);
  });

  it("closes into a loop of the expected length", () => {
    const t = Track.fromRadii(circle(77));
    const n = t.count;
    const gap = Math.hypot(t.xs[0] - t.xs[n - 1], t.ys[0] - t.ys[n - 1]);
    expect(gap).toBeLessThan(SPACING * 1.6);
    expect(t.length).toBeCloseTo(2 * Math.PI * 77 * SCALE, -1);
    expect(t.fromStart(t.startIndex)).toBe(0);
    expect(t.fromStart(t.wrap(t.startIndex - 20))).toBeLessThan(0);
  });

  it("measures lateral offset and curvature with the right signs", () => {
    const t = Track.fromRadii(circle(77));
    const i = t.startIndex + 100;
    const [tx, ty] = t.tangent(i);
    // a point 3 m to the left of the centerline
    const x = t.xs[i] - ty * 3, y = t.ys[i] + tx * 3;
    expect(t.offset(x, y, i)).toBeCloseTo(3, 1);
    expect(t.curvature(i)).toBeCloseTo(1 / (77 * SCALE), 3); // counter-clockwise = left-hander
    expect(t.nearest(x, y, i - 5)).toBe(i);
  });
});

describe("drivability checks", () => {
  it("accept a gentle circuit and reject a hairpin spike", () => {
    expect(checkGuess(circle(77), new Set(range(0, N))).ok).toBe(true);
    const spiky = circle(77);
    spiky[40] = 30;
    const r = checkGuess(spiky, new Set(range(30, 50)));
    expect(r.ok).toBe(false);
    // a spike is both a hairpin and a pinch; either rule may fire first
    expect(["too tight", "too close to itself"]).toContain(r.reason);
  });

  it("reject circuits that are too short", () => {
    expect(checkGuess(circle(20), new Set(range(0, N))).reason).toBe("length");
  });
});

describe("arc smoothing", () => {
  it("only touches the new arc", () => {
    const u = Float32Array.from({ length: N }, (_, j) => (j % 2 ? 1 : -1));
    const arc = range(10, 20);
    const s = smoothArc(u, arc, 1.0);
    for (let j = 0; j < N; j++) {
      if (arc.includes(j)) expect(Math.abs(s[j])).toBeLessThan(0.5);
      else expect(s[j]).toBe(u[j]);
    }
  });
});

describe("lap counting", () => {
  it("counts crossings of the start line, and un-counts backing over it", () => {
    const t = Track.fromRadii(circle(77));
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

  it("keeps a stationary kart on the road and classes ordered by pace", () => {
    expect(CLASSES.rookie.vmax).toBeLessThan(CLASSES.pro.vmax);
    expect(CLASSES.pro.vmax).toBeLessThan(CLASSES.legend.vmax);
    const t = Track.fromRadii(circle(77));
    const k = new Kart(0, "TEST", 0, true);
    k.placeOn(t, t.startIndex, HALF_WIDTH / 2);
    k.update(1 / 60, { steer: 0, throttle: 0, brake: 0, drift: false }, t, CLASSES.pro);
    expect(k.surface).toBe("road");
    expect(polarPoint(77, 0)[0]).toBeCloseTo(77 * SCALE, 9);
  });
});

describe("rival drivers", () => {
  it("lap a twisty circuit cleanly and drift its tight corners", () => {
    const radii = Float64Array.from({ length: N },
      (_, j) => 78 + 22 * Math.sin((2 * Math.PI * j) / N * 2 + 0.4) + 9 * Math.cos((2 * Math.PI * j) / N * 6));
    expect(checkGuess(radii, new Set(range(0, N))).ok).toBe(true);
    const t = Track.fromRadii(radii);
    const k = new Kart(1, "RIVAL", 1, false);
    k.placeOn(t, t.wrap(t.startIndex - 8), 0);
    const driver = new RivalDriver(new Rand(4), k, 1);
    const dt = 1 / 60;
    let steps = 0, grass = 0, drifts = 0, boosts = 0, was = false;
    while (k.crossings < 4 && steps < 60 * 300) {
      const { boosted } = k.update(dt, driver.act(dt, t, CLASSES.pro, k, [k]), t, CLASSES.pro);
      k.updateProgress(t);
      if (k.surface === "grass") grass++;
      if (k.drifting && !was) drifts++;
      was = k.drifting;
      if (boosted) boosts++;
      steps++;
    }
    expect(k.crossings - 1).toBe(3);
    expect(grass / steps).toBeLessThan(0.02);
    expect(drifts).toBeGreaterThanOrEqual(3);
    expect(boosts).toBeGreaterThanOrEqual(1);
  });
});

const twisty = () => Float64Array.from({ length: N },
  (_, j) => 78 + 22 * Math.sin((2 * Math.PI * j) / N * 2 + 0.4) + 9 * Math.cos((2 * Math.PI * j) / N * 6));

describe("items", () => {
  it("favor defense at the front of the field and speed at the back", () => {
    const lead = itemOdds(1, 8), last = itemOdds(8, 8);
    for (const p of [lead, last, itemOdds(4, 8)]) {
      expect(p.turbo + p.oil + p.orb).toBeCloseTo(1, 9);
      for (const v of Object.values(p)) expect(v).toBeGreaterThan(0);
    }
    expect(lead.oil).toBeGreaterThan(lead.turbo);
    expect(last.turbo).toBeGreaterThan(last.oil);
  });

  it("come in rows of boxes along the road, clear of the run to the line", () => {
    const t = Track.fromRadii(circle(77));
    const items = new Items(new Rand(1));
    items.onCommit(t, 0, t.count);
    expect(items.boxes.length % 4).toBe(0);
    const rows = items.boxes.length / 4;
    expect(rows).toBeGreaterThanOrEqual(Math.floor(t.length / BOX_SPACING) - 1);
    for (const b of items.boxes) {
      const s = t.fromStart(t.nearest(b.x, b.y, 0));
      expect(s).toBeGreaterThan(BOX_SPACING * 0.5);
      expect(s).toBeLessThan(t.length - 60);
    }
  });

  it("hand rivals an item at once and give the player a roulette first", () => {
    const t = Track.fromRadii(circle(77));
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
    expect(items.use(me, [me])).toBe(true);
    expect(me.item).toBeNull();
  });

  it("oil spins out whoever drives through it, but spares its owner at first", () => {
    const t = Track.fromRadii(circle(77));
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
    const t = Track.fromRadii(circle(77));
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
    for (let i = 0; i < 60 * 70; i++) {
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
        for (const k of race.karts) fastest = Math.max(fastest, Math.abs(k.v));
      }
      // before the fix, bumps at the start pumped one kart to 88 m/s and shoved another to -55
      expect(fastest).toBeLessThan(race.cls.vmax * 1.3);
    }
  });
});
