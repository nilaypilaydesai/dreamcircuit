// One ONNX Runtime Web inference at a time, page-wide. The WebGPU build runs every session inside
// a single asyncified WASM module, so a run() that starts while another one is suspended corrupts
// its stack ("RuntimeError: memory access out of bounds"), even when the two runs belong to
// different sessions, and every later run then fails too. The world model and the autopilot share
// that module, so all of their runs (and the circuit designer's, for symmetry) go through here.

let tail: Promise<unknown> = Promise.resolve();

/** Run ``fn`` after every inference queued before it has settled. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
