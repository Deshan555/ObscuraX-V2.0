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

export function overlap(a: Pick<FaceBox, "x" | "y" | "w" | "h">, b: Pick<FaceBox, "x" | "y" | "w" | "h">) {
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
/** Video boxes keep their track id (`track-<id>`) so a face is the same item in every frame. */
export function facesToMasks(boxes: FaceBox[]): Mask[] {
  return boxes.map(b => ({
    id: b.id != null ? `track-${b.id}` : `auto-${++idSeq}`,
    x: b.x, y: b.y, w: b.w, h: b.h, type: "blur", isAuto: true, score: b.score,
  }));
}

/** Square JPEG thumbnail of a face, with some margin, from the unmasked source. */
export function cropThumb(source: HTMLImageElement | HTMLVideoElement, box: Pick<FaceBox, "x" | "y" | "w" | "h">, size = 72): string {
  const W = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const H = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  const side = Math.max(box.w * W, box.h * H) * 1.35;
  const cx = (box.x + box.w / 2) * W, cy = (box.y + box.h / 2) * H;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d")!.drawImage(source, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.8);
}

// ── Video tracking ────────────────────────────────────────────────────────────

const center = (b: FaceBox) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 });

/**
 * Pairs faces between two neighbouring samples, closest first. Two boxes match
 * when their centres are within one face-width of each other.
 */
function matchBoxes(a: FaceBox[], b: FaceBox[], reach = 1) {
  const pairs: { i: number; j: number; d: number }[] = [];
  a.forEach((ba, i) => b.forEach((bb, j) => {
    const ca = center(ba), cb = center(bb);
    const d = Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
    // Linked boxes match only their own track; otherwise match by distance.
    const ok = ba.id != null && bb.id != null ? ba.id === bb.id : d < Math.max(ba.w, ba.h, bb.w, bb.h) * reach;
    if (ok) pairs.push({ i, j, d });
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
      x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k), score: Math.max(a.score, b.score), id: a.id,
    })),
    ...onlyA,
    ...onlyB,
  ];
}

/**
 * Links detections into tracks while a video is scanned: a box near a face
 * seen in the last `maxGap` seconds gets that face's id, otherwise a new one.
 */
export function createTrackLinker(maxGap = 1) {
  let next = 1;
  const live: { id: number; box: FaceBox; t: number }[] = [];
  return (t: number, boxes: FaceBox[]): { boxes: FaceBox[]; newIds: number[] } => {
    const recent = live.filter(tr => t - tr.t <= maxGap);
    const prevBoxes: FaceBox[] = recent.map(tr => ({ ...tr.box, id: undefined }));
    const { matched, onlyB } = matchBoxes(prevBoxes, boxes, 1.5);
    const newIds: number[] = [];
    const out: FaceBox[] = [];
    for (const [prev, cur] of matched) {
      const tr = recent[prevBoxes.indexOf(prev)];
      tr.box = cur; tr.t = t;
      out.push({ ...cur, id: tr.id });
    }
    for (const cur of onlyB) {
      const id = next++;
      live.push({ id, box: cur, t });
      newIds.push(id);
      out.push({ ...cur, id });
    }
    return { boxes: out, newIds };
  };
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
