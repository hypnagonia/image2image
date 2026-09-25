/**
 * Tone-range curve sliders (L, R, G, B) for one set of curves — the photo's
 * own (Adjust) or one region's (Regions). One slider per tone range instead
 * of dragging points: black level, shadows, darks, midtones, lights,
 * highlights, white level. They are a view of the point curves
 * (curves.ts: bandsFromCurve / curveFromBands), so curves set elsewhere (an
 * older edit, an Ask-AI answer) show up here; the small curve is a preview.
 */
import type { CurvePoint, Curves } from "../decision/params.ts";
import { bandsFromCurve, curveFromBands, isFlat, type CurveBands } from "../render/curves.ts";
import { CurveEditor } from "./curveEditor.ts";
import { t } from "./i18n.ts";

type Chan = "l" | "r" | "g" | "b";
const CHANS: Chan[] = ["l", "r", "g", "b"];
const COLOURS = { l: "#ece9e3", r: "#ff6b6b", g: "#6bdc7a", b: "#6b9bff" } as const;
export const FLAT: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
export const flatCurves = (): Curves => ({ l: [...FLAT], r: [...FLAT], g: [...FLAT], b: [...FLAT] });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

export interface ToneCurvesOptions {
  /** The curves being edited (undefined = unchanged / no photo). */
  get: () => Curves | undefined;
  /** Stores edited curves (all four channels). */
  set: (c: Curves) => void;
  /** Identity of what is edited (e.g. the region), so remembered slider values never leak between targets. */
  key: () => string;
  changed: () => void;
  /** Whether there is anything to edit (a photo is open). */
  enabled: () => boolean;
}

export function createToneCurves(o: ToneCurvesOptions) {
  let chan: Chan = "l";
  const preview = new CurveEditor(150);
  preview.el.style.pointerEvents = "none";
  const chips = el("div", { class: "chips" });
  // The slider values last set, per target and channel, while the curve is still
  // the one they made: a curve cannot hold contradictory settings (it is never
  // inverted), and reading them back from it would make one slider move another.
  const memo = new Map<string, { key: string; bands: CurveBands }>();
  const cur = (): Curves => o.get() ?? flatCurves();
  const bandsOf = (c: Chan): CurveBands => {
    const pts = cur()[c] ?? FLAT;
    const m = memo.get(o.key() + "|" + c);
    return m && m.key === JSON.stringify(pts) ? structuredClone(m.bands) : bandsFromCurve(pts);
  };
  const store = (c: Chan, b: CurveBands) => {
    const pts = curveFromBands(b);
    o.set({ ...cur(), [c]: pts });
    memo.set(o.key() + "|" + c, { key: JSON.stringify(pts), bands: structuredClone(b) });
  };

  const rows: Array<{ input: HTMLInputElement; out: HTMLOutputElement; get: (b: CurveBands) => number }> = [];
  function row(label: string, min: number, max: number, get: (b: CurveBands) => number, put: (b: CurveBands, v: number) => void): HTMLElement {
    const input = el("input", { type: "range", min: String(min), max: String(max), step: "0.01" });
    const out = el("output");
    const r = el("div", { class: "row" }, el("label", { text: label }), input, out);
    input.oninput = () => {
      if (!o.enabled()) return;
      const b = bandsOf(chan);
      put(b, parseFloat(input.value));
      store(chan, b);
      render();
      o.changed();
    };
    // Double-tap the label: this range back to unchanged.
    r.querySelector("label")!.addEventListener("dblclick", () => {
      if (!o.enabled()) return;
      const b = bandsOf(chan);
      put(b, 0);
      store(chan, b);
      render();
      o.changed();
    });
    rows.push({ input, out, get });
    return r;
  }
  const sliders = el("div", {},
    row(t("curve.blackLevel"), 0, 1, (b) => b.black, (b, v) => { b.black = v; }),
    ...[t("curve.shadows"), t("curve.darks"), t("curve.midtones"), t("curve.lights"), t("curve.highlights")].map((label, i) =>
      row(label, -1, 1, (b) => b.bands[i], (b, v) => { b.bands[i] = v; })),
    row(t("curve.whiteLevel"), -1, 0, (b) => b.white, (b, v) => { b.white = v; }),
  );
  const reset = el("button", { class: "btn small", text: t("adj.curvesReset") });
  reset.onclick = () => {
    if (!o.enabled()) return;
    o.set(flatCurves());
    render();
    o.changed();
  };

  function render() {
    const c = cur();
    chips.replaceChildren(...CHANS.map((k) => {
      const changed = !isFlat(c[k] ?? FLAT);
      const b = el("button", { class: "chip" + (k === chan ? " on" : ""), text: t(`chip.${k === "l" ? "master" : k}`) + (changed ? " •" : "") });
      b.onclick = () => { chan = k; render(); };
      return b;
    }));
    const pts = c[chan] ?? FLAT;
    preview.set(pts.map((q) => [q.x, q.y] as [number, number]), COLOURS[chan]);
    const b = bandsOf(chan);
    for (const r of rows) {
      const v = r.get(b);
      r.input.value = String(v);
      r.out.textContent = `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
      r.out.classList.toggle("auto", Math.abs(v) < 1e-3);
    }
  }

  const root = el("div", {}, chips, sliders, el("div", { class: "curve-wrap" }, preview.el), el("div", { class: "actions" }, reset));
  render();
  return { el: root, render };
}
