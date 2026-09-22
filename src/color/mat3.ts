/** Row-major 3×3 matrices and 3-vectors. Small, allocation-light helpers. */
export type Mat3 = readonly number[]; // length 9, row-major
export type Vec3 = readonly number[]; // length 3

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): number[] {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function mulVec(a: Mat3, v: Vec3): number[] {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

export function det(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function inverse(m: Mat3): number[] {
  const d = det(m);
  if (Math.abs(d) < 1e-12) throw new Error("singular matrix");
  const id = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * id,
    (m[2] * m[7] - m[1] * m[8]) * id,
    (m[1] * m[5] - m[2] * m[4]) * id,
    (m[5] * m[6] - m[3] * m[8]) * id,
    (m[0] * m[8] - m[2] * m[6]) * id,
    (m[2] * m[3] - m[0] * m[5]) * id,
    (m[3] * m[7] - m[4] * m[6]) * id,
    (m[1] * m[6] - m[0] * m[7]) * id,
    (m[0] * m[4] - m[1] * m[3]) * id,
  ];
}

export function diag(v: Vec3): number[] {
  return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
}

export function scale(m: Mat3, s: number): number[] {
  return m.map((x) => x * s);
}

export function lerp(a: Mat3, b: Mat3, t: number): number[] {
  return a.map((x, i) => x + (b[i] - x) * t);
}

export function isZero(m: readonly number[]): boolean {
  return m.every((x) => x === 0);
}

/** Pads a row-major 3×3 into the 12-float layout WGSL expects for mat3x3<f32>
 * (three column vec3s, each padded to 16 bytes). */
export function toWgsl(m: Mat3): Float32Array {
  const out = new Float32Array(12);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = m[r * 3 + c];
  return out;
}

export function fmt(m: Mat3, digits = 4): string {
  const f = (x: number) => x.toFixed(digits).padStart(digits + 4);
  return `[${f(m[0])} ${f(m[1])} ${f(m[2])} | ${f(m[3])} ${f(m[4])} ${f(m[5])} | ${f(m[6])} ${f(m[7])} ${f(m[8])}]`;
}
