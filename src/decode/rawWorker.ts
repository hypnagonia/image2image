/// <reference lib="webworker" />
/**
 * LibRaw in its own short-lived worker. A wasm heap never shrinks and is freed
 * only when the garbage collector gets to it; for a 48 MP ProRAW that is ≈ 460 MB
 * which could still be alive while scene analysis runs (where phones died).
 * Here the engine asks for the sensor rows strip by strip while it develops, and
 * then terminates this worker: the memory is returned at once.
 *
 * Messages in:  { type: "decode", bytes: ArrayBuffer, name }
 *               { type: "rows", id, first, count }   rows [first, first + count) of the stored buffer
 * Messages out: { type: "decoded", image }  (the source without its data; masks transferred)
 *               { type: "rows", id, data }  |  { type: "error", message }
 */
import { decodeRaw } from "./libraw.ts";
import type { DecodedImage, RawSource } from "./types.ts";

let decoded: DecodedImage | undefined;
const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { type: "decode"; bytes: ArrayBuffer; name: string } | { type: "rows"; id: number; first: number; count: number };
  try {
    if (m.type === "decode") {
      decoded = await decodeRaw(new Uint8Array(m.bytes), m.name);
      const { close: _close, source, ...rest } = decoded;
      void _close;
      const src = source as RawSource;
      const masks = decoded.masks ?? [];
      post({ type: "decoded", image: { ...rest, source: { ...src, data: new Uint16Array(0) } } }, masks.map((k) => k.data.buffer));
      decoded.masks = undefined; // transferred
    } else if (m.type === "rows") {
      const src = decoded!.source as RawSource;
      const rows = src.data.slice(m.first * src.pitch, (m.first + m.count) * src.pitch);
      post({ type: "rows", id: m.id, data: rows }, [rows.buffer]);
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
