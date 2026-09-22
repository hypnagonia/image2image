/**
 * Input dispatcher. Chooses a decoder from the file's magic bytes, not its
 * extension (iOS hands over DNGs with odd names and MIME types).
 *
 *   DNG / TIFF-based RAW → LibRaw (wasm)                       src/decode/libraw.ts
 *   HEIC / HEIF          → native (createImageBitmap) first,
 *                          libheif (wasm) when the browser cannot decode it
 *   JPEG / PNG / WebP    → native
 */
import { decodeRaw } from "./libraw.ts";
import { findHeifExif, findJpegExif, readExif } from "./exif.ts";
import type { DecodedImage, PhotoMetadata, RgbSource } from "./types.ts";

export type Sniffed = "tiff" | "heif" | "jpeg" | "png" | "webp" | "unknown";

export function sniff(b: Uint8Array): Sniffed {
  if (b.length < 12) return "unknown";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tiff";
  const ftyp = String.fromCharCode(b[4], b[5], b[6], b[7]);
  if (ftyp === "ftyp") {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(brand)) return "heif";
  }
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "webp";
  // Other camera raws (CR3 is ISOBMFF 'crx ', RAF, ORF…) — let LibRaw try.
  return "unknown";
}

export async function decodeFile(bytes: Uint8Array, name: string, mime: string): Promise<DecodedImage> {
  const kind = sniff(bytes);
  if (kind === "tiff" || kind === "unknown") return decodeRaw(bytes, name);
  if (kind === "heif") return decodeHeif(bytes, mime);
  return decodeNative(bytes, mime, kind === "jpeg" ? "jpeg" : kind === "png" ? "png" : "other");
}

function metaFrom(exif: Uint8Array | undefined): PhotoMetadata {
  const m = exif ? readExif(exif) : {};
  return { ...m, orientation: 1, exifBlock: exif } as PhotoMetadata;
}

async function nativeBitmap(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type: mime || "application/octet-stream" });
  // imageOrientation 'from-image' applies EXIF/irot so pixels arrive upright.
  return createImageBitmap(blob, { imageOrientation: "from-image", colorSpaceConversion: "default", premultiplyAlpha: "none" });
}

async function decodeNative(bytes: Uint8Array, mime: string, format: DecodedImage["format"]): Promise<DecodedImage> {
  const t0 = performance.now();
  const bmp = await nativeBitmap(bytes, mime);
  const exif = format === "jpeg" ? findJpegExif(bytes) : undefined;
  const source: RgbSource = { kind: "rgb", width: bmp.width, height: bmp.height, pixels: bmp, colorSpace: "display-p3", decoder: "native" };
  return { format, source, meta: metaFrom(exif), close: () => bmp.close(), timings: { "native.decode": performance.now() - t0 } };
}

async function decodeHeif(bytes: Uint8Array, mime: string): Promise<DecodedImage> {
  const exif = findHeifExif(bytes);
  const meta = metaFrom(exif);
  const t0 = performance.now();
  try {
    const bmp = await nativeBitmap(bytes, mime || "image/heic");
    const source: RgbSource = { kind: "rgb", width: bmp.width, height: bmp.height, pixels: bmp, colorSpace: "display-p3", decoder: "native" };
    return { format: "heic", source, meta, close: () => bmp.close(), timings: { "heic.native": performance.now() - t0 } };
  } catch {
    // Browser has no HEVC/HEIF decoder (Chrome, Firefox): fall back to libheif.
  }
  const t1 = performance.now();
  const lib = await loadLibheif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images.length) throw new Error("libheif found no image in this HEIF file");
  const img = images[0];
  const w = img.get_width(), h = img.get_height();
  const rgba = new Uint8ClampedArray(w * h * 4);
  await new Promise<void>((resolve, reject) => {
    img.display({ data: rgba, width: w, height: h }, (res: unknown) => (res ? resolve() : reject(new Error("libheif failed to decode"))));
  });
  for (const i of images) i.free?.();
  // libheif applies the HEIF transforms (irot/imir) itself; it does not colour-
  // manage. Apple HEICs are Display P3 (nclx); others are assumed sRGB.
  const cs = /apple/i.test(meta.make ?? "") ? "display-p3" : "srgb";
  const source: RgbSource = { kind: "rgb", width: w, height: h, pixels: { data: new Uint8Array(rgba.buffer), bits: 8, channels: 4 }, colorSpace: cs, decoder: "libheif" };
  return { format: "heic", source, meta, close: () => {}, timings: { "heic.native-failed": t1 - t0, "heic.libheif": performance.now() - t1 } };
}

type Libheif = { HeifDecoder: new () => { decode(b: Uint8Array): Array<{ get_width(): number; get_height(): number; display(o: object, cb: (r: unknown) => void): void; free?(): void }> } };
let libheif: Promise<Libheif> | undefined;
function loadLibheif(): Promise<Libheif> {
  libheif ??= import("libheif-js/libheif-wasm/libheif-bundle.mjs").then((m) => {
    const f = (m as { default: unknown }).default;
    return (typeof f === "function" ? (f as () => Libheif)() : f) as Libheif;
  });
  return libheif;
}
