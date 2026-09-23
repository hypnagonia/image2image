import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBlacks, renderCode } from "../src/decision/blacks.ts";
import type { Params } from "../src/decision/params.ts";

const tone = (o: Partial<Params["tone"]> = {}): Params["tone"] =>
  ({ highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0, rolloff: 0.5, ...o });

test("a scene with real shadow material keeps its black", () => {
  // Darkest 0.1% ten stops below white: shadow material, and it already renders near black.
  const r = checkBlacks(tone(), -10.5, -9.5, 0, 0);
  assert.equal(r.hasTrueBlack, true);
  assert.ok(r.deepBefore <= 5, `renders at ${r.deepBefore}`);
  assert.equal(r.blacks, 0); // nothing to fix
});

test("milky blacks are deepened, shadow separation kept", () => {
  // A strong shadow lift leaves the darkest tones grey.
  const t = tone({ shadows: 0.5, contrast: -0.1 });
  const deepEV = -9.6, lowEV = -8.2, liftEV = 2.4; // a strong lift on shallow shadows
  const before = renderCode(t, deepEV + liftEV);
  assert.ok(before > 5, `test setup: ${before} should be milky`);
  const r = checkBlacks(t, deepEV, lowEV, liftEV, 0);
  assert.ok(r.blacks < 0, "black point should deepen");
  assert.ok(r.deepAfter <= before - 2, `after ${r.deepAfter}, before ${before}`);
  assert.ok(r.lowAfter >= 4, `darkest 1% must stay separated: ${r.lowAfter}`);

  // With room below (the darkest 1% well above the darkest 0.1%), it reaches black.
  const deep = checkBlacks(t, -11, -7.5, 2.4, 0);
  assert.ok(deep.blacks < 0 && deep.deepAfter <= 5, `deep ${deep.deepAfter} blacks ${deep.blacks}`);
});

test("haze and fog are left alone (no black to find)", () => {
  // Nothing in the scene is deeper than −6 EV: the darkest tones are haze.
  const r = checkBlacks(tone({ shadows: 0.3 }), -6, -5.5, 0.6, 0);
  assert.equal(r.hasTrueBlack, false);
  assert.equal(r.blacks, 0);
});

test("a source that already clips to black counts as having black", () => {
  const r = checkBlacks(tone({ shadows: 0.4 }), -7, -6.5, 0.8, 0.01);
  assert.equal(r.hasTrueBlack, true);
});
