/// <reference lib="webworker" />
/** Worker entry: all decoding, GPU work and inference happen here, off the UI thread. */
import { Engine } from "./engine.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { MAX_FOCUS_POINTS } from "../decision/params.ts";

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const engine = new Engine(post);

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  // Cheap, idempotent messages are handled immediately; heavy ones are serialised.
  if (m.type === "params") { engine.setParams(m.params, m.draft); return; }
  if (m.type === "view") { engine.setView(m.view, m.before, m.region); return; }
  if (m.type === "preview-size") { engine.setPreviewSize(m.long); return; }
  // Heavy work shares the engine's serial GPU queue with preview renders.
  engine.exclusive(() => handle(m)).catch((e: unknown) => {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    console.error(e);
  });
};

async function handle(m: ToWorker) {
  switch (m.type) {
    case "init": {
      const caps = await engine.init(m.base, m.forceCpu);
      post({ type: "ready", caps, looks: engine.looks() });
      break;
    }
    case "open":
      await engine.open(m.file, m.resolution, m.autoExposure, m.autoDof, m.upscale);
      break;
    case "upscale-now":
      engine.forceUpscale();
      break;
    case "focus": {
      const s = engine.session;
      if (!s) break;
      let points = [...s.params.dof.points];
      if (m.action === "clear") {
        points = [];
      } else {
        // Tapping an existing point removes it; anywhere else adds one.
        const hit = points.findIndex((p) => Math.hypot(p.x - m.x, p.y - m.y) < 0.045);
        if (hit >= 0) points.splice(hit, 1);
        else {
          const d = engine.focusAt(m.x, m.y);
          if (d === undefined) break;
          points.push({ x: m.x, y: m.y, dist: d });
          if (points.length > MAX_FOCUS_POINTS) points.shift();
        }
      }
      const dof = { ...s.params.dof, points, strength: s.params.dof.strength > 0 ? s.params.dof.strength : 0.5 };
      s.params = { ...s.params, dof, enable: { ...s.params.enable, dof: s.params.enable.dof || points.length > 0 } };
      post({ type: "params", params: s.params });
      await engine.renderNow(true);
      break;
    }
    case "export": {
      const r = await engine.export(m.format, m.quality, m.space, m.stripRows);
      post({ type: "exported", blob: r.blob, name: r.name, ms: r.ms });
      break;
    }
    case "restore":
      await engine.forceRestore({ scunet: m.scunet, nafnet: m.nafnet });
      break;
    case "thumbs":
      post({ type: "thumbs", items: await engine.thumbnails(m.profiles, m.long) });
      break;
    case "palette":
      post({ type: "palette", stats: await engine.palette() });
      break;
    case "reference": {
      const r = await engine.reference(m.file, m.mode, m.amount);
      post({ type: "lookProfile", profile: r.profile, reference: r.reference, message: r.message });
      break;
    }
    case "importLook":
      post({ type: "looks", looks: engine.importLook(m.name, m.text) });
      break;
  }
}
