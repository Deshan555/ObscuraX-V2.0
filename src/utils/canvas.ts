import { Mask, WatermarkConfig } from "../types";
import { WM } from "../constants/config";

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

export function applyMasks(ctx: CanvasRenderingContext2D, W: number, H: number, masks: Mask[]) {
  masks.forEach(m => {
    const x = m.x * W;
    const y = m.y * H;
    const w = m.w * W;
    const h = m.h * H;

    ctx.save();
    if (m.type === "blur") {
      ctx.filter = `blur(${m.blurLevel ?? 12}px)`;
      ctx.drawImage(ctx.canvas, x, y, w, h, x, y, w, h);
    } else if (m.type === "pixelate") {
      const pSize = 24;
      const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h);
      const sw = Math.max(1, Math.floor(rw / pSize));
      const sh = Math.max(1, Math.floor(rh / pSize));
      const offscreen = document.createElement("canvas");
      offscreen.width = sw;
      offscreen.height = sh;
      const offctx = offscreen.getContext("2d")!;
      offctx.drawImage(ctx.canvas, rx, ry, rw, rh, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreen, 0, 0, sw, sh, rx, ry, rw, rh);
      ctx.imageSmoothingEnabled = true;
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.92)";
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  });
}
