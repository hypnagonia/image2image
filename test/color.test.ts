import { test } from "node:test";
import assert from "node:assert/strict";
import { solveCameraColor, xyToNeutral, type CameraColorInput } from "../src/color/dng.ts";
import { mulVec } from "../src/color/mat3.ts";
import { bandsFromCurve, curveFromBands } from "../src/render/curves.ts";
import { tempTintToXy, xyToTempTint, planckianXY, REC2020_TO_P3 } from "../src/color/spaces.ts";

// iPhone 16 Pro Max ProRAW (IMG_1384.DNG) as reported by LibRaw.
const iphone: CameraColorInput = {
  dng: {
    illuminants: [
      { cct: 2856, colorMatrix: [1.309169888496399, -0.6652565598487854, -0.2358742207288742, -0.42569541931152344, 1.4791451692581177, -0.024069005623459816, -0.03598230704665184, 0.13771191239356995, 0.6340663433074951, 0, 0, 0] },
      { cct: 6504, colorMatrix: [0.9564185738563538, -0.3792504370212555, -0.13388173282146454, -0.40429916977882385, 1.2963262796401978, 0.08532455563545227, -0.09401905536651611, 0.2064267247915268, 0.4658730924129486, 0, 0, 0] },
    ],
    analogBalance: [2.37255859, 1, 1.80297852],
    asShotNeutral: [1, 1, 1],
  },
  baselineExposure: -0.825,
};

test("neutral maps to working white", () => {
  const c = solveCameraColor(iphone);
  const w = mulVec(c.cameraToWorking, c.gains.map((g, i) => g * c.neutral[i]));
  for (const v of w) assert.ok(Math.abs(v - 1) < 1e-6, `white ${w}`);
  assert.ok(c.temp > 2000 && c.temp < 12000, `temp ${c.temp}`);
});

test("xyToNeutral inverts the neutral solve", () => {
  const c = solveCameraColor(iphone);
  const n = xyToNeutral(iphone, c.whiteXY);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(n[i] - c.neutral[i]) < 2e-3, `${n} vs ${c.neutral}`);
});

test("temperature/tint round trip", () => {
  for (const T of [2800, 4000, 5500, 6500, 9000]) {
    for (const tint of [-20, 0, 15]) {
      const r = xyToTempTint(tempTintToXy(T, tint));
      assert.ok(Math.abs(r.temp - T) / T < 0.01, `${T} → ${r.temp}`);
      assert.ok(Math.abs(r.tint - tint) < 0.5, `${tint} → ${r.tint}`);
    }
  }
  const d65 = xyToTempTint([0.3127, 0.329]);
  assert.ok(Math.abs(d65.temp - 6504) < 60, `D65 ${d65.temp}`);
  assert.ok(planckianXY(2856)[0] > 0.44);
});

test("Rec.2020→P3 keeps white", () => {
  const w = mulVec(REC2020_TO_P3, [1, 1, 1]);
  for (const v of w) assert.ok(Math.abs(v - 1) < 1e-4);
});
test("tone-range sliders round-trip through the curve and never invert it", () => {
  const b = { black: 0.3, bands: [0.5, -0.2, 0.1, 0, -1], white: -0.4 };
  const back = bandsFromCurve(curveFromBands(b));
  assert.ok(Math.abs(back.black - 0.3) < 1e-3 && Math.abs(back.white + 0.4) < 1e-3);
  back.bands.forEach((v, i) => assert.ok(Math.abs(v - b.bands[i]) < 1e-3, `band ${i}: ${v}`));
  const steep = curveFromBands({ black: 0, bands: [1, -1, 1, -1, 1], white: 0 });
  for (let i = 1; i < steep.length; i++) assert.ok(steep[i].y >= steep[i - 1].y);
  assert.deepEqual(curveFromBands({ black: 0, bands: [0, 0, 0, 0, 0], white: 0 }), [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
});
