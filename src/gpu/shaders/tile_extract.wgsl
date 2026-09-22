@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> tile_in: array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let T = p.tile;
  if (id.x >= T || id.y >= T) { return; }
  let x = mirror(p.tx + i32(id.x), i32(p.img_w));
  let y = mirror(p.ty + i32(id.y), i32(p.img_h));
  let e = enc(textureLoad(src, vec2<i32>(x, y), 0).rgb);
  let i = id.y * T + id.x;
  tile_in[i] = e.r;
  tile_in[T * T + i] = e.g;
  tile_in[2u * T * T + i] = e.b;
}
