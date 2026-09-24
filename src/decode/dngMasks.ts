/**
 * Apple's semantic mattes inside a ProRAW DNG.
 *
 * Every ProRAW file carries the masks the phone computed while shooting,
 * stored as DNG 1.6 semantic masks (PhotometricInterpretation 52527) in their
 * own SubIFDs: sky, skin, and the portrait subject, each a JPEG-compressed
 * 8-bit image at half the frame's width and height with an Apple URN as its
 * SemanticName. They are far better than anything a small network can produce
 * on a reduced image — precise around hair, branches and roof lines — and
 * cost a JPEG decode instead of an inference.
 *
 * The mattes are stored in sensor orientation, so they are rotated here the
 * same way the working image is.
 */
export interface DngMask {
  kind: "sky" | "skin" | "subject";
  data: Uint8Array;
  width: number;
  height: number;
}

const KIND: Array<[RegExp, DngMask["kind"]]> = [
  [/semanticskymatte/i, "sky"],
  [/semanticskinmatte/i, "skin"],
  [/portraiteffectsmatte/i, "subject"],
];

interface Blob_ { kind: DngMask["kind"]; width: number; height: number; bytes: Uint8Array }

/** Finds the semantic mattes in a DNG without decoding them. */
export function findDngMasks(file: Uint8Array): Array<{ kind: DngMask["kind"]; width: number; height: number; bytes: Uint8Array }> {
  if (file.length < 8 || !((file[0] === 0x49 && file[1] === 0x49) || (file[0] === 0x4d && file[1] === 0x4d))) return [];
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const le = file[0] === 0x49;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const out: Blob_[] = [];
  const seen = new Set<number>();
  const walk = (ifd: number, depth: number) => {
    if (ifd <= 0 || ifd + 2 > file.length || depth > 3 || seen.has(ifd)) return;
    seen.add(ifd);
    const n = u16(ifd);
    if (n > 512) return;
    const tags = new Map<number, { type: number; count: number; value: number }>();
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > file.length) break;
      const type = u16(e + 2), count = u32(e + 4);
      tags.set(u16(e), { type, count, value: type === 3 && count === 1 ? u16(e + 8) : u32(e + 8) });
    }
    const photometric = tags.get(262)?.value;
    const name = tags.get(52526);
    if (photometric === 52527 && name) {
      let s = "";
      for (let i = 0; i < name.count && name.value + i < file.length; i++) {
        const c = file[name.value + i];
        if (!c) break;
        s += String.fromCharCode(c);
      }
      const kind = KIND.find(([re]) => re.test(s))?.[1];
      const off = tags.get(273)?.value, len = tags.get(279)?.value;
      const w = tags.get(256)?.value, h = tags.get(257)?.value;
      // Only single-strip JPEG mattes (what Apple writes) are read.
      if (kind && off && len && w && h && tags.get(259)?.value === 34892 && off + len <= file.length) {
        out.push({ kind, width: w, height: h, bytes: file.subarray(off, off + len) });
      }
    }
    const sub = tags.get(330);
    if (sub) {
      if (sub.count === 1) walk(sub.value, depth + 1);
      else for (let k = 0; k < sub.count && sub.value + k * 4 + 4 <= file.length; k++) walk(u32(sub.value + k * 4), depth + 1);
    }
    const next = ifd + 2 + n * 12;
    if (next + 4 <= file.length) walk(u32(next), depth + 1);
  };
  walk(u32(4), 0);
  return out;
}

/**
 * Decodes the mattes to single-channel images, upright (the EXIF orientation
 * of the photograph is applied, as the working image gets it too).
 */
export async function decodeDngMasks(file: Uint8Array, orientation: number): Promise<DngMask[]> {
  const found = findDngMasks(file);
  const out: DngMask[] = [];
  for (const m of found) {
    try {
      const bmp = await createImageBitmap(new Blob([m.bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
      const rot = orientation >= 5; // 5…8 exchange width and height
      const w = rot ? bmp.height : bmp.width, h = rot ? bmp.width : bmp.height;
      const cv = new OffscreenCanvas(w, h);
      const ctx = cv.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      ctx.save();
      // Same transforms the developer applies to the sensor image.
      switch (orientation) {
        case 2: ctx.translate(w, 0); ctx.scale(-1, 1); break;
        case 3: ctx.translate(w, h); ctx.rotate(Math.PI); break;
        case 4: ctx.translate(0, h); ctx.scale(1, -1); break;
        case 5: ctx.rotate(Math.PI / 2); ctx.scale(1, -1); break;
        case 6: ctx.translate(w, 0); ctx.rotate(Math.PI / 2); break;
        case 7: ctx.translate(w, 0); ctx.rotate(Math.PI / 2); ctx.translate(0, h); ctx.scale(1, -1); break;
        case 8: ctx.translate(0, h); ctx.rotate(-Math.PI / 2); break;
        default: break;
      }
      ctx.drawImage(bmp, 0, 0);
      ctx.restore();
      bmp.close();
      const px = ctx.getImageData(0, 0, w, h).data;
      const data = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) data[i] = px[i * 4];
      out.push({ kind: m.kind, data, width: w, height: h });
    } catch {
      // A matte that will not decode simply does not exist for the pipeline.
    }
  }
  return out;
}
