import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// GitHub Pages serves a project site from /<repo>/, so assets need that prefix.
// BASE_PATH lets the deploy workflow set it, and "/" is right for local dev and
// for a custom domain at the apex.
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
  resolve: {
    alias: { "@shared": path.join(repoRoot, "shared") },
  },
  server: {
    // shared/ lives above this app's root.
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The judge pulls in Transformers.js, which is large by nature. Raise the
    // warning limit rather than pretend the bundle is small.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // mem-test.html is a standalone, unlinked diagnostic page (not part of
      // the game) for manually isolating onnxruntime-web + the q4 model from
      // app code on a real device - see web/src/mem-test.js.
      input: {
        main: path.join(here, "index.html"),
        "mem-test": path.join(here, "mem-test.html"),
      },
    },
  },
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["@huggingface/transformers"],
  },
});
