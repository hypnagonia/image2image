import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, NG } from "../src/neural/scene.ts";

type G = (typeof GROUPS)[number];
const W = 96, H = 72;

/** A synthetic frame: background class + distance, then rectangles painted over it. */
function scene(bg: G, bgDist: number, rects: Array<{ g: G; x0: number; y0: number; x1: number; y1: number; d: number }>, sky?: number) {
  const probs = new Float32Array(NG * W * H);
  const dist = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let g: G = sky !== undefined && y / H < sky ? "sky" : bg;
    let d = g === "sky" ? 1 : bgDist;
    for (const r of rects) if (x / W >= r.x0 && x / W < r.x1 && y / H >= r.y0 && y / H < r.y1) { g = r.g; d = r.d; }
    probs[GROUPS.indexOf(g) * W * H + i] = 1;
    dist[i] = d;
  }
  return autoFocus({ w: W, h: H, data: dist }, { width: W, height: H, probs });
}

test("a person on a third wins over a nearer railing across the bottom", () => {
  const f = scene("interior", 0.85, [
    { g: "person", x0: 0.6, y0: 0.2, x1: 0.75, y1: 0.8, d: 0.4 },
    { g: "other", x0: 0, y0: 0.85, x1: 1, y1: 1, d: 0.05 },
  ]);
  assert.ok(f.x > 0.6 && f.x < 0.75, `x ${f.x}`);
  assert.ok(f.y < 0.45, `focus on the head, y ${f.y}`);
  assert.ok(Math.abs(f.focus - 0.4) < 0.02, `focus ${f.focus}`);
  assert.match(f.reason, /person/);
});

test("a building in the centre is the subject of a street scene without people", () => {
  const f = scene("ground", 0.5, [{ g: "building", x0: 0.3, y0: 0.25, x1: 0.7, y1: 0.75, d: 0.6 }], 0.25);
  assert.ok(f.x > 0.3 && f.x < 0.7 && f.y > 0.25 && f.y < 0.75, `(${f.x}, ${f.y})`);
  assert.match(f.reason, /building/);
});

test("a car on the centre beats a speck-sized person at the edge", () => {
  const f = scene("ground", 0.8, [
    { g: "vehicle", x0: 0.35, y0: 0.4, x1: 0.65, y1: 0.7, d: 0.35 },
    { g: "person", x0: 0.93, y0: 0.1, x1: 0.95, y1: 0.14, d: 0.7 },
  ]);
  assert.match(f.reason, /vehicle/);
});

test("of two people, the larger one near a composition point wins", () => {
  const f = scene("vegetation", 0.9, [
    { g: "person", x0: 0.05, y0: 0.3, x1: 0.1, y1: 0.5, d: 0.6 },
    { g: "person", x0: 0.28, y0: 0.2, x1: 0.42, y1: 0.9, d: 0.3 },
  ]);
  assert.ok(f.x > 0.28 && f.x < 0.42, `x ${f.x}`);
});

test("an unlabelled object standing in front of its background is found by depth", () => {
  const f = scene("other", 0.9, [{ g: "other", x0: 0.4, y0: 0.35, x1: 0.6, y1: 0.65, d: 0.3 }]);
  assert.ok(f.x > 0.4 && f.x < 0.6 && f.y > 0.35 && f.y < 0.65, `(${f.x}, ${f.y})`);
  assert.match(f.reason, /object/);
});

import { objectDepthRange } from "../src/decision/focus.ts";
test("a tap covers the whole depth range of the object, not just the tapped spot", () => {
  // A car at an angle: its distance runs 0.30 → 0.50 across it; ground behind at 0.9.
  const probs = new Float32Array(NG * W * H), data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, inCar = x >= 20 && x < 70 && y >= 30 && y < 55;
    probs[GROUPS.indexOf(inCar ? "vehicle" : "ground") * W * H + i] = 1;
    data[i] = inCar ? 0.3 + 0.2 * ((x - 20) / 50) : 0.9;
  }
  const [lo, hi] = objectDepthRange({ w: W, h: H, data }, { width: W, height: H, probs }, 25 / W, 40 / H, 0.31);
  assert.ok(lo <= 0.31 && hi >= 0.48, `range ${lo}–${hi}`);
  const g = objectDepthRange({ w: W, h: H, data }, { width: W, height: H, probs }, 5 / W, 5 / H, 0.9);
  assert.ok(g[1] - g[0] <= 0.041, "ground: a thin slice");
});

import { autoFocus } from "../src/decision/focus.ts";
function frame(rects: Array<{ g: (typeof GROUPS)[number]; x0: number; y0: number; x1: number; y1: number; d: number }>, bg = 0.9) {
  const probs = new Float32Array(NG * W * H), data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let g: (typeof GROUPS)[number] = "interior", d = bg;
    for (const r of rects) if (x / W >= r.x0 && x / W < r.x1 && y / H >= r.y0 && y / H < r.y1) { g = r.g; d = r.d; }
    probs[GROUPS.indexOf(g) * W * H + i] = 1;
    data[i] = d;
  }
  return { dist: { w: W, h: H, data }, seg: { width: W, height: H, probs } };
}

test("blur grows with the subject's size and the depth behind it (thin lens)", () => {
  const close = frame([{ g: "person", x0: 0.3, y0: 0.1, x1: 0.7, y1: 0.95, d: 0.25 }]);
  const far = frame([{ g: "person", x0: 0.45, y0: 0.4, x1: 0.55, y1: 0.7, d: 0.25 }]);
  const shallow = frame([{ g: "person", x0: 0.3, y0: 0.1, x1: 0.7, y1: 0.95, d: 0.25 }], 0.45);
  const a = autoFocus(close.dist, close.seg), b = autoFocus(far.dist, far.seg), c = autoFocus(shallow.dist, shallow.seg);
  assert.ok(a.justified && a.strength > b.strength, `close ${a.strength} vs small ${b.strength}`);
  assert.ok(a.strength > c.strength, `deep background ${a.strength} vs near background ${c.strength}`);
  assert.match(a.reason, /blur: subject \d+% of the frame/);
});

test("blur already made by the lens is not added again; architecture gets little", () => {
  const f = frame([{ g: "person", x0: 0.4, y0: 0.3, x1: 0.6, y1: 0.8, d: 0.25 }]);
  const sharpBg = autoFocus(f.dist, f.seg, { blur: { bw: 10, bh: 8, data: new Float32Array(80).fill(0.8) }, longPx: 4000 });
  const blurredBg = autoFocus(f.dist, f.seg, { blur: { bw: 10, bh: 8, data: new Float32Array(80).fill(30) }, longPx: 4000 });
  assert.ok(blurredBg.strength < sharpBg.strength * 0.6, `${blurredBg.strength} vs ${sharpBg.strength}`);
  const b = frame([{ g: "building", x0: 0.25, y0: 0.2, x1: 0.75, y1: 0.8, d: 0.3 }]);
  assert.ok(autoFocus(b.dist, b.seg).strength < sharpBg.strength * 0.5, "building: much less");
});
