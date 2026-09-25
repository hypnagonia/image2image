import { test } from "node:test";
import assert from "node:assert/strict";
import { measureSkin, naturalSkin } from "../src/decision/skinTone.ts";
import { defaultParams, neutralSemantic } from "../src/decision/params.ts";

const p = defaultParams();
const skin = neutralSemantic();

test("natural skin is left alone", () => {
  const f = naturalSkin({ share: 0.1, L: 0.7, C: 0.07, hue: 55 }, p, skin);
  assert.equal(f.saturation, 0); assert.equal(f.hue, 0); assert.equal(f.reasons.length, 0);
});

test("oversaturated skin is desaturated, capped", () => {
  const f = naturalSkin({ share: 0.1, L: 0.7, C: 0.16, hue: 55 }, p, skin);
  assert.ok(f.saturation < -0.2 && f.saturation >= -0.35, String(f.saturation));
  const g = naturalSkin({ share: 0.1, L: 0.7, C: 0.09, hue: 55 }, { color: { saturation: 0.3, vibrance: 0 } }, skin);
  assert.ok(g.saturation < 0, "the photo's own saturation boost counts");
});

test("too red skin turns toward orange, yellow-green back toward orange; never beyond 8°", () => {
  assert.ok(naturalSkin({ share: 0.1, L: 0.7, C: 0.08, hue: 30 }, p, skin).hue > 0);
  assert.ok(naturalSkin({ share: 0.1, L: 0.7, C: 0.08, hue: 85 }, p, skin).hue < 0);
  assert.equal(naturalSkin({ share: 0.1, L: 0.7, C: 0.08, hue: 0 }, p, skin).hue, 8);
});

test("skin is measured on person × skin colour, not on clothes", () => {
  // Left half: a warm skin tone; right half: a blue shirt. Both belong to the person.
  const w = 20, h = 10, lin = new Float32Array(w * h * 4), probs = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    lin.set(x < 10 ? [0.55, 0.36, 0.26, 1] : [0.08, 0.12, 0.45, 1], i * 4);
    probs[i] = 1;
  }
  const st = measureSkin(lin, w, h, { width: w, height: h, probs, plane: 0 })!;
  assert.ok(st && st.hue > 35 && st.hue < 80, `hue ${st?.hue}`);
  assert.ok(Math.abs(st.share - 0.5) < 0.1, `share ${st.share}`);
});
