import { test } from "node:test";
import assert from "node:assert/strict";
import { hueSatTable, isNeutralLayer, makeLayer } from "../src/layers/model.ts";
import { packLayers, RECORD } from "../src/layers/gpu.ts";
import { buildAutoLayers } from "../src/layers/auto.ts";
import { defaultParams } from "../src/decision/params.ts";

test("layers pack into fixed records and one atlas row per table", () => {
  const c = makeLayer("curves", "C", { params: { l: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }], r: [{ x: 0, y: 0 }, { x: 1, y: 1 }], g: [{ x: 0, y: 0 }, { x: 1, y: 1 }], b: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } });
  const h = makeLayer("hueSat", "H", { params: { ranges: { greens: { hue: 10, sat: 0.2, light: 0 } }, colorize: false, cHue: 30, cSat: 0.25, cLight: 0 }, mask: { kind: "region", region: "sky", invert: true, feather: 0.5, density: 0.8 } });
  const hidden = makeLayer("exposure", "E", { visible: false });
  const auto = makeLayer("basic", "A", { auto: "colour.sky", opacity: 0.8 });
  const pk = packLayers([c, h, hidden, auto], 0.5);
  assert.equal(pk.count, 3, "hidden layers are left out");
  assert.equal(pk.records.length, 3 * RECORD);
  assert.equal(pk.rows, 2);
  assert.equal(pk.records[3], 0); assert.equal(pk.records[RECORD + 3], 1); // atlas rows
  assert.equal(pk.records[RECORD + 4], 1); assert.equal(pk.records[RECORD + 7], 1); // region mask, inverted
  assert.ok(Math.abs(pk.records[RECORD + 12] - 0.8) < 1e-6);
  assert.ok(Math.abs(pk.records[2 * RECORD + 2] - 0.4) < 1e-6, "auto strength scales automatic layers");
});

test("hue/saturation ranges: full inside, fading to zero outside", () => {
  const t = hueSatTable({ ranges: { greens: { hue: 0, sat: 0.5, light: 0, inner: 15, outer: 45 } }, colorize: false, cHue: 0, cSat: 0, cLight: 0 }, 360);
  assert.equal(t[120 * 3 + 1], 0.5);
  assert.ok(t[150 * 3 + 1] > 0 && t[150 * 3 + 1] < 0.5);
  assert.equal(t[200 * 3 + 1], 0);
});

test("the automatic grade becomes layers and nothing is applied twice", () => {
  const p = defaultParams();
  p.curves.l = [{ x: 0, y: 0 }, { x: 0.2, y: 0.12 }, { x: 1, y: 1 }];
  p.semantic.vegetation = { ...p.semantic.vegetation, warmth: 0.25, tint: 0.08, hue: -3, saturation: 0.05 };
  p.semantic.person = { ...p.semantic.person, vibrance: -0.6 };
  p.color.vibrance = 0.1;
  p.skin = { ...p.semantic.person, saturation: -0.2 };
  p.regionCurves.sky = { l: [{ x: 0, y: 0 }, { x: 0.8, y: 0.7 }, { x: 1, y: 1 }], r: [{ x: 0, y: 0 }, { x: 1, y: 1 }], g: [{ x: 0, y: 0 }, { x: 1, y: 1 }], b: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
  const q = buildAutoLayers(p);
  const names = q.layers.map((l) => l.name);
  assert.deepEqual(names, ["Tone & black point", "Sky tone", "Greens colour", "People colour", "Natural skin"]);
  const skin = q.layers.find((l) => l.name === "Natural skin")!;
  assert.equal((skin.params as { saturation: number; vibrance: number }).saturation, -0.2);
  assert.equal((skin.params as { saturation: number; vibrance: number }).vibrance, 0, "skin holds only its difference from people");
  const people = q.layers.find((l) => l.name === "People colour")!;
  assert.equal((people.params as { vibrance: number }).vibrance, -0.06, "region vibrance is a share of the global vibrance, not an absolute −60 %");
  assert.equal(q.layers.find((l) => l.name === "Greens colour")!.mask.exceptSkin, true, "region colour leaves skin to its own correction");
  assert.ok(!people.mask.exceptSkin);
  assert.equal(q.semantic.vegetation.warmth, 0);
  assert.equal(q.regionCurves.sky, undefined);
  assert.ok(q.curves.l.every((pt) => pt.x === pt.y));
  assert.equal(buildAutoLayers(q).layers.length, q.layers.length, "idempotent");
  assert.ok(q.layers.every((l) => !isNeutralLayer(l)));
});

import { History } from "../src/layers/history.ts";
test("history: undo, redo, a new change drops the redo branch, identical states are not recorded", () => {
  const h = new History(3);
  const p = defaultParams();
  h.reset(p, "Open");
  p.exposure = 0.5; assert.ok(h.commit(p, "Exposure"));
  assert.equal(h.commit(p, "Exposure"), false);
  p.exposure = 1; h.commit(p, "Exposure 2");
  assert.equal(h.undo()!.exposure, 0.5);
  assert.equal(h.undo()!.exposure, 0);
  assert.equal(h.canUndo, false);
  assert.equal(h.redo()!.exposure, 0.5);
  p.exposure = 0.7; h.commit(p, "Other");
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.list().map((e) => e.label), ["Open", "Exposure", "Other"]);
  p.exposure = 0.9; h.commit(p, "More");
  assert.equal(h.list().length, 3, "limit");
});

import { layerModule, liveLayers } from "../src/layers/gpu.ts";
test("module switches: auto grade follows Regions, the photo curve and user layers follow Curves", () => {
  const p = defaultParams();
  p.curves.l = [{ x: 0, y: 0 }, { x: 0.2, y: 0.12 }, { x: 1, y: 1 }];
  p.semantic.sky = { ...p.semantic.sky, saturation: 0.1 };
  const q = buildAutoLayers(p);
  q.layers.push(makeLayer("hueSat", "Mine"));
  assert.deepEqual(q.layers.map(layerModule), ["curves", "semantic", "curves"]);
  assert.deepEqual(liveLayers(q.layers, 1, { curves: true, semantic: false }).map((l) => l.name), ["Tone & black point", "Mine"]);
  assert.deepEqual(liveLayers(q.layers, 0, { curves: true, semantic: true }).map((l) => l.name), ["Mine"]);
});
