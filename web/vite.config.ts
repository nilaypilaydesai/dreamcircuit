import { defineConfig } from "vite";

// Cross-origin isolation enables multi-threaded WASM (the fallback when WebGPU is missing).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
