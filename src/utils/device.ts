// What this device can handle. Phones have far less memory than desktops, and
// iOS Safari refuses to draw into a canvas larger than 16.7 MP (it stays blank).

const nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator;

export const isIOS = !!nav && (/iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1));

export const isTouch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

const memoryGb = (nav as Navigator & { deviceMemory?: number } | undefined)?.deviceMemory;

/** Phones, tablets and low-RAM machines: keep canvases small. */
export const lowMemory = isIOS || (memoryGb != null ? memoryGb <= 4 : isTouch);

/** Largest canvas this browser can reliably draw into and encode. */
export const CANVAS_MAX_PIXELS = isIOS ? 16_777_216 : lowMemory ? 33_554_432 : 50_000_000;
export const CANVAS_MAX_SIDE = 16384;

/** The on-screen preview is redrawn on every change, so it stays smaller on phones. */
export const PREVIEW_MAX_PIXELS = lowMemory ? 8_000_000 : CANVAS_MAX_PIXELS;

/** Factor (≤ 1) that shrinks a w × h image to fit `maxPixels` and the side limit. */
export function scaleToFit(w: number, h: number, maxPixels: number): number {
  if (!w || !h) return 1;
  return Math.min(1, CANVAS_MAX_SIDE / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
}
