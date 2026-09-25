import type { Decision, Params } from "../decision/params.ts";
import type { LookProfile } from "../looks/profile.ts";
import type { ColorStats } from "../looks/palette.ts";
import type { ImageQualityReport, UpscaleMode, UpscaleReasonCode } from "../analysis/quality.ts";
export type { UpscaleMode };

export type ExportFormat = "jpeg" | "heic" | "tiff16" | "dng";

export interface Capabilities {
  webgpu: boolean;
  f16: boolean;
  backend: "webgpu" | "wasm" | "cpu";
  gpu: string;
  heicEncode: boolean;
  crossOriginIsolated: boolean;
  threads: number;
}

export interface StageProfile {
  stage: string;
  ms: number;
  gpuLiveMB: number;
  gpuPeakMB: number;
  heapMB?: number;
  note?: string;
}

export interface Summary {
  file: string;
  format: string;
  source: string;
  width: number;
  height: number;
  working: { width: number; height: number; factor: number };
  meta: Record<string, string | number>;
  coverage: Record<string, number>;
}

/** The upscale stage's decision and outcome (kept on the session, mirrored to the UI). */
export interface UpscaleInfo {
  state: "skipped" | "pending" | "running" | "applied" | "failed" | "cancelled";
  upscaleApplied: boolean;
  upscaleFactor: 1 | 2;
  upscaleReason: string;
  code: UpscaleReasonCode;
  vars: Record<string, string | number>;
  /** Analyzer measurements (qualityMetrics) and scores. */
  report: ImageQualityReport;
  /** Working size after upscaling. */
  width?: number;
  height?: number;
}

export type ToWorker =
  | { type: "init"; base: string; forceCpu?: boolean }
  | { type: "open"; file: File; resolution: "auto" | "full" | "half"; autoExposure: boolean; autoDof: boolean; upscale: UpscaleMode }
  | { type: "upscale-now" }
  | { type: "params"; params: Params; draft?: boolean }
  | { type: "view"; view: 0 | 1 | 2 | 4 | 5; before?: boolean; region?: number }
  | { type: "focus"; action: "toggle"; x: number; y: number }
  | { type: "focus"; action: "move"; index: number; x: number; y: number }
  | { type: "focus"; action: "clear" }
  | { type: "export"; format: ExportFormat; quality: number; space: "srgb" | "p3"; stripRows?: number }
  | { type: "importLook"; name: string; text: string }
  | { type: "restore"; scunet: boolean; nafnet: boolean }
  | { type: "thumbs"; profiles: LookProfile[]; long: number }
  | { type: "palette" }
  | { type: "reference"; file: File; mode: "create" | "match"; amount: number }
  | { type: "preview-size"; long: number };

export type FromWorker =
  | { type: "ready"; caps: Capabilities; looks: Array<{ id: string; name: string; description: string }> }
  | { type: "progress"; stage: string; detail?: string; frac?: number }
  | { type: "preview"; width: number; height: number; data: ArrayBuffer; space: "p3" | "srgb"; final: boolean; ms: number }
  | { type: "analysis"; summary: Summary; decisions: Decision[]; auto: Params; params: Params; dof: { justified: boolean; focus: number; strength: number; reason: string; x?: number; y?: number; zoneEdges?: number[]; zones?: Array<{ share: number; label: string; lo: number; hi: number }> }; exposureSuggestion: number }
  | { type: "params"; params: Params }
  | { type: "log"; text: string }
  | { type: "profile"; stages: StageProfile[] }
  | { type: "exported"; blob: Blob; name: string; ms: number }
  | { type: "looks"; looks: Array<{ id: string; name: string; description: string }> }
  | { type: "thumbs"; items: Array<{ id: string; width: number; height: number; data: ArrayBuffer }> }
  | { type: "palette"; stats: ColorStats }
  | { type: "lookProfile"; profile: LookProfile; reference: ColorStats; message: string }
  | { type: "gpu-lost"; reason: string }
  | { type: "upscale"; info: UpscaleInfo }
  | { type: "error"; message: string; stage?: string };
