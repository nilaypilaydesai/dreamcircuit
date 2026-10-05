import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Cross-origin isolation enables multi-threaded WASM (the fallback when WebGPU is missing).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** The pages' films and posters (public/media) linked with a hash of what is in them, ?v=...: a
 * new cut kept the old one's URL, so a browser that had it cached went on showing the old film
 * (or, with the start of the old file cached and the rest from the new one, could play neither). */
function versionedMedia(): Plugin {
  const known = new Map<string, string>(); // (by size and time: the dev server rehashes a changed file)
  const version = (file: string): string | null => {
    const path = resolve(import.meta.dirname, "public/media", file);
    let key: string;
    try {
      const st = statSync(path);
      key = `${file}:${st.size}:${st.mtimeMs}`;
    } catch {
      return null; // (no such file: the link is left as it is)
    }
    if (!known.has(key)) known.set(key, createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 10));
    return known.get(key)!;
  };
  return {
    name: "versioned-media",
    transformIndexHtml: (html) => html.replace(/(["'])media\/([\w.-]+\.(?:mp4|jpg|png))\1/g, (whole, q: string, file: string) => {
      const v = version(file);
      return v ? `${q}media/${file}?v=${v}${q}` : whole;
    }),
  };
}

export default defineConfig({
  base: "./",
  plugins: [versionedMedia()],
  server: { headers: isolation },
  preview: { headers: isolation },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        data: resolve(import.meta.dirname, "data.html"),
      },
    },
  },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  // whole races run headlessly in the tests, several to a test: give a slow machine room, and let
  // the tests collect garbage between them (tests/game.test.ts), so each race's ground texture
  // (35 MB, outside the JS heap) is freed as it goes instead of piling up into gigabytes
  test: { testTimeout: 60_000, execArgv: ["--expose-gc"] },
});
