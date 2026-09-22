/**
 * Per-stage measurement: wall time, live and peak GPU memory (every engine
 * allocation is tracked in Gpu), and JS heap where the browser exposes it.
 * Safari does not expose heap size; the wasm heaps are reported separately.
 */
import type { Gpu } from "../gpu/gpu.ts";
import type { StageProfile } from "./protocol.ts";

const MB = 1048576;

export class Profiler {
  stages: StageProfile[] = [];
  private gpu?: Gpu;
  constructor(gpu?: Gpu) { this.gpu = gpu; }

  async time<T>(stage: string, f: () => Promise<T> | T, note?: (r: T) => string | undefined): Promise<T> {
    this.gpu?.resetPeak();
    const t0 = performance.now();
    const r = await f();
    if (this.gpu) await this.gpu.device.queue.onSubmittedWorkDone();
    const ms = performance.now() - t0;
    const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    this.stages.push({
      stage,
      ms: Math.round(ms),
      gpuLiveMB: this.gpu ? +(this.gpu.liveBytes() / MB).toFixed(1) : 0,
      gpuPeakMB: this.gpu ? +(this.gpu.peakBytes / MB).toFixed(1) : 0,
      heapMB: mem ? +(mem.usedJSHeapSize / MB).toFixed(0) : undefined,
      note: note?.(r),
    });
    return r;
  }

  add(stage: string, ms: number, note?: string) {
    this.stages.push({ stage, ms: Math.round(ms), gpuLiveMB: this.gpu ? +(this.gpu.liveBytes() / MB).toFixed(1) : 0, gpuPeakMB: this.gpu ? +(this.gpu.peakBytes / MB).toFixed(1) : 0, note });
  }
}
