/// <reference lib="webworker" />
/**
 * Scene analysis (segmentation + depth) in its own short-lived worker, on the
 * CPU. ONNX Runtime's wasm memory grows to several hundred MB for the depth
 * network and can never shrink; kept in the engine worker it stayed for the
 * life of the tab and phones ran out of memory right after the first preview.
 * Here it runs, answers once, and the worker is terminated: all of it returned.
 *
 * In:  { img: AnalysisImage, base, detailTiles }   Out: { maps: SceneMaps } | { error }
 */
import { Neural } from "./ort.ts";
import { analyseScene, type AnalysisImage, type SceneMaps } from "./scene.ts";

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (ev: MessageEvent<{ img: AnalysisImage; base: string; detailTiles: boolean }>) => {
  try {
    const { img, base, detailTiles } = ev.data;
    const neural = await Neural.create(undefined, base, true);
    const maps: SceneMaps = await analyseScene(neural, img, (stage) => post({ stage }), true, detailTiles, "wasm");
    post({ maps }, [maps.seg.probs.buffer, maps.depth.dist.buffer, maps.depth.raw.buffer]);
  } catch (e) {
    post({ error: e instanceof Error ? e.message : String(e) });
  }
};
