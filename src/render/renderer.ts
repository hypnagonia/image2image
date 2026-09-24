/**
 * Modules: Exposure/Tone Engine, Camera Color Engine (stages B/C),
 * Semantic/Depth Processing, Optional Depth of Field, output transform.
 *
 *   in:  base + denoised working textures (full res or preview proxy),
 *        RefinedMaps, Params
 *   out: rgba8unorm (display/JPEG) or rgba16float (16-bit export) texture
 *
 * Resolution-independent: the same passes render the preview proxy and the
 * full-resolution export, so what is seen is what is saved.
 */
import { Gpu, Uniforms } from "../gpu/gpu.ts";
import toneWgsl from "../gpu/shaders/render_tone.wgsl?raw";
import detailWgsl from "../gpu/shaders/render_detail.wgsl?raw";
import dofWgsl from "../gpu/shaders/render_dof.wgsl?raw";
import outputWgsl from "../gpu/shaders/output.wgsl?raw";
import { floatsToHalves } from "../gpu/half.ts";
import { CURVE_LUT_SIZE, TONE_LUT_SIZE, curveLUT, isFlat, toneCurveLUT } from "./curves.ts";
import { buildLUT, LOOKS, type Look } from "./looks.ts";
import { DEPTH_CURVE_SIZE, HUE_CURVE_SIZE, PROFILE_CURVE_SIZE, depthTable, hueCurveTable, profileCurveTable, profileUniforms, isNeutral } from "../looks/profile.ts";
import { GROUPS } from "../neural/scene.ts";
import type { Params } from "../decision/params.ts";
import type { RefinedMaps } from "../refine/refine.ts";

export interface RenderSource {
  base: GPUTexture;
  denoised: GPUTexture; // may be the same texture as base
  width: number;
  height: number;
  /** Width of the full-resolution image (for scaling pixel radii). */
  fullWidth: number;
  /** Apple's skin matte from a ProRAW file, in image coordinates (optional). */
  skin?: GPUTexture;
}

export interface RenderOptions {
  wb: number[]; // 3×3 working-space white balance
  gain: number; // analysis/guide encoding gain k
  lightLinear: [number, number, number];
  output: "srgb8" | "p38" | "p3f16";
  debugView?: 0 | 1 | 2 | 3 | 4 | 5;
  /** Depth range highlighted by debug view 5. */
  zoneRange?: [number, number];
  /** Region index highlighted by debug view 4. */
  region?: number;
  dither?: boolean;
}

const MIDDLE_GREY_EV = Math.log2(0.18);

export class Renderer {
  private gpu: Gpu;
  private toneLut?: GPUTexture;
  private curveLut?: GPUTexture;
  private look?: GPUTexture;
  private lookKey = "";
  private toneKey = "";
  private curveKey = "";
  private sampler: GPUSampler;
  private customLooks = new Map<string, Look>();
  private profCurve?: GPUTexture;
  private profCurveKey = "";
  private depthTab?: GPUTexture;
  private depthKey = "";
  private hueTab?: GPUTexture;
  private skinDummy?: GPUTexture;

  /** A 1×1 "no skin here" texture for photographs without an Apple matte. */
  private noSkin(): GPUTexture {
    this.skinDummy ??= this.gpu.tex("skin.none", 1, 1, "r8unorm", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    return this.skinDummy;
  }
  private hueKey = "";

  constructor(gpu: Gpu) {
    this.gpu = gpu;
    this.sampler = gpu.device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
  }

  addLook(l: Look) { this.customLooks.set(l.id, l); }
  looks(): Look[] { return [...LOOKS, ...this.customLooks.values()]; }

  private ensureLuts(p: Params) {
    const gpu = this.gpu;
    const tk = JSON.stringify(p.tone);
    if (tk !== this.toneKey) {
      this.toneKey = tk;
      if (!this.toneLut) this.toneLut = gpu.tex("toneLUT", TONE_LUT_SIZE, 1, "rgba16float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
      gpu.device.queue.writeTexture({ texture: this.toneLut }, floatsToHalves(toneCurveLUT(p.tone)), { bytesPerRow: TONE_LUT_SIZE * 8 }, { width: TONE_LUT_SIZE, height: 1 });
    }
    const ck = JSON.stringify(p.curves);
    if (ck !== this.curveKey) {
      this.curveKey = ck;
      if (!this.curveLut) this.curveLut = gpu.tex("curveLUT", CURVE_LUT_SIZE, 1, "rgba16float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
      gpu.device.queue.writeTexture({ texture: this.curveLut }, floatsToHalves(curveLUT(p.curves)), { bytesPerRow: CURVE_LUT_SIZE * 8 }, { width: CURVE_LUT_SIZE, height: 1 });
    }
    // Profile components, cached by content: switching between loaded profiles
    // re-uploads nothing unless a component actually differs.
    const prof = p.profile;
    const pk = JSON.stringify([prof.tone, prof.rgbCurves]);
    if (pk !== this.profCurveKey) {
      this.profCurveKey = pk;
      if (!this.profCurve) this.profCurve = gpu.tex("profileCurve", PROFILE_CURVE_SIZE, 1, "rgba16float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
      gpu.device.queue.writeTexture({ texture: this.profCurve }, floatsToHalves(profileCurveTable(prof)), { bytesPerRow: PROFILE_CURVE_SIZE * 8 }, { width: PROFILE_CURVE_SIZE, height: 1 });
    }
    const dk = JSON.stringify(prof.depth);
    if (dk !== this.depthKey) {
      this.depthKey = dk;
      if (!this.depthTab) this.depthTab = gpu.tex("profileDepth", DEPTH_CURVE_SIZE, 2, "rgba16float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
      gpu.device.queue.writeTexture({ texture: this.depthTab }, floatsToHalves(depthTable(prof)), { bytesPerRow: DEPTH_CURVE_SIZE * 8, rowsPerImage: 2 }, { width: DEPTH_CURVE_SIZE, height: 2 });
    }
    const hk = JSON.stringify([prof.hueCurves, prof.satByLum]); // both live in this table
    if (hk !== this.hueKey) {
      this.hueKey = hk;
      if (!this.hueTab) this.hueTab = gpu.tex("profileHue", HUE_CURVE_SIZE, 2, "rgba16float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
      gpu.device.queue.writeTexture({ texture: this.hueTab }, floatsToHalves(hueCurveTable(prof)), { bytesPerRow: HUE_CURVE_SIZE * 8, rowsPerImage: 2 }, { width: HUE_CURVE_SIZE, height: 2 });
    }
    const look = (prof.lut.id && this.looks().find((l) => l.id === prof.lut.id)) || LOOKS[0];
    // Imported tables keep their native size (17/33/65); procedural looks use the profile's size.
    const size = (look.table ? (look.table.size >= 65 ? 65 : look.table.size >= 33 ? 33 : 17) : prof.lut.size) as 17 | 33 | 65;
    const lk = look.id + "|" + size;
    if (lk !== this.lookKey) {
      this.lookKey = lk;
      gpu.release(this.look);
      this.look = gpu.tex("look3D", size, size, "rgba16float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, "3d", size);
      gpu.device.queue.writeTexture({ texture: this.look }, floatsToHalves(buildLUT(look, size)), { bytesPerRow: size * 8, rowsPerImage: size }, { width: size, height: size, depthOrArrayLayers: size });
    }
    return { size, identity: look.id === "neutral" || !prof.lut.id };
  }

  private toneUniforms(p: Params, src: RenderSource, maps: RefinedMaps, o: RenderOptions, lutSize: number, lutOn: boolean): ArrayBuffer {
    const e = p.enable;
    const bits = (e.denoise ? 1 : 0) | (e.wb ? 2 : 0) | (e.exposure ? 4 : 0) | (e.localTone ? 8 : 0) | (e.semantic ? 16 : 0) | (e.dehaze ? 32 : 0) | (e.sharpen ? 64 : 0);
    const u = new Uniforms(176)
      .u32(src.width, src.height, maps.w, maps.h)
      .mat3(o.wb)
      .f32(p.exposure, o.gain, p.denoise.luma, p.denoise.chroma)
      .f32(p.denoise.shadowBoost, p.dehaze.strength, p.dehaze.beta, p.dehaze.minT)
      .f32(o.lightLinear[0], o.lightLinear[1], o.lightLinear[2], 0)
      .f32(p.local.compression, p.local.clarity, p.local.texture, p.local.anchorEV ?? MIDDLE_GREY_EV)
      .f32(p.tone.shadows, p.tone.highlights, p.depth.near, p.depth.far)
      .f32(p.color.saturation, p.color.vibrance, o.region ?? 0, lutSize)
      .u32(bits, e.curves && !(isFlat(p.curves.l) && isFlat(p.curves.r) && isFlat(p.curves.g) && isFlat(p.curves.b)) ? 1 : 0, lutOn ? 1 : 0, o.debugView ?? 0);
    for (const g of GROUPS) {
      const s = p.semantic[g];
      u.f32(s.exposure, s.highlights, s.saturation, s.vibrance);
      u.f32((s.hue * Math.PI) / 180, s.clarity, s.texture, s.sharpen);
      u.f32(s.denoise, s.dehaze, s.warmth ?? 0, s.tint ?? 0);
    }
    return u.bytes();
  }

  // ------------------------------------------------------------------ targets
  /** Render targets are reused across renders (no per-frame allocation churn). */
  private targets = new Map<string, GPUTexture>();
  /** Cached by name, format *and* size, so preview, draft and thumbnail renders
   * (different sizes) don't reallocate each other's targets. Oldest entries are
   * evicted beyond a small budget. */
  private target(name: string, w: number, h: number, fmt: GPUTextureFormat): GPUTexture {
    const key = `${name}|${fmt}|${w}x${h}`;
    let t = this.targets.get(key);
    if (t) {
      this.targets.delete(key);
      this.targets.set(key, t); // most recently used last
      return t;
    }
    t = this.gpu.tex(`render.${name}`, w, h, fmt, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    this.targets.set(key, t);
    while (this.targets.size > 18) {
      const [k, old] = this.targets.entries().next().value as [string, GPUTexture];
      this.targets.delete(k);
      this.gpu.release(old);
    }
    return t;
  }
  /** Frees all cached render targets (after an export, or when a photo closes). */
  releaseTargets() {
    for (const t of this.targets.values()) this.gpu.release(t);
    this.targets.clear();
  }

  private toneDispatch(enc: GPUCommandEncoder, temp: Array<GPUBuffer | GPUTexture>, src: RenderSource, maps: RefinedMaps, p: Params, o: RenderOptions,
    lutSize: number, lutOn: boolean, profileOn: boolean, dst: GPUTexture, distT: GPUTexture, ty0: number, th: number) {
    const gpu = this.gpu;
    // Tone uniforms followed by the target rectangle (tgt: offset x/y, width, height).
    const base = this.toneUniforms(p, src, maps, o, lutSize, lutOn);
    const buf = new ArrayBuffer(base.byteLength + 32);
    new Uint8Array(buf).set(new Uint8Array(base));
    new Int32Array(buf, base.byteLength, 4).set([0, ty0, src.width, th]);
    new Float32Array(buf, base.byteLength + 16, 4).set([o.zoneRange?.[0] ?? 0, o.zoneRange?.[1] ?? 1, 0, 0]);
    const u = gpu.uniform(buf, "tone.u");
    const profU = gpu.uniform(profileUniforms(p.profile, profileOn, lutOn, lutSize), "profile.u");
    temp.push(u, profU);
    gpu.dispatch(enc, gpu.pipeline("render.tone", toneWgsl), [
      u, src.base.createView(), src.denoised.createView(), maps.guide.createView(),
      maps.masks[0].createView(), maps.masks[1].createView(), maps.masks[2].createView(),
      maps.toneC.createView(), maps.toneM.createView(),
      this.toneLut!.createView(), this.curveLut!.createView(), this.look!.createView({ dimension: "3d" }),
      this.sampler, dst.createView(), distT.createView(),
      profU, this.profCurve!.createView(), this.depthTab!.createView(), this.hueTab!.createView(),
      (src.skin ?? this.noSkin()).createView(),
    ], Math.ceil(src.width / 8), Math.ceil(th / 8));
  }

  /**
   * Renders rows [y0, y0 + rows) of `src` (default: the whole image). The
   * result texture belongs to the renderer and stays valid until the next
   * render; the requested rows start at row `top` of it (the rest is apron for
   * sharpening / depth-of-field neighbourhoods). Rendering in strips keeps the
   * extra memory of a full-resolution export to a few tens of MB.
   */
  async render(src: RenderSource, maps: RefinedMaps, p: Params, o: RenderOptions, dofOn: boolean, strip?: { y0: number; rows: number }): Promise<{ tex: GPUTexture; top: number; rows: number }> {
    const gpu = this.gpu;
    const { width: W, height: H } = src;
    const { size: lutSize, identity } = this.ensureLuts(p);
    const dof = dofOn && p.dof.strength > 0;
    const maxRadius = p.dof.strength * 0.022 * Math.max(W, H);
    const y0 = strip?.y0 ?? 0, rows = strip?.rows ?? H;
    const apron = strip ? (dof ? Math.ceil(maxRadius) + 4 : 3) : 0;
    // Strip starts are aligned to 64 rows so the depth-of-field mip grid (up to
    // 2^5-row texels) lines up with the full-image grid: no seams between strips.
    // Heights are rounded up to 64 rows too (mip level sizes round down, so an
    // odd height would squeeze the coarse levels relative to the full image).
    const ty0 = Math.max(0, Math.floor((y0 - apron) / 64) * 64);
    const ty1 = strip ? Math.min(H, ty0 + Math.ceil((y0 + rows + apron - ty0) / 64) * 64) : H;
    const th = ty1 - ty0;
    const dofLevels = Math.max(1, Math.min(6, Math.floor(Math.log2(Math.min(W, H) / 16))));
    const top = y0 - ty0;
    const t1 = this.target("tone", W, th, "rgba16float");
    const t2 = this.target("detail", W, th, "rgba16float");
    const distT = dof ? this.target("dist", W, th, "r32float") : this.target("distDummy", 1, 1, "r32float");
    const scale = W / src.fullWidth;
    await gpu.run("render.tone+detail", (enc, temp) => {
      this.toneDispatch(enc, temp, src, maps, p, o, lutSize, !identity, p.enable.lut && !isNeutral(p.profile), t1, distT, ty0, th);
      // Sharpening radius is defined at full resolution; a preview sees it scaled.
      const radius = p.sharpen.radius * Math.max(scale, 0.35);
      const amount = p.enable.sharpen ? p.sharpen.amount * Math.min(1, scale * 1.5 + 0.2) : 0;
      const ud = gpu.uniform(new Uniforms(8).u32(W, th, 0, 0).f32(amount, radius, p.sharpen.threshold, 0).bytes(), "detail.u");
      temp.push(ud);
      gpu.dispatch(enc, gpu.pipeline("render.detail", detailWgsl), [ud, t1.createView(), t2.createView()], Math.ceil(W / 8), Math.ceil(th / 8));
    });
    let final = t2;
    let finalLinear = false;
    if (dof) {
      final = await this.depthOfField(t2, distT, W, th, p, maxRadius, dofLevels);
      finalLinear = true;
    }
    if (o.output === "p3f16" && !finalLinear) return { tex: final, top, rows };
    if (o.output === "p3f16") return { tex: await this.encodeF16(final, W, th), top, rows };
    const out = this.target("out8", W, th, "rgba8unorm");
    await gpu.run("render.output", (enc, temp) => {
      const u = gpu.uniform(new Uniforms(8).u32(W, th, 0, 0, o.output === "srgb8" ? 0 : 1, o.dither === false ? 0 : 1, finalLinear ? 1 : 0, ty0).bytes());
      temp.push(u);
      gpu.dispatch(enc, gpu.pipeline("output.encode", outputWgsl, "encode"), [u, final.createView(), out.createView()], Math.ceil(W / 8), Math.ceil(th / 8));
    });
    return { tex: out, top, rows };
  }

  /** Scene-linear Rec.2020 (after denoise, WB, dehaze, exposure) for the linear DNG export; same strip contract as render(). */
  async renderLinear(src: RenderSource, maps: RefinedMaps, p: Params, o: RenderOptions, strip?: { y0: number; rows: number }): Promise<{ tex: GPUTexture; top: number; rows: number }> {
    const gpu = this.gpu;
    const { size: lutSize, identity } = this.ensureLuts(p);
    const y0 = strip?.y0 ?? 0, rows = strip?.rows ?? src.height;
    const t1 = this.target("linear", src.width, rows, "rgba16float");
    const distT = this.target("distDummy", 1, 1, "r32float");
    await gpu.run("render.linear", (enc, temp) => {
      this.toneDispatch(enc, temp, src, maps, p, { ...o, debugView: 3 as never }, lutSize, !identity, false, t1, distT, y0, rows);
    });
    return { tex: t1, top: 0, rows };
  }

  private async encodeF16(src: GPUTexture, W: number, H: number): Promise<GPUTexture> {
    // Re-encode linear P3 → sRGB-curve P3 in rgba16float (reuses the tone path's encoding).
    const gpu = this.gpu;
    const code = `@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = textureDimensions(src);
  if (id.x >= s.x || id.y >= s.y) { return; }
  let c = textureLoad(src, vec2<i32>(id.xy), 0);
  textureStore(dst, vec2<i32>(id.xy), vec4<f32>(srgb_oetf(clamp(c.rgb, vec3<f32>(0.0), vec3<f32>(1.0))), 1.0));
}`;
    const out = this.target("out16", W, H, "rgba16float");
    await gpu.run("render.encode16", (enc) => {
      gpu.dispatch(enc, gpu.pipeline("encode16", code), [src.createView(), out.createView()], Math.ceil(W / 8), Math.ceil(H / 8));
    });
    return out;
  }

  private async depthOfField(sharp: GPUTexture, distT: GPUTexture, W: number, H: number, p: Params, maxRadius: number, fullLevels: number): Promise<GPUTexture> {
    const gpu = this.gpu;
    // Same level count as a full-image render (a strip may be shorter), limited by what fits.
    const levels = Math.max(1, Math.min(fullLevels, Math.floor(Math.log2(Math.min(W, H))) + 1));
    const mipTex = gpu.device.createTexture({
      label: "dof.mips", size: { width: W, height: H }, format: "rgba16float", mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const out = this.target("dof", W, H, "rgba16float");
    await gpu.run("dof", (enc, temp) => {
      const u0 = gpu.uniform(new Uniforms(8).u32(W, H, 0, 0, 0, 0, 0, 0).bytes());
      temp.push(u0);
      gpu.dispatch(enc, gpu.pipeline("output.linearize", outputWgsl, "linearize"), [u0, sharp.createView(), undefined, mipTex.createView({ baseMipLevel: 0, mipLevelCount: 1 })], Math.ceil(W / 8), Math.ceil(H / 8));
      let w = W, h = H;
      for (let l = 1; l < levels; l++) {
        const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
        const u = gpu.uniform(new Uniforms(8).u32(nw, nh, w, h, 0, 0, 0, 0).bytes());
        temp.push(u);
        gpu.dispatch(enc, gpu.pipeline("output.mip", outputWgsl, "mip"), [u, mipTex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }), undefined, mipTex.createView({ baseMipLevel: l, mipLevelCount: 1 })], Math.ceil(nw / 8), Math.ceil(nh / 8));
        w = nw; h = nh;
      }
      const pts = p.dof.points.slice(0, 8);
      const foci = Array.from({ length: 8 }, (_, i) => pts[i]?.dist ?? 0);
      const zonesOn = p.dof.mode === "zones" && p.dof.zones?.length === 5 && p.dof.zoneBounds?.length === 4;
      const zc = zonesOn ? [...p.dof.zoneBounds!, 0, 0, 0, 0] : new Array(8).fill(0);
      const zv = zonesOn ? [...p.dof.zones!, 0, 0, 0] : new Array(8).fill(0);
      const u = gpu.uniform(new Uniforms(36).u32(W, H, 0, 0).f32(p.dof.focus, maxRadius, 0.6, 0).f32(pts.length, zonesOn ? 1 : 0, levels, 0).f32(...foci).f32(...zc).f32(...zv).bytes());
      temp.push(u);
      gpu.dispatch(enc, gpu.pipeline("render.dof", dofWgsl), [u, mipTex.createView(), distT.createView(), undefined, this.sampler, out.createView()], Math.ceil(W / 8), Math.ceil(H / 8));
    });
    await gpu.device.queue.onSubmittedWorkDone();
    mipTex.destroy();
    return out;
  }

  destroy() {
    this.releaseTargets();
    this.gpu.release(this.toneLut, this.curveLut, this.look, this.profCurve, this.depthTab, this.hueTab, this.skinDummy);
  }
}
