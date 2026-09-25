/**
 * Fast GPU denoise (denoise.wgsl): a full-frame, noise-profile-driven
 * edge-preserving filter. Milliseconds at 12 MP — the app's denoiser.
 */
import { Gpu, Uniforms } from "../gpu/gpu.ts";
import denoiseWgsl from "../gpu/shaders/denoise.wgsl?raw";
import type { NoiseProfile } from "../analysis/types.ts";

export async function denoiseGPU(gpu: Gpu, src: GPUTexture, w: number, h: number, gain: number, noise: NoiseProfile): Promise<GPUTexture> {
  const out = gpu.tex("denoised", w, h, "rgba16float");
  const sig = noise.bins.map((b) => (b.blocks >= 4 && Number.isFinite(b.sigma) ? b.sigma : noise.mid));
  const u = new Uniforms(16).u32(w, h, 0, 0).f32(gain, noise.chroma || noise.mid, 0, 0).f32(...sig);
  await gpu.run("denoise.gpu", (enc, temp) => {
    const ub = gpu.uniform(u.bytes(), "denoise.u");
    temp.push(ub);
    gpu.dispatch(enc, gpu.pipeline("denoise.gpu", denoiseWgsl), [ub, src.createView(), out.createView()], Math.ceil(w / 8), Math.ceil(h / 8));
  }, true);
  return out;
}
