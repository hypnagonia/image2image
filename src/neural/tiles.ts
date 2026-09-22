/**
 * Tiled full-resolution inference (SCUNet, NAFNet).
 *
 * Tiles of TILE px with OVERLAP px overlap are processed strip by strip into a
 * rolling accumulator. A tile the plan marks as unnecessary contributes its
 * own input (identity) instead of running the network, so a clean or sharp
 * region costs almost nothing. Blending is exact (normalised feather weights),
 * which is what keeps tile boundaries invisible.
 *
 * GPU path: tile tensors live in storage buffers shared with ONNX Runtime's
 * WebGPU EP — no CPU round trip per tile. WASM path: the same buffers are
 * read back / written per tile.
 */
import { Gpu, Uniforms } from "../gpu/gpu.ts";
import tilesCommon from "../gpu/shaders/tiles.wgsl?raw";
import extractWgsl from "../gpu/shaders/tile_extract.wgsl?raw";
import accumWgsl from "../gpu/shaders/tile_accum.wgsl?raw";
import finalizeWgsl from "../gpu/shaders/tile_finalize.wgsl?raw";
import shiftWgsl from "../gpu/shaders/tile_shift.wgsl?raw";
import checkWgsl from "../gpu/shaders/tile_check.wgsl?raw";
import { ort, type Neural } from "./ort.ts";

export const TILE = 256;
export const OVERLAP = 32;

export interface TileGrid {
  xs: number[];
  ys: number[];
}

export function tileGrid(w: number, h: number, tile = TILE, overlap = OVERLAP): TileGrid {
  const axis = (n: number) => {
    if (n <= tile) return [0];
    const stride = tile - overlap;
    const out: number[] = [];
    for (let p = 0; p + tile < n; p += stride) out.push(p);
    out.push(n - tile);
    return out;
  };
  return { xs: axis(w), ys: axis(h) };
}

export interface TilePlanEntry {
  /** Blend strength 0..1 (0 = skip, identity). */
  strength: number;
}

export interface TileRunStats {
  tiles: number;
  run: number;
  skipped: number;
  rejected: number;
  ms: number;
  msPerTile: number;
}

export interface TileRunOptions {
  /** Encode gain (scene-linear → network input range). */
  gain: number;
  /** Per-tile decision, indexed [row][col] of the grid. */
  plan: (col: number, row: number, x: number, y: number) => TilePlanEntry;
  /** Reject tiles whose output diverges (NAFNet on unexpectedly sharp input). */
  sanity?: { maxMeanDiff: number; maxDeviation: number };
  onTile?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
}

export async function runTiled(
  gpu: Gpu, neural: Neural, session: ort.InferenceSession,
  src: GPUTexture, dst: GPUTexture, w: number, h: number, opt: TileRunOptions,
): Promise<TileRunStats> {
  const t0 = performance.now();
  const grid = tileGrid(w, h);
  const T = TILE; // the exported graphs have a fixed 256×256 input
  const n = T * T * 3;
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const inBuf = gpu.buf("tile.in", n * 4, usage);
  const outBuf = gpu.buf("tile.out", n * 4, usage);
  const checkBuf = gpu.buf("tile.check", 16, usage);
  const accH = TILE;
  let accA = gpu.buf("tile.accA", w * accH * 16, usage);
  let accB = gpu.buf("tile.accB", w * accH * 16, usage);
  const strip = gpu.tex("tile.strip", w, accH, "rgba16float");
  const pExtract = gpu.pipeline("tile.extract", tilesCommon + extractWgsl);
  const pAccum = gpu.pipeline("tile.accum", tilesCommon + accumWgsl);
  const pFinal = gpu.pipeline("tile.finalize", tilesCommon + finalizeWgsl);
  const pShift = gpu.pipeline("tile.shift", tilesCommon + shiftWgsl);
  const pCheck = gpu.pipeline("tile.check", tilesCommon + checkWgsl);
  const srcView = src.createView();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const gpuTensors = neural.backend === "webgpu" && neural.sharedDevice;
  const stats: TileRunStats = { tiles: grid.xs.length * grid.ys.length, run: 0, skipped: 0, rejected: 0, ms: 0, msPerTile: 0 };
  let netMs = 0;

  const params = (tx: number, ty: number, accY: number, mode: number, rows: number, strength: number) => {
    const u = new Uniforms(16)
      .u32(w, h, T, OVERLAP).i32(tx, ty, accY).u32(accH, mode, rows).f32(opt.gain, strength)
      .u32(tx <= 0 ? 1 : 0, tx + T >= w ? 1 : 0, ty <= 0 ? 1 : 0, ty + T >= h ? 1 : 0);
    return gpu.uniform(u.bytes(), "tile.u");
  };

  // Zero the first accumulator.
  await gpu.run("tile.clear", (enc) => { enc.clearBuffer(accA); });

  let done = 0;
  for (let r = 0; r < grid.ys.length; r++) {
    const ty = grid.ys[r];
    for (let c = 0; c < grid.xs.length; c++) {
      if (opt.shouldCancel?.()) throw new Error("cancelled");
      const tx = grid.xs[c];
      const plan = opt.plan(c, r, tx, ty);
      let mode = 0;
      let strength = Math.max(0, Math.min(1, plan.strength));
      if (strength > 0.01) {
        // Extract → network.
        await gpu.run("tile.extract", (enc, temp) => {
          const u = params(tx, ty, ty, 0, 0, 0);
          temp.push(u);
          gpu.dispatch(enc, pExtract, [u, srcView, inBuf], T / 16, T / 16);
        });
        const tn = performance.now();
        if (gpuTensors) {
          const input = ort.Tensor.fromGpuBuffer(inBuf as never, { dataType: "float32", dims: [1, 3, T, T] });
          const res = await session.run({ [inputName]: input });
          const outT = res[outputName];
          const ob = (outT as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer;
          const enc = gpu.device.createCommandEncoder();
          enc.copyBufferToBuffer(ob, 0, outBuf, 0, n * 4);
          gpu.device.queue.submit([enc.finish()]);
          outT.dispose();
          input.dispose();
        } else {
          const host = new Float32Array(await gpu.readBuffer(inBuf, n * 4));
          const res = await session.run({ [inputName]: new ort.Tensor("float32", host, [1, 3, T, T]) });
          const data = res[outputName].data as Float32Array;
          gpu.device.queue.writeBuffer(outBuf, 0, data.buffer as ArrayBuffer, data.byteOffset, n * 4);
        }
        netMs += performance.now() - tn;
        mode = 1;
        if (opt.sanity) {
          await gpu.run("tile.check", (enc, temp) => {
            const u = params(tx, ty, ty, 0, 0, 0);
            temp.push(u);
            gpu.dispatch(enc, pCheck, [u, inBuf, outBuf, checkBuf], 1);
          });
          const s = new Float32Array(await gpu.readBuffer(checkBuf, 8));
          if (!(s[0] <= opt.sanity.maxMeanDiff) || !(s[1] <= opt.sanity.maxDeviation)) {
            mode = 0;
            strength = 0;
            stats.rejected++;
          }
        }
        if (mode === 1) stats.run++;
      } else {
        stats.skipped++;
      }
      const accY = grid.ys[r];
      await gpu.run("tile.accum", (enc, temp) => {
        const u = params(tx, ty, accY, mode, 0, strength);
        temp.push(u);
        gpu.dispatch(enc, pAccum, [u, srcView, outBuf, accA], T / 16, T / 16);
      });
      opt.onTile?.(++done, stats.tiles);
    }
    // Finalise the rows no later strip touches, then shift the rest up.
    const next = r + 1 < grid.ys.length ? grid.ys[r + 1] : h;
    const rows = Math.min(next - ty, accH);
    await gpu.run("tile.finalize", (enc, temp) => {
      const u = params(0, 0, ty, 0, rows, 0);
      temp.push(u);
      gpu.dispatch(enc, pFinal, [u, srcView, accA, strip.createView()], Math.ceil(w / 16), Math.ceil(rows / 16));
      enc.copyTextureToTexture({ texture: strip }, { texture: dst, origin: { x: 0, y: ty } }, { width: w, height: rows });
      if (r + 1 < grid.ys.length) {
        const u2 = params(0, 0, ty, 0, rows, 0);
        temp.push(u2);
        gpu.dispatch(enc, pShift, [u2, accA, accB], Math.ceil(w / 16), Math.ceil(accH / 16));
      }
    });
    [accA, accB] = [accB, accA];
  }
  await gpu.device.queue.onSubmittedWorkDone();
  gpu.release(inBuf, outBuf, checkBuf, accA, accB, strip);
  stats.ms = performance.now() - t0;
  stats.msPerTile = stats.run ? netMs / stats.run : 0;
  return stats;
}
