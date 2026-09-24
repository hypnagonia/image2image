/**
 * Low-level HEIF access (libheif in WebAssembly).
 *
 * The wrapper that ships with libheif-js only offers 8-bit RGBA through
 * `HeifDecoder.display()`, which throws away two things an iPhone photograph
 * carries: the 10-bit base image and the HDR gain map Apple stores as an
 * auxiliary image (`urn:com:apple:photo:2020:aux:hdrgainmap`). Both are
 * reachable through libheif's C API, which the same module exports, so this
 * module calls it directly — no rebuild of libheif needed.
 *
 * Emscripten details: functions returning a `heif_error` struct take a hidden
 * first argument pointing at the result (sret), embind objects carry their
 * pointer in `$$.ptr`, and there is no `UTF8ToString` in this build.
 */

/** Apple's auxiliary type for the HDR gain map. */
const GAIN_MAP_URN = "urn:com:apple:photo:2020:aux:hdrgainmap";

// libheif's enums reach JS as embind objects; the raw C entry points need the
// plain numbers behind them.
const COLORSPACE_MONOCHROME = 2;
const CHROMA_MONOCHROME = 0;
const CHANNEL_Y = 0;

export interface HeifImageData {
  width: number;
  height: number;
  /** 8 … 16; the base image of an iPhone HDR photograph is 10. */
  bits: number;
  /** Interleaved RGBA at `bits` per sample, tightly packed. */
  rgba: Uint16Array;
  /** Apple HDR gain map, one byte per pixel, usually half the frame size. */
  gain?: { data: Uint8Array; width: number; height: number };
}

type Ptr = number;
interface Libheif {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(n: number): Ptr;
  _free(p: Ptr): void;
  heif_context_alloc(): { $$: { ptr: Ptr } };
  heif_context_free(c: unknown): void;
  heif_context_read_from_memory(c: unknown, bytes: Uint8Array): { code: { value?: number } | number; message?: string };
  heif_js_context_get_list_of_top_level_image_IDs(c: unknown): number[];
  heif_js_context_get_image_handle(c: unknown, id: number): { $$: { ptr: Ptr } } & { code?: unknown; message?: string };
  heif_js_decode_image2(h: unknown, colorspace: unknown, chroma: unknown): Promise<HeifDecoded> | HeifDecoded;
  heif_image_release(img: unknown): void;
  heif_image_handle_release(h: unknown): void;
  /** Embind enum values — objects, not numbers; only the embind entry points accept them. */
  heif_colorspace: { heif_colorspace_RGB: unknown };
  heif_chroma: { heif_chroma_interleaved_RRGGBBAA_LE: unknown };
  _heif_image_handle_get_number_of_auxiliary_images(h: Ptr, filter: number): number;
  _heif_image_handle_get_list_of_auxiliary_image_IDs(h: Ptr, filter: number, out: Ptr, count: number): number;
  _heif_image_handle_get_auxiliary_image_handle(err: Ptr, h: Ptr, id: number, out: Ptr): void;
  _heif_image_handle_get_auxiliary_type(err: Ptr, h: Ptr, out: Ptr): void;
  _heif_image_handle_get_width(h: Ptr): number;
  _heif_image_handle_get_height(h: Ptr): number;
  _heif_image_handle_release(h: Ptr): void;
  _heif_decode_image(err: Ptr, h: Ptr, out: Ptr, colorspace: number, chroma: number, options: Ptr): void;
  _heif_image_get_plane_readonly(img: Ptr, channel: number, stride: Ptr): Ptr;
  _heif_image_release(img: Ptr): void;
}
interface HeifDecoded {
  image: unknown;
  code?: unknown;
  message?: string;
  channels: Array<{ id: unknown; data: Uint8Array; stride: number; width: number; height: number; bits_per_pixel: number }>;
}

let mod: Promise<Libheif> | undefined;
function load(): Promise<Libheif> {
  mod ??= import("libheif-js/libheif-wasm/libheif-bundle.mjs").then(async (m) => {
    const f = (m as { default: unknown }).default;
    const r = typeof f === "function" ? (f as () => unknown)() : f;
    return (await r) as Libheif;
  });
  return mod;
}

/**
 * Does this file carry an Apple HDR gain map? A plain byte scan for the
 * auxiliary type string: a few milliseconds, and it avoids loading the 2 MB
 * libheif module for ordinary photographs. Only meaningful for HEIF — a
 * ProRAW DNG names the same type in its XMP without this path applying.
 */
export function hasAppleGainMap(bytes: Uint8Array): boolean {
  const needle = GAIN_MAP_URN;
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

/** Reads a NUL-terminated C string out of the wasm heap. */
function cstring(lib: Libheif, p: Ptr): string {
  let s = "";
  for (let i = p; lib.HEAPU8[i]; i++) s += String.fromCharCode(lib.HEAPU8[i]);
  return s;
}

/**
 * Decodes a HEIF file at its own bit depth, together with Apple's HDR gain
 * map when the file has one. The base image comes back as tightly packed
 * RGBA (16-bit samples, values in 0 … 2^bits − 1).
 */
export async function decodeHeifFull(bytes: Uint8Array): Promise<HeifImageData> {
  const lib = await load();
  const ctx = lib.heif_context_alloc();
  try {
    const err = lib.heif_context_read_from_memory(ctx, bytes);
    const code = typeof err.code === "object" ? (err.code as { value?: number }).value ?? 0 : err.code;
    if (code) throw new Error(`libheif could not read this HEIF file${err.message ? `: ${err.message}` : ""}`);
    const ids = lib.heif_js_context_get_list_of_top_level_image_IDs(ctx);
    if (!ids?.length) throw new Error("libheif found no image in this HEIF file");
    const handle = lib.heif_js_context_get_image_handle(ctx, ids[0]);
    if (!handle || handle.code) throw new Error("libheif could not open the main image");
    try {
      const res = await lib.heif_js_decode_image2(handle, lib.heif_colorspace.heif_colorspace_RGB, lib.heif_chroma.heif_chroma_interleaved_RRGGBBAA_LE);
      if (!res || res.code) throw new Error(`libheif could not decode the main image${res?.message ? `: ${res.message}` : ""}`);
      const ch = res.channels[0];
      const width = ch.width, height = ch.height;
      // Tight RGBA16: libheif pads rows to its own stride.
      const rgba = new Uint16Array(width * height * 4);
      const src = new Uint16Array(ch.data.buffer, ch.data.byteOffset, ch.data.byteLength >> 1);
      const strideSamples = ch.stride >> 1;
      for (let y = 0; y < height; y++) rgba.set(src.subarray(y * strideSamples, y * strideSamples + width * 4), y * width * 4);
      lib.heif_image_release(res.image);
      const gain = readGainMap(lib, handle.$$.ptr);
      return { width, height, bits: ch.bits_per_pixel, rgba, gain };
    } finally {
      lib.heif_image_handle_release(handle);
    }
  } finally {
    lib.heif_context_free(ctx);
  }
}

/** Apple's gain map, if this image has one attached as an auxiliary image. */
function readGainMap(lib: Libheif, handle: Ptr): HeifImageData["gain"] {
  const n = lib._heif_image_handle_get_number_of_auxiliary_images(handle, 0);
  if (!n) return undefined;
  const idsPtr = lib._malloc(4 * n);
  const errPtr = lib._malloc(16), outPtr = lib._malloc(4), strPtr = lib._malloc(4), stridePtr = lib._malloc(4);
  try {
    lib._heif_image_handle_get_list_of_auxiliary_image_IDs(handle, 0, idsPtr, n);
    for (let i = 0; i < n; i++) {
      const id = lib.HEAPU32[(idsPtr >> 2) + i];
      lib._heif_image_handle_get_auxiliary_image_handle(errPtr, handle, id, outPtr);
      if (lib.HEAPU32[errPtr >> 2]) continue;
      const aux = lib.HEAPU32[outPtr >> 2];
      if (!aux) continue;
      try {
        lib._heif_image_handle_get_auxiliary_type(errPtr, aux, strPtr);
        if (lib.HEAPU32[errPtr >> 2]) continue;
        if (cstring(lib, lib.HEAPU32[strPtr >> 2]) !== GAIN_MAP_URN) continue;
        const w = lib._heif_image_handle_get_width(aux), h = lib._heif_image_handle_get_height(aux);
        lib._heif_decode_image(errPtr, aux, outPtr, COLORSPACE_MONOCHROME, CHROMA_MONOCHROME, 0);
        if (lib.HEAPU32[errPtr >> 2]) continue;
        const img = lib.HEAPU32[outPtr >> 2];
        try {
          const plane = lib._heif_image_get_plane_readonly(img, CHANNEL_Y, stridePtr);
          const stride = lib.HEAPU32[stridePtr >> 2];
          const data = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) data.set(lib.HEAPU8.subarray(plane + y * stride, plane + y * stride + w), y * w);
          return { data, width: w, height: h };
        } finally {
          lib._heif_image_release(img);
        }
      } finally {
        lib._heif_image_handle_release(aux);
      }
    }
    return undefined;
  } finally {
    lib._free(idsPtr); lib._free(errPtr); lib._free(outPtr); lib._free(strPtr); lib._free(stridePtr);
  }
}
