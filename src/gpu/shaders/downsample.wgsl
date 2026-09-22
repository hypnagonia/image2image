// Exact area-average resize (box filter with fractional coverage at the
// footprint edges). Used for the preview proxy, the analysis image and the
// guidance image. Optional encode: 0 = none, 1 = normalised display encoding
// (gain, then Rec.2020 → sRGB curve, clamped) as fed to the networks.

struct P {
  src_w: u32, src_h: u32, dst_w: u32, dst_h: u32,
  encode: u32, _a: u32, gain: f32, _b: f32,
}
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var src: texture_2d<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.dst_w || id.y >= p.dst_h) { return; }
  let sx = f32(p.src_w) / f32(p.dst_w);
  let sy = f32(p.src_h) / f32(p.dst_h);
  let x0 = f32(id.x) * sx; let x1 = x0 + sx;
  let y0 = f32(id.y) * sy; let y1 = y0 + sy;
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  let ix0 = u32(floor(x0)); let ix1 = min(u32(ceil(x1)), p.src_w);
  let iy0 = u32(floor(y0)); let iy1 = min(u32(ceil(y1)), p.src_h);
  // Large footprints are subsampled to at most 12×12 taps (still exact-area at the edges).
  let stepx = max(1u, (ix1 - ix0) / 12u);
  let stepy = max(1u, (iy1 - iy0) / 12u);
  for (var y = iy0; y < iy1; y += stepy) {
    let wy = min(f32(y + stepy), y1) - max(f32(y), y0);
    for (var x = ix0; x < ix1; x += stepx) {
      let wx = min(f32(x + stepx), x1) - max(f32(x), x0);
      let w = max(wx, 0.0) * max(wy, 0.0);
      acc += w * textureLoad(src, vec2<i32>(i32(x), i32(y)), 0);
      wsum += w;
    }
  }
  var o = acc / max(wsum, 1e-8);
  if (p.encode == 1u) {
    o = vec4<f32>(clamp(srgb_oetf(max(o.rgb * p.gain, vec3<f32>(0.0))), vec3<f32>(0.0), vec3<f32>(1.0)), o.a);
  }
  textureStore(dst, vec2<i32>(id.xy), o);
}
