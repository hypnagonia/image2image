/**
 * Module: Output Encoder.
 *
 *   JPEG   browser encoder (OffscreenCanvas.convertToBlob), then our own EXIF
 *          (APP1) and ICC (APP2) segments — the browser's metadata handling
 *          differs between engines, ours does not.
 *   HEIC   offered only when the browser's canvas encoder actually produces
 *          HEIC (probed at startup; Safari may, Chrome does not).
 *   TIFF   16-bit/channel, Display P3 (sRGB curve) with embedded ICC — the
 *          high-precision interchange export. Deflate + horizontal predictor.
 *   DNG    *processed* linear DNG (LinearRaw, Rec.2020 primaries, 16-bit),
 *          scene-referred after denoise/restoration/white balance. It is
 *          explicitly labelled as processed (UniqueCameraModel, ProfileName,
 *          ImageDescription) and is never presented as original sensor RAW.
 */
import type { PhotoMetadata } from "../decode/types.ts";
import { buildExifApp1, captureEntries, injectJpegSegments, SOFTWARE } from "./exif.ts";
import { buildIcc } from "./icc.ts";
import { IfdWriter, T, tiffHeader, concat, srational, type Entry } from "./tiffWriter.ts";
import { XYZ_TO_REC2020, REC2020_TO_XYZ, bradford, D65_XY, D50_XY } from "../color/spaces.ts";
import { mul } from "../color/mat3.ts";

export async function encodeJpeg(rgba: Uint8ClampedArray, w: number, h: number, space: "srgb" | "p3", quality: number, meta: PhotoMetadata): Promise<Blob> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { colorSpace: space === "p3" ? "display-p3" : "srgb" }) as OffscreenCanvasRenderingContext2D;
  ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h, { colorSpace: space === "p3" ? "display-p3" : "srgb" }), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const out = injectJpegSegments(bytes, buildExifApp1(meta, space), buildIcc(space));
  return new Blob([out as BlobPart], { type: "image/jpeg" });
}

let heicSupport: Promise<boolean> | undefined;
export function canEncodeHeic(): Promise<boolean> {
  heicSupport ??= (async () => {
    try {
      const c = new OffscreenCanvas(8, 8);
      c.getContext("2d")!.fillRect(0, 0, 8, 8);
      const b = await c.convertToBlob({ type: "image/heic" });
      return b.type === "image/heic" || b.type === "image/heif";
    } catch { return false; }
  })();
  return heicSupport;
}

export async function encodeHeic(rgba: Uint8ClampedArray, w: number, h: number, space: "srgb" | "p3", quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { colorSpace: space === "p3" ? "display-p3" : "srgb" }) as OffscreenCanvasRenderingContext2D;
  ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h, { colorSpace: space === "p3" ? "display-p3" : "srgb" }), 0, 0);
  const b = await canvas.convertToBlob({ type: "image/heic", quality });
  if (b.type !== "image/heic" && b.type !== "image/heif") throw new Error("This browser cannot encode HEIC");
  return b;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Horizontal differencing predictor (TIFF Predictor=2) on interleaved 16-bit samples, in place. */
function predict16(rows: Uint16Array, w: number, h: number, spp: number) {
  for (let y = 0; y < h; y++) {
    const o = y * w * spp;
    for (let x = w - 1; x >= 1; x--) for (let c = 0; c < spp; c++) rows[o + x * spp + c] = (rows[o + x * spp + c] - rows[o + (x - 1) * spp + c]) & 0xffff;
  }
}

const ROWS_PER_STRIP = 64;

async function stripsOf(rgb16: Uint16Array, w: number, h: number, compress: boolean): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let y = 0; y < h; y += ROWS_PER_STRIP) {
    const rows = Math.min(ROWS_PER_STRIP, h - y);
    const slice = rgb16.slice(y * w * 3, (y + rows) * w * 3);
    if (compress) predict16(slice, w, rows, 3);
    const bytes = new Uint8Array(slice.buffer); // little-endian host (all WebGPU platforms)
    out.push(compress ? await deflate(bytes) : bytes);
  }
  return out;
}

async function writeTiffLike(w: number, h: number, rgb16: Uint16Array, entries: Entry[], extraIfds: Array<{ key: string; entries: Entry[] }>, compress: boolean): Promise<Uint8Array> {
  const strips = await stripsOf(rgb16, w, h, compress);
  const base: Entry[] = [
    { tag: 256, type: T.LONG, values: [w] },
    { tag: 257, type: T.LONG, values: [h] },
    { tag: 258, type: T.SHORT, values: [16, 16, 16] },
    { tag: 259, type: T.SHORT, values: [compress ? 8 : 1] },
    { tag: 277, type: T.SHORT, values: [3] },
    { tag: 278, type: T.LONG, values: [ROWS_PER_STRIP] },
    { tag: 279, type: T.LONG, values: strips.map((s) => s.length) },
    { tag: 284, type: T.SHORT, values: [1] },
    ...(compress ? [{ tag: 317, type: T.SHORT, values: [2] } as Entry] : []),
    ...entries,
  ];
  // Strip offsets are known only after the IFD layout: lay out once with dummies, then patch.
  const stripOffsets: Entry = { tag: 273, type: T.LONG, values: strips.map(() => 0) };
  const ifds = [{ key: "ifd0", entries: [...base, stripOffsets] }, ...extraIfds];
  const first = IfdWriter.layout(ifds, 8);
  let pos = 8 + first.bytes.length;
  const offs = strips.map((s) => { const o = pos; pos += s.length; return o; });
  stripOffsets.values = offs;
  const final = IfdWriter.layout(ifds, 8);
  return concat([tiffHeader(8), final.bytes, ...strips]);
}

/** 16-bit TIFF from display-encoded P3 half floats (RGBA). */
export async function encodeTiff16(rgbaHalf: Float32Array, w: number, h: number, meta: PhotoMetadata): Promise<Blob> {
  const rgb16 = new Uint16Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    rgb16[i * 3] = Math.round(Math.min(1, Math.max(0, rgbaHalf[j])) * 65535);
    rgb16[i * 3 + 1] = Math.round(Math.min(1, Math.max(0, rgbaHalf[j + 1])) * 65535);
    rgb16[i * 3 + 2] = Math.round(Math.min(1, Math.max(0, rgbaHalf[j + 2])) * 65535);
  }
  const { ifd0, exif, gps } = captureEntries(meta, "p3");
  const entries: Entry[] = [
    { tag: 262, type: T.SHORT, values: [2] },
    { tag: 274, type: T.SHORT, values: [1] },
    { tag: 34675, type: T.UNDEFINED, values: buildIcc("p3") },
    ...ifd0.filter((e) => e.tag !== 0x0112),
    { tag: 0x8769, type: T.LONG, values: [0], patch: (o) => [o("exif")] },
  ];
  const extra = [{ key: "exif", entries: exif }];
  if (gps) { entries.push({ tag: 0x8825, type: T.LONG, values: [0], patch: (o) => [o("gps")] }); extra.push({ key: "gps", entries: gps }); }
  const bytes = await writeTiffLike(w, h, rgb16, entries, extra, true);
  return new Blob([bytes as BlobPart], { type: "image/tiff" });
}

/**
 * Processed linear DNG. Input: scene-linear Rec.2020 RGBA floats.
 * Data are scaled by 2^-headroom so that highlights above 1.0 survive, and
 * BaselineExposure = +headroom restores the intended brightness.
 */
export async function encodeLinearDng(rgba: Float32Array, w: number, h: number, meta: PhotoMetadata): Promise<Blob> {
  let mx = 0;
  for (let i = 0; i < w * h * 4; i += 4) mx = Math.max(mx, rgba[i], rgba[i + 1], rgba[i + 2]);
  const headroom = Math.max(0, Math.ceil(Math.log2(Math.max(mx, 1e-6))));
  const s = Math.pow(2, -headroom) * 65535;
  const rgb16 = new Uint16Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    for (let c = 0; c < 3; c++) rgb16[i * 3 + c] = Math.round(Math.min(65535, Math.max(0, rgba[j + c] * s)));
  }
  // Camera space ≡ linear Rec.2020: ColorMatrix1 = XYZ→camera, ForwardMatrix1 = camera→XYZ(D50).
  const cm = XYZ_TO_REC2020;
  const fm = mul(bradford(D65_XY, D50_XY), REC2020_TO_XYZ);
  const sr = (m: number[]) => m.flatMap((v) => srational(v, 10000));
  const { ifd0, exif, gps } = captureEntries(meta, "p3");
  const entries: Entry[] = [
    { tag: 254, type: T.LONG, values: [0] },
    { tag: 262, type: T.SHORT, values: [34892] }, // LinearRaw
    { tag: 274, type: T.SHORT, values: [1] },
    { tag: 0x010e, type: T.ASCII, values: "Processed image (denoised/restored, white-balanced, scene-linear Rec.2020). Not original sensor data." },
    ...ifd0.filter((e) => e.tag !== 0x0112 && e.tag !== 0x0131),
    { tag: 0x0131, type: T.ASCII, values: SOFTWARE },
    { tag: 50706, type: T.BYTE, values: [1, 4, 0, 0] }, // DNGVersion
    { tag: 50707, type: T.BYTE, values: [1, 1, 0, 0] }, // DNGBackwardVersion
    { tag: 50708, type: T.ASCII, values: `${SOFTWARE} processed linear (${meta.make ?? ""} ${meta.model ?? ""})`.trim() },
    { tag: 50717, type: T.LONG, values: [65535, 65535, 65535] }, // WhiteLevel
    { tag: 50714, type: T.LONG, values: [0, 0, 0] },            // BlackLevel (per sample)
    { tag: 50713, type: T.SHORT, values: [1, 1] },              // BlackLevelRepeatDim
    { tag: 50721, type: T.SRATIONAL, values: sr(cm) },          // ColorMatrix1
    { tag: 50964, type: T.SRATIONAL, values: sr(fm) },          // ForwardMatrix1
    { tag: 50778, type: T.SHORT, values: [21] },                // CalibrationIlluminant1 = D65
    { tag: 50728, type: T.RATIONAL, values: [1, 1, 1, 1, 1, 1] }, // AsShotNeutral
    { tag: 50730, type: T.SRATIONAL, values: srational(headroom, 100) }, // BaselineExposure
    { tag: 50936, type: T.ASCII, values: "Processed linear Rec.2020" }, // ProfileName
    { tag: 50829, type: T.LONG, values: [0, 0, h, w] },          // ActiveArea
    { tag: 0x8769, type: T.LONG, values: [0], patch: (o) => [o("exif")] },
  ];
  const extra = [{ key: "exif", entries: exif }];
  if (gps) { entries.push({ tag: 0x8825, type: T.LONG, values: [0], patch: (o) => [o("gps")] }); extra.push({ key: "gps", entries: gps }); }
  // Uncompressed: the most widely readable choice for LinearRaw integer data.
  const bytes = await writeTiffLike(w, h, rgb16, entries, extra, false);
  return new Blob([bytes as BlobPart], { type: "image/x-adobe-dng" });
}
