// The Grand Prix: one race in every world, back to back, the same rivals in the same karts. Each
// race pays points by finishing place, like the classics (15 for a win, then 12, 10, 8, 6, 4, 2
// and 1); the standings add them up, with total race time breaking ties. Pure bookkeeping (no
// rendering), unit-tested headlessly.

import type { Theme } from "../themes";
import type { Build } from "./parts";

export const POINTS = [15, 12, 10, 8, 6, 4, 2, 1];

export interface Entrant { id: number; name: string; livery: number; build: Build; isPlayer: boolean }

/** One racer's line after a race: where they finished it, what it paid, and their totals. */
export interface CupRow {
  entrant: Entrant;
  place: number; // in this race
  gained: number; // points it paid
  before: number; // total before it
  points: number; // total after it
  time: number; // total race time so far (s)
  rank: number; // place in the standings after this race (1 = leading the cup)
  rankBefore: number; // and before it
}

export class Cup {
  index = 0; // the race being run (0-based)
  readonly points = new Map<number, number>();
  readonly times = new Map<number, number>();
  entrants: Entrant[] = [];
  last: CupRow[] = [];

  constructor(readonly worlds: Theme[], readonly seed: number) {}

  get done(): boolean {
    return this.index >= this.worlds.length;
  }

  get world(): Theme {
    return this.worlds[Math.min(this.index, this.worlds.length - 1)];
  }

  /** Points for finishing ``place`` (1-based). */
  static pointsFor(place: number): number {
    return POINTS[place - 1] ?? 0;
  }

  /** Everyone, best first: most points, then least total time. */
  ranking(points = this.points, times = this.times): Entrant[] {
    return [...this.entrants].sort((a, b) =>
      (points.get(b.id) ?? 0) - (points.get(a.id) ?? 0) || (times.get(a.id) ?? 0) - (times.get(b.id) ?? 0));
  }

  /** Score a finished race from its order (best first, with each racer's race time) and move on
   * to the next world. Returns the rows in the new standings' order. */
  award(order: { entrant: Entrant; time: number }[]): CupRow[] {
    if (!this.entrants.length) this.entrants = order.map((o) => o.entrant);
    const beforeP = new Map(this.points), beforeT = new Map(this.times);
    const rankBefore = new Map(this.ranking(beforeP, beforeT).map((e, i) => [e.id, i + 1]));
    const placeOf = new Map<number, number>();
    order.forEach((o, i) => {
      placeOf.set(o.entrant.id, i + 1);
      this.points.set(o.entrant.id, (this.points.get(o.entrant.id) ?? 0) + Cup.pointsFor(i + 1));
      this.times.set(o.entrant.id, (this.times.get(o.entrant.id) ?? 0) + o.time);
    });
    this.last = this.ranking().map((e, i) => ({
      entrant: e,
      place: placeOf.get(e.id) ?? order.length,
      gained: Cup.pointsFor(placeOf.get(e.id) ?? 99),
      before: beforeP.get(e.id) ?? 0,
      points: this.points.get(e.id) ?? 0,
      time: this.times.get(e.id) ?? 0,
      rank: i + 1,
      rankBefore: rankBefore.get(e.id) ?? i + 1,
    }));
    this.index += 1;
    return this.last;
  }

  /** The top three for the podium (best first). */
  podium(): Entrant[] {
    return this.ranking().slice(0, 3);
  }
}
