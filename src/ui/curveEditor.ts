/**
 * Touch-friendly point-curve editor (monotone cubic preview).
 * Tap empty space to add a point, drag to move, drag a point far outside the
 * box to delete it. End points can move vertically only.
 */
import { monotoneCurve } from "../render/curves.ts";
import { periodicCurve } from "../looks/profile.ts";
import { oklabToLinSrgb } from "../color/oklab.ts";

/** CSS colour of an OkLab hue (degrees) at a fixed lightness/chroma — the app's rainbow. */
export function hueColor(deg: number, L = 0.74, C = 0.12): string {
  const h = (deg * Math.PI) / 180;
  const rgb = oklabToLinSrgb([L, C * Math.cos(h), C * Math.sin(h)]).map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
  });
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** CSS linear-gradient across the whole hue circle. */
export function rainbowGradient(): string {
  return `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => hueColor(i * 30)).join(", ")})`;
}

export type Pt = [number, number];
export type Mode = "curve" | "rainbow" | "level";

export class CurveEditor {
  readonly el: HTMLCanvasElement;
  private pts: Pt[] = [[0, 0], [1, 1]];
  private color = "#ece9e3";
  private drag = -1;
  /** curve: plain 0…1 point curve. rainbow: x is the hue circle (periodic), y = 0.5 is "no change".
   *  level: x is lightness (black → white), y = 0.5 is "no change". */
  private mode: Mode = "curve";
  onChange?: (pts: Pt[]) => void;

  constructor(size = 220) {
    this.el = document.createElement("canvas");
    this.el.className = "curve-editor";
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.width = size * dpr;
    this.el.height = size * dpr;
    this.el.style.width = this.el.style.height = size + "px";
    this.el.addEventListener("pointerdown", (e) => this.down(e));
    this.el.addEventListener("pointermove", (e) => this.move(e));
    this.el.addEventListener("pointerup", () => this.up());
    this.el.addEventListener("pointercancel", () => this.up());
  }

  set(pts: Pt[], color: string, mode: Mode = "curve") {
    this.pts = pts.map((p) => [p[0], p[1]] as Pt).sort((a, b) => a[0] - b[0]);
    this.color = color;
    this.mode = mode;
    const wide = mode !== "curve";
    this.el.style.height = wide ? Math.round(parseInt(this.el.style.width) * 0.6) + "px" : this.el.style.width;
    this.el.height = wide ? Math.round(this.el.width * 0.6) : this.el.width;
    this.draw();
  }

  private pos(e: PointerEvent): Pt {
    const r = this.el.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  }

  private down(e: PointerEvent) {
    this.el.setPointerCapture(e.pointerId);
    const [x, y] = this.pos(e);
    let best = -1, bd = 0.06;
    this.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) {
      const q: Pt = [Math.min(0.98, Math.max(0.02, x)), Math.min(1, Math.max(0, y))];
      this.pts.push(q);
      this.pts.sort((a, b) => a[0] - b[0]);
      best = this.pts.indexOf(q);
      this.emit();
    }
    this.drag = best;
    this.draw();
  }

  private move(e: PointerEvent) {
    if (this.drag < 0) return;
    const [x, y] = this.pos(e);
    const i = this.drag;
    const last = this.pts.length - 1;
    const outside = x < -0.15 || x > 1.15 || y < -0.15 || y > 1.15;
    if (outside && i > 0 && i < last) {
      this.pts.splice(i, 1);
      this.drag = -1;
    } else if (i === 0 || i === last) {
      const yy = Math.min(1, Math.max(0, y));
      this.pts[i] = [this.pts[i][0], yy];
      // The hue circle wraps: red at 0 and red at 1 are the same colour.
      if (this.mode === "rainbow") { this.pts[0] = [0, yy]; this.pts[last] = [1, yy]; }
    } else {
      const lo = this.pts[i - 1][0] + 0.02, hi = this.pts[i + 1][0] - 0.02;
      this.pts[i] = [Math.min(hi, Math.max(lo, x)), Math.min(1, Math.max(0, y))];
    }
    this.emit();
    this.draw();
  }

  private up() { this.drag = -1; this.draw(); }

  private emit() { this.onChange?.(this.pts.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000] as Pt)); }

  private draw() {
    const c = this.el.getContext("2d")!;
    const W = this.el.width, H = this.el.height;
    c.clearRect(0, 0, W, H);
    if (this.mode === "level") {
      // Lightness band along the bottom, neutral line at y = 0.5.
      const g = c.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, "#000"); g.addColorStop(1, "#fff");
      c.fillStyle = g;
      c.globalAlpha = 0.16; c.fillRect(0, 0, W, H); c.globalAlpha = 1;
      c.fillRect(0, H - 8 * (W / 220), W, 8 * (W / 220));
      c.strokeStyle = "rgba(255,255,255,0.35)";
      c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
      c.setLineDash([]);
    }
    if (this.mode === "rainbow") {
      // Hue band along the bottom, faint wash behind, neutral line at y = 0.5.
      for (let i = 0; i < 90; i++) {
        c.fillStyle = hueColor((i / 90) * 360);
        c.globalAlpha = 0.18;
        c.fillRect((i / 90) * W, 0, W / 90 + 1, H);
        c.globalAlpha = 1;
        c.fillRect((i / 90) * W, H - 8 * (W / 220), W / 90 + 1, 8 * (W / 220));
      }
      c.strokeStyle = "rgba(255,255,255,0.35)";
      c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
      c.setLineDash([]);
    }
    c.strokeStyle = "rgba(255,255,255,0.08)";
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      c.beginPath(); c.moveTo((i / 4) * W, 0); c.lineTo((i / 4) * W, H); c.stroke();
      c.beginPath(); c.moveTo(0, (i / 4) * H); c.lineTo(W, (i / 4) * H); c.stroke();
    }
    if (this.mode === "curve") {
      c.strokeStyle = "rgba(255,255,255,0.18)";
      c.beginPath(); c.moveTo(0, H); c.lineTo(W, 0); c.stroke();
    }
    const f = this.mode === "rainbow" ? periodicCurve(this.pts) : monotoneCurve(this.pts.map(([x, y]) => ({ x, y })));
    c.strokeStyle = this.color;
    c.lineWidth = 2 * (W / 220);
    c.beginPath();
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      const y = f(x);
      if (i === 0) c.moveTo(x * W, (1 - y) * H); else c.lineTo(x * W, (1 - y) * H);
    }
    c.stroke();
    c.fillStyle = this.color;
    for (const [x, y] of this.pts) { c.beginPath(); c.arc(x * W, (1 - y) * H, 5 * (W / 220), 0, Math.PI * 2); c.fill(); }
  }
}
