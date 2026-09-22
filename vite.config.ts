import { defineConfig, type Plugin } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Dev-only: POST /__debug/save?name=… writes the body to .samples/out (export validation). */
const debugSave: Plugin = {
  name: "debug-save",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__debug/save", (req, res) => {
      const name = new URL(req.url ?? "", "http://x").searchParams.get("name")?.replace(/[^\w.\-]/g, "_") ?? "out.bin";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        mkdirSync(".samples/out", { recursive: true });
        writeFileSync(`.samples/out/${name}`, Buffer.concat(chunks));
        res.end("ok");
      });
    });
  },
};

// Cross-origin isolation enables SharedArrayBuffer, i.e. multi-threaded WASM
// for ONNX Runtime's CPU fallback. The same headers are set on Vercel.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ command }) => ({
  plugins: [debugSave],
  // Use ORT's non-bundled build: it loads its runtime from env.wasm.wasmPaths
  // (public/ort, see scripts/copy-ort.mjs) instead of inlining it.
  // Build only: the dev server serves ORT unbundled and refuses imports from /public.
  resolve: command === "build"
    ? { alias: [{ find: /^onnxruntime-web$/, replacement: fileURLToPath(new URL("./node_modules/onnxruntime-web/dist/ort.min.mjs", import.meta.url)) }] }
    : {},
  define: { __ORT_EXTERNAL__: JSON.stringify(command === "build") },
  build: { target: "es2022", assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { headers: isolation },
  preview: { headers: isolation },
}));
