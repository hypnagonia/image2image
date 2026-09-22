import { test } from "node:test";
import assert from "node:assert/strict";
import { depthZones } from "../src/decision/zones.ts";

test("natural breaks put boundaries in the gaps between depth layers", () => {
  // Three layers: near subject ~0.15, middle ~0.5, far ~0.9, plus sky at 1.0.
  const vals: number[] = [];
  const layer = (c: number, n: number) => { for (let i = 0; i < n; i++) vals.push(c + ((i % 11) - 5) * 0.004); };
  layer(0.15, 3000); layer(0.5, 4000); layer(0.9, 2500); layer(1.0, 1500);
  const z = depthZones({ w: vals.length, h: 1, data: Float32Array.from(vals) }, undefined, 4);
  // No boundary may fall inside a layer.
  for (const zz of z.slice(1)) {
    const b = zz.lo;
    for (const c of [0.15, 0.5, 0.9]) // Layers span ±0.02 around their centre: a boundary inside that span would cut one.
    assert.ok(Math.abs(b - c) > 0.02, `boundary ${b} cuts the layer at ${c}`);
  }
  assert.equal(z.length, 4);
  assert.ok(Math.abs(z.reduce((a, x) => a + x.share, 0) - 1) < 1e-6);
});
