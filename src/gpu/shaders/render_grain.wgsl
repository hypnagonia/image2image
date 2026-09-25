// Film grain — the last pass before output, after sharpening and depth of field
// (grain lies on the film: it is neither sharpened nor blurred with the scene).
//
//   pattern    two octaves of gradient noise (quintic fade, unit gradients at
//              hashed angles — isotropic, no lattice artefacts): particles of
//              the chosen size plus coarser clumps (roughness), unit RMS
//   size       defined in full-image pixels, scaled with the image (the same
//              film on a 12 MP and a 48 MP frame); positions are full-image
//              coordinates, so strips, the preview and the export share one
//              pattern
//   footprint  an output pixel that covers F full-image pixels (preview proxy,
//              thumbnails) averages the full-resolution grain at up to 5×5 of
//              the full-image pixel centres it covers — exactly what shrinking
//              the export would show (measured: equal RMS for whole-number F up
//              to 5, within ≈ 20% in between); beyond 5 the rest is damped as
//              independent samples. What is seen is what is exported.
//   response   added to display-encoded values (perceptually even), strongest
//              in the mid-tones, fading to zero at black and white (clipping
//              one side of the noise would otherwise lift blacks / dull whites)
//   colour     independent per-channel grain mixed in around the luminance
//              grain (dye clouds); 0 = monochrome grain

struct U {
  size: vec4<u32>,   // W, H of this texture, row offset in the full image, input is linear
  g: vec4<f32>,      // amount (RMS in encoded units), particle size (full-image px), roughness, colour
  f: vec4<f32>,      // footprint (full-image px per output px), _, _, _
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;

const TAU = 6.2831853;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn grad(i: vec2<i32>, seed: u32) -> vec2<f32> {
  let h = pcg(pcg(bitcast<u32>(i.x) ^ seed) + bitcast<u32>(i.y) * 0x9e3779b9u);
  let a = f32(h) * (TAU / 4294967296.0);
  return vec2<f32>(cos(a), sin(a));
}
/** Gradient noise, normalised to unit RMS (measured RMS of the raw noise: 0.216). */
fn gnoise(x: vec2<f32>, seed: u32) -> f32 {
  let i = vec2<i32>(floor(x));
  let f = x - floor(x);
  let q = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let n00 = dot(grad(i, seed), f);
  let n10 = dot(grad(i + vec2<i32>(1, 0), seed), f - vec2<f32>(1.0, 0.0));
  let n01 = dot(grad(i + vec2<i32>(0, 1), seed), f - vec2<f32>(0.0, 1.0));
  let n11 = dot(grad(i + vec2<i32>(1, 1), seed), f - vec2<f32>(1.0, 1.0));
  return mix(mix(n00, n10, q.x), mix(n01, n11, q.x), q.y) * 4.63;
}
/** The full-resolution grain field (unit RMS) at full-image position p: particles plus clumps. */
fn grain(p: vec2<f32>, seed: u32) -> f32 {
  let s1 = u.g.y;
  let s2 = u.g.y * 2.6;
  let w2 = 0.9 * u.g.z;
  return (gnoise(p / s1, seed) + w2 * gnoise(p / s2, seed ^ 0x51ed27u)) / sqrt(1.0 + w2 * w2);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u.size.x || id.y >= u.size.y) { return; }
  let c = textureLoad(src, vec2<i32>(id.xy), 0);
  var e = c.rgb;
  if (u.size.w != 0u) { e = srgb_oetf(max(c.rgb, vec3<f32>(0.0))); }
  // The full-image pixels this output pixel covers: their grain, averaged.
  let F = max(u.f.x, 1.0);
  let o = (vec2<f32>(id.xy) + vec2<f32>(0.0, f32(u.size.z))) * F;
  // Drafts (u.f.y = 1) average fewer grain samples: the grain is too fine to see while dragging.
  let k = min(select(5u, 2u, u.f.y > 0.5), u32(ceil(F - 1e-3)));
  let colour = u.g.w > 0.0;
  var gl = 0.0;
  var gc = vec3<f32>(0.0);
  for (var j = 0u; j < k; j++) {
    for (var i = 0u; i < k; i++) {
      let p = floor(o + (vec2<f32>(f32(i), f32(j)) + 0.5) * (F / f32(k))) + 0.5;
      gl += grain(p, 0x2545f491u);
      if (colour) { gc += vec3<f32>(grain(p, 0x9e3779b1u), grain(p, 0x85ebca77u), grain(p, 0xc2b2ae3du)); }
    }
  }
  let norm = min(1.0, f32(k) / F) / f32(k * k);
  gl *= norm;
  gc *= norm;
  let L = dot(e, LUMAP3);
  let resp = mix(0.35, 1.0, smoothstep(0.02, 0.3, L)) * (1.0 - 0.6 * smoothstep(0.55, 1.0, L))
    * smoothstep(0.0, 0.05, L) * (1.0 - smoothstep(0.95, 1.0, L));
  var n = vec3<f32>(gl);
  // Colour grain: independent dye clouds around the luminance grain (their mean removed, so brightness grain stays the same).
  if (colour) { n = mix(n, gl + (gc - vec3<f32>(dot(gc, vec3<f32>(1.0 / 3.0)))) * 0.8, u.g.w); }
  e = clamp(e + n * (u.g.x * resp), vec3<f32>(0.0), vec3<f32>(1.0));
  var outc = e;
  if (u.size.w != 0u) { outc = srgb_eotf(e); }
  textureStore(dst, vec2<i32>(id.xy), vec4<f32>(outc, c.a));
}
