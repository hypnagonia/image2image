// Display-referred RGB input (HEIC/JPEG/PNG) → linear working Rec.2020.
// Input is an rgba8unorm copy of the decoded bitmap (entry `main`) or, for a
// 10/16-bit HEIF, an rgba16uint copy (entry `main_u16`), still in its own
// transfer function and primaries.
//
// HDR gain map (Apple): the file stores an SDR base image plus a map of how
// far each pixel may rise above display white. Applying it in linear light,
//   linear_hdr = linear_sdr × (1 + (headroom − 1) × gain),
// turns a clipped-looking window or sky back into real highlight detail that
// the tone curve can roll off. Without a map the factor is 1 everywhere.

struct P {
  w: u32, h: u32,
  transfer: u32,   // 0 = sRGB curve, 1 = linear already
  max_code: u32,   // u16 path: largest sample value (1023 for 10-bit)
  m: mat3x3<f32>,  // source primaries → Rec.2020
  gain: vec4<f32>, // headroom, gain map width, height, 1 = map present
}
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var src16: texture_2d<u32>;
@group(0) @binding(4) var gain_map: texture_2d<f32>;

/** Gain map value at this pixel, bilinear (the map is usually half size). */
fn gain_at(id: vec2<u32>) -> f32 {
  if (p.gain.w < 0.5) { return 0.0; }
  let gw = i32(p.gain.y); let gh = i32(p.gain.z);
  let fx = (f32(id.x) + 0.5) * p.gain.y / f32(p.w) - 0.5;
  let fy = (f32(id.y) + 0.5) * p.gain.z / f32(p.h) - 0.5;
  let x0 = clamp(i32(floor(fx)), 0, gw - 1); let x1 = clamp(x0 + 1, 0, gw - 1);
  let y0 = clamp(i32(floor(fy)), 0, gh - 1); let y1 = clamp(y0 + 1, 0, gh - 1);
  let tx = clamp(fx - floor(fx), 0.0, 1.0); let ty = clamp(fy - floor(fy), 0.0, 1.0);
  let a = textureLoad(gain_map, vec2<i32>(x0, y0), 0).r;
  let b = textureLoad(gain_map, vec2<i32>(x1, y0), 0).r;
  let c = textureLoad(gain_map, vec2<i32>(x0, y1), 0).r;
  let d = textureLoad(gain_map, vec2<i32>(x1, y1), 0).r;
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

fn emit(id: vec2<u32>, c: vec3<f32>, clipped: f32) {
  var lin = c;
  if (p.transfer == 0u) { lin = srgb_eotf(c); }
  lin *= 1.0 + (p.gain.x - 1.0) * gain_at(id);
  textureStore(dst, vec2<i32>(id), vec4<f32>(p.m * lin, clipped));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let c = textureLoad(src, vec2<i32>(id.xy), 0).rgb;
  // An 8-bit display-referred source is "clipped" wherever a channel hit the top code.
  emit(id.xy, c, select(0.0, 1.0, max(c.r, max(c.g, c.b)) >= 0.999));
}

@compute @workgroup_size(16, 16)
fn main_u16(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let raw = textureLoad(src16, vec2<i32>(id.xy), 0);
  let scale = 1.0 / f32(p.max_code);
  let c = vec3<f32>(f32(raw.r), f32(raw.g), f32(raw.b)) * scale;
  // With a gain map the base image is an SDR rendering: its top code is white,
  // not a clipped highlight, so "clipped" only marks pixels the map cannot lift.
  let top = select(0.0, 1.0, max(raw.r, max(raw.g, raw.b)) >= p.max_code);
  emit(id.xy, c, select(top, 0.0, p.gain.w > 0.5));
}
