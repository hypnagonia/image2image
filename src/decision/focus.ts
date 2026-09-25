/**
 * Automatic focus and depth-of-field justification.
 *
 * Inputs are the refined distance map (guide resolution, 0 = near … 1 = far)
 * and the semantic probabilities. The subject is chosen as a whole *object*,
 * the way a photographer reads a frame, not as the best-scoring pixel:
 *
 *   1. candidates   connected regions of people, animals, vehicles and
 *                   buildings (segmentation), plus anything else that clearly
 *                   stands in front of its surroundings (depth: nearer than
 *                   the local background by a margin, not sky)
 *   2. score        class (person > animal ≫ vehicle > building > other object)
 *                   × size (a subject is neither a speck nor the whole frame)
 *                   × composition of its centre (frame centre, rule-of-thirds
 *                   points) × framing (cut by the frame edges = background or
 *                   foreground clutter; people may be cut at the bottom)
 *                   × separation from what is behind it × a little nearness
 *   3. focus point  a person or animal: the top of the region (head / face);
 *                   anything else: its own pixel nearest its centre. Focus
 *                   distance: the median of the upper half of a person (faces
 *                   sharp), the 30th percentile of an object's distances (its
 *                   near surface, not background seen through gaps)
 *
 * If there is no candidate at all, the per-pixel score of earlier versions is
 * used (separation × nearness × composition × semantic), box-smoothed.
 * Blur is justified only when enough of the frame lies clearly behind the
 * focus distance.
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
  /** What the subject is, when it was found as an object. */
  kind?: "person" | "animal" | "vehicle" | "building" | "object";
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function autoFocus(
  dist: { w: number; h: number; data: Float32Array },
  seg: { width: number; height: number; probs: Float32Array },
): AutoFocus {
  const { w, h, data } = dist;
  const plane = seg.width * seg.height;
  const gi = (name: (typeof GROUPS)[number]) => GROUPS.indexOf(name) * plane;
  const P = { person: gi("person"), animal: gi("animal"), vehicle: gi("vehicle"), sky: gi("sky"), other: gi("other"), interior: gi("interior"), building: gi("building") };
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
  const skyMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (segAt(x, y, P.sky) > 0.5) skyMask[y * w + x] = 1;

  const obj = findSubject(w, h, data, localMax, skyMask, segAt, P, thirds);
  let bx: number, by: number, focus: number;
  let living: boolean;
  let what: string;
  if (obj) {
    ({ x: bx, y: by, focus } = obj);
    living = obj.kind === "person" || obj.kind === "animal";
    what = `${obj.kind} (${(obj.area * 100).toFixed(1)}% of the frame)`;
  } else {
    ({ bx, by, focus } = pixelSubject(w, h, data, localMax, segAt, P, thirds, peopleFirst));
    living = peopleFirst;
    what = "strongest depth/composition point";
  }

  // Justification: how much of the (non-sky) frame is clearly behind the subject,
  // and whether the subject itself is a sensible size.
  // Distance is linear in disparity, so a very near object squeezes a person and
  // the room behind them close to 1; with a person as subject, "clearly behind"
  // is judged against the depth range left behind them.
  const margin = living ? Math.max(0.05, 0.25 * (1 - focus)) : 0.25;
  const farLimit = living ? 0.92 : 0.6;
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
  const reason = `subject: ${what} at (${((bx + 0.5) / w).toFixed(2)}, ${((by + 0.5) / h).toFixed(2)}) — ` + (justified
    ? `subject at distance ${focus.toFixed(2)} (${(subjectFrac * 100).toFixed(0)}% of the frame) with ${(behindFrac * 100).toFixed(0)}% of the frame clearly behind it`
    : focus >= farLimit
      ? `the likely subject is itself far away (${focus.toFixed(2)}) — nothing to separate`
      : behindFrac <= 0.3
        ? `only ${(behindFrac * 100).toFixed(0)}% of the frame lies clearly behind the subject — not enough depth separation`
        : `subject covers ${(subjectFrac * 100).toFixed(0)}% of the frame — not a separable subject`);
  return { focus: Math.round(focus * 1000) / 1000, x: (bx + 0.5) / w, y: (by + 0.5) / h, justified, strength: Math.round(strength * 100) / 100, reason, kind: obj?.kind };
}

type SegAt = (x: number, y: number, off: number) => number;
type Planes = { person: number; animal: number; vehicle: number; sky: number; other: number; interior: number; building: number };
type Kind = "person" | "animal" | "vehicle" | "building" | "object";

/** How likely each kind of region is to be what the photograph is about. */
const PRIOR: Record<Kind, number> = { person: 1, animal: 0.9, vehicle: 0.5, building: 0.4, object: 0.35 };
const KINDS: Kind[] = ["person", "animal", "vehicle", "building", "object"];

/** Centre and rule-of-thirds attraction of a point (0.25 … ~1.1). */
function composition(u: number, v: number, thirds: number[][]): number {
  const centre = Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / (2 * 0.2 * 0.2));
  let third = 0;
  for (const [tx, ty] of thirds) third = Math.max(third, Math.exp(-((u - tx) ** 2 + (v - ty) ** 2) / (2 * 0.1 * 0.1)));
  return 0.25 + Math.max(centre, 0.85 * third);
}

export interface Subject { kind: Kind; x: number; y: number; focus: number; area: number; score: number }

/**
 * Candidate objects → the one the photograph is about (see the header).
 * Exported for tests.
 */
export function findSubject(
  w: number, h: number, data: Float32Array, localMax: Float32Array, skyMask: Uint8Array,
  segAt: SegAt, P: Planes, thirds: number[][],
): Subject | undefined {
  const n = w * h;
  // 1. label every pixel with the kind of candidate it belongs to (0 = none)
  const kind = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (skyMask[i]) continue;
    const pe = segAt(x, y, P.person), an = segAt(x, y, P.animal);
    if (pe + an > 0.5) { kind[i] = pe >= an ? 1 : 2; continue; }
    if (segAt(x, y, P.vehicle) > 0.5) { kind[i] = 3; continue; }
    if (segAt(x, y, P.building) > 0.5) { kind[i] = 4; continue; }
    // Anything else counts when it clearly stands in front of its surroundings.
    if (localMax[i] - data[i] > 0.12 && data[i] < 0.75) kind[i] = 5;
  }
  // 2. connected regions (4-neighbour) of one kind, scored as a whole
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let best: Subject | undefined;
  let bestPix: number[] = [];
  const minArea = Math.max(4, Math.round(n * 0.002));
  for (let s0 = 0; s0 < n; s0++) {
    if (!kind[s0] || comp[s0] >= 0) continue;
    const k = kind[s0];
    let sp = 0;
    stack[sp++] = s0;
    comp[s0] = s0;
    const pix: number[] = [];
    let sx = 0, sy = 0, sd = 0, ssep = 0, left = false, right = false, top = false, bottom = false;
    while (sp) {
      const i = stack[--sp];
      pix.push(i);
      const x = i % w, y = (i - x) / w;
      sx += x; sy += y; sd += data[i]; ssep += Math.max(0, localMax[i] - data[i]);
      if (x === 0) left = true;
      if (x === w - 1) right = true;
      if (y === 0) top = true;
      if (y === h - 1) bottom = true;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && comp[j] < 0 && kind[j] === k) { comp[j] = s0; stack[sp++] = j; }
    }
    if (pix.length < minArea) continue;
    const kd = KINDS[k - 1];
    const livingK = kd === "person" || kd === "animal";
    const area = pix.length / n;
    const u = (sx / pix.length + 0.5) / w, v = (sy / pix.length + 0.5) / h;
    // A subject is neither a speck nor the whole frame; buildings may be large.
    const size = clamp((area - 0.002) / 0.013, 0, 1) * (1 - (kd === "building" ? 0.5 : 0.7) * clamp((area - 0.4) / 0.45, 0, 1));
    // Regions cut by the frame are background or foreground clutter. People are
    // routinely cut at the bottom (half-length portraits), so that side is free.
    const cuts = (left ? 1 : 0) + (right ? 1 : 0) + (top ? 1 : 0) + (bottom && !livingK ? 1 : 0);
    let framing = [1, 0.8, 0.45, 0.25, 0.15][cuts];
    // Something small that sits on the bottom edge is foreground (grass, a railing).
    if (bottom && !livingK && area < 0.15) framing *= 0.5;
    const sepF = 0.6 + 0.8 * Math.min(1, (ssep / pix.length) * 4);
    const nearF = 0.75 + 0.25 * (1 - sd / pix.length);
    const score = PRIOR[kd] * size * composition(u, v, thirds) * framing * sepF * nearF;
    if (!best || score > best.score) {
      best = { kind: kd, x: 0, y: 0, focus: 0, area, score };
      bestPix = pix;
    }
  }
  if (!best || best.score <= 0) return undefined;
  // 3. focus point and distance
  const pix = bestPix;
  if (best.kind === "person" || best.kind === "animal") {
    // The head: the top 30% of the region's rows; focus on the upper half's median distance.
    let y0 = h, y1 = 0;
    for (const i of pix) { const y = Math.floor(i / w); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const lim = y0 + Math.max(1, Math.round((y1 - y0) * 0.3));
    let hx = 0, hy = 0, hn = 0;
    const upper: number[] = [];
    const mid = (y0 + y1) / 2;
    for (const i of pix) {
      const x = i % w, y = (i - x) / w;
      if (y <= lim) { hx += x; hy += y; hn++; }
      if (y <= mid) upper.push(data[i]);
    }
    upper.sort((a, b) => a - b);
    best.x = Math.round(hx / hn);
    best.y = Math.round(hy / hn);
    best.focus = upper[Math.floor(upper.length / 2)];
  } else {
    let cx = 0, cy = 0;
    for (const i of pix) { cx += i % w; cy += Math.floor(i / w); }
    cx /= pix.length; cy /= pix.length;
    // The region's own pixel nearest its centre (the centre of an L or a ring is outside it).
    let bi = pix[0], bd = Infinity;
    for (const i of pix) { const d = (i % w - cx) ** 2 + (Math.floor(i / w) - cy) ** 2; if (d < bd) { bd = d; bi = i; } }
    best.x = bi % w;
    best.y = Math.floor(bi / w);
    const ds = pix.map((i) => data[i]).sort((a, b) => a - b);
    best.focus = ds[Math.floor(ds.length * 0.3)];
  }
  return best;
}

/** The earlier per-pixel subject score, for frames without any candidate object. */
function pixelSubject(
  w: number, h: number, data: Float32Array, localMax: Float32Array,
  segAt: SegAt, P: Planes, thirds: number[][], peopleFirst: boolean,
): { bx: number; by: number; focus: number } {
  const score = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      const i = y * w + x;
      const sky = segAt(x, y, P.sky);
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
  return { bx, by, focus: vals[Math.floor(vals.length * 0.3)] ?? 0.3 };
}
