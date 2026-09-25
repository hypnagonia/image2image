import { test } from "node:test";
import assert from "node:assert/strict";
import { hdrGain, hdrKnee, toneCurve, toneCurveLUT, TONE_LUT_SIZE } from "../src/render/curves.ts";
import { defaultParams } from "../src/decision/params.ts";

const tones = [];
for (const contrast of [-1, 0, 1]) for (const rolloff of [0, 0.5, 1]) for (const whites of [-1, 0, 1]) for (const blacks of [-1, 0, 1])
  tones.push({ ...defaultParams().tone, contrast, rolloff, whites, blacks });

test("HDR gain: 1 below the knee, within [1, H], HDR monotone, 0 stops = SDR", () => {
  for (const tone of tones) for (const stops of [0, 1, 2, 3]) {
    const g = hdrGain(tone, stops), sdr = toneCurve(tone), Yk = hdrKnee(tone), H = 2 ** stops;
    assert.equal(g(0.18), 1);
    assert.equal(g(Yk * 0.999), 1);
    let prev = -1;
    for (let ev = -14; ev <= 6; ev += 0.05) {
      const Y = 2 ** ev, v = g(Y);
      assert.ok(v >= 1 && v <= H + 1e-9, `gain ${v}`);
      const hdr = sdr(Y) * v;
      assert.ok(hdr >= prev - 1e-9, `monotone at ${ev} EV (stops ${stops})`);
      prev = hdr;
      if (stops === 0) assert.equal(v, 1);
    }
    if (stops > 0) assert.ok(Math.abs(g(Yk * 2 ** 0.01) - 1) < 1e-3, "continuous at the knee");
  }
});

test("HDR gain makes real highlights brighter", () => {
  const tone = defaultParams().tone;
  const g = hdrGain(tone, 2), Yk = hdrKnee(tone);
  assert.ok(g(Yk * 2 ** 6) > 2, `specular gain ${g(Yk * 2 ** 6)}`);
  assert.ok(g(Yk * 2) > 1.1 && g(Yk * 2) < 2, `sky gain ${g(Yk * 2)}`);
});

test("tone table carries the gain in g and SDR unchanged in r", () => {
  const tone = defaultParams().tone;
  const a = toneCurveLUT(tone), b = toneCurveLUT(tone, 2);
  for (let i = 0; i < TONE_LUT_SIZE; i++) { assert.equal(a[i * 4], b[i * 4]); assert.equal(a[i * 4 + 1], 1); }
  assert.ok(b[(TONE_LUT_SIZE - 1) * 4 + 1] > 1);
});
