// Chiptune music: a four-channel sequencer (pulse lead, pulse arpeggio, triangle bass, noise
// drums) playing short original loops, one for the title and one per world (each its own song). The tempo rises on
// the final lap. Notes are scheduled ahead on the WebAudio clock, so the beat stays tight even
// when frames drop.

interface Song {
  bpm: number;
  chords: string[]; // one per bar
  lead: string[]; // one per bar: 16 tokens, a note ("E5"), "-" to hold, "." for silence
  bass: "bounce" | "drive" | "walk" | "pad" | "octave"; // octave: eighths, jumping up an octave on the offbeat
  arp: 0 | 8 | 16; // arpeggio speed (notes per bar), 0 for none
  drums: { kick: string; snare: string; hat: string };
}

export const SONGS: Record<string, Song> = {
  title: {
    bpm: 104,
    chords: ["Fmaj7", "Em7", "Dm7", "Cmaj7"],
    lead: [
      "A5 - - - G5 - - - E5 - - - C5 - - -",
      "G5 - - - E5 - - - D5 - - - B4 - - -",
      "F5 - - - E5 - - - C5 - - - A4 - - -",
      "E5 - - - D5 - - - B4 - - - G4 - - -",
    ],
    bass: "pad",
    arp: 16,
    drums: { kick: "x...........x...", snare: "................", hat: "....x.......x..." },
  },
  valley: {
    bpm: 150,
    chords: ["C", "G", "Am", "F", "C", "G", "F", "G"],
    lead: [
      "E5 . G5 . C6 - - . B5 . A5 . G5 - - .",
      "D5 . G5 . B5 - - . A5 . G5 . D5 - - .",
      "C5 . E5 . A5 - - . G5 . E5 . C5 - - .",
      "A4 . C5 . F5 - - . E5 . D5 . C5 - - .",
      "E5 . G5 . C6 - - . D6 . E6 - D6 . C6 .",
      "B5 - - . G5 - - . D6 - - . B5 . A5 .",
      "A5 - - . F5 - - . C6 - - . A5 . G5 .",
      "G5 . A5 . B5 . D6 . G6 - - - - - . .",
    ],
    bass: "bounce",
    arp: 8,
    drums: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  },
  neon: {
    bpm: 128,
    chords: ["Am", "F", "C", "G"],
    lead: [
      "A4 - - - C5 - E5 - A5 - - - G5 - E5 -",
      "F5 - - - E5 - C5 - A4 - - - C5 - D5 -",
      "E5 - - - G5 - C6 - B5 - - - G5 - E5 -",
      "D5 - - - B4 - G4 - B4 - D5 - G5 - - -",
    ],
    bass: "drive",
    arp: 16,
    drums: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "xxxxxxxxxxxxxxxx" },
  },
  mesa: {
    bpm: 142,
    chords: ["Dm", "C", "Bb", "C"],
    lead: [
      "D5 . F5 . A5 - G5 . F5 . E5 . D5 - - .",
      "C5 . E5 . G5 - F5 . E5 . D5 . C5 - - .",
      "A#4 . D5 . F5 - E5 . D5 . C5 . A#4 - - .",
      "C5 . E5 . G5 - A5 . G5 - E5 - C5 - - .",
    ],
    bass: "walk",
    arp: 8,
    drums: { kick: "x.....x...x.....", snare: "....x.......x..x", hat: "..x...x...x...x." },
  },
  // the reef: slow and floaty, long notes over a bubbling arpeggio
  reef: {
    bpm: 108,
    chords: ["Am7", "Fmaj7", "Cmaj7", "Em7"],
    lead: [
      "E5 - - - - - G5 - A5 - - - - - - .",
      "C6 - - - A5 - - - G5 - - - E5 - - .",
      "G5 - - - - - E5 - D5 - - - C5 - - .",
      "B4 - - - D5 - - - E5 - - - - - - .",
    ],
    bass: "pad",
    arp: 16,
    drums: { kick: "x.......x.......", snare: "................", hat: "..x...x...x...x." },
  },
  // Tokyo: drift music, a fast minor riff in the eurobeat way: a bass jumping octaves on every
  // eighth, a pedal-note lead in the second half, a four-on-the-floor kick under open hats
  tokyo: {
    bpm: 158,
    chords: ["Am", "F", "G", "Am", "Am", "F", "G", "E7"],
    lead: [
      "A5 . C6 . E6 . A6 - G6 . E6 . C6 - - .",
      "F5 . A5 . C6 . F6 - E6 . C6 . A5 - - .",
      "G5 . B5 . D6 . G6 - F6 . D6 . B5 - - .",
      "E6 - D6 . C6 - B5 . A5 - - . E5 . A5 .",
      "A5 . A5 . C6 . A5 . E6 . A5 . D6 . C6 .",
      "F5 . F5 . A5 . F5 . C6 . F5 . E6 . C6 .",
      "G5 . G5 . B5 . G5 . D6 . G5 . F6 . E6 .",
      "G#5 - - . B5 - - . D6 - - . E6 - - .",
    ],
    bass: "octave",
    arp: 16,
    drums: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "..x...x...x...x." },
  },
  // the volcano: a driving minor riff over a pounding bass, with a climb in the second half
  volcano: {
    bpm: 146,
    chords: ["Em", "C", "Am", "B7", "Em", "C", "D", "B7"],
    lead: [
      "E5 . E5 . G5 . B5 - A5 . G5 . F#5 - E5 .",
      "C5 . E5 . G5 - - . E5 . G5 . C6 - - .",
      "A5 . G5 . E5 . C5 - E5 . A5 . C6 - B5 .",
      "B5 - - . A5 - - . F#5 - - . D#5 - - .",
      "B5 . A5 . G5 . E5 - G5 . B5 . E6 - - .",
      "C6 . B5 . G5 . E5 - G5 . C6 . E6 - - .",
      "D6 . C6 . A5 . F#5 - A5 . D6 . F#6 - - .",
      "D#6 - - . B5 - - . F#5 - - . D#5 - - .",
    ],
    bass: "drive",
    arp: 16,
    drums: { kick: "x...x.x.x...x.x.", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  },
  // the building site: a hammering, funky riff (the flat seventh of a work song) over a busy bass,
  // a hat on every sixteenth like a riveter, the kick pushed off the beat
  construction: {
    bpm: 138,
    chords: ["G", "F", "C", "G", "G", "F", "Bb", "D"],
    lead: [
      "G5 . G5 . D5 . G5 - F5 . G5 . A5 - - .",
      "C6 . A5 . F5 . A5 - G5 . F5 . C5 - - .",
      "E5 . G5 . C6 . G5 - E5 . D5 . C5 - - .",
      "D5 . D5 . G5 - - . B5 . A5 . G5 - - .",
      "G5 . G5 . D6 . B5 - A5 . G5 . F5 - - .",
      "F5 . A5 . C6 . A5 - F5 . C6 . F6 - - .",
      "F5 . A#5 . D6 . A#5 - F5 . D5 . A#4 - - .",
      "A5 - - . F#5 - - . D5 - - . A5 . . .",
    ],
    bass: "drive",
    arp: 8,
    drums: { kick: "x..x..x.x..x..x.", snare: "....x.......x.x.", hat: "xxxxxxxxxxxxxxxx" },
  },
  // the moon: slow and weightless, long notes that hang in the air (the raised fourth of the
  // lydian mode) over a glittering arpeggio, hardly any drums
  moon: {
    bpm: 100,
    chords: ["Fmaj7", "G", "Em7", "Am7", "Fmaj7", "G", "Em7", "Am7"],
    lead: [
      "C6 - - - - - A5 - B5 - - - E6 - - .",
      "D6 - - - - - B5 - G5 - - - D5 - - .",
      "E5 - - - G5 - - - B5 - - - D6 - - .",
      "C6 - - - - - - - - - - - B5 - A5 .",
      "A5 - - - C6 - - - E6 - - - - - - .",
      "D6 - - - B5 - - - D6 - G6 - - - - .",
      "G6 - - - - - E6 - D6 - - - B5 - - .",
      "C6 - - - - - - - A5 - - - - - - .",
    ],
    bass: "pad",
    arp: 16,
    drums: { kick: "x.........x.....", snare: "................", hat: "......x.......x." },
  },
};

const NAMES: Record<string, number> = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
const QUALITY: Record<string, number[]> = {
  "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
};

export function midi(note: string): number {
  const m = /^([A-G]#?)(-?\d)$/.exec(note);
  if (!m) throw new Error(`bad note ${note}`);
  return NAMES[m[1]] + 12 * (Number(m[2]) + 1);
}

export function chord(name: string): number[] {
  const m = /^([A-G]b?#?)(.*)$/.exec(name)!;
  let root = m[1];
  if (root.endsWith("b")) root = Object.keys(NAMES).find((k) => NAMES[k] === (NAMES[root[0]] + 11) % 12)!;
  const base = NAMES[root] + 48; // the bass octave (C3)
  return (QUALITY[m[2]] ?? QUALITY[""]).map((i) => base + i);
}

const freq = (m: number) => 440 * 2 ** ((m - 69) / 12);

export class Music {
  private timer: ReturnType<typeof setInterval> | null = null;
  private song: Song | null = null;
  private step = 0; // 16th note being scheduled next
  private nextAt = 0; // audio time of that step
  private tempo = 1;
  private out: GainNode | null = null;
  private pulse25: PeriodicWave | null = null;
  private pulse12: PeriodicWave | null = null;
  private noise: AudioBuffer | null = null;
  current = "";

  constructor(private readonly ctx: () => AudioContext | null, private readonly master: () => AudioNode | null) {}

  private setup(ac: AudioContext): void {
    if (this.out) return;
    this.out = ac.createGain();
    this.out.gain.value = 0.42; // the music leads the mix; the engine sits far under it
    this.out.connect(this.master()!);
    const wave = (duty: number) => {
      const n = 32, re = new Float32Array(n), im = new Float32Array(n);
      for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      return ac.createPeriodicWave(re, im);
    };
    this.pulse25 = wave(0.25);
    this.pulse12 = wave(0.125);
    const len = ac.sampleRate;
    this.noise = ac.createBuffer(1, len, ac.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Start (or switch to) a loop; the same song keeps playing without a restart. */
  play(name: string): void {
    const ac = this.ctx();
    if (!ac || !SONGS[name]) return;
    if (this.current === name && this.timer) return;
    this.setup(ac);
    this.song = SONGS[name];
    this.current = name;
    this.step = 0;
    this.tempo = 1;
    this.nextAt = ac.currentTime + 0.08;
    if (!this.timer) this.timer = setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current = "";
  }

  /** 1 normally; the final lap plays faster. */
  setTempo(scale: number): void {
    this.tempo = scale;
  }

  private schedule(): void {
    const ac = this.ctx();
    const song = this.song;
    if (!ac || !song || ac.state !== "running") return;
    const sixteenth = 60 / (song.bpm * this.tempo) / 4;
    if (this.nextAt < ac.currentTime - 0.2) this.nextAt = ac.currentTime + 0.05; // woke up late
    while (this.nextAt < ac.currentTime + 0.15) {
      this.playStep(ac, song, this.step, this.nextAt, sixteenth);
      this.step = (this.step + 1) % (song.chords.length * 16);
      this.nextAt += sixteenth;
    }
  }

  private playStep(ac: AudioContext, song: Song, step: number, t: number, dur: number): void {
    const bar = Math.floor(step / 16), s = step % 16;
    const tones = chord(song.chords[bar % song.chords.length]);
    // lead
    const lead = song.lead[bar % song.lead.length].split(/\s+/);
    const tok = lead[s];
    if (tok && tok !== "-" && tok !== ".") {
      let len = 1;
      while (s + len < 16 && lead[s + len] === "-") len++;
      this.note(ac, this.pulse25!, freq(midi(tok)), t, len * dur * 0.95, 0.1);
    }
    // arpeggio
    if (song.arp && s % (16 / song.arp) === 0) {
      const k = Math.floor(s / (16 / song.arp));
      const m = tones[k % tones.length] + 24 + (k >= tones.length ? 12 : 0);
      this.note(ac, this.pulse12!, freq(m), t, dur * (16 / song.arp) * 0.7, 0.035);
    }
    // bass
    const root = tones[0] - 12;
    const bassAt: Record<Song["bass"], number[]> = {
      bounce: [0, 4, 8, 12], drive: [0, 2, 4, 6, 8, 10, 12, 14], walk: [0, 4, 8, 12], pad: [0],
      octave: [0, 2, 4, 6, 8, 10, 12, 14],
    };
    if (bassAt[song.bass].includes(s)) {
      let m = root;
      if (song.bass === "bounce" && s % 8 === 4) m = root + 12;
      if (song.bass === "walk") m = [root, root + 7, root + 12, root + 7][s / 4];
      if (song.bass === "octave" && s % 4 === 2) m = root + 12;
      const len = song.bass === "pad" ? 16 : song.bass === "drive" || song.bass === "octave" ? 2 : 4;
      this.note(ac, "triangle", freq(m), t, len * dur * 0.9, song.bass === "pad" ? 0.13 : 0.17);
    }
    // drums
    if (song.drums.kick[s] === "x") this.kick(ac, t);
    if (song.drums.snare[s] === "x") this.hit(ac, t, 1800, 0.13, 0.12);
    if (song.drums.hat[s] === "x") this.hit(ac, t, 7000, 0.03, 0.04);
  }

  private note(ac: AudioContext, wave: PeriodicWave | OscillatorType, f: number, t: number,
               len: number, vol: number): void {
    const o = ac.createOscillator();
    if (wave instanceof PeriodicWave) o.setPeriodicWave(wave);
    else o.type = wave;
    o.frequency.setValueAtTime(f, t);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(vol * 0.6, t + 0.08);
    g.gain.setValueAtTime(vol * 0.6, t + Math.max(0.09, len - 0.03));
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  private kick(ac: AudioContext, t: number): void {
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + 0.18);
  }

  private hit(ac: AudioContext, t: number, cutoff: number, len: number, vol: number): void {
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = cutoff;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(this.out!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + len + 0.01);
  }
}
