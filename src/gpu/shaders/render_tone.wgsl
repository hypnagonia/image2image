// Render pass 1 — per-pixel photographic development at any resolution
// (preview proxy or full-resolution export).
//
//   masks/depth   joint-bilateral upsampling of the refined maps (guide res)
//                 against this pixel, so region boundaries follow real edges
//   denoise       SCUNet result blended in luma and chroma separately, with
//                 strength from noise, semantic class and shadow depth
//   white balance 3×3 in working space  (= camera-space gains, see wb.ts)
//   dehaze        depth-aware haze model  I = J·t + A·(1−t)   (linear light)
//   exposure      global + per-region (e.g. fill for a backlit person)
//   local tone    guided-filter base layers: coarse range compression,
//                 shadows/highlights on the base, medium (clarity) and fine
//                 (texture) detail gains with halo guards, depth-attenuated
//   tone curve    scene log2 Y → display Y (1D LUT), luminance-ratio applied,
//                 chroma rolled off toward white
//   curves        user L/R/G/B point curves (1D LUT) on display-encoded values
//   colour        saturation/vibrance + per-region saturation/hue in OkLab
//   ── end of the technical transform ──
//   look profile  the creative layer (apply_profile): profile tone curve → RGB
//                 curves → 3D LUT (the base look) → hue shaping and hue curves
//                 → opponent (warm/cool) separation → saturation response and
//                 luminance→saturation → palette restriction → colour balance
//                 → spatial refinement: semantic (sky, foliage, urban, lights)
//                 → profile semantic rules → depth curves → depth refinement
//                 (foreground / background / distance) → intensity blend in
//                 OkLab → skin guard
//
// Output: display-encoded Display P3 in rgb; alpha = per-pixel sharpening
// multiplier (semantic × depth) for the detail pass.

struct U {
  size: vec4<u32>,          // W, H, guide w, guide h
  wb: mat3x3<f32>,
  a: vec4<f32>,             // exposure EV, gain k, denoise luma, denoise chroma
  b: vec4<f32>,             // shadow boost, dehaze strength, dehaze beta, dehaze min t
  light: vec4<f32>,         // atmospheric light (linear working), _
  local: vec4<f32>,         // compression, clarity, texture, anchor EV
  tone: vec4<f32>,          // shadows, highlights, depth near mult, depth far mult
  color: vec4<f32>,         // saturation, vibrance, look strength, look size
  flags: vec4<u32>,         // x: enable bits, y: curves on, z: lut on, w: debug view
  sem: array<vec4<f32>, 33>,// per group: [exp, hl, sat, vib] [hue rad, clarity, texture, sharpen] [denoise, dehaze, warmth, tint]
  tgt: vec4<i32>,           // render target: offset x, y in the full image, target width, height (strip rendering)
  hl: vec4<f32>,            // view 5: highlighted depth range (lo, hi)
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var base: texture_2d<f32>;
@group(0) @binding(2) var dn: texture_2d<f32>;
@group(0) @binding(3) var guide: texture_2d<f32>;
@group(0) @binding(4) var m0: texture_2d<f32>;
@group(0) @binding(5) var m1: texture_2d<f32>;
@group(0) @binding(6) var m2: texture_2d<f32>;
@group(0) @binding(7) var tc: texture_2d<f32>;
@group(0) @binding(8) var tm: texture_2d<f32>;
@group(0) @binding(9) var tone_lut: texture_2d<f32>;   // 1-row LUTs: 2D textures sample the same and are universally supported
@group(0) @binding(10) var curve_lut: texture_2d<f32>;
@group(0) @binding(11) var look: texture_3d<f32>;
@group(0) @binding(12) var lsamp: sampler;
@group(0) @binding(13) var dst: texture_storage_2d<rgba16float, write>;
// Per-pixel refined distance for the depth-of-field pass (a 1×1 dummy when DoF is off:
// out-of-bounds stores are discarded).
@group(0) @binding(14) var dist_out: texture_storage_2d<r32float, write>;

// ---------------------------------------------------------------- look profile
struct Prof {
  f: vec4<f32>,               // enabled, intensity, LUT strength, LUT size
  sat: vec4<f32>,             // global, knee, compression, low boost
  zsat: vec4<f32>,            // shadows, highlights, depth curves on, _
  haze: vec4<f32>,            // haze colour (OkLab a, b)
  hue: array<vec4<f32>, 8>,   // per hue range: shift (rad), sat, lum, centre (rad)
  bal: array<vec4<f32>, 3>,   // colour balance per zone: OkLab a, b offsets
  sem: array<vec4<f32>, 11>,  // per semantic group: hue (rad), sat, lum, protect
  pal: vec4<f32>,             // anchor count, pull, focus, width (rad)
  anc: array<vec4<f32>, 6>,   // anchors: hue (rad), chroma ×, weight, _
  opp: vec4<f32>,             // opponent separation: cos, sin of the warm pole, amount, _
  spa: array<vec4<f32>, 3>,   // spatial: (skin, sky, foliage, urban), (emissive, fg, bg contrast, bg sat), (bg cooling, distant, _, _)
}
@group(0) @binding(15) var<uniform> prof: Prof;
@group(0) @binding(16) var prof_curve: texture_2d<f32>;   // r master tone, g/b/a = R/G/B curves
@group(0) @binding(17) var depth_tab: texture_2d<f32>;    // 64×2: (sat, contrast, temp, haze), (black)
@group(0) @binding(18) var hue_tab: texture_2d<f32>;      // 360×2: row 0 hue curves (hue shift rad, chroma ×, L shift), row 1 lightness → chroma ×

const PI = 3.14159265;
const P3_FROM_SRGB = mat3x3<f32>(
  vec3<f32>(0.8224621, 0.0331942, 0.0170827),
  vec3<f32>(0.1775380, 0.9668058, 0.0723974),
  vec3<f32>(0.0, 0.0, 0.9105199));

fn enc_to_lab(e: vec3<f32>) -> vec3<f32> { return lin_srgb_to_oklab(P3_TO_SRGB * srgb_eotf(e)); }
fn lab_to_enc(l: vec3<f32>) -> vec3<f32> {
  var p3 = P3_FROM_SRGB * oklab_to_lin_srgb(l);
  // Out-of-gamut results are pulled toward their own luminance, never clipped per channel.
  let Y = dot(p3, LUMAP3);
  let mn = min(p3.r, min(p3.g, p3.b));
  if (mn < 0.0) { p3 = mix(p3, vec3<f32>(Y), clamp(-mn / max(Y - mn, 1e-6), 0.0, 1.0)); }
  let mx = max(p3.r, max(p3.g, p3.b));
  if (mx > 1.0) { p3 = mix(p3, vec3<f32>(min(Y, 1.0)), clamp((mx - 1.0) / max(mx - Y, 1e-6), 0.0, 1.0)); }
  return srgb_oetf(clamp(p3, vec3<f32>(0.0), vec3<f32>(1.0)));
}
fn angdiff(a: f32, b: f32) -> f32 {
  var d = a - b;
  d = d - 2.0 * PI * floor((d + PI) / (2.0 * PI));
  return d;
}
/** Smooth luminance zones (shadows, midtones, highlights) on OkLab L; sums to 1. */
fn zones(L: f32) -> vec3<f32> {
  let s = 1.0 - smoothstep(0.28, 0.58, L);
  let h = smoothstep(0.6, 0.88, L);
  return vec3<f32>(s, max(0.0, 1.0 - s - h), h);
}

fn apply_profile(e_tech: vec3<f32>, g: array<f32, 12>, dist: f32) -> vec3<f32> {
  var gw = g;
  // Spatial weights. Masks arrive soft (guided-filter refined, joint-bilaterally
  // upsampled against this pixel), depth continuous; every weight below is 0…1.
  // Skin = person mask × skin-colour likelihood of the technical colour (OkLab
  // hue ≈ 25…80°, moderate chroma, not black/white): faces and hands, not the
  // shirt. Priority: skin > semantic objects > global palette > depth.
  let lab_t = enc_to_lab(e_tech);
  let Ct = length(lab_t.yz);
  let ht = atan2(lab_t.z, lab_t.y);
  let skin_col = exp(-pow(angdiff(ht, 0.9) / 0.45, 2.0)) * smoothstep(0.012, 0.03, Ct) * (1.0 - smoothstep(0.17, 0.24, Ct))
    * smoothstep(0.12, 0.28, lab_t.x) * (1.0 - smoothstep(0.93, 0.99, lab_t.x));
  let skin = clamp(clamp(gw[6], 0.0, 1.0) * (0.4 + 0.6 * skin_col), 0.0, 1.0) * prof.spa[0].x;
  let local = 1.0 - 0.85 * skin; // local corrections reach skin at ~15%
  let w_sky = clamp(gw[0], 0.0, 1.0) * (1.0 - skin);
  // 1. master tone curve on display-encoded luminance, applied as a ratio (no hue shift)
  let lin = srgb_eotf(e_tech);
  let Y = max(dot(lin, LUMAP3), 1e-6);
  let Yt = srgb_eotf1(textureSampleLevel(prof_curve, lsamp, vec2<f32>(srgb_oetf1(Y), 0.5), 0.0).r);
  var e = lab_to_enc(lin_srgb_to_oklab(P3_TO_SRGB * (lin * (Yt / Y))));
  // 2. RGB curves
  e = vec3<f32>(textureSampleLevel(prof_curve, lsamp, vec2<f32>(e.r, 0.5), 0.0).g,
                textureSampleLevel(prof_curve, lsamp, vec2<f32>(e.g, 0.5), 0.0).b,
                textureSampleLevel(prof_curve, lsamp, vec2<f32>(e.b, 0.5), 0.0).a);
  // 3. the base look: the 3D LUT defines the broad palette; everything below
  //    shapes that result rather than replacing it
  if (prof.f.z > 0.0) {
    let n = prof.f.w;
    let uvw = clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)) * ((n - 1.0) / n) + 0.5 / n;
    e = mix(e, textureSampleLevel(look, lsamp, uvw, 0.0).rgb, prof.f.z);
  }
  // 4. hue-dependent shaping: raised-cosine windows around 8 centres, normalised
  var lab = enc_to_lab(e);
  var C = length(lab.yz);
  var h = atan2(lab.z, lab.y);
  let cw = smoothstep(0.008, 0.045, C); // neutrals are not "a hue"
  var hs = 0.0; var ss = 0.0; var ls = 0.0; var wsum = 1e-4;
  for (var i = 0u; i < 8u; i++) {
    let r = prof.hue[i];
    let d = abs(angdiff(h, r.w));
    let w = pow(max(0.0, cos(clamp(d / 0.9, 0.0, 1.0) * PI * 0.5)), 2.0);
    hs += w * r.x; ss += w * r.y; ls += w * r.z; wsum += w;
  }
  h += cw * hs / wsum;
  C *= max(0.0, 1.0 + cw * ss / wsum);
  lab.x += cw * 0.25 * ls / wsum;
  // Continuous hue curves (hue→hue, hue→saturation, hue→luminance), periodic in hue.
  {
    let hx = fract(h / (2.0 * PI) + 1.0) * 360.0;
    let i0 = i32(floor(hx)) % 360; let i1 = (i0 + 1) % 360; let t = fract(hx);
    let hc = mix(textureLoad(hue_tab, vec2<i32>(i0, 0), 0), textureLoad(hue_tab, vec2<i32>(i1, 0), 0), t);
    h += cw * hc.x;
    C *= mix(1.0, max(hc.y, 0.0), cw);
    lab.x += cw * hc.z;
  }
  // 5. opponent separation: stretch colour along the warm ↔ cool axis and
  //    compress it across, so the two poles pull apart without hues rotating
  if (abs(prof.opp.z) > 1e-4) {
    let u = prof.opp.xy;
    let v = vec2<f32>(-u.y, u.x);
    var ab0 = vec2<f32>(cos(h), sin(h)) * C;
    let along = dot(ab0, u);
    let across = dot(ab0, v);
    ab0 = u * (along * (1.0 + 0.35 * prof.opp.z)) + v * (across * (1.0 - 0.25 * prof.opp.z));
    C = length(ab0);
    if (C > 1e-6) { h = atan2(ab0.y, ab0.x); }
  }
  // 6. saturation response: global, per luminance zone, weak-colour boost, high-chroma compression
  let z = zones(lab.x);
  C *= prof.sat.x * (z.x * prof.zsat.x + z.y + z.z * prof.zsat.y);
  C *= 1.0 + prof.sat.w * (1.0 - smoothstep(0.0, 0.12, C));
  // Luminance → saturation (film trait: rich mid-tones, calmer highlights and shadows).
  {
    let xl = clamp(lab.x, 0.0, 1.0) * 359.0;
    let i0 = i32(floor(xl)); let i1 = min(i0 + 1, 359);
    C *= mix(textureLoad(hue_tab, vec2<i32>(i0, 1), 0).x, textureLoad(hue_tab, vec2<i32>(i1, 1), 0).x, fract(xl));
  }
  let knee = prof.sat.y;
  if (C > knee && prof.sat.z > 0.0) { let x = C - knee; C = knee + x / (1.0 + prof.sat.z * x / knee); }
  // 6b. palette restriction: pull hues toward the anchors (closeness-weighted, so a
  //     hue between two anchors drifts toward both), desaturate what is far from all
  let na = u32(prof.pal.x);
  if (na > 0u && C > 1e-4) {
    let width = max(prof.pal.w, 0.05);
    var shift = 0.0; var wsum = 0.0; var near = 0.0; var cmul = 0.0;
    for (var i = 0u; i < na; i++) {
      let a = prof.anc[i];
      let d = angdiff(a.x, h);
      let w = exp(-d * d / (2.0 * width * width)) * a.z;
      shift += w * d; wsum += w; cmul += w * a.y;
      near = max(near, exp(-d * d / (2.0 * 2.0 * width * width)) * a.z);
    }
    let pc = cw * prof.pal.y;
    h += pc * shift / (wsum + 0.05);
    if (wsum > 1e-4) { C *= mix(1.0, cmul / wsum, pc * smoothstep(0.0, 0.3, wsum)); }
    C *= 1.0 - prof.pal.z * (1.0 - near);
  }
  // 7. luminance-dependent colour balance (split toning), fading out toward black and white
  let edge = smoothstep(0.02, 0.12, lab.x) * (1.0 - smoothstep(0.95, 1.0, lab.x));
  var ab = vec2<f32>(cos(h), sin(h)) * C + edge * (prof.bal[0].xy * z.x + prof.bal[1].xy * z.y + prof.bal[2].xy * z.z);
  e = lab_to_enc(vec3<f32>(lab.x, ab));
  lab = enc_to_lab(e);
  // 8. semantic refinement of the palette's result (bounded; soft masks)
  {
    var Lr = lab.x; var Cr = length(lab.yz); var hr = atan2(lab.z, lab.y);
    let sp0 = prof.spa[0];
    // sky: tame over-saturation, lean slightly on the palette's highlight balance, roll bright skies off
    let ws = w_sky * sp0.y;
    if (ws > 1e-3) {
      let kn = 0.09;
      if (Cr > kn) { let x = Cr - kn; Cr = mix(Cr, kn + x / (1.0 + 2.0 * x / kn), ws); }
      Lr = mix(Lr, 0.78 + (Lr - 0.78) * 0.85, ws * smoothstep(0.72, 0.9, Lr));
    }
    // foliage: calmer digital greens, harsh yellow-greens nudged (≤ 4°) toward film greens
    let wf = clamp(gw[1], 0.0, 1.0) * (1.0 - skin) * sp0.z;
    if (wf > 1e-3) {
      let gwin = exp(-pow(angdiff(hr, 2.35) / 0.5, 2.0));
      let yg = exp(-pow(angdiff(hr, 1.95) / 0.3, 2.0));
      Cr *= 1.0 - 0.2 * wf * gwin * smoothstep(0.05, 0.14, Cr);
      hr += 0.07 * wf * yg;
    }
    var ab2 = vec2<f32>(cos(hr), sin(hr)) * Cr;
    if (ws > 1e-3) { ab2 += ws * 0.35 * prof.bal[2].xy; }
    // urban: neutral surfaces stay neutral — palette casts are pulled back toward the
    // technical colour (which keeps the real lighting) — slightly muted and cool
    let wu = clamp(gw[2] + gw[3], 0.0, 1.0) * (1.0 - skin) * sp0.w;
    if (wu > 1e-3) {
      let neutral = 1.0 - smoothstep(0.015, 0.06, Ct);
      ab2 = mix(ab2, lab_t.yz, 0.5 * wu * neutral);
      ab2 *= 1.0 - 0.08 * wu;
      ab2.y -= 0.003 * wu;
    }
    // lights: bright, strongly coloured sources keep their own hue and chroma
    let we = prof.spa[1].x * smoothstep(0.7, 0.88, lab_t.x) * smoothstep(0.05, 0.12, Ct) * (1.0 - skin);
    if (we > 1e-3) {
      let C2 = length(ab2);
      let h2 = atan2(ab2.y, ab2.x);
      let hh = h2 + angdiff(ht, h2) * 0.6 * we;
      ab2 = vec2<f32>(cos(hh), sin(hh)) * mix(C2, max(C2, Ct), we);
    }
    lab = vec3<f32>(Lr, ab2);
  }
  // 9. semantic rules (mask-weighted, soft)
  var sh = 0.0; var sat = 0.0; var sl = 0.0; var protect = 0.0; var tot = 1e-4;
  for (var k = 0u; k < 11u; k++) {
    let w = max(gw[k], 0.0);
    let r = prof.sem[k];
    sh += w * r.x; sat += w * r.y; sl += w * r.z; protect += w * r.w; tot += w;
  }
  sh /= tot; sat /= tot; sl /= tot; protect = clamp(protect / tot, 0.0, 1.0);
  sh *= local; sat *= local; sl *= local;
  ab = lab.yz;
  if (abs(sh) > 1e-5) { let cs = cos(sh); let sn = sin(sh); ab = vec2<f32>(ab.x * cs - ab.y * sn, ab.x * sn + ab.y * cs); }
  ab *= max(0.0, 1.0 + sat);
  var L = lab.x + 0.25 * sl;
  // 10. depth curves (continuous in distance) — never on skin: a face farther away
  //    must not turn colder, darker or greyer
  let dskin = 1.0 - skin;
  if (prof.zsat.z > 0.5) {
    let x = clamp(dist, 0.0, 1.0) * 63.0;
    let i0 = i32(floor(x)); let i1 = min(i0 + 1, 63); let t = fract(x);
    let a = dskin * mix(textureLoad(depth_tab, vec2<i32>(i0, 0), 0), textureLoad(depth_tab, vec2<i32>(i1, 0), 0), t);
    let blk = dskin * mix(textureLoad(depth_tab, vec2<i32>(i0, 1), 0).r, textureLoad(depth_tab, vec2<i32>(i1, 1), 0).r, t);
    ab *= max(0.0, 1.0 + a.x);
    L = 0.6 + (L - 0.6) * (1.0 + a.y);
    ab.y += a.z;
    let hazed = vec3<f32>(0.82, prof.haze.x, prof.haze.y);
    let lab3 = mix(vec3<f32>(L, ab), hazed, clamp(a.w, 0.0, 0.8));
    L = lab3.x; ab = lab3.yz;
    L = blk + L * (1.0 - blk);
  }
  // 11. depth refinement: continuous foreground / background / distance weights,
  //     never on skin or sky, bounded to a few percent
  {
    let sp1 = prof.spa[1]; let sp2 = prof.spa[2];
    let wd = dskin * (1.0 - clamp(gw[0], 0.0, 1.0));
    let d = clamp(dist, 0.0, 1.0);
    let fg = (1.0 - smoothstep(0.08, 0.45, d)) * wd;
    let bg = smoothstep(0.35, 0.85, d) * wd;
    let far = smoothstep(0.7, 1.0, d) * wd;
    let el = smoothstep(0.02, 0.12, L) * (1.0 - smoothstep(0.95, 1.0, L)); // colour shifts fade at black/white
    let pivot = 0.55;
    // foreground: a touch more contrast; a touch warmer unless the palette is a cold one
    L = pivot + (L - pivot) * (1.0 + 0.05 * sp1.y * fg);
    if (prof.bal[1].y >= -0.002) { ab.y += 0.004 * sp1.y * fg * el; }
    // background: softer tonal separation, a little less colour, slightly cooler
    L = pivot + (L - pivot) * (1.0 - 0.08 * sp1.z * bg);
    ab *= 1.0 - 0.12 * sp1.w * bg;
    ab += vec2<f32>(-0.0015, -0.006) * sp2.x * bg * el;
    // distance: faint atmospheric perspective (≤ 10%): lifted blacks, less contrast and colour
    let hz = 0.1 * sp2.y * far;
    let l3 = mix(vec3<f32>(L, ab), vec3<f32>(0.78, prof.haze.x, prof.haze.y), hz);
    L = l3.x; ab = l3.yz;
  }
  // 12. intensity: blend with the technical result in OkLab (perceptual), minus protected
  //    regions; skin keeps ~35% of the palette — graded, never disconnected from it
  let k = clamp(prof.f.y, 0.0, 1.0) * (1.0 - protect) * (1.0 - 0.65 * skin);
  var res = mix(lab_t, vec3<f32>(L, ab), k);
  // 13. skin guard: hue within ±7° of the technical skin hue (no green, magenta or teal
  //     skin), chroma at most +12%, lightness within −0.05 … +0.04 (keeps the rolloff)
  if (skin > 1e-3 && Ct > 0.01) {
    let Cr = length(res.yz);
    let hg = ht + clamp(angdiff(atan2(res.z, res.y), ht), -0.12, 0.12);
    let Cg = min(Cr, Ct * 1.12 + 0.004);
    let Lg = clamp(res.x, lab_t.x - 0.05, lab_t.x + 0.04);
    res = mix(res, vec3<f32>(Lg, vec2<f32>(cos(hg), sin(hg)) * Cg), skin);
  }
  return lab_to_enc(res);
}

const EN_DENOISE = 1u; const EN_WB = 2u; const EN_EXPOSURE = 4u; const EN_LOCAL = 8u;
const EN_SEMANTIC = 16u; const EN_DEHAZE = 32u; const EN_SHARPEN = 64u;

struct Maps { g: array<f32, 12>, dist: f32 }

fn gsz() -> vec2<i32> { return vec2<i32>(i32(u.size.z), i32(u.size.w)); }
fn gl(t: texture_2d<f32>, q: vec2<i32>) -> vec4<f32> { return textureLoad(t, clamp(q, vec2<i32>(0), gsz() - 1), 0); }

// Bilinear fetch from an unfilterable guide-resolution texture.
fn bil(t: texture_2d<f32>, p: vec2<f32>) -> vec4<f32> {
  let f = p - 0.5;
  let i = vec2<i32>(floor(f));
  let w = fract(f);
  return mix(mix(gl(t, i), gl(t, i + vec2<i32>(1, 0)), w.x), mix(gl(t, i + vec2<i32>(0, 1)), gl(t, i + vec2<i32>(1, 1)), w.x), w.y);
}

// Joint bilateral upsampling of masks + distance (3×3 guide-res neighbourhood).
fn maps_at(p: vec2<f32>, enc: vec3<f32>) -> Maps {
  let c = vec2<i32>(floor(p));
  var acc0 = vec4<f32>(0.0); var acc1 = vec4<f32>(0.0); var acc2 = vec4<f32>(0.0);
  var ws = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = c + vec2<i32>(dx, dy);
      let d = (vec2<f32>(q) + 0.5) - p;
      let ws_ = exp(-dot(d, d) / 1.2);
      let gd = gl(guide, q).rgb - enc;
      let wr = exp(-dot(gd, gd) / (2.0 * 0.035 * 0.035)); // strict: maps follow real edges
      let w = ws_ * wr + 1e-5 * ws_;
      acc0 += w * gl(m0, q); acc1 += w * gl(m1, q); acc2 += w * gl(m2, q);
      ws += w;
    }
  }
  acc0 /= ws; acc1 /= ws; acc2 /= ws;
  var m: Maps;
  m.g = array<f32, 12>(acc0.x, acc0.y, acc0.z, acc0.w, acc1.x, acc1.y, acc1.z, acc1.w, acc2.x, acc2.y, acc2.z, 0.0);
  m.dist = acc2.w;
  return m;
}

struct Sem { exp: f32, hl: f32, sat: f32, vib: f32, hue: f32, clarity: f32, texture: f32, sharpen: f32, denoise: f32, dehaze: f32, warmth: f32, tint: f32 }

fn sem_at(m: Maps) -> Sem {
  var s: Sem;
  var a0 = vec4<f32>(0.0); var a1 = vec4<f32>(0.0); var a2 = vec4<f32>(0.0);
  var tot = 0.0;
  var gs = m.g;
  for (var g = 0u; g < 11u; g++) {
    let w = max(gs[g], 0.0);
    a0 += w * u.sem[g * 3u]; a1 += w * u.sem[g * 3u + 1u]; a2 += w * u.sem[g * 3u + 2u];
    tot += w;
  }
  let n = 1.0 / max(tot, 1e-4);
  a0 *= n; a1 *= n; a2 *= n;
  s.exp = a0.x; s.hl = a0.y; s.sat = a0.z; s.vib = a0.w;
  s.hue = a1.x; s.clarity = a1.y; s.texture = a1.z; s.sharpen = a1.w;
  s.denoise = a2.x; s.dehaze = a2.y; s.warmth = a2.z; s.tint = a2.w;
  return s;
}

fn tone_curve(ev: f32) -> f32 {
  let x = clamp((ev + 14.0) / 20.0, 0.0, 1.0);
  return textureSampleLevel(tone_lut, lsamp, vec2<f32>(x, 0.5), 0.0).r;
}

fn soft_detail(d: f32, gain: f32, k: f32) -> f32 {
  // Boost small detail by `gain`, large (edge-sized) detail progressively less — halo guard.
  let extra = (gain - 1.0) * d / (1.0 + k * abs(d) * max(gain - 1.0, 0.0));
  return d + extra;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = u.size.x; let H = u.size.y;
  if (i32(id.x) >= u.tgt.z || i32(id.y) >= u.tgt.w) { return; }
  // Full-image pixel this invocation develops (the target may be a strip with an apron).
  let px = clamp(vec2<i32>(id.xy) + u.tgt.xy, vec2<i32>(0), vec2<i32>(i32(W) - 1, i32(H) - 1));
  let tp = vec2<i32>(id.xy);
  let src0 = textureLoad(base, px, 0);
  let c0 = max(src0.rgb, vec3<f32>(-0.001));
  let k = u.a.y;
  let enc0 = srgb_oetf(clamp(c0 * k, vec3<f32>(0.0), vec3<f32>(1.0)));
  let gp = (vec2<f32>(px) + 0.5) * vec2<f32>(f32(u.size.z), f32(u.size.w)) / vec2<f32>(f32(W), f32(H));
  var maps = maps_at(gp, enc0);
  var sem = sem_at(maps);
  let flags = u.flags.x;
  if ((flags & EN_SEMANTIC) == 0u) {
    sem.exp = 0.0; sem.hl = 0.0; sem.sat = 0.0; sem.vib = 0.0; sem.hue = 0.0;
    sem.clarity = 1.0; sem.texture = 1.0; sem.sharpen = 1.0; sem.denoise = 1.0; sem.dehaze = 1.0; sem.warmth = 0.0; sem.tint = 0.0;
  }
  let dist = clamp(maps.dist, 0.0, 1.0);
  let Y0 = max(luma2020(c0), 1e-6);

  // --- neural denoise blend ---------------------------------------------------
  var c = c0;
  if ((flags & EN_DENOISE) != 0u) {
    let cn = textureLoad(dn, px, 0).rgb;
    let shadow = 1.0 - smoothstep(0.0, 0.35, enc0.g);
    let sl = clamp(u.a.z * sem.denoise * (1.0 + u.b.x * shadow), 0.0, 1.0);
    let sc = clamp(u.a.w * max(sem.denoise, 0.8), 0.0, 1.0);
    let d = cn - c0;
    let dl = luma2020(d);
    c = c0 + vec3<f32>(dl) * sl + (d - vec3<f32>(dl)) * sc;
  }

  // --- white balance -----------------------------------------------------------
  if ((flags & EN_WB) != 0u) { c = u.wb * c; }

  // --- depth-aware dehaze (linear light) -------------------------------------
  if ((flags & EN_DEHAZE) != 0u && u.b.y > 0.0) {
    let s = u.b.y * sem.dehaze;
    let t = max(mix(1.0, exp(-u.b.z * dist), s), u.b.w);
    let A = u.light.rgb;
    var j = (c - A * (1.0 - t)) / t;
    // Never push a channel below a small fraction of its input (avoids crushed, noisy shadows).
    j = max(j, c * 0.15);
    c = j;
  }

  // --- exposure -----------------------------------------------------------------
  var ev = 0.0;
  if ((flags & EN_EXPOSURE) != 0u) { ev = u.a.x + sem.exp; }
  c = c * exp2(ev);
  // View 3: scene-linear working RGB after denoise/WB/dehaze/exposure (linear DNG export).
  if (u.flags.w == 3u) {
    textureStore(dst, tp, vec4<f32>(max(c, vec3<f32>(0.0)), 1.0));
    return;
  }

  // --- local tone mapping -------------------------------------------------------
  var Y = max(luma2020(c), 1e-7);
  let L = log2(Y);
  let l0 = log_enc(Y0);
  let delta = (log2(Y) - log2(Y0)); // what denoise/WB/dehaze/exposure changed, in EV
  let depthMul = mix(u.tone.z, u.tone.w, smoothstep(0.15, 0.95, dist));
  var Lp = L;
  if ((flags & EN_LOCAL) != 0u) {
    let cc = bil(tc, gp);
    let mm = bil(tm, gp);
    let bc = (cc.x * l0 + cc.y) * LOG_RANGE + LOG_MIN + delta;
    let bm = (mm.z * l0 + mm.w) * LOG_RANGE + LOG_MIN + delta;
    let anchor = u.local.w + ev;
    let dFine = L - bm;
    let dMed = bm - bc;
    var b2 = anchor + (bc - anchor) * (1.0 - u.local.x);
    let wsh = 1.0 - smoothstep(anchor - 3.0, anchor + 0.5, b2);
    let whl = smoothstep(anchor + 0.3, anchor + 3.0, b2);
    b2 += u.tone.x * 2.0 * wsh;
    b2 += (u.tone.y - sem.hl) * 1.6 * whl;
    let gm = 1.0 + u.local.y * sem.clarity * depthMul;
    let gf = 1.0 + u.local.z * sem.texture * depthMul;
    Lp = b2 + soft_detail(dMed, gm, 0.8) + soft_detail(dFine, gf, 1.5);
  }
  c = c * exp2(Lp - L);
  Y = max(luma2020(c), 1e-7);

  // --- tone curve (display rendering), luminance ratio -----------------------------
  let Yd = tone_curve(log2(Y));
  var cd = c * (Yd / Y);
  // Path to white: chroma rolls off as display luminance approaches 1.
  let wmix = smoothstep(0.82, 1.0, Yd);
  cd = mix(cd, vec3<f32>(Yd), wmix * 0.85);
  // Working Rec.2020 → display P3, soft gamut compression toward luminance.
  var p3 = REC2020_TO_P3 * cd;
  let Yp = dot(p3, LUMAP3);
  let mn = min(p3.r, min(p3.g, p3.b));
  if (mn < 0.0) { p3 = mix(p3, vec3<f32>(Yp), clamp(-mn / max(Yp - mn, 1e-6), 0.0, 1.0)); }
  let mx = max(p3.r, max(p3.g, p3.b));
  if (mx > 1.0) { p3 = mix(p3, vec3<f32>(min(Yp, 1.0)), clamp((mx - 1.0) / max(mx - Yp, 1e-6), 0.0, 1.0)); }
  var e = srgb_oetf(clamp(p3, vec3<f32>(0.0), vec3<f32>(1.0)));

  // --- curves ------------------------------------------------------------------------
  if (u.flags.y != 0u) {
    let lr = vec3<f32>(textureSampleLevel(curve_lut, lsamp, vec2<f32>(e.r, 0.5), 0.0).r, textureSampleLevel(curve_lut, lsamp, vec2<f32>(e.g, 0.5), 0.0).r, textureSampleLevel(curve_lut, lsamp, vec2<f32>(e.b, 0.5), 0.0).r);
    e = vec3<f32>(textureSampleLevel(curve_lut, lsamp, vec2<f32>(lr.r, 0.5), 0.0).g, textureSampleLevel(curve_lut, lsamp, vec2<f32>(lr.g, 0.5), 0.0).b, textureSampleLevel(curve_lut, lsamp, vec2<f32>(lr.b, 0.5), 0.0).a);
  }

  // --- colour: saturation / vibrance / per-region hue & saturation (OkLab) ----------------
  var lin = P3_TO_SRGB * srgb_eotf(e);
  var lab = lin_srgb_to_oklab(lin);
  let C = length(lab.yz);
  if (C > 1e-5) {
    let sat = 1.0 + u.color.x + sem.sat;
    let vib = u.color.y * (1.0 + sem.vib);
    let vgain = 1.0 + vib * (1.0 - smoothstep(0.0, 0.2, C));
    var ab = lab.yz * max(sat * vgain, 0.0);
    let hr = sem.hue;
    if (abs(hr) > 1e-4) {
      let cs = cos(hr); let sn = sin(hr);
      ab = vec2<f32>(ab.x * cs - ab.y * sn, ab.x * sn + ab.y * cs);
    }
    lab = vec3<f32>(lab.x, ab);
    lin = oklab_to_lin_srgb(lab);
  }
  // Per-region temperature / tint (OkLab b / a offsets, fading toward black and white).
  if (abs(sem.warmth) + abs(sem.tint) > 1e-4) {
    var lab2 = lin_srgb_to_oklab(lin);
    let edge = smoothstep(0.02, 0.15, lab2.x) * (1.0 - smoothstep(0.93, 1.0, lab2.x));
    lab2 = vec3<f32>(lab2.x, lab2.y + edge * 0.03 * sem.tint, lab2.z + edge * 0.035 * sem.warmth);
    lin = oklab_to_lin_srgb(lab2);
  }
  // Back to P3 (inverse of P3_TO_SRGB).
  let S2P = mat3x3<f32>(
    vec3<f32>(0.8224621, 0.0331942, 0.0170827),
    vec3<f32>(0.1775380, 0.9668058, 0.0723974),
    vec3<f32>(0.0, 0.0, 0.9105199));
  var outp = S2P * lin;
  let Yo = dot(outp, LUMAP3);
  let mno = min(outp.r, min(outp.g, outp.b));
  if (mno < 0.0) { outp = mix(outp, vec3<f32>(Yo), clamp(-mno / max(Yo - mno, 1e-6), 0.0, 1.0)); }
  e = srgb_oetf(clamp(outp, vec3<f32>(0.0), vec3<f32>(1.0)));

  // --- creative layer --------------------------------------------------------------------
  if (prof.f.x > 0.5) { e = apply_profile(e, maps.g, dist); }

  // Debug views (flags.w): 1 = masks (argmax colours), 2 = depth.
  if (u.flags.w == 1u) {
    var best = 0u; var bv = -1.0;
    for (var g = 0u; g < 11u; g++) { if (maps.g[g] > bv) { bv = maps.g[g]; best = g; } }
    var pal = array<vec3<f32>, 11>(vec3<f32>(0.35,0.6,1.0), vec3<f32>(0.2,0.75,0.2), vec3<f32>(0.75,0.45,0.3), vec3<f32>(0.55,0.55,0.55),
      vec3<f32>(0.6,0.5,0.25), vec3<f32>(0.1,0.35,0.8), vec3<f32>(1.0,0.75,0.6), vec3<f32>(0.9,0.2,0.2), vec3<f32>(0.9,0.6,0.1),
      vec3<f32>(0.6,0.3,0.7), vec3<f32>(0.3,0.3,0.3));
    e = mix(e, pal[best], 0.6);
  } else if (u.flags.w == 2u) {
    e = vec3<f32>(1.0 - dist);
  } else if (u.flags.w == 5u) {
    // Depth zone at full brightness, the rest dimmed (soft edges, same refined depth the blur uses).
    let inz = smoothstep(u.hl.x - 0.015, u.hl.x + 0.015, dist) * (1.0 - smoothstep(u.hl.y - 0.015, u.hl.y + 0.015, dist));
    e = mix(e * 0.2, e, inz);
  } else if (u.flags.w == 4u) {
    // Selected region at full brightness, everything else dimmed (soft, by probability).
    let sel = u32(u.color.z);
    var gs2 = maps.g;
    let w = clamp(gs2[min(sel, 10u)], 0.0, 1.0);
    e = mix(e * 0.22, e, smoothstep(0.1, 0.6, w));
  }
  var sharpen = sem.sharpen * mix(u.tone.z, u.tone.w, smoothstep(0.1, 0.9, dist));
  if ((flags & EN_SHARPEN) == 0u) { sharpen = 0.0; }
  textureStore(dst, tp, vec4<f32>(e, sharpen));
  textureStore(dist_out, tp, vec4<f32>(dist, 0.0, 0.0, 0.0));
}
