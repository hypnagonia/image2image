/**
 * The camera's own rendering, embedded in a DNG: Apple ProRAW (and most camera
 * DNGs) carry a full-size JPEG preview of the photo as the phone showed it. Its
 * brightness is the reference for automatic exposure ("as bright as the
 * original"), measured here without decoding it at full size.
 *
 * The file is scanned for JPEG streams; each one's frame header (SOF) gives its
 * size and component count without decoding (Apple's semantic mattes are
 * single-component and are skipped). The largest colour JPEG is decoded at a
 * small size and its luminance quantiles returned (display-encoded, 0…1).
 */

interface JpegInfo { offset: number; width: number; height: number; components: number }

/** Frame header of the JPEG starting at `o` (null if not a plausible JPEG). */
export function jpegInfo(b: Uint8Array, o: number): JpegInfo | null {
  let i = o + 2;
  const end = Math.min(b.length - 9, o + (1 << 20)); // the SOF sits in the first KB of real files; 1 MB is generous
  while (i < end) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    // Frame headers. Only baseline / extended / progressive (C0–C2) are pictures: the
    // raw sensor data itself is stored as lossless JPEG (C3 …) and must not be read as one.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (m > 0xc2) return null;
      return { offset: o, height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], components: b[i + 9] };
    }
    if (m === 0xda) return null; // scan started without a frame header
    i += 2 + len;
  }
  return null;
}

/** The largest colour picture JPEG in the bytes (the camera's rendering), if any. */
export function findPreview(head: Uint8Array): JpegInfo | null {
  let best: JpegInfo | null = null;
  for (let i = 0; i < head.length - 4; i++) {
    if (head[i] !== 0xff || head[i + 1] !== 0xd8 || head[i + 2] !== 0xff) continue;
    const info = jpegInfo(head, i);
    if (info && info.components === 3 && Math.max(info.width, info.height) >= 256 && (!best || info.width * info.height > best.width * best.height)) best = info;
  }
  return best;
}

const eotf = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const oetf = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Median display-encoded luminance of rendered 8-bit P3 pixels (rgba), subsampled. */
export function renderedMedian(px: Uint8Array, stride = 7): number {
  const ys: number[] = [];
  for (let k = 0; k < px.length; k += 4 * stride) {
    const Y = 0.229 * eotf(px[k] / 255) + 0.6917 * eotf(px[k + 1] / 255) + 0.0793 * eotf(px[k + 2] / 255);
    ys.push(oetf(Y));
  }
  ys.sort((a, b) => a - b);
  return ys.length ? ys[ys.length >> 1] : 0;
}

export interface PreviewStats {
  width: number; height: number;
  /** Display-encoded luminance at the requested quantiles. */
  q: number[];
}

/**
 * Luminance quantiles of the embedded camera rendering, or undefined when the
 * file has none (or only a thumbnail: under 256 px on the long side).
 */
export async function embeddedPreviewStats(file: Blob, qs: number[]): Promise<PreviewStats | undefined> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") return undefined;
  // Previews sit in the first part of the file (before the raw data in Apple's layout,
  // but not always): read up to 48 MB, which also covers most cameras' layouts.
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 48 << 20)).arrayBuffer());
  const best = findPreview(head);
  if (!best) return undefined;
  try {
    const w = 256, h = Math.max(1, Math.round((w * best.height) / best.width));
    const bmp = await createImageBitmap(file.slice(best.offset), { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const ys: number[] = [];
    for (let k = 0; k < px.length; k += 4) {
      // Display P3 luminance (Apple's previews are P3); encoded like our own display levels.
      const Y = 0.229 * eotf(px[k] / 255) + 0.6917 * eotf(px[k + 1] / 255) + 0.0793 * eotf(px[k + 2] / 255);
      ys.push(oetf(Y));
    }
    ys.sort((a, b) => a - b);
    return { width: best.width, height: best.height, q: qs.map((q) => ys[Math.min(ys.length - 1, Math.floor(q * ys.length))]) };
  } catch {
    return undefined;
  }
}
