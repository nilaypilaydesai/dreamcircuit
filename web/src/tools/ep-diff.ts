import * as ort from "onnxruntime-web/webgpu";

const out = document.getElementById("log")!;
const log = (s: string) => { out.insertAdjacentHTML("beforeend", `<div>${s}</div>`); console.log(s); };

(async () => {
  // ?model=debug_nopad reproduces the ONNX Runtime Web WebGPU Conv bug (no channel padding).
  const name = new URLSearchParams(location.search).get("model") ?? "debug_padded";
  log(`model: ${name}`);
  const order: { name: string; op: string; node: string; idx: number }[] =
    await (await fetch(`../diagnostics/${name}.json`)).json();
  const z = (n: number) => new Float32Array(n);
  const mk = () => ({
    x: new ort.Tensor("float32", z(3 * 64 * 64).map((_, i) => Math.sin(i)), [1, 3, 64, 64]),
    sigma: new ort.Tensor("float32", new Float32Array([1.0]), [1]),
    context: new ort.Tensor("float32", z(12 * 64 * 64), [1, 12, 64, 64]),
    actions: new ort.Tensor("float32", z(8), [1, 4, 2]),
    aug_sigma: new ort.Tensor("float32", z(1), [1]),
    mid_bias: new ort.Tensor("float32", z(192), [1, 192]),
  });
  const results: Record<string, Record<string, ort.Tensor>> = {};
  for (const ep of ["wasm", "webgpu"]) {
    const s = await ort.InferenceSession.create(`../diagnostics/${name}.onnx`, {
      executionProviders: [ep], graphOptimizationLevel: "disabled" });
    results[ep] = await s.run(mk());
    log(`${ep}: ran, ${Object.keys(results[ep]).length} outputs`);
  }
  let shown = 0;
  for (const o of order) {
    const a = results.wasm[o.name]?.data as Float32Array, b = results.webgpu[o.name]?.data as Float32Array;
    if (!a || !b || !(a instanceof Float32Array)) continue;
    let maxd = 0, maxa = 1e-6;
    for (let i = 0; i < a.length; i++) { maxd = Math.max(maxd, Math.abs(a[i] - b[i])); maxa = Math.max(maxa, Math.abs(a[i])); }
    const rel = maxd / maxa;
    if (rel > 1e-3 && shown < 12) {
      log(`DIVERGE #${o.idx} ${o.op} ${o.node} -> ${o.name}: max|d|=${maxd.toExponential(2)} rel=${rel.toExponential(2)} shape=${results.wasm[o.name].dims}`);
      shown++;
    }
  }
  log(shown === 0 ? "no divergence found" : "done");
})();
