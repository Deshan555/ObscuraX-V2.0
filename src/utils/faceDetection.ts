import * as faceapi from "face-api.js";
import { FaceBox, Mask, TrackSample } from "../types";

const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";

let modelPromise: Promise<void> | null = null;

export function loadFaceModels(): Promise<void> {
  modelPromise ??= faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL).catch(err => {
    modelPromise = null; // allow a retry
    throw err;
  });
  return modelPromise;
}

type DetectInput = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

export interface DetectOptions {
  minConfidence: number;
  smallFaceBoost: boolean;
}

/** Frames larger than this (longest side, px) get the tiled small-face pass. */
const TILE_THRESHOLD = 1400;

function mediaSize(input: DetectInput) {
  if (input instanceof HTMLImageElement) return { W: input.naturalWidth, H: input.naturalHeight };
  if (input instanceof HTMLVideoElement) return { W: input.videoWidth, H: input.videoHeight };
  return { W: input.width, H: input.height };
}

let tileCanvas: HTMLCanvasElement | null = null;

/**
 * Detects faces and returns boxes normalised to 0–1.
 *
 * SSD-MobileNet resizes every input to 512px, so small faces in a large frame
 * shrink to a few pixels and get missed. With `smallFaceBoost`, overlapping
 * tiles are also scanned at higher effective resolution and the results merged.
 */
export async function detectFaces(input: DetectInput, opts: DetectOptions): Promise<FaceBox[]> {
  const { W, H } = mediaSize(input);
  if (!W || !H) return [];
  const ssd = new faceapi.SsdMobilenetv1Options({ minConfidence: opts.minConfidence, maxResults: 200 });

  const boxes: FaceBox[] = (await faceapi.detectAllFaces(input, ssd)).map(d => ({
    x: d.box.x / W, y: d.box.y / H, w: d.box.width / W, h: d.box.height / H, score: d.score,
  }));

  if (opts.smallFaceBoost && Math.max(W, H) > TILE_THRESHOLD) {
    const n = Math.max(W, H) > 2800 ? 3 : 2;
    // Tiles overlap by ~30% so a face on a seam is fully inside at least one tile.
    const tw = Math.min(W, Math.ceil((W / n) * 1.3));
    const th = Math.min(H, Math.ceil((H / n) * 1.3));
    tileCanvas ??= document.createElement("canvas");
    tileCanvas.width = tw;
    tileCanvas.height = th;
    const tctx = tileCanvas.getContext("2d")!;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const tx = Math.round(((W - tw) * col) / (n - 1));
        const ty = Math.round(((H - th) * row) / (n - 1));
        tctx.clearRect(0, 0, tw, th);
        tctx.drawImage(input, tx, ty, tw, th, 0, 0, tw, th);
        const dets = await faceapi.detectAllFaces(tileCanvas, ssd);
        for (const d of dets) {
          boxes.push({
            x: (tx + d.box.x) / W, y: (ty + d.box.y) / H,
            w: d.box.width / W, h: d.box.height / H, score: d.score,
          });
        }
      }
    }
  }

  return mergeOverlapping(boxes);
}

function overlap(a: FaceBox, b: FaceBox) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 >= x2 || y1 >= y2) return { iou: 0, contain: 0 };
  const inter = (x2 - x1) * (y2 - y1);
  const aa = a.w * a.h, ab = b.w * b.h;
  return { iou: inter / (aa + ab - inter), contain: inter / Math.min(aa, ab) };
}

/**
 * Collapses duplicate detections (full frame + tiles) into one box each.
 * Overlapping boxes are unioned rather than dropped: when in doubt, cover more.
 */
function mergeOverlapping(boxes: FaceBox[]): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const b of sorted) {
    const k = kept.find(k => { const o = overlap(k, b); return o.iou > 0.3 || o.contain > 0.6; });
    if (!k) { kept.push({ ...b }); continue; }
    const x2 = Math.max(k.x + k.w, b.x + b.w), y2 = Math.max(k.y + k.h, b.y + b.h);
    k.x = Math.min(k.x, b.x); k.y = Math.min(k.y, b.y);
    k.w = x2 - k.x; k.h = y2 - k.y;
  }
  return kept;
}

let idSeq = 0;
export function facesToMasks(boxes: FaceBox[]): Mask[] {
  return boxes.map(b => ({ id: `auto-${++idSeq}`, x: b.x, y: b.y, w: b.w, h: b.h, type: "blur", isAuto: true }));
}

// ── Video tracking ────────────────────────────────────────────────────────────

const center = (b: FaceBox) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 });

/**
 * Pairs faces between two neighbouring samples, closest first. Two boxes match
 * when their centres are within one face-width of each other.
 */
function matchBoxes(a: FaceBox[], b: FaceBox[]) {
  const pairs: { i: number; j: number; d: number }[] = [];
  a.forEach((ba, i) => b.forEach((bb, j) => {
    const ca = center(ba), cb = center(bb);
    const d = Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
    if (d < Math.max(ba.w, ba.h, bb.w, bb.h)) pairs.push({ i, j, d });
  }));
  pairs.sort((p, q) => p.d - q.d);
  const usedA = new Set<number>(), usedB = new Set<number>();
  const matched: [FaceBox, FaceBox][] = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i); usedB.add(p.j);
    matched.push([a[p.i], b[p.j]]);
  }
  return {
    matched,
    onlyA: a.filter((_, i) => !usedA.has(i)),
    onlyB: b.filter((_, j) => !usedB.has(j)),
  };
}

const lerp = (p: number, q: number, k: number) => p + (q - p) * k;

/**
 * Face boxes at time `t`, interpolated between the two surrounding scan samples.
 * Faces seen in only one neighbour are kept for the whole gap, so a face the
 * detector misses in one sample stays covered instead of flashing into view.
 */
export function boxesAt(track: TrackSample[], t: number): FaceBox[] {
  if (!track.length) return [];
  if (t <= track[0].t) return track[0].boxes;
  const last = track[track.length - 1];
  if (t >= last.t) return last.boxes;

  let lo = 0, hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid; else hi = mid;
  }
  const A = track[lo], B = track[hi];
  const k = (t - A.t) / (B.t - A.t);
  const { matched, onlyA, onlyB } = matchBoxes(A.boxes, B.boxes);
  return [
    ...matched.map(([a, b]) => ({
      x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k), score: Math.max(a.score, b.score),
    })),
    ...onlyA,
    ...onlyB,
  ];
}

/** Seeks a video and resolves once the new frame is available. */
export function seekVideo(vid: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); vid.removeEventListener("seeked", done); resolve(); };
    const timer = setTimeout(done, 3000); // some browsers skip "seeked" for no-op seeks
    vid.addEventListener("seeked", done);
    vid.currentTime = t;
  });
}
