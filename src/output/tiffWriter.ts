/**
 * Minimal little-endian TIFF/IFD writer shared by EXIF (APP1), 16-bit TIFF and
 * processed-linear DNG export. Values are laid out after each IFD; image data
 * is appended by the caller and referenced through offsets it supplies.
 */

export const enum T { BYTE = 1, ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, UNDEFINED = 7, SRATIONAL = 10, FLOAT = 11 }

export interface Entry {
  tag: number;
  type: T;
  values: number[] | string | Uint8Array;
  /** For pointer tags whose value is patched once layout is known. */
  patch?: (offsetOf: (key: string) => number) => number[];
}

const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8, 11: 4 };

function count(e: Entry): number {
  if (typeof e.values === "string") return e.values.length + 1;
  if (e.values instanceof Uint8Array) return e.values.length;
  if (e.type === T.RATIONAL || e.type === T.SRATIONAL) return e.values.length / 2;
  return e.values.length;
}

export function rational(v: number, den = 10000): [number, number] {
  if (!Number.isFinite(v)) return [0, 1];
  if (Number.isInteger(v)) return [v, 1];
  if (Math.abs(v) < 1 && v !== 0) {
    // Exposure times like 1/250 stay exact.
    const inv = 1 / Math.abs(v);
    if (Math.abs(inv - Math.round(inv)) < 1e-3) return [Math.sign(v), Math.round(inv)];
  }
  return [Math.round(v * den), den];
}

export function srational(v: number, den = 1000000): [number, number] {
  return [Math.round(v * den), den];
}

export class IfdWriter {
  /** Serialises IFDs back to back starting at `base`. Returns bytes and IFD offsets. */
  static layout(ifds: Array<{ key: string; entries: Entry[]; next?: string }>, base: number): { bytes: Uint8Array; offsets: Map<string, number> } {
    // First pass: sizes.
    const offsets = new Map<string, number>();
    let pos = base;
    const sizes = ifds.map((ifd) => {
      const n = ifd.entries.length;
      let extra = 0;
      for (const e of ifd.entries) {
        const sz = SIZE[e.type] * count(e);
        if (sz > 4) extra += sz + (sz & 1);
      }
      return 2 + n * 12 + 4 + extra;
    });
    ifds.forEach((ifd, i) => { offsets.set(ifd.key, pos); pos += sizes[i]; });
    const total = pos - base;
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < ifds.length; i++) {
      const ifd = ifds[i];
      const start = offsets.get(ifd.key)! - base;
      const entries = [...ifd.entries].sort((a, b) => a.tag - b.tag);
      dv.setUint16(start, entries.length, true);
      let extraPos = start + 2 + entries.length * 12 + 4;
      entries.forEach((e, k) => {
        const vals = e.patch ? e.patch((key) => offsets.get(key) ?? 0) : e.values;
        const ee: Entry = { ...e, values: vals as Entry["values"] };
        const o = start + 2 + k * 12;
        const n = count(ee);
        const sz = SIZE[e.type] * n;
        dv.setUint16(o, e.tag, true);
        dv.setUint16(o + 2, e.type, true);
        dv.setUint32(o + 4, n, true);
        let at = o + 8;
        if (sz > 4) {
          dv.setUint32(o + 8, extraPos + base, true);
          at = extraPos;
          extraPos += sz + (sz & 1);
        }
        writeValues(dv, buf, at, ee);
      });
      const nextOff = ifd.next ? offsets.get(ifd.next) ?? 0 : 0;
      dv.setUint32(start + 2 + entries.length * 12, nextOff, true);
    }
    return { bytes: buf, offsets };
  }
}

function writeValues(dv: DataView, buf: Uint8Array, at: number, e: Entry) {
  const v = e.values;
  if (typeof v === "string") {
    for (let i = 0; i < v.length; i++) buf[at + i] = v.charCodeAt(i) & 0x7f;
    buf[at + v.length] = 0;
    return;
  }
  if (v instanceof Uint8Array) { buf.set(v, at); return; }
  for (let i = 0; i < v.length; i++) {
    switch (e.type) {
      case T.BYTE: case T.UNDEFINED: dv.setUint8(at + i, v[i]); break;
      case T.SHORT: dv.setUint16(at + i * 2, v[i], true); break;
      case T.LONG: dv.setUint32(at + i * 4, v[i], true); break;
      case T.RATIONAL: dv.setUint32(at + i * 4, v[i] >>> 0, true); break;
      case T.SRATIONAL: dv.setInt32(at + i * 4, v[i] | 0, true); break;
      case T.FLOAT: dv.setFloat32(at + i * 4, v[i], true); break;
    }
  }
}

export function tiffHeader(firstIfd: number): Uint8Array {
  const h = new Uint8Array(8);
  const dv = new DataView(h.buffer);
  h[0] = 0x49; h[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, firstIfd, true);
  return h;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
