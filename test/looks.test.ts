import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseColors } from "../src/looks/palette.ts";
import { matchProfile, profileFromReference, abToBalance } from "../src/looks/reference.ts";
import { balanceToAB } from "../src/looks/profile.ts";

function img(fn: (x: number, y: number) => [number, number, number], w = 64, h = 64) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x / w, y / h);
    d.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  return d;
}

test("palette finds the dominant colours", () => {
  const s = analyseColors(img((x) => (x < 0.7 ? [30, 90, 200] : [220, 120, 40])), undefined, 4);
  assert.ok(s.palette.length >= 2);
  const hexes = s.palette.map((p) => p.hex);
  assert.ok(s.palette[0].weight > 0.6, `weights ${s.palette.map((p) => p.weight)}`);
  assert.ok(s.warmCool < 0, `blue-dominant image should be cool: ${s.warmCool}`);
  void hexes;
});

test("abToBalance inverts balanceToAB", () => {
  const [a, b] = balanceToAB([0.02, 0.0, -0.03]);
  const back = abToBalance(a, b);
  const [a2, b2] = balanceToAB(back);
  assert.ok(Math.abs(a - a2) < 2e-3 && Math.abs(b - b2) < 2e-3, `${a},${b} vs ${a2},${b2}`);
});

test("matching a warm reference warms the grade and never touches people", () => {
  const src = analyseColors(img((x, y) => { const v = 40 + 180 * y; return [v, v, v * 0.98]; }));
  const ref = analyseColors(img((x, y) => { const v = 40 + 180 * y; return [Math.min(255, v * 1.12), v, v * 0.8]; }));
  const p = matchProfile(src, ref, "warm.jpg");
  const [, b] = balanceToAB(p.colorBalance.midtones);
  assert.ok(b > 0, `midtone balance should be warm (b>0): ${b}`);
  assert.equal(p.semantic.person?.protect, 0.75);
  // Tone curve stays monotone and anchored.
  const c = p.tone.curve;
  assert.deepEqual(c[0], [0, 0]); assert.deepEqual(c[c.length - 1], [1, 1]);
  for (let i = 1; i < c.length; i++) assert.ok(c[i][0] > c[i - 1][0] && c[i][1] >= c[i - 1][1]);
});

test("reference profile is deterministic", () => {
  const ref = analyseColors(img((x, y) => [60 + 150 * x, 80 + 100 * y, 120]));
  const a = profileFromReference(ref, "r.jpg"), b = profileFromReference(ref, "r.jpg");
  assert.deepEqual({ ...a, id: "", description: "" }, { ...b, id: "", description: "" });
});
