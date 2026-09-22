import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProfile, neutralProfile, parseProfile, serialize, toneFunction, profileCurveTable, balanceToAB } from "../src/looks/profile.ts";

test("neutral tone is identity", () => {
  const f = toneFunction(neutralProfile().tone);
  for (let x = 0; x <= 1; x += 0.05) assert.ok(Math.abs(f(x) - x) < 1e-6, `${x} → ${f(x)}`);
});

test("tone curves are monotone and unclipped for extreme settings", () => {
  for (const contrast of [-0.5, 0, 0.8]) for (const hc of [0, 0.6]) for (const bp of [-0.05, 0, 0.15]) for (const sl of [-0.2, 0.3]) {
    const f = toneFunction({ contrast, highlightCompression: hc, blackPoint: bp, shadowLift: sl, rolloff: 0.5, curve: [[0, 0], [1, 1]] });
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const y = f(i / 1000);
      assert.ok(y >= prev - 1e-9, `not monotone c${contrast} h${hc} b${bp} s${sl} at ${i}`);
      prev = y;
    }
    // No hard clip at white: the top 5% of input keeps distinct outputs unless compressed on purpose.
    assert.ok(f(1) - f(0.95) > 0.001, `flat top c${contrast} h${hc}`);
  }
});

test("JSON round trip and clamping", () => {
  const p = makeProfile({ id: "t", name: "T", tone: { contrast: 0.2 }, hsl: { green: { hue: 5, sat: -0.2, lum: 0 } }, colorBalance: { shadows: [0, 0.02, 0.05] } });
  const q = parseProfile(serialize(p));
  assert.deepEqual(q.tone, p.tone);
  assert.deepEqual(q.hsl.green, p.hsl.green);
  const bad = parseProfile(JSON.stringify({ id: "x", tone: { contrast: 99 }, saturation: { global: -3 } }));
  assert.equal(bad.tone.contrast, 0.8);
  assert.equal(bad.saturation.global, 0);
  assert.equal(profileCurveTable(p).length, 1024 * 4);
});

test("colour balance direction", () => {
  const [a, b] = balanceToAB([0, 0.02, 0.05]); // toward teal/blue
  assert.ok(b < 0, `b ${b}`);
  const [a2, b2] = balanceToAB([0.05, 0.02, -0.02]); // warm
  assert.ok(b2 > 0 && a2 > 0, `${a2} ${b2}`);
  void a;
});

import { periodicCurve, hueCurveTable } from "../src/looks/profile.ts";
test("periodic hue curve: flat, interpolating, wrapping", () => {
  const flat = periodicCurve([[0, 0.5], [1, 0.5]]);
  for (let x = 0; x < 1; x += 0.1) assert.ok(Math.abs(flat(x) - 0.5) < 1e-9);
  const bump = periodicCurve([[0, 0.5], [0.4, 0.8], [1, 0.5]]);
  assert.ok(Math.abs(bump(0.4) - 0.8) < 1e-6, `peak ${bump(0.4)}`);
  assert.ok(Math.abs(bump(0) - bump(0.99999)) < 1e-3, "wraps continuously");
  const edge = periodicCurve([[0.02, 0.3], [0.5, 0.5], [0.98, 0.3]]);
  assert.ok(Math.abs(edge(0) - edge(0.9999)) < 1e-3 && edge(0) < 0.35, `wrap across 0: ${edge(0)} ${edge(0.9999)}`);
  const p = makeProfile({ id: "h", name: "h" });
  const t = hueCurveTable(p);
  assert.ok(Math.abs(t[0]) < 1e-9 && Math.abs(t[1] - 1) < 1e-9, "neutral table");
});

test("spatial refinement: category defaults, old profiles upgraded, values clamped", async () => {
  const { parseProfile, makeProfile, neutralProfile, profileUniforms, PROFILE_VEC4S } = await import("../src/looks/profile.ts");
  // The technical look never refines; creative looks do, subtly.
  assert.equal(neutralProfile().spatial.depth.background, 0);
  const cine = makeProfile({ id: "x", name: "x", category: "cool cinematic" });
  assert.ok(cine.spatial.depth.background > 0 && cine.spatial.semantic.skin === 1);
  // A profile saved before spatial refinement existed gets its category's defaults.
  const old = parseProfile(JSON.stringify({ id: "o", name: "o", category: "landscape" }));
  assert.equal(old.spatial.semantic.sky, 0.8);
  // Out-of-range values are clamped; explicit values survive a round trip.
  const p = parseProfile(JSON.stringify({ id: "p", name: "p", category: "custom", spatial: { semantic: { skin: 3, sky: 0.25 }, depth: { distant: -1 } } }));
  assert.equal(p.spatial.semantic.skin, 1);
  assert.equal(p.spatial.semantic.sky, 0.25);
  assert.equal(p.spatial.depth.distant, 0);
  // Skin protection supersedes the person group's blanket "protect".
  const q = makeProfile({ id: "q", name: "q", category: "portrait-neutral", semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.6 } } });
  const u = profileUniforms(q, true, false, 33);
  assert.equal(u.length, PROFILE_VEC4S * 4);
  const personProtect = u[(15 + 6) * 4 + 3];
  assert.equal(personProtect, 0);
});
