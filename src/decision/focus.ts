/**
 * Automatic focus and depth-of-field justification.
 *
 * Inputs are the refined distance map (guide resolution, 0 = near … 1 = far)
 * and the semantic probabilities. The subject is where nearness, composition
 * and subject-like classes agree:
 *
 *   score = separation × (0.3 + nearness) × composition(x, y) × semantic(x, y)
 *
 *   separation   how much farther the surroundings are than this pixel (local
 *                maximum distance within ~8% of the frame minus own distance):
 *                a subject stands in front of its background; mere nearness
 *                would pick grass at the bottom edge
 *
 *   composition  a wide bell on the frame centre plus tighter bells on the four
 *                rule-of-thirds points, with a small floor everywhere else —
 *                without it the nearest thing (a railing, grass at the bottom
 *                edge) would always win
 *   semantic     people/animals ≫ vehicles > other objects; sky never. When a
 *                person or animal covers > 1.5% of the frame, only they compete
 *
 * The score map is box-smoothed so a single noisy pixel cannot win, the focus
 * distance is the 30th percentile of distance around the best location (the
 * subject's near surface, not background seen through gaps) — for a person, the
 * median of the upper half of their own pixels (faces sharp) — and blur is
 * justified only when enough of the frame lies clearly behind that distance.
 */
import { GROUPS } from "../neural/scene.ts";

export interface AutoFocus {
  /** Focus distance (0 near … 1 far) and where the subject is (0..1). */
  focus: number;
  x: number;
  y: number;
  justified: boolean;
  /** Suggested blur strength when justified. */
  strength: number;
  reason: string;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function autoFocus(
  dist: { w: number; h: number; data: Float32Array },
  seg: { width: number; height: number; probs: Float32Array },
): AutoFocus {
  const { w, h, data } = dist;
  const plane = seg.width * seg.height;
  const gi = (name: (typeof GROUPS)[number]) => GROUPS.indexOf(name) * plane;
  const P = { person: gi("person"), animal: gi("animal"), vehicle: gi("vehicle"), sky: gi("sky"), other: gi("other"), interior: gi("interior") };
  const segAt = (x: number, y: number, off: number) => {
    const sx = Math.min(seg.width - 1, Math.floor((x / w) * seg.width));
    const sy = Math.min(seg.height - 1, Math.floor((y / h) * seg.height));
    return seg.probs[off + sy * seg.width + sx];
  };
  // A clearly visible person or animal is the subject, whatever is nearer: a
  // blurred armrest or railing in front of the camera must not steal focus.
  let livingCells = 0;
  for (let i = 0; i < plane; i++) if (seg.probs[P.person + i] + seg.probs[P.animal + i] > 0.5) livingCells++;
  const peopleFirst = livingCells / plane > 0.015;
  const thirds = [[1 / 3, 1 / 3], [2 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 2 / 3]];
  // Local background distance: separable running maximum of distance.
  const R = Math.max(3, Math.round(Math.max(w, h) * 0.08));
  const mx1 = new Float32Array(w * h), localMax = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - R); k <= Math.min(w - 1, x + R); k += 2) m = Math.max(m, data[y * w + k]);
    mx1[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0;
    for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R); k += 2) m = Math.max(m, mx1[k * w + x]);
    localMax[y * w + x] = m;
  }
  const score = new Float32Array(w * h);
  const skyMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      const i = y * w + x;
      const sky = segAt(x, y, P.sky);
      if (sky > 0.5) skyMask[i] = 1;
      const dc = (u - 0.5) ** 2 + (v - 0.5) ** 2;
      let comp = 0.04 + Math.exp(-dc / (2 * 0.3 * 0.3));
      for (const [tx, ty] of thirds) comp += 0.6 * Math.exp(-((u - tx) ** 2 + (v - ty) ** 2) / (2 * 0.16 * 0.16));
      // The bottom edge is usually foreground clutter, not the subject.
      comp *= 0.2 + 0.8 * clamp((1 - v) / 0.2, 0, 1);
      const living = segAt(x, y, P.person) + segAt(x, y, P.animal);
      const sem = peopleFirst ? (living > 0.5 ? 1 + 3 * living : 0.02) : Math.max(0.02, 1 + 3 * living + 1.2 * segAt(x, y, P.vehicle) + 0.4 * (segAt(x, y, P.other) + segAt(x, y, P.interior)) - 1.5 * sky);
      const near = 1 - clamp(data[i], 0, 1);
      const sep = Math.max(0, localMax[i] - data[i]);
      score[i] = sep * (0.3 + near) * comp * sem;
    }
  }
  // Box-smooth (radius ≈ 3% of the long edge) so a single pixel cannot win.
  const r = Math.max(2, Math.round(Math.max(w, h) * 0.03));
  const tmp = new Float32Array(w * h), sm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w && x + r >= 0) acc += score[y * w + x + r];
      if (x - r - 1 >= 0 && x - r - 1 < w) acc -= score[y * w + x - r - 1];
      if (x >= 0 && x < w) tmp[y * w + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h && y + r >= 0) acc += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0 && y - r - 1 < h) acc -= tmp[(y - r - 1) * w + x];
      if (y >= 0 && y < h) sm[y * w + x] = acc;
    }
  }
  let best = 0;
  for (let i = 1; i < w * h; i++) if (sm[i] > sm[best]) best = i;
  const bx = best % w, by = Math.floor(best / w);
  const vals: number[] = [];
  const rr = Math.max(2, Math.round(r / 2));
  for (let y = Math.max(0, by - rr); y <= Math.min(h - 1, by + rr); y++)
    for (let x = Math.max(0, bx - rr); x <= Math.min(w - 1, bx + rr); x++) vals.push(data[y * w + x]);
  vals.sort((a, b) => a - b);
  // The near part of the neighbourhood: the subject's surface, not the gaps behind it.
  let focus = vals[Math.floor(vals.length * 0.3)] ?? 0.3;
  if (peopleFirst) {
    // A person: their own pixels only (not the armrest in front of them), and the
    // upper half of them near the subject point — faces are what must be sharp.
    const R2 = Math.round(Math.max(w, h) * 0.15);
    const pix: Array<[number, number]> = [];
    for (let y = Math.max(0, by - R2); y <= Math.min(h - 1, by + R2); y++)
      for (let x = Math.max(0, bx - R2); x <= Math.min(w - 1, bx + R2); x++)
        if (segAt(x, y, P.person) + segAt(x, y, P.animal) > 0.6) pix.push([y, data[y * w + x]]);
    if (pix.length > 20) {
      pix.sort((a, b) => a[0] - b[0]);
      const upper = pix.slice(0, Math.ceil(pix.length / 2)).map((p) => p[1]).sort((a, b) => a - b);
      focus = upper[Math.floor(upper.length / 2)];
    }
  }

  // Justification: how much of the (non-sky) frame is clearly behind the subject,
  // and whether the subject itself is a sensible size.
  // Distance is linear in disparity, so a very near object squeezes a person and
  // the room behind them close to 1; with a person as subject, "clearly behind"
  // is judged against the depth range left behind them.
  const margin = peopleFirst ? Math.max(0.05, 0.25 * (1 - focus)) : 0.25;
  const farLimit = peopleFirst ? 0.92 : 0.6;
  let behind = 0, subject = 0, counted = 0, farSum = 0;
  for (let i = 0; i < w * h; i++) {
    if (skyMask[i]) { behind++; farSum += 1; counted++; continue; }
    counted++;
    const d = data[i];
    if (d > focus + margin) { behind++; farSum += d; }
    if (Math.abs(d - focus) < Math.min(0.08, margin * 0.6)) subject++;
  }
  const behindFrac = behind / counted, subjectFrac = subject / counted;
  const bgDist = behind ? farSum / behind : focus;
  const justified = behindFrac > 0.3 && subjectFrac > 0.03 && subjectFrac < 0.6 && focus < farLimit;
  const strength = clamp(((bgDist - focus) / Math.max(margin * 4, 0.2)) * 1.1, 0.25, 0.65);
  const reason = justified
    ? `subject at distance ${focus.toFixed(2)} (${(subjectFrac * 100).toFixed(0)}% of the frame) with ${(behindFrac * 100).toFixed(0)}% of the frame clearly behind it`
    : focus >= farLimit
      ? `the likely subject is itself far away (${focus.toFixed(2)}) — nothing to separate`
      : behindFrac <= 0.3
        ? `only ${(behindFrac * 100).toFixed(0)}% of the frame lies clearly behind the subject — not enough depth separation`
        : `subject covers ${(subjectFrac * 100).toFixed(0)}% of the frame — not a separable subject`;
  return { focus: Math.round(focus * 1000) / 1000, x: (bx + 0.5) / w, y: (by + 0.5) / h, justified, strength: Math.round(strength * 100) / 100, reason };
}
