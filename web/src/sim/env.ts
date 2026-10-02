// One car on one track: the "reality" half of the split screen. Mirrors RaceEnv for n = 1.

import { type SimConfig, type SpriteData, pyMod } from "./config";
import { EgoRenderer } from "./render";
import type { Track } from "./track";
import { PSI, STATE_DIM, VX, X, Y, stepVehicle } from "./vehicle";

export class CarEnv {
  state: Float64Array = new Float64Array(STATE_DIM);
  idx = 0;
  progress = 0;
  onGrass = false;
  offset = 0;
  readonly renderer: EgoRenderer;
  private readonly frame: Uint8Array;

  constructor(readonly track: Track, readonly cfg: SimConfig, sprite: SpriteData) {
    this.renderer = new EgoRenderer(track, cfg.render, cfg.vehicle, sprite);
    this.frame = new Uint8Array(cfg.render.size * cfg.render.size * 3);
  }

  /** Place the car on the centerline at ``startIdx`` with an initial speed (m/s). */
  reset(startIdx = 0, speed = 0, lateral = 0): void {
    const tr = this.track;
    const i = pyMod(Math.round(startIdx), tr.n);
    this.state = new Float64Array(STATE_DIM);
    this.state[X] = tr.cx[i] + lateral * tr.nx[i];
    this.state[Y] = tr.cy[i] + lateral * tr.ny[i];
    this.state[PSI] = tr.heading[i];
    this.state[VX] = speed;
    this.idx = i;
    this.progress = 0;
    this.localize(true);
  }

  setState(state: ArrayLike<number>, idx?: number): void {
    this.state = Float64Array.from(state);
    if (idx !== undefined) this.idx = idx;
    this.localize(idx === undefined);
  }

  step(steer: number, pedal: number): void {
    const c = this.cfg;
    this.state = stepVehicle(this.state, steer, pedal, this.onGrass, c.vehicle, c.dt, c.substeps);
    this.localize(false);
  }

  private localize(full: boolean): void {
    const loc = this.track.localize(this.state[X], this.state[Y], this.idx, full);
    this.idx = loc.idx;
    this.offset = loc.offset;
    this.onGrass = loc.onGrass;
    this.progress += loc.progressStep;
  }

  /** Current ego frame as RGB bytes (shared buffer: copy it if you keep it). */
  render(): Uint8Array {
    return this.renderer.renderRGB(this.state, this.frame);
  }

  /** Lost the circuit entirely? (the web game respawns; the dream has no such notion) */
  get lost(): boolean {
    return Math.abs(this.offset) > this.track.halfWidth + 25;
  }
}
