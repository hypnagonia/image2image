// Region statistics at the guide resolution R. One dispatch per region
// (group index g in 0..10, or 11 = whole image with weight 1). Each 16×16
// workgroup covers 32×32 px and writes 16 partial sums; the host adds them.
//
// Partial record (weighted by the refined group probability w):
//  0 Σw            1 Σw·log2Y       2 Σw·(log2Y)²     3 Σw·Y
//  4 Σw·R          5 Σw·G           6 Σw·B            7 Σw·chroma (OkLab C of display P3)
//  8 Σw·clipHi     9 Σw·clipLo     10 Σw·|l − base_m| (EV)   11 Σw·|∇Y'| (texture)
// 12 Σw·dist      13 Σw·dist²      14 Σw·darkChannel  15 Σw·Y'
//
// The whole-image dispatch also fills histograms (atomics):
//  hist[0..127]      luminance, log2 Y from −14 to +4 EV (0.140625 EV/bin)
//  hist[128..895]    encoded R, G, B (256 bins each)
//  hist[896..959]    dark channel (64 bins)
//  hist[960..1151]   Σ encoded rgb per dark-channel bin (×256, fixed point)
//  hist[1152+g*32..] per-group log2 Y (32 bins, −14..+4 EV), weight ×64

struct P { w: u32, h: u32, group: u32, groups_x: u32, gain: f32, _a: f32, _b: f32, _c: f32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var lin: texture_2d<f32>;
@group(0) @binding(2) var guide: texture_2d<f32>;
@group(0) @binding(3) var m0: texture_2d<f32>;
@group(0) @binding(4) var m1: texture_2d<f32>;
@group(0) @binding(5) var m2: texture_2d<f32>;
@group(0) @binding(6) var tone_m: texture_2d<f32>;
@group(0) @binding(7) var<storage, read_write> part: array<f32>;
@group(0) @binding(8) var<storage, read_write> hist: array<atomic<u32>>;

var<workgroup> red: array<f32, 256>;

fn weight_of(id: vec2<i32>) -> f32 {
  if (p.group >= 11u) { return 1.0; }
  let g = p.group;
  if (g < 4u) { return textureLoad(m0, id, 0)[g]; }
  if (g < 8u) { return textureLoad(m1, id, 0)[g - 4u]; }
  return textureLoad(m2, id, 0)[g - 8u];
}

fn ey(id: vec2<i32>) -> f32 {
  let c = textureLoad(guide, clamp(id, vec2<i32>(0), vec2<i32>(i32(p.w) - 1, i32(p.h) - 1)), 0).rgb;
  return dot(c, LUMA2020);
}

fn reduce(v: f32, li: u32) -> f32 {
  red[li] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { red[li] += red[li + s]; }
    workgroupBarrier();
  }
  let r = red[0];
  workgroupBarrier();
  return r;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  var acc: array<f32, 16>;
  for (var k = 0u; k < 16u; k++) { acc[k] = 0.0; }
  let whole = p.group >= 11u;
  for (var j = 0u; j < 2u; j++) {
    for (var i = 0u; i < 2u; i++) {
      let x = wid.x * 32u + lid.x * 2u + i;
      let y = wid.y * 32u + lid.y * 2u + j;
      if (x >= p.w || y >= p.h) { continue; }
      let id = vec2<i32>(i32(x), i32(y));
      let w = weight_of(id);
      if (w <= 0.002 && !whole) { continue; }
      let L = textureLoad(lin, id, 0);
      let c = max(L.rgb, vec3<f32>(0.0));
      let Yl = max(luma2020(c), 1e-6);
      let l2 = log2(Yl);
      let g = textureLoad(guide, id, 0);
      let e = g.rgb;
      let Ye = dot(e, LUMA2020);
      // Colourfulness as it would display at the normalised exposure.
      let lab = lin_srgb_to_oklab(P3_TO_SRGB * (REC2020_TO_P3 * srgb_eotf(e)));
      let chroma = length(lab.yz);
      let clipHi = max(g.a, select(0.0, 1.0, max(e.r, max(e.g, e.b)) >= 0.995));
      let clipLo = select(0.0, 1.0, Ye <= 1.0 / 255.0);
      let tm = textureLoad(tone_m, id, 0);
      let le = log_enc(Yl);
      let base = tm.z * le + tm.w;
      let lc = abs(le - base) * LOG_RANGE;
      let gx = 0.5 * (ey(id + vec2<i32>(1, 0)) - ey(id - vec2<i32>(1, 0)));
      let gy = 0.5 * (ey(id + vec2<i32>(0, 1)) - ey(id - vec2<i32>(0, 1)));
      let tex = sqrt(gx * gx + gy * gy);
      let d = textureLoad(m2, id, 0).a;
      // Dark channel: min over channels and a 3×3 neighbourhood of the encoded image.
      var dc = 1.0;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let q = textureLoad(guide, clamp(id + vec2<i32>(dx, dy), vec2<i32>(0), vec2<i32>(i32(p.w) - 1, i32(p.h) - 1)), 0).rgb;
          dc = min(dc, min(q.r, min(q.g, q.b)));
        }
      }
      acc[0] += w; acc[1] += w * l2; acc[2] += w * l2 * l2; acc[3] += w * Yl;
      acc[4] += w * c.r; acc[5] += w * c.g; acc[6] += w * c.b; acc[7] += w * chroma;
      acc[8] += w * clipHi; acc[9] += w * clipLo; acc[10] += w * lc; acc[11] += w * tex;
      acc[12] += w * d; acc[13] += w * d * d; acc[14] += w * dc; acc[15] += w * Ye;
      if (whole) {
        let hb = u32(clamp((l2 + 14.0) / 18.0 * 128.0, 0.0, 127.0));
        atomicAdd(&hist[hb], 1u);
        let q = vec3<u32>(clamp(e * 255.0 + 0.5, vec3<f32>(0.0), vec3<f32>(255.0)));
        atomicAdd(&hist[128u + q.r], 1u);
        atomicAdd(&hist[384u + q.g], 1u);
        atomicAdd(&hist[640u + q.b], 1u);
        let db = u32(clamp(dc * 64.0, 0.0, 63.0));
        atomicAdd(&hist[896u + db], 1u);
        let ce = vec3<u32>(clamp(e * 256.0, vec3<f32>(0.0), vec3<f32>(256.0)));
        atomicAdd(&hist[960u + db * 3u], ce.r);
        atomicAdd(&hist[961u + db * 3u], ce.g);
        atomicAdd(&hist[962u + db * 3u], ce.b);
        // Per-group luminance histograms, weighted by the refined probabilities.
        let gb = u32(clamp((l2 + 14.0) / 18.0 * 32.0, 0.0, 31.0));
        let a0 = textureLoad(m0, id, 0); let a1 = textureLoad(m1, id, 0); let a2 = textureLoad(m2, id, 0);
        var ws = array<f32, 11>(a0.x, a0.y, a0.z, a0.w, a1.x, a1.y, a1.z, a1.w, a2.x, a2.y, a2.z);
        for (var k = 0u; k < 11u; k++) {
          let wq = u32(ws[k] * 64.0 + 0.5);
          if (wq > 0u) { atomicAdd(&hist[1152u + k * 32u + gb], wq); }
        }
      }
    }
  }
  workgroupBarrier();
  let o = (wid.y * p.groups_x + wid.x) * 16u;
  for (var k = 0u; k < 16u; k++) {
    let r = reduce(acc[k], li);
    if (li == 0u) { part[o + k] = r; }
  }
}
