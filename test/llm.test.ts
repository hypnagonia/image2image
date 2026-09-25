import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAnswer, buildPrompt, extractJson } from "../src/ui/llmPanel.ts";
import { defaultParams } from "../src/decision/params.ts";
test("round trip", () => {
  const p = defaultParams();
  const prompt = buildPrompt(p, p, undefined, [], [{ id: "teal-warm", name: "Teal", description: "x" }], "warmer");
  assert.match(prompt, /tone\.shadows/);
  const reply = `Sure:\n- warmer\n\`\`\`json\n{ "look": "teal-warm", "set": { "exposure": 5, "tone.shadows": 0.2, "semantic.sky.saturation": -0.1, "curves.l": [[0,0],[0.5,0.55],[1,1]], "bogus": 1, }, }\n\`\`\``;
  let picked = "";
  const r = applyAnswer(p, extractJson(reply), (id) => { picked = id; return true; });
  assert.equal(picked, "teal-warm");
  assert.equal(p.exposure, 3);
  assert.equal(p.tone.shadows, 0.2);
  assert.equal(p.semantic.sky.saturation, -0.1);
  assert.equal(p.curves.l.length, 3);
  assert.equal(r.ignored.length, 1);
});

test("reply edge cases: nulls, curves without ends, quotes inside strings, comments", () => {
  const p = defaultParams();
  p.tone.shadows = 0.3;
  const reply = '```json\n{ "why": "the “sky” // not a comment", "set": { "tone.shadows": null, "dehaze.strength": true, /* note */ "curves.l": [[0.25,0.22],[0.75,0.79],[0.75,0.8]], "tone.contrast": "0.1", } }\n```';
  const r = applyAnswer(p, extractJson(reply), () => true);
  assert.equal(p.tone.shadows, 0.3, "null leaves the value alone");
  assert.equal(p.dehaze.strength, 0, "true is not a number");
  assert.equal(p.tone.contrast, 0.1, "numeric strings are accepted");
  assert.deepEqual(p.curves.l, [{ x: 0, y: 0 }, { x: 0.25, y: 0.22 }, { x: 0.75, y: 0.79 }, { x: 1, y: 1 }]);
  assert.equal(r.ignored.length, 2);
});

test("undo data covers only what the answer touched", () => {
  const p = defaultParams();
  const r = applyAnswer(p, { set: { exposure: 1, "semantic.sky.hue": 10 } }, () => true);
  assert.deepEqual(r.previous.map(([k]) => k).sort(), ["exposure", "semantic.sky.hue"]);
  assert.deepEqual(r.previous.find(([k]) => k === "exposure")?.[1], 0);
});

test("skin settings and region curves", () => {
  const p = defaultParams();
  const r = applyAnswer(p, { set: { "semantic.skin.warmth": 0.2, "regionCurves.sky.l": [[0, 0], [0.5, 0.45], [1, 1]], "regionCurves.skin.r": [[0.5, 0.53]], "regionCurves.moon.l": [[0, 0], [1, 1]] } }, () => true);
  assert.equal(p.skin.warmth, 0.2);
  assert.deepEqual(p.regionCurves.sky?.l, [{ x: 0, y: 0 }, { x: 0.5, y: 0.45 }, { x: 1, y: 1 }]);
  assert.deepEqual(p.regionCurves.sky?.g, [{ x: 0, y: 0 }, { x: 1, y: 1 }], "other channels stay flat");
  assert.deepEqual(p.regionCurves.skin?.r, [{ x: 0, y: 0 }, { x: 0.5, y: 0.53 }, { x: 1, y: 1 }]);
  assert.equal(r.ignored.length, 1);
  // undo data: the sky curves did not exist before
  assert.equal(r.previous.find(([k]) => k === "regionCurves.sky")?.[1], undefined);
  assert.equal(r.previous.find(([k]) => k === "skin.warmth")?.[1], 0);
});

test("distance curves", () => {
  const p = defaultParams();
  const r = applyAnswer(p, { set: { "depthCurves.far.l": [[0.1, 0.13]], "depthCurves.behind.l": [[0.5, 0.5]] } }, () => true);
  assert.deepEqual(p.depthCurves.far?.l, [{ x: 0, y: 0 }, { x: 0.1, y: 0.13 }, { x: 1, y: 1 }]);
  assert.equal(r.ignored.length, 1);
  assert.equal(r.previous.find(([k]) => k === "depthCurves.far")?.[1], undefined);
});
