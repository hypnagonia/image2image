/** Shape of the JSON produced by native/libraw/wrapper.cpp (lr_meta_json). */
export interface LibRawMeta {
  rawKind: 0 | 1 | 3 | 4;
  sizes: {
    rawWidth: number; rawHeight: number; width: number; height: number;
    topMargin: number; leftMargin: number; rawPitch: number; flip: number;
    pixelAspect: number; insetCrop: number[];
  };
  idata: {
    make: string; model: string; normalizedMake: string; normalizedModel: string; software: string;
    dngVersion: number; colors: number; filters: number; cdesc: string; cfa16: number[];
  };
  color: {
    black: number; cblack: number[]; maximum: number; linearMax: number[];
    camMul: number[]; preMul: number[]; rgbCam: number[]; camXyz: number[]; flashUsed: number;
    dng1: DngIlluminantData; dng2: DngIlluminantData;
    dngLevels: {
      black: number; cblack: number[]; whiteLevel: number[]; defaultCrop: number[];
      analogBalance: number[]; asShotNeutral: number[]; baselineExposure: number; linearResponseLimit: number;
    };
  };
  other: {
    iso: number; shutter: number; aperture: number; focalLength: number; timestamp: number;
    artist: string; description: string; gpsParsed: number; latitude: number[]; longitude: number[];
    altitude: number; latRef: string; lonRef: string;
  };
  lens: { make: string; model: string; focalLength35: number };
}

export interface DngIlluminantData {
  illuminant: number;
  calibration: number[]; // 4×4 row-major
  colorMatrix: number[]; // 4×3 row-major (XYZ → camera)
  forwardMatrix: number[]; // 3×4 row-major (camera → XYZ D50)
}

/** Capture metadata carried through the pipeline and written to exports. */
export interface PhotoMetadata {
  make?: string;
  model?: string;
  software?: string;
  lensMake?: string;
  lensModel?: string;
  iso?: number;
  exposureTime?: number;
  fNumber?: number;
  focalLength?: number;
  focalLength35?: number;
  dateTime?: Date;
  gps?: { lat: number; lon: number; alt?: number };
  artist?: string;
  description?: string;
  /** EXIF orientation 1..8 of the *source*; pixels are rotated upright during development. */
  orientation: number;
  /** Raw APP1 Exif payload from the source (HEIC/JPEG), re-used when exporting. */
  exifBlock?: Uint8Array;
  iccProfile?: Uint8Array;
}

export type SourceKind = "bayer" | "linear-raw" | "rgb";

/** Everything the RAW development stage needs to turn sensor numbers into linear working RGB. */
export interface RawSource {
  kind: "bayer" | "linear-raw";
  /** True for Apple ProRAW: LinearRaw that already went through Apple's
   * demosaic, multi-frame fusion and noise reduction. */
  isProRaw: boolean;
  width: number; // active area (after margins), unrotated
  height: number;
  /** Samples per stored pixel (1 for CFA, 3 or 4 for LinearRaw). */
  channels: 1 | 3 | 4;
  /** Row pitch in samples. */
  pitch: number;
  /** Offset of the active area inside the stored buffer, in pixels. */
  left: number;
  top: number;
  data: Uint16Array; // view into the decoder heap — valid until the decoder is closed
  /** 2×2 CFA colour indices (0=R,1=G,2=B,3=G2) at (row%2,col%2) relative to `top/left`. */
  cfa: [number, number, number, number];
  /** Black level per CFA position (Bayer) or per channel (LinearRaw), in raw units. */
  black: [number, number, number, number];
  white: [number, number, number, number];
  color: import("../color/dng.ts").CameraColorInput;
}

export interface RgbSource {
  kind: "rgb";
  width: number;
  height: number;
  /** Decoded upright RGBA. `float16` path is used when a decoder gives >8 bits. */
  pixels: ImageBitmap | { data: Uint8Array | Uint16Array; bits: 8 | 10 | 12 | 16; channels: 3 | 4 };
  colorSpace: "srgb" | "display-p3" | "rec2020";
  decoder: "native" | "libheif";
}

export interface DecodedImage {
  format: "dng" | "raw" | "heic" | "jpeg" | "png" | "other";
  source: RawSource | RgbSource;
  meta: PhotoMetadata;
  /** Release decoder memory (wasm heap, bitmaps). */
  close(): void;
  timings: Record<string, number>;
}
