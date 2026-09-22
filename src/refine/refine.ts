/**
 * Module: Mask/Depth Refinement.
 *
 *   in:  WorkingImage (full resolution), SceneMaps (network-resolution maps)
 *   out: RefinedMaps at the guide resolution R (≤ 768 px long edge):
 *          masks[0..2]  11 group probabilities + distance, snapped to image
 *                       edges with a colour guided filter (He et al. 2013)
 *                       guided by the photograph itself
 *          toneC/toneM  fast-guided-filter coefficients of log luminance at a
 *                       coarse and a medium radius — the edge-aware base
 *                       layers local tone mapping upsamples at render time
 *          guide, lin   the image at R (encoded / linear) for joint-bilateral
 *                       upsampling and statistics
 *
 * Full-resolution masks are never stored: the renderer upsamples these with a
 * joint bilateral filter against the full-resolution pixels, which is what
 * keeps roofs, hair and branches from bleeding.
 */
import { Gpu, Uniforms } from "../gpu/gpu.ts";
import refineHead from "../gpu/shaders/refine.wgsl?raw";
import refinePasses from "../gpu/shaders/refine_passes.wgsl?raw";
import downsampleWgsl from "../gpu/shaders/downsample.wgsl?raw";
import { box } from "./box.ts";
import { floatsToHalves } from "../gpu/half.ts";
import { NG, type SceneMaps } from "../neural/scene.ts";

export const GUIDE_LONG = 768;

export interface RefinedMaps {
  w: number;
  h: number;
  guide: GPUTexture; // rgba16float, encoded display RGB (gain k), a = clip
  lin: GPUTexture; // rgba16float, linear working
  masks: [GPUTexture, GPUTexture, GPUTexture]; // rgba32float
  toneC: GPUTexture; // rgba32float (a_c, b_c)
  toneM: GPUTexture; // rgba32float (…, a_m, b_m)
  params: { maskRadius: number; maskEps: number; depthEps: number; coarseRadius: number; coarseEps: number; mediumRadius: number; mediumEps: number };
}

export function guideSize(w: number, h: number): [number, number] {
  const s = Math.min(1, GUIDE_LONG / Math.max(w, h));
  return [Math.max(8, Math.round(w * s)), Math.max(8, Math.round(h * s))];
}

export async function downsample(gpu: Gpu, src: GPUTexture, sw: number, sh: number, dw: number, dh: number, encode: boolean, gain: number, label: string): Promise<GPUTexture> {
  const dst = gpu.tex(label, dw, dh, "rgba16float");
  await gpu.run("downsample", (enc, temp) => {
    const u = gpu.uniform(new Uniforms(8).u32(sw, sh, dw, dh, encode ? 1 : 0, 0).f32(gain, 0).bytes());
    temp.push(u);
    gpu.dispatch(enc, gpu.pipeline("downsample", downsampleWgsl), [u, dst.createView(), src.createView()], Math.ceil(dw / 16), Math.ceil(dh / 16));
  });
  return dst;
}

function uploadPlanes(gpu: Gpu, planes: Float32Array[], w: number, h: number, label: string): GPUTexture {
  const tex = gpu.tex(label, w, h, "rgba16float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
  const inter = new Float32Array(w * h * 4);
  for (let c = 0; c < 4; c++) {
    const pl = planes[c];
    if (!pl) continue;
    for (let i = 0; i < w * h; i++) inter[i * 4 + c] = pl[i];
  }
  gpu.device.queue.writeTexture({ texture: tex }, floatsToHalves(inter), { bytesPerRow: w * 8, rowsPerImage: h }, { width: w, height: h });
  return tex;
}

export async function refine(gpu: Gpu, work: GPUTexture, W: number, H: number, gain: number, scene: SceneMaps): Promise<RefinedMaps> {
  const [gw, gh] = guideSize(W, H);
  const guide = await downsample(gpu, work, W, H, gw, gh, true, gain, "refine.guide");
  const lin = await downsample(gpu, work, W, H, gw, gh, false, 1, "refine.lin");

  const { seg, depth } = scene;
  const plane = seg.width * seg.height;
  const pl = (k: number) => seg.probs.subarray(k * plane, (k + 1) * plane);
  const segT = [
    uploadPlanes(gpu, [pl(0), pl(1), pl(2), pl(3)], seg.width, seg.height, "seg0"),
    uploadPlanes(gpu, [pl(4), pl(5), pl(6), pl(7)], seg.width, seg.height, "seg1"),
    uploadPlanes(gpu, [pl(8), pl(9), pl(10)], seg.width, seg.height, "seg2"),
  ];
  void NG;
  const depthT = uploadPlanes(gpu, [depth.dist], depth.width, depth.height, "depth");
  const sampler = gpu.device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

  const long = Math.max(gw, gh);
  const params = {
    maskRadius: Math.max(2, Math.round(long * 0.007)),
    maskEps: 0.0025,
    depthEps: 0.0006,
    coarseRadius: Math.max(4, Math.round(long * 0.06)),
    coarseEps: 0.01, // log_enc units (1 EV = 0.05): edges of ≳ 2 EV are preserved
    mediumRadius: Math.max(2, Math.round(long * 0.016)),
    mediumEps: 0.0025,
  };
  const f32 = (l: string) => gpu.tex(l, gw, gh, "rgba32float");
  const code = refineHead + refinePasses;
  const pipe = (e: string) => gpu.pipeline("refine." + e, code, e);
  const uni = (temp: Array<GPUBuffer | GPUTexture>, eps: number, epsM = 0) => {
    const u = gpu.uniform(new Uniforms(8).u32(gw, gh).f32(eps, 1, epsM, 0, 0, 0).bytes());
    temp.push(u);
    return u;
  };
  const v = (t?: GPUTexture) => t?.createView();
  const X = Math.ceil(gw / 16), Y = Math.ceil(gh / 16);

  // Scratch textures reused across steps.
  // Eight scratch textures: box filters write back into their inputs (the
  // horizontal pass goes to the temps, the vertical pass back), which keeps the
  // refinement's transient memory ~30% lower on phones.
  const s = Array.from({ length: 8 }, (_, i) => f32("refine.scratch" + i));
  const P = [f32("refine.P0"), f32("refine.P1"), f32("refine.P2")];
  const masks = [f32("mask0"), f32("mask1"), f32("mask2")] as [GPUTexture, GPUTexture, GPUTexture];
  const mS = [f32("refine.mS0"), f32("refine.mS1"), f32("refine.mS2")];

  await gpu.run("refine.compose+guide", (enc, temp) => {
    const u = uni(temp, params.maskEps);
    gpu.dispatch(enc, pipe("compose"), [u, sampler, v(segT[0]), v(segT[1]), v(segT[2]), v(depthT), v(P[0]), v(P[1]), v(P[2])], X, Y);
    gpu.dispatch(enc, pipe("gstats"), [u, undefined, v(guide), undefined, undefined, undefined, v(s[0]), v(s[1]), v(s[2])], X, Y);
    box(gpu, enc, temp, gw, gh, params.maskRadius, [s[0], s[1], s[2]], [s[3], s[4], s[5]], mS);
  });
  for (let k = 0; k < 3; k++) {
    await gpu.run("refine.mask" + k, (enc, temp) => {
      // P2 carries distance: a tighter ε makes depth follow the photo's colour
      // edges closely, so a rim of background next to a subject does not
      // inherit the subject's distance (visible as a half-sharp fringe in DoF).
      const u = uni(temp, k === 2 ? params.depthEps : params.maskEps);
      gpu.dispatch(enc, pipe("pstats"), [u, undefined, v(guide), v(P[k]), undefined, undefined, v(s[0]), v(s[1]), v(s[2]), v(s[3])], X, Y);
      box(gpu, enc, temp, gw, gh, params.maskRadius, [s[0], s[1], s[2], s[3]], [s[4], s[5], s[6], s[7]], [s[0], s[1], s[2], s[3]]);
      gpu.dispatch(enc, pipe("solve"), [u, undefined, v(mS[0]), v(mS[1]), v(mS[2]), undefined, v(s[4]), v(s[5]), v(s[6]), v(s[7]), v(s[0]), v(s[1]), v(s[2]), v(s[3])], X, Y);
      box(gpu, enc, temp, gw, gh, params.maskRadius, [s[4], s[5], s[6], s[7]], [s[0], s[1], s[2], s[3]], [s[4], s[5], s[6], s[7]]);
      gpu.dispatch(enc, pipe("apply"), [u, undefined, v(guide), v(s[4]), v(s[5]), v(s[6]), v(masks[k]), undefined, undefined, undefined, v(s[7])], X, Y);
    });
  }
  const toneC = f32("toneC");
  const toneM = f32("toneM");
  await gpu.run("refine.tone", (enc, temp) => {
    const u = uni(temp, params.coarseEps, params.mediumEps);
    gpu.dispatch(enc, pipe("tstats"), [u, undefined, v(lin), undefined, undefined, undefined, v(s[0])], X, Y);
    box(gpu, enc, temp, gw, gh, params.coarseRadius, [s[0]], [s[1]], [s[2]]);
    box(gpu, enc, temp, gw, gh, params.mediumRadius, [s[0]], [s[1]], [s[3]]);
    gpu.dispatch(enc, pipe("tsolve"), [u, undefined, v(s[2]), v(s[3]), undefined, undefined, v(s[4])], X, Y);
    box(gpu, enc, temp, gw, gh, params.coarseRadius, [s[4]], [s[5]], [toneC]);
    box(gpu, enc, temp, gw, gh, params.mediumRadius, [s[4]], [s[6]], [toneM]);
  }, true);
  gpu.release(...s, ...P, ...mS, ...segT, depthT);
  return { w: gw, h: gh, guide, lin, masks, toneC, toneM, params };
}

export function releaseRefined(gpu: Gpu, r: RefinedMaps | undefined) {
  if (!r) return;
  gpu.release(r.guide, r.lin, ...r.masks, r.toneC, r.toneM);
}
