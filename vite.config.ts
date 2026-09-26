import { defineConfig, type Plugin } from "vite";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
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

/**
 * Build-only: writes dist/sw.js from scripts/sw.template.js with this build's
 * app shell (everything in dist except /models and /ort, which are cached at
 * run time) and a version derived from the shell's contents.
 */
const serviceWorker: Plugin = {
  name: "service-worker",
  apply: "build",
  closeBundle() {
    const dist = fileURLToPath(new URL("./dist", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const abs = join(d, f);
        const rel = "/" + relative(dist, abs).split("\\").join("/");
        if (rel === "/models" || rel === "/ort" || rel === "/sw.js" || rel.endsWith(".txt")) continue;
        if (statSync(abs).isDirectory()) walk(abs); else files.push(rel);
      }
    };
    walk(dist);
    files.sort();
    const hash = createHash("sha256");
    for (const f of files) hash.update(f).update(readFileSync(join(dist, f)));
    const precache = ["/", ...files.filter((f) => f !== "/index.html")];
    const sw = readFileSync(new URL("./scripts/sw.template.js", import.meta.url), "utf8")
      .replace("__VERSION__", JSON.stringify(hash.digest("hex").slice(0, 12)))
      .replace("__PRECACHE__", JSON.stringify(precache));
    writeFileSync(join(dist, "sw.js"), sw);
  },
};

// Cross-origin isolation enables SharedArrayBuffer, i.e. multi-threaded WASM
// for ONNX Runtime's CPU fallback. The same headers are set on Vercel.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ command }) => ({
  plugins: [debugSave, serviceWorker],
  // Use ORT's non-bundled build: it loads its runtime from env.wasm.wasmPaths
  // (public/ort, see scripts/copy-ort.mjs) instead of inlining it.
  // Build only: the dev server serves ORT unbundled and refuses imports from /public.
  resolve: command === "build"
    ? { alias: [{ find: /^onnxruntime-web$/, replacement: fileURLToPath(new URL("./node_modules/onnxruntime-web/dist/ort.min.mjs", import.meta.url)) }] }
    : {},
  define: { __ORT_EXTERNAL__: JSON.stringify(command === "build"), __BUILD__: JSON.stringify(Date.now().toString(36)) },
  build: { target: "es2022", assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { headers: isolation },
  preview: { headers: isolation },
}));
