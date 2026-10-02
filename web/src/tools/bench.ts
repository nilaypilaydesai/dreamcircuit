import * as ort from "onnxruntime-web/webgpu";

const out = document.getElementById("log")!;
const log = (s: string) => { out.insertAdjacentHTML("beforeend", `<div>${s}</div>`); console.log(s); };

type Case = { model: string; ep: string | { name: string; [k: string]: unknown } };

async function bench(c: Case): Promise<void> {
  const label = `${c.model} / ${typeof c.ep === "string" ? c.ep : JSON.stringify(c.ep)}`;
  const sess = await ort.InferenceSession.create(`../models/${c.model}.onnx`, {
    executionProviders: [c.ep as ort.InferenceSession.ExecutionProviderConfig],
    graphOptimizationLevel: "all",
  });
  const z = (n: number) => new Float32Array(n);
  const feeds = {
    x: new ort.Tensor("float32", z(3 * 64 * 64).map((_, i) => Math.sin(i)), [1, 3, 64, 64]),
    sigma: new ort.Tensor("float32", new Float32Array([1.0]), [1]),
    context: new ort.Tensor("float32", z(12 * 64 * 64), [1, 12, 64, 64]),
    actions: new ort.Tensor("float32", z(8), [1, 4, 2]),
    aug_sigma: new ort.Tensor("float32", z(1), [1]),
    mid_bias: new ort.Tensor("float32", z(192), [1, 192]),
  };
  for (let i = 0; i < 5; i++) await sess.run(feeds);
  const n = 40;
  const t1 = performance.now();
  let res;
  for (let i = 0; i < n; i++) res = await sess.run(feeds);
  const ms = (performance.now() - t1) / n;
  log(`${label}: <b>${ms.toFixed(1)} ms</b>/call | out[0]=${(res!.x0.data as Float32Array)[0].toFixed(4)}`);
  await sess.release();
}

(async () => {
  const cases: Case[] = [
    { model: "denoiser", ep: "webgpu" },
    { model: "denoiser", ep: { name: "webgpu", preferredLayout: "NHWC" } },
    { model: "denoiser", ep: "wasm" },
  ];
  for (const c of cases) {
    try { await bench(c); } catch (e) { log(`${c.model} failed: ${e}`); }
  }
  log("done");
})();
