import { WatermarkConfig, Mask } from "../types";
import { WM } from "../constants/config";

export function applyWatermark(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  config: WatermarkConfig
) {
  const {
    wmType,
    wmText,
    wmLink,
    wmColor,
    wmFont,
    wmSize,
    wmOpacity,
    wmBold,
    wmShadow,
    wmPos,
    wmImgEl,
  } = config;

  ctx.save();
  ctx.globalAlpha = wmOpacity / 100;

  if (wmShadow) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
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
    // Underline decoration for link type
    if (wmType === WM.LINK) {
      const mw = ctx.measureText(content).width;
      const ulY = wy + wmSize * 0.62;
      ctx.fillRect(wx - mw / 2, ulY, mw, Math.max(1.5, wmSize * 0.055));
    }
    ctx.fillText(content, wx, wy);
  } else if (wmType === WM.IMG && wmImgEl) {
    const ratio = wmImgEl.naturalHeight / wmImgEl.naturalWidth;
    const iw = wmSize * 5;
    const ih = iw * ratio;
    ctx.drawImage(wmImgEl, wx - iw / 2, wy - ih / 2, iw, ih);
  }

  ctx.restore();
}

export function applyMasks(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  masks: Mask[]
) {
  masks.forEach((m) => {
    const x = m.x * W;
    const y = m.y * H;
    const w = m.w * W;
    const h = m.h * H;

    ctx.save();
    if (m.type === "blur") {
      ctx.filter = "blur(12px)";
      ctx.drawImage(ctx.canvas, x, y, w, h, x, y, w, h);
    } else if (m.type === "pixelate") {
      const pSize = 24;
      const rx = Math.round(x),
        ry = Math.round(y),
        rw = Math.round(w),
        rh = Math.round(h);
      const sw = Math.max(1, Math.floor(rw / pSize));
      const sh = Math.max(1, Math.floor(rh / pSize));
      const off = document.createElement("canvas");
      off.width = sw;
      off.height = sh;
      const octx = off.getContext("2d");
      if (octx) {
        octx.drawImage(ctx.canvas, rx, ry, rw, rh, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, sw, sh, rx, ry, rw, rh);
        ctx.imageSmoothingEnabled = true;
      }
    } else {
      // box
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  });
}
