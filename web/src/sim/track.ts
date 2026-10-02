// Track geometry + texture, and the localization logic of RaceEnv._update_track_frame.

import { pyMod } from "./config";
import { type DecodedImage, type Inflate, browserInflate, decodePng } from "./png";

export interface TrackJson {
  seed: number;
  ds: number;
  half_width: number;
  tex_origin: [number, number];
  tex_res: number;
  center: number[]; // flattened (N, 2)
  normal: number[]; // flattened (N, 2)
  curvature: number[];
}

export interface Localization {
  idx: number;
  offset: number;
  headingError: number;
  onGrass: boolean;
  progressStep: number; // meters of centerline credited this step
}

export class Track {
  readonly n: number;
  readonly cx: Float64Array;
  readonly cy: Float64Array;
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  readonly heading: Float64Array;
  readonly curvature: Float64Array;
  readonly ds: number;
  readonly halfWidth: number;
  readonly origin: [number, number];
  readonly texRes: number;
  /** Texture as float32 RGB, like the Python renderer's ``tex.astype(np.float32)``. */
  readonly tex: Float32Array;
  readonly texW: number;
  readonly texH: number;

  constructor(readonly id: string, json: TrackJson, image: DecodedImage) {
    this.n = json.curvature.length;
    this.cx = new Float64Array(this.n);
    this.cy = new Float64Array(this.n);
    this.nx = new Float64Array(this.n);
    this.ny = new Float64Array(this.n);
    this.heading = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.cx[i] = json.center[2 * i];
      this.cy[i] = json.center[2 * i + 1];
      this.nx[i] = json.normal[2 * i];
      this.ny[i] = json.normal[2 * i + 1];
      // tangent = (n_y, -n_x) exactly, so heading = atan2(t_y, t_x).
      this.heading[i] = Math.atan2(-this.nx[i], this.ny[i]);
    }
    this.curvature = Float64Array.from(json.curvature);
    this.ds = json.ds;
    this.halfWidth = json.half_width;
    this.origin = json.tex_origin;
    this.texRes = json.tex_res;
    this.texW = image.width;
    this.texH = image.height;
    this.tex = new Float32Array(image.width * image.height * 3);
    for (let i = 0, j = 0; i < image.width * image.height; i++, j += image.channels) {
      this.tex[3 * i] = image.data[j];
      this.tex[3 * i + 1] = image.data[j + 1];
      this.tex[3 * i + 2] = image.data[j + 2];
    }
  }

  get length(): number {
    return this.n * this.ds;
  }

  static async load(baseUrl: string, id: string, inflate: Inflate = browserInflate,
                    fetcher: (url: string) => Promise<ArrayBuffer> = defaultFetch): Promise<Track> {
    const [jsonBuf, pngBuf] = await Promise.all([fetcher(`${baseUrl}/${id}.json`),
                                                 fetcher(`${baseUrl}/${id}.png`)]);
    const json = JSON.parse(new TextDecoder().decode(jsonBuf)) as TrackJson;
    const image = await decodePng(new Uint8Array(pngBuf), inflate);
    return new Track(id, json, image);
  }

  /** Nearest centerline index search identical to the Python env (first minimum wins). */
  localize(x: number, y: number, prevIdx: number, fullSearch: boolean,
           window = 14): Localization {
    const n = this.n;
    let best = -1;
    let bestD2 = Infinity;
    for (let k = -window; k <= window; k++) {
      const j = pyMod(prevIdx + k, n);
      const dx = this.cx[j] - x;
      const dy = this.cy[j] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = j;
      }
    }
    if (fullSearch || bestD2 > (this.halfWidth + 8.0) ** 2) {
      bestD2 = Infinity;
      for (let j = 0; j < n; j++) {
        const dx = this.cx[j] - x;
        const dy = this.cy[j] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = j;
        }
      }
    }
    const half = Math.floor(n / 2);
    const step = pyMod(best - prevIdx + half, n) - half;
    const jumped = Math.abs(step) * this.ds > 10.0;
    const offset = (x - this.cx[best]) * this.nx[best] + (y - this.cy[best]) * this.ny[best];
    return {
      idx: best,
      offset,
      headingError: 0, // filled by the caller, which knows the car heading
      onGrass: Math.abs(offset) > this.halfWidth + 0.25,
      progressStep: fullSearch || jumped ? 0 : step * this.ds,
    };
  }
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.arrayBuffer();
}
