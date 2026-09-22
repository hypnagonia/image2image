// Full-resolution block statistics (32×32 px blocks), the raw material for
// noise estimation, blur detection and texture measurement. One workgroup per
// block; results are raw sums/means so all interpretation stays in TypeScript
// (src/analysis/blocks.ts) where it is inspectable.
//
// Values are measured on the *encoded* luma Y' = OETF(k · Y) — noise and
// sharpness are perceived, and the networks see, the encoded signal.
//
// Output record (16 floats per block):
//  0 meanY'       1 noiseY (Immerkaer σ)   2 noiseC (chroma σ)   3 mean|∇Y'|
//  4 mean|∇²Y'|   5 max|∇Y'|               6 clipped fraction    7 mean linear Y
//  8 mean|Y'-box3|  9 edge-pixel Σ|∇|²  10 edge-pixel Σ(∇²)²   11 edge pixel count
//  (edge pixels: |∇Y'| > edge_thr; the host picks edge_thr ≈ 8σ_noise and
//   subtracts the noise variance — blur σ ≈ 0.7 / sqrt(Σ(∇²)²/Σ|∇|²), calibrated
//   on Gaussian-blurred ProRAW renders, see docs/PIPELINE.md)
// 12 meanCb'     13 meanCr'               14 mean Y'^2           15 unused

struct P { w: u32, h: u32, bw: u32, bh: u32, gain: f32, edge_thr: f32, _a: f32, _b: f32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outb: array<f32>;

const B = 32u;
const A = 36u; // block + 2px apron each side
var<workgroup> sh: array<f32, 3888>; // 3 planes × 36 × 36; reused for reductions

fn load_px(x: i32, y: i32) -> vec4<f32> {
  let c = textureLoad(src, vec2<i32>(clamp(x, 0, i32(p.w) - 1), clamp(y, 0, i32(p.h) - 1)), 0);
  let lin = max(c.rgb * p.gain, vec3<f32>(0.0));
  let e = srgb_oetf(min(lin, vec3<f32>(1.0)));
  let Y = dot(e, LUMA2020);
  return vec4<f32>(Y, e.b - Y, e.r - Y, c.a);
}

fn Y(x: u32, y: u32) -> f32 { return sh[y * A + x]; }
fn Cb(x: u32, y: u32) -> f32 { return sh[1296u + y * A + x]; }
fn Cr(x: u32, y: u32) -> f32 { return sh[2592u + y * A + x]; }

// Reductions reuse `sh` (only after the apron tile is no longer needed): keeps
// workgroup memory under the 16 KiB WebGPU minimum that iPhones expose.

fn reduce_sum(v: f32, li: u32) -> f32 {
  sh[li] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { sh[li] += sh[li + s]; }
    workgroupBarrier();
  }
  let r = sh[0];
  workgroupBarrier();
  return r;
}
fn reduce_max(v: f32, li: u32) -> f32 {
  sh[li] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { sh[li] = max(sh[li], sh[li + s]); }
    workgroupBarrier();
  }
  let r = sh[0];
  workgroupBarrier();
  return r;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let bx = wid.x; let by = wid.y;
  let ox = i32(bx * B) - 2; let oy = i32(by * B) - 2;
  // Cooperative load of the 36×36 apron tile.
  var clip_acc = 0.0;
  var lin_acc = 0.0;
  for (var i = li; i < A * A; i += 256u) {
    let tx = i % A; let ty = i / A;
    let v = load_px(ox + i32(tx), oy + i32(ty));
    sh[i] = v.x; sh[1296u + i] = v.y; sh[2592u + i] = v.z;
  }
  workgroupBarrier();

  var sY = 0.0; var sY2 = 0.0; var sN = 0.0; var sNC = 0.0; var sG = 0.0; var sL = 0.0; var mG = 0.0;
  var sT = 0.0; var eG = 0.0; var eL = 0.0; var eN = 0.0; var sCb = 0.0; var sCr = 0.0; var cnt = 0.0;
  for (var j = 0u; j < 2u; j++) {
    for (var i = 0u; i < 2u; i++) {
      let x = lid.x * 2u + i + 2u;
      let y = lid.y * 2u + j + 2u;
      let gx_ = bx * B + x - 2u; let gy_ = by * B + y - 2u;
      if (gx_ >= p.w || gy_ >= p.h) { continue; }
      cnt += 1.0;
      let c = Y(x, y);
      sY += c; sY2 += c * c;
      sCb += Cb(x, y); sCr += Cr(x, y);
      // Immerkaer noise operator [1 -2 1; -2 4 -2; 1 -2 1].
      let n = Y(x - 1u, y - 1u) + Y(x + 1u, y - 1u) + Y(x - 1u, y + 1u) + Y(x + 1u, y + 1u)
            - 2.0 * (Y(x, y - 1u) + Y(x, y + 1u) + Y(x - 1u, y) + Y(x + 1u, y)) + 4.0 * c;
      sN += abs(n);
      let nb = Cb(x - 1u, y - 1u) + Cb(x + 1u, y - 1u) + Cb(x - 1u, y + 1u) + Cb(x + 1u, y + 1u)
            - 2.0 * (Cb(x, y - 1u) + Cb(x, y + 1u) + Cb(x - 1u, y) + Cb(x + 1u, y)) + 4.0 * Cb(x, y);
      let nr = Cr(x - 1u, y - 1u) + Cr(x + 1u, y - 1u) + Cr(x - 1u, y + 1u) + Cr(x + 1u, y + 1u)
            - 2.0 * (Cr(x, y - 1u) + Cr(x, y + 1u) + Cr(x - 1u, y) + Cr(x + 1u, y)) + 4.0 * Cr(x, y);
      sNC += 0.5 * (abs(nb) + abs(nr));
      let gx = 0.5 * (Y(x + 1u, y) - Y(x - 1u, y));
      let gy = 0.5 * (Y(x, y + 1u) - Y(x, y - 1u));
      let g = sqrt(gx * gx + gy * gy);
      sG += g; mG = max(mG, g);
      let lap = Y(x + 1u, y) + Y(x - 1u, y) + Y(x, y + 1u) + Y(x, y - 1u) - 4.0 * c;
      sL += abs(lap);
      let box = (Y(x - 1u, y - 1u) + Y(x, y - 1u) + Y(x + 1u, y - 1u) + Y(x - 1u, y) + c + Y(x + 1u, y)
               + Y(x - 1u, y + 1u) + Y(x, y + 1u) + Y(x + 1u, y + 1u)) / 9.0;
      sT += abs(c - box);
      if (g > p.edge_thr) { eG += g * g; eL += lap * lap; eN += 1.0; }
    }
  }
  // Clipping / linear luminance straight from the texture (not the apron copy).
  for (var j = 0u; j < 2u; j++) {
    for (var i = 0u; i < 2u; i++) {
      let gx_ = bx * B + lid.x * 2u + i; let gy_ = by * B + lid.y * 2u + j;
      if (gx_ >= p.w || gy_ >= p.h) { continue; }
      let t = textureLoad(src, vec2<i32>(i32(gx_), i32(gy_)), 0);
      clip_acc += t.a;
      lin_acc += dot(max(t.rgb, vec3<f32>(0.0)), LUMA2020);
    }
  }
  workgroupBarrier();
  let N = max(reduce_sum(cnt, li), 1.0);
  let rY = reduce_sum(sY, li) / N;
  let rN = reduce_sum(sN, li) / N;
  let rNC = reduce_sum(sNC, li) / N;
  let rG = reduce_sum(sG, li) / N;
  let rL = reduce_sum(sL, li) / N;
  let rM = reduce_max(mG, li);
  let rClip = reduce_sum(clip_acc, li) / N;
  let rLin = reduce_sum(lin_acc, li) / N;
  let rT = reduce_sum(sT, li) / N;
  let rEG = reduce_sum(eG, li);
  let rEL = reduce_sum(eL, li);
  let rEN = reduce_sum(eN, li);
  let rCb = reduce_sum(sCb, li) / N;
  let rCr = reduce_sum(sCr, li) / N;
  let rY2 = reduce_sum(sY2, li) / N;
  if (li == 0u) {
    let o = (by * p.bw + bx) * 16u;
    // Immerkaer: σ = sqrt(π/2) / 6 · mean|N*I|
    let k = 0.2088856; // sqrt(pi/2)/6
    outb[o + 0u] = rY; outb[o + 1u] = k * rN; outb[o + 2u] = k * rNC; outb[o + 3u] = rG;
    outb[o + 4u] = rL; outb[o + 5u] = rM; outb[o + 6u] = rClip; outb[o + 7u] = rLin;
    outb[o + 8u] = rT; outb[o + 9u] = rEG; outb[o + 10u] = rEL; outb[o + 11u] = rEN;
    outb[o + 12u] = rCb; outb[o + 13u] = rCr; outb[o + 14u] = rY2; outb[o + 15u] = N;
  }
}
