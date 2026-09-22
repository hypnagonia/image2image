@group(0) @binding(1) var<storage, read> acc_src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> acc_dst: array<vec4<f32>>;

// acc_dst[y] = acc_src[y + rows] (zero beyond the end).
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.img_w || id.y >= p.acc_h) { return; }
  let sy = id.y + p.rows;
  var v = vec4<f32>(0.0);
  if (sy < p.acc_h) { v = acc_src[sy * p.img_w + id.x]; }
  acc_dst[id.y * p.img_w + id.x] = v;
}
