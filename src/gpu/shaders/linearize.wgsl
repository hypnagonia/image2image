// Display-referred RGB input (HEIC/JPEG/PNG) → linear working Rec.2020.
// Input is an rgba8unorm or rgba16float copy of the decoded bitmap, still in
// its own transfer function and primaries.

struct P {
  w: u32, h: u32,
  transfer: u32,   // 0 = sRGB curve, 1 = linear already
  _pad: u32,
  m: mat3x3<f32>,  // source primaries → Rec.2020
}
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var src: texture_2d<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let c = textureLoad(src, vec2<i32>(id.xy), 0).rgb;
  var lin = c;
  if (p.transfer == 0u) { lin = srgb_eotf(c); }
  let w = p.m * lin;
  // An 8-bit display-referred source is "clipped" wherever a channel hit the top code.
  let clip = select(0.0, 1.0, max(c.r, max(c.g, c.b)) >= 0.999);
  textureStore(dst, vec2<i32>(id.xy), vec4<f32>(w, clip));
}
