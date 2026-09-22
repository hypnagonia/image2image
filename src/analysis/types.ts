import type { Group } from "../neural/scene.ts";

export interface RegionStats {
  /** Share of the image area (sum of probabilities / pixels). */
  area: number;
  /** Mean and spread of log2 scene luminance (EV). */
  meanEV: number;
  sdEV: number;
  meanY: number;
  /** Mean linear working RGB (for white-balance reasoning). */
  rgb: [number, number, number];
  /** Mean OkLab chroma as displayed at the normalised exposure. */
  chroma: number;
  clipHi: number;
  clipLo: number;
  /** Mean |detail| between pixel and medium-scale base (EV). */
  localContrast: number;
  /** Mean encoded-luma gradient (guide resolution). */
  texture: number;
  dist: number;
  distSd: number;
  darkChannel: number;
  meanYe: number;
  /** 32-bin log2 luminance histogram (−14..+4 EV), normalised to sum 1. */
  hist: number[];
}

export interface NoiseProfile {
  /** Encoded-luma bins (centre) with noise σ in encoded units (1/255 ≈ 0.0039). */
  bins: Array<{ y: number; sigma: number; sigmaC: number; blocks: number }>;
  /** Robust overall luma noise σ at mid-tones, and in the shadows. */
  mid: number;
  shadow: number;
  chroma: number;
}

export interface BlurReport {
  /** Estimated Gaussian blur σ (px, working resolution) per block; NaN where no edges. */
  perBlock: Float32Array;
  /** Median over edge blocks; fraction of edge blocks with σ above the "blurred" threshold. */
  median: number;
  blurredFraction: number;
  edgeBlocks: number;
}

export interface BlockGrid {
  bw: number;
  bh: number;
  size: number;
  /** 16 floats per block, see blocks.wgsl. */
  data: Float32Array;
}

export interface AnalysisReport {
  width: number;
  height: number;
  /** Scene-linear → network/analysis encoding gain. */
  gain: number;
  referred: "scene" | "display";
  isProRaw: boolean;
  iso?: number;
  global: RegionStats;
  groups: Record<Group, RegionStats>;
  /** 128-bin log2 Y histogram (−14..+4 EV), normalised. */
  histLum: number[];
  histRGB: [number[], number[], number[]];
  /** Dark-channel-prior atmospheric light (encoded RGB) and the 99th-percentile dark channel. */
  atmosphere: { light: [number, number, number]; dcP99: number; dcMedian: number };
  noise: NoiseProfile;
  blur: BlurReport;
  blocks: BlockGrid;
  /** Percentiles of scene luminance (linear). */
  lum: { p01: number; p05: number; p50: number; p95: number; p99: number; p999: number };
  timings: Record<string, number>;
}
