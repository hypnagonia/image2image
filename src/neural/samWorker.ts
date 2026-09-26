/// <reference lib="webworker" />
/**
 * Tap-to-select (MobileSAM) on the CPU, in a worker of its own (see sam.ts).
 *
 * "encode": the photo (HWC, 0…255, long side 1024) → image embeddings. The
 *   encoder's memory can never shrink inside ONNX Runtime's wasm heap, so the
 *   worker that encodes is terminated right after it answers.
 * "init" + "decode": a second, long-lived worker keeps only the small decoder
 *   and the embeddings; each tap is one ≈ 20 ms decode.
 */
import { Neural, MODELS, ort } from "./ort.ts";

type In =
  | { type: "encode"; base: string; image: Float32Array; w: number; h: number }
  | { type: "init"; base: string; emb: Float32Array }
  | { type: "decode"; id: number; coords: Float32Array; labels: Float32Array; w: number; h: number };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

let decoder: ort.InferenceSession | undefined;
let emb: ort.Tensor | undefined;

self.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data;
  try {
    if (m.type === "encode") {
      const neural = await Neural.create(undefined, m.base, true);
      const s = await neural.session(MODELS.samEncoder, false, "wasm");
      const out = await s.run({ input_image: new ort.Tensor("float32", m.image, [m.h, m.w, 3]) });
      const e = Float32Array.from((await out[s.outputNames[0]].getData()) as Float32Array);
      await s.release();
      post({ type: "embedding", emb: e }, [e.buffer]);
    } else if (m.type === "init") {
      const neural = await Neural.create(undefined, m.base, true);
      decoder = await neural.session(MODELS.samDecoder, false, "wasm");
      emb = new ort.Tensor("float32", m.emb, [1, 256, 64, 64]);
      post({ type: "ready" });
    } else if (m.type === "decode") {
      if (!decoder || !emb) throw new Error("selection decoder not ready");
      const n = m.labels.length;
      const out = await decoder.run({
        image_embeddings: emb,
        point_coords: new ort.Tensor("float32", m.coords, [1, n, 2]),
        point_labels: new ort.Tensor("float32", m.labels, [1, n]),
        mask_input: new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor("float32", new Float32Array([0]), [1]),
        orig_im_size: new ort.Tensor("float32", new Float32Array([m.h, m.w]), [2]),
      });
      const low = Float32Array.from((await out.low_res_masks.getData()) as Float32Array);
      const iou = Float32Array.from((await out.iou_predictions.getData()) as Float32Array);
      for (const t of Object.values(out)) t.dispose();
      post({ type: "masks", id: m.id, low, iou }, [low.buffer, iou.buffer]);
    }
  } catch (e) {
    post({ type: "error", id: (m as { id?: number }).id, error: e instanceof Error ? e.message : String(e) });
  }
};
