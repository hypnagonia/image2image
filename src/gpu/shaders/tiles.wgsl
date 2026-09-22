// Tiled neural inference support.
//
// extract:   working texture → NCHW float32 tile, encoded (gain + sRGB curve)
//            with mirrored padding beyond the image edge.
// accum:     net output (or the input itself, for tiles that were skipped)
//            → strip accumulator  acc += w · value,  acc.a += w
//            w is a separable feather that is 1 in the tile core and ramps
//            down across the overlap, so overlapping tiles blend exactly
//            (partition of unity after normalisation).
// finalize:  accumulator rows → decode → working texture; highlights beyond
//            the encoded range (where the network saw a clipped value) keep
//            the original scene-linear data.
// shift:     moves the unfinished tail of the accumulator up for the next strip.
// check:     per-tile sanity statistics of the net output (NAFNet gate).

struct P {
  img_w: u32, img_h: u32,
  tile: u32, overlap: u32,
  tx: i32, ty: i32,          // tile origin in image space
  acc_y: i32,                // image row held in accumulator row 0
  acc_h: u32,
  mode: u32,                 // accum: 1 = use net output, 0 = identity
  rows: u32,                 // finalize: rows to write; shift: rows to move by
  gain: f32,
  strength: f32,
  edge_l: u32, edge_r: u32, edge_t: u32, edge_b: u32, // 1 = image border (no feather)
}
@group(0) @binding(0) var<uniform> p: P;

fn mirror(v: i32, n: i32) -> i32 {
  var x = v;
  if (x < 0) { x = -x; }
  if (x >= n) { x = 2 * n - 2 - x; }
  return clamp(x, 0, n - 1);
}

fn enc(c: vec3<f32>) -> vec3<f32> {
  return srgb_oetf(clamp(c * p.gain, vec3<f32>(0.0), vec3<f32>(1.0)));
}
