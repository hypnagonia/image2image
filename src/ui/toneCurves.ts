/**
 * Curves (L, R, G, B) for one set of curves — the photo's own (Adjust), one
 * region's or skin's (Regions), or one distance band's (Depth). A big curve
 * window: tap to add a point, drag to move, drag a point out of the box to
 * remove it. Behind the curve: what it acts on (the intensity histogram of
 * the rendered photo, region or band) and intensity ramps along both axes.
 */
import type { CurvePoint, Curves } from "../decision/params.ts";
import { isFlat } from "../render/curves.ts";
import { CurveEditor } from "./curveEditor.ts";
import { t } from "./i18n.ts";
import { el } from "./dom.ts";

export type Chan = "l" | "r" | "g" | "b";
const CHANS: Chan[] = ["l", "r", "g", "b"];
const COLOURS = { l: "#ece9e3", r: "#ff6b6b", g: "#6bdc7a", b: "#6b9bff" } as const;
export const FLAT: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
export const flatCurves = (): Curves => ({ l: [...FLAT], r: [...FLAT], g: [...FLAT], b: [...FLAT] });


export interface ToneCurvesOptions {
  /** The curves being edited (undefined = unchanged / no photo). */
  get: () => Curves | undefined;
  /** Stores edited curves (all four channels). */
  set: (c: Curves) => void;
  changed: () => void;
  /** Whether there is anything to edit (a photo is open). */
  enabled: () => boolean;
  /** Histogram of what these curves act on, per channel (drawn behind the curve). */
  histogram?: (chan: Chan) => ArrayLike<number> | undefined;
}

export function createToneCurves(o: ToneCurvesOptions) {
  let chan: Chan = "l";
  const editor = new CurveEditor(420, true);
  const chips = el("div", { class: "chips" });
  const cur = (): Curves => o.get() ?? flatCurves();

  editor.onChange = (pts) => {
    if (!o.enabled()) return;
    o.set({ ...cur(), [chan]: pts.map(([x, y]) => ({ x, y })) });
    renderChips();
    o.changed();
  };
  const reset = el("button", { class: "btn small", text: t("adj.curvesReset") });
  reset.onclick = () => {
    if (!o.enabled()) return;
    o.set(flatCurves());
    render();
    o.changed();
  };

  function renderChips() {
    const c = cur();
    chips.replaceChildren(...CHANS.map((k) => {
      const changed = !isFlat(c[k] ?? FLAT);
      const b = el("button", { class: "chip" + (k === chan ? " on" : ""), text: t(`chip.${k === "l" ? "master" : k}`) + (changed ? " •" : "") });
      b.onclick = () => { chan = k; render(); };
      return b;
    }));
  }
  function render() {
    renderChips();
    const pts = cur()[chan] ?? FLAT;
    editor.set(pts.map((q) => [q.x, q.y] as [number, number]), COLOURS[chan]);
    editor.setHistogram(o.histogram?.(chan));
  }
  /** New histograms only: redraw behind the curve without touching the points (safe mid-drag). */
  function refreshHistogram() { editor.setHistogram(o.histogram?.(chan)); }

  const root = el("div", {}, chips, el("div", { class: "curve-wrap" }, editor.el), el("div", { class: "actions" }, reset));
  render();
  return { el: root, render, refreshHistogram };
}
