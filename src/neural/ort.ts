/**
 * ONNX Runtime Web session management.
 *
 * Backend order: WebGPU EP (sharing the engine's GPUDevice, so tensors can stay
 * on the GPU as storage buffers) → WASM SIMD EP. Model precision follows the
 * device: true fp16 graphs when the adapter exposes shader-f16, otherwise
 * fp16-weight/fp32-compute graphs (same download size, runs everywhere).
 *
 * Models are fetched from this origin only and cached with the Cache API, so
 * after the first visit the app works offline and nothing leaves the device.
 */
import * as ort from "onnxruntime-web";
import type { Gpu } from "../gpu/gpu.ts";

export type Backend = "webgpu" | "wasm";

export interface ModelSpec {
  id: "scunet" | "nafnet" | "segformer" | "depth";
  /** File for WebGPU with shader-f16. */
  f16: string;
  /** File for everything else. */
  f32: string;
  /** Approximate bytes for progress reporting. */
  bytes: number;
}

export const MODELS: Record<ModelSpec["id"], ModelSpec> = {
  scunet: { id: "scunet", f16: "scunet.fp16.onnx", f32: "scunet.fp32w16.onnx", bytes: 39e6 },
  nafnet: { id: "nafnet", f16: "nafnet.fp16.onnx", f32: "nafnet.fp32w16.onnx", bytes: 35e6 },
  segformer: { id: "segformer", f16: "segformer-b0-ade.fp16.onnx", f32: "segformer-b0-ade.fp32.onnx", bytes: 8e6 },
  depth: { id: "depth", f16: "depth-anything-v2-small.q4f16.onnx", f32: "depth-anything-v2-small.q4.onnx", bytes: 20e6 },
};

const CACHE = "image-improver2-models-v1";

export class Neural {
  readonly backend: Backend;
  readonly f16: boolean;
  /** True when ORT runs on the engine's own device (zero-copy GPU tensors). */
  readonly sharedDevice: boolean;
  private base: string;
  onProgress?: (id: string, loaded: number, total: number) => void;

  private constructor(backend: Backend, f16: boolean, shared: boolean, base: string) {
    this.backend = backend;
    this.f16 = f16;
    this.sharedDevice = shared;
    this.base = base;
  }

  static async create(gpu: Gpu | undefined, base: string, forceWasm = false): Promise<Neural> {
    ort.env.logLevel = "error";
    const iso = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    const cores = (globalThis.navigator?.hardwareConcurrency ?? 2) | 0;
    ort.env.wasm.numThreads = iso ? Math.max(1, Math.min(4, cores - 1)) : 1;
    ort.env.wasm.simd = true;
    // Production loads ORT's runtime from /ort (see scripts/copy-ort.mjs); dev uses the package directly.
    if (__ORT_EXTERNAL__) ort.env.wasm.wasmPaths = base + "ort/";
    if (gpu && !forceWasm) {
      try {
        // ORT's WebGPU backend (JSEP) requests its own device from an adapter and
        // ignores env.webgpu.device. Hand it an adapter whose requestDevice()
        // returns the engine's device, so both share one GPUDevice and tile
        // tensors never leave the GPU.
        const a = gpu.adapter as GPUAdapter & { info?: GPUAdapterInfo };
        const shim = {
          limits: a.limits,
          features: a.features,
          info: a.info,
          isFallbackAdapter: false,
          requestDevice: async () => gpu.device,
          requestAdapterInfo: async () => a.info,
        };
        ort.env.webgpu.adapter = shim as unknown as GPUAdapter;
        return new Neural("webgpu", gpu.info.f16, true, base);
      } catch (e) {
        console.warn("ORT WebGPU unavailable, falling back to WASM", e);
      }
    }
    return new Neural("wasm", false, false, base);
  }

  modelFile(spec: ModelSpec): string {
    return this.backend === "webgpu" && this.f16 ? spec.f16 : spec.f32;
  }

  async fetchModel(spec: ModelSpec): Promise<Uint8Array> {
    const url = this.base + "models/" + this.modelFile(spec);
    let cache: Cache | undefined;
    try { cache = await caches.open(CACHE); } catch { /* private mode */ }
    const hit = await cache?.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Could not download ${spec.id} model (${res.status})`);
    const total = Number(res.headers.get("content-length")) || spec.bytes;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      this.onProgress?.(spec.id, loaded, total);
    }
    const out = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    try { await cache?.put(url, new Response(out.slice(), { headers: { "content-type": "application/octet-stream" } })); } catch { /* quota */ }
    return out;
  }

  async session(spec: ModelSpec, gpuOutput: boolean): Promise<ort.InferenceSession> {
    const bytes = await this.fetchModel(spec);
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: this.backend === "webgpu" ? ["webgpu"] : ["wasm"],
      graphOptimizationLevel: "all",
      enableMemPattern: this.backend === "wasm",
    };
    if (this.backend === "webgpu" && gpuOutput) opts.preferredOutputLocation = "gpu-buffer";
    return ort.InferenceSession.create(bytes, opts);
  }
}

export { ort };
