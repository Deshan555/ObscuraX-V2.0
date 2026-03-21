import { ImageEntry } from "../types";

export function detectImageResolution(file: File): Promise<{ w: number; h: number }> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

export function normalizeMask(x: number, y: number, w: number, h: number) {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

export function getCursorPos(
  e: React.MouseEvent | React.TouchEvent,
  canvas: HTMLCanvasElement
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const cx = "touches" in e ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
  const cy = "touches" in e ? (e as React.TouchEvent).touches[0].clientY : (e as React.MouseEvent).clientY;
  return {
    x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)),
  };
}

export async function buildImageEntries(
  incoming: File[],
  existing: ImageEntry[],
  maxFiles: number,
  onError: (msg: string) => void
): Promise<ImageEntry[]> {
  const combined = [...existing, ...incoming].slice(0, maxFiles);
  if (existing.length + incoming.length > maxFiles) {
    onError(`Maximum ${maxFiles} images allowed. Extra files were ignored.`);
  }
  return Promise.all(
    combined.map(async (item): Promise<ImageEntry> => {
      if ("src" in item) return item as ImageEntry;
      const { w, h } = await detectImageResolution(item as File);
      return { file: item as File, src: URL.createObjectURL(item as File), w, h };
    })
  );
}
