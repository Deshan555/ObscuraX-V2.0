import { Mask, MaskStyle, WatermarkConfig } from "../types";
import { WM, DEFAULT_MASK_STYLE } from "../constants/config";

export function applyWatermark(ctx: CanvasRenderingContext2D, W: number, H: number, config: WatermarkConfig) {
  const { wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmImgEl } = config;

  ctx.save();
  ctx.globalAlpha = wmOpacity / 100;

  if (wmShadow) {
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = Math.max(6, wmSize * 0.28);
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;
  }

  const wx = wmPos.x * W;
  const wy = wmPos.y * H;

  if (wmType === WM.TEXT || wmType === WM.LINK) {
    const content = wmType === WM.LINK ? wmLink : wmText;
    ctx.font = `${wmBold ? "bold " : ""}${wmSize}px ${wmFont}`;
    ctx.fillStyle = wmColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (wmType === WM.LINK) {
      const mw = ctx.measureText(content).width;
      ctx.fillRect(wx - mw / 2, wy + wmSize * 0.62, mw, Math.max(1.5, wmSize * 0.055));
    }
    ctx.fillText(content, wx, wy);
  } else if (wmType === WM.IMG && wmImgEl) {
    const ratio = wmImgEl.naturalHeight / wmImgEl.naturalWidth;
    const iw = wmSize * 5;
    ctx.drawImage(wmImgEl, wx - iw / 2, wy - (iw * ratio) / 2, iw, iw * ratio);
  }

  ctx.restore();
}

// ── Whole-image filters ───────────────────────────────────────────────────────

/** Soft blur radii as a fraction of the image's shorter side, so they look the same at any resolution. */
const SOFT_BLUR: Record<string, number> = { "soft-blur": 0.004, "ultra-soft-blur": 0.012 };

/** Thumbnail CSS for a FILTERS value (thumbnails are ~80 px, so fixed radii are fine). */
export function filterPreviewCss(filter: string): string {
  if (filter === "blur") return "blur(2px)";
  if (filter === "soft-blur") return "blur(1px)";
  if (filter === "ultra-soft-blur") return "blur(3px)";
  return filter;
}

/**
 * Canvas filter for a FILTERS value at a W × H output. `blurPx` is the radius of the
 * adjustable "blur" filter, already scaled to this output.
 */
export function resolveFilter(filter: string, blurPx: number, W: number, H: number): string {
  if (!filter || filter === "none") return "none";
  if (filter === "blur") return blurPx > 0 ? `blur(${blurPx}px)` : "none";
  const soft = SOFT_BLUR[filter];
  if (soft) return `blur(${Math.max(1, Math.min(W, H) * soft).toFixed(1)}px)`;
  return filter;
}

/**
 * Draws `src` over the whole canvas with a filter. Blurs are laid over an unblurred
 * copy so the borders don't fade to transparent (the blur pulls in empty pixels there).
 */
export function drawFiltered(ctx: CanvasRenderingContext2D, src: CanvasImageSource, W: number, H: number, filter: string) {
  if (filter.startsWith("blur(")) ctx.drawImage(src, 0, 0, W, H);
  ctx.filter = filter;
  ctx.drawImage(src, 0, 0, W, H);
  ctx.filter = "none";
}

// ── Masks ─────────────────────────────────────────────────────────────────────

const supportsCanvasFilter =
  typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

// Grow-only scratch canvases, reused across masks and video frames to avoid
// reallocating every frame.
const scratch: HTMLCanvasElement[] = [];
function getScratch(i: number, w: number, h: number) {
  const c = (scratch[i] ??= document.createElement("canvas"));
  if (c.width < w) c.width = Math.ceil(w);
  if (c.height < h) c.height = Math.ceil(h);
  const x = c.getContext("2d")!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = "source-over";
  x.globalAlpha = 1;
  x.shadowColor = "transparent";
  x.shadowBlur = 0;
  x.shadowOffsetX = 0;
  x.shadowOffsetY = 0;
  if (supportsCanvasFilter) x.filter = "none";
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = "high";
  x.clearRect(0, 0, c.width, c.height);
  return { c, x };
}

function shapePath(x: CanvasRenderingContext2D, shape: MaskStyle["shape"], px: number, py: number, w: number, h: number) {
  x.beginPath();
  if (shape === "ellipse") x.ellipse(px + w / 2, py + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else x.rect(px, py, w, h);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The area a mask actually covers (normalised), including face padding. */
export function maskRect(m: Mask, style: MaskStyle) {
  let { x, y, w, h } = m;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  if (m.isAuto && style.padding > 0) {
    // Detector boxes run brow-to-chin; pad more on top to cover hair.
    const p = style.padding / 100;
    x -= w * p; w *= 1 + 2 * p;
    y -= h * p * 1.4; h *= 1 + 2 * p;
  }
  return { x, y, w, h };
}

function renderMask(ctx: CanvasRenderingContext2D, W: number, H: number, m: Mask, style: MaskStyle) {
  const { x, y, w, h } = maskRect(m, style);
  const bx = x * W, by = y * H, bw = w * W, bh = h * H;
  const minSide = Math.min(bw, bh);
  if (minSide < 1) return;

  const s = clamp01(style.strength / 100);
  const featherPx = (clamp01(style.feather / 100) * minSide) / 4;
  const margin = Math.ceil(featherPx);

  // Region the effect is drawn into: the mask plus room for the feather to fade out.
  const rx0 = Math.max(0, Math.floor(bx - margin)), ry0 = Math.max(0, Math.floor(by - margin));
  const rx1 = Math.min(W, Math.ceil(bx + bw + margin)), ry1 = Math.min(H, Math.ceil(by + bh + margin));
  const rw = rx1 - rx0, rh = ry1 - ry0;
  if (rw < 1 || rh < 1) return;

  const fx = getScratch(0, rw, rh);
  if (style.type === "box") {
    fx.x.fillStyle = style.color;
    fx.x.fillRect(0, 0, rw, rh);
  } else if (style.type === "pixelate") {
    // 16 blocks across the face at strength 1, down to 4 at strength 100.
    const block = Math.max(2, minSide / (16 - 12 * s));
    const sw = Math.max(1, Math.round(rw / block)), sh = Math.max(1, Math.round(rh / block));
    const sm = getScratch(1, sw, sh);
    sm.x.drawImage(ctx.canvas, rx0, ry0, rw, rh, 0, 0, sw, sh);
    fx.x.imageSmoothingEnabled = false;
    fx.x.drawImage(sm.c, 0, 0, sw, sh, 0, 0, rw, rh);
  } else {
    // Radius is 3%–30% of the face size, so strength looks the same at any resolution.
    const radius = Math.max(1, minSide * (0.03 + 0.27 * s));
    // Base layer: downscale + smooth upscale. Works in every browser and fills
    // the transparent fringe the filter pass leaves at image borders.
    const f = Math.max(1, radius / 2);
    const sw = Math.max(1, Math.round(rw / f)), sh = Math.max(1, Math.round(rh / f));
    const sm = getScratch(1, sw, sh);
    sm.x.drawImage(ctx.canvas, rx0, ry0, rw, rh, 0, 0, sw, sh);
    fx.x.drawImage(sm.c, 0, 0, sw, sh, 0, 0, rw, rh);
    if (supportsCanvasFilter) {
      // Gaussian pass over a wider source so edges sample real neighbours.
      const pad = Math.ceil(radius * 2);
      const sx0 = Math.max(0, rx0 - pad), sy0 = Math.max(0, ry0 - pad);
      const sx1 = Math.min(W, rx1 + pad), sy1 = Math.min(H, ry1 + pad);
      fx.x.filter = `blur(${radius.toFixed(1)}px)`;
      fx.x.drawImage(ctx.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 - rx0, sy0 - ry0, sx1 - sx0, sy1 - sy0);
      fx.x.filter = "none";
    }
  }

  // Cut the effect to the mask shape, with a soft edge if feathered.
  const al = getScratch(2, rw, rh);
  al.x.fillStyle = "#000";
  if (featherPx > 0.5) {
    // Shadow trick: draw the shape off-canvas and let only its blurred shadow
    // land in place. shadowBlur works everywhere, unlike ctx.filter.
    const off = rw + rh + 100;
    al.x.shadowColor = "#000";
    al.x.shadowBlur = featherPx;
    al.x.shadowOffsetX = off;
    // Grow the shape by half the feather so the mask itself stays mostly opaque.
    const g = featherPx / 2;
    shapePath(al.x, style.shape, bx - rx0 - g - off, by - ry0 - g, bw + 2 * g, bh + 2 * g);
  } else {
    shapePath(al.x, style.shape, bx - rx0, by - ry0, bw, bh);
  }
  al.x.fill();

  fx.x.globalCompositeOperation = "destination-in";
  fx.x.drawImage(al.c, 0, 0, rw, rh, 0, 0, rw, rh);
  fx.x.globalCompositeOperation = "source-over";

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (supportsCanvasFilter) ctx.filter = "none";
  ctx.drawImage(fx.c, 0, 0, rw, rh, rx0, ry0, rw, rh);
  ctx.restore();
}

export function applyMasks(ctx: CanvasRenderingContext2D, W: number, H: number, masks: Mask[], style: MaskStyle = DEFAULT_MASK_STYLE) {
  for (const m of masks) if (!m.off) renderMask(ctx, W, H, m, style);
}
