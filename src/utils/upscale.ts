// Image upscaling on the canvas: high-quality resampling plus an unsharp mask
// to restore edge crispness. Runs locally; nothing is uploaded.

import { CANVAS_MAX_PIXELS, CANVAS_MAX_SIDE } from "./device";

/** Browsers refuse canvases past ~16k per side, and very large ones exhaust memory (far sooner on phones). */
export const UPSCALE_MAX_SIDE = CANVAS_MAX_SIDE;
export const UPSCALE_MAX_PIXELS = CANVAS_MAX_PIXELS;

export const UPSCALE_FACTORS = [1, 2, 3, 4] as const;

/**
 * Largest factor up to `factor` whose output still fits the canvas limits.
 * Below 1 when even the original is too big for this device (e.g. a 24 MP
 * iPhone photo on iOS Safari), so the export is saved smaller instead of failing.
 */
export function fitScale(w: number, h: number, factor: number): number {
  if (!w || !h) return 1;
  const bySide = UPSCALE_MAX_SIDE / Math.max(w, h);
  const byArea = Math.sqrt(UPSCALE_MAX_PIXELS / (w * h));
  return Math.min(Math.max(1, factor), bySide, byArea);
}

/** Output size for an image enlarged by `factor`, capped to the canvas limits. */
export function upscaledSize(w: number, h: number, factor: number) {
  const scale = fitScale(w, h, factor);
  return { w: Math.round(w * scale), h: Math.round(h * scale), scale };
}

const supportsCanvasFilter =
  typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { c, ctx };
}

/**
 * Draws `src` (natural size sw × sh) enlarged to dw × dh and sharpens it.
 * `sharpen` is 0–100; 0 gives plain high-quality resampling.
 *
 * Sharpening works in horizontal bands so memory stays bounded on large outputs.
 * Each band is drawn from the source with a transform rather than a source rect,
 * which avoids seams where browsers clamp sampling to the source rect.
 */
export function upscaleImage(src: CanvasImageSource, sw: number, sh: number, dw: number, dh: number, sharpen: number): HTMLCanvasElement {
  const out = makeCanvas(dw, dh);
  const amount = (Math.min(100, Math.max(0, sharpen)) / 100) * 1.5;
  if (amount <= 0 || !supportsCanvasFilter) {
    out.ctx.drawImage(src, 0, 0, dw, dh);
    return out.c;
  }

  // Blur radius tracks the enlargement so the mask hits the softened edges, not noise.
  const scale = Math.max(dw / sw, dh / sh);
  const radius = Math.min(3, Math.max(0.8, scale * 0.6));
  const pad = Math.ceil(radius * 3) + 2;
  const bandH = Math.max(64, Math.floor(4_000_000 / dw));
  // Differences below this are left alone so flat areas don't turn grainy.
  const threshold = 3;

  const sharp = makeCanvas(dw, bandH + 2 * pad);
  const soft = makeCanvas(dw, bandH + 2 * pad);
  soft.ctx.filter = `blur(${radius.toFixed(2)}px)`;

  for (let y0 = 0; y0 < dh; y0 += bandH) {
    const bh = Math.min(bandH, dh - y0);
    const top = Math.max(0, y0 - pad);
    sharp.ctx.clearRect(0, 0, dw, sharp.c.height);
    soft.ctx.clearRect(0, 0, dw, soft.c.height);
    sharp.ctx.drawImage(src, 0, -top, dw, dh);
    soft.ctx.drawImage(src, 0, -top, dw, dh);

    const img = sharp.ctx.getImageData(0, y0 - top, dw, bh);
    const a = img.data;
    const b = soft.ctx.getImageData(0, y0 - top, dw, bh).data;
    for (let i = 0; i < a.length; i += 4) {
      for (let k = i; k < i + 3; k++) {
        const d = a[k] - b[k];
        if (d > threshold || d < -threshold) a[k] = a[k] + amount * d; // Uint8ClampedArray clamps
      }
    }
    out.ctx.putImageData(img, 0, y0);
  }

  // Free the band buffers now rather than at GC.
  sharp.c.width = soft.c.width = 0;
  return out.c;
}
