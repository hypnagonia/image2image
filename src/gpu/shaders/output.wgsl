// Output transform.
//   linearize: display-encoded P3 → linear P3 (for DoF mips and blending); alpha: HDR gain → excess luminance
//   mip:       2× box reduction into the next mip level
//   encode:    (encoded or linear) P3 → target space, dithered, rgba8unorm
//              target 0 = sRGB, 1 = Display P3; input_linear flag in cfg.z

struct U { size: vec4<u32>, cfg: vec4<u32> } // cfg: x target, y dither, z input is linear, w row offset in the full image
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst8: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var dst16: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn linearize(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u.size.x || id.y >= u.size.y) { return; }
  let c = textureLoad(src, vec2<i32>(id.xy), 0);
  // Alpha = the HDR gain; carried as additive "excess luminance" Y·(gain − 1), so
  // mips and the blur average it like light (a blurred highlight keeps its HDR).
  let lin = srgb_eotf(c.rgb);
  textureStore(dst16, vec2<i32>(id.xy), vec4<f32>(lin, dot(lin, LUMAP3) * (c.a - 1.0)));
}

@compute @workgroup_size(8, 8)
fn mip(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u.size.x || id.y >= u.size.y) { return; }
  let s = vec2<i32>(id.xy) * 2;
  let m = vec2<i32>(i32(u.size.z) - 1, i32(u.size.w) - 1);
  let c = textureLoad(src, min(s, m), 0) + textureLoad(src, min(s + vec2<i32>(1, 0), m), 0)
        + textureLoad(src, min(s + vec2<i32>(0, 1), m), 0) + textureLoad(src, min(s + vec2<i32>(1, 1), m), 0);
  textureStore(dst16, vec2<i32>(id.xy), c * 0.25);
}

@compute @workgroup_size(8, 8)
fn encode(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u.size.x || id.y >= u.size.y) { return; }
  var c = textureLoad(src, vec2<i32>(id.xy), 0).rgb;
  var lin = c;
  if (u.cfg.z == 0u) { lin = srgb_eotf(c); }
  if (u.cfg.x == 0u) {
    lin = P3_TO_SRGB * lin;
    // Soft gamut map into sRGB: desaturate toward luminance instead of clipping channels.
    let Y = dot(lin, vec3<f32>(0.2126, 0.7152, 0.0722));
    let mn = min(lin.r, min(lin.g, lin.b));
    if (mn < 0.0) { lin = mix(lin, vec3<f32>(Y), clamp(-mn / max(Y - mn, 1e-6), 0.0, 1.0)); }
  }
  var e = srgb_oetf(clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0)));
  if (u.cfg.y != 0u) {
    // Triangular dither of ±1 LSB: removes banding in skies without bias.
    let g = id.xy + vec2<u32>(0u, u.cfg.w); // full-image coordinates: same pattern in strips
    let n = hash21(g) + hash21(g + vec2<u32>(7919u, 104729u)) - 1.0;
    e += vec3<f32>(n / 255.0);
  }
  textureStore(dst8, vec2<i32>(id.xy), vec4<f32>(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0));
}
