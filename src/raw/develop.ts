/**
 * Module: RAW Development.
 *
 *   in:  DecodedImage (sensor integers + DNG colour metadata, or display RGB)
 *   out: WorkingImage — rgba16float texture, linear Rec.2020 D65, scene-referred,
 *        upright; alpha = fraction of the pixel clipped in the source.
 *
 * Strip-wise upload keeps GPU memory at one output texture plus a small strip.
 */
import { Gpu, Uniforms } from "../gpu/gpu.ts";
import developWgsl from "../gpu/shaders/develop.wgsl?raw";
import linearizeWgsl from "../gpu/shaders/linearize.wgsl?raw";
import { solveCameraColor, type CameraColor } from "../color/dng.ts";
import { P3_TO_REC2020, SRGB_TO_REC2020 } from "../color/spaces.ts";
import { IDENTITY } from "../color/mat3.ts";
import type { DecodedImage, RawSource, RgbSource } from "../decode/types.ts";

export interface WorkingImage {
  tex: GPUTexture;
  width: number;
  height: number;
  /** Scene-referred (RAW) or display-referred (HEIC/JPEG) origin. */
  referred: "scene" | "display";
  camera?: CameraColor;
  factor: number;
  log: string[];
}

export interface DevelopOptions {
  /** Integer downscale applied during development (1 = full resolution). */
  factor: number;
  /** Camera-space neutral override (white-balance refinement re-develop). */
  neutral?: readonly number[];
}

const STRIP_ROWS = 256;

export async function develop(gpu: Gpu, img: DecodedImage, opt: DevelopOptions): Promise<WorkingImage> {
  return img.source.kind === "rgb" ? linearize(gpu, img.source) : developRaw(gpu, img.source, img.meta.orientation, opt);
}

async function developRaw(gpu: Gpu, src: RawSource, orientation: number, opt: DevelopOptions): Promise<WorkingImage> {
  const f = Math.max(1, Math.floor(opt.factor));
  const cam = solveCameraColor(src.color, opt.neutral);
  const W = src.width, H = src.height;
  const outW = Math.floor(W / f), outH = Math.floor(H / f);
  const rot = orientation >= 5;
  const tex = gpu.tex("working", rot ? outH : outW, rot ? outW : outH, "rgba16float");
  const isBayer = src.kind === "bayer";
  const apron = isBayer ? 2 : 0;
  const stripRows = Math.max(f, Math.floor(STRIP_ROWS / f) * f);
  const stripH = stripRows + 2 * apron;
  const format: GPUTextureFormat = isBayer ? "r16uint" : "rgba16uint";
  const stripTex = gpu.tex("develop.strip", W, stripH, format, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
  const pipe = gpu.pipeline("develop", developWgsl, isBayer ? "bayer" : "linear");
  const expScale = Math.pow(2, cam.baselineExposure);
  const inv = src.white.map((w, i) => 1 / Math.max(1, w - src.black[i]));
  const view = tex.createView();
  const stripView = stripTex.createView();
  // Staging for 3-sample LinearRaw (expanded to 4) — not needed for 1 or 4.
  const expand = src.channels === 3 ? new Uint16Array(W * stripH * 4) : undefined;

  let strip = 0;
  for (let y0 = 0; y0 < outH * f; y0 += stripRows) {
    // writeTexture copies at once and the GPU consumes later: without a pause every
    // strip would be queued at once (≈ 390 MB for a 48 MP file, a phone's limit).
    if (++strip % 4 === 0) await gpu.device.queue.onSubmittedWorkDone();
    const own1 = Math.min(y0 + stripRows, outH * f);
    const first = Math.max(0, y0 - apron);
    const last = Math.min(H, own1 + apron);
    const rows = last - first;
    // Upload rows [first, last) of the active area.
    const rowSamples = src.pitch;
    const base = (src.top + first) * rowSamples + src.left * src.channels;
    if (src.channels === 3 && expand) {
      for (let r = 0; r < rows; r++) {
        const so = base + r * rowSamples;
        for (let x = 0; x < W; x++) {
          const d = (r * W + x) * 4, s = so + x * 3;
          expand[d] = src.data[s]; expand[d + 1] = src.data[s + 1]; expand[d + 2] = src.data[s + 2]; expand[d + 3] = 0;
        }
      }
      gpu.device.queue.writeTexture({ texture: stripTex }, expand, { bytesPerRow: W * 8, rowsPerImage: rows }, { width: W, height: rows });
    } else {
      const bpp = src.channels * 2;
      gpu.device.queue.writeTexture(
        { texture: stripTex },
        src.data.buffer as ArrayBuffer,
        { offset: src.data.byteOffset + base * 2, bytesPerRow: rowSamples * 2, rowsPerImage: rows },
        { width: W, height: rows },
      );
      void bpp;
    }
    const u = new Uniforms(64)
      .u32(W, H).i32(first).u32(y0, own1, f, outW, outH, orientation, stripH, 0, 0)
      .align(4).u32(...src.cfa)
      .f32(...src.black).f32(...inv)
      .f32(cam.gains[0], cam.gains[1], cam.gains[2], expScale)
      .mat3(cam.cameraToWorking);
    await gpu.run("develop.strip", (enc, temp) => {
      const ub = gpu.uniform(u.bytes(), "develop.u");
      temp.push(ub);
      gpu.dispatch(enc, pipe, [ub, view, stripView], Math.ceil(outW / 16), Math.ceil((own1 - y0) / f / 8));
    });
  }
  await gpu.device.queue.onSubmittedWorkDone();
  gpu.release(stripTex);
  const log = [
    `${src.isProRaw ? "Apple ProRAW (LinearRaw, already demosaiced/fused)" : src.kind === "bayer" ? "Bayer CFA — Malvar-He-Cutler demosaic" : "LinearRaw"} ${W}×${H}` +
      (f > 1 ? `, developed at 1/${f} (${outW}×${outH})` : ""),
    `black ${src.black.slice(0, 3).map((b) => b.toFixed(0)).join("/")} white ${src.white.slice(0, 3).join("/")}; orientation ${orientation}`,
    `WB gains (camera) ${cam.gains.map((g) => g.toFixed(3)).join(" ")}; baseline exposure ${cam.baselineExposure.toFixed(2)} EV`,
    ...cam.log,
  ];
  return { tex, width: rot ? outH : outW, height: rot ? outW : outH, referred: "scene", camera: cam, factor: f, log };
}

async function linearize(gpu: Gpu, src: RgbSource): Promise<WorkingImage> {
  const W = src.width, H = src.height;
  let primaries = src.colorSpace === "display-p3" ? P3_TO_REC2020 : src.colorSpace === "rec2020" ? IDENTITY : SRGB_TO_REC2020;
  const wide = !("close" in src.pixels) && src.pixels.data instanceof Uint16Array;
  const bits = !("close" in src.pixels) ? src.pixels.bits : 8;
  // 10/16-bit HEIF arrives as integers: rgba16uint keeps them exact (rgba16float
  // would mean a full-frame conversion on the CPU first).
  const input = gpu.tex("rgb.input", W, H, wide ? "rgba16uint" : "rgba8unorm",
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT);
  if ("close" in src.pixels) {
    // Ask the browser to colour-manage into Display P3 on upload.
    gpu.device.queue.copyExternalImageToTexture({ source: src.pixels }, { texture: input, colorSpace: "display-p3" }, { width: W, height: H });
    primaries = P3_TO_REC2020;
  } else {
    const px = src.pixels;
    gpu.device.queue.writeTexture({ texture: input }, px.data as Uint8Array<ArrayBuffer>, { bytesPerRow: W * (wide ? 8 : 4), rowsPerImage: H }, { width: W, height: H });
  }
  // The gain map is one byte per pixel at its own (usually half) size.
  const g = src.gain;
  const gainTex = gpu.tex("rgb.gain", g ? g.width : 1, g ? g.height : 1, "r8unorm", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
  if (g) gpu.device.queue.writeTexture({ texture: gainTex }, g.data as Uint8Array<ArrayBuffer>, { bytesPerRow: g.width, rowsPerImage: g.height }, { width: g.width, height: g.height });
  const tex = gpu.tex("working", W, H, "rgba16float");
  const u = new Uniforms(40).u32(W, H, 0, (1 << bits) - 1).mat3(primaries).f32(g ? g.headroom : 1, g ? g.width : 1, g ? g.height : 1, g ? 1 : 0);
  await gpu.run("linearize", (enc, temp) => {
    const ub = gpu.uniform(u.bytes());
    temp.push(ub);
    // Each entry point uses only one of the two source textures; the other
    // binding is left out (the pipeline layout is derived from the entry point).
    gpu.dispatch(enc, gpu.pipeline("linearize" + (wide ? ".u16" : ""), linearizeWgsl, wide ? "main_u16" : "main"),
      [ub, tex.createView(), wide ? undefined : input.createView(), wide ? input.createView() : undefined, gainTex.createView()],
      Math.ceil(W / 16), Math.ceil(H / 16));
  }, true);
  gpu.release(input, gainTex);
  return {
    tex, width: W, height: H, referred: "display", factor: 1,
    log: [`${src.decoder === "native" ? "Native" : "libheif"} decode ${W}×${H} at ${bits} bit, ${src.colorSpace} → linear Rec.2020` +
      (g ? `; HDR gain map ${g.width}×${g.height}, headroom ${g.headroom.toFixed(2)}× (+${Math.log2(g.headroom).toFixed(2)} EV)` : " (display-referred: no highlight headroom above the encoded white)")],
  };
}
