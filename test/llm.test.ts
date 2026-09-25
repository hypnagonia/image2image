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
