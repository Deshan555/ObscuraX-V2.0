export interface ImageEntry {
  file: File;
  src: string;
  w: number;
  h: number;
  masks: Mask[];
  /** True once auto face detection has run on this image with the current detection settings. */
  scanned?: boolean;
}

export interface BulkProgress {
  done: number;
  total: number;
}

export interface WatermarkConfig {
  wmType: string;
  wmText: string;
  wmLink: string;
  wmColor: string;
  wmFont: string;
  wmSize: number;
  wmOpacity: number;
  wmBold: boolean;
  wmShadow: boolean;
  wmPos: { x: number; y: number };
  wmImgEl: HTMLImageElement | null;
  wmFilter: string;
  wmBlur: number;
}

export type MaskType = "blur" | "box" | "pixelate";

export interface Mask {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: MaskType;
  isAuto?: boolean;
  /** Kept in the list but not blurred (the user turned it off). */
  off?: boolean;
  /** Detector confidence, 0–1, for auto-detected faces. */
  score?: number;
  /** @deprecated style now comes from MaskStyle; kept for older callers. */
  blurLevel?: number;
}

export type MaskShape = "rect" | "ellipse";

/** Global look of every mask, applied at render time. */
export interface MaskStyle {
  type: MaskType;
  /** 1–100. Blur radius / pixel-block size, relative to the mask's size. */
  strength: number;
  shape: MaskShape;
  /** 0–100. Soft edge width, relative to the mask's size. */
  feather: number;
  /** Fill colour for "box" masks. */
  color: string;
  /** 0–60. Extra margin (%) added around auto-detected faces to cover hair and ears. */
  padding: number;
}

export interface DetectSettings {
  /** 0.1–0.9. Lower finds more faces but more false positives. */
  minConfidence: number;
  /** Also scan overlapping tiles of large frames so small faces aren't missed. Slower. */
  smallFaceBoost: boolean;
  /** Video tracking: frames sampled per second of video. */
  scanFps: number;
}

/** Face box in normalised (0–1) coordinates. */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** Video only: the same person across samples shares an id. */
  id?: number;
}

/** Video only: one person followed through the video. */
export interface TrackInfo {
  id: number;
  thumb: string;
  score: number;
  /** Samples the face appears in. */
  samples: number;
  /** Where and when the face was first seen, to re-identify it after a rescan. */
  firstT: number;
  firstBox: FaceBox;
}

export interface TrackSample {
  t: number;
  boxes: FaceBox[];
}
