// HDR gain map for the gain-map JPEG (ISO 21496-1 / Ultra HDR), from the final
// image (display-encoded P3, or linear after depth of field) whose alpha is the
// linear luminance gain of the HDR rendition over the SDR one.
//
// One map pixel per s×s block of the requested rows. The block's *minimum*
// log gain is kept: the viewer upsamples the map bilinearly, and a mean would
// let a bright sky's gain glow onto a dark window frame next to it.
//   l    = log2((Ys·gain + offHdr) / (Ys + offSdr))      (the decoder's model)
//   code = clamp((l − min) / (max − min), 0, 1)^gamma    → 8-bit grey

struct U {
  size: vec4<u32>,   // W, H of the source texture, first requested row, block size s
  cfg: vec4<u32>,    // source is linear, map width, requested rows, _
  f: vec4<f32>,      // map min, map max (log2), gamma, offset (SDR and HDR)
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = u.size.w;
  let rows = u.cfg.z;
  if (id.x >= u.cfg.y || id.y * s >= rows) { return; }
  var l = 1e9;
  for (var j = 0u; j < s; j++) {
    let y = id.y * s + j;
    if (y >= rows) { break; }
    for (var i = 0u; i < s; i++) {
      let x = id.x * s + i;
      if (x >= u.size.x) { break; }
      let c = textureLoad(src, vec2<i32>(i32(x), i32(u.size.z + y)), 0);
      var lin = c.rgb;
      if (u.cfg.x == 0u) { lin = srgb_eotf(c.rgb); }
      let Ys = max(dot(lin, LUMAP3), 0.0);
      let o = u.f.w;
      l = min(l, log2((Ys * max(c.a, 1.0) + o) / (Ys + o)));
    }
  }
  let code = pow(clamp((l - u.f.x) / max(u.f.y - u.f.x, 1e-6), 0.0, 1.0), u.f.z);
  textureStore(dst, vec2<i32>(id.xy), vec4<f32>(code, code, code, 1.0));
}
