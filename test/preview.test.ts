import { test } from "node:test";
import assert from "node:assert/strict";
import { findPreview } from "../src/decode/preview.ts";

/** A minimal JPEG header: SOI, an APP0 segment, then a frame header (SOFn). */
function jpeg(sof: number, w: number, h: number, comps: number): number[] {
  return [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, comps, 0, 0, 0, 0];
}

test("the camera's rendering: the largest colour picture JPEG, never the raw data or a matte", () => {
  const bytes = new Uint8Array([
    0, 1, 2,
    ...jpeg(0xc0, 4032, 3024, 3), 9, 9,
    ...jpeg(0xc3, 8064, 6048, 3), 9,   // lossless: the raw sensor data
    ...jpeg(0xc0, 8064, 6048, 1), 9,   // single channel: a semantic matte
    ...jpeg(0xc0, 160, 120, 3),        // a thumbnail
  ]);
  const p = findPreview(bytes);
  assert.ok(p);
  assert.deepEqual([p.width, p.height, p.components, p.offset], [4032, 3024, 3, 3]);
  assert.equal(findPreview(new Uint8Array(jpeg(0xc3, 4000, 3000, 3))), null);
});
