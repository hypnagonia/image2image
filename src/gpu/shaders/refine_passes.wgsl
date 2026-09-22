// Entry points share bindings 1..8; each entry point only statically uses the
// ones it needs, and the host binds exactly those (auto layout).

@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var in0: texture_2d<f32>;
@group(0) @binding(3) var in1: texture_2d<f32>;
@group(0) @binding(4) var in2: texture_2d<f32>;
@group(0) @binding(5) var in3: texture_2d<f32>;
@group(0) @binding(6) var out0: texture_storage_2d<rgba32float, write>;
@group(0) @binding(7) var out1: texture_storage_2d<rgba32float, write>;
@group(0) @binding(8) var out2: texture_storage_2d<rgba32float, write>;
@group(0) @binding(9) var out3: texture_storage_2d<rgba32float, write>;

fn uv(id: vec2<u32>) -> vec2<f32> { return (vec2<f32>(id) + 0.5) / vec2<f32>(f32(p.w), f32(p.h)); }
fn ld(t: texture_2d<f32>, id: vec2<u32>) -> vec4<f32> { return textureLoad(t, vec2<i32>(id), 0); }

// in0..in2 = seg groups (sampled), in3 = distance (r). out0..out2 = P0..P2.
@compute @workgroup_size(16, 16)
fn compose(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let t = uv(id.xy);
  let a = textureSampleLevel(in0, samp, t, 0.0);
  let b = textureSampleLevel(in1, samp, t, 0.0);
  let c = textureSampleLevel(in2, samp, t, 0.0);
  var d = textureSampleLevel(in3, samp, t, 0.0).r;
  d = max(d, a.x * p.sky_far); // sky is at infinity whatever the depth net says
  textureStore(out0, vec2<i32>(id.xy), a);
  textureStore(out1, vec2<i32>(id.xy), b);
  textureStore(out2, vec2<i32>(id.xy), vec4<f32>(c.xyz, d));
}

// in0 = guide (encoded rgb). out0 = (I, 0), out1 = (rr, rg, rb, gg), out2 = (gb, bb, 0, 0)
@compute @workgroup_size(16, 16)
fn gstats(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let I = ld(in0, id.xy).rgb;
  textureStore(out0, vec2<i32>(id.xy), vec4<f32>(I, 0.0));
  textureStore(out1, vec2<i32>(id.xy), vec4<f32>(I.r * I.r, I.r * I.g, I.r * I.b, I.g * I.g));
  textureStore(out2, vec2<i32>(id.xy), vec4<f32>(I.g * I.b, I.b * I.b, 0.0, 0.0));
}

// in0 = guide, in1 = P. out0 = P, out1 = Ir·P, out2 = Ig·P, out3 = Ib·P
@compute @workgroup_size(16, 16)
fn pstats(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let I = ld(in0, id.xy).rgb;
  let P = ld(in1, id.xy);
  textureStore(out0, vec2<i32>(id.xy), P);
  textureStore(out1, vec2<i32>(id.xy), I.r * P);
  textureStore(out2, vec2<i32>(id.xy), I.g * P);
  textureStore(out3, vec2<i32>(id.xy), I.b * P);
}

// in0 = mean I, in1 = mean(rr,rg,rb,gg), in2 = mean(gb,bb), in3 unused.
// Reads mean P / mean Ir·P … from the second group of bindings via `solve_p*`.
@group(0) @binding(10) var mp0: texture_2d<f32>;
@group(0) @binding(11) var mp1: texture_2d<f32>;
@group(0) @binding(12) var mp2: texture_2d<f32>;
@group(0) @binding(13) var mp3: texture_2d<f32>;

@compute @workgroup_size(16, 16)
fn solve(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let mI = ld(in0, id.xy).rgb;
  let s1 = ld(in1, id.xy);
  let s2 = ld(in2, id.xy);
  let e = p.eps;
  // Covariance of the guide (symmetric), regularised.
  let rr = s1.x - mI.r * mI.r + e; let rg = s1.y - mI.r * mI.g; let rb = s1.z - mI.r * mI.b;
  let gg = s1.w - mI.g * mI.g + e; let gb = s2.x - mI.g * mI.b; let bb = s2.y - mI.b * mI.b + e;
  // Inverse of the symmetric 3×3.
  let i00 = gg * bb - gb * gb; let i01 = rb * gb - rg * bb; let i02 = rg * gb - rb * gg;
  let i11 = rr * bb - rb * rb; let i12 = rb * rg - rr * gb; let i22 = rr * gg - rg * rg;
  let det = rr * i00 + rg * i01 + rb * i02;
  let inv = 1.0 / det;
  let mP = ld(mp0, id.xy);
  let cr = ld(mp1, id.xy) - mI.r * mP;
  let cg = ld(mp2, id.xy) - mI.g * mP;
  let cb = ld(mp3, id.xy) - mI.b * mP;
  let ar = (i00 * cr + i01 * cg + i02 * cb) * inv;
  let ag = (i01 * cr + i11 * cg + i12 * cb) * inv;
  let ab = (i02 * cr + i12 * cg + i22 * cb) * inv;
  let b = mP - ar * mI.r - ag * mI.g - ab * mI.b;
  textureStore(out0, vec2<i32>(id.xy), ar);
  textureStore(out1, vec2<i32>(id.xy), ag);
  textureStore(out2, vec2<i32>(id.xy), ab);
  textureStore(out3, vec2<i32>(id.xy), b);
}

// in0 = guide, in1..in3 = mean a_r, a_g, a_b; mp0 = mean b. out0 = q.
@compute @workgroup_size(16, 16)
fn apply(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let I = ld(in0, id.xy).rgb;
  let q = ld(in1, id.xy) * I.r + ld(in2, id.xy) * I.g + ld(in3, id.xy) * I.b + ld(mp0, id.xy);
  textureStore(out0, vec2<i32>(id.xy), clamp(q, vec4<f32>(0.0), vec4<f32>(1.0)));
}

// Tone base, stage 1. in0 = linear image at R. out0 = (l, l², l, l²) with
// l = log_enc(Y) — box-filtered at the coarse radius (xy) and medium radius (zw) by the host.
@compute @workgroup_size(16, 16)
fn tstats(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let l = log_enc(luma2020(max(ld(in0, id.xy).rgb, vec3<f32>(0.0))));
  textureStore(out0, vec2<i32>(id.xy), vec4<f32>(l, l * l, l, l * l));
}

// Tone base, stage 2. in0 = coarse means (xy), in1 = medium means (zw).
// out0 = (a_c, b_c, a_m, b_m), to be box-filtered once more.
@compute @workgroup_size(16, 16)
fn tsolve(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let c = ld(in0, id.xy);
  let m = ld(in1, id.xy);
  let vc = max(c.y - c.x * c.x, 0.0);
  let vm = max(m.w - m.z * m.z, 0.0);
  let ac = vc / (vc + p.eps);
  let am = vm / (vm + p.eps_m);
  textureStore(out0, vec2<i32>(id.xy), vec4<f32>(ac, c.x * (1.0 - ac), am, m.z * (1.0 - am)));
}
