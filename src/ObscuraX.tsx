import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import JSZip from "jszip/dist/jszip.min.js";

import { ImageEntry, BulkProgress, WatermarkConfig, Mask, MaskStyle, DetectSettings, TrackSample } from "./types";
import { WM, PRESETS, FONTS, PALETTE, MAX_FILES, FILTERS, DEFAULT_MASK_STYLE, DEFAULT_DETECT_SETTINGS } from "./constants/config";
import { applyWatermark, applyMasks } from "./utils/canvas";
import { loadFaceModels, detectFaces, facesToMasks, boxesAt, seekVideo } from "./utils/faceDetection";
import { detectImageResolution } from "./helpers/media";
import { Field, TextInput, Select, SwitchRow, Range, Seg, ArmedBtn, Spinner, Progress } from "./components/common/Atoms";
import { useTheme } from "./hooks/useTheme";
import {
  ImageIcon, Type, ScanFace, Download, Upload, Sun, Moon, Monitor, Play, Pause, Volume2, VolumeX, X, Check, FileJson,
  ArrowUpLeft, ArrowUp, ArrowUpRight, ArrowLeft, Dot, ArrowRight, ArrowDownLeft, ArrowDown, ArrowDownRight, LucideIcon,
} from "lucide-react";

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const el = new Image();
  el.onload = () => resolve(el);
  el.onerror = reject;
  el.src = src;
});

const MODEL_MISSING_MSG = "The face model hasn't loaded, so faces can't be found. Wait a moment, or turn off Find faces automatically, before exporting.";

type TrackStatus = "idle" | "scanning" | "ready" | "stale";

type Panel = "media" | "watermark" | "masking" | "export";
const NAV: { id: Panel; label: string; Icon: LucideIcon }[] = [
  { id: "media", label: "Media", Icon: ImageIcon },
  { id: "watermark", label: "Watermark", Icon: Type },
  { id: "masking", label: "Face masking", Icon: ScanFace },
  { id: "export", label: "Export", Icon: Download },
];
const PANEL_TITLES: Record<Panel, string> = { media: "Media", watermark: "Watermark", masking: "Face masking", export: "Export" };

const POSITION_ICONS: Record<string, { Icon: LucideIcon; label: string }> = {
  tl: { Icon: ArrowUpLeft, label: "Top left" }, tc: { Icon: ArrowUp, label: "Top centre" }, tr: { Icon: ArrowUpRight, label: "Top right" },
  ml: { Icon: ArrowLeft, label: "Middle left" }, cc: { Icon: Dot, label: "Centre" }, mr: { Icon: ArrowRight, label: "Middle right" },
  bl: { Icon: ArrowDownLeft, label: "Bottom left" }, bc: { Icon: ArrowDown, label: "Bottom centre" }, br: { Icon: ArrowDownRight, label: "Bottom right" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}`;

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

  const [mode, setMode] = useState<"image" | "video" | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [fileError, setFileError] = useState("");

  const [wmType, setWmType] = useState<typeof WM[keyof typeof WM]>(WM.TEXT);
  const [wmText, setWmText] = useState("© Your Brand");
  const [wmLink, setWmLink] = useState("https://yourbrand.com");
  const [wmImgFile, setWmImgFile] = useState<File | null>(null);
  const [wmColor, setWmColor] = useState("#ffffff");
  const [wmFont, setWmFont] = useState(FONTS[0].value);
  const [wmSize, setWmSize] = useState(44);
  const [wmOpacity, setWmOpacity] = useState(75);
  const [wmBold, setWmBold] = useState(false);
  const [wmShadow, setWmShadow] = useState(true);
  const [wmPos, setWmPos] = useState({ x: 0.5, y: 0.93 });
  const [wmFilter, setWmFilter] = useState("none");
  const [wmBlur, setWmBlur] = useState(4);
  const [exportPrefix, setExportPrefix] = useState("watermarked_");

  // Image mode: mirror of the selected image's masks. Video mode: manual masks only
  // (auto face masks come from faceTrack, per frame).
  const [masks, setMasks] = useState<Mask[]>([]);
  const [maskStyle, setMaskStyle] = useState<MaskStyle>(DEFAULT_MASK_STYLE);
  const [detectSettings, setDetectSettings] = useState<DetectSettings>(DEFAULT_DETECT_SETTINGS);
  const [maskingMode, setMaskingMode] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>("bc");
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [autoMaskEnabled, setAutoMaskEnabled] = useState(true);
  const [faceTrack, setFaceTrack] = useState<TrackSample[]>([]);
  const [trackStatus, setTrackStatus] = useState<TrackStatus>("idle");
  const [scan, setScan] = useState<{ label: string; pct: number } | null>(null);
  const scanToken = useRef(0);
  const drawingId = useRef<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [expPct, setExpPct] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2600);
  }, []);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const vidElRef = useRef<HTMLVideoElement | null>(null);
  const wmImgEl = useRef<HTMLImageElement | null>(null);
  const animRef = useRef<number | null>(null);
  const dragging = useRef(false);
  const maskStart = useRef<{ x: number; y: number } | null>(null);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });

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

  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoSrc(url); setVideoReady(false);
    // New video: drop the previous video's masks and face track, cancel any scan.
    scanToken.current++;
    setMasks([]); setFaceTrack([]); setTrackStatus("idle"); setScan(null);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const wmConfig = useCallback((): WatermarkConfig => ({
    wmType, wmText, wmLink, wmColor, wmFont, wmSize,
    wmOpacity, wmBold, wmShadow, wmPos,
    wmImgEl: wmImgEl.current,
    wmFilter,
    wmBlur,
  }), [wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter, wmBlur]);

  const draw = useCallback(() => {
    const cvs = canvasRef.current;
    const med = mode === "video" ? vidElRef.current : imgElRef.current;
    const ready = mode === "video" ? videoReady : imgReady;
    if (!cvs || !med || !ready) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const cfg = wmConfig();
    let filter = cfg.wmFilter || "none";
    if (filter === "blur") filter = `blur(${cfg.wmBlur}px)`;
    ctx.filter = filter;
    ctx.drawImage(med, 0, 0, cvs.width, cvs.height);
    ctx.filter = "none";
    let active = masks;
    if (mode === "video" && autoMaskEnabled && faceTrack.length) {
      active = [...facesToMasks(boxesAt(faceTrack, (med as HTMLVideoElement).currentTime)), ...masks];
    }
    applyMasks(ctx, cvs.width, cvs.height, active, maskStyle);
    applyWatermark(ctx, cvs.width, cvs.height, cfg);
  }, [mode, imgReady, videoReady, wmConfig, masks, autoMaskEnabled, faceTrack, maskStyle]);

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
      ? { ...img, scanned: true, masks: [...autos, ...img.masks.filter(m => !m.isAuto)] }
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
    try {
      for (let i = 0; i < n; i++) {
        if (token !== scanToken.current) return false;
        const t = Math.min(i / fps, lastT);
        if (samples.length && t <= samples[samples.length - 1].t) continue;
        await seekVideo(vid, t);
        if (token !== scanToken.current) return false;
        samples.push({ t, boxes: await detectFaces(vid, detectOpts) });
        setScan({ label: `Tracking faces… ${i + 1} of ${n}`, pct: Math.round(((i + 1) / n) * 100) });
      }
    } catch (err) {
      console.error("ObscuraX: Video scan failed:", err);
      if (token === scanToken.current) { setTrackStatus("stale"); setScan(null); }
      return false;
    }
    if (token !== scanToken.current) return false;
    setFaceTrack(samples); setTrackStatus("ready"); setScan(null);
    await seekVideo(vid, t0);
    if (wasPlaying) setVideoPaused(false);
    return true;
  }, [modelsLoaded, detectSettings.scanFps, detectOpts]);

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
    if (mode === "image") updateMasks(() => []);
    else { scanToken.current++; setScan(null); setMasks([]); setFaceTrack([]); setTrackStatus("ready"); }
  };

  const onImgLoad = useCallback((el: HTMLImageElement) => {
    if (!el || !canvasRef.current) return;
    canvasRef.current.width = el.naturalWidth;
    canvasRef.current.height = el.naturalHeight;
    imgElRef.current = el;
    setCanvasDims({ w: el.naturalWidth, h: el.naturalHeight });
    setImgReady(true);
  }, []);

  const onVideoLoad = useCallback((el: HTMLVideoElement) => {
    if (!el || !canvasRef.current) return;
    const w = el.videoWidth || 1280, h = el.videoHeight || 720;
    canvasRef.current.width = w; canvasRef.current.height = h;
    vidElRef.current = el;
    setCanvasDims({ w, h });
    setVideoDur(el.duration);
    setVideoReady(true);
  }, []);

  const ingestFiles = useCallback(async (fileList: FileList | File[]) => {
    setFileError("");
    const incoming = Array.from(fileList);
    const newVideos = incoming.filter(f => f.type.startsWith("video"));
    const newImages = incoming.filter(f => f.type.startsWith("image"));
    if (newVideos.length > 0) { setVideoFile(newVideos[0]); setMode("video"); setImages([]); return; }
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
        return { file, src: URL.createObjectURL(file), w, h, masks: [] };
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

  const posFromEvent = (e: React.MouseEvent | React.TouchEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = "touches" in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const cy = "touches" in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    return { x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)) };
  };

  const onPtrDown = (e: React.MouseEvent | React.TouchEvent) => {
    dragging.current = true;
    const pos = posFromEvent(e);
    if (maskingMode) {
      maskStart.current = pos;
      const id = `m-${Date.now()}`;
      drawingId.current = id;
      updateMasks(prev => [...prev, { id, ...pos, w: 0, h: 0, type: maskStyle.type, isAuto: false }]);
    } else { setActivePreset(null); setWmPos(pos); }
  };

  const onPtrMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!dragging.current) return;
    e.preventDefault();
    const pos = posFromEvent(e);
    const start = maskStart.current, id = drawingId.current;
    if (maskingMode && start && id) {
      updateMasks(prev => prev.map(m => m.id === id ? { ...m, w: pos.x - start.x, h: pos.y - start.y } : m));
    } else if (!maskingMode) { setWmPos(pos); }
  };

  const onPtrUp = () => {
    const id = drawingId.current;
    dragging.current = false; maskStart.current = null; drawingId.current = null;
    if (!maskingMode || !id) return;
    // Normalise negative sizes from dragging up/left; drop accidental clicks.
    updateMasks(prev => prev.flatMap(m => {
      if (m.id !== id) return [m];
      const x = m.w < 0 ? m.x + m.w : m.x, y = m.h < 0 ? m.y + m.h : m.y;
      const w = Math.abs(m.w), h = Math.abs(m.h);
      return w < 0.005 && h < 0.005 ? [] : [{ ...m, x, y, w, h }];
    }));
  };

  const exportConfigJson = () => {
    const cfg = { wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter, wmBlur, exportPrefix, maskStyle, detectSettings };
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
      } catch { setFileError("That settings file couldn't be read. Choose a file saved by ObscuraX."); }
    };
    reader.readAsText(file);
  };

  const exportSingleImage = () => {
    draw();
    if (!canvasRef.current) return;
    const isPng = images[selectedIdx]?.file?.type === "image/png";
    canvasRef.current.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${exportPrefix}${images[selectedIdx]?.file?.name ?? "image"}.${isPng ? "png" : "jpg"}`;
      a.click(); showToast("Image downloaded");
    }, isPng ? "image/png" : "image/jpeg", 0.96);
  };

  const exportBulkZip = async () => {
    if (!images.length) return;
    // Faces in images the user never opened must still be masked.
    const autoScan = maskingMode && autoMaskEnabled;
    if (autoScan && !modelsLoaded) { setFileError(MODEL_MISSING_MSG); return; }
    setFileError("");
    setBulkProgress({ done: 0, total: images.length }); setExportMsg("Building ZIP…");
    const zip = new JSZip(); const folder = zip.folder("watermarked"); const cfg = wmConfig();
    try {
      for (let i = 0; i < images.length; i++) {
        const entry = images[i];
        setBulkProgress({ done: i, total: images.length }); setExportMsg(`Processing ${i + 1} of ${images.length}…`);
        const imgEl = await loadImage(entry.src);
        let entryMasks = entry.masks || [];
        if (autoScan && !entry.scanned) {
          setExportMsg(`Finding faces ${i + 1} of ${images.length}…`);
          const autos = facesToMasks(await detectFaces(imgEl, detectOpts));
          entryMasks = [...autos, ...entryMasks.filter(m => !m.isAuto)];
          setAutoMasks(entry.src, autos);
        }
        const offscr = document.createElement("canvas"); offscr.width = imgEl.naturalWidth; offscr.height = imgEl.naturalHeight;
        const ctx = offscr.getContext("2d"); if (!ctx) continue;
        let filter = cfg.wmFilter || "none";
        if (filter === "blur") filter = `blur(${cfg.wmBlur}px)`;
        ctx.filter = filter; ctx.drawImage(imgEl, 0, 0); ctx.filter = "none";
        applyMasks(ctx, offscr.width, offscr.height, entryMasks, maskStyle); applyWatermark(ctx, offscr.width, offscr.height, cfg);
        const blob = await new Promise<Blob | null>(res => offscr.toBlob(res, entry.file.type === "image/png" ? "image/png" : "image/jpeg", 0.96));
        if (blob) { const buf = await blob.arrayBuffer(); const ext = entry.file.type === "image/png" ? "png" : "jpg"; folder!.file(`${exportPrefix}${entry.file.name.replace(/\.[^.]+$/, "")}.${ext}`, buf); }
      }
    } catch (err) {
      // Don't ship a partial ZIP that may contain unmasked faces.
      console.error("ObscuraX: Bulk export failed:", err);
      setFileError("Export stopped because an image couldn't be processed. Nothing was saved. Try again, or remove that image.");
      setBulkProgress(null); setExportMsg("");
      return;
    }
    setBulkProgress({ done: images.length, total: images.length }); setExportMsg("Compressing…");
    const zipBlob = await zip.generateAsync({ type: "blob" }, (meta: { percent: number }) => setExpPct(Math.round(meta.percent)));
    const a = document.createElement("a"); a.href = URL.createObjectURL(zipBlob); a.download = `${exportPrefix}images.zip`; a.click();
    setBulkProgress(null); setExportMsg(""); setExpPct(0); showToast("ZIP downloaded");
  };

  const exportVideo = async () => {
    const cvs = canvasRef.current, vid = vidElRef.current;
    if (!cvs || !vid) return;
    if (maskingMode && autoMaskEnabled) {
      if (!modelsLoaded) { setFileError(MODEL_MISSING_MSG); return; }
      // Never export with a missing or out-of-date face track.
      if (trackStatus !== "ready" && !(await scanVideo())) return;
    }
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const stream = (cvs as any).captureStream(60);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${exportPrefix}video_${Date.now()}.webm`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setExporting(false); setExpPct(0); showToast("Video downloaded");
      if (vidElRef.current) vidElRef.current.playbackRate = 1.0;
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    vid.currentTime = 0; vid.playbackRate = 4.0;
    setExporting(true); setVideoPaused(false); recorder.start(); vid.play();
    const onProg = () => setExpPct(vid.duration ? Math.round((vid.currentTime / vid.duration) * 100) : 0);
    vid.addEventListener("timeupdate", onProg);
    vid.addEventListener("ended", () => { recorder.stop(); vid.removeEventListener("timeupdate", onProg); }, { once: true });
  };

  const activeImg = mode === "image" && images.length > 0 ? images[selectedIdx] : null;

  // ── View ────────────────────────────────────────────────────────────────────
  const { mode: themeMode, cycle: cycleTheme } = useTheme();
  const [panel, setPanel] = useState<Panel>("media");

  // Keep --head-h current so sticky content sits below the header.
  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--head-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = mode === "video" ? videoReady : imgReady;
  const autoFaces = masks.filter(m => m.isAuto).length;
  const drawnMasks = masks.length - autoFaces;
  const peakFaces = faceTrack.reduce((mx, smp) => Math.max(mx, smp.boxes.length), 0);
  const modelLoading = maskingMode && autoMaskEnabled && !modelsLoaded && !modelError;
  const mediaName = mode === "video" ? videoFile?.name ?? "the video" : activeImg?.file.name ?? "this image";
  const ratio = canvasDims.h ? (canvasDims.w / canvasDims.h).toFixed(2) : "";

  const clearImages = () => {
    images.forEach(img => URL.revokeObjectURL(img.src));
    setImages([]); setMode(null); setImgReady(false);
  };
  const removeVideo = () => {
    scanToken.current++;
    setScan(null); setVideoFile(null); setVideoSrc(null); setVideoReady(false); setMode(null);
    setMasks([]); setFaceTrack([]); setTrackStatus("idle");
  };

  // Hero: the one answer this screen gives, how many faces are covered.
  let heroBig = "0", heroUnit: string | null = "faces", heroSub = "Add an image or a video to start.";
  if (mode && !maskingMode) {
    heroBig = "Off"; heroUnit = null; heroSub = "Turn on face masking to find and cover faces.";
  } else if (mode === "image") {
    if (autoMaskEnabled && !activeScanned) {
      heroBig = "…"; heroUnit = null; heroSub = `Looking for faces in ${mediaName}`;
    } else {
      heroBig = String(autoFaces); heroUnit = autoFaces === 1 ? "face" : "faces";
      heroSub = autoMaskEnabled ? `found in ${mediaName}` : "Finding faces is off.";
    }
  } else if (mode === "video") {
    if (trackStatus === "scanning") {
      heroBig = String(scan?.pct ?? 0); heroUnit = "%"; heroSub = "Tracking faces through the video…";
    } else if (!autoMaskEnabled) {
      heroBig = "0"; heroSub = "Finding faces is off.";
    } else if (trackStatus === "ready") {
      heroBig = String(peakFaces); heroUnit = peakFaces === 1 ? "face" : "faces";
      heroSub = faceTrack.length ? "at most in one frame, followed through the video" : "Face track cleared.";
    } else {
      heroBig = "–"; heroUnit = null;
      heroSub = trackStatus === "stale" ? "Settings changed. Rescan to update the face track." : "The video hasn't been scanned yet.";
    }
  }
  if (mode && maskingMode && drawnMasks > 0) heroSub += ` · ${plural(drawnMasks, "drawn mask")}`;

  let activity: string | null = null;
  if (modelLoading) activity = "Loading face model…";
  else if (scan) activity = scan.label;
  else if (mode === "image" && maskingMode && autoMaskEnabled && modelsLoaded && !activeScanned) activity = "Finding faces…";

  const exportAction = mode === "video"
    ? { label: exporting ? `Recording… ${expPct}%` : "Export video", run: exportVideo, busy: exporting, disabled: !videoReady || exporting || trackStatus === "scanning" }
    : images.length > 1
      ? { label: bulkProgress ? exportMsg || "Exporting…" : `Export all (${images.length})`, run: exportBulkZip, busy: !!bulkProgress, disabled: !!bulkProgress || !!scan }
      : { label: "Export image", run: exportSingleImage, busy: false, disabled: !imgReady };

  const pickFiles = () => document.getElementById("__mi")?.click();
  const renderDrop = (large: boolean) => (
    <button type="button" className={`drop${large ? " lg" : ""}${dropActive ? " over" : ""}`} onClick={pickFiles}
      onDragOver={e => { e.preventDefault(); setDropActive(true); }}
      onDragLeave={() => setDropActive(false)}
      onDrop={onMediaDrop}>
      <Upload aria-hidden="true" />
      <span className="t">
        {large ? "Drop images or a video here" : images.length ? `Add more images (${images.length} of ${MAX_FILES})` : "Add images or a video"}
      </span>
      <span className="sub">{large ? `Or click to choose. Up to ${MAX_FILES} images, or one video.` : `JPG, PNG, GIF, MP4 or WebM · up to ${MAX_FILES} images`}</span>
    </button>
  );

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

  return (
    <div className="app">
      <aside className="nav">
        <div className="brand">ObscuraX</div>
        <div className="brand-sub">Blur faces, add watermarks</div>
        <nav className="nav-list" aria-label="Sections">
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} type="button" className="nav-item" aria-current={panel === id ? "page" : undefined} onClick={() => setPanel(id)}>
              <Icon aria-hidden="true" />
              <span className="nav-label">{label}</span>
              {id === "media" && images.length > 0 && <span className="nbadge" aria-label={plural(images.length, "image")}>{images.length}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-end">
          <button type="button" className="nav-item" onClick={cycleTheme} aria-label={`Colour mode: ${themeLabel}. Click to change.`} title="Change colour mode">
            <ThemeIcon aria-hidden="true" />
            <span className="nav-label">{themeLabel}</span>
          </button>
        </div>
      </aside>

      <main>
        <header className="top" ref={headerRef}>
          <h1 id="title">{PANEL_TITLES[panel]}</h1>
          <div className="actions">
            {activity && <span className="activity" role="status"><Spinner />{activity}</span>}
            <button type="button" className="btn primary" onClick={exportAction.run} disabled={!mode || exportAction.disabled}>
              {exportAction.busy ? <Spinner /> : <Download aria-hidden="true" />}
              {mode ? exportAction.label : "Export"}
            </button>
          </div>
        </header>

        <div className="ws">
          <div className="ws-preview">
            <section className="card" aria-label="Preview">
              {!mode ? renderDrop(true) : (
                <>
                  <div className="pv-meta">
                    <span>{maskingMode ? "Drag on the preview to add a mask" : "Drag on the preview to move the watermark"}</span>
                    {canvasDims.w > 0 && <span className="num">{canvasDims.w} × {canvasDims.h} px · {ratio}:1</span>}
                  </div>
                  <div className="pv-stage">
                    <canvas ref={canvasRef} aria-label={`Preview of ${mediaName}`}
                      onMouseDown={onPtrDown} onMouseMove={onPtrMove} onMouseUp={onPtrUp} onMouseLeave={onPtrUp}
                      onTouchStart={e => { e.preventDefault(); onPtrDown(e); }}
                      onTouchMove={e => { e.preventDefault(); onPtrMove(e); }}
                      onTouchEnd={onPtrUp}
                    />
                    {!ready && <div className="pv-loading"><Spinner />Loading media…</div>}
                  </div>

                  {mode === "video" && videoReady && (
                    <div className="pv-controls">
                      <button type="button" className="dl-btn" onClick={() => setVideoPaused(!videoPaused)} aria-label={videoPaused ? "Play" : "Pause"} title={videoPaused ? "Play" : "Pause"}>
                        {videoPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                      </button>
                      <button type="button" className="dl-btn" onClick={() => setVideoMuted(!videoMuted)} aria-label={videoMuted ? "Turn sound on" : "Mute"} title={videoMuted ? "Turn sound on" : "Mute"}>
                        {videoMuted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
                      </button>
                      <input type="range" aria-label="Position in video" min={0} max={videoDur || 100} step={0.01} value={videoTime}
                        onChange={e => { const t = Number(e.target.value); if (vidElRef.current) vidElRef.current.currentTime = t; setVideoTime(t); }} />
                      <span className="time">{fmtTime(videoTime)} / {fmtTime(videoDur)}</span>
                    </div>
                  )}

                  {mode === "image" && images.length > 0 && (
                    <div className="gl" role="list" aria-label="Images">
                      {images.map((img, idx) => (
                        <div key={img.src} className="gl-item" role="listitem">
                          <button type="button" className="gl-pick" aria-current={selectedIdx === idx} aria-label={`Show ${img.file.name}`} title={img.file.name} onClick={() => setSelectedIdx(idx)}>
                            <img src={img.src} alt="" />
                          </button>
                          <button type="button" className="gl-remove" aria-label={`Remove ${img.file.name}`} title="Remove" onClick={() => removeImage(idx)}>
                            <X aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>

          <div className="ws-side">
            <section className="card hero" aria-live="polite">
              <div className="what"><span className="chip-ico"><ScanFace aria-hidden="true" /></span>Faces masked</div>
              <div className="big">{heroBig}{heroUnit && <small>{heroUnit}</small>}</div>
              <div className="sub">{heroSub}</div>
            </section>

            {fileError && <div className="notice err" role="alert">{fileError}</div>}

            {panel === "media" && (
              <section className="card">
                <h2>Media</h2>
                {mode ? renderDrop(false) : <p className="hint">JPG, PNG, GIF, MP4 or WebM. Up to {MAX_FILES} images, or one video. Files stay on this device.</p>}
                {mode && canvasDims.w > 0 && (
                  <div className="grid">
                    <div className="stat"><div className="k">Resolution</div><div className="v">{canvasDims.w} × {canvasDims.h}</div></div>
                    <div className="stat"><div className="k">Aspect ratio</div><div className="v">{ratio}:1</div></div>
                    {mode === "image"
                      ? <div className="stat"><div className="k">Images</div><div className="v">{images.length} of {MAX_FILES}</div></div>
                      : <div className="stat"><div className="k">Length</div><div className="v">{fmtTime(videoDur)}</div></div>}
                    <div className="stat"><div className="k">File</div><div className="v" title={mediaName}>{mediaName}</div></div>
                  </div>
                )}
                {mode === "image" && <ArmedBtn className="sm" onConfirm={clearImages}>Remove all images</ArmedBtn>}
                {mode === "video" && <ArmedBtn className="sm" onConfirm={removeVideo}>Remove video</ArmedBtn>}
              </section>
            )}

            {panel === "watermark" && (
              <>
                <section className="card">
                  <h2>Watermark</h2>
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
                    <>
                      <Field label="Colour">{colourSwatches(wmColor, setWmColor, "Watermark colour")}</Field>
                      <Field label="Font" htmlFor="wm-font"><Select id="wm-font" value={wmFont} onChange={setWmFont} options={FONTS} /></Field>
                      <SwitchRow label="Bold" value={wmBold} onChange={setWmBold} />
                    </>
                  )}
                  <SwitchRow label="Shadow" sub="Keeps the watermark readable on light areas." value={wmShadow} onChange={setWmShadow} />
                </section>

                <section className="card">
                  <h2>Size and position</h2>
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
                  <p className="hint">Or turn off face masking and drag on the preview.</p>
                </section>

                <section className="card">
                  <h2>Image filter</h2>
                  <Field label="Filter" htmlFor="wm-filter"><Select id="wm-filter" value={wmFilter} onChange={setWmFilter} options={FILTERS} /></Field>
                  {wmFilter === "blur" && <Range label="Blur radius" value={wmBlur} min={0} max={25} fmt={v => `${v} px`} onChange={setWmBlur} />}
                </section>
              </>
            )}

            {panel === "masking" && (
              <>
                <section className="card">
                  <h2>Masks</h2>
                  <SwitchRow label="Face masking" value={maskingMode} onChange={setMaskingMode}
                    sub={maskingMode ? "Drag on the preview to add your own masks." : "Off: dragging on the preview moves the watermark."} />
                  {maskingMode && (
                    <SwitchRow label="Find faces automatically" value={autoMaskEnabled} onChange={toggleAutoMask}
                      sub="Runs on this device. Nothing is uploaded." />
                  )}
                  {maskingMode && autoMaskEnabled && modelError && (
                    <div className="notice err" role="alert">The face model couldn't be downloaded. Check the internet connection, then reload the page.</div>
                  )}
                </section>

                {maskingMode && autoMaskEnabled && (
                  <section className="card">
                    <h2>Detection</h2>
                    <Range label="Sensitivity" value={Math.round((1 - detectSettings.minConfidence) * 100)} min={10} max={90} fmt={v => `${v}%`}
                      onChange={v => updateDetectSettings({ minConfidence: 1 - v / 100 })} />
                    <SwitchRow label="Find small faces" sub="Checks large photos in sections. Slower." value={detectSettings.smallFaceBoost}
                      onChange={v => updateDetectSettings({ smallFaceBoost: v })} />
                    {mode === "image" && images.length > 1 && (
                      <div style={{ marginTop: 14 }}>
                        {unscannedCount === 0 ? (
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
                        )}
                      </div>
                    )}
                  </section>
                )}

                {maskingMode && autoMaskEnabled && mode === "video" && (
                  <section className="card">
                    <h2>Face tracking</h2>
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
                  </section>
                )}

                {maskingMode && (
                  <section className="card">
                    <h2>Mask style</h2>
                    <div className="lbl">Effect</div>
                    <Seg label="Mask effect" value={maskStyle.type} onChange={t => setMaskStyle(st => ({ ...st, type: t }))}
                      options={[{ value: "blur", label: "Blur" }, { value: "pixelate", label: "Pixelate" }, { value: "box", label: "Solid" }]} />
                    <div className="lbl">Shape</div>
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
                    {autoMaskEnabled && (
                      <Range label="Extra cover around faces" value={maskStyle.padding} min={0} max={60} fmt={v => `${v}%`}
                        onChange={v => setMaskStyle(st => ({ ...st, padding: v }))} />
                    )}
                    {(masks.length > 0 || (mode === "video" && faceTrack.length > 0)) && (
                      <ArmedBtn className="sm" onConfirm={clearAllMasks}>Clear all masks</ArmedBtn>
                    )}
                  </section>
                )}
              </>
            )}

            {panel === "export" && (
              <>
                <section className="card">
                  <h2>Export</h2>
                  <Field label="File name prefix" htmlFor="exp-prefix"><TextInput id="exp-prefix" value={exportPrefix} onChange={setExportPrefix} placeholder="watermarked_" /></Field>
                  {bulkProgress && <Progress label={exportMsg || "Exporting…"} meta={`${bulkProgress.done} of ${bulkProgress.total}`} pct={(bulkProgress.done / bulkProgress.total) * 100} />}
                  {exporting && <Progress label="Recording video" meta={`${expPct}%`} pct={expPct} />}
                  {mode === "image" && images.length > 1 && (
                    <div className="btn-row">
                      <button type="button" className="btn" onClick={exportSingleImage} disabled={!imgReady}><Download aria-hidden="true" />Export this image only</button>
                    </div>
                  )}
                  <p className="hint">
                    {!mode ? "Add media first. " : ""}
                    PNG images stay PNG; other images save as JPG. Videos save as WebM.
                  </p>
                </section>
                <section className="card">
                  <h2>Settings file</h2>
                  <p className="hint">Save the watermark and mask settings to use them again later.</p>
                  <div className="btn-row">
                    <button type="button" className="btn sm" onClick={exportConfigJson}><FileJson aria-hidden="true" />Save settings</button>
                    <button type="button" className="btn sm" onClick={() => document.getElementById("__ic")?.click()}><Upload aria-hidden="true" />Load settings</button>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </main>

      <input id="__mi" type="file" accept="image/*,video/*" multiple hidden onChange={e => { if (e.target.files) ingestFiles(e.target.files); e.target.value = ""; }} />
      <input id="__wi" type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && setWmImgFile(e.target.files[0])} />
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
          autoPlay loop muted={videoMuted} playsInline
          style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        />
      )}

      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
  );
}
