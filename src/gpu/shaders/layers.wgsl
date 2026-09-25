// Adjustment layers (src/layers): appended to render_tone.wgsl and run inside
// its per-pixel pass, after the technical colour stage. Each layer: adjusted
// colour → blend mode against what is below → mixed in by opacity × smart mask.
// Record layout: src/layers/gpu.ts.

struct LayerRec {
  a: vec4<f32>,   // type, blend, opacity, atlas row (−1 none)
  m0: vec4<f32>,  // mask kind, region (11 = skin), band, invert
  m1: vec4<f32>,  // luminance low, high, softness, feather
  r: vec4<f32>,   // density, except skin, _, _
  p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, // type parameters
}
@group(0) @binding(21) var<storage, read> layers: array<LayerRec>;

fn atlas_at(row: f32, x: f32) -> vec4<f32> {
  return textureSampleLevel(atlas, lsamp, vec2<f32>(clamp(x, 0.0, 1.0), (row + 0.5) / f32(max(u.lay.y, 1u))), 0.0);
}

/**
 * Sky at pixel level. The segmentation is coarse: at branch scale (a tree line,
 * gaps in a canopy) its sky probability fades out early and leaves an unedited
 * pale halo. Where the map says "maybe sky", the pixel decides: bright and not
 * green is sky, dark (branches, trunks) is not. Where the map is sure, it stays.
 * `e` is the colour before the layers (so earlier layers do not move the mask).
 */
fn sky_mask(p: f32, e: vec3<f32>, uv: vec2<f32>, other: f32) -> f32 {
  // Only near sky the map already sees (not water or a white wall far from it):
  // where the map itself is unsure, or confident sky lies within ≈ 7 % of the
  // picture (sky seen through a canopy or between trunks, next to open sky).
  let gp = uv * vec2<f32>(gsz());
  let R = 0.07 * f32(max(gsz().x, gsz().y));
  // The most confident sky around, and its colour (both in the analysis encoding).
  var near = 0.0;
  var sky_c = vec3<f32>(0.0);
  for (var k = 0; k < 12; k++) {
    let a = f32(k) * 0.5235988;
    let d = vec2<f32>(cos(a), sin(a));
    for (var r = 0; r < 2; r++) {
      let q = vec2<i32>(gp + d * R * select(1.0, 0.45, r == 1));
      let s = gl(m0, q).x;
      if (s > near) { near = s; sky_c = gl(guide, q).rgb; }
    }
  }
  // Reaching out only to what looks like that sky (white paint next to blue sky does not).
  // Same colour, any brightness: sky seen through a canopy is often brighter than the
  // open sky beside it. The brightness offset is removed before comparing.
  let dc = pix_enc - sky_c;
  let same = 1.0 - smoothstep(0.03, 0.09, length(dc - vec3<f32>((dc.r + dc.g + dc.b) / 3.0)));
  let nearSky = smoothstep(0.6, 0.95, near) * same;
  // Never into what the map sees as water (it mirrors the sky's colour) or buildings.
  let reach = max(smoothstep(0.12, 0.45, p), 0.95 * nearSky) * (1.0 - smoothstep(0.2, 0.5, other));
  let y = dot(e, LUMAP3);
  // Sky's own colours: bright and neutral (overcast), or clearly blue even when darker;
  // not green (leaves), not warm (lit walls, signs, skin). Next to known sky the
  // brightness bar is lower, so pixels half sky, half twig are not left as pale fringes.
  let lo = mix(0.35, 0.22, nearSky);
  let blue = smoothstep(0.04, 0.12, e.b - e.r) * smoothstep(0.12, 0.25, y);
  let skyish = max(smoothstep(lo, lo + 0.25, y), blue) * (1.0 - smoothstep(0.02, 0.1, e.g - max(e.r, e.b))) * (1.0 - smoothstep(0.0, 0.06, e.r - e.b));
  return max(smoothstep(0.75, 0.97, p), reach * skyish);
}

/** The layer's smart mask at this pixel (0…1), before opacity. `e0`: the colour before the layers. */
fn layer_mask(L: LayerRec, g: array<f32, 12>, dist: f32, skin_w: f32, e: vec3<f32>, e0: vec3<f32>, uv: vec2<f32>) -> f32 {
  var gs = g;
  let kind = u32(L.m0.x);
  let reg = u32(L.m0.y);
  let bw = band_w(dist);
  var m = 1.0;
  var pr = clamp(gs[min(reg, 10u)], 0.0, 1.0);
  if (reg == 0u && (kind == 1u || kind == 3u)) { pr = sky_mask(pr, e0, uv, max(gs[5], gs[2])); }
  if (kind == 1u) { m = select(pr, skin_w, reg == 11u); }
  else if (kind == 2u) { m = bw[min(u32(L.m0.z), 2u)]; }
  else if (kind == 3u) { m = pr * bw[min(u32(L.m0.z), 2u)]; }
  else if (kind == 4u) {
    let y = dot(e, LUMAP3);
    let s = max(L.m1.z, 1e-3);
    // A range that starts at black or ends at white covers it fully (no half-strength edge there).
    let lo = select(smoothstep(L.m1.x - s, L.m1.x + s, y), 1.0, L.m1.x <= 0.0);
    let hi = select(1.0 - smoothstep(L.m1.y - s, L.m1.y + s, y), 1.0, L.m1.y >= 1.0);
    m = lo * hi;
  }
  // Feather 1 = the mask's own soft edge; 0 = a hard edge at its middle.
  m = mix(smoothstep(0.45, 0.55, m), m, clamp(L.m1.w, 0.0, 1.0));
  if (L.m0.w > 0.5) { m = 1.0 - m; }
  // Faces keep their own correction: region and distance colour do not reach skin.
  if (L.r.y > 0.5) { m *= 1.0 - skin_w; }
  return m * clamp(L.r.x, 0.0, 1.0);
}

/**
 * Exposure gain `g` on display-linear colour with a highlight shoulder: brightening
 * maps full to full (m·g / (1 + (g − 1)·m³)) instead of clipping, midtones get
 * almost the full gain. The shoulder follows the brightest channel, not luminance:
 * a warm highlight (blonde hair against the sun) has red far above its luminance
 * and would clip to flat yellow-white first. One ratio for all channels keeps the hue.
 * Darkening is a plain multiply. g = 1 leaves the colour untouched.
 */
fn expose(lin: vec3<f32>, g: f32) -> vec3<f32> {
  if (g <= 1.0) { return lin * g; }
  let m = clamp(max(lin.r, max(lin.g, lin.b)), 1e-6, 1.0);
  let m2 = m * g / (1.0 + (g - 1.0) * m * m * m);
  return lin * (m2 / m);
}

/**
 * Highlight protection: what the layers added above the colour's own brightest
 * channel (before the layers) is compressed so it approaches white but does not
 * clip; already clipped colours and everything that got darker are untouched.
 */
fn protect_highlights(e0: vec3<f32>, e: vec3<f32>) -> vec3<f32> {
  let m0 = max(e0.r, max(e0.g, e0.b));
  let m1 = max(e.r, max(e.g, e.b));
  let head = 1.0 - m0;
  if (m1 <= m0 || m1 < 0.8 || head < 1e-3) { return e; }
  // f: share of the headroom the layers used (≥ 1 = clipped); keep at most ~85 % of it.
  let f = (m1 - m0) / head;
  let fk = 0.85 * (1.0 - exp(-f / 0.85));
  let mt = m0 + head * min(f, fk);
  return e * (mt / m1);
}

fn op_curves(L: LayerRec, e: vec3<f32>) -> vec3<f32> {
  let row = L.a.w;
  let l = vec3<f32>(atlas_at(row, e.r).r, atlas_at(row, e.g).r, atlas_at(row, e.b).r);
  return vec3<f32>(atlas_at(row, l.r).g, atlas_at(row, l.g).b, atlas_at(row, l.b).a);
}

/** Photoshop's hue (HSV, 0…1 for 0…360°) of a display-encoded colour: what the colour ranges are defined in. */
fn hsv_hue(c: vec3<f32>) -> f32 {
  let mx = max(c.r, max(c.g, c.b));
  let d = mx - min(c.r, min(c.g, c.b));
  if (d < 1e-6) { return 0.0; }
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d; }
  else if (mx == c.g) { h = 2.0 + (c.b - c.r) / d; }
  else { h = 4.0 + (c.r - c.g) / d; }
  return fract(h / 6.0 + 1.0);
}
/** The fully saturated colour of an HSV hue (radians). */
fn hue_rgb(h: f32) -> vec3<f32> {
  let x = fract(h / (2.0 * PI)) * 6.0;
  return clamp(vec3<f32>(abs(x - 3.0) - 1.0, 2.0 - abs(x - 2.0), 2.0 - abs(x - 4.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn op_huesat(L: LayerRec, e: vec3<f32>) -> vec3<f32> {
  var lab = enc_to_lab(e);
  var C = length(lab.yz);
  var h = atan2(lab.z, lab.y);
  var light = 0.0;
  if (L.p0.x > 0.5) {
    // Colorize: one hue and saturation for everything, lightness kept.
    // (the hue slider is in Photoshop degrees: take that colour's OkLab hue)
    let hc = enc_to_lab(hue_rgb(L.p0.y));
    h = atan2(hc.z, hc.y); C = L.p0.z * 0.25; light = L.p0.w;
  } else {
    let t = atlas_at(L.a.w, hsv_hue(e));
    let cw = smoothstep(0.008, 0.04, C); // greys have no hue to shift
    h += cw * t.r;
    C *= max(0.0, 1.0 + t.g);
    light = t.b;
  }
  var o = lab_to_enc(vec3<f32>(lab.x, vec2<f32>(cos(h), sin(h)) * C));
  // Lightness as in Photoshop: toward white above 0, toward black below.
  o = select(o * (1.0 + light), mix(o, vec3<f32>(1.0), light), light > 0.0);
  return o;
}

fn op_bright_contrast(L: LayerRec, e: vec3<f32>) -> vec3<f32> {
  let y = max(dot(e, LUMAP3), 1e-5);
  // Brightness bends the curve (black and white stay), contrast is an S around mid-grey.
  var y1 = pow(y, 1.0 / (1.0 + 0.6 * clamp(L.p0.x, -1.0, 1.0)));
  y1 = clamp(y1 + clamp(L.p0.y, -1.0, 1.0) * (y1 - 0.5) * 4.0 * y1 * (1.0 - y1), 0.0, 1.0);
  return clamp(e * (y1 / y), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn op_exposure(L: LayerRec, e: vec3<f32>) -> vec3<f32> {
  var lin = expose(srgb_eotf(e), exp2(L.p0.x)) + vec3<f32>(L.p0.y);
  lin = pow(clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / max(L.p0.z, 0.05)));
  return srgb_oetf(lin);
}

fn op_basic(L: LayerRec, e: vec3<f32>) -> vec3<f32> {
  var lin = srgb_eotf(e);
  if (abs(L.p0.x) > 1e-4) { lin = clamp(expose(lin, exp2(L.p0.x)), vec3<f32>(0.0), vec3<f32>(1.0)); }
  var lab = lin_srgb_to_oklab(P3_TO_SRGB * lin);
  let C = length(lab.yz);
  let vgain = 1.0 + L.p1.x * (1.0 - smoothstep(0.0, 0.2, C));
  var ab = lab.yz * max((1.0 + L.p0.w) * vgain, 0.0);
  if (abs(L.p1.y) > 1e-4) { let cs = cos(L.p1.y); let sn = sin(L.p1.y); ab = vec2<f32>(ab.x * cs - ab.y * sn, ab.x * sn + ab.y * cs); }
  // Temperature / tint as OkLab b / a offsets, fading toward black and white.
  let edge = smoothstep(0.02, 0.15, lab.x) * (1.0 - smoothstep(0.93, 1.0, lab.x));
  ab += edge * vec2<f32>(0.03 * L.p0.z, 0.035 * L.p0.y);
  return lab_to_enc(vec3<f32>(lab.x, ab));
}

fn blend_ch(mode: u32, b: f32, t: f32) -> f32 {
  switch mode {
    case 1u: { return b * t; }
    case 2u: { return 1.0 - (1.0 - b) * (1.0 - t); }
    case 3u: { return select(1.0 - 2.0 * (1.0 - b) * (1.0 - t), 2.0 * b * t, b < 0.5); }
    case 4u: { // soft light (W3C)
      let d = select(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, b <= 0.25);
      return select(b + (2.0 * t - 1.0) * (d - b), b - (1.0 - 2.0 * t) * b * (1.0 - b), t <= 0.5);
    }
    case 5u: { return select(1.0 - 2.0 * (1.0 - t) * (1.0 - b), 2.0 * b * t, t < 0.5); }
    case 6u: { return min(b, t); }
    case 7u: { return max(b, t); }
    default: { return t; }
  }
}

fn blend_modes(mode: u32, b: vec3<f32>, t: vec3<f32>) -> vec3<f32> {
  if (mode <= 7u) { return vec3<f32>(blend_ch(mode, b.r, t.r), blend_ch(mode, b.g, t.g), blend_ch(mode, b.b, t.b)); }
  // Hue / saturation / color / luminosity: in OkLab, so lightness is perceptual.
  let lb = enc_to_lab(b);
  let lt = enc_to_lab(t);
  let Cb = length(lb.yz); let Ct = length(lt.yz);
  let hb = atan2(lb.z, lb.y); let ht = atan2(lt.z, lt.y);
  var o = lb;
  if (mode == 8u) { o = vec3<f32>(lb.x, vec2<f32>(cos(ht), sin(ht)) * Cb); }
  else if (mode == 9u) { o = vec3<f32>(lb.x, vec2<f32>(cos(hb), sin(hb)) * Ct); }
  else if (mode == 10u) { o = vec3<f32>(lb.x, lt.yz); }
  else { o = vec3<f32>(lt.x, lb.yz); }
  return lab_to_enc(o);
}

/** Gradient Map: brightness → a colour of the gradient (alpha in .a). */
fn op_gradient_map(L: LayerRec, e: vec3<f32>) -> vec4<f32> {
  let y = clamp(dot(e, LUMAP3), 0.0, 1.0);
  return atlas_at(L.a.w, select(y, 1.0 - y, L.p0.x > 0.5));
}

/** Gradient Fill at picture position uv (0…1), picture aspect w/h. */
fn op_gradient_fill(L: LayerRec, uv: vec2<f32>, aspect: f32) -> vec4<f32> {
  let d = vec2<f32>((uv.x - L.p1.x) * aspect, uv.y - L.p1.y);
  var t = 0.0;
  if (L.p0.x > 0.5) {
    // radial: 1 at the picture's far corner (scale 1)
    t = length(d) / (L.p0.z * 0.5 * length(vec2<f32>(aspect, 1.0)));
  } else {
    let dir = vec2<f32>(cos(L.p0.y), sin(L.p0.y)); // 90° = downwards
    let ext = 0.5 * (abs(dir.x) * aspect + abs(dir.y));
    t = 0.5 + dot(d, dir) / (2.0 * ext * L.p0.z);
  }
  t = clamp(t, 0.0, 1.0);
  return atlas_at(L.a.w, select(t, 1.0 - t, L.p0.w > 0.5));
}

/** Runs every visible layer, bottom to top. */
fn apply_layers(e0: vec3<f32>, g: array<f32, 12>, dist: f32, skin_w: f32, uv: vec2<f32>, aspect: f32) -> vec3<f32> {
  var e = e0;
  let n = u.lay.x;
  for (var i = 0u; i < n; i++) {
    let L = layers[i];
    var w = L.a.z * layer_mask(L, g, dist, skin_w, e, e0, uv);
    if (w < 1e-4) { continue; }
    var t = e;
    switch u32(L.a.x) {
      case 0u: { t = op_curves(L, e); }
      case 1u: { t = op_huesat(L, e); }
      case 2u: { t = op_bright_contrast(L, e); }
      case 3u: { t = op_exposure(L, e); }
      case 4u: { t = op_basic(L, e); }
      case 5u: { let c = op_gradient_map(L, e); t = c.rgb; w *= c.a; }
      case 6u: { let c = op_gradient_fill(L, uv, aspect); t = c.rgb; w *= c.a; }
      default: { }
    }
    e = mix(e, clamp(blend_modes(u32(L.a.y), e, t), vec3<f32>(0.0), vec3<f32>(1.0)), w);
  }
  if (u.lay.w != 0u) { e = protect_highlights(e0, e); }
  return e;
}
