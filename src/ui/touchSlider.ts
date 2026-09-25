/**
 * Sliders that answer to a touch anywhere on them (not only on the knob, as
 * iOS's native range input does): a tap sets the value where it lands, a
 * sideways drag follows the finger. A mostly vertical move is left to the page
 * (the panel scrolls, nothing changes), so scrolling past a slider never edits.
 *
 * One delegated listener serves every range input, present and future. Values
 * are written through the input and announced with the usual "input" and
 * "change" events, so the controls' own handlers do the rest.
 */
const SLOP = 6; // px of movement before a drag is read as sideways or vertical

function valueAt(input: HTMLInputElement, clientX: number): string {
  const r = input.getBoundingClientRect();
  const knob = 18; // the thumb's width (styles.css): its centre spans the track minus the knob
  const t = Math.min(1, Math.max(0, (clientX - r.left - knob / 2) / Math.max(1, r.width - knob)));
  const min = parseFloat(input.min || "0"), max = parseFloat(input.max || "100");
  const step = parseFloat(input.step) || 0;
  let v = min + t * (max - min);
  if (step > 0) v = min + Math.round((v - min) / step) * step;
  return String(Math.min(max, Math.max(min, v)));
}

function set(input: HTMLInputElement, clientX: number) {
  const v = valueAt(input, clientX);
  if (v === input.value) return;
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function installTouchSliders(root: Document | HTMLElement = document) {
  root.addEventListener("pointerdown", (ev) => {
    const e = ev as PointerEvent;
    const input = e.target as HTMLInputElement;
    if (e.pointerType === "mouse" || !(input instanceof HTMLInputElement) || input.type !== "range" || input.disabled) return;
    const x0 = e.clientX, y0 = e.clientY;
    let mode: "undecided" | "drag" | "scroll" = "undecided";
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      if (mode === "undecided") {
        const dx = Math.abs(m.clientX - x0), dy = Math.abs(m.clientY - y0);
        if (Math.max(dx, dy) < SLOP) return;
        mode = dx >= dy ? "drag" : "scroll";
      }
      if (mode === "drag") set(input, m.clientX);
    };
    const end = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", end, true);
      removeEventListener("pointercancel", end, true);
      if (u.type === "pointerup" && mode === "undecided") set(input, u.clientX); // a tap
      if (mode !== "scroll") input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", end, true);
    addEventListener("pointercancel", end, true);
  }, true);
}
