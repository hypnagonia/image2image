import { test } from "node:test";
import assert from "node:assert/strict";
import { HIST_BINS, histogramOf, previewHistograms } from "../src/analysis/previewHist.ts";
import { GROUPS, NG } from "../src/neural/scene.ts";

test("histograms per photo, region and distance band", () => {
  // 30×30: left half dark sky-coloured "sky" far away, right half bright "person" near.
  const w = 30, h = 30, px = new Uint8Array(w * h * 4);
  const probs = new Float32Array(NG * w * h), dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, left = x < 15;
    px.set(left ? [40, 60, 120, 255] : [220, 170, 140, 255], i * 4);
    probs[GROUPS.indexOf(left ? "sky" : "person") * w * h + i] = 1;
    dist[i] = left ? 0.95 : 0.1;
  }
  const all = previewHistograms(px, w, h, { width: w, height: h, probs }, { w, h, data: dist }, [0.33, 0.66], 1);
  const peak = (a: Float32Array) => a.indexOf(Math.max(...a));
  const sky = histogramOf(all, "sky", "b")!, person = histogramOf(all, "person", "r")!;
  assert.equal(peak(sky), 120 >> 2);
  assert.equal(peak(person), 220 >> 2);
  assert.ok(Math.abs(sky.reduce((a, b) => a + b, 0) - 1) < 1e-5);
  assert.equal(peak(histogramOf(all, "far", "b")!), 120 >> 2, "far = the sky side");
  assert.equal(peak(histogramOf(all, "near", "r")!), 220 >> 2, "near = the person side");
  assert.ok(histogramOf(all, "skin", "l"), "warm person pixels count as skin");
  assert.equal(histogramOf(all, "water", "l"), undefined, "absent region: no histogram");
  const photo = histogramOf(all, "photo", "l")!;
  assert.equal(photo.length, HIST_BINS);
  assert.equal(photo.filter((v) => v > 0).length, 2);
});
