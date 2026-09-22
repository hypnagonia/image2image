@group(0) @binding(1) var<storage, read> tile_in: array<f32>;
@group(0) @binding(2) var<storage, read> tile_out: array<f32>;
@group(0) @binding(3) var<storage, read_write> stats: array<f32>;

var<workgroup> s_diff: array<f32, 256>;
var<workgroup> s_max: array<f32, 256>;

// Single workgroup: mean |out - in| and max |out| over the tile.
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let n = p.tile * p.tile * 3u;
  var d = 0.0; var m = 0.0;
  for (var i = li; i < n; i += 256u) {
    let o = tile_out[i];
    let bad = !(o == o) || abs(o) > 1e4;
    let oo = select(o, 1e4, bad);
    d += abs(oo - tile_in[i]);
    m = max(m, abs(oo - 0.5));
  }
  s_diff[li] = d; s_max[li] = m;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { s_diff[li] += s_diff[li + s]; s_max[li] = max(s_max[li], s_max[li + s]); }
    workgroupBarrier();
  }
  if (li == 0u) { stats[0] = s_diff[0] / f32(n); stats[1] = s_max[0]; }
}
