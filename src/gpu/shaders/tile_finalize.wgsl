@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> acc: array<vec4<f32>>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.img_w || id.y >= p.rows) { return; }
  let gy = p.acc_y + i32(id.y);
  if (gy >= i32(p.img_h)) { return; }
  let a = acc[id.y * p.img_w + id.x];
  let orig = textureLoad(src, vec2<i32>(i32(id.x), gy), 0);
  var outc = orig.rgb;
  if (a.w > 0.0) {
    let e = a.rgb / a.w;
    let lin = srgb_eotf(max(e, vec3<f32>(0.0))) / p.gain;
    // The network saw min(k·x, 1): where the original approached the encoded
    // ceiling, keep the scene-linear original instead of a clipped estimate.
    let top = max(orig.r, max(orig.g, orig.b)) * p.gain;
    let t = smoothstep(0.90, 0.995, top);
    outc = mix(lin, orig.rgb, t);
  }
  // Written to a strip texture (row = id.y) and copied into place by the host, so
  // the same working texture can be both source and destination (in-place NAFNet).
  textureStore(dst, vec2<i32>(i32(id.x), i32(id.y)), vec4<f32>(outc, orig.a));
}
