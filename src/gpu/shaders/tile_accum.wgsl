@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> tile_out: array<f32>;
@group(0) @binding(3) var<storage, read_write> acc: array<vec4<f32>>;

fn ramp(d: u32, border: u32) -> f32 {
  if (border == 1u) { return 1.0; }
  // Linear ramp across the overlap, never exactly zero.
  return clamp((f32(d) + 0.5) / f32(max(p.overlap, 1u)), 0.02, 1.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let T = p.tile;
  if (id.x >= T || id.y >= T) { return; }
  let gx = p.tx + i32(id.x);
  let gy = p.ty + i32(id.y);
  if (gx < 0 || gy < 0 || gx >= i32(p.img_w) || gy >= i32(p.img_h)) { return; }
  let ay = gy - p.acc_y;
  if (ay < 0 || ay >= i32(p.acc_h)) { return; }
  let w = ramp(id.x, p.edge_l) * ramp(T - 1u - id.x, p.edge_r) * ramp(id.y, p.edge_t) * ramp(T - 1u - id.y, p.edge_b);
  let inp = enc(textureLoad(src, vec2<i32>(gx, gy), 0).rgb);
  var v = inp;
  if (p.mode == 1u) {
    let i = id.y * T + id.x;
    var o = vec3<f32>(tile_out[i], tile_out[T * T + i], tile_out[2u * T * T + i]);
    // NaN/Inf guard: a non-finite output falls back to the input.
    if (!(all(o == o)) || any(abs(o) > vec3<f32>(1e4))) { o = inp; }
    v = inp + p.strength * (clamp(o, vec3<f32>(-0.05), vec3<f32>(1.05)) - inp);
  }
  let k = u32(ay) * p.img_w + u32(gx);
  acc[k] = acc[k] + vec4<f32>(v * w, w);
}
