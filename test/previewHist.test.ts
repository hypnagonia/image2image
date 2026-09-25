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

import { cellCoverage } from "../src/analysis/previewHist.ts";
test("region-at-a-distance coverage and histograms", () => {
  const w = 40, h = 20, px = new Uint8Array(w * h * 4).fill(128);
  const probs = new Float32Array(NG * w * h), dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    probs[GROUPS.indexOf("building") * w * h + i] = 1;       // all building…
    dist[i] = x < 10 ? 0.1 : 0.9;                            // …a quarter near, the rest far
    if (x >= 10) px.set([200, 200, 200, 255], i * 4);
  }
  const cov = cellCoverage({ width: w, height: h, probs }, { w, h, data: dist }, [0.33, 0.66]);
  assert.ok(Math.abs(cov["building.near"] - 25) < 3, `near ${cov["building.near"]}`);
  assert.ok(Math.abs(cov["building.far"] - 75) < 3, `far ${cov["building.far"]}`);
  assert.equal(cov["building.middle"], 0);
  const all = previewHistograms(px, w, h, { width: w, height: h, probs }, { w, h, data: dist }, [0.33, 0.66], 1);
  const far = histogramOf(all, "building.far", "l")!, near = histogramOf(all, "building.near", "l")!;
  assert.equal(far.indexOf(Math.max(...far)), 200 >> 2);
  assert.equal(near.indexOf(Math.max(...near)), 128 >> 2);
});
