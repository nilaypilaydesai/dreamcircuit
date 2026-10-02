// The pixel autopilot: a small CNN distilled from the privileged expert ("learning by cheating").
// It only ever sees frames, so it can drive inside the dream as well as in reality.

import * as ort from "onnxruntime-web/webgpu";
import { rgbToChw } from "./engine";

export class Policy {
  private constructor(private readonly session: ort.InferenceSession, readonly frames: number) {}

  static async tryCreate(baseUrl: string, backend: string): Promise<Policy | null> {
    try {
      const res = await fetch(`${baseUrl}/policy.onnx`);
      // Dev servers answer unknown paths with index.html; only accept real model bytes.
      if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [backend], graphOptimizationLevel: "all",
      });
      return new Policy(session, 4);
    } catch (e) {
      console.warn("autopilot unavailable", e);
      return null;
    }
  }

  /** frames: the last 4 RGB frames, oldest first. Returns (steer, pedal). */
  async act(frames: Uint8Array[]): Promise<[number, number]> {
    const n = 3 * 64 * 64;
    const x = new Float32Array(this.frames * n);
    frames.slice(-this.frames).forEach((f, i) => rgbToChw(f, 64, x.subarray(i * n, (i + 1) * n)));
    const out = await this.session.run({ frames: new ort.Tensor("float32", x, [1, 3 * this.frames, 64, 64]) });
    const a = out.action.data as Float32Array;
    return [a[0], a[1]];
  }

  /** Same, but from CHW floats (the dream's own frames). */
  async actCHW(frames: Float32Array): Promise<[number, number]> {
    const out = await this.session.run({ frames: new ort.Tensor("float32", frames, [1, 3 * this.frames, 64, 64]) });
    const a = out.action.data as Float32Array;
    return [a[0], a[1]];
  }
}
