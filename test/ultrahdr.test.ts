import { test } from "node:test";
import assert from "node:assert/strict";
import { muxGainMapJpeg, parseJpegSegments, type GainMapMeta } from "../src/output/ultrahdr.ts";

/** A stand-in for a browser-encoded JPEG: SOI, APP0 JFIF, APP2 junk, DQT, SOS + data, EOI. */
function fakeJpeg(fill: number, n: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app2 = [0xff, 0xe2, 0, 6, 1, 2, 3, 4];
  const dqt = [0xff, 0xdb, 0, 4, 0, 0];
  const sos = [0xff, 0xda, 0, 4, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app2, ...dqt, ...sos, ...new Array(n).fill(fill), 0xff, 0xd9]);
}
const meta: GainMapMeta = { min: 0, max: 2, gamma: 1, offSdr: 1 / 64, offHdr: 1 / 64, capMin: 0, capMax: 2 };
const exif = new TextEncoder().encode("Exif\0\0MM-fake-exif");
const icc = new Uint8Array(200).fill(7);
const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

test("gain-map JPEG: two images, MPF points at the second, metadata parses back", () => {
  const primary = fakeJpeg(0x11, 5000), gain = fakeJpeg(0x22, 1500);
  const out = muxGainMapJpeg(primary, gain, meta, exif, icc);
  // Both images present, primary ends where MPF says, file ends with EOI.
  assert.equal(out[0], 0xff); assert.equal(out[1], 0xd8);
  assert.equal(out[out.length - 2], 0xff); assert.equal(out[out.length - 1], 0xd9);
  const { segments } = parseJpegSegments(out);
  const mpf = segments.find((s) => s.marker === 0xe2 && text(out.subarray(s.start + 4, s.start + 8)) === "MPF\0")!;
  assert.ok(mpf, "MPF present");
  assert.equal(mpf.end - mpf.start, 90); // FF E2 + length 88
  const endian = mpf.start + 8;
  const dv = new DataView(out.buffer, endian);
  assert.equal(dv.getUint32(0), 0x4d4d002a);
  assert.equal(dv.getUint16(8), 3);
  assert.equal(dv.getUint16(10), 0xb000); assert.equal(text(out.subarray(endian + 18, endian + 22)), "0100");
  assert.equal(dv.getUint16(22), 0xb001); assert.equal(dv.getUint32(30), 2);
  assert.equal(dv.getUint16(34), 0xb002); assert.equal(dv.getUint32(38), 32); assert.equal(dv.getUint32(42), 50);
  const size1 = dv.getUint32(54), size2 = dv.getUint32(70), off2 = dv.getUint32(74);
  assert.equal(dv.getUint32(58), 0, "first image offset is 0");
  assert.equal(size1 + size2, out.length);
  assert.equal(out[size1 - 2], 0xff); assert.equal(out[size1 - 1], 0xd9, "primary ends with EOI");
  assert.equal(endian + off2, size1);
  assert.equal(out[endian + off2], 0xff); assert.equal(out[endian + off2 + 1], 0xd8, "offset lands on the gain map's SOI");
  // Primary: Exif and ICC exactly once, the browser's APP2 junk gone, XMP length = gain map size, ISO version block.
  const all = text(out.subarray(0, size1));
  assert.equal(all.split("Exif\0\0").length - 1, 1);
  assert.equal(all.split("ICC_PROFILE\0").length - 1, 1);
  assert.ok(!all.includes("\x01\x02\x03\x04"), "old APP2 stripped");
  assert.ok(all.includes(`Item:Length="${size2}"`));
  assert.ok(all.includes('hdrgm:Version="1.0"'));
  const iso1 = all.indexOf("urn:iso:std:iso:ts:21496:-1\0");
  assert.ok(iso1 > 0);
  assert.deepEqual([...out.subarray(iso1 + 28, iso1 + 32)], [0, 0, 0, 0]);
  // Gain map: its XMP values and the ISO metadata; no Exif / ICC.
  const g = out.subarray(size1);
  const gt = text(g);
  for (const [k, v] of [["GainMapMin", "0"], ["GainMapMax", "2"], ["Gamma", "1"], ["OffsetSDR", "0.015625"], ["HDRCapacityMax", "2"], ["BaseRenditionIsHDR", "False"]]) assert.ok(gt.includes(`hdrgm:${k}="${v}"`), k);
  assert.ok(!gt.includes("Exif\0\0") && !gt.includes("ICC_PROFILE"));
  const iso2 = gt.indexOf("urn:iso:std:iso:ts:21496:-1\0");
  const idv = new DataView(g.buffer, g.byteOffset + iso2 + 28);
  assert.equal(idv.getUint8(4), 0x40);
  assert.equal(idv.getUint32(5) / idv.getUint32(9), 0, "base headroom");
  assert.equal(idv.getUint32(13) / idv.getUint32(17), 2, "alternate headroom");
  assert.equal(idv.getInt32(21) / idv.getUint32(25), 0, "gain map min");
  assert.equal(idv.getInt32(29) / idv.getUint32(33), 2, "gain map max");
  assert.equal(idv.getUint32(37) / idv.getUint32(41), 1, "gamma");
  assert.equal(idv.getInt32(45) / idv.getUint32(49), 1 / 64, "base offset");
  assert.equal(idv.getInt32(53) / idv.getUint32(57), 1 / 64, "alternate offset");
  assert.equal(iso2 + 28 + 61 <= gt.length, true);
  // Every segment fits a JPEG length field; image data is untouched.
  for (const s of parseJpegSegments(out).segments) assert.ok(s.end - s.start - 2 < 65536);
  assert.ok(out.subarray(0, size1).includes(0x11) && g.includes(0x22));
});
