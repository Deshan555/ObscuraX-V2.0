import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import JSZip from "jszip/dist/jszip.min.js";

import { ImageEntry, BulkProgress, WatermarkConfig, Mask, MaskStyle, DetectSettings, TrackSample } from "./types";
import { C } from "./constants/theme";
import { WM, PRESETS, FONTS, PALETTE, MAX_FILES, FILTERS, DEFAULT_MASK_STYLE, DEFAULT_DETECT_SETTINGS } from "./constants/config";
import { applyWatermark, applyMasks } from "./utils/canvas";
import { loadFaceModels, detectFaces, facesToMasks, boxesAt, seekVideo } from "./utils/faceDetection";
import { detectImageResolution } from "./helpers/media";
import { Sect, FL, TI, Toggle, Slider, Btn, WmTab, Seg } from "./components/common/Atoms";

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const el = new Image();
  el.onload = () => resolve(el);
  el.onerror = reject;
  el.src = src;
});

const MODEL_MISSING_MSG = "Face detection model isn't loaded. Wait for it, or turn off Auto-Mask Faces, before exporting.";

type TrackStatus = "idle" | "scanning" | "ready" | "stale";

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
  const [exported, setExported] = useState(false);
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
    setExported(false);
  }, [selectedIdx, images[selectedIdx]?.src, mode]);

  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoSrc(url); setVideoReady(false); setExported(false);
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
      setScan({ label: `Detecting faces ${i + 1}/${todo.length}…`, pct: Math.round((i / todo.length) * 100) });
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
        setScan({ label: `Tracking faces… ${i + 1}/${n}`, pct: Math.round(((i + 1) / n) * 100) });
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
    if (newImages.length === 0) { setFileError("Unsupported file type. Please upload images or a video."); return; }
    setMode("image");
    const combined = [...images, ...newImages].slice(0, MAX_FILES);
    if (images.length + newImages.length > MAX_FILES)
      setFileError(`Maximum ${MAX_FILES} images allowed. Extra files were ignored.`);
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
      } catch (_) { setFileError("Invalid configuration file."); }
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
      a.click(); setExported(true);
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
        setBulkProgress({ done: i, total: images.length }); setExportMsg(`Processing ${i + 1} / ${images.length}…`);
        const imgEl = await loadImage(entry.src);
        let entryMasks = entry.masks || [];
        if (autoScan && !entry.scanned) {
          setExportMsg(`Detecting faces ${i + 1} / ${images.length}…`);
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
      setFileError("Export stopped: face detection or image processing failed.");
      setBulkProgress(null); setExportMsg("");
      return;
    }
    setBulkProgress({ done: images.length, total: images.length }); setExportMsg("Compressing…");
    const zipBlob = await zip.generateAsync({ type: "blob" }, (meta: { percent: number }) => setExpPct(Math.round(meta.percent)));
    const a = document.createElement("a"); a.href = URL.createObjectURL(zipBlob); a.download = `${exportPrefix}images.zip`; a.click();
    setBulkProgress(null); setExportMsg(""); setExpPct(0); setExported(true);
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
      setExporting(false); setExpPct(0); setExported(true);
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.bg, color: C.text, fontFamily: "'JetBrains Mono',monospace", overflow: "hidden" }}>

      <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 22px", background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 20, color: C.gold, letterSpacing: 1.5, whiteSpace: "nowrap" }}>ObscuraX</span>
        <div style={{ width: 1, height: 16, background: C.border, flexShrink: 0 }} />
        <div style={{ display: "flex", gap: 5 }}>
          {["Face Blur", "Video", "Masking", "Filters", "ZIP Export"].map(t => (
            <span key={t} style={{ fontSize: 8, padding: "2px 7px", borderRadius: 3, background: C.card, border: `1px solid ${C.border}`, color: C.muted, letterSpacing: 1.2, whiteSpace: "nowrap" }}>{t}</span>
          ))}
        </div>
        {images.length > 0 && (
          <div style={{ marginLeft: "auto", flexShrink: 0 }}>
            <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 4, background: C.goldBg, color: C.gold, border: `1px solid ${C.goldDim}` }}>{images.length} / {MAX_FILES} images</span>
          </div>
        )}
        {mode === "video" && videoFile && (
          <div style={{ marginLeft: images.length > 0 ? 0 : "auto", flexShrink: 0 }}>
            <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 4, background: C.purpleBg, color: C.purple, border: `1px solid ${C.purple}` }}>VIDEO</span>
          </div>
        )}
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        <aside style={{ width: 278, flexShrink: 0, background: C.panel, borderRight: `1px solid ${C.border}`, overflowY: "auto", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 20 }}>

          <div>
            <Sect>Source Media</Sect>
            <div
              onClick={() => document.getElementById("__mi")?.click()}
              onDragOver={e => { e.preventDefault(); setDropActive(true); }}
              onDragLeave={() => setDropActive(false)}
              onDrop={onMediaDrop}
              style={{ border: `2px dashed ${dropActive ? C.gold : C.border}`, borderRadius: 10, padding: "16px 12px", textAlign: "center", cursor: "pointer", background: dropActive ? C.goldBg : C.card, transition: "all .18s" }}
            >
              <div style={{ fontSize: 22, marginBottom: 5 }}>📂</div>
              <div style={{ fontSize: 11, color: C.text, marginBottom: 3 }}>{images.length > 0 ? `Add more (${images.length}/${MAX_FILES})` : "Drop files or click to upload"}</div>
              <div style={{ fontSize: 9, color: C.muted }}>JPG · PNG · GIF · MP4 · WEBM · Max {MAX_FILES} images</div>
            </div>
            <input id="__mi" type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={e => e.target.files && ingestFiles(e.target.files)} />
            {fileError && <div style={{ marginTop: 8, fontSize: 9, color: C.red, lineHeight: 1.5 }}>{fileError}</div>}
          </div>

          <div>
            <Sect>Watermark Type</Sect>
            <div style={{ display: "flex", gap: 5 }}>
              <WmTab id={WM.TEXT} label="TEXT" active={wmType === WM.TEXT} onSelect={id => setWmType(id as typeof WM[keyof typeof WM])} />
              <WmTab id={WM.IMG}  label="IMAGE" active={wmType === WM.IMG} onSelect={id => setWmType(id as typeof WM[keyof typeof WM])} />
              <WmTab id={WM.LINK} label="LINK"  active={wmType === WM.LINK} onSelect={id => setWmType(id as typeof WM[keyof typeof WM])} />
            </div>
          </div>

          <div>
            <Sect>Content</Sect>
            {wmType === WM.TEXT && <><FL>Watermark Text</FL><TI value={wmText} onChange={setWmText} placeholder="© Your Brand" /></>}
            {wmType === WM.LINK && (<><FL>URL / Link Label</FL><TI value={wmLink} onChange={setWmLink} placeholder="https://yourbrand.com" /><div style={{ fontSize: 9, color: C.muted, marginTop: 6 }}>Rendered with underline on export</div></>)}
            {wmType === WM.IMG && (<>
              <FL>Logo / Watermark Image</FL>
              <div onClick={() => document.getElementById("__wi")?.click()} style={{ border: `1px dashed ${wmImgFile ? C.goldDim : C.border}`, borderRadius: 8, padding: 14, textAlign: "center", cursor: "pointer", background: C.card }}>
                <div style={{ fontSize: 11, color: wmImgFile ? C.gold : C.muted }}>{wmImgFile ? wmImgFile.name.slice(0, 22) : "Upload PNG logo"}</div>
              </div>
              <input id="__wi" type="file" accept="image/*" style={{ display: "none" }} onChange={e => e.target.files?.[0] && setWmImgFile(e.target.files[0])} />
            </>)}
          </div>

          {(wmType === WM.TEXT || wmType === WM.LINK) && (
            <div>
              <Sect>Appearance</Sect>
              <FL>Colour</FL>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input type="color" value={wmColor} onChange={e => setWmColor(e.target.value)} style={{ width: 36, height: 32, border: `1px solid ${C.border}`, borderRadius: 7, cursor: "pointer", padding: 2, background: "none" }} />
                <input value={wmColor} onChange={e => setWmColor(e.target.value)} style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "7px 10px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none" }} />
              </div>
              <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
                {PALETTE.map(clr => <div key={clr} onClick={() => setWmColor(clr)} style={{ width: 24, height: 24, borderRadius: 5, background: clr, cursor: "pointer", border: wmColor === clr ? `2px solid ${C.gold}` : `1px solid ${C.border}`, boxSizing: "border-box", flexShrink: 0 }} />)}
              </div>
              <FL>Font</FL>
              <select value={wmFont} onChange={e => setWmFont(e.target.value)} style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "8px 28px 8px 10px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none", cursor: "pointer", marginBottom: 14, WebkitAppearance: "none", appearance: "none" }}>
                {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <div style={{ display: "flex", gap: 18 }}>
                <Toggle label="Bold"   value={wmBold}   onChange={setWmBold} />
                <Toggle label="Shadow" value={wmShadow} onChange={setWmShadow} />
              </div>
            </div>
          )}
          {wmType === WM.IMG && <div><Sect>Appearance</Sect><Toggle label="Drop Shadow" value={wmShadow} onChange={setWmShadow} /></div>}

          <div>
            <Sect>Masking</Sect>
            <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              <Toggle label="Masking Mode" value={maskingMode} onChange={setMaskingMode} />
              {maskingMode && <Toggle label="Auto-Mask Faces" value={autoMaskEnabled} onChange={toggleAutoMask} />}
              <div style={{ fontSize: 9, color: C.muted, fontStyle: "italic" }}>{maskingMode ? "Auto-detecting faces + drag to draw masks" : "Reposition watermark"}</div>
              {maskingMode && autoMaskEnabled && !modelsLoaded && (
                <div style={{ fontSize: 9, color: modelError ? C.red : C.muted, lineHeight: 1.5 }}>
                  {modelError ? "Face model failed to load. Check your connection and reload." : "Loading face model…"}
                </div>
              )}
            </div>

            {maskingMode && autoMaskEnabled && (
              <div style={{ marginBottom: 16 }}>
                <FL>Face Detection</FL>
                <Slider label="Sensitivity" value={Math.round((1 - detectSettings.minConfidence) * 100)} min={10} max={90} fmt={v => `${v}%`}
                  onChange={v => updateDetectSettings({ minConfidence: 1 - v / 100 })} />
                <Slider label="Face Padding" value={maskStyle.padding} min={0} max={60} fmt={v => `${v}%`}
                  onChange={v => setMaskStyle(st => ({ ...st, padding: v }))} />
                <Toggle label="Small-face boost (slower)" value={detectSettings.smallFaceBoost} onChange={v => updateDetectSettings({ smallFaceBoost: v })} />

                {mode === "image" && images.length > 1 && (
                  <div style={{ marginTop: 12 }}>
                    {unscannedCount > 0 ? (
                      <button onClick={detectAllImages} disabled={!modelsLoaded || !!scan} style={{ width: "100%", padding: "8px", background: C.goldBg, border: `1px solid ${C.goldDim}`, borderRadius: 6, color: C.gold, fontSize: 9, cursor: "pointer", fontWeight: 600, letterSpacing: 1 }}>
                        {scan ? scan.label.toUpperCase() : `DETECT IN ALL IMAGES (${unscannedCount} LEFT)`}
                      </button>
                    ) : (
                      <div style={{ fontSize: 9, color: C.teal }}>✓ All {images.length} images scanned for faces</div>
                    )}
                    {unscannedCount > 0 && !scan && <div style={{ fontSize: 9, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>Unscanned images are detected automatically on ZIP export.</div>}
                  </div>
                )}

                {mode === "video" && (
                  <div style={{ marginTop: 14 }}>
                    <FL>Face Tracking</FL>
                    <Slider label="Scan Rate" value={detectSettings.scanFps} min={2} max={15} fmt={v => `${v} fps`} accent={C.purple}
                      onChange={v => updateDetectSettings({ scanFps: v })} />
                    <div style={{ fontSize: 9, lineHeight: 1.5, marginBottom: 8, color: trackStatus === "stale" ? C.gold : trackStatus === "ready" ? C.teal : C.muted }}>
                      {trackStatus === "idle" && "Not scanned yet. Masks will follow faces frame by frame once scanned."}
                      {trackStatus === "scanning" && (scan?.label ?? "Tracking faces…")}
                      {trackStatus === "stale" && "Settings changed or scan cancelled. Rescan to apply (export rescans automatically)."}
                      {trackStatus === "ready" && (faceTrack.length === 0
                        ? "Face track cleared."
                        : `✓ Tracking up to ${faceTrack.reduce((mx, smp) => Math.max(mx, smp.boxes.length), 0)} face(s) across ${faceTrack.length} samples`)}
                    </div>
                    {trackStatus === "scanning" ? (
                      <button onClick={cancelScan} style={{ width: "100%", padding: "8px", background: "#3d1414", border: "1px solid #632222", borderRadius: 6, color: "#ff8a8a", fontSize: 9, cursor: "pointer", fontWeight: 600, letterSpacing: 1 }}>
                        CANCEL SCAN
                      </button>
                    ) : (
                      <button onClick={scanVideo} disabled={!modelsLoaded || !videoReady || exporting} style={{ width: "100%", padding: "8px", background: C.purpleBg, border: `1px solid ${C.purple}`, borderRadius: 6, color: C.purple, fontSize: 9, cursor: "pointer", fontWeight: 600, letterSpacing: 1 }}>
                        {trackStatus === "idle" ? "SCAN VIDEO FOR FACES" : "RESCAN VIDEO"}
                      </button>
                    )}
                  </div>
                )}

                {scan && (
                  <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: C.border }}>
                    <div style={{ width: `${scan.pct}%`, height: "100%", background: mode === "video" ? C.purple : C.gold, borderRadius: 2, transition: "width .2s" }} />
                  </div>
                )}
              </div>
            )}

            {maskingMode && (
              <div style={{ marginBottom: 12 }}>
                <FL>Mask Style</FL>
                <Seg value={maskStyle.type} onChange={t => setMaskStyle(st => ({ ...st, type: t }))}
                  options={[{ value: "blur", label: "BLUR" }, { value: "pixelate", label: "PIXEL" }, { value: "box", label: "BOX" }]} />
                <FL>Shape</FL>
                <Seg value={maskStyle.shape} onChange={sh => setMaskStyle(st => ({ ...st, shape: sh }))}
                  options={[{ value: "ellipse", label: "OVAL" }, { value: "rect", label: "RECTANGLE" }]} />
                {maskStyle.type === "box" ? (
                  <>
                    <FL>Box Colour</FL>
                    <div style={{ display: "flex", gap: 5, marginBottom: 14, alignItems: "center" }}>
                      <input type="color" value={maskStyle.color} onChange={e => setMaskStyle(st => ({ ...st, color: e.target.value }))} style={{ width: 30, height: 26, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer", padding: 2, background: "none" }} />
                      {PALETTE.map(clr => <div key={clr} onClick={() => setMaskStyle(st => ({ ...st, color: clr }))} style={{ width: 22, height: 22, borderRadius: 5, background: clr, cursor: "pointer", border: maskStyle.color === clr ? `2px solid ${C.gold}` : `1px solid ${C.border}`, boxSizing: "border-box", flexShrink: 0 }} />)}
                    </div>
                  </>
                ) : (
                  <Slider label={maskStyle.type === "blur" ? "Blur Strength" : "Pixel Size"} value={maskStyle.strength} min={1} max={100} fmt={v => `${v}%`}
                    onChange={v => setMaskStyle(st => ({ ...st, strength: v }))} />
                )}
                <Slider label="Edge Feather" value={maskStyle.feather} min={0} max={100} fmt={v => `${v}%`}
                  onChange={v => setMaskStyle(st => ({ ...st, feather: v }))} />
              </div>
            )}
            {(masks.length > 0 || (mode === "video" && faceTrack.length > 0)) && (
              <button onClick={clearAllMasks} style={{ width: "100%", padding: "7px", background: "#3d1414", border: "1px solid #632222", borderRadius: 6, color: "#ff8a8a", fontSize: 8, letterSpacing: 1.5, cursor: "pointer" }}>
                CLEAR ALL MASKS ({masks.length}{mode === "video" && faceTrack.length > 0 ? " + FACE TRACK" : ""})
              </button>
            )}
            <div style={{ height: 16 }} />
            <Sect>Size &amp; Opacity</Sect>
            <Slider label={wmType === WM.IMG ? "Logo Width" : "Font Size"} value={wmSize} min={8} max={120} fmt={v => wmType === WM.IMG ? `${v * 5}px` : `${v}px`} onChange={setWmSize} />
            <Slider label="Opacity" value={wmOpacity} min={5} max={100} fmt={v => `${v}%`} onChange={setWmOpacity} />
            <FL>Global Filter</FL>
            <select value={wmFilter} onChange={e => setWmFilter(e.target.value)} style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "8px 28px 8px 10px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none", cursor: "pointer", WebkitAppearance: "none", appearance: "none" }}>
              {FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            {wmFilter === "blur" && (
              <div style={{ marginTop: 12 }}>
                <Slider label="Blur Radius" value={wmBlur} min={0} max={25} fmt={v => `${v}px`} onChange={setWmBlur} />
              </div>
            )}
          </div>

          <div>
            <Sect>Position</Sect>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 4, marginBottom: 8 }}>
              {PRESETS.map(p => (
                <button key={p.id} onClick={() => { setActivePreset(p.id); setWmPos({ x: p.x, y: p.y }); }} style={{ padding: "9px 0", background: activePreset === p.id ? C.gold : C.card, border: `1px solid ${activePreset === p.id ? C.gold : C.border}`, borderRadius: 7, cursor: "pointer", color: activePreset === p.id ? C.bg : C.muted, fontSize: 16, transition: "all .12s" }}>
                  {p.icon}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: C.muted, textAlign: "center", letterSpacing: 1.5 }}>OR DRAG ON CANVAS</div>
          </div>

          <div>
            <Sect>Export Settings</Sect>
            <FL>Filename Prefix</FL>
            <TI value={exportPrefix} onChange={setExportPrefix} placeholder="e.g. obscurax_" />
            <div style={{ height: 12 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={exportConfigJson} style={{ flex: 1, padding: "7px", background: C.subtle, border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, fontSize: 8, letterSpacing: 1.5, cursor: "pointer" }}>EXPORT CONFIG</button>
              <button onClick={() => document.getElementById("__ic")?.click()} style={{ flex: 1, padding: "7px", background: C.subtle, border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, fontSize: 8, letterSpacing: 1.5, cursor: "pointer" }}>IMPORT CONFIG</button>
              <input id="__ic" type="file" accept=".json" style={{ display: "none" }} onChange={e => e.target.files?.[0] && importConfigJson(e.target.files[0])} />
            </div>
            <div style={{ height: 16 }} />
            <Sect>Export Actions</Sect>

            {mode === "image" && <Btn onClick={exportSingleImage} disabled={!imgReady}>↓ EXPORT CURRENT IMAGE</Btn>}

            {mode === "image" && images.length > 1 && (
              <>
                <Btn onClick={exportBulkZip} disabled={!!bulkProgress} color={C.teal}>
                  {bulkProgress ? `⏳ ${exportMsg || `${bulkProgress.done}/${bulkProgress.total}`}` : `⬇ EXPORT ALL AS ZIP (${images.length})`}
                </Btn>
                {bulkProgress && <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: C.border }}><div style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%`, height: "100%", background: C.teal, borderRadius: 2, transition: "width .3s" }} /></div>}
              </>
            )}

            {mode === "video" && (
              <>
                <Btn onClick={exportVideo} disabled={!videoReady || exporting || trackStatus === "scanning"}>
                  {exporting ? `● RECORDING  ${expPct}%` : "↓ EXPORT VIDEO"}
                </Btn>
                {exporting && <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: C.border }}><div style={{ width: `${expPct}%`, height: "100%", background: C.gold, borderRadius: 2, transition: "width .3s" }} /></div>}
              </>
            )}

            {exported && !bulkProgress && <div style={{ marginTop: 10, textAlign: "center", fontSize: 10, color: C.teal, letterSpacing: 1 }}>✓ SAVED TO DOWNLOADS</div>}
          </div>
        </aside>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", background: C.bg, overflow: "hidden" }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 24px 12px", overflow: "hidden", position: "relative" }}>
            {!mode ? (
              <div style={{ textAlign: "center", opacity: 0.28, pointerEvents: "none" }}>
                <div style={{ fontSize: 56, marginBottom: 14 }}>🎞</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 4, letterSpacing: 1 }}>Upload media to begin</div>
                <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5 }}>Up to {MAX_FILES} images · or one video · Drag-and-drop or browse</div>
              </div>
            ) : (
              <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1.5 }}>DRAG ON CANVAS TO REPOSITION WATERMARK</div>
                  {canvasDims.w > 0 && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 9, color: C.muted }}>AUTO-DETECTED:</span>
                      <span style={{ fontSize: 10, color: C.gold, fontWeight: 600 }}>{canvasDims.w} × {canvasDims.h} px</span>
                      <span style={{ fontSize: 9, color: C.muted }}>({(canvasDims.w / canvasDims.h).toFixed(2)}:1)</span>
                    </div>
                  )}
                </div>

                <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: `1px solid ${C.border}`, boxShadow: "0 20px 70px rgba(0,0,0,.8)", background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <canvas ref={canvasRef} style={{ display: "block", maxWidth: "100%", height: "auto", maxHeight: "58vh", cursor: "crosshair" }}
                    onMouseDown={onPtrDown} onMouseMove={onPtrMove} onMouseUp={onPtrUp} onMouseLeave={onPtrUp}
                    onTouchStart={e => { e.preventDefault(); onPtrDown(e); }}
                    onTouchMove={e => { e.preventDefault(); onPtrMove(e); }}
                    onTouchEnd={onPtrUp}
                  />
                  {(imgReady || videoReady) && (
                    <div style={{ position: "absolute", top: 10, right: 10, fontSize: 9, letterSpacing: 1.5, color: C.gold, background: `${C.bg}dd`, padding: "3px 8px", borderRadius: 4, border: `1px solid ${C.goldDim}`, pointerEvents: "none" }}>LIVE PREVIEW</div>
                  )}
                  {mode && !(imgReady || videoReady) && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: C.card, color: C.muted, fontSize: 11, letterSpacing: 1.5 }}>LOADING MEDIA…</div>
                  )}
                </div>

                {(imgReady || videoReady) && (
                  <div style={{ display: "flex", background: C.panel, borderRadius: 8, border: `1px solid ${C.border}`, overflow: "hidden" }}>
                    {[
                      { label: "TYPE", value: wmType.toUpperCase() },
                      { label: "SIZE", value: wmType === WM.IMG ? `${wmSize * 5}px` : `${wmSize}px` },
                      { label: "OPACITY", value: `${wmOpacity}%` },
                      { label: "X", value: `${Math.round(wmPos.x * 100)}%` },
                      { label: "Y", value: `${Math.round(wmPos.y * 100)}%` },
                      { label: "RESOLUTION", value: canvasDims.w > 0 ? `${canvasDims.w}×${canvasDims.h}` : "—" },
                    ].map(({ label, value }, i, arr) => (
                      <div key={label} style={{ flex: 1, textAlign: "center", padding: "8px 4px", borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none" }}>
                        <div style={{ fontSize: 8, color: C.muted, letterSpacing: 1.5, marginBottom: 3 }}>{label}</div>
                        <div style={{ fontSize: 10, color: C.gold, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
                      </div>
                    ))}
                  </div>
                )}

                {mode === "video" && videoReady && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.panel, padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}` }}>
                    <button onClick={() => setVideoPaused(!videoPaused)} style={{ background: "none", border: "none", color: C.gold, fontSize: 16, cursor: "pointer", width: 24 }}>{videoPaused ? "▶" : "⏸"}</button>
                    <button onClick={() => setVideoMuted(!videoMuted)} style={{ background: "none", border: "none", color: C.gold, fontSize: 16, cursor: "pointer", width: 24, display: "flex", alignItems: "center", justifyContent: "center" }}>{videoMuted ? "🔇" : "🔊"}</button>
                    <input type="range" min={0} max={videoDur || 100} step={0.01} value={videoTime} onChange={e => { const t = Number(e.target.value); if (vidElRef.current) vidElRef.current.currentTime = t; setVideoTime(t); }} style={{ flex: 1, cursor: "pointer", height: 3, borderRadius: 2, background: C.subtle, accentColor: C.gold }} />
                    <div style={{ fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>{Math.floor(videoTime / 60)}:{Math.floor(videoTime % 60).toString().padStart(2, "0")} / {Math.floor(videoDur / 60)}:{Math.floor(videoDur % 60).toString().padStart(2, "0")}</div>
                  </div>
                )}
              </div>
            )}
          </div>

          {mode === "image" && images.length > 0 && (
            <div style={{ flexShrink: 0, borderTop: `1px solid ${C.border}`, background: C.panel, padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 9, letterSpacing: 2.5, textTransform: "uppercase", color: C.muted }}>Image Gallery</div>
                <span style={{ fontSize: 9, color: C.gold }}>{images.length} file{images.length !== 1 ? "s" : ""}</span>
                <button onClick={() => { images.forEach(img => URL.revokeObjectURL(img.src)); setImages([]); setMode(null); setImgReady(false); }} style={{ marginLeft: "auto", fontSize: 9, color: C.muted, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>CLEAR ALL</button>
                {images.length < MAX_FILES && <button onClick={() => document.getElementById("__mi")?.click()} style={{ fontSize: 9, color: C.gold, background: C.goldBg, border: `1px solid ${C.goldDim}`, borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>+ ADD MORE</button>}
              </div>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
                {images.map((img, idx) => (
                  <div key={img.src} onClick={() => setSelectedIdx(idx)} style={{ position: "relative", flexShrink: 0, width: 88, borderRadius: 7, overflow: "hidden", border: `2px solid ${selectedIdx === idx ? C.gold : C.border}`, cursor: "pointer", transition: "border-color .15s", background: C.card }}>
                    <img src={img.src} alt={img.file.name} style={{ display: "block", width: "100%", height: "auto", maxHeight: 62, objectFit: "cover" }} />
                    {img.w > 0 && <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(7,8,15,.82)", padding: "2px 4px", fontSize: 7, color: C.gold, textAlign: "center" }}>{img.w}×{img.h}</div>}
                    {selectedIdx === idx && <div style={{ position: "absolute", top: 4, left: 4, width: 14, height: 14, borderRadius: "50%", background: C.gold, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: C.bg, fontWeight: 700 }}>✓</div>}
                    <button onClick={e => { e.stopPropagation(); removeImage(idx); }} style={{ position: "absolute", top: 3, right: 3, width: 16, height: 16, borderRadius: "50%", background: "rgba(248,113,113,.9)", border: "none", cursor: "pointer", fontSize: 9, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

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
    </div>
  );
}
