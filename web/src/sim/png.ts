// Minimal PNG decoder for 8-bit RGB/RGBA, non-interlaced images (what Pillow writes).
// Decoding ourselves (instead of canvas.getImageData) guarantees bit-exact texels on every
// browser: no color management, no premultiplied alpha, no GPU readback quirks.

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

export interface DecodedImage {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array; // tightly packed rows
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export async function decodePng(bytes: Uint8Array, inflate: Inflate): Promise<DecodedImage> {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const idat: Uint8Array[] = [];
  while (pos < bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || body[12] !== 0 || (color !== 2 && color !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, color ${color}, interlace ${body[12]})`);
      }
      channels = color === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const total = idat.reduce((n, c) => n + c.length, 0);
  const compressed = new Uint8Array(total);
  let off = 0;
  for (const c of idat) {
    compressed.set(c, off);
    off += c.length;
  }
  const raw = await inflate(compressed);
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) pred = paeth(a, b, c);
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      out[dst + x] = (v + pred) & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Browser inflate via the native DecompressionStream ("deflate" = zlib-wrapped). */
export const browserInflate: Inflate = async (data) => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
