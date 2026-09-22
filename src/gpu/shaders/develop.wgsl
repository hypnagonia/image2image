// RAW development: sensor integers → linear working RGB (Rec.2020, scene-referred).
//
// Runs strip by strip: the CPU uploads `strip_rows` rows of the active area
// (plus a 2-row apron above/below for the demosaic) and each invocation
// produces one output pixel of the (optionally downscaled) image, written at
// its *oriented* position. The full-resolution sensor data never has to exist
// on the GPU at once.
//
// Per source pixel:
//   camera = (raw - black[cfa]) / (white[cfa] - black[cfa])      black/white level
//   demosaic (Bayer only, Malvar–He–Cutler 5×5)
//   clipped = any channel ≥ 1 before white balance
//   balanced = camera · gains                                      as-shot / chosen WB, camera space
//   clipped pixels: balanced = min(balanced, 1)                   no hue shift, nothing invented
//   working = M · balanced · 2^baseline                            camera matrix
// Output alpha = fraction of the footprint that was clipped in the RAW.

struct P {
  src_w: u32, src_h: u32,          // active area
  strip_y0: i32,                   // active-area row held in strip texture row 0
  own_y0: u32, own_y1: u32,        // active-area rows this dispatch owns (multiple of factor)
  factor: u32,                     // integer downscale
  out_w: u32, out_h: u32,          // unrotated downscaled size
  orient: u32,                     // EXIF orientation 1..8
  strip_h: u32,
  _p0: u32, _p1: u32,
  cfa: vec4<u32>,                  // colour at (0,0),(0,1),(1,0),(1,1): 0=R 1=G 2=B
  black: vec4<f32>,
  inv_range: vec4<f32>,
  gains: vec4<f32>,                // camera-space WB gains (rgb), w = exposure scale
  m: mat3x3<f32>,
}

@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var src: texture_2d<u32>;

fn orient_xy(x: u32, y: u32) -> vec2<u32> {
  let W = p.out_w; let H = p.out_h;
  switch p.orient {
    case 2u: { return vec2<u32>(W - 1u - x, y); }
    case 3u: { return vec2<u32>(W - 1u - x, H - 1u - y); }
    case 4u: { return vec2<u32>(x, H - 1u - y); }
    case 5u: { return vec2<u32>(y, x); }
    case 6u: { return vec2<u32>(H - 1u - y, x); }
    case 7u: { return vec2<u32>(H - 1u - y, W - 1u - x); }
    case 8u: { return vec2<u32>(y, W - 1u - x); }
    default: { return vec2<u32>(x, y); }
  }
}

fn cfa_at(x: i32, y: i32) -> u32 {
  let i = u32(y & 1) * 2u + u32(x & 1);
  return p.cfa[i];
}

// Normalised raw sample at active-area coordinates (mirrored at the edges).
fn rawv(x0: i32, y0: i32) -> f32 {
  var x = x0; var y = y0;
  let W = i32(p.src_w); let H = i32(p.src_h);
  if (x < 0) { x = -x; } if (x >= W) { x = 2 * W - 2 - x; }
  if (y < 0) { y = -y; } if (y >= H) { y = 2 * H - 2 - y; }
  // Mirroring by an even offset keeps the CFA colour, so black/white of the
  // *requested* site are correct. Keep parity: mirror by 2 when parity flips.
  if ((x & 1) != (x0 & 1)) { x = x + select(1, -1, x >= W - 1); }
  if ((y & 1) != (y0 & 1)) { y = y + select(1, -1, y >= H - 1); }
  let sy = clamp(y - p.strip_y0, 0, i32(p.strip_h) - 1);
  let v = f32(textureLoad(src, vec2<i32>(x, sy), 0).r);
  let c = cfa_at(x0, y0);
  return (v - p.black[c]) * p.inv_range[c];
}

// Malvar–He–Cutler: high-quality linear demosaic, 5×5 support.
fn demosaic(x: i32, y: i32) -> vec3<f32> {
  let c = cfa_at(x, y);
  let C = rawv(x, y);
  let n1 = rawv(x, y - 1); let s1 = rawv(x, y + 1); let w1 = rawv(x - 1, y); let e1 = rawv(x + 1, y);
  let n2 = rawv(x, y - 2); let s2 = rawv(x, y + 2); let w2 = rawv(x - 2, y); let e2 = rawv(x + 2, y);
  let nw = rawv(x - 1, y - 1); let ne = rawv(x + 1, y - 1); let sw = rawv(x - 1, y + 1); let se = rawv(x + 1, y + 1);
  if (c == 1u) {
    // Green site. Horizontal neighbours are R or B.
    let hc = cfa_at(x + 1, y);
    // Colour whose samples lie left/right of this site.
    let horiz = (5.0 * C + 4.0 * (w1 + e1) - (w2 + e2) - (nw + ne + sw + se) + 0.5 * (n2 + s2)) / 8.0;
    // Colour whose samples lie above/below.
    let vert = (5.0 * C + 4.0 * (n1 + s1) - (n2 + s2) - (nw + ne + sw + se) + 0.5 * (w2 + e2)) / 8.0;
    if (hc == 0u) { return vec3<f32>(horiz, C, vert); }
    return vec3<f32>(vert, C, horiz);
  }
  let g = (4.0 * C + 2.0 * (n1 + s1 + w1 + e1) - (n2 + s2 + w2 + e2)) / 8.0;
  let opp = (6.0 * C + 2.0 * (nw + ne + sw + se) - 1.5 * (n2 + s2 + w2 + e2)) / 8.0;
  if (c == 0u) { return vec3<f32>(C, g, opp); }
  return vec3<f32>(opp, g, C);
}

fn develop_px(cam_in: vec3<f32>, clipped_raw: bool, acc: ptr<function, vec4<f32>>) {
  var cam = cam_in;
  let clipped = clipped_raw || max(cam.r, max(cam.g, cam.b)) >= 0.9995;
  var bal = max(cam, vec3<f32>(0.0)) * p.gains.rgb;
  if (clipped) { bal = min(bal, vec3<f32>(1.0)); }
  let w = p.m * bal * p.gains.w;
  *acc = *acc + vec4<f32>(w, select(0.0, 1.0, clipped));
}

@compute @workgroup_size(16, 8)
fn bayer(@builtin(global_invocation_id) id: vec3<u32>) {
  let ox = id.x;
  let oy = p.own_y0 / p.factor + id.y;
  if (ox >= p.out_w || oy * p.factor >= p.own_y1 || oy >= p.out_h) { return; }
  var acc = vec4<f32>(0.0);
  for (var j = 0u; j < p.factor; j++) {
    for (var i = 0u; i < p.factor; i++) {
      let x = i32(ox * p.factor + i);
      let y = i32(oy * p.factor + j);
      let cam = demosaic(x, y);
      develop_px(cam, rawv(x, y) >= 0.9995, &acc);
    }
  }
  let n = f32(p.factor * p.factor);
  textureStore(dst, orient_xy(ox, oy), acc / n);
}

@compute @workgroup_size(16, 8)
fn linear(@builtin(global_invocation_id) id: vec3<u32>) {
  let ox = id.x;
  let oy = p.own_y0 / p.factor + id.y;
  if (ox >= p.out_w || oy * p.factor >= p.own_y1 || oy >= p.out_h) { return; }
  var acc = vec4<f32>(0.0);
  for (var j = 0u; j < p.factor; j++) {
    for (var i = 0u; i < p.factor; i++) {
      let x = i32(ox * p.factor + i);
      let y = i32(oy * p.factor + j) - p.strip_y0;
      let v = vec4<f32>(textureLoad(src, vec2<i32>(x, y), 0));
      let cam = (v.rgb - p.black.rgb) * p.inv_range.rgb;
      develop_px(cam, false, &acc);
    }
  }
  let n = f32(p.factor * p.factor);
  textureStore(dst, orient_xy(ox, oy), acc / n);
}
