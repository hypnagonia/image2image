import { test } from "node:test";
import assert from "node:assert/strict";
import { decideUpscale, measureLuma, type QualityMetrics } from "../src/analysis/quality.ts";

/** Random rectangles (step edges of varying contrast), Gaussian-blurred, with optional noise. */
function patches(sigma: number, noise = 0) {
  const W = 256, H = 256;
  return [1, 2, 3, 4].map((seed) => {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const y = new Float32Array(W * H).fill(0.4);
    for (let k = 0; k < 60; k++) {
      const x0 = rnd() * W, y0 = rnd() * H, x1 = x0 + 10 + rnd() * 80, y1 = y0 + 10 + rnd() * 80, v = 0.15 + rnd() * 0.7;
      for (let r = Math.floor(y0); r < Math.min(H, y1); r++) for (let c = Math.floor(x0); c < Math.min(W, x1); c++) y[r * W + c] = v;
    }
    const R = Math.ceil(sigma * 3);
    const k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * sigma * sigma)));
    const ks = k.reduce((a, b) => a + b);
    const t = new Float32Array(W * H), o = new Float32Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { let a = 0; for (let i = -R; i <= R; i++) a += k[i + R] * y[r * W + Math.min(W - 1, Math.max(0, c + i))]; t[r * W + c] = a / ks; }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { let a = 0; for (let i = -R; i <= R; i++) a += k[i + R] * t[Math.min(H - 1, Math.max(0, r + i)) * W + c]; o[r * W + c] = a / ks; }
    let q = seed * 11;
    const u = () => ((q = (q * 48271) % 2147483647) / 2147483647);
    if (noise) for (let i = 0; i < o.length; i++) o[i] += noise * Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
    return { y: o, w: W, h: H };
  });
}

test("edge-width estimate tracks the true blur and the noise estimate the true noise", () => {
  for (const sigma of [0.8, 1.6, 3]) {
    const m = measureLuma(patches(sigma));
    assert.ok(Math.abs(m.edgeSigma - sigma) < 0.12 * sigma + 0.05, `blur ${sigma}: estimated ${m.edgeSigma}`);
  }
  const m = measureLuma(patches(1.2, 1.5 / 255));
  assert.ok(Math.abs(m.noiseSigma * 255 - 1.5) < 0.1, `noise 1.5/255: estimated ${m.noiseSigma * 255}`);
  assert.ok(Math.abs(m.edgeSigma - 1.2) < 0.2);
});

const base: QualityMetrics = { laplacianVar: 0.001, tenengrad: 0.002, noiseSigma: 0.5 / 255, edgeSigma: 0.9, edgeSigmaMedian: 1, detailDensity: 0.15, edgeBlocks: 100, patches: 12 };
const ctx = (w: number, h: number, extra = {}) => ({ width: w, height: h, reducedByUser: false, maxOutputMP: 50, maxTextureDimension: 16384, ...extra });

test("high-resolution sharp images are never upscaled", () => {
  assert.equal(decideUpscale(base, ctx(8064, 6048)).needsUpscale, false); // 48 MP
  assert.equal(decideUpscale(base, ctx(4032, 3024)).needsUpscale, false); // 12 MP sharp
  assert.equal(decideUpscale({ ...base, edgeSigma: 2.2 }, ctx(4896, 3264)).needsUpscale, false); // 16 MP even when soft
});

test("low-resolution and soft mid-resolution frames are upscaled", () => {
  const small = decideUpscale(base, ctx(2000, 1500)); // 3 MP
  assert.equal(small.needsUpscale, true);
  assert.equal(small.code, "below-target");
  const soft10 = decideUpscale({ ...base, edgeSigma: 2.0 }, ctx(3648, 2736)); // 10 MP, soft
  assert.equal(soft10.needsUpscale, true);
  assert.equal(soft10.code, "soft");
  const adequate10 = decideUpscale({ ...base, edgeSigma: 1.25, detailDensity: 0.03 }, ctx(3648, 2736));
  assert.equal(adequate10.needsUpscale, false);
});

test("severe blur, noise, lack of detail, user-reduced size and memory budget all skip", () => {
  const blur = decideUpscale({ ...base, edgeSigma: 3.4 }, ctx(2000, 1500));
  assert.equal(blur.needsUpscale, false);
  assert.equal(blur.severeBlur, true);
  assert.equal(blur.reason, "severe blur detected; super-resolution would not recover reliable detail");
  assert.equal(decideUpscale({ ...base, noiseSigma: 3 / 255 }, ctx(2000, 1500)).code, "noise");
  assert.equal(decideUpscale({ ...base, detailDensity: 0.005 }, ctx(2000, 1500)).code, "no-detail");
  assert.equal(decideUpscale(base, ctx(2000, 1500, { reducedByUser: true })).code, "reduced");
  assert.equal(decideUpscale(base, ctx(3000, 2000, { maxOutputMP: 16 })).code, "memory"); // 6 MP → 24 MP
});

test("ISO tightens requirements but never enables upscaling on its own", () => {
  // Sharp 12 MP at ISO 6400: still skipped.
  assert.equal(decideUpscale(base, ctx(4032, 3024, { iso: 6400 })).needsUpscale, false);
  // Marginal noise passes at base ISO and is rejected at high ISO.
  const m = { ...base, noiseSigma: 1.8 / 255 };
  assert.equal(decideUpscale(m, ctx(2000, 1500, { iso: 100 })).needsUpscale, true);
  assert.equal(decideUpscale(m, ctx(2000, 1500, { iso: 6400 })).needsUpscale, false);
});

test("the display transform around the upscaler is exactly invertible below its white point", async () => {
  const { toDisplay, fromDisplay } = await import("../src/restore/display.ts");
  for (const v of [0, 1e-4, 0.01, 0.18, 0.5, 1, 2, 3.5]) {
    const t = toDisplay(v);
    assert.ok(t >= 0 && t <= 1);
    assert.ok(Math.abs(fromDisplay(t) - v) < 1e-6 * Math.max(1, v), `round trip of ${v}: ${fromDisplay(t)}`);
  }
  // Mid grey lands in the mid-tones a display-referred model expects.
  assert.ok(toDisplay(0.18) > 0.35 && toDisplay(0.18) < 0.5);
});
