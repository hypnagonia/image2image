import { test } from "node:test";
import assert from "node:assert/strict";
import { guidedFilter, levelsByArea, samDims, selectionMask, SAM_LOW } from "../src/refine/selection.ts";

test("samDims fits the long side to 1024", () => {
  assert.deepEqual(samDims(4032, 3024), [1024, 768]);
  assert.deepEqual(samDims(3024, 4032), [768, 1024]);
});

test("levels are ordered by area, largest first", () => {
  const plane = SAM_LOW * SAM_LOW;
  const low = new Float32Array(4 * plane).fill(-5);
  const fill = (k: number, n: number) => { for (let i = 0; i < n; i++) low[k * plane + i] = 5; };
  fill(1, 100); fill(2, 3000); fill(3, 900);
  assert.deepEqual(levelsByArea(low), [2, 3, 1]);
});

test("a mask covers the photo's part of SAM's square only", () => {
  // Photo 768×1024 in the square: logits positive in the left half of the photo region.
  const low = new Float32Array(4 * SAM_LOW * SAM_LOW).fill(-8);
  for (let y = 0; y < SAM_LOW; y++) for (let x = 0; x < 96; x++) low[y * SAM_LOW + x] = 8; // photo is 192 cells wide
  const m = selectionMask(low, 0, [768, 1024], 96, 128);
  assert.ok(m[64 * 96 + 10] > 250, "left of the photo selected");
  assert.ok(m[64 * 96 + 85] < 5, "right of the photo not");
});

test("the guided filter snaps a soft edge to the guide's edge", () => {
  const w = 40, h = 1;
  const I = new Float32Array(w).map((_, x) => (x < 22 ? 0.1 : 0.9)); // photo edge at 22
  const p = new Float32Array(w).map((_, x) => 1 / (1 + Math.exp(-(x - 18) / 3))); // mask ramp centred at 18
  const q = guidedFilter(I, p, w, h, 4, 1e-3);
  // The biggest jump now sits at the photo's edge (21 → 22), not at the mask's own middle (18).
  let best = 0;
  for (let x = 1; x < w; x++) if (q[x] - q[x - 1] > q[best] - q[best - 1 < 0 ? 0 : best - 1]) best = x;
  assert.equal(best, 22);
  assert.ok(q[22] - q[21] > 3 * (p[22] - p[21]), "sharper at the photo's edge than the mask was");
});
