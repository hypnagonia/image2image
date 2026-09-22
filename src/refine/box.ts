/**
 * Separable box filter over up to four rgba32float textures at once
 * (WebGPU guarantees four storage textures per stage). Radii above 16 are
 * sampled every other texel — the inputs of a large box are smooth.
 */
import { Gpu, Uniforms } from "../gpu/gpu.ts";

function boxWgsl(n: number): string {
  let s = `struct P { w: u32, h: u32, r: i32, dir: u32, step: i32, _a: u32, _b: u32, _c: u32 }
@group(0) @binding(0) var<uniform> p: P;\n`;
  for (let i = 0; i < n; i++) s += `@group(0) @binding(${1 + i}) var i${i}: texture_2d<f32>;\n`;
  for (let i = 0; i < n; i++) s += `@group(0) @binding(${5 + i}) var o${i}: texture_storage_2d<rgba32float, write>;\n`;
  s += `@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let d = select(vec2<i32>(0, 1), vec2<i32>(1, 0), p.dir == 0u);
  let lim = select(i32(p.h) - 1, i32(p.w) - 1, p.dir == 0u);
  let c = vec2<i32>(id.xy);
  let cc = select(c.y, c.x, p.dir == 0u);
`;
  for (let i = 0; i < n; i++) s += `  var a${i} = vec4<f32>(0.0);\n`;
  s += `  var cnt = 0.0;
  for (var k = -p.r; k <= p.r; k += p.step) {
    let t = cc + k;
    if (t < 0 || t > lim) { continue; }
    let q = c + d * k;
`;
  for (let i = 0; i < n; i++) s += `    a${i} += textureLoad(i${i}, q, 0);\n`;
  s += `    cnt += 1.0;
  }
`;
  for (let i = 0; i < n; i++) s += `  textureStore(o${i}, c, a${i} / cnt);\n`;
  s += "}\n";
  return s;
}

/**
 * Box-filters `inputs` into `outputs` (same count, same size) using `temps`
 * for the intermediate horizontal pass.
 */
export function box(
  gpu: Gpu, enc: GPUCommandEncoder, temp: Array<GPUBuffer | GPUTexture>,
  w: number, h: number, r: number,
  inputs: GPUTexture[], temps: GPUTexture[], outputs: GPUTexture[],
) {
  const n = inputs.length;
  const pipe = gpu.pipeline(`box${n}`, boxWgsl(n));
  const step = r > 16 ? 2 : 1;
  for (const dir of [0, 1]) {
    const u = gpu.uniform(new Uniforms(8).u32(w, h).i32(Math.round(r)).u32(dir).i32(step).bytes(), "box.u");
    temp.push(u);
    const src = dir === 0 ? inputs : temps;
    const dst = dir === 0 ? temps : outputs;
    const b: Array<GPUBuffer | GPUTextureView | undefined> = [u];
    for (let i = 0; i < 4; i++) b[1 + i] = src[i]?.createView();
    for (let i = 0; i < 4; i++) b[5 + i] = dst[i]?.createView();
    gpu.dispatch(enc, pipe, b, Math.ceil(w / 16), Math.ceil(h / 16));
  }
}
