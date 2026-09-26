/**
 * Tap-to-select: MobileSAM (Segment Anything with a TinyViT encoder), for masks
 * of one thing — one person of four, one person's clothes — which the scene
 * analysis (a region per kind of thing) cannot tell apart.
 *
 * The photo is encoded once, in a worker that is terminated right after (see
 * samWorker.ts); taps are decoded in a second small worker that lives until the
 * photo is closed. A selection is its taps (points with add / remove labels),
 * so params stay small and the mask can be rebuilt after a reload.
 */
import { samDims } from "../refine/selection.ts";

import type { SelectPoint } from "../layers/model.ts";
export type { SelectPoint };

type Reply =
  | { type: "embedding"; emb: Float32Array }
  | { type: "ready" }
  | { type: "masks"; id: number; low: Float32Array; iou: Float32Array }
  | { type: "error"; id?: number; error: string };

function spawn(): Worker {
  return new Worker(new URL("./samWorker.ts", import.meta.url), { type: "module" });
}

/** One request/answer with a worker (the first message of the matching type, or an error). */
function ask<T extends Reply["type"]>(w: Worker, msg: unknown, want: T, id?: number, transfer: Transferable[] = []): Promise<Extract<Reply, { type: T }>> {
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<Reply>) => {
      const r = ev.data;
      if (r.type === "error" && (id === undefined || r.id === id || r.id === undefined)) { done(); reject(new Error(r.error)); }
      else if (r.type === want && (id === undefined || (r as { id?: number }).id === id)) { done(); resolve(r as Extract<Reply, { type: T }>); }
    };
    const onErr = (e: ErrorEvent) => { e.preventDefault(); done(); reject(new Error(e.message || "Selection stopped")); };
    const done = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    w.postMessage(msg, transfer);
  });
}

export class SamSelector {
  /** The photo's size inside SAM's 1024 square. */
  readonly dims: [number, number];
  private emb?: Float32Array;
  private encoding?: Promise<void>;
  private decoder?: Worker;
  private decoderReady?: Promise<unknown>;
  private nextId = 1;

  constructor(private base: string, photoW: number, photoH: number) {
    this.dims = samDims(photoW, photoH);
  }

  get encoded(): boolean { return !!this.emb; }

  /** Encodes the photo once (`image`: HWC 0…255 at `dims`); later calls wait for the same run. */
  encode(image: () => Promise<Float32Array>): Promise<void> {
    this.encoding ??= (async () => {
      const px = await image();
      const w = spawn();
      try {
        const [pw, ph] = this.dims;
        const r = await ask(w, { type: "encode", base: this.base, image: px, w: pw, h: ph }, "embedding", undefined, [px.buffer]);
        this.emb = r.emb;
      } finally {
        w.terminate(); // all of the encoder's memory, returned at once
      }
    })().catch((e) => { this.encoding = undefined; throw e; });
    return this.encoding;
  }

  /** SAM's four 256² logit masks and their predicted quality for these taps. */
  async decode(points: SelectPoint[]): Promise<{ low: Float32Array; iou: Float32Array }> {
    if (!this.emb) throw new Error("photo not encoded for selection");
    if (!this.decoder) {
      this.decoder = spawn();
      this.decoderReady = ask(this.decoder, { type: "init", base: this.base, emb: this.emb.slice() }, "ready");
    }
    await this.decoderReady;
    const [pw, ph] = this.dims;
    // SAM's point prompt: coordinates in the 1024 square, plus a padding point (label −1) when there is no box.
    const coords = new Float32Array((points.length + 1) * 2);
    const labels = new Float32Array(points.length + 1);
    points.forEach(([x, y, l], i) => { coords[i * 2] = x * pw; coords[i * 2 + 1] = y * ph; labels[i] = l; });
    labels[points.length] = -1;
    const id = this.nextId++;
    const r = await ask(this.decoder, { type: "decode", id, coords, labels, w: pw, h: ph }, "masks", id);
    return { low: r.low, iou: r.iou };
  }

  dispose() {
    this.decoder?.terminate();
    this.decoder = undefined;
    this.decoderReady = undefined;
  }
}
