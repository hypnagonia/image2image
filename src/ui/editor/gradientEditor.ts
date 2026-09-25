/**
 * Gradient editor (Photopea's, made for fingers):
 *   presets   a strip of palettes (Teal & Gold, …): one tap applies
 *   bar       the gradient over a checkerboard; tap it to add a colour stop there
 *   stops     handles under the bar: tap selects, drag moves, drag down off the bar removes
 *   stop      the selected stop's colour (the system colour picker), hex, opacity, location
 */
import { GRADIENT_PRESETS, gradientAt, gradientCss, gradientFrom, rgbToHex, type Gradient } from "../../layers/gradient.ts";
import { t } from "../i18n.ts";
import { icon } from "./icons.ts";
import { el } from "../dom.ts";

type Target = { gradient: Gradient; reverse: boolean; preset?: string };


/**
 * `changed(label?)`: the gradient was edited (a label = a finished step, e.g. a preset).
 * `slider` builds the app's standard slider row.
 */
export function createGradientEditor(target: () => Target, changed: (label?: string) => void,
  slider: (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, def: number) => HTMLElement): HTMLElement {
  const root = el("div", { class: "grad" });
  let selected = 0;

  // ---- presets
  const presets = el("div", { class: "grad-presets" });
  for (const p of GRADIENT_PRESETS) {
    const g = gradientFrom(p.colors);
    const b = el("button", { class: "grad-preset", title: t(`grad.p.${p.id}` as never) },
      el("span", { class: "grad-swatch" }), el("span", { class: "grad-pname", text: t(`grad.p.${p.id}` as never) }));
    (b.firstChild as HTMLElement).style.background = gradientCss(g);
    b.onclick = () => {
      const tg = target();
      tg.gradient = g; tg.preset = p.id; selected = 0;
      changed(t("grad.applied", { name: t(`grad.p.${p.id}` as never) }));
      render();
    };
    presets.append(b);
  }

  // ---- bar + stops
  const bar = el("div", { class: "grad-bar" }, el("div", { class: "grad-fill" }));
  const stopsRow = el("div", { class: "grad-stops" });
  const stopBody = el("div", { class: "grad-stop" });
  const reverseBtn = el("button", { class: "chip", text: t("grad.reverse") });
  reverseBtn.onclick = () => { const tg = target(); tg.reverse = !tg.reverse; changed(t("grad.reverse")); render(); };
  const head = el("div", { class: "grad-head" }, el("div", { class: "group-title", text: t("grad.gradient") }), reverseBtn);

  const posOf = (clientX: number) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (clientX - r.left) / r.width)); };
  const shown = (pos: number) => (target().reverse ? 1 - pos : pos);

  // Tap the bar: a new stop with the colour already there.
  bar.addEventListener("click", (e) => {
    const tg = target();
    const x = shown(posOf(e.clientX));
    const [r, g, b, a] = gradientAt(tg.gradient, x);
    tg.gradient.stops.push({ pos: x, color: rgbToHex(r, g, b), alpha: Math.round(a * 100) / 100 });
    tg.preset = undefined;
    selected = tg.gradient.stops.length - 1;
    changed(t("grad.addStop"));
    render();
  });

  function renderStops() {
    const tg = target();
    (bar.firstChild as HTMLElement).style.background = gradientCss(tg.gradient, tg.reverse);
    stopsRow.replaceChildren(...tg.gradient.stops.map((s, i) => {
      const h = el("div", { class: "grad-handle" + (i === selected ? " on" : ""), role: "button", "aria-label": `${t("grad.stop")} ${i + 1}` }, el("i"));
      h.style.left = `${shown(s.pos) * 100}%`;
      (h.firstChild as HTMLElement).style.background = s.color;
      let drag: { id: number; y0: number; moved: boolean } | undefined;
      h.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        drag = { id: e.pointerId, y0: e.clientY, moved: false };
        h.setPointerCapture(e.pointerId);
        if (selected !== i) { selected = i; renderStops(); renderStop(); }
      });
      h.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        drag.moved = true;
        const off = e.clientY - drag.y0 > 44 && tg.gradient.stops.length > 2;
        h.classList.toggle("remove", off);
        s.pos = shown(posOf(e.clientX));
        h.style.left = `${shown(s.pos) * 100}%`;
        (bar.firstChild as HTMLElement).style.background = gradientCss(tg.gradient, tg.reverse);
        tg.preset = undefined;
        changed();
      });
      const end = (e: PointerEvent) => {
        if (!drag || e.pointerId !== drag.id) return;
        const removed = h.classList.contains("remove");
        const moved = drag.moved;
        drag = undefined;
        if (removed) { tg.gradient.stops.splice(i, 1); selected = Math.max(0, i - 1); changed(t("grad.removeStop")); render(); }
        else if (moved) { changed(t("grad.moveStop")); renderStop(); }
      };
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
      return h;
    }));
  }

  function renderStop() {
    const tg = target();
    const s = tg.gradient.stops[selected];
    if (!s) { stopBody.replaceChildren(); return; }
    const color = el("input", { type: "color", class: "grad-color", value: s.color.toLowerCase(), "aria-label": t("grad.color") });
    const hex = el("input", { class: "text grad-hex", value: s.color.toUpperCase(), maxlength: "7", spellcheck: "false", "aria-label": "Hex" });
    color.oninput = () => { s.color = color.value.toUpperCase(); hex.value = s.color; tg.preset = undefined; renderStops(); changed(); };
    color.onchange = () => changed(t("grad.color"));
    hex.onchange = () => {
      const v = hex.value.trim().replace(/^#?/, "#").toUpperCase();
      if (/^#[0-9A-F]{6}$/.test(v)) { s.color = v; color.value = v.toLowerCase(); tg.preset = undefined; renderStops(); changed(t("grad.color")); }
      else hex.value = s.color;
    };
    const del = el("button", { class: "btn small icon ghost", title: t("grad.removeStop"), "aria-label": t("grad.removeStop") }, icon("trash", 18));
    del.disabled = tg.gradient.stops.length <= 2;
    del.onclick = () => { tg.gradient.stops.splice(selected, 1); selected = Math.max(0, selected - 1); changed(t("grad.removeStop")); render(); };
    stopBody.replaceChildren(
      el("div", { class: "grad-stoprow" }, el("label", { class: "grad-colorwrap" }, color), hex, el("span", { class: "grad-spacer" }), del),
      slider(t("grad.opacity"), 0, 1, 0.01, () => s.alpha, (v) => { s.alpha = v; tg.preset = undefined; renderStops(); }, (v) => `${Math.round(v * 100)}%`, 1),
      slider(t("grad.location"), 0, 1, 0.005, () => s.pos, (v) => { s.pos = v; tg.preset = undefined; renderStops(); }, (v) => `${Math.round(v * 100)}%`, s.pos),
    );
  }

  function render() {
    const tg = target();
    selected = Math.min(selected, tg.gradient.stops.length - 1);
    reverseBtn.classList.toggle("on", tg.reverse);
    for (const [i, b] of [...presets.children].entries()) b.classList.toggle("on", GRADIENT_PRESETS[i].id === tg.preset);
    renderStops();
    renderStop();
  }

  root.append(el("div", { class: "group-title", text: t("grad.presets") }), presets, head, bar, stopsRow,
    el("div", { class: "muted grad-hint", text: t("grad.hint") }), stopBody);
  render();
  requestAnimationFrame(() => presets.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" }));
  return root;
}
