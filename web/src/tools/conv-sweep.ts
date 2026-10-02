import * as ort from "onnxruntime-web/webgpu";
const out = document.getElementById("log")!;
const log = (s: string) => { out.insertAdjacentHTML("beforeend", `<div>${s}</div>`); console.log(s); };
(async () => {
  const cases: { name: string; cin: number }[] = await (await fetch("../diagnostics/convtest/cases.json")).json();
  const bad: string[] = [];
  for (const c of cases) {
    const x = new Float32Array(c.cin * 64 * 64).map((_, i) => Math.sin(i * 0.37));
    const res: Record<string, Float32Array> = {};
    for (const ep of ["wasm", "webgpu"]) {
      const s = await ort.InferenceSession.create(`../diagnostics/convtest/${c.name}.onnx`, { executionProviders: [ep] });
      res[ep] = (await s.run({ x: new ort.Tensor("float32", x, [1, c.cin, 64, 64]) })).y.data as Float32Array;
    }
    let m = 0; for (let i = 0; i < res.wasm.length; i++) m = Math.max(m, Math.abs(res.wasm[i] - res.webgpu[i]));
    const ok = m < 1e-4;
    if (!ok) bad.push(c.name);
    log(`${c.name.padEnd(12)} webgpu-vs-wasm max|diff| = ${m.toExponential(1)} ${ok ? "ok" : "<b>WRONG</b>"}`);
  }
  log(`done. wrong: ${bad.join(", ") || "none"}`);
})();
