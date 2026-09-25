import { test } from "node:test";
import assert from "node:assert/strict";
import { autoCurves, displayLevel, type AutoCurvesInput } from "../src/decision/autoCurves.ts";
import { defaultParams } from "../src/decision/params.ts";
import { curveFromBands } from "../src/render/curves.ts";

/** A 32-bin log2 histogram (−14 … +4 EV), Gaussian around `ev` with spread `sd` EV. */
function hist(ev: number, sd: number): number[] {
  const h = Array.from({ length: 32 }, (_, k) => Math.exp(-((-14 + (k + 0.5) * (18 / 32) - ev) ** 2) / (2 * sd * sd)));
  const s = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / s);
}
const p = defaultParams();
const base = (over: Partial<AutoCurvesInput> = {}): AutoCurvesInput => ({
  tone: p.tone, exposure: 0, local: p.local, clipHi: 0,
  photo: { hist: hist(-2.5, 2.2), area: 1 }, regions: {}, ...over,
});
const G = Math.log2(0.18);

test("display levels rise with scene luminance and put middle grey mid-screen", () => {
  let prev = -1;
  for (let ev = -12; ev <= 3; ev += 0.25) { const v = displayLevel(ev, base()); assert.ok(v >= prev); prev = v; }
  const mg = displayLevel(G, base());
  assert.ok(mg > 0.5 && mg < 0.65, `middle grey at ${mg}`);
});

test("a photo that already renders well gets flat curves", () => {
  const r = autoCurves(base({ regions: { sky: { hist: hist(G + 1.2, 0.5), area: 0.3 }, vegetation: { hist: hist(G - 1, 1.5), area: 0.3, localContrast: 0.35 } } }));
  assert.equal(r.photo, undefined);
  assert.deepEqual(r.regions, {});
  assert.equal(r.notes.length, 0);
});

test("a flat photo gets contrast around its own median", () => {
  const r = autoCurves(base({ photo: { hist: hist(G, 0.6), area: 1 } }));
  assert.ok(r.photo, "fires");
  assert.ok(r.photo!.bands[1] < 0 && r.photo!.bands[3] > 0, `S: ${r.photo!.bands}`);
});

test("a washed-out sky is deepened; a normal one is left alone", () => {
  const washed = autoCurves(base({ regions: { sky: { hist: hist(G + 3.2, 0.4), area: 0.4 } } }));
  assert.ok(washed.regions.sky && washed.regions.sky.bands[4] < -0.1, JSON.stringify(washed.regions.sky));
  const ok = autoCurves(base({ regions: { sky: { hist: hist(G + 1, 0.4), area: 0.4 } } }));
  assert.equal(ok.regions.sky, undefined);
});

test("dark faces are lifted in the skin curve only", () => {
  const r = autoCurves(base({ regions: { person: { hist: hist(G - 3.5, 0.6), area: 0.2 } } }));
  assert.ok(r.regions.skin && r.regions.skin.bands[2] > 0.1, JSON.stringify(r.regions.skin));
  assert.equal(r.regions.person, undefined);
});

test("a flat foreground gets contrast; a hazy landscape's deep far shadows are lifted", () => {
  const r = autoCurves(base({
    regions: { sky: { hist: hist(G + 1, 0.4), area: 0.2 } },
    bands: { near: { hist: hist(G, 0.3), area: 0.3 }, far: { hist: hist(G - 7, 0.8), area: 0.4 } },
  }));
  assert.ok(r.depth.near, "near fires");
  assert.ok(r.depth.far && r.depth.far.bands[0] > 0, JSON.stringify(r.depth.far));
});

test("every change is capped and never inverts the curve", () => {
  const r = autoCurves(base({
    photo: { hist: hist(G, 0.2), area: 1 },
    regions: { sky: { hist: hist(3, 0.2), area: 0.5 }, person: { hist: hist(-12, 0.2), area: 0.3 }, vegetation: { hist: hist(G, 0.2), area: 0.3, localContrast: 0 } },
    bands: { near: { hist: hist(G, 0.1), area: 0.5 } },
  }));
  const all = [r.photo, ...Object.values(r.regions), ...Object.values(r.depth)].filter(Boolean);
  assert.ok(all.length >= 4);
  for (const b of all) {
    for (const v of [b!.black, b!.white, ...b!.bands]) assert.ok(Math.abs(v) <= 0.35 + 1e-9, `cap: ${v}`);
    const pts = curveFromBands(b!);
    for (let k = 1; k < pts.length; k++) assert.ok(pts[k].y >= pts[k - 1].y);
  }
  assert.equal(r.notes.length, all.length);
});

import { applyAutoCurves } from "../src/decision/autoCurves.ts";
test("the strength slider rescales automatic curves and keeps hand-edited ones", () => {
  const q = defaultParams();
  const a = { photo: { black: 0, bands: [0, -0.2, 0, 0.2, 0], white: 0 }, regions: { sky: { black: 0, bands: [0, 0, -0.1, -0.2, -0.3], white: 0 } }, depth: {} };
  applyAutoCurves(q, a, 1);
  assert.deepEqual(q.curves.l, curveFromBands(a.photo));
  q.regionCurves.sky = { ...q.regionCurves.sky!, l: [{ x: 0, y: 0 }, { x: 0.5, y: 0.4 }, { x: 1, y: 1 }] }; // the user's own sky curve
  applyAutoCurves(q, a, 0.5, 1);
  assert.equal(q.autoCurves, 0.5);
  assert.deepEqual(q.curves.l, curveFromBands({ black: 0, bands: [0, -0.1, 0, 0.1, 0], white: 0 }));
  assert.deepEqual(q.regionCurves.sky!.l, [{ x: 0, y: 0 }, { x: 0.5, y: 0.4 }, { x: 1, y: 1 }], "hand edit kept");
  applyAutoCurves(q, a, 0, 0.5);
  assert.deepEqual(q.curves.l, [{ x: 0, y: 0 }, { x: 1, y: 1 }], "0 = none");
});
