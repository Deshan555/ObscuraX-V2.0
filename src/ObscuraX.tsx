import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import JSZip from "jszip/dist/jszip.min.js";

import { ImageEntry, BulkProgress, WatermarkConfig, Mask, MaskStyle, DetectSettings, TrackSample, TrackInfo } from "./types";
import { WM, PRESETS, FONTS, PALETTE, MAX_FILES, FILTERS, DEFAULT_MASK_STYLE, DEFAULT_DETECT_SETTINGS } from "./constants/config";
import { applyWatermark, applyMasks, maskRect, resolveFilter, drawFiltered, filterPreviewCss } from "./utils/canvas";
import { loadFaceModels, detectFaces, facesToMasks, boxesAt, seekVideo, overlap, cropThumb, createTrackLinker } from "./utils/faceDetection";
import { upscaleImage, upscaledSize, fitScale, UPSCALE_FACTORS, UPSCALE_MAX_PIXELS } from "./utils/upscale";
import { scaleToFit, PREVIEW_MAX_PIXELS, CANVAS_MAX_PIXELS, isTouch } from "./utils/device";
import { usePwa, useOnline, applyUpdate, dismissUpdate, clearOfflineReady } from "./pwa";
import { useHistory } from "./hooks/useHistory";
import {
  loadPrefs, savePrefs, Prefs, loadSession, saveSession, clearSession, saveLogo, loadLogo,
  LoadedSession, Session, SavedVideo, MAX_SAVED_VIDEO_BYTES,
} from "./utils/session";
import { detectImageResolution } from "./helpers/media";
import { Field, TextInput, Select, SwitchRow, Range, Seg, ArmedBtn, Spinner, Progress, Modal } from "./components/common/Atoms";
import { useTheme } from "./hooks/useTheme";
import {
  Type, ScanFace, SlidersHorizontal, Eye, EyeOff, Trash2, SquareDashed, Download, Upload, ImagePlus, Plus, Minus, Maximize, Sun, Moon, Monitor, Play, Pause, Volume2, VolumeX, X, Check, FileJson,
  WifiOff, ChevronDown, Share2, RefreshCw, Undo2, Redo2, History, Square,
  ArrowUpLeft, ArrowUp, ArrowUpRight, ArrowLeft, Dot, ArrowRight, ArrowDownLeft, ArrowDown, ArrowDownRight, LucideIcon,
} from "lucide-react";

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const el = new Image();
  el.onload = () => resolve(el);
  el.onerror = reject;
  el.src = src;
});

/** Lets React paint (e.g. a progress message) before a long synchronous render. */
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

const canvasBlob = (c: HTMLCanvasElement, type: string) => new Promise<Blob | null>(res => c.toBlob(res, type, 0.96));

const baseName = (name: string) => name.replace(/\.[^.]+$/, "");

/** Saves a file through the browser's download, and returns it for sharing. */
function downloadBlob(blob: Blob, name: string): File {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  // Some mobile browsers read the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return new File([blob], name, { type: blob.type });
}

/** Phones and tablets can hand a file to the share sheet ("Save Image" puts it in Photos). */
const canShareFile = (f: File) => isTouch && typeof navigator.canShare === "function" && navigator.canShare({ files: [f] });

/** Video formats MediaRecorder may support, best first. Safari records MP4 only. */
const RECORD_TYPES = [
  { mime: "video/webm;codecs=vp9,opus", ext: "webm", audio: true },
  { mime: "video/webm;codecs=vp8,opus", ext: "webm", audio: true },
  { mime: "video/webm;codecs=vp9", ext: "webm", audio: false },
  { mime: "video/webm;codecs=vp8", ext: "webm", audio: false },
  { mime: "video/webm", ext: "webm", audio: true },
  { mime: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4", audio: true },
  { mime: "video/mp4;codecs=avc1", ext: "mp4", audio: false },
  { mime: "video/mp4", ext: "mp4", audio: true },
];
const recordType = (withAudio = true) => typeof MediaRecorder === "undefined" ? null
  : RECORD_TYPES.find(t => (!withAudio || t.audio) && MediaRecorder.isTypeSupported(t.mime)) ?? null;

/** Fallback for crypto.randomUUID, which only exists on HTTPS / localhost. */
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const MODEL_MISSING_MSG = "The face model hasn't loaded, so faces can't be found. Wait a moment, or turn off Find faces automatically, before exporting.";

/** Phone layout (see index.css): the panel sits under the image and can be hidden. */
const isPhoneLayout = () => window.matchMedia("(max-width: 760px)").matches;

type TrackStatus = "idle" | "scanning" | "ready" | "stale";

type Tool = "mask" | "watermark" | "adjust";
const TOOLS: { id: Tool; label: string; key: string; Icon: LucideIcon }[] = [
  { id: "mask", label: "Face blur", key: "F", Icon: ScanFace },
  { id: "watermark", label: "Watermark", key: "W", Icon: Type },
  { id: "adjust", label: "Adjust", key: "A", Icon: SlidersHorizontal },
];

const POSITION_ICONS: Record<string, { Icon: LucideIcon; label: string }> = {
  tl: { Icon: ArrowUpLeft, label: "Top left" }, tc: { Icon: ArrowUp, label: "Top centre" }, tr: { Icon: ArrowUpRight, label: "Top right" },
  ml: { Icon: ArrowLeft, label: "Middle left" }, cc: { Icon: Dot, label: "Centre" }, mr: { Icon: ArrowRight, label: "Middle right" },
  bl: { Icon: ArrowDownLeft, label: "Bottom left" }, bc: { Icon: ArrowDown, label: "Bottom centre" }, br: { Icon: ArrowDownRight, label: "Bottom right" },
};

/** Video face masks are `track-<id>`; returns the id, or null for other masks. */
const trackIdOf = (maskId: string) => (maskId.startsWith("track-") ? Number(maskId.slice(6)) : null);

/** New auto masks for an image; faces the user turned off stay off when detection reruns. */
function mergeAutoMasks(prev: Mask[], autos: Mask[]): Mask[] {
  const offBefore = prev.filter(m => m.isAuto && m.off);
  const merged = autos.map(a => offBefore.some(o => { const ov = overlap(a, o); return ov.iou > 0.3 || ov.contain > 0.6; }) ? { ...a, off: true } : a);
  return [...merged, ...prev.filter(m => !m.isAuto)];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "5 minutes ago", "yesterday"… for the saved-session card. */
function timeAgo(t: number) {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const sec = (t - Date.now()) / 1000;
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  return "just now";
}

/** Saved preferences, read once at startup so the first render already uses them. */
const PREFS = loadPrefs();

type Box = Pick<Mask, "x" | "y" | "w" | "h">;
/** What undo / redo restores: the user's own edits, never detection results. */
interface EditSnapshot {
  wm: Pick<Prefs, "wmType" | "wmText" | "wmLink" | "wmColor" | "wmFont" | "wmSize" | "wmOpacity" | "wmBold" | "wmShadow" | "wmPos" | "activePreset" | "wmFilter" | "wmBlur">;
  maskStyle: MaskStyle;
  /** Per image id: drawn areas, and where the faces turned off are (faces are matched by position). */
  images: Record<string, { drawn: Mask[]; off: Box[]; faces: number }>;
  video: { drawn: Mask[]; hidden: number[]; tracked: boolean } | null;
}
const sameFace = (a: Box, b: Box) => { const o = overlap(a, b); return o.iou > 0.3 || o.contain > 0.6; };
const fmtTime = (t: number) => Number.isFinite(t) ? `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}` : "–:––";

export default function ObscuraX() {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [imgReady, setImgReady] = useState(false);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(true);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  // The video's sound goes through Web Audio once a recording has started (see routeAudio).
  const [audioRouted, setAudioRouted] = useState(false);

  const [mode, setMode] = useState<"image" | "video" | null>(null);
  // Last visit's work, offered back on the start screen until opened or discarded.
  const [savedSession, setSavedSession] = useState<LoadedSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [fileError, setFileError] = useState("");

  const [wmType, setWmType] = useState<typeof WM[keyof typeof WM]>(() => (PREFS.wmType as typeof WM[keyof typeof WM]) ?? WM.TEXT);
  const [wmText, setWmText] = useState(PREFS.wmText ?? "© Your Brand");
  const [wmLink, setWmLink] = useState(PREFS.wmLink ?? "https://yourbrand.com");
  const [wmImgFile, setWmImgFile] = useState<File | null>(null);
  const [wmColor, setWmColor] = useState(PREFS.wmColor ?? "#ffffff");
  const [wmFont, setWmFont] = useState(PREFS.wmFont ?? FONTS[0].value);
  const [wmSize, setWmSize] = useState(PREFS.wmSize ?? 44);
  const [wmOpacity, setWmOpacity] = useState(PREFS.wmOpacity ?? 75);
  const [wmBold, setWmBold] = useState(PREFS.wmBold ?? false);
  const [wmShadow, setWmShadow] = useState(PREFS.wmShadow ?? true);
  const [wmPos, setWmPos] = useState(PREFS.wmPos ?? { x: 0.5, y: 0.93 });
  const [wmFilter, setWmFilter] = useState(PREFS.wmFilter ?? "none");
  const [wmBlur, setWmBlur] = useState(PREFS.wmBlur ?? 4);
  const [exportPrefix, setExportPrefix] = useState(PREFS.exportPrefix ?? "watermarked_");
  // Export-only: images are enlarged by this factor, then sharpened (0–100).
  const [upscaleFactor, setUpscaleFactor] = useState<number>(() => (UPSCALE_FACTORS as readonly number[]).includes(PREFS.upscaleFactor ?? 1) ? PREFS.upscaleFactor ?? 1 : 1);
  const [upscaleSharpen, setUpscaleSharpen] = useState(PREFS.upscaleSharpen ?? 40);

  // Image mode: mirror of the selected image's masks. Video mode: manual masks only
  // (auto face masks come from faceTrack, per frame).
  const [masks, setMasks] = useState<Mask[]>([]);
  const [maskStyle, setMaskStyle] = useState<MaskStyle>(PREFS.maskStyle ?? DEFAULT_MASK_STYLE);
  const [detectSettings, setDetectSettings] = useState<DetectSettings>(PREFS.detectSettings ?? DEFAULT_DETECT_SETTINGS);
  // Face blur on/off (auto-detection and export scanning). Independent of the active tool.
  const [maskingMode, setMaskingMode] = useState(true);
  const [tool, setTool] = useState<Tool>("mask");
  const [activePreset, setActivePreset] = useState<string | null>(PREFS.activePreset !== undefined ? PREFS.activePreset : "bc");
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [autoMaskEnabled, setAutoMaskEnabled] = useState(true);
  const [faceTrack, setFaceTrack] = useState<TrackSample[]>([]);
  const [trackInfo, setTrackInfo] = useState<TrackInfo[]>([]);
  const [hiddenTracks, setHiddenTracks] = useState<number[]>([]);
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);
  const [hoverMaskId, setHoverMaskId] = useState<string | null>(null);
  const [trackStatus, setTrackStatus] = useState<TrackStatus>("idle");
  const [scan, setScan] = useState<{ label: string; pct: number } | null>(null);
  const scanToken = useRef(0);
  const drawingId = useRef<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [expPct, setExpPct] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // A just-exported file the share sheet can take (phones: save to Photos, send to an app).
  const [shareFile, setShareFile] = useState<File | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((msg: string, file?: File) => {
    setToastMsg(msg);
    setShareFile(file && canShareFile(file) ? file : null);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => { setToastMsg(null); setShareFile(null); }, file ? 8000 : 2600);
  }, []);
  const shareExport = async () => {
    if (!shareFile) return;
    try { await navigator.share({ files: [shareFile] }); }
    catch (err) { if ((err as Error).name !== "AbortError") console.warn("ObscuraX: share failed:", err); }
    setToastMsg(null); setShareFile(null);
  };
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const vidElRef = useRef<HTMLVideoElement | null>(null);
  const wmImgEl = useRef<HTMLImageElement | null>(null);
  const animRef = useRef<number | null>(null);
  const dragging = useRef(false);
  const maskStart = useRef<{ x: number; y: number } | null>(null);
  // canvasDims is the media's real size; the canvas itself may be smaller
  // (previewScale) so phones aren't asked for more than they can draw.
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });
  const naturalW = useRef(0);
  const previewScale = useRef(1);

  useEffect(() => {
    loadFaceModels()
      .then(() => setModelsLoaded(true))
      .catch(err => { console.error("ObscuraX: Failed to load face model:", err); setModelError(true); });
  }, []);

  useEffect(() => {
    if (!wmImgFile) { wmImgEl.current = null; return; }
    const url = URL.createObjectURL(wmImgFile);
    const img = new Image();
    img.onload = () => { wmImgEl.current = img; };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [wmImgFile]);

  useEffect(() => {
    if (mode === "image" && images[selectedIdx]) {
      setMasks(images[selectedIdx].masks || []);
    }
  }, [selectedIdx, images, mode]);

  useEffect(() => {
    setImgReady(false);
  }, [selectedIdx, images[selectedIdx]?.src, mode]);

  // Stable id of the open video, for the saved session; and a saved video's
  // masks and face track to put back once it loads.
  const videoId = useRef<string | null>(null);
  const restoreVideo = useRef<SavedVideo | null>(null);
  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoSrc(url); setVideoReady(false); setAudioRouted(false);
    // New video: drop the previous video's masks and face track (or restore the
    // saved ones), and cancel any scan.
    scanToken.current++;
    const r = restoreVideo.current;
    restoreVideo.current = null;
    setMasks(r?.masks ?? []); setFaceTrack(r?.faceTrack ?? []); setTrackInfo(r?.trackInfo ?? []); setHiddenTracks(r?.hiddenTracks ?? []);
    setTrackStatus(r && (r.trackStatus === "ready" || r.trackStatus === "stale") ? r.trackStatus : "idle");
    setScan(null);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const wmConfig = useCallback((): WatermarkConfig => ({
    wmType, wmText, wmLink, wmColor, wmFont, wmSize,
    wmOpacity, wmBold, wmShadow, wmPos,
    wmImgEl: wmImgEl.current,
    wmFilter,
    wmBlur,
  }), [wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter, wmBlur]);

  /** Face masks at time t of the video; faces the user turned off come back with `off`. */
  const videoFaceMasks = useCallback((t: number) => facesToMasks(boxesAt(faceTrack, t)).map(m => {
    const tid = trackIdOf(m.id);
    return tid != null && hiddenTracks.includes(tid) ? { ...m, off: true } : m;
  }), [faceTrack, hiddenTracks]);

  const draw = useCallback(() => {
    const cvs = canvasRef.current;
    const med = mode === "video" ? vidElRef.current : imgElRef.current;
    const ready = mode === "video" ? videoReady : imgReady;
    if (!cvs || !med || !ready) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    // Pixel sizes are in media pixels; scale them to the (possibly smaller) preview canvas.
    const base = wmConfig(), ps = previewScale.current;
    const cfg = ps === 1 ? base : { ...base, wmSize: base.wmSize * ps, wmBlur: base.wmBlur * ps };
    drawFiltered(ctx, med, cvs.width, cvs.height, resolveFilter(cfg.wmFilter, cfg.wmBlur, cvs.width, cvs.height));
    let active = masks;
    if (mode === "video" && autoMaskEnabled && faceTrack.length) {
      active = [...videoFaceMasks((med as HTMLVideoElement).currentTime), ...masks];
    }
    applyMasks(ctx, cvs.width, cvs.height, active, maskStyle);
    applyWatermark(ctx, cvs.width, cvs.height, cfg);
  }, [mode, imgReady, videoReady, wmConfig, masks, autoMaskEnabled, faceTrack, maskStyle, videoFaceMasks]);

  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; }, [draw]);

  useEffect(() => { if (mode === "image" && imgReady) draw(); }, [draw, mode, imgReady]);
  // A paused video has no render loop; redraw when settings or masks change.
  useEffect(() => { if (mode === "video" && videoReady && videoPaused) draw(); }, [draw, mode, videoReady, videoPaused]);

  useEffect(() => {
    if (mode !== "video" || !videoReady || videoPaused) return;
    const loop = () => {
      if (vidElRef.current) setVideoTime(vidElRef.current.currentTime);
      draw();
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [draw, mode, videoReady, videoPaused]);

  useEffect(() => {
    const vid = vidElRef.current;
    if (!vid) return;
    if (videoPaused) vid.pause(); else vid.play();
  }, [videoPaused]);

  // ── Face detection ──────────────────────────────────────────────────────────
  const { minConfidence, smallFaceBoost } = detectSettings;
  const detectOpts = useMemo(() => ({ minConfidence, smallFaceBoost }), [minConfidence, smallFaceBoost]);

  /** Applies a mask change to the selected image (image mode) or the video's manual masks. */
  const updateMasks = useCallback((fn: (prev: Mask[]) => Mask[]) => {
    if (mode === "image") setImages(prev => prev.map((img, i) => i === selectedIdx ? { ...img, masks: fn(img.masks) } : img));
    else setMasks(fn);
  }, [mode, selectedIdx]);

  /** Replaces auto masks on an image. Keyed by src because indices can shift while detection runs. */
  const setAutoMasks = useCallback((src: string, autos: Mask[]) => {
    setImages(prev => prev.map(img => img.src === src
      ? { ...img, scanned: true, masks: mergeAutoMasks(img.masks, autos) }
      : img));
  }, []);

  const updateDetectSettings = useCallback((patch: Partial<DetectSettings>) => {
    setDetectSettings(prev => ({ ...prev, ...patch }));
    // Images re-detect lazily (on view or export); video waits for an explicit rescan.
    if ("minConfidence" in patch || "smallFaceBoost" in patch) setImages(prev => prev.map(img => ({ ...img, scanned: false })));
    setTrackStatus(s => (s === "ready" ? "stale" : s));
  }, []);

  // Detect faces on the selected image whenever it hasn't been scanned with the current settings.
  const activeSrc = mode === "image" ? images[selectedIdx]?.src : undefined;
  const activeScanned = mode === "image" && !!images[selectedIdx]?.scanned;
  useEffect(() => {
    if (!modelsLoaded || !maskingMode || !autoMaskEnabled || !activeSrc || activeScanned) return;
    let cancelled = false;
    // Debounced so dragging the sensitivity slider doesn't queue a detection per tick.
    const timer = setTimeout(async () => {
      try {
        const boxes = await detectFaces(await loadImage(activeSrc), detectOpts);
        if (!cancelled) setAutoMasks(activeSrc, facesToMasks(boxes));
      } catch (err) {
        console.error("ObscuraX: Detection error:", err);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [modelsLoaded, maskingMode, autoMaskEnabled, activeSrc, activeScanned, detectOpts, setAutoMasks]);

  const unscannedCount = images.filter(img => !img.scanned).length;

  const detectAllImages = useCallback(async () => {
    if (!modelsLoaded) return;
    const todo = images.filter(img => !img.scanned);
    for (let i = 0; i < todo.length; i++) {
      setScan({ label: `Finding faces in image ${i + 1} of ${todo.length}…`, pct: Math.round((i / todo.length) * 100) });
      try {
        const boxes = await detectFaces(await loadImage(todo[i].src), detectOpts);
        setAutoMasks(todo[i].src, facesToMasks(boxes));
      } catch (err) {
        console.error("ObscuraX: Detection error:", err);
      }
    }
    setScan(null);
  }, [modelsLoaded, images, detectOpts, setAutoMasks]);

  // ── Video face tracking ─────────────────────────────────────────────────────
  /**
   * Samples the video at `scanFps`, detects faces in each sample, and stores the
   * result as a track. Rendering interpolates between samples so masks follow
   * moving faces. Resolves false if cancelled or failed.
   */
  const scanVideo = useCallback(async (): Promise<boolean> => {
    const vid = vidElRef.current;
    if (!modelsLoaded || !vid || !Number.isFinite(vid.duration) || vid.duration <= 0) return false;
    const token = ++scanToken.current;
    const wasPlaying = !vid.paused;
    const t0 = vid.currentTime;
    vid.pause(); setVideoPaused(true);
    setTrackStatus("scanning");
    const fps = detectSettings.scanFps;
    const lastT = Math.max(0, vid.duration - 0.05);
    const n = Math.max(2, Math.ceil(lastT * fps) + 1);
    const samples: TrackSample[] = [];
    const link = createTrackLinker();
    const info = new Map<number, TrackInfo>();
    try {
      for (let i = 0; i < n; i++) {
        if (token !== scanToken.current) return false;
        const t = Math.min(i / fps, lastT);
        if (samples.length && t <= samples[samples.length - 1].t) continue;
        await seekVideo(vid, t);
        if (token !== scanToken.current) return false;
        const { boxes } = link(t, await detectFaces(vid, detectOpts));
        for (const b of boxes) {
          const ti = info.get(b.id!);
          if (ti) { ti.samples++; ti.score = Math.max(ti.score, b.score); }
          else info.set(b.id!, { id: b.id!, thumb: cropThumb(vid, b), score: b.score, samples: 1, firstT: t, firstBox: b });
        }
        samples.push({ t, boxes });
        setScan({ label: `Tracking faces… ${i + 1} of ${n}`, pct: Math.round(((i + 1) / n) * 100) });
      }
    } catch (err) {
      console.error("ObscuraX: Video scan failed:", err);
      if (token === scanToken.current) { setTrackStatus("stale"); setScan(null); }
      return false;
    }
    if (token !== scanToken.current) return false;
    // Faces turned off before a rescan stay off: find the face now at the same place and time.
    const carried = trackInfo.filter(ti => hiddenTracks.includes(ti.id)).flatMap(old => {
      const hit = boxesAt(samples, old.firstT).find(b => { const o = overlap(b, old.firstBox); return o.iou > 0.3 || o.contain > 0.6; });
      return hit?.id != null ? [hit.id] : [];
    });
    setFaceTrack(samples); setTrackInfo([...info.values()]); setHiddenTracks([...new Set(carried)]);
    setTrackStatus("ready"); setScan(null);
    await seekVideo(vid, t0);
    if (wasPlaying) setVideoPaused(false);
    return true;
  }, [modelsLoaded, detectSettings.scanFps, detectOpts, trackInfo, hiddenTracks]);

  const cancelScan = () => {
    scanToken.current++;
    setScan(null);
    setTrackStatus("stale");
  };

  useEffect(() => {
    if (mode === "video" && videoReady && modelsLoaded && maskingMode && autoMaskEnabled && trackStatus === "idle") scanVideo();
  }, [mode, videoReady, modelsLoaded, maskingMode, autoMaskEnabled, trackStatus, scanVideo]);

  const toggleAutoMask = (val: boolean) => {
    setAutoMaskEnabled(val);
    if (!val) {
      // Off means no auto masks anywhere, including images not currently shown.
      setImages(prev => prev.map(img => ({ ...img, scanned: false, masks: img.masks.filter(m => !m.isAuto) })));
    } else if (mode === "video" && !faceTrack.length) {
      setTrackStatus("idle");
    }
  };

  const clearAllMasks = () => {
    markEdit();
    if (mode === "image") updateMasks(() => []);
    else { scanToken.current++; setScan(null); setMasks([]); setFaceTrack([]); setTrackInfo([]); setHiddenTracks([]); setTrackStatus("ready"); }
  };

  const onImgLoad = useCallback((el: HTMLImageElement) => {
    if (!el || !canvasRef.current) return;
    const s = scaleToFit(el.naturalWidth, el.naturalHeight, PREVIEW_MAX_PIXELS);
    previewScale.current = s; naturalW.current = el.naturalWidth;
    canvasRef.current.width = Math.round(el.naturalWidth * s);
    canvasRef.current.height = Math.round(el.naturalHeight * s);
    imgElRef.current = el;
    setCanvasDims({ w: el.naturalWidth, h: el.naturalHeight });
    setImgReady(true);
  }, []);

  const onVideoLoad = useCallback((el: HTMLVideoElement) => {
    if (!el || !canvasRef.current) return;
    const w = el.videoWidth || 1280, h = el.videoHeight || 720;
    // The recording is taken from this canvas, so it stays full size where the device allows.
    const s = scaleToFit(w, h, CANVAS_MAX_PIXELS);
    previewScale.current = s; naturalW.current = w;
    canvasRef.current.width = Math.round(w * s); canvasRef.current.height = Math.round(h * s);
    vidElRef.current = el;
    setCanvasDims({ w, h });
    const ready = (dur: number) => { setVideoDur(dur); setVideoReady(true); };
    if (Number.isFinite(el.duration)) { ready(el.duration); return; }
    // WebM recorded in a browser (MediaRecorder, including this app's own exports)
    // has no duration in its header. Seeking far past the end makes the browser
    // work it out; then go back to the start.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("durationchange", onDur);
      clearTimeout(timer);
      el.currentTime = 0;
      ready(Number.isFinite(el.duration) ? el.duration : 0);
    };
    const onDur = () => { if (Number.isFinite(el.duration)) settle(); };
    const timer = setTimeout(settle, 5000);
    el.addEventListener("durationchange", onDur);
    el.currentTime = 1e101;
  }, []);

  const ingestFiles = useCallback(async (fileList: FileList | File[]) => {
    setFileError("");
    const incoming = Array.from(fileList);
    const newVideos = incoming.filter(f => f.type.startsWith("video"));
    const newImages = incoming.filter(f => f.type.startsWith("image"));
    setSavedSession(null);
    if (newVideos.length > 0) { videoId.current = newId(); setVideoFile(newVideos[0]); setMode("video"); setImages([]); return; }
    if (newImages.length === 0) { setFileError("That file type isn't supported. Add JPG, PNG, GIF, MP4 or WebM files."); return; }
    setMode("image");
    const combined = [...images, ...newImages].slice(0, MAX_FILES);
    if (images.length + newImages.length > MAX_FILES)
      setFileError(`Only ${MAX_FILES} images fit, so the extra files were left out.`);
    const entries = await Promise.all(
      combined.map(async (item): Promise<ImageEntry> => {
        if ("src" in item) return item as ImageEntry;
        const file = item as File;
        const { w, h } = await detectImageResolution(file);
        return { id: newId(), file, src: URL.createObjectURL(file), w, h, masks: [] };
      })
    );
    setImages(entries); setSelectedIdx(0);
  }, [images]);

  const onMediaDrop = (e: React.DragEvent) => { e.preventDefault(); setDropActive(false); ingestFiles(e.dataTransfer.files); };

  const removeImage = (idx: number) => {
    setImages(prev => { URL.revokeObjectURL(prev[idx].src); return prev.filter((_, i) => i !== idx); });
    setSelectedIdx(prev => Math.max(0, prev >= idx ? prev - 1 : prev));
    if (images.length === 1) { setMode(null); setImgReady(false); }
  };

  const posFromEvent = (e: { clientX: number; clientY: number }) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) };
  };

  /** Masks visible right now: the image's masks, or this video frame's faces plus drawn areas. */
  const masksOnScreen = (): Mask[] =>
    mode === "video" && autoMaskEnabled && faceTrack.length ? [...videoFaceMasks(vidElRef.current?.currentTime ?? 0), ...masks] : masks;

  /** Smallest mask under a point, so a face inside a big drawn area can still be picked. */
  const hitMask = (pos: { x: number; y: number }) => {
    let best: Mask | null = null, bestArea = Infinity;
    for (const m of masksOnScreen()) {
      const r = maskRect(m, maskStyle);
      if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h && r.w * r.h < bestArea) { best = m; bestArea = r.w * r.h; }
    }
    return best;
  };

  const onPtrDown = (e: { clientX: number; clientY: number }) => {
    dragging.current = true;
    const pos = posFromEvent(e);
    if (tool === "mask") {
      const hit = hitMask(pos);
      if (hit) { dragging.current = false; setSelectedMaskId(hit.id); return; }
      setSelectedMaskId(null);
      maskStart.current = pos;
      const id = `m-${Date.now()}`;
      drawingId.current = id;
      updateMasks(prev => [...prev, { id, ...pos, w: 0, h: 0, type: maskStyle.type, isAuto: false }]);
    } else if (tool === "watermark") { setActivePreset(null); setWmPos(pos); }
  };

  const onPtrMove = (e: { clientX: number; clientY: number }) => {
    if (!dragging.current) return;
    const pos = posFromEvent(e);
    const start = maskStart.current, id = drawingId.current;
    if (tool === "mask" && start && id) {
      updateMasks(prev => prev.map(m => m.id === id ? { ...m, w: pos.x - start.x, h: pos.y - start.y } : m));
    } else if (tool === "watermark") { setWmPos(pos); }
  };

  const onPtrUp = () => {
    const id = drawingId.current;
    dragging.current = false; maskStart.current = null; drawingId.current = null;
    if (!id) return;
    markEdit();
    setSelectedMaskId(id);
    // Normalise negative sizes from dragging up/left; drop accidental clicks.
    updateMasks(prev => prev.flatMap(m => {
      if (m.id !== id) return [m];
      const x = m.w < 0 ? m.x + m.w : m.x, y = m.h < 0 ? m.y + m.h : m.y;
      const w = Math.abs(m.w), h = Math.abs(m.h);
      return w < 0.005 && h < 0.005 ? [] : [{ ...m, x, y, w, h }];
    }));
  };

  // ── Pointer input: mouse, pen and touch ──
  // One pointer draws a mask or moves the watermark (Adjust: pans the view).
  // A second finger cancels that and pinches to zoom / drags to pan instead.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d0: number; z0: number; mx: number; my: number; sl: number; st: number } | null>(null);
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const cancelStroke = () => {
    const id = drawingId.current;
    dragging.current = false; maskStart.current = null; drawingId.current = null;
    if (id) updateMasks(prev => prev.filter(m => m.id !== id));
  };

  const startGesture = () => {
    const [a, b] = [...pointers.current.values()], st = stageRef.current;
    gesture.current = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom ?? shownScale,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, sl: st?.scrollLeft ?? 0, st: st?.scrollTop ?? 0,
    };
  };

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Keep receiving moves when the finger or mouse leaves the canvas mid-drag.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) { cancelStroke(); pan.current = null; startGesture(); return; }
    if (pointers.current.size > 2) return;
    if (tool === "adjust") {
      const st = stageRef.current;
      if (st) pan.current = { x: e.clientX, y: e.clientY, sl: st.scrollLeft, st: st.scrollTop };
      return;
    }
    onPtrDown(e);
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = stageRef.current, g = gesture.current;
    if (g && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(Math.min(8, Math.max(0.05, g.z0 * (d / g.d0))));
      if (st) { st.scrollLeft = g.sl - ((a.x + b.x) / 2 - g.mx); st.scrollTop = g.st - ((a.y + b.y) / 2 - g.my); }
      return;
    }
    if (pan.current && st) {
      st.scrollLeft = pan.current.sl - (e.clientX - pan.current.x);
      st.scrollTop = pan.current.st - (e.clientY - pan.current.y);
      return;
    }
    onPtrMove(e);
  };

  const onCanvasPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (gesture.current) {
      // Lifting fingers after a pinch never starts a stroke with the one left down.
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    pan.current = null;
    onPtrUp();
  };

  const exportConfigJson = () => {
    const cfg = { wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter, wmBlur, exportPrefix, maskStyle, detectSettings, upscale: { factor: upscaleFactor, sharpen: upscaleSharpen } };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" }));
    a.download = "obscurax_settings.json"; a.click();
  };

  const importConfigJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const cfg = JSON.parse(e.target?.result as string);
        if (cfg.wmType) setWmType(cfg.wmType);
        if (cfg.wmText) setWmText(cfg.wmText);
        if (cfg.wmLink) setWmLink(cfg.wmLink);
        if (cfg.wmColor) setWmColor(cfg.wmColor);
        if (cfg.wmFont) setWmFont(cfg.wmFont);
        if (cfg.wmSize) setWmSize(cfg.wmSize);
        if (cfg.wmOpacity) setWmOpacity(cfg.wmOpacity);
        if (cfg.wmBold !== undefined) setWmBold(cfg.wmBold);
        if (cfg.wmShadow !== undefined) setWmShadow(cfg.wmShadow);
        if (cfg.wmPos) setWmPos(cfg.wmPos);
        if (cfg.wmFilter) setWmFilter(cfg.wmFilter);
        if (cfg.wmBlur) setWmBlur(cfg.wmBlur);
        if (cfg.exportPrefix) setExportPrefix(cfg.exportPrefix);
        if (cfg.maskStyle) setMaskStyle({ ...DEFAULT_MASK_STYLE, ...cfg.maskStyle });
        if (cfg.detectSettings) updateDetectSettings(cfg.detectSettings);
        if ((UPSCALE_FACTORS as readonly number[]).includes(cfg.upscale?.factor)) setUpscaleFactor(cfg.upscale.factor);
        if (typeof cfg.upscale?.sharpen === "number") setUpscaleSharpen(Math.min(100, Math.max(0, cfg.upscale.sharpen)));
      } catch { setFileError("That settings file couldn't be read. Choose a file saved by ObscuraX."); }
    };
    reader.readAsText(file);
  };

  /**
   * Renders one image for export: enlarged (when upscaling), then filter, masks and
   * watermark. Masks are in relative units; pixel sizes (watermark, filter blur) are
   * scaled so the export looks like the preview, only bigger.
   */
  const renderForExport = (imgEl: HTMLImageElement, entryMasks: Mask[]) => {
    const sw = imgEl.naturalWidth, sh = imgEl.naturalHeight;
    const { w, h, scale } = upscaledSize(sw, sh, upscaleFactor);
    const base = wmConfig();
    const cfg = { ...base, wmSize: base.wmSize * scale, wmBlur: base.wmBlur * scale };
    const filter = resolveFilter(cfg.wmFilter, cfg.wmBlur, w, h);
    const up = scale > 1 ? upscaleImage(imgEl, sw, sh, w, h, upscaleSharpen) : null;
    let out: HTMLCanvasElement;
    if (up && filter === "none") out = up;
    else {
      out = document.createElement("canvas"); out.width = w; out.height = h;
      const c = out.getContext("2d")!;
      c.imageSmoothingQuality = "high";
      drawFiltered(c, up ?? imgEl, w, h, filter);
      if (up) up.width = 0;
    }
    const ctx = out.getContext("2d")!;
    applyMasks(ctx, w, h, entryMasks, maskStyle);
    applyWatermark(ctx, w, h, cfg);
    return out;
  };

  const exportSingleImage = async (): Promise<boolean> => {
    const entry = images[selectedIdx], imgEl = imgElRef.current;
    if (!entry || !imgEl) return false;
    const autoScan = maskingMode && autoMaskEnabled && !entry.scanned;
    if (autoScan && !modelsLoaded) { setFileError(MODEL_MISSING_MSG); return false; }
    setFileError("");
    setBulkProgress({ done: 0, total: 1 }); setExportMsg(autoScan ? "Finding faces…" : upscaleFactor > 1 ? "Upscaling…" : "Rendering…");
    try {
      await nextFrame();
      // Faces must be found before saving, even if the image was just changed.
      let entryMasks = masks;
      if (autoScan) {
        const autos = facesToMasks(await detectFaces(imgEl, detectOpts));
        entryMasks = mergeAutoMasks(entry.masks, autos);
        setAutoMasks(entry.src, autos);
        if (upscaleFactor > 1) { setExportMsg("Upscaling…"); await nextFrame(); }
      }
      const isPng = entry.file.type === "image/png";
      const out = renderForExport(imgEl, entryMasks);
      const blob = await canvasBlob(out, isPng ? "image/png" : "image/jpeg");
      out.width = 0;
      if (!blob) throw new Error("Canvas could not be encoded");
      const file = downloadBlob(blob, `${exportPrefix}${baseName(entry.file.name)}.${isPng ? "png" : "jpg"}`);
      showToast("Image downloaded", file);
      return true;
    } catch (err) {
      console.error("ObscuraX: Export failed:", err);
      setFileError(upscaleFactor > 1 ? "The image couldn't be saved at this size. Try a smaller size." : "The image couldn't be saved. Try again.");
      return false;
    } finally {
      setBulkProgress(null); setExportMsg("");
    }
  };

  const exportBulkZip = async (): Promise<boolean> => {
    if (!images.length) return false;
    // Faces in images the user never opened must still be masked.
    const autoScan = maskingMode && autoMaskEnabled;
    if (autoScan && !modelsLoaded) { setFileError(MODEL_MISSING_MSG); return false; }
    setFileError("");
    setBulkProgress({ done: 0, total: images.length }); setExportMsg("Building ZIP…");
    const zip = new JSZip(); const folder = zip.folder("watermarked");
    try {
      for (let i = 0; i < images.length; i++) {
        const entry = images[i];
        setBulkProgress({ done: i, total: images.length }); setExportMsg(`Processing ${i + 1} of ${images.length}…`);
        const imgEl = await loadImage(entry.src);
        let entryMasks = entry.masks || [];
        if (autoScan && !entry.scanned) {
          setExportMsg(`Finding faces ${i + 1} of ${images.length}…`);
          const autos = facesToMasks(await detectFaces(imgEl, detectOpts));
          entryMasks = mergeAutoMasks(entryMasks, autos);
          setAutoMasks(entry.src, autos);
        }
        if (upscaleFactor > 1) { setExportMsg(`Upscaling ${i + 1} of ${images.length}…`); await nextFrame(); }
        const isPng = entry.file.type === "image/png";
        const offscr = renderForExport(imgEl, entryMasks);
        const blob = await canvasBlob(offscr, isPng ? "image/png" : "image/jpeg");
        offscr.width = 0;
        if (!blob) throw new Error(`Could not encode ${entry.file.name}`);
        folder!.file(`${exportPrefix}${baseName(entry.file.name)}.${isPng ? "png" : "jpg"}`, await blob.arrayBuffer());
      }
    } catch (err) {
      // Don't ship a partial ZIP that may contain unmasked faces.
      console.error("ObscuraX: Bulk export failed:", err);
      setFileError("Export stopped because an image couldn't be processed. Nothing was saved. Try again, or remove that image.");
      setBulkProgress(null); setExportMsg("");
      return false;
    }
    setBulkProgress({ done: images.length, total: images.length }); setExportMsg("Compressing…");
    const zipBlob = await zip.generateAsync({ type: "blob" }, (meta: { percent: number }) => setExpPct(Math.round(meta.percent)));
    const file = downloadBlob(zipBlob, `${exportPrefix}images.zip`);
    setBulkProgress(null); setExportMsg(""); setExpPct(0); showToast("ZIP downloaded", file);
    return true;
  };

  // ── Video soundtrack ──
  // The recording is taken from the canvas, which has no sound. The video's
  // audio is routed through Web Audio: to the speakers (following the mute
  // button) and to a stream the recorder adds as the export's audio track.
  // A media element can be connected only once, so this is set up on the first
  // export and kept for that video.
  const audioRef = useRef<{ el: HTMLVideoElement; ctx: AudioContext; src: MediaElementAudioSourceNode; gain: GainNode; dest: MediaStreamAudioDestinationNode } | null>(null);
  const routeAudio = (vid: HTMLVideoElement) => {
    const cur = audioRef.current;
    if (cur?.el === vid) { cur.ctx.resume().catch(() => {}); return cur; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = cur?.ctx ?? new AC();
      cur?.src.disconnect();
      ctx.resume().catch(() => {});
      const src = ctx.createMediaElementSource(vid);
      const gain = ctx.createGain();
      gain.gain.value = videoMuted ? 0 : 1;
      src.connect(gain).connect(ctx.destination);
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      // Muting the element would silence the recording too; the gain mutes the speakers instead.
      vid.muted = false;
      audioRef.current = { el: vid, ctx, src, gain, dest };
      setAudioRouted(true);
      return audioRef.current;
    } catch (err) {
      console.warn("ObscuraX: the video's sound can't be recorded:", err);
      return null;
    }
  };
  useEffect(() => {
    const a = audioRef.current;
    if (a && a.el === vidElRef.current) a.gain.gain.value = videoMuted ? 0 : 1;
  }, [videoMuted, audioRouted]);

  const recorderRef = useRef<{ recorder: MediaRecorder; cancelled: boolean } | null>(null);
  const cancelVideoExport = () => {
    const r = recorderRef.current;
    if (!r) return;
    r.cancelled = true;
    vidElRef.current?.pause();
    if (r.recorder.state !== "inactive") r.recorder.stop();
  };

  const exportVideo = async () => {
    const cvs = canvasRef.current, vid = vidElRef.current;
    if (!cvs || !vid) return;
    // Connect the soundtrack now, while the click still counts as a user gesture
    // (browsers only start audio from one).
    const audio = routeAudio(vid);
    if (maskingMode && autoMaskEnabled) {
      if (!modelsLoaded) { setFileError(MODEL_MISSING_MSG); return; }
      // Never export with a missing or out-of-date face track.
      if (trackStatus !== "ready" && !(await scanVideo())) return;
    }
    const audioTrack = audio?.dest.stream.getAudioTracks()[0];
    const type = recordType(!!audioTrack) ?? recordType(false);
    if (!type || typeof cvs.captureStream !== "function") {
      setFileError("This browser can't record video. Try Chrome, Edge, Firefox or Safari 14.1 or later.");
      return;
    }
    const stream = cvs.captureStream(60);
    if (audioTrack && type.audio) stream.addTrack(audioTrack);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: 5000000, audioBitsPerSecond: 128000 });
    } catch (err) {
      console.error("ObscuraX: recorder failed:", err);
      setFileError("This browser couldn't start recording. Try again, or use another browser.");
      return;
    }
    const job = { recorder, cancelled: false };
    recorderRef.current = job;
    const chunks: Blob[] = [];
    const onProg = () => setExpPct(vid.duration ? Math.round((vid.currentTime / vid.duration) * 100) : 0);
    recorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      vid.removeEventListener("timeupdate", onProg);
      vid.loop = true;
      recorderRef.current = null;
      setExporting(false); setExpPct(0); setVideoPaused(true);
      if (job.cancelled) { showToast("Export cancelled"); return; }
      const blob = new Blob(chunks, { type: type.mime.split(";")[0] });
      const file = downloadBlob(blob, `${exportPrefix}video_${Date.now()}.${type.ext}`);
      showToast(audioTrack && type.audio ? "Video downloaded" : "Video downloaded (without sound)", file);
    };

    // Recorded in real time: the recorder timestamps frames by the clock, so a
    // faster playback rate would make the saved video play too fast (and the
    // sound would be sped up). Looping is off so "ended" fires.
    setExporting(true); setExpPct(0);
    vid.pause(); setVideoPaused(true);
    vid.loop = false; vid.playbackRate = 1;
    await seekVideo(vid, 0);
    if (job.cancelled) return;
    vid.addEventListener("timeupdate", onProg);
    vid.addEventListener("ended", () => { if (recorder.state !== "inactive") recorder.stop(); }, { once: true });
    recorder.start(1000);
    try {
      await vid.play();
    } catch {
      // Some browsers won't start unmuted playback without a fresh tap: record silently instead.
      vid.muted = true;
      await vid.play().catch(() => {});
    }
    setVideoPaused(false);
  };

  const activeImg = mode === "image" && images.length > 0 ? images[selectedIdx] : null;

  // ── Undo / redo ─────────────────────────────────────────────────────────────
  // Snapshots cover the user's edits: watermark, filter, mask style, drawn
  // areas, and which faces are turned off. Face detection results are not
  // part of history, so undo can never bring back an unblurred face that
  // detection found; it only restores the user's own on/off choices.
  const history = useHistory<EditSnapshot>();
  const takeSnapshot = (): EditSnapshot => ({
    wm: { wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, activePreset, wmFilter, wmBlur },
    maskStyle,
    images: mode === "image" ? Object.fromEntries(images.map(img => [img.id ?? img.src, {
      drawn: img.masks.filter(m => !m.isAuto),
      off: img.masks.filter(m => m.isAuto && m.off).map(({ x, y, w, h }) => ({ x, y, w, h })),
      faces: img.masks.filter(m => m.isAuto).length,
    }])) : {},
    video: mode === "video" ? { drawn: masks, hidden: [...hiddenTracks].sort((a, b) => a - b), tracked: faceTrack.length > 0 } : null,
  });
  const restoreSnapshot = (snap: EditSnapshot) => {
    const w = snap.wm;
    setWmType(w.wmType as typeof WM[keyof typeof WM]); setWmText(w.wmText); setWmLink(w.wmLink); setWmColor(w.wmColor); setWmFont(w.wmFont);
    setWmSize(w.wmSize); setWmOpacity(w.wmOpacity); setWmBold(w.wmBold); setWmShadow(w.wmShadow); setWmPos(w.wmPos);
    setActivePreset(w.activePreset); setWmFilter(w.wmFilter); setWmBlur(w.wmBlur);
    setMaskStyle(snap.maskStyle);
    if (mode === "image") {
      setImages(prev => prev.map(img => {
        const autos = img.masks.filter(m => m.isAuto);
        // An image missing from the snapshot was added after it: back to no edits.
        const e = snap.images[img.id ?? img.src] ?? { drawn: [], off: [], faces: autos.length };
        if (!autos.length && e.faces > 0) {
          // Undoing "Clear all masks": find the faces again. The turned-off faces
          // go back as placeholders so detection keeps them off (mergeAutoMasks).
          const offs: Mask[] = e.off.map((b, i) => ({ id: `off-${i}`, ...b, type: "blur", isAuto: true, off: true }));
          return { ...img, scanned: false, masks: [...offs, ...e.drawn] };
        }
        return { ...img, masks: [...autos.map(a => ({ ...a, off: e.off.some(o => sameFace(a, o)) })), ...e.drawn] };
      }));
    } else if (mode === "video" && snap.video) {
      setMasks(snap.video.drawn); setHiddenTracks(snap.video.hidden);
      // Undoing "Clear all masks": the face track isn't kept in history, so scan again.
      if (snap.video.tracked && !faceTrack.length && trackStatus !== "scanning") setTrackStatus("idle");
    }
    setSelectedMaskId(null);
  };
  const snapRef = useRef(takeSnapshot);
  useEffect(() => { snapRef.current = takeSnapshot; });

  // New media starts a fresh history.
  const historyKey = `${mode}|${videoSrc ?? ""}`;
  useEffect(() => { history.reset(snapRef.current()); }, [historyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings (sliders, text) are recorded once they settle, so one drag is one step.
  const settingsKey = JSON.stringify([wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, activePreset, wmFilter, wmBlur, maskStyle]);
  useEffect(() => {
    const t = setTimeout(() => history.commit(snapRef.current()), 400);
    return () => clearTimeout(t);
  }, [settingsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mask edits (draw, delete, turn a face on/off, clear) are recorded right after they render.
  const [editTick, setEditTick] = useState(0);
  const markEdit = () => setEditTick(t => t + 1);
  useEffect(() => { if (editTick) history.commit(snapRef.current()); }, [editTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const doUndo = () => {
    // Record a change still waiting for its debounce first, so it can be redone.
    history.commit(takeSnapshot());
    const snap = history.undo();
    if (snap) restoreSnapshot(snap);
  };
  const doRedo = () => {
    const snap = history.redo();
    if (snap) restoreSnapshot(snap);
  };

  // ── Keeping work between visits ─────────────────────────────────────────────
  // Preferences are saved as they change; the session (media, masks, face
  // track) is saved a moment after each change and offered back next time.
  const prefs: Prefs = {
    wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, activePreset, wmFilter, wmBlur,
    exportPrefix, maskStyle, detectSettings, upscaleFactor, upscaleSharpen,
  };
  const prefsJson = JSON.stringify(prefs);
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; });
  useEffect(() => {
    const t = setTimeout(() => savePrefs(prefsRef.current), 300);
    return () => clearTimeout(t);
  }, [prefsJson]);
  useEffect(() => {
    // localStorage is synchronous, so the last change survives closing the tab.
    const flush = () => savePrefs(prefsRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSession().then(s => { if (!cancelled) { setSavedSession(s); setSessionChecked(true); } });
    loadLogo().then(f => { if (!cancelled && f) setWmImgFile(cur => cur ?? f); });
    return () => { cancelled = true; };
  }, []);

  const buildSession = (): { session: Session; files: { id: string; file: File }[] } | null => {
    if (mode === "image" && images.length) {
      return {
        session: {
          v: 1, savedAt: Date.now(), mode: "image", selectedIdx, video: null,
          images: images.map(img => ({ id: img.id!, w: img.w, h: img.h, masks: img.masks, scanned: img.scanned })),
        },
        files: images.map(img => ({ id: img.id!, file: img.file })),
      };
    }
    if (mode === "video" && videoFile && videoId.current && videoFile.size <= MAX_SAVED_VIDEO_BYTES) {
      return {
        session: {
          v: 1, savedAt: Date.now(), mode: "video", images: [], selectedIdx: 0,
          video: { id: videoId.current, masks, faceTrack, trackInfo, hiddenTracks, trackStatus },
        },
        files: [{ id: videoId.current, file: videoFile }],
      };
    }
    return null;
  };
  const saveNow = async () => {
    if (!sessionChecked || savedSession) return; // don't overwrite a session still on offer
    const b = buildSession();
    if (b) await saveSession(b.session, b.files);
    else await clearSession();
  };
  const saveRef = useRef(saveNow);
  useEffect(() => { saveRef.current = saveNow; });
  useEffect(() => {
    if (!sessionChecked || trackStatus === "scanning") return;
    const t = setTimeout(() => { saveRef.current(); }, 800);
    return () => clearTimeout(t);
  }, [sessionChecked, savedSession, mode, images, selectedIdx, videoFile, masks, faceTrack, trackInfo, hiddenTracks, trackStatus]);

  const continueSession = () => {
    const s = savedSession;
    if (!s) return;
    const { session, files } = s;
    setSavedSession(null); setFileError("");
    if (session.mode === "image") {
      const entries: ImageEntry[] = session.images.flatMap(im => {
        const file = files.get(im.id);
        return file ? [{ id: im.id, file, src: URL.createObjectURL(file), w: im.w, h: im.h, masks: im.masks, scanned: im.scanned }] : [];
      });
      if (!entries.length) return;
      setImages(entries); setSelectedIdx(Math.min(session.selectedIdx, entries.length - 1)); setMode("image");
    } else if (session.video) {
      const file = files.get(session.video.id);
      if (!file) return;
      videoId.current = session.video.id;
      restoreVideo.current = session.video;
      setVideoFile(file); setImages([]); setMode("video");
    }
  };
  const discardSession = () => { setSavedSession(null); clearSession(); };
  const sessionSummary = savedSession && (savedSession.session.mode === "video"
    ? savedSession.files.values().next().value?.name ?? "A video"
    : plural(savedSession.files.size, "image"));

  // ── View ────────────────────────────────────────────────────────────────────
  const { mode: themeMode, cycle: cycleTheme } = useTheme();
  const online = useOnline();
  const pwa = usePwa();
  useEffect(() => {
    if (!pwa.offlineReady) return;
    showToast("Ready to work offline");
    clearOfflineReady();
  }, [pwa.offlineReady, showToast]);

  // Phone layout: tapping the active tool again hides its panel to give the image more room.
  const [panelOpen, setPanelOpen] = useState(true);
  const pickTool = (id: Tool) => {
    if (id === tool && isPhoneLayout()) setPanelOpen(o => !o);
    else { setTool(id); setPanelOpen(true); }
  };
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"all" | "current">("all");

  // The canvas hint ("Drag to …") appears for a few seconds after a tool or file change.
  const [hintKey, setHintKey] = useState<string | null>(null);
  useEffect(() => {
    const key = `${tool}|${activeSrc ?? videoSrc ?? ""}`;
    setHintKey(key);
    const t = setTimeout(() => setHintKey(k => (k === key ? null : k)), 3000);
    return () => clearTimeout(t);
  }, [tool, activeSrc, videoSrc]);

  // Zoom: null fits the image to the workspace; a number is a fixed scale.
  const [zoom, setZoom] = useState<number | null>(null);
  const [shownScale, setShownScale] = useState(1);
  const stageRef = useRef<HTMLElement | null>(null);
  const [canvasBox, setCanvasBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const c = canvasRef.current, st = stageRef.current;
    if (!c || !st) return;
    const measure = () => {
      if (naturalW.current) setShownScale(c.clientWidth / naturalW.current);
      setCanvasBox({ left: c.offsetLeft, top: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(c); ro.observe(st);
    return () => ro.disconnect();
  }, [mode]);
  useEffect(() => { setZoom(null); }, [activeSrc, videoSrc]);
  const zoomBy = useCallback((f: number) => setZoom(z => Math.min(8, Math.max(0.05, (z ?? shownScale) * f))), [shownScale]);

  // Latest undo / redo for the key handler.
  const undoKeys = useRef({ undo: doUndo, redo: doRedo });
  useEffect(() => { undoKeys.current = { undo: doUndo, redo: doRedo }; });

  // Latest selection actions for the key handler, without re-binding it every render.
  const selectionKeys = useRef<{ remove?: () => void; deselect?: () => void }>({});

  // Shortcuts: F / W / A pick a tool; Ctrl/⌘ + Z undo, Ctrl/⌘ + Shift + Z or Ctrl + Y redo;
  // Ctrl/⌘ + = / − / 0 zoom; Delete / Esc act on the selected mask.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (exportOpen) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && (k === "z" || k === "y")) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) undoKeys.current.redo(); else undoKeys.current.undo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectionKeys.current.remove) { e.preventDefault(); selectionKeys.current.remove(); return; }
      if (e.key === "Escape" && selectionKeys.current.deselect) { selectionKeys.current.deselect(); return; }
      if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomBy(1.25); }
      else if (mod && e.key === "-") { e.preventDefault(); zoomBy(0.8); }
      else if (mod && e.key === "0") { e.preventDefault(); setZoom(null); }
      else if (!mod && !e.altKey) {
        const t = TOOLS.find(x => x.key.toLowerCase() === e.key.toLowerCase());
        if (t) setTool(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportOpen, zoomBy]);

  const ready = mode === "video" ? videoReady : imgReady;

  // ── Blurred areas: list + selection ──
  useEffect(() => { setSelectedMaskId(null); setHoverMaskId(null); }, [activeSrc, videoSrc]);
  const thumbCache = useRef(new Map<string, string>());
  type AreaItem = { id: string; name: string; sub: string; thumb?: string; off: boolean; kind: "face" | "drawn"; seekTo?: number };
  const areaItems: AreaItem[] = [];
  const drawnItems = masks.filter(m => !m.isAuto);
  if (mode === "video") {
    trackInfo.forEach((ti, i) => areaItems.push({
      id: `track-${ti.id}`, name: `Face ${i + 1}`, kind: "face", thumb: ti.thumb, off: hiddenTracks.includes(ti.id), seekTo: ti.firstT,
      sub: `${Math.round(ti.score * 100)}% sure · ${Math.max(1, Math.round(ti.samples / detectSettings.scanFps))} s on screen`,
    }));
  } else if (mode === "image") {
    const imgEl = imgReady ? imgElRef.current : null;
    [...masks.filter(m => m.isAuto)].sort((a, b) => a.x - b.x).forEach((m, i) => {
      let thumb: string | undefined;
      if (imgEl && activeSrc) {
        const key = `${activeSrc}|${m.x.toFixed(4)},${m.y.toFixed(4)},${m.w.toFixed(4)},${m.h.toFixed(4)}`;
        thumb = thumbCache.current.get(key);
        if (!thumb) { thumb = cropThumb(imgEl, m); thumbCache.current.set(key, thumb); }
      }
      areaItems.push({
        id: m.id, name: `Face ${i + 1}`, kind: "face", thumb, off: !!m.off,
        sub: `${Math.round((m.score ?? 0) * 100)}% sure · ${Math.round(m.w * canvasDims.w)} × ${Math.round(m.h * canvasDims.h)} px`,
      });
    });
  }
  drawnItems.forEach((m, i) => areaItems.push({
    id: m.id, name: `Drawn area ${i + 1}`, kind: "drawn", off: false,
    sub: `${Math.round(Math.abs(m.w) * canvasDims.w)} × ${Math.round(Math.abs(m.h) * canvasDims.h)} px`,
  }));
  const itemById = new Map(areaItems.map(it => [it.id, it]));
  const onScreen = mode && ready ? masksOnScreen() : [];
  const selectedMask = onScreen.find(m => m.id === selectedMaskId) ?? null;
  const selectedItem = selectedMaskId ? itemById.get(selectedMaskId) ?? null : null;

  const setAreaOff = (id: string, off: boolean) => {
    markEdit();
    const tid = trackIdOf(id);
    if (tid != null) setHiddenTracks(h => (off ? [...new Set([...h, tid])] : h.filter(x => x !== tid)));
    else updateMasks(prev => prev.map(m => (m.id === id ? { ...m, off } : m)));
  };
  const deleteArea = (id: string) => {
    markEdit();
    updateMasks(prev => prev.filter(m => m.id !== id));
    setSelectedMaskId(sel => (sel === id ? null : sel));
  };
  const pickArea = (it: AreaItem) => {
    setSelectedMaskId(it.id);
    // In a video, jump to where the face first appears so it can be seen.
    if (it.seekTo != null && vidElRef.current) { vidElRef.current.currentTime = it.seekTo; setVideoTime(it.seekTo); }
  };
  useEffect(() => {
    selectionKeys.current = selectedItem ? {
      remove: () => (selectedItem.kind === "drawn" ? deleteArea(selectedItem.id) : setAreaOff(selectedItem.id, !selectedItem.off)),
      deselect: () => setSelectedMaskId(null),
    } : {};
  });

  const autoFaces = masks.filter(m => m.isAuto && !m.off).length;
  const autoTotal = masks.filter(m => m.isAuto).length;
  const drawnMasks = masks.length - autoTotal;
  const peakFaces = faceTrack.reduce((mx, smp) => Math.max(mx, smp.boxes.filter(b => !hiddenTracks.includes(b.id ?? -1)).length), 0);
  const faceBlurOn = maskingMode && autoMaskEnabled;
  const modelLoading = faceBlurOn && !modelsLoaded && !modelError;
  const mediaName = mode === "video" ? videoFile?.name ?? "Video" : activeImg?.file.name ?? "Image";
  const exportAll = mode === "image" && images.length > 1 && exportScope === "all";
  const busy = exporting || !!bulkProgress;

  const setFaceBlur = (on: boolean) => {
    setMaskingMode(on);
    toggleAutoMask(on);
  };
  const clearImages = () => {
    images.forEach(img => URL.revokeObjectURL(img.src));
    setImages([]); setMode(null); setImgReady(false);
  };
  const removeVideo = () => {
    scanToken.current++;
    setScan(null); setVideoFile(null); setVideoSrc(null); setVideoReady(false); setMode(null);
    setMasks([]); setFaceTrack([]); setTrackStatus("idle");
  };
  const openExport = () => { setFileError(""); setExportOpen(true); };
  const runExport = async () => {
    if (mode === "video") { setExportOpen(false); await exportVideo(); return; }
    if (exportAll) { if (await exportBulkZip()) setExportOpen(false); return; }
    if (await exportSingleImage()) setExportOpen(false);
  };

  // Export size: what the upscale setting produces for the images being exported.
  const exportImgs = mode !== "image" ? [] : exportAll ? images : activeImg ? [activeImg] : [];
  const cappedCount = exportImgs.filter(img => fitScale(img.w, img.h, upscaleFactor) < upscaleFactor).length;
  const outSize = activeImg && !exportAll ? upscaledSize(activeImg.w || canvasDims.w, activeImg.h || canvasDims.h, upscaleFactor) : null;
  const fmtScale = (s: number) => `${Number(s.toFixed(1))}×`;

  // Status for the dock: what the face blur is doing right now.
  let faceStatus: { text: string; spin?: boolean; ok?: boolean } | null = null;
  if (mode) {
    if (!faceBlurOn) faceStatus = { text: drawnMasks ? plural(drawnMasks, "drawn area") : "Face blur off" };
    else if (modelLoading) faceStatus = { text: "Loading face model…", spin: true };
    else if (modelError) faceStatus = { text: "Face model unavailable" };
    else if (mode === "image") {
      faceStatus = !activeScanned
        ? { text: "Finding faces…", spin: true }
        : { text: `${autoFaces < autoTotal ? `${autoFaces} of ${autoTotal} faces` : plural(autoFaces, "face")} covered${drawnMasks ? ` · ${plural(drawnMasks, "drawn area")}` : ""}`, ok: true };
    } else if (trackStatus === "scanning") faceStatus = { text: `Tracking faces… ${scan?.pct ?? 0}%`, spin: true };
    else if (trackStatus === "ready") faceStatus = { text: !faceTrack.length ? "Face track cleared" : peakFaces ? `Up to ${plural(peakFaces, "face")} per frame covered` : "No faces found", ok: faceTrack.length > 0 };
    else faceStatus = { text: trackStatus === "stale" ? "Rescan needed" : "Not scanned yet" };
  }

  let activity: string | null = null;
  if (exporting) activity = `Recording video… ${expPct}%`;
  else if (scan && mode === "video") activity = scan.label;

  const pickFiles = () => document.getElementById("__mi")?.click();
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDropActive(true); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false); },
    onDrop: onMediaDrop,
  };

  const colourSwatches = (value: string, onChange: (c: string) => void, label: string) => (
    <div className="swatches" role="group" aria-label={label}>
      {PALETTE.map(clr => (
        <button key={clr} type="button" className="swatch" style={{ background: clr }} aria-pressed={value === clr} aria-label={clr} title={clr} onClick={() => onChange(clr)} />
      ))}
      <input type="color" className="swatch" value={value} aria-label={`Custom ${label.toLowerCase()}`} title="Custom colour" onChange={e => onChange(e.target.value)} />
    </div>
  );

  const ThemeIcon = themeMode === "light" ? Sun : themeMode === "dark" ? Moon : Monitor;
  const themeLabel = themeMode === "light" ? "Light mode" : themeMode === "dark" ? "Dark mode" : "Match computer";
  const toolHint = tool === "mask" ? "Drag to blur any area" : tool === "watermark" ? "Drag to move the watermark" : null;
  const showHint = hintKey === `${tool}|${activeSrc ?? videoSrc ?? ""}`;
  const filterThumb = activeImg?.src;

  return (
    <div className="editor">
      {/* ── Tool rail ── */}
      <nav className="rail" aria-label="Tools">
        <div className="rail-logo" aria-hidden="true">OX</div>
        <div className="rail-sep" />
        {TOOLS.map(({ id, label, key, Icon }) => (
          <button key={id} type="button" className="rail-btn" aria-pressed={tool === id} aria-label={label} title={`${label} (${key})`} onClick={() => pickTool(id)}>
            <Icon aria-hidden="true" /><span className="rail-label" aria-hidden="true">{label}</span>
          </button>
        ))}
        <div className="rail-end">
          <button type="button" className="rail-btn" onClick={cycleTheme} aria-label={`Colour mode: ${themeLabel}. Click to change.`} title={`${themeLabel} (click to change)`}>
            <ThemeIcon aria-hidden="true" /><span className="rail-label" aria-hidden="true">Theme</span>
          </button>
        </div>
      </nav>

      {/* ── Top bar ── */}
      <header className="topbar">
        <span className="brand">ObscuraX</span>
        {mode && (
          <div className="doc">
            <span className="doc-name" title={mediaName}>{mediaName}</span>
            {canvasDims.w > 0 && <span className="num hide-sm">{canvasDims.w} × {canvasDims.h}</span>}
          </div>
        )}
        <div className="spacer" />
        {!online && (
          <span className="activity offline" role="status" title="No connection. Everything still works: files are processed on this device.">
            <WifiOff aria-hidden="true" /><span className="hide-sm">Offline</span>
          </span>
        )}
        {activity && <span className="activity" role="status" title={activity}><Spinner /><span className="hide-sm">{activity}</span></span>}
        {mode && (
          <div className="zoom" role="group" aria-label="History">
            <button type="button" onClick={doUndo} disabled={!history.canUndo || busy} aria-label="Undo" title="Undo (Ctrl/⌘ + Z)"><Undo2 aria-hidden="true" /></button>
            <button type="button" onClick={doRedo} disabled={!history.canRedo || busy} aria-label="Redo" title="Redo (Ctrl/⌘ + Shift + Z)"><Redo2 aria-hidden="true" /></button>
          </div>
        )}
        {mode && (
          <div className="zoom" role="group" aria-label="Zoom">
            <button type="button" className="hide-sm" onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (Ctrl/⌘ + −)"><Minus aria-hidden="true" /></button>
            <button type="button" className="pct" onClick={() => setZoom(1)} aria-label="Actual size" title="Actual size">{Math.round((zoom ?? shownScale) * 100)}%</button>
            <button type="button" className="hide-sm" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (Ctrl/⌘ + =)"><Plus aria-hidden="true" /></button>
            <button type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null} aria-label="Fit to window" title="Fit to window (Ctrl/⌘ + 0)"><Maximize aria-hidden="true" /></button>
          </div>
        )}
        <button type="button" className="btn" onClick={pickFiles}><ImagePlus aria-hidden="true" /><span className="hide-sm">Open</span></button>
        <button type="button" className="btn primary" onClick={openExport} disabled={!mode || busy} aria-label="Export">
          {busy ? <Spinner /> : <Download aria-hidden="true" />}<span className="hide-xs">Export</span>
        </button>
      </header>

      {/* ── Workspace ── */}
      <div className="stage-wrap">
        <main ref={stageRef} className={`stage${zoom === null ? " fit" : ""}${dropActive ? " over" : ""}`} aria-label="Workspace" {...dropProps}>
          {!mode ? (
            <div className="start">
            {savedSession && (
              <section className="card resume" aria-labelledby="resume-title">
                <div className="resume-head">
                  <span className="resume-icon" aria-hidden="true"><History /></span>
                  <div>
                    <h2 id="resume-title">Continue where you left off?</h2>
                    <p className="sub">{sessionSummary} · saved {timeAgo(savedSession.session.savedAt)}</p>
                  </div>
                </div>
                <div className="btn-row">
                  <button type="button" className="btn primary" onClick={continueSession}>Continue</button>
                  <button type="button" className="btn" onClick={discardSession}>Start over</button>
                </div>
                <p className="hint">Your work is kept only in this browser, on this device.</p>
              </section>
            )}
            <button type="button" className="drop lg" onClick={pickFiles}>
              <Upload aria-hidden="true" />
              <span className="t">Open images or a video</span>
              <span className="sub">
                {isTouch ? "Tap to choose photos or a video" : "Drop files here, or click to choose"}. Up to {MAX_FILES} images, or one video. Files stay on this device, and it works offline.
              </span>
            </button>
            </div>
          ) : (
            <canvas ref={canvasRef} aria-label={`Preview of ${mediaName}`} data-tool={tool}
              style={zoom === null ? undefined : { width: canvasDims.w * zoom }}
              onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerEnd} onPointerCancel={onCanvasPointerEnd}
              onContextMenu={e => e.preventDefault()}
            />
          )}
          {/* Outlines of blurred areas; editor-only, never drawn into the export. */}
          {tool === "mask" && canvasBox && onScreen.length > 0 && (
            <div className="mk-layer" style={canvasBox}>
              {onScreen.map(m => {
                const r = maskRect(m, maskStyle);
                const cls = ["mk", maskStyle.shape === "ellipse" ? "oval" : "", m.off ? "off" : "", m.id === selectedMaskId ? "sel" : "", m.id === hoverMaskId ? "hov" : ""].join(" ");
                return <div key={m.id} className={cls} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />;
              })}
              {selectedMask && selectedItem && (() => {
                const r = maskRect(selectedMask, maskStyle);
                const below = r.y < 0.14;
                return (
                  <div className={`mk-bar${below ? " below" : ""}`} style={{ left: `${(r.x + r.w / 2) * 100}%`, top: `${(below ? r.y + r.h : r.y) * 100}%` }}>
                    <span className="mk-bar-name">{selectedItem.name}</span>
                    {selectedItem.kind === "face" ? (
                      <button type="button" className="btn sm" onClick={() => setAreaOff(selectedItem.id, !selectedItem.off)}>
                        {selectedItem.off ? <><Eye aria-hidden="true" />Blur</> : <><EyeOff aria-hidden="true" />Don't blur</>}
                      </button>
                    ) : (
                      <button type="button" className="btn sm danger" onClick={() => deleteArea(selectedItem.id)}><Trash2 aria-hidden="true" />Delete</button>
                    )}
                    <button type="button" className="icon-x" aria-label="Deselect" title="Deselect (Esc)" onClick={() => setSelectedMaskId(null)}><X aria-hidden="true" /></button>
                  </div>
                );
              })()}
            </div>
          )}
        </main>
        {mode && !ready && <div className="stage-loading"><Spinner />Loading media…</div>}
        {mode && ready && toolHint && showHint && <div className="tool-hint" aria-hidden="true">{toolHint}</div>}
        {fileError && !exportOpen && (
          <div className="notice err stage-notice" role="alert">
            <span>{fileError}</span>
            <button type="button" className="icon-x" aria-label="Dismiss" title="Dismiss" onClick={() => setFileError("")}><X aria-hidden="true" /></button>
          </div>
        )}
      </div>

      {/* ── Dock: filmstrip or video timeline ── */}
      <footer className="dock" aria-label={mode === "video" ? "Timeline" : "Images"} hidden={!mode}>
        {mode === "video" ? (
          <div className="transport">
            <button type="button" className="dl-btn" onClick={() => setVideoPaused(!videoPaused)} disabled={!videoReady || exporting} aria-label={videoPaused ? "Play" : "Pause"} title={videoPaused ? "Play" : "Pause"}>
              {videoPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            </button>
            <button type="button" className="dl-btn" onClick={() => setVideoMuted(!videoMuted)} aria-label={videoMuted ? "Turn sound on" : "Mute"} title={videoMuted ? "Turn sound on" : "Mute"}>
              {videoMuted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
            </button>
            <input type="range" aria-label="Position in video" min={0} max={videoDur || 100} step={0.01} value={videoTime} disabled={exporting}
              onChange={e => { const t = Number(e.target.value); if (vidElRef.current) vidElRef.current.currentTime = t; setVideoTime(t); }} />
            <span className="time">{fmtTime(videoTime)} / {fmtTime(videoDur)}</span>
            {exporting && <button type="button" className="btn sm" onClick={cancelVideoExport}><Square aria-hidden="true" />Stop</button>}
          </div>
        ) : (
          <div className="strip" role="list">
            {images.map((img, idx) => (
              <div key={img.src} className="strip-item" role="listitem">
                <button type="button" className="strip-pick" aria-current={selectedIdx === idx} aria-label={`Show ${img.file.name}`} title={img.file.name} onClick={() => setSelectedIdx(idx)}>
                  <img src={img.src} alt="" />
                </button>
                <button type="button" className="strip-remove" aria-label={`Remove ${img.file.name}`} title="Remove" onClick={() => removeImage(idx)}>
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
            {images.length < MAX_FILES && (
              <button type="button" className="strip-add" onClick={pickFiles} aria-label="Add images" title={`Add images (${images.length} of ${MAX_FILES})`}>
                <Plus aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {faceStatus && (
          <span className={`status${faceStatus.ok ? " good" : ""}`} role="status">
            {faceStatus.spin ? <Spinner /> : <ScanFace aria-hidden="true" />}{faceStatus.text}
          </span>
        )}
        {mode === "image" && <ArmedBtn className="sm" onConfirm={clearImages}>Remove all</ArmedBtn>}
        {mode === "video" && <ArmedBtn className="sm" onConfirm={removeVideo}>Remove video</ArmedBtn>}
      </footer>

      {/* ── Properties for the active tool ── */}
      <aside className={`insp${panelOpen ? "" : " closed"}`} aria-labelledby="insp-title">
        <button type="button" className="insp-hide icon-x" onClick={() => setPanelOpen(false)} aria-label="Hide panel" title="Hide panel">
          <ChevronDown aria-hidden="true" />
        </button>
        {tool === "mask" && (
          <>
            <h2 id="insp-title">Face blur</h2>
            <p className="insp-sub">Faces are found and covered on this device. Nothing is uploaded.</p>
            <SwitchRow label="Find faces automatically" value={faceBlurOn} onChange={setFaceBlur} />
            {faceBlurOn && modelError && (
              <div className="notice err" role="alert">The face model couldn't be loaded. Reload the page to try again.</div>
            )}

            {mode && (
              <div className="insp-sec">
                <div className="sec-head">
                  <h3>Blurred areas</h3>
                  {areaItems.length > 0 && <span className="sec-meta num">{areaItems.filter(it => !it.off).length} of {areaItems.length} on</span>}
                </div>
                {areaItems.length === 0 ? (
                  <p className="hint">
                    {mode === "video" && faceBlurOn && trackStatus !== "ready" ? "Faces appear here after the video is scanned." : "Nothing is blurred yet. Drag on the image to blur an area."}
                  </p>
                ) : (
                  <>
                    <ul className="mk-list">
                      {areaItems.map(it => (
                        <li key={it.id} className={`mk-row${it.id === selectedMaskId ? " sel" : ""}${it.off ? " off" : ""}`}
                          onMouseEnter={() => setHoverMaskId(it.id)} onMouseLeave={() => setHoverMaskId(h => (h === it.id ? null : h))}>
                          <button type="button" className="mk-pick" aria-pressed={it.id === selectedMaskId} onClick={() => pickArea(it)} title="Show on the image">
                            <span className="mk-thumb">{it.thumb ? <img src={it.thumb} alt="" /> : <SquareDashed aria-hidden="true" />}</span>
                            <span className="mk-text">
                              <span className="mk-name">{it.name}{it.off && <span className="badge neutral">Not blurred</span>}</span>
                              <span className="mk-sub">{it.sub}</span>
                            </span>
                          </button>
                          {it.kind === "face" ? (
                            <button type="button" role="switch" className="switch sm" aria-checked={!it.off} aria-label={`Blur ${it.name}`} title={it.off ? "Blur this face" : "Don't blur this face"}
                              onClick={() => setAreaOff(it.id, !it.off)} />
                          ) : (
                            <button type="button" className="icon-x" aria-label={`Delete ${it.name}`} title="Delete" onClick={() => deleteArea(it.id)}><Trash2 aria-hidden="true" /></button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="hint">Turn off faces that shouldn't be blurred. They stay off if faces are found again. Click a blur on the image to select it.</p>
                  </>
                )}
              </div>
            )}

            <div className="insp-sec">
              <h3>Effect</h3>
              <Seg label="Mask effect" value={maskStyle.type} onChange={t => setMaskStyle(st => ({ ...st, type: t }))}
                options={[{ value: "blur", label: "Blur" }, { value: "pixelate", label: "Pixelate" }, { value: "box", label: "Solid" }]} />
              <Seg label="Mask shape" value={maskStyle.shape} onChange={sh => setMaskStyle(st => ({ ...st, shape: sh }))}
                options={[{ value: "ellipse", label: "Oval" }, { value: "rect", label: "Rectangle" }]} />
              {maskStyle.type === "box" ? (
                <Field label="Colour">{colourSwatches(maskStyle.color, c => setMaskStyle(st => ({ ...st, color: c })), "Mask colour")}</Field>
              ) : (
                <Range label={maskStyle.type === "blur" ? "Blur strength" : "Block size"} value={maskStyle.strength} min={1} max={100} fmt={v => `${v}%`}
                  onChange={v => setMaskStyle(st => ({ ...st, strength: v }))} />
              )}
              <Range label="Soft edge" value={maskStyle.feather} min={0} max={100} fmt={v => `${v}%`}
                onChange={v => setMaskStyle(st => ({ ...st, feather: v }))} />
            </div>

            {faceBlurOn && (
              <div className="insp-sec">
                <h3>Detection</h3>
                <Range label="Sensitivity" value={Math.round((1 - detectSettings.minConfidence) * 100)} min={10} max={90} fmt={v => `${v}%`}
                  onChange={v => updateDetectSettings({ minConfidence: 1 - v / 100 })} />
                <Range label="Extra cover around faces" value={maskStyle.padding} min={0} max={60} fmt={v => `${v}%`}
                  onChange={v => setMaskStyle(st => ({ ...st, padding: v }))} />
                <SwitchRow label="Find small faces" sub="Checks large photos in sections. Slower." value={detectSettings.smallFaceBoost}
                  onChange={v => updateDetectSettings({ smallFaceBoost: v })} />
                {mode === "image" && images.length > 1 && (
                  unscannedCount === 0 ? (
                    <div className="ok-line"><Check aria-hidden="true" />All {images.length} images checked for faces</div>
                  ) : scan ? (
                    <Progress label={scan.label} pct={scan.pct} />
                  ) : (
                    <>
                      <p className="hint">{plural(unscannedCount, "image")} not checked yet. Export checks them first.</p>
                      <button type="button" className="btn block" onClick={detectAllImages} disabled={!modelsLoaded}>
                        <ScanFace aria-hidden="true" />Find faces in all images
                      </button>
                    </>
                  )
                )}
              </div>
            )}

            {faceBlurOn && mode === "video" && (
              <div className="insp-sec">
                <h3>Face tracking</h3>
                <Range label="Scan rate" value={detectSettings.scanFps} min={2} max={15} fmt={v => `${v} frames/s`}
                  onChange={v => updateDetectSettings({ scanFps: v })} />
                {trackStatus === "ready" && faceTrack.length > 0 ? (
                  <div className="ok-line"><Check aria-hidden="true" />Following up to {plural(peakFaces, "face")} across {plural(faceTrack.length, "frame")}</div>
                ) : (
                  <p className="hint">
                    {trackStatus === "idle" && "Scan the video so masks follow each face from frame to frame."}
                    {trackStatus === "scanning" && "Playback pauses while the video is scanned."}
                    {trackStatus === "stale" && "Settings changed. Rescan to update the masks. Export rescans if needed."}
                    {trackStatus === "ready" && "Face track cleared."}
                  </p>
                )}
                {trackStatus === "scanning" ? (
                  <>
                    {scan && <Progress label={scan.label} pct={scan.pct} />}
                    <button type="button" className="btn block" onClick={cancelScan}>Cancel scan</button>
                  </>
                ) : (
                  <button type="button" className="btn block" onClick={scanVideo} disabled={!modelsLoaded || !videoReady || exporting}>
                    <ScanFace aria-hidden="true" />{trackStatus === "idle" ? "Scan video for faces" : "Rescan video"}
                  </button>
                )}
              </div>
            )}

            {(masks.length > 0 || (mode === "video" && faceTrack.length > 0)) && (
              <div className="insp-sec">
                <ArmedBtn className="sm" onConfirm={clearAllMasks}>Clear all masks</ArmedBtn>
              </div>
            )}
          </>
        )}

        {tool === "watermark" && (
          <>
            <h2 id="insp-title">Watermark</h2>
            <p className="insp-sub">Drag on the image to place it.</p>
            <Seg label="Watermark type" value={wmType} onChange={setWmType}
              options={[{ value: WM.TEXT, label: "Text" }, { value: WM.IMG, label: "Image" }, { value: WM.LINK, label: "Link" }]} />
            {wmType === WM.TEXT && <Field label="Text" htmlFor="wm-text"><TextInput id="wm-text" value={wmText} onChange={setWmText} placeholder="© Your brand" /></Field>}
            {wmType === WM.LINK && <Field label="Link" htmlFor="wm-link"><TextInput id="wm-link" value={wmLink} onChange={setWmLink} placeholder="https://yourbrand.com" /></Field>}
            {wmType === WM.IMG && (
              <Field label="Logo">
                <button type="button" className="btn block" onClick={() => document.getElementById("__wi")?.click()}>
                  <Upload aria-hidden="true" />{wmImgFile ? wmImgFile.name : "Choose a logo (PNG)"}
                </button>
              </Field>
            )}

            {wmType !== WM.IMG && (
              <div className="insp-sec">
                <h3>Text style</h3>
                <Field label="Colour">{colourSwatches(wmColor, setWmColor, "Watermark colour")}</Field>
                <Field label="Font" htmlFor="wm-font"><Select id="wm-font" value={wmFont} onChange={setWmFont} options={FONTS} /></Field>
                <SwitchRow label="Bold" value={wmBold} onChange={setWmBold} />
              </div>
            )}

            <div className="insp-sec">
              <h3>Size and placement</h3>
              <Range label={wmType === WM.IMG ? "Logo width" : "Text size"} value={wmSize} min={8} max={120} fmt={v => wmType === WM.IMG ? `${v * 5} px` : `${v} px`} onChange={setWmSize} />
              <Range label="Opacity" value={wmOpacity} min={5} max={100} fmt={v => `${v}%`} onChange={setWmOpacity} />
              <div className="lbl">Position</div>
              <div className="pos-grid" role="group" aria-label="Watermark position">
                {PRESETS.map(p => {
                  const { Icon, label } = POSITION_ICONS[p.id];
                  return (
                    <button key={p.id} type="button" className="btn sm" aria-pressed={activePreset === p.id} aria-label={label} title={label}
                      onClick={() => { setActivePreset(p.id); setWmPos({ x: p.x, y: p.y }); }}>
                      <Icon aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              <SwitchRow label="Shadow" sub="Keeps it readable on light areas." value={wmShadow} onChange={setWmShadow} />
            </div>
          </>
        )}

        {tool === "adjust" && (
          <>
            <h2 id="insp-title">Adjust</h2>
            <p className="insp-sub">A filter for the whole image. Applied before masks and the watermark.</p>
            <div className="flt-grid" role="group" aria-label="Filter">
              {FILTERS.map(f => (
                <button key={f.value} type="button" className="flt" aria-pressed={wmFilter === f.value} onClick={() => setWmFilter(f.value)}>
                  <span className="thumb">
                    {filterThumb && <img src={filterThumb} alt="" style={{ filter: filterPreviewCss(f.value) }} />}
                  </span>
                  {f.label}
                </button>
              ))}
            </div>
            {wmFilter === "blur" && <Range label="Blur radius" value={wmBlur} min={0} max={25} fmt={v => `${v} px`} onChange={setWmBlur} />}
          </>
        )}
      </aside>

      {/* ── Export dialog ── */}
      <Modal open={exportOpen} onClose={() => { if (!bulkProgress) setExportOpen(false); }} labelledBy="exp-title">
        <h2 id="exp-title">Export</h2>
        {mode === "image" && images.length > 1 && (
          <Seg label="What to export" value={exportScope} onChange={setExportScope}
            options={[{ value: "all", label: `All ${images.length} images` }, { value: "current", label: "This image" }]} />
        )}
        <div className="grid">
          <div className="stat"><div className="k">{exportAll ? "Images" : "File"}</div><div className="v" title={mediaName}>{exportAll ? images.length : mediaName}</div></div>
          <div className="stat"><div className="k">Saves as</div><div className="v">{mode === "video" ? (recordType()?.ext === "mp4" ? "MP4 video" : "WebM video") : exportAll ? "ZIP of images" : activeImg?.file.type === "image/png" ? "PNG" : "JPG"}</div></div>
        </div>
        {mode === "image" && (
          <>
            <Field label="Size">
              <Seg label="Output size" value={String(upscaleFactor)} onChange={v => setUpscaleFactor(Number(v))}
                options={UPSCALE_FACTORS.map(f => ({ value: String(f), label: f === 1 ? "Original" : `${f}×` }))} />
            </Field>
            {outSize && outSize.w > 0 && (
              <p className="hint num">
                {outSize.scale !== 1 ? <>{activeImg!.w} × {activeImg!.h} → <strong>{outSize.w} × {outSize.h} px</strong></> : <>{outSize.w} × {outSize.h} px</>}
                {cappedCount > 0 && (outSize.scale > 1
                  ? <> · enlarged {fmtScale(outSize.scale)}, the most this device can save</>
                  : <> · saved smaller: this device can save up to {Math.floor(UPSCALE_MAX_PIXELS / 1e6)} MP</>)}
              </p>
            )}
            {exportAll && (upscaleFactor > 1 || cappedCount > 0) && (
              <p className="hint">
                {upscaleFactor > 1 && `Each image is enlarged ${upscaleFactor}×.`}
                {cappedCount > 0 && ` ${plural(cappedCount, "large image")} ${cappedCount === 1 ? "is" : "are"} ${upscaleFactor > 1 ? "enlarged less" : "saved smaller"}, to stay under the ${Math.floor(UPSCALE_MAX_PIXELS / 1e6)} MP this device can save.`}
              </p>
            )}
            {upscaleFactor > 1 && (
              <>
                <Range label="Sharpen" value={upscaleSharpen} min={0} max={100} fmt={v => (v ? `${v}%` : "Off")} onChange={setUpscaleSharpen} />
                <p className="hint">Smooth resampling plus sharpening. Edges stay crisp, but detail the photo doesn't have can't be added.</p>
              </>
            )}
          </>
        )}
        <Field label="File name prefix" htmlFor="exp-prefix"><TextInput id="exp-prefix" value={exportPrefix} onChange={setExportPrefix} placeholder="watermarked_" /></Field>
        {faceBlurOn && exportAll && unscannedCount > 0 && <p className="hint">{plural(unscannedCount, "image")} {unscannedCount === 1 ? "hasn't" : "haven't"} been checked for faces yet. {unscannedCount === 1 ? "It's" : "They're"} checked before saving.</p>}
        {faceBlurOn && mode === "video" && trackStatus !== "ready" && <p className="hint">The video is scanned for faces before recording.</p>}
        {mode === "video" && <p className="hint">The video plays through once while it's recorded, with its sound ({fmtTime(videoDur)}). Keep this tab open until it finishes.</p>}
        {bulkProgress && <Progress label={exportMsg || "Exporting…"} meta={bulkProgress.total > 1 ? `${bulkProgress.done} of ${bulkProgress.total}` : undefined} pct={(bulkProgress.done / bulkProgress.total) * 100} />}
        {fileError && <div className="notice err" role="alert">{fileError}</div>}
        <div className="modal-foot">
          <div>
            <button type="button" className="btn sm" onClick={exportConfigJson} title="Save the watermark and mask settings to a file"><FileJson aria-hidden="true" />Save settings</button>
            <button type="button" className="btn sm" onClick={() => document.getElementById("__ic")?.click()}><Upload aria-hidden="true" />Load settings</button>
          </div>
          <div>
            <button type="button" className="btn" onClick={() => setExportOpen(false)} disabled={!!bulkProgress}>Cancel</button>
            <button type="button" className="btn primary" onClick={runExport} disabled={busy || (mode === "video" ? !videoReady || trackStatus === "scanning" : !imgReady)}>
              {bulkProgress ? <Spinner /> : <Download aria-hidden="true" />}
              {bulkProgress ? "Exporting…" : mode === "video" ? "Export video" : exportAll ? `Export ${images.length} images` : "Export image"}
            </button>
          </div>
        </div>
      </Modal>

      <input id="__mi" type="file" accept="image/*,video/*" multiple hidden onChange={e => { if (e.target.files) ingestFiles(e.target.files); e.target.value = ""; }} />
      <input id="__wi" type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) { setWmImgFile(f); saveLogo(f); } e.target.value = ""; }} />
      <input id="__ic" type="file" accept=".json" hidden onChange={e => { if (e.target.files?.[0]) importConfigJson(e.target.files[0]); e.target.value = ""; }} />

      {activeImg && (
        <img key={activeImg.src} src={activeImg.src} alt="" crossOrigin="anonymous"
          onLoad={e => onImgLoad(e.target as HTMLImageElement)}
          style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none" }}
        />
      )}
      {videoSrc && mode === "video" && (
        <video key={videoSrc} src={videoSrc} crossOrigin="anonymous"
          onLoadedMetadata={e => onVideoLoad(e.target as HTMLVideoElement)}
          onLoadedData={() => drawRef.current()}
          onSeeked={() => drawRef.current()}
          autoPlay loop muted={audioRouted ? false : videoMuted} playsInline
          style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        />
      )}

      {pwa.updateReady ? (
        <div className="toast has-action" role="status">
          <span>A new version is ready.{mode && !buildSession() ? " Reloading clears this video: it's too large to keep." : " Your work is kept."}</span>
          <button type="button" className="btn sm" onClick={async () => { await saveRef.current(); applyUpdate(); }}><RefreshCw aria-hidden="true" />Reload</button>
          <button type="button" className="icon-x" onClick={dismissUpdate} aria-label="Later" title="Later"><X aria-hidden="true" /></button>
        </div>
      ) : toastMsg && (
        <div className={`toast${shareFile ? " has-action" : ""}`} role="status">
          <span>{toastMsg}</span>
          {shareFile && <button type="button" className="btn sm" onClick={shareExport}><Share2 aria-hidden="true" />Share or save</button>}
        </div>
      )}
    </div>
  );
}
