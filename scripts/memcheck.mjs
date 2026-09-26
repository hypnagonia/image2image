#!/usr/bin/env node
/**
 * Memory guard: runs the app's phone path in real WebKit (Safari on this Mac: the
 * same JavaScriptCore, WebAssembly and WebGPU as iPhone Safari) and fails when a
 * step needs more memory than an iPhone tab can have.
 *
 *   npm run memcheck                     build, then check the default photos
 *   npm run memcheck -- --no-build --photo IMG_1514.DNG --steps open,select
 *
 * How: `vite preview` serves the production build; Safari opens
 * /?autotest&phone&… (src/autotest.ts), which behaves exactly as on an iPhone
 * (src/device.ts), opens the sample by itself and reports every step to
 * .samples/out/autotest.jsonl. Meanwhile this script samples the physical
 * footprint (what iOS's memory limit counts) of the tab's WebContent process and
 * of Safari's GPU process (WebGPU memory, which iOS charges to the tab), and
 * keeps the peak per step. Budgets: scripts/memcheck.budget.json.
 *
 * Needs: macOS with Safari 26+ (WebGPU on). The iOS simulator has no WebGPU.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const budget = JSON.parse(readFileSync(new URL("./memcheck.budget.json", import.meta.url), "utf8"));
const photos = (opt("photo") ?? budget.photos.join(",")).split(",");
const steps = opt("steps", budget.steps.join(","));
const port = Number(opt("port", "5399"));
const REPORT = ".samples/out/autotest.jsonl";
const MB = 1024 * 1024;

const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
const pids = (re) => sh("pgrep", ["-f", re]).split("\n").filter(Boolean).map(Number);
/** Physical footprint in MB (what jetsam limits), or 0 when the process is gone. */
function footprint(pid) {
  const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(sh("footprint", ["-p", String(pid)]));
  if (!m) return 0;
  return Number(m[1]) * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1);
}
const SAFARI_WC = "StagedFrameworks/Safari/WebKit.framework.*com.apple.WebKit.WebContent";
const SAFARI_GPU = "StagedFrameworks/Safari/WebKit.framework.*com.apple.WebKit.GPU";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!flag("no-build")) {
  console.log("building…");
  execFileSync("npm", ["run", "build"], { stdio: "ignore" });
}
const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
process.on("exit", () => server.kill());
await sleep(2500);

let failed = false;
for (const photo of photos) {
  if (!existsSync(`.samples/${photo}`)) { console.log(`skip ${photo}: not in .samples`); continue; }
  rmSync(REPORT, { force: true });
  const before = new Set(pids(SAFARI_WC));
  const gpuPid0 = pids(SAFARI_GPU)[0];
  const gpuBase = gpuPid0 ? footprint(gpuPid0) : 0;
  const url = `http://127.0.0.1:${port}/?autotest&phone&close&photo=${encodeURIComponent(photo)}&steps=${steps}&run=${Date.now()}`;
  execFileSync("open", ["-g", "-a", "Safari", url]);
  console.log(`\n${photo}: ${steps}`);
  const peaks = new Map(); // step → { page, gpu, total }
  let stage = "load", done = "", message = "";
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < budget.timeoutSec * 1000) {
    await sleep(500);
    // The tab: the Safari WebContent processes that appeared for it (the biggest is the page).
    const mine = pids(SAFARI_WC).filter((p) => !before.has(p));
    const page = Math.max(0, ...mine.map(footprint));
    const gpuPid = pids(SAFARI_GPU)[0];
    const gpu = gpuPid ? Math.max(0, footprint(gpuPid) - (gpuPid === gpuPid0 ? gpuBase : 0)) : 0;
    if (existsSync(REPORT)) {
      const lines = readFileSync(REPORT, "utf8").trim().split("\n").filter(Boolean);
      for (const l of lines.slice(seen)) {
        const r = JSON.parse(l);
        if (r.stage.endsWith(":start")) stage = r.stage.slice(0, -6);
        if (r.stage === "done" || r.stage === "failed") { done = r.stage; message = r.message ?? ""; }
        if (r.stage === "error") message = r.message;
        if (r.stage === "start" && (!r.gpu || !r.isolated)) { done = "failed"; message = `browser: WebGPU ${r.gpu}, cross-origin isolated ${r.isolated}`; }
      }
      seen = lines.length;
    }
    const p = peaks.get(stage) ?? { page: 0, gpu: 0, total: 0 };
    peaks.set(stage, { page: Math.max(p.page, page), gpu: Math.max(p.gpu, gpu), total: Math.max(p.total, page + gpu) });
    if (done) break;
  }
  if (!done) { done = "failed"; message = `timeout after ${budget.timeoutSec}s in ${stage}`; }
  const rows = [...peaks.entries()].map(([s, p]) => {
    const limit = budget.stepMB[s] ?? budget.totalMB;
    const over = p.total > limit;
    if (over) failed = true;
    return `  ${s.padEnd(10)} tab ${String(Math.round(p.page)).padStart(5)} MB  gpu ${String(Math.round(p.gpu)).padStart(5)} MB  total ${String(Math.round(p.total)).padStart(5)} MB  / ${limit}${over ? "  ✗ OVER" : ""}`;
  });
  console.log(rows.join("\n"));
  if (done === "failed") { failed = true; console.log(`  ✗ ${message}`); } else console.log("  ✓ all steps ran");
  await sleep(2000);
}
server.kill();
console.log(failed ? "\nmemcheck FAILED" : "\nmemcheck passed");
process.exit(failed ? 1 : 0);
