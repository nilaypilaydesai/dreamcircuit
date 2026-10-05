// Chiptune sound, synthesized live with WebAudio (no audio files): music (core/music.ts), an
// engine whose pitch follows the kart's speed, countdown beeps, lap and finish jingles, boosts,
// bumps, jumps and tricks, and a little shimmer when the dreamed circuit locks. Starts on the
// first key press (browser autoplay rules).

import { Music } from "./music";

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  readonly music = new Music(() => this.ctx, () => this.master);
  private engine: { a: OscillatorNode; b: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  muted = false;
  /** The engine note's loudness: a soft hum well under the music (LOW), or nothing (OFF). */
  engineLevel = 0.18;

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
  }

  /** Silence everything while the page is hidden; resume when it comes back. */
  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  private tone(freq: number, dur: number, type: OscillatorType = "square", vol = 0.12, at = 0,
               slideTo = 0): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, vol = 0.15, freq = 900): void {
    if (!this.ctx || !this.master) return;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  /** Continuous engine note; call every frame while racing. */
  setEngine(speedFrac: number, on: boolean, offroad: boolean): void {
    if (!this.ctx || !this.master) return;
    if (!this.engine) {
      const a = this.ctx.createOscillator(), b = this.ctx.createOscillator();
      const gain = this.ctx.createGain(), filter = this.ctx.createBiquadFilter();
      a.type = "sawtooth";
      b.type = "square";
      filter.type = "lowpass";
      filter.frequency.value = 900;
      gain.gain.value = 0;
      a.connect(filter);
      b.connect(filter);
      filter.connect(gain).connect(this.master);
      a.start();
      b.start();
      this.engine = { a, b, gain, filter };
    }
    const t = this.ctx.currentTime;
    const f = 55 + 150 * Math.min(1.2, speedFrac);
    this.engine.a.frequency.setTargetAtTime(f, t, 0.05);
    this.engine.b.frequency.setTargetAtTime(f * 0.5 * (offroad ? 1.03 : 1), t, 0.05);
    // a low, muffled hum: the buzzy upper harmonics are what made it grate
    this.engine.filter.frequency.setTargetAtTime(260 + 600 * speedFrac, t, 0.08);
    this.engine.gain.gain.setTargetAtTime(on ? (0.05 + 0.04 * speedFrac) * this.engineLevel : 0, t, 0.1);
  }

  count(): void { this.tone(440, 0.22, "square", 0.14); }
  go(): void { this.tone(880, 0.6, "square", 0.16); }
  lap(): void { [523, 659, 784].forEach((f, i) => this.tone(f, 0.16, "square", 0.1, i * 0.09)); }
  finalLap(): void { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.15, "square", 0.11, i * 0.1)); }
  finish(place: number): void {
    const win = [523, 659, 784, 1047, 1319, 1047, 1319, 1568];
    const lose = [392, 349, 330, 262];
    (place <= 3 ? win : lose).forEach((f, i) => this.tone(f, 0.22, "square", 0.12, i * 0.13));
  }
  boost(): void { this.tone(300, 0.5, "sawtooth", 0.08, 0, 1200); this.noise(0.4, 0.06, 3000); }
  /** A wing pad: a jet's rising roar and a bright call. */
  wings(): void {
    this.noise(0.8, 0.08, 2400);
    this.tone(180, 0.7, "sawtooth", 0.06, 0, 720);
    [784, 1175, 1568].forEach((f, i) => this.tone(f, 0.12, "triangle", 0.07, 0.15 + i * 0.07));
  }
  /** The wings run out: a falling whistle. */
  wingsOff(): void { this.tone(880, 0.45, "triangle", 0.06, 0, 330); }
  bump(): void { this.noise(0.18, 0.22, 400); this.tone(90, 0.15, "triangle", 0.15); }
  locked(): void { [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.3, "triangle", 0.09, i * 0.07)); }
  roll(): void { for (let i = 0; i < 12; i++) this.tone(520 + (i % 4) * 140, 0.05, "square", 0.045, i * 0.095); }
  itemGet(): void { [988, 1319].forEach((f, i) => this.tone(f, 0.12, "square", 0.1, i * 0.08)); }
  oil(): void { this.noise(0.25, 0.12, 500); this.tone(160, 0.2, "triangle", 0.1, 0, 90); }
  orb(): void { this.tone(400, 0.35, "sawtooth", 0.07, 0, 1600); }
  spin(): void { this.tone(700, 0.6, "triangle", 0.12, 0, 120); this.noise(0.3, 0.1, 1200); }
  hit(): void { [1175, 1568].forEach((f, i) => this.tone(f, 0.1, "square", 0.09, i * 0.06)); }
  jump(): void { this.tone(330, 0.25, "square", 0.07, 0, 880); }
  land(): void { this.noise(0.12, 0.16, 300); this.tone(110, 0.12, "triangle", 0.14); }
  trick(perfect: boolean): void {
    const notes = perfect ? [1047, 1319, 1568, 2093] : [880, 1175, 1397];
    notes.forEach((f, i) => this.tone(f, 0.11, "square", 0.08, i * 0.06));
  }
  rocket(): void { [392, 523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.1, "sawtooth", 0.07, i * 0.04)); }
  boomerang(): void { this.tone(500, 0.35, "triangle", 0.08, 0, 1100); this.tone(1100, 0.3, "triangle", 0.05, 0.3, 500); }
  bombThrow(): void { this.tone(260, 0.3, "square", 0.06, 0, 520); }
  explode(near: boolean, big = false): void {
    this.noise(near ? (big ? 1.1 : 0.7) : 0.4, near ? (big ? 0.4 : 0.32) : 0.14, big ? 500 : 700);
    this.tone(big ? 55 : 70, big ? 0.8 : 0.5, "triangle", near ? 0.22 : 0.08, 0, 35);
  }
  /** An aimed item's arrow locks: a click. */
  lock(): void { this.tone(1320, 0.05, "square", 0.07); this.tone(990, 0.06, "square", 0.05, 0.05); }
  puck(): void { this.tone(220, 0.18, "square", 0.08, 0, 520); this.noise(0.12, 0.08, 1600); }
  bounce(): void { this.tone(880, 0.05, "triangle", 0.06); }
  clash(): void { this.noise(0.15, 0.14, 2400); this.tone(600, 0.08, "square", 0.05, 0, 300); }
  coin(): void { [1568, 2093].forEach((f, i) => this.tone(f, 0.08, "square", 0.06, i * 0.06)); }
  /** The horn: two blaring notes and a rush of air. */
  horn(near: boolean): void {
    const v = near ? 0.11 : 0.05;
    this.tone(233, 0.5, "sawtooth", v);
    this.tone(294, 0.5, "sawtooth", v * 0.8);
    this.noise(0.45, near ? 0.12 : 0.05, 900);
  }
  staticHit(): void { this.noise(0.9, 0.16, 7000); this.tone(60, 0.4, "square", 0.04); }
  /** A comet on its way: a rising whoosh, and for the leader it is after, warning beeps. */
  comet(you: boolean): void {
    this.tone(180, 0.9, "sawtooth", 0.05, 0, 900);
    if (you) for (let k = 0; k < 4; k++) this.tone(1760, 0.08, "square", 0.08, 0.25 + k * 0.22);
  }
  bite(): void { this.tone(300, 0.07, "square", 0.08, 0, 120); this.noise(0.07, 0.1, 3000); }
  flare(): void { this.noise(0.25, 0.1, 1400); this.tone(160, 0.2, "sawtooth", 0.05, 0, 420); }
  phantom(): void { this.tone(523, 0.7, "sine", 0.05, 0, 262); this.tone(784, 0.7, "sine", 0.03, 0.1, 392); }
  steal(): void { [988, 1319, 1760].forEach((f, i) => this.tone(f, 0.08, "triangle", 0.06, i * 0.05)); }
  prism(): void { [1047, 1319, 1568, 2093, 1568, 2093, 2637].forEach((f, i) => this.tone(f, 0.09, "square", 0.06, i * 0.05)); }
  shock(): void { this.tone(1400, 0.45, "square", 0.08, 0, 90); this.noise(0.35, 0.12, 5000); }
  rocketGo(): void { this.tone(110, 1.1, "sawtooth", 0.09, 0, 440); this.noise(1.0, 0.1, 1800); }
  blocked(): void { this.tone(1568, 0.08, "square", 0.08); this.noise(0.1, 0.12, 2500); }
  /** Into the lava: a hiss and a deep gulp. */
  lava(): void { this.noise(0.9, 0.2, 2600); this.tone(260, 0.5, "triangle", 0.16, 0.05, 60); }
  /** Into water or sand: a plop and a spray. */
  splash(): void { this.tone(420, 0.25, "sine", 0.14, 0, 120); this.noise(0.6, 0.16, 1800); }
  /** Off an edge, into a hole: a whistle falling away. */
  // what gets in the way (race/obstacles.ts)
  moo(): void { this.tone(150, 0.8, "sawtooth", 0.07, 0, 105); this.tone(156, 0.6, "triangle", 0.06, 0.06, 112); }
  puff(): void { this.noise(0.22, 0.1, 900); }
  zap(): void { this.tone(1800, 0.25, "square", 0.06, 0, 380); this.noise(0.22, 0.1, 6000); }
  siren(): void { this.tone(650, 0.42, "square", 0.04, 0, 1050); this.tone(1050, 0.42, "square", 0.04, 0.44, 650); }
  ram(): void { this.noise(0.28, 0.24, 500); this.tone(70, 0.22, "square", 0.12); }
  geyser(): void { this.noise(0.9, 0.18, 1400); this.tone(90, 0.7, "sawtooth", 0.07, 0, 40); }
  clang(): void { this.tone(520, 0.6, "square", 0.08, 0, 470); this.tone(1040, 0.35, "triangle", 0.06); this.noise(0.12, 0.16, 3000); }
  honk(): void { this.tone(392, 0.18, "square", 0.07); this.tone(330, 0.24, "square", 0.07, 0.2); }

  fall(): void { this.tone(880, 0.7, "triangle", 0.1, 0, 160); }
  /** The rescue drone: rotors whining up, and a two-note beep. */
  rescue(): void {
    this.tone(180, 0.9, "sawtooth", 0.035, 0, 320);
    [988, 784].forEach((f, i) => this.tone(f, 0.09, "square", 0.06, 0.15 + i * 0.12));
  }

  // the award ceremony
  fanfare(): void {
    const lead = [[392, 0.12], [523, 0.12], [659, 0.12], [784, 0.36], [659, 0.12], [784, 0.12], [1047, 0.8]];
    let at = 0;
    for (const [f, d] of lead) {
      this.tone(f, d * 0.95, "square", 0.1, at);
      this.tone(f / 2, d * 0.95, "triangle", 0.12, at);
      at += d;
    }
  }
  reveal(place: number): void {
    const notes = place === 1 ? [659, 880, 1319] : place === 2 ? [587, 784] : [523, 659];
    notes.forEach((f, i) => this.tone(f, 0.18, "square", 0.09, i * 0.09));
    this.noise(0.5, 0.06, 6000);
  }
  whistle(): void { this.tone(520, 0.55, "sine", 0.025, 0, 1500); }
  firework(near: boolean): void {
    this.noise(0.6, near ? 0.2 : 0.11, 1100);
    this.tone(60, 0.35, "triangle", near ? 0.16 : 0.08, 0, 40);
    for (let k = 0; k < 6; k++) this.tone(2000 + k * 300, 0.03, "square", 0.02, 0.2 + k * 0.07);
  }
  /** A crowd: band-passed noise swelling up and dying away, with a few whoops on top. */
  cheer(): void {
    const ctx = this.ctx, out = this.master;
    if (!ctx || !out) return;
    const dur = 3.2, n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1300;
    band.Q.value = 0.7;
    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(band).connect(g).connect(out);
    src.start();
    for (let k = 0; k < 4; k++) this.tone(700 + k * 90, 0.45, "sine", 0.03, 0.3 + k * 0.35, 1100 + k * 120);
  }
  burnout(): void { this.noise(0.6, 0.14, 700); this.tone(70, 0.5, "sawtooth", 0.08, 0, 50); }
  select(): void { this.tone(660, 0.07, "square", 0.08); }
  move(): void { this.tone(440, 0.04, "square", 0.05); }
}
