// Mask/depth refinement at the guide resolution R (≤ 768 px long edge).
//
// compose:  bilinear-upsample network outputs (seg probs, distance) to R and
//           force sky to the far plane.
// gstats:   guide statistics for the colour guided filter:  I, I·Iᵀ
// pstats:   per mask texture P (4 channels): P, Ir·P, Ig·P, Ib·P
// solve:    a = (Σ + εI)⁻¹ cov(I,P), b = mean(P) − aᵀ·mean(I)   (per channel)
// apply:    q = mean(a)ᵀ·I + mean(b)
// tstats / tsolve: self-guided grey filter on log luminance at two radii
//           (coarse and medium) whose coefficients the renderer upsamples —
//           the "fast guided filter" base layers of local tone mapping.
//
// Box filtering between these steps is done by box.wgsl (generated).

struct P { w: u32, h: u32, eps: f32, sky_far: f32, eps_m: f32, _a: f32, _b: f32, _c: f32 }
@group(0) @binding(0) var<uniform> p: P;
