/**
 * Minimal EXIF (TIFF) reader for HEIC/JPEG sources, and a locator for the Exif
 * item inside HEIF (ISOBMFF). Only the fields the pipeline uses or re-emits.
 */
import type { PhotoMetadata } from "./types.ts";

export function readExif(tiff: Uint8Array): Partial<PhotoMetadata> {
  if (tiff.length < 8) return {};
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = tiff[0] === 0x49;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const out: Partial<PhotoMetadata> = {};
  const str = (off: number, n: number) => {
    let s = "";
    for (let i = 0; i < n && off + i < tiff.length; i++) { const c = tiff[off + i]; if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  };
  const rational = (off: number, signed = false) => {
    const a = signed ? dv.getInt32(off, le) : u32(off);
    const b = signed ? dv.getInt32(off + 4, le) : u32(off + 4);
    return b ? a / b : 0;
  };
  const tags = new Map<number, { type: number; count: number; valOff: number }>();
  const walk = (ifd: number, depth: number) => {
    if (ifd <= 0 || ifd + 2 > tiff.length || depth > 3) return;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = ([0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] ?? 1) * count;
      const valOff = size <= 4 ? e + 8 : u32(e + 8);
      if (!tags.has(tag)) tags.set(tag, { type, count, valOff });
      if (tag === 0x8769 || tag === 0x8825) walk(u32(e + 8), depth + 1);
    }
  };
  walk(u32(4), 0);
  const get = (t: number) => tags.get(t);
  const num = (t: number): number | undefined => {
    const e = get(t);
    if (!e) return undefined;
    switch (e.type) {
      case 3: return u16(e.valOff);
      case 4: return u32(e.valOff);
      case 5: return rational(e.valOff);
      case 10: return rational(e.valOff, true);
      default: return undefined;
    }
  };
  const s = (t: number) => { const e = get(t); return e && e.type === 2 ? str(e.valOff, e.count) : undefined; };
  out.make = s(0x010f);
  out.model = s(0x0110);
  out.software = s(0x0131);
  out.artist = s(0x013b);
  out.orientation = num(0x0112) ?? 1;
  out.exposureTime = num(0x829a);
  out.fNumber = num(0x829d);
  out.iso = num(0x8827);
  out.focalLength = num(0x920a);
  out.focalLength35 = num(0xa405);
  out.lensMake = s(0xa433);
  out.lensModel = s(0xa434);
  const dt = s(0x9003) ?? s(0x0132);
  if (dt) {
    const m = dt.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (m) out.dateTime = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  const lat = get(0x0002), lon = get(0x0004);
  if (lat && lon && lat.count === 3 && lon.count === 3) {
    const dms = (o: number) => rational(o) + rational(o + 8) / 60 + rational(o + 16) / 3600;
    const latRef = s(0x0001), lonRef = s(0x0003);
    out.gps = { lat: dms(lat.valOff) * (latRef === "S" ? -1 : 1), lon: dms(lon.valOff) * (lonRef === "W" ? -1 : 1) };
    const alt = num(0x0006);
    if (alt !== undefined) out.gps.alt = alt;
  }
  for (const k of Object.keys(out) as Array<keyof PhotoMetadata>) if (out[k] === undefined) delete out[k];
  return out;
}

/** Finds the Exif payload (TIFF header onwards) inside a HEIF file. */
export function findHeifExif(buf: Uint8Array): Uint8Array | undefined {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const box = (off: number, end: number, cb: (type: string, start: number, bodyStart: number, boxEnd: number) => void) => {
    while (off + 8 <= end) {
      let size = dv.getUint32(off);
      const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(off + 8)); hdr = 16; }
      if (size === 0) size = end - off;
      if (size < hdr || off + size > end) return;
      cb(type, off, off + hdr, off + size);
      off += size;
    }
  };
  let exifId = -1;
  const locs = new Map<number, { offset: number; length: number }>();
  box(0, buf.length, (type, _s, body, end) => {
    if (type !== "meta") return;
    box(body + 4, end, (t, _s2, b2, e2) => {
      if (t === "iinf") {
        const ver = buf[b2];
        const count = ver === 0 ? dv.getUint16(b2 + 4) : dv.getUint32(b2 + 4);
        box(b2 + (ver === 0 ? 6 : 8), e2, (t3, _s3, b3) => {
          if (t3 !== "infe" || count === 0) return;
          const v = buf[b3];
          if (v < 2) return;
          const id = v === 2 ? dv.getUint16(b3 + 4) : dv.getUint32(b3 + 4);
          const typeOff = b3 + (v === 2 ? 8 : 10);
          const itype = String.fromCharCode(buf[typeOff], buf[typeOff + 1], buf[typeOff + 2], buf[typeOff + 3]);
          if (itype === "Exif") exifId = id;
        });
      } else if (t === "iloc") {
        const ver = buf[b2];
        const s1 = buf[b2 + 4], s2 = buf[b2 + 5];
        const offSize = s1 >> 4, lenSize = s1 & 15, baseSize = s2 >> 4, idxSize = ver >= 1 ? s2 & 15 : 0;
        let p = b2 + 6;
        const rd = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[p++]; return v; };
        const count = ver < 2 ? rd(2) : rd(4);
        for (let i = 0; i < count; i++) {
          const id = ver < 2 ? rd(2) : rd(4);
          if (ver >= 1) rd(2);
          rd(2); // data reference index
          const base = rd(baseSize);
          const ext = rd(2);
          for (let k = 0; k < ext; k++) {
            if (idxSize) rd(idxSize);
            const o = rd(offSize), l = rd(lenSize);
            if (k === 0) locs.set(id, { offset: base + o, length: l });
          }
        }
      }
    });
  });
  const loc = locs.get(exifId);
  if (!loc || loc.offset + loc.length > buf.length) return undefined;
  const item = buf.subarray(loc.offset, loc.offset + loc.length);
  const skip = new DataView(item.buffer, item.byteOffset).getUint32(0); // exif_tiff_header_offset
  const tiff = item.subarray(4 + skip);
  return tiff[0] === 0x49 || tiff[0] === 0x4d ? tiff : undefined;
}

/** Finds the APP1 Exif payload in a JPEG. */
export function findJpegExif(buf: Uint8Array): Uint8Array | undefined {
  let p = 2;
  while (p + 4 < buf.length && buf[p] === 0xff) {
    const marker = buf[p + 1];
    const len = (buf[p + 2] << 8) | buf[p + 3];
    if (marker === 0xe1 && buf[p + 4] === 0x45 && buf[p + 5] === 0x78 && buf[p + 6] === 0x69 && buf[p + 7] === 0x66) {
      return buf.subarray(p + 10, p + 2 + len);
    }
    if (marker === 0xda) break;
    p += 2 + len;
  }
  return undefined;
}

/**
 * HDR headroom of an Apple photograph: the factor by which the gain map may
 * lift the image above display white. Apple stores two numbers in its
 * MakerNote (tags 33 and 48) from which the headroom in stops follows; the
 * relation below is the one Apple's own pipeline uses.
 */
export function appleHeadroom(t33: number, t48: number): number {
  const stops = t33 < 1
    ? (t48 <= 0.01 ? -20.0 * t48 + 1.8 : -0.101 * t48 + 1.0)
    : (t48 <= 0.01 ? -70.0 * t48 + 3.0 : -0.303 * t48 + 2.303);
  return Math.pow(2, Math.max(stops, 0));
}

/**
 * Reads the headroom out of an Exif block (Apple MakerNote, tag 0x927c). The
 * MakerNote is its own little TIFF: a 14-byte header ("Apple iOS\0\0\x01" and
 * the byte order), then an IFD whose offsets are relative to its own start.
 */
export function appleHdrHeadroom(tiff: Uint8Array): number | undefined {
  if (tiff.length < 8) return undefined;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = tiff[0] === 0x49;
  const u16 = (o: number, l = le) => dv.getUint16(o, l);
  const u32 = (o: number, l = le) => dv.getUint32(o, l);
  /** Offset and length of the MakerNote, found through IFD0 → Exif IFD. */
  const findMakerNote = (): { off: number; len: number } | undefined => {
    const scan = (ifd: number, depth: number): { off: number; len: number } | undefined => {
      if (ifd <= 0 || ifd + 2 > tiff.length || depth > 2) return undefined;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        const tag = u16(e), count = u32(e + 4);
        if (tag === 0x927c) return { off: u32(e + 8), len: count };
        if (tag === 0x8769) { const r = scan(u32(e + 8), depth + 1); if (r) return r; }
      }
      return undefined;
    };
    return scan(u32(4), 0);
  };
  const mn = findMakerNote();
  if (!mn || mn.off + 16 > tiff.length) return undefined;
  const p = mn.off;
  if (String.fromCharCode(...tiff.subarray(p, p + 9)) !== "Apple iOS") return undefined;
  const mle = tiff[p + 12] === 0x49; // "II" or "MM" at the end of the header
  const q = p + 14;
  if (q + 2 > tiff.length) return undefined;
  const n = u16(q, mle);
  let t33: number | undefined, t48: number | undefined;
  for (let i = 0; i < n; i++) {
    const e = q + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = u16(e, mle), type = u16(e + 2, mle);
    if ((tag !== 33 && tag !== 48) || (type !== 5 && type !== 10)) continue;
    const at = p + u32(e + 8, mle); // MakerNote offsets are relative to its own start
    if (at + 8 > tiff.length) continue;
    const a = type === 10 ? dv.getInt32(at, mle) : u32(at, mle);
    const b = type === 10 ? dv.getInt32(at + 4, mle) : u32(at + 4, mle);
    const v = b ? a / b : 0;
    if (tag === 33) t33 = v; else t48 = v;
  }
  return t33 !== undefined && t48 !== undefined ? appleHeadroom(t33, t48) : undefined;
}

/**
 * Compression tags (259) of every IFD in a TIFF/DNG, including SubIFDs. Used
 * to recognise a DNG this build cannot decode before LibRaw fails on it:
 * 7 = lossless JPEG (Apple ProRAW), 52546 = JPEG-XL (DNG 1.7).
 */
export function tiffCompressions(bytes: Uint8Array): number[] {
  if (bytes.length < 8 || !((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (ifd: number, depth: number) => {
    if (ifd <= 0 || ifd + 2 > bytes.length || depth > 3 || seen.has(ifd)) return;
    seen.add(ifd);
    const n = u16(ifd);
    if (n > 512) return;
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (tag === 259) out.push(type === 3 ? u16(e + 8) : u32(e + 8));
      if (tag === 330) { // SubIFDs: one pointer inline, several through an offset
        if (count === 1) walk(u32(e + 8), depth + 1);
        else { const at = u32(e + 8); for (let k = 0; k < count && at + k * 4 + 4 <= bytes.length; k++) walk(u32(at + k * 4), depth + 1); }
      }
    }
    const next = ifd + 2 + n * 12;
    if (next + 4 <= bytes.length) walk(u32(next), depth + 1);
  };
  walk(u32(4), 0);
  return out;
}
