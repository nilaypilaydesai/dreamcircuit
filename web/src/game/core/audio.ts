// Chiptune sound, synthesized live with WebAudio (no audio files): an engine whose pitch follows
// the kart's speed, countdown beeps, lap and finish jingles, boosts, bumps and a little shimmer
// when the dreamed circuit locks. Starts on the first key press (browser autoplay rules).

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: { a: OscillatorNode; b: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  muted = false;

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
    this.engine.filter.frequency.setTargetAtTime(500 + 1400 * speedFrac, t, 0.08);
    this.engine.gain.gain.setTargetAtTime(on ? 0.05 + 0.04 * speedFrac : 0, t, 0.1);
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
  bump(): void { this.noise(0.18, 0.22, 400); this.tone(90, 0.15, "triangle", 0.15); }
  locked(): void { [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.3, "triangle", 0.09, i * 0.07)); }
  roll(): void { for (let i = 0; i < 12; i++) this.tone(520 + (i % 4) * 140, 0.05, "square", 0.045, i * 0.095); }
  itemGet(): void { [988, 1319].forEach((f, i) => this.tone(f, 0.12, "square", 0.1, i * 0.08)); }
  oil(): void { this.noise(0.25, 0.12, 500); this.tone(160, 0.2, "triangle", 0.1, 0, 90); }
  orb(): void { this.tone(400, 0.35, "sawtooth", 0.07, 0, 1600); }
  spin(): void { this.tone(700, 0.6, "triangle", 0.12, 0, 120); this.noise(0.3, 0.1, 1200); }
  hit(): void { [1175, 1568].forEach((f, i) => this.tone(f, 0.1, "square", 0.09, i * 0.06)); }
  select(): void { this.tone(660, 0.07, "square", 0.08); }
  move(): void { this.tone(440, 0.04, "square", 0.05); }
}
