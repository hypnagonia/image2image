import { test } from "node:test";
import assert from "node:assert/strict";
import { toHalf, halfToFloat } from "../src/gpu/half.ts";
test("half round trip", () => {
  for (const v of [0, 1, -1, 0.5, 0.1, 1e-5, 65504, 3.14159, 1e-7, 2.5e-3]) {
    const r = halfToFloat(toHalf(v));
    assert.ok(Math.abs(r - v) <= Math.max(Math.abs(v) * 1e-3, 6e-8), `${v} → ${r}`);
  }
});
