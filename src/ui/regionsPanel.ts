/**
 * Regions tab: per-segment control of the technical rendering. Every region
 * detected by SegFormer (grouped into 11 photographic classes) can be adjusted
 * on its own; the renderer blends the adjustments by the refined, soft masks,
 * so there are no hard edges between regions. Values start at what the
 * decision engine chose for this photo (amber = automatic).
 */
import type { Params, SemanticAdjust } from "../decision/params.ts";
import { GROUPS, type Group } from "../neural/scene.ts";
import { t } from "./i18n.ts";

type Ctx = {
  params: () => Params | undefined;
  auto: () => Params | undefined;
  coverage: () => Record<string, number> | undefined;
  changed: () => void;
  /** Highlight a region on the photo (or undefined to stop). */
  highlight: (index: number | undefined) => void;
};

/** Same colours as the Regions overlay in the Depth tab. */
const COLORS: Record<Group, string> = {
  sky: "#5999ff", vegetation: "#33bf33", building: "#bf7349", ground: "#8c8c8c", terrain: "#997f40",
  water: "#1a59cc", person: "#ffbf99", vehicle: "#e63333", animal: "#e6991a", interior: "#994db3", other: "#4d4d4d",
};

interface Def { key: keyof SemanticAdjust; label: string; min: number; max: number; step: number; fmt: (v: number) => string }
const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
const mult = (v: number) => `×${v.toFixed(2)}`;
const DEFS: Array<Def | string> = [
  t("reg.light"),
  { key: "exposure", label: t("reg.exposure"), min: -2, max: 2, step: 0.05, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV` },
  { key: "highlights", label: t("reg.highlights"), min: 0, max: 1, step: 0.01, fmt: (v) => `−${Math.round(v * 100)}` },
  t("reg.colour"),
  { key: "warmth", label: t("reg.warmth"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "tint", label: t("reg.tint"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "saturation", label: t("reg.saturation"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "vibrance", label: t("reg.vibrance"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "hue", label: t("reg.hue"), min: -30, max: 30, step: 0.5, fmt: (v) => `${v.toFixed(1)}°` },
  t("reg.detail"),
  { key: "clarity", label: t("reg.clarity"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "texture", label: t("reg.texture"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "sharpen", label: t("reg.sharpen"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "denoise", label: t("reg.denoise"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "dehaze", label: t("reg.dehaze"), min: 0, max: 2, step: 0.01, fmt: mult },
];

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

export function createRegionsPanel(root: HTMLElement, ctx: Ctx) {
  let selected: Group = "sky";
  let showAll = false;
  let highlight = true;
  let visible = false;

  const chipsBox = el("div", { class: "chips" });
  const sliders = el("div");
  const hlToggle = el("input", { type: "checkbox" });
  hlToggle.checked = highlight;
  hlToggle.onchange = () => { highlight = hlToggle.checked; applyHighlight(); };
  const allToggle = el("input", { type: "checkbox" });
  allToggle.onchange = () => { showAll = allToggle.checked; render(); };
  const reset = el("button", { class: "btn small", text: t("reg.reset") });
  reset.onclick = () => {
    const p = ctx.params(), a = ctx.auto();
    if (!p || !a) return;
    p.semantic[selected] = structuredClone(a.semantic[selected]);
    ctx.changed();
    render();
  };
  const resetAll = el("button", { class: "btn small", text: t("reg.resetAll") });
  resetAll.onclick = () => {
    const p = ctx.params(), a = ctx.auto();
    if (!p || !a) return;
    p.semantic = structuredClone(a.semantic);
    ctx.changed();
    render();
  };

  root.replaceChildren(
    el("p", { class: "muted", text: t("reg.hint") }),
    chipsBox,
    el("label", { class: "toggle" }, t("reg.highlight"), hlToggle),
    el("label", { class: "toggle" }, t("reg.showAll"), allToggle),
    sliders,
    el("div", { class: "actions" }, reset, resetAll),
  );

  function applyHighlight() {
    ctx.highlight(visible && highlight ? GROUPS.indexOf(selected) : undefined);
  }

  function render() {
    const p = ctx.params();
    const cov = ctx.coverage() ?? {};
    const groups = GROUPS.filter((g) => showAll || (cov[g] ?? 0) >= 0.5);
    if (!groups.includes(selected) && groups.length) selected = [...groups].sort((a, b) => (cov[b] ?? 0) - (cov[a] ?? 0))[0];
    chipsBox.replaceChildren(...groups.map((g) => {
      const dot = el("i", { class: "hue-dot" });
      dot.style.background = COLORS[g];
      const b = el("button", { class: "chip" + (g === selected ? " on" : "") }, dot, `${t(`group.${g}`)} ${cov[g] !== undefined ? Math.round(cov[g]) + "%" : ""}`);
      b.onclick = () => { selected = g; render(); applyHighlight(); };
      return b;
    }));
    if (!p) { sliders.replaceChildren(); return; }
    const auto = ctx.auto()?.semantic[selected];
    const cur = p.semantic[selected];
    sliders.replaceChildren(...DEFS.map((d) => {
      if (typeof d === "string") return el("div", { class: "group-title", text: d });
      const input = el("input", { type: "range", min: String(d.min), max: String(d.max), step: String(d.step) });
      const out = el("output");
      const show = () => {
        const v = (p.semantic[selected][d.key] as number) ?? 0;
        input.value = String(v);
        out.textContent = d.fmt(v);
        out.classList.toggle("auto", auto !== undefined && Math.abs(((auto[d.key] as number) ?? 0) - v) < 1e-6);
      };
      input.oninput = () => {
        (p.semantic[selected] as unknown as Record<string, number>)[d.key] = +input.value;
        show();
        ctx.changed();
      };
      const label = el("label", { text: d.label });
      label.addEventListener("dblclick", () => {
        if (!auto) return;
        (p.semantic[selected] as unknown as Record<string, number>)[d.key] = (auto[d.key] as number) ?? 0;
        show();
        ctx.changed();
      });
      show();
      return el("div", { class: "row" }, label, input, out);
    }));
    void cur;
  }

  return {
    render,
    setVisible(v: boolean) { visible = v; applyHighlight(); if (v) render(); },
  };
}
