export interface ImageEntry {
  file: File;
  src: string;
  w: number;
  h: number;
  masks: Mask[];
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
}
