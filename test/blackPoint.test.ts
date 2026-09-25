import { test } from "node:test";
import assert from "node:assert/strict";
import { blackPoint, type BlackPointInput } from "../src/decision/blackPoint.ts";
import { curveFromBands, monotoneCurve } from "../src/render/curves.ts";

/** A rendered-tone distribution as a quantile function: Gaussian in display level, clamped. */
function dist(mean: number, sd: number) {
  const inv = (p: number) => { // inverse normal (Acklam's approximation, good to 1e-4)
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const q = p < 0.5 ? Math.sqrt(-2 * Math.log(p)) : Math.sqrt(-2 * Math.log(1 - p));
    const x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    if (p > 0.02425 && p < 0.97575) { const r = p - 0.5, s = r * r; return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1); }
    return p < 0.5 ? x : -x;
  };
  return (qs: number[]) => qs.map((p) => Math.min(1, Math.max(0, mean + sd * inv(Math.min(0.9999, Math.max(1e-4, p))))));
}
const base = (over: Partial<BlackPointInput> = {}): BlackPointInput => ({ q: dist(0.45, 0.14), rangeEV: 8, chroma: 0.045, clipHi: 0, haze: 0, people: false, near: false, far: false, ...over });

test("a lifted shadow floor gets a smooth toe; the darkest tones stay above black and apart", () => {
  const r = blackPoint(base());
  assert.ok(r.photo.toe && r.photo.toe[1] < r.photo.toe[0] - 0.01, `toe ${JSON.stringify(r.photo.toe)}`);
  const f = monotoneCurve(curveFromBands(r.photo));
  const [q005, q02] = base().q([0.005, 0.02]);
  assert.ok(f(q005) >= 0.012, `not crushed: ${f(q005)}`);
  assert.ok(f(q02) - f(q005) >= 0.6 * (q02 - q005), "separation kept");
  assert.ok(Math.abs(f(0.5) - 0.5) < 0.01, "midtones untouched by the toe");
});

test("an already grounded photo is left alone", () => {
  const r = blackPoint(base({ q: dist(0.4, 0.2) }));
  assert.equal(r.photo.toe, undefined);
});

test("high-key, hazy and foggy scenes keep soft blacks", () => {
  const hk = blackPoint(base({ q: dist(0.72, 0.1) })).photo.toe;
  assert.ok(!hk || hk[0] - hk[1] < 0.03, "high-key: at most a whisper");
  assert.equal(blackPoint(base({ haze: 0.6 })).photo.toe, undefined, "haze");
  assert.equal(blackPoint(base({ rangeEV: 3 })).photo.toe, undefined, "fog");
});

test("skin, clothing and foreground are protected; clear distance may go a touch deeper, hazy distance softer", () => {
  const r = blackPoint(base({ people: true, near: true, far: true }));
  assert.ok(r.targets.skin!.bands[0] > 0 && r.targets.skin!.bands[0] > r.targets.person!.bands[0]);
  assert.ok(r.targets.near!.bands[0] > 0);
  assert.ok(r.targets.far!.bands[0] < 0, "clear air: deeper");
  const hz = blackPoint(base({ far: true, haze: 0.2 }));
  assert.ok(!hz.targets.far || hz.targets.far.bands[0] > 0, "hazy: softer");
});

test("contrast is added only if still flat after the black point, and never on the toe", () => {
  const flat = blackPoint(base({ q: dist(0.45, 0.07) }));
  assert.ok(flat.photo.bands[3] > 0 && flat.photo.bands[1] < flat.photo.bands[3]);
  const fine = blackPoint(base({ q: dist(0.45, 0.2) }));
  assert.equal(fine.photo.bands[4], 0, "enough contrast: no S");
});
