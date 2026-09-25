// Fast, noise-adaptive GPU denoiser.
//
// Works on the encoded signal (gain k, sRGB curve) the noise was measured on,
// split into luma Y' and chroma (Cb', Cr'):
//   luma    5×5 bilateral; range σ = 2.2 × the measured noise σ at this pixel's
//           luminance (8-bin profile), so texture well above the noise survives
//   chroma  9×9 (every other texel) joint bilateral guided by luma and chroma:
//           colour noise is low-frequency and objectionable, detail lives in luma
// The render pass blends this result in by the decided strength per region, so
// this pass can be moderately strong. Near the encoded ceiling the scene-linear
// original is kept (highlights beyond the encoding are never touched).

struct P { w: u32, h: u32, _a: u32, _b: u32, gain: f32, chroma_sigma: f32, _c: f32, _d: f32, sig: array<vec4<f32>, 2> }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;

fn enc_px(q: vec2<i32>) -> vec3<f32> {
  let c = textureLoad(src, clamp(q, vec2<i32>(0), vec2<i32>(i32(p.w) - 1, i32(p.h) - 1)), 0).rgb;
  let e = srgb_oetf(clamp(c * p.gain, vec3<f32>(0.0), vec3<f32>(1.0)));
  let Y = dot(e, LUMA2020);
  return vec3<f32>(Y, e.b - Y, e.r - Y);
}

fn noise_at(y: f32) -> f32 {
  let x = clamp(y * 8.0 - 0.5, 0.0, 7.0);
  let i = u32(floor(x));
  let t = fract(x);
  let a = p.sig[i / 4u][i % 4u];
  let b = p.sig[min(i + 1u, 7u) / 4u][min(i + 1u, 7u) % 4u];
  return max(mix(a, b, t), 0.0005);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let c = vec2<i32>(id.xy);
  let orig = textureLoad(src, c, 0);
  let e0 = enc_px(c);
  let sy = noise_at(e0.x) * 2.2;
  // Luma bilateral 5×5.
  var ly = 0.0; var lw = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let v = enc_px(c + vec2<i32>(dx, dy));
      let ds = f32(dx * dx + dy * dy);
      let dr = v.x - e0.x;
      let w = exp(-ds / (2.0 * 1.4 * 1.4) - dr * dr / (2.0 * sy * sy));
      ly += w * v.x; lw += w;
    }
  }
  let Y = ly / lw;
  // Chroma joint bilateral, 9×9 on a stride-2 lattice.
  let sc = max(p.chroma_sigma * 3.0, 0.003);
  var cc = vec2<f32>(0.0); var cw = 0.0;
  for (var dy = -4; dy <= 4; dy += 2) {
    for (var dx = -4; dx <= 4; dx += 2) {
      let v = enc_px(c + vec2<i32>(dx, dy));
      let ds = f32(dx * dx + dy * dy);
      let dl = v.x - e0.x;
      let dc = v.yz - e0.yz;
      let w = exp(-ds / (2.0 * 3.0 * 3.0) - dl * dl / (2.0 * (3.0 * sy) * (3.0 * sy)) - dot(dc, dc) / (2.0 * sc * sc));
      cc += w * v.yz; cw += w;
    }
  }
  let C = cc / cw;
  // Back to encoded RGB (Y' = kr·R + kg·G + kb·B with Cb' = B−Y, Cr' = R−Y).
  let R = C.y + Y;
  let B = C.x + Y;
  let G = (Y - LUMA2020.r * R - LUMA2020.b * B) / LUMA2020.g;
  let lin = srgb_eotf(max(vec3<f32>(R, G, B), vec3<f32>(0.0))) / p.gain;
  let top = max(orig.r, max(orig.g, orig.b)) * p.gain;
  let t = smoothstep(0.9, 0.995, top);
  textureStore(dst, c, vec4<f32>(mix(lin, orig.rgb, t), orig.a));
}
