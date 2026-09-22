// Shared helpers, prepended to every shader module.

// Rec.2020 luminance (row Y of Rec.2020→XYZ).
const LUMA2020 = vec3<f32>(0.2627002, 0.6779981, 0.0593017);
// Display P3 luminance.
const LUMAP3 = vec3<f32>(0.2289746, 0.6917385, 0.0792869);

fn luma2020(c: vec3<f32>) -> f32 { return dot(c, LUMA2020); }

fn srgb_oetf1(x: f32) -> f32 {
  let v = max(x, 0.0);
  return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, 12.92 * v, v <= 0.0031308);
}
fn srgb_eotf1(x: f32) -> f32 {
  let v = max(x, 0.0);
  return select(pow((v + 0.055) / 1.055, 2.4), v / 12.92, v <= 0.04045);
}
fn srgb_oetf(c: vec3<f32>) -> vec3<f32> { return vec3<f32>(srgb_oetf1(c.r), srgb_oetf1(c.g), srgb_oetf1(c.b)); }
fn srgb_eotf(c: vec3<f32>) -> vec3<f32> { return vec3<f32>(srgb_eotf1(c.r), srgb_eotf1(c.g), srgb_eotf1(c.b)); }

// Working Rec.2020 → Display P3 (linear).
const REC2020_TO_P3 = mat3x3<f32>(
  vec3<f32>(1.3435783, -0.0652975, 0.0028218),
  vec3<f32>(-0.2821797, 1.0757879, -0.0195985),
  vec3<f32>(-0.0613986, -0.0104905, 1.0167767));
const P3_TO_REC2020 = mat3x3<f32>(
  vec3<f32>(0.7538330, 0.0457438, -0.0012103),
  vec3<f32>(0.1985973, 0.9417772, 0.0176017),
  vec3<f32>(0.0475697, 0.0124789, 0.9836086));
const P3_TO_SRGB = mat3x3<f32>(
  vec3<f32>(1.2249401, -0.0420569, -0.0196376),
  vec3<f32>(-0.2249404, 1.0420571, -0.0786361),
  vec3<f32>(0.0, 0.0, 1.0982735));

// OkLab (Björn Ottosson), on linear sRGB-primaries input. We feed it linear P3
// converted to sRGB primaries (unclamped), which keeps the transform exact.
fn lin_srgb_to_oklab(c: vec3<f32>) -> vec3<f32> {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = sign(l) * pow(abs(l), 1.0 / 3.0);
  let m_ = sign(m) * pow(abs(m), 1.0 / 3.0);
  let s_ = sign(s) * pow(abs(s), 1.0 / 3.0);
  return vec3<f32>(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
fn oklab_to_lin_srgb(c: vec3<f32>) -> vec3<f32> {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3<f32>(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

// Log-luminance encoding used by tone mapping and its guided filters:
// maps 2^-16 .. 2^4 onto 0 .. 1.
const LOG_MIN = -16.0;
const LOG_RANGE = 20.0;
fn log_enc(y: f32) -> f32 { return (log2(max(y, 1.52e-5)) - LOG_MIN) / LOG_RANGE; }
fn log_dec(v: f32) -> f32 { return exp2(v * LOG_RANGE + LOG_MIN); }

fn hash21(p: vec2<u32>) -> f32 {
  var h = p.x * 1664525u + p.y * 1013904223u;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967295.0;
}
