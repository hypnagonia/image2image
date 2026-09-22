/**
 * DNG / camera RAW decoding through LibRaw compiled to WebAssembly
 * (native/libraw). LibRaw parses the container and decompresses the sensor
 * data; it applies *no* processing — black level, demosaic, white balance and
 * colour are done on the GPU from the metadata returned here.
 *
 * A fresh module instance is created per file and dropped afterwards: a wasm
 * heap never shrinks, so re-using one instance would pin the peak of the
 * largest file ever opened for the lifetime of the tab.
 */
import createLibRaw from "./wasm/libraw.js";
import { cameraColorFromLibRaw } from "../color/dng.ts";
import type { DecodedImage, LibRawMeta, PhotoMetadata, RawSource } from "./types.ts";

interface LibRawModule {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  UTF8ToString(p: number): string;
  _lr_open(p: number, n: number): number;
  _lr_unpack(): number;
  _lr_strerror(c: number): number;
  _lr_raw_kind(): number;
  _lr_raw_ptr(): number;
  _lr_meta_json(): number;
  _lr_close(): void;
  _lr_malloc(n: number): number;
  _lr_free(p: number): void;
}

/** LibRaw flip → EXIF orientation. */
function flipToOrientation(flip: number): number {
  switch (flip) {
    case 3: return 3;
    case 5: return 8;
    case 6: return 6;
    default: return 1;
  }
}

function dmsToDeg(v: number[], ref: string): number {
  const d = (v[0] || 0) + (v[1] || 0) / 60 + (v[2] || 0) / 3600;
  return ref === "S" || ref === "W" ? -d : d;
}

export async function decodeRaw(bytes: Uint8Array, name: string): Promise<DecodedImage> {
  const t0 = performance.now();
  const M = (await createLibRaw()) as unknown as LibRawModule;
  const tInit = performance.now();
  const ptr = M._lr_malloc(bytes.byteLength);
  if (!ptr) throw new Error("Not enough memory to load the file");
  M.HEAPU8.set(bytes, ptr);
  const err = (c: number, what: string) => new Error(`${what}: ${M.UTF8ToString(M._lr_strerror(c))}`);
  let r = M._lr_open(ptr, bytes.byteLength);
  if (r) { M._lr_free(ptr); throw err(r, `LibRaw could not open ${name}`); }
  r = M._lr_unpack();
  if (r) { M._lr_close(); M._lr_free(ptr); throw err(r, "LibRaw could not decode the sensor data"); }
  // The compressed file is no longer needed once unpacked.
  M._lr_free(ptr);
  const tUnpack = performance.now();

  const meta = JSON.parse(M.UTF8ToString(M._lr_meta_json())) as LibRawMeta;
  const s = meta.sizes;
  const kind = meta.rawKind;
  if (kind === 0) {
    M._lr_close();
    throw new Error("Unsupported sensor layout (floating-point or unusual DNG). Try a ProRAW or standard Bayer DNG.");
  }
  if (kind === 1 && meta.idata.filters !== 0 && meta.idata.filters < 1000) {
    M._lr_close();
    throw new Error("X-Trans and other non-Bayer mosaics are not supported yet.");
  }
  const channels = (kind === 1 ? 1 : kind) as 1 | 3 | 4;
  const rawPtr = M._lr_raw_ptr();
  const total = (s.rawPitch / 2) * s.rawHeight;
  const data = new Uint16Array(M.HEAPU16.buffer, rawPtr, total);

  const c = meta.color;
  const lv = c.dngLevels;
  // Black: LibRaw's `black` + per-channel cblack[0..3] + the cblack[6..] pattern.
  const cfaFull = meta.idata.cfa16;
  const cfaAt = (row: number, col: number) => cfaFull[(row % 16) * 16 + (col % 16)];
  const patW = c.cblack[4] | 0, patH = c.cblack[5] | 0;
  const blackAt = (row: number, col: number, ch: number) => {
    let b = c.black + (c.cblack[ch] || 0);
    if (patW > 0 && patH > 0) b += c.cblack[6 + (row % patH) * patW + (col % patW)] || 0;
    return b;
  };
  const top = s.topMargin, left = s.leftMargin;
  const cfaIdx = (row: number, col: number) => {
    const v = cfaAt(row, col);
    return v === 3 ? 1 : v; // second green → green
  };
  let cfa: [number, number, number, number] = [0, 1, 1, 2];
  let black: [number, number, number, number];
  let white: [number, number, number, number];
  const maximum = c.maximum || 65535;
  if (kind === 1) {
    cfa = [cfaIdx(0, 0), cfaIdx(0, 1), cfaIdx(1, 0), cfaIdx(1, 1)];
    // Black per CFA *colour* (the shader indexes by colour).
    const b = [0, 0, 0, 0];
    const cnt = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const row = i >> 1, col = i & 1;
      const colour = cfa[i];
      b[colour] += blackAt(row, col, cfaAt(row, col));
      cnt[colour]++;
    }
    black = [b[0] / (cnt[0] || 1), b[1] / (cnt[1] || 1), b[2] / (cnt[2] || 1), 0];
    white = [maximum, maximum, maximum, maximum];
  } else {
    black = [blackAt(0, 0, 0), blackAt(0, 0, 1), blackAt(0, 0, 2), 0];
    const wl = lv.whiteLevel;
    white = [wl[0] || maximum, wl[1] || wl[0] || maximum, wl[2] || wl[0] || maximum, maximum];
  }

  const make = meta.idata.make || "";
  const isProRaw = kind !== 1 && /apple/i.test(make);
  const color = cameraColorFromLibRaw(meta);

  const o = meta.other;
  const pm: PhotoMetadata = {
    make: meta.idata.make || undefined,
    model: meta.idata.normalizedModel || meta.idata.model || undefined,
    software: meta.idata.software || undefined,
    lensMake: meta.lens.make || undefined,
    lensModel: meta.lens.model || undefined,
    iso: o.iso || undefined,
    exposureTime: o.shutter || undefined,
    fNumber: o.aperture || undefined,
    focalLength: o.focalLength || undefined,
    focalLength35: meta.lens.focalLength35 || undefined,
    dateTime: o.timestamp ? new Date(o.timestamp * 1000) : undefined,
    gps: o.gpsParsed ? { lat: dmsToDeg(o.latitude, o.latRef), lon: dmsToDeg(o.longitude, o.lonRef), alt: o.altitude || undefined } : undefined,
    artist: o.artist || undefined,
    description: o.description || undefined,
    orientation: flipToOrientation(s.flip),
  };

  const source: RawSource = {
    kind: kind === 1 ? "bayer" : "linear-raw",
    isProRaw,
    width: s.width,
    height: s.height,
    channels,
    pitch: s.rawPitch / 2,
    left,
    top,
    data,
    cfa,
    black,
    white,
    color,
  };
  const tEnd = performance.now();
  return {
    format: meta.idata.dngVersion ? "dng" : "raw",
    source,
    meta: pm,
    close: () => { M._lr_close(); },
    timings: { "libraw.init": tInit - t0, "libraw.unpack": tUnpack - tInit, "libraw.meta": tEnd - tUnpack },
    // Exposed for the debug log.
    ...({ libraw: meta } as object),
  };
}
