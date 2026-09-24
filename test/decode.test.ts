import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { appleHeadroom, appleHdrHeadroom, tiffCompressions } from "../src/decode/exif.ts";
import { hasAppleGainMap } from "../src/decode/heif.ts";
import { findDngMasks } from "../src/decode/dngMasks.ts";

test("Apple HDR headroom follows the two MakerNote numbers", () => {
  // The values of a real iPhone HDR photograph: ~1 stop of headroom.
  assert.ok(Math.abs(appleHeadroom(0.658485, 0.030009) - 1.9958) < 0.001);
  // Both branches: a small tag 48 means much more headroom.
  assert.ok(appleHeadroom(0.5, 0.005) > appleHeadroom(0.5, 0.05));
  assert.ok(appleHeadroom(1.5, 0.005) > appleHeadroom(0.5, 0.005));
  // Never below 1 (no headroom is the floor, not a darkening factor).
  assert.ok(appleHeadroom(0.2, 10) >= 1);
});

test("compression tags are read from every IFD of a TIFF/DNG", () => {
  // Not a TIFF at all.
  assert.deepEqual(tiffCompressions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), []);
  // A minimal little-endian TIFF with one IFD: Compression = 52546 (JPEG-XL).
  const b = new Uint8Array(32);
  const dv = new DataView(b.buffer);
  b[0] = 0x49; b[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, 1, true);                 // one entry
  dv.setUint16(10, 259, true);              // Compression
  dv.setUint16(12, 3, true);                // SHORT
  dv.setUint32(14, 1, true);
  dv.setUint16(18, 52546, true);
  assert.deepEqual(tiffCompressions(b), [52546]);
});

test("real sample files: ProRAW compression is recognised", () => {
  const dng = ".samples/IMG_1384.DNG";
  if (!existsSync(dng)) return; // samples are local only
  const b = new Uint8Array(readFileSync(dng));
  const c = tiffCompressions(b);
  assert.ok(c.includes(7), `expected lossless JPEG, got ${c}`);
  assert.ok(!c.includes(52546)); // not JPEG-XL, so LibRaw can unpack it
  // A ProRAW DNG names the gain map in its XMP as well, so the byte scan is
  // only meaningful for HEIF files (where it is used).
  assert.equal(hasAppleGainMap(b), true);
});

test("an HDR HEIC is recognised and its headroom read", () => {
  const heic = ".samples/hdr_test.heic";
  if (!existsSync(heic)) return;
  const b = new Uint8Array(readFileSync(heic));
  assert.equal(hasAppleGainMap(b), true);
  // The Exif block sits inside the HEIF; find its TIFF header the way the app does.
  const i = b.findIndex((_, k) => b[k] === 0x4d && b[k + 1] === 0x4d && b[k + 2] === 0 && b[k + 3] === 42);
  const headroom = appleHdrHeadroom(b.subarray(i));
  assert.ok(headroom !== undefined && Math.abs(headroom - 2) < 0.05, `headroom ${headroom}`);
});

test("Apple's semantic mattes are found inside a ProRAW DNG", () => {
  const dng = ".samples/IMG_1384.DNG";
  if (!existsSync(dng)) return;
  const masks = findDngMasks(new Uint8Array(readFileSync(dng)));
  assert.equal(masks.length, 1);
  assert.equal(masks[0].kind, "sky");
  assert.equal(masks[0].width, 2016);
  assert.equal(masks[0].height, 1512);
  // A JPEG payload, ready for createImageBitmap.
  assert.equal(masks[0].bytes[0], 0xff);
  assert.equal(masks[0].bytes[1], 0xd8);
});

test("a portrait ProRAW carries the skin and subject mattes", () => {
  const dng = ".samples/IMG_1401.DNG";
  if (!existsSync(dng)) return;
  const kinds = findDngMasks(new Uint8Array(readFileSync(dng))).map((m) => m.kind).sort();
  assert.deepEqual(kinds, ["skin", "subject"]);
});

test("a matte overrides the network where it claims more, and probabilities still sum to 1", async () => {
  const { applyAppleMattes, GROUPS, NG } = await import("../src/neural/scene.ts");
  const w = 4, h = 4, plane = w * h;
  const probs = new Float32Array(NG * plane);
  const sky = GROUPS.indexOf("sky"), veg = GROUPS.indexOf("vegetation");
  for (let i = 0; i < plane; i++) { probs[sky * plane + i] = 0.4; probs[veg * plane + i] = 0.6; }
  // A matte that is certain about the top half and silent about the bottom.
  const data = new Uint8Array(w * h * 4); // twice the grid in each direction
  for (let y = 0; y < h * 2; y++) for (let x = 0; x < w * 2; x++) data[y * w * 2 + x] = y < h ? 255 : 0;
  const log = applyAppleMattes({ width: w, height: h, probs }, [{ kind: "sky", data, width: w * 2, height: h * 2 }]);
  assert.match(log[0], /Apple sky matte/);
  for (let i = 0; i < plane; i++) {
    let sum = 0;
    for (let k = 0; k < NG; k++) sum += probs[k * plane + i];
    assert.ok(Math.abs(sum - 1) < 1e-5, `probabilities sum to ${sum}`);
  }
  assert.ok(probs[sky * plane + 0] > 0.99); // top row: the matte won
  assert.ok(Math.abs(probs[sky * plane + plane - 1] - 0.4) < 1e-6); // bottom: untouched
});
