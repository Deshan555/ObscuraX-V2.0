// Nudity detection: finds exposed intimate body parts so they can be blurred.
//
// Model: NudeNet 320n (https://github.com/notAI-tech/NudeNet), a YOLOv8n
// detector, licensed AGPL-3.0 (public/models/NUDENET-LICENSE.txt). It runs
// on this device through onnxruntime-web (WebAssembly); nothing is uploaded.
// The model (12 MB) and runtime are only downloaded when the option is turned
// on, then kept by the service worker for offline use.
//
// Pre- and post-processing follow NudeNet's reference implementation
// (nudenet/nudenet.py): pad to a square on the right/bottom, resize to
// 320 × 320 RGB in 0–1, then decode [1, 4 + classes, candidates] with NMS.

import type { InferenceSession } from "onnxruntime-web";
import { FaceBox } from "../types";

/** Output classes, in the model's order. */
const LABELS = [
  "FEMALE_GENITALIA_COVERED", "FACE_FEMALE", "BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED",
  "FEMALE_GENITALIA_EXPOSED", "MALE_BREAST_EXPOSED", "ANUS_EXPOSED", "FEET_EXPOSED",
  "BELLY_COVERED", "FEET_COVERED", "ARMPITS_COVERED", "ARMPITS_EXPOSED",
  "FACE_MALE", "BELLY_EXPOSED", "MALE_GENITALIA_EXPOSED", "ANUS_COVERED",
  "FEMALE_BREAST_COVERED", "BUTTOCKS_COVERED",
] as const;

/** The choices in the panel, and the classes each one blurs. */
export const BODY_PARTS = {
  breasts: { label: "Breasts", classes: ["FEMALE_BREAST_EXPOSED"] },
  genitals: { label: "Genitals", classes: ["FEMALE_GENITALIA_EXPOSED", "MALE_GENITALIA_EXPOSED", "ANUS_EXPOSED"] },
  buttocks: { label: "Buttocks", classes: ["BUTTOCKS_EXPOSED"] },
  chest: { label: "Male chest", classes: ["MALE_BREAST_EXPOSED"] },
} as const;
export type BodyPart = keyof typeof BODY_PARTS;
export type BodyPartChoice = Record<BodyPart, boolean>;
export const DEFAULT_BODY_PARTS: BodyPartChoice = { breasts: true, genitals: true, buttocks: true, chest: false };

/** Name shown in the list of blurred areas, per class. */
export const PART_NAMES: Record<string, string> = {
  FEMALE_BREAST_EXPOSED: "Breast",
  FEMALE_GENITALIA_EXPOSED: "Genitals",
  MALE_GENITALIA_EXPOSED: "Genitals",
  ANUS_EXPOSED: "Anus",
  BUTTOCKS_EXPOSED: "Buttocks",
  MALE_BREAST_EXPOSED: "Chest",
};

/** Classes to look for, from the panel's choices. */
export const classesFor = (choice: BodyPartChoice) =>
  new Set<string>((Object.keys(BODY_PARTS) as BodyPart[]).filter(p => choice[p]).flatMap(p => BODY_PARTS[p].classes));

const MODEL_URL = `${import.meta.env.BASE_URL}models/nudenet-320n.onnx`;
const SIZE = 320;
/** NudeNet keeps candidates from 0.2 and runs NMS at 0.25 / IoU 0.45. */
const NMS_IOU = 0.45;

type Ort = typeof import("onnxruntime-web/wasm");
let loading: Promise<{ ort: Ort; session: InferenceSession }> | null = null;

/** Loads the runtime and model (once). Rejects if they can't be downloaded. */
export function loadBodyModel(): Promise<void> {
  loading ??= (async () => {
    const [ort, wasm, mjs] = await Promise.all([
      import("onnxruntime-web/wasm"),
      import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url"),
      import("onnxruntime-web/ort-wasm-simd-threaded.mjs?url"),
    ]);
    // Served from this app (bundled by Vite), not a CDN, so it works offline.
    ort.env.wasm.wasmPaths = { wasm: wasm.default, mjs: mjs.default };
    // Threads need cross-origin isolation headers, which most static hosts don't send.
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return { ort, session };
  })();
  loading.catch(() => { loading = null; });
  return loading.then(() => undefined);
}

type DetectInput = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

function mediaSize(input: DetectInput) {
  if (input instanceof HTMLImageElement) return { W: input.naturalWidth, H: input.naturalHeight };
  if (input instanceof HTMLVideoElement) return { W: input.videoWidth, H: input.videoHeight };
  return { W: input.width, H: input.height };
}

const iou = (a: number[], b: number[]) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
};

/**
 * Finds the chosen intimate parts. Boxes are normalised to 0–1 and carry the
 * NudeNet class in `part`. `minScore` is the confidence threshold (lower finds more).
 */
export async function detectBodyParts(input: DetectInput, minScore: number, classes: ReadonlySet<string>): Promise<FaceBox[]> {
  const { W, H } = mediaSize(input);
  if (!W || !H || !classes.size) return [];
  await loadBodyModel();
  const { ort, session } = await loading!;

  // Pad to a square on the right and bottom (black), then scale to 320 × 320.
  const side = Math.max(W, H), k = SIZE / side;
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(input, 0, 0, W * k, H * k);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  c.width = 0;

  const plane = SIZE * SIZE, data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    data[i] = px[i * 4] / 255;
    data[plane + i] = px[i * 4 + 1] / 255;
    data[2 * plane + i] = px[i * 4 + 2] / 255;
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]) });
  const t = out[session.outputNames[0]];
  const [, ch, n] = t.dims as number[];
  const d = t.data as Float32Array;

  // Each candidate j: d[0..3][j] = centre x, centre y, w, h (model pixels); d[4..][j] = class scores.
  const found: { box: number[]; score: number; part: string }[] = [];
  const scale = side / SIZE;
  for (let j = 0; j < n; j++) {
    let best = 0, cls = -1;
    for (let c2 = 4; c2 < ch; c2++) { const s = d[c2 * n + j]; if (s > best) { best = s; cls = c2 - 4; } }
    const part = LABELS[cls];
    if (best < minScore || !part || !classes.has(part)) continue;
    const w = d[2 * n + j] * scale, h = d[3 * n + j] * scale;
    let x = d[j] * scale - w / 2, y = d[n + j] * scale - h / 2;
    x = Math.max(0, Math.min(x, W)); y = Math.max(0, Math.min(y, H));
    found.push({ box: [x, y, Math.min(w, W - x), Math.min(h, H - y)], score: best, part });
  }

  // Non-maximum suppression, highest score first.
  found.sort((a, b) => b.score - a.score);
  const kept: typeof found = [];
  for (const f of found) if (!kept.some(k2 => iou(k2.box, f.box) > NMS_IOU)) kept.push(f);

  return kept.map(f => ({ x: f.box[0] / W, y: f.box[1] / H, w: f.box[2] / W, h: f.box[3] / H, score: f.score, part: f.part }));
}
