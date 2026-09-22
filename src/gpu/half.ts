/** float32 ⇄ float16 conversion for texture uploads/readbacks. */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >>> shift;
    if ((mant >>> (shift - 1)) & 1) h++;
    return sign | h;
  }
  let h = sign | (exp << 10) | (mant >>> 13);
  if (mant & 0x1000) h++; // round half up (ties are rare enough for image data)
  return h;
}

const TABLE = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f, m = h & 0x3ff;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();

export function halfToFloat(h: number): number {
  return TABLE[h & 0xffff];
}

export function halvesToFloats(src: Uint16Array, dst = new Float32Array(src.length)): Float32Array {
  for (let i = 0; i < src.length; i++) dst[i] = TABLE[src[i]];
  return dst;
}

export function floatsToHalves(src: ArrayLike<number>, dst: Uint16Array<ArrayBuffer> = new Uint16Array(src.length)): Uint16Array<ArrayBuffer> {
  for (let i = 0; i < src.length; i++) dst[i] = toHalf(src[i]);
  return dst;
}
