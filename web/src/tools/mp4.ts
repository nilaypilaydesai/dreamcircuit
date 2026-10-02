// A minimal MP4 writer for one H.264 video track from WebCodecs (no audio): ftyp, moov (with the
// sample tables up front, so the browser can start playing before the whole file arrives) and
// one mdat holding every sample as a single chunk.

export interface Sample {
  data: Uint8Array; // AVCC (length-prefixed NAL units), as VideoEncoder emits with format "avc"
  key: boolean;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function u16(n: number): number[] {
  return [(n >>> 8) & 255, n & 255];
}
function str(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}
function box(type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array {
  const size = 8 + parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(size);
  out.set([...u32(size), ...str(type)], 0);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const full = (type: string, version: number, flags: number, ...parts: (number[] | Uint8Array)[]) =>
  box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
const MATRIX = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0),
  ...u32(0), ...u32(0), ...u32(0x40000000)];

function moov(samples: Sample[], avcC: Uint8Array, w: number, h: number, fps: number,
              dataOffset: number): Uint8Array {
  const n = samples.length;
  const durMs = Math.round((n * 1000) / fps);
  const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x10000), u16(0x100),
    new Array(10).fill(0), MATRIX, new Array(24).fill(0), u32(2));
  const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), new Array(8).fill(0),
    u16(0), u16(0), u16(0), u16(0), MATRIX, u32(w << 16), u32(h << 16));
  const mdhd = full("mdhd", 0, 0, u32(0), u32(0), u32(fps), u32(n), u16(0x55c4), u16(0));
  const hdlr = full("hdlr", 0, 0, u32(0), str("vide"), new Array(12).fill(0), str("DreamCircuit\0"));
  const vmhd = full("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  const avc1 = box("avc1", new Array(6).fill(0), u16(1), new Array(16).fill(0), u16(w), u16(h),
    u32(0x480000), u32(0x480000), u32(0), u16(1), new Array(32).fill(0), u16(0x18), u16(0xffff),
    box("avcC", avcC));
  const stsd = full("stsd", 0, 0, u32(1), avc1);
  const stts = full("stts", 0, 0, u32(1), u32(n), u32(1));
  const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));
  const stss = full("stss", 0, 0, u32(keys.length), ...keys.map(u32));
  const stsc = full("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1));
  const stsz = full("stsz", 0, 0, u32(0), u32(n), ...samples.map((s) => u32(s.data.length)));
  const stco = full("stco", 0, 0, u32(1), u32(dataOffset));
  const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  return box("moov", mvhd, box("trak", tkhd, mdia));
}

/** The finished file. ``avcC`` is the encoder's decoderConfig.description. */
export function mp4(samples: Sample[], avcC: Uint8Array, w: number, h: number, fps: number): Blob {
  const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso2"), str("avc1"), str("mp41"));
  const size = samples.reduce((a, s) => a + s.data.length, 0);
  // moov's size does not depend on the offset it records, so measure it once, then write it
  const probe = moov(samples, avcC, w, h, fps, 0);
  const offset = ftyp.length + probe.length + 8;
  const head = moov(samples, avcC, w, h, fps, offset);
  const parts: BlobPart[] = [ftyp, head, new Uint8Array([...u32(size + 8), ...str("mdat")])]
    .concat(samples.map((s) => s.data)).map((a) => a as Uint8Array<ArrayBuffer>);
  return new Blob(parts, { type: "video/mp4" });
}

function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** H.264 encoder for a stream of canvases, with explicit frame timing. */
export class Encoder {
  private readonly samples: Sample[] = [];
  private avcC: Uint8Array | null = null;
  private readonly enc: VideoEncoder;
  private n = 0;

  constructor(readonly w: number, readonly h: number, readonly fps: number, codec: string,
              bitrate = 12_000_000) {
    this.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const d = meta?.decoderConfig?.description;
        if (d && !this.avcC) {
          this.avcC = ArrayBuffer.isView(d)
            ? Uint8Array.from(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
            : Uint8Array.from(new Uint8Array(d as ArrayBuffer));
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.samples.push({ data, key: chunk.type === "key" });
      },
      error: (e) => console.error("encoder", e),
    });
    this.enc.configure({ codec, width: w, height: h, bitrate, framerate: fps, avc: { format: "avc" },
                         latencyMode: "quality" });
  }

  static async pick(w: number, h: number, fps: number): Promise<string> {
    for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028"]) {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: fps, avc: { format: "avc" } });
      if (r.supported) return codec;
    }
    throw new Error("this browser cannot encode H.264 at that size");
  }

  async add(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<void> {
    const frame = new VideoFrame(canvas, { timestamp: Math.round((this.n * 1e6) / this.fps),
                                           duration: Math.round(1e6 / this.fps) });
    this.enc.encode(frame, { keyFrame: this.n % (this.fps * 2) === 0 });
    frame.close();
    this.n += 1;
    // back-pressure: let the encoder drain. A message-channel hop, not setTimeout, which a hidden
    // page throttles to one tick a second
    while (this.enc.encodeQueueSize > 8) await yieldTask();
  }

  async finish(): Promise<Blob> {
    await this.enc.flush();
    this.enc.close();
    if (!this.avcC) throw new Error("the encoder produced no decoder configuration");
    return mp4(this.samples, this.avcC, this.w, this.h, this.fps);
  }
}
