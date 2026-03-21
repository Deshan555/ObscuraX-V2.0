/**
 * WatermarkStudio v2
 * ─────────────────────────────────────────────────────────────────
 *  Features:
 *   • Multi-image import (up to 20 files) + single video support
 *   • Auto-detected resolution shown per thumbnail & preview
 *   • Fixed canvas preview — proper aspect ratio, zero stretching
 *   • Thumbnail grid with per-file resolution badge + remove button
 *   • Watermark types: Text | Image Logo | Link
 *   • Drag-to-reposition watermark on canvas
 *   • 9-grid preset positions
 *   • Opacity, size, colour, font, bold, shadow controls
 *   • Single export (current image / video)
 *   • Bulk export → ZIP  (all images, watermark baked into each)
 *
 *  Install dependency:   npm install jszip
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useRef, useEffect, useCallback } from "react";
import JSZip from "jszip/dist/jszip.min.js";
import * as faceapi from "face-api.js";

// ── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  bg: "#07080f",
  panel: "#0c0d18",
  card: "#10111f",
  cardHov: "#14152a",
  border: "#1c1d30",
  gold: "#e8b86d",
  goldDim: "#7a5a28",
  goldBg: "#e8b86d15",
  purple: "#8b7cf8",
  purpleBg: "#8b7cf815",
  teal: "#3ecf8e",
  tealBg: "#3ecf8e15",
  red: "#f87171",
  text: "#dce4f0",
  muted: "#4a5570",
  subtle: "#1e2035",
};

// ── Watermark types ────────────────────────────────────────────────────────────
const WM = { TEXT: "text", IMG: "img", LINK: "link" };

// ── 9-grid position presets (normalised 0–1) ───────────────────────────────────
const PRESETS = [
  { id: "tl", x: .07, y: .07, icon: "↖" }, { id: "tc", x: .50, y: .07, icon: "↑" }, { id: "tr", x: .93, y: .07, icon: "↗" },
  { id: "ml", x: .07, y: .50, icon: "←" }, { id: "cc", x: .50, y: .50, icon: "·" }, { id: "mr", x: .93, y: .50, icon: "→" },
  { id: "bl", x: .07, y: .93, icon: "↙" }, { id: "bc", x: .50, y: .93, icon: "↓" }, { id: "br", x: .93, y: .93, icon: "↘" },
];

const FONTS = [
  { label: "Serif", value: "Georgia,'Times New Roman',serif" },
  { label: "Sans", value: "'Helvetica Neue',Helvetica,Arial,sans-serif" },
  { label: "Mono", value: "'Courier New',Courier,monospace" },
  { label: "Impact", value: "Impact,Haettenschweiler,'Arial Narrow Bold',sans-serif" },
  { label: "Arial", value: "Arial,sans-serif" },
  { label: "Optima", value: "Optima,sans-serif" },
  { label: "Avenir", value: "Avenir,sans-serif" },
  { label: "Gill Sans", value: "'Gill Sans',sans-serif" },
  { label: "Menlo", value: "Menlo,monospace" },
  { label: "Typewriter", value: "'American Typewriter',serif" },
];

const PALETTE = ["#ffffff", "#000000", "#e8b86d", "#ff4d4d", "#4d94ff", "#3ecf8e"];
const MAX_FILES = 20;

const FILTERS = [
  { label: "None",       value: "none" },
  { label: "Grayscale",  value: "grayscale(100%)" },
  { label: "Sepia",      value: "sepia(100%)" },
  { label: "Invert",     value: "invert(100%)" },
  { label: "Blur",       value: "blur(4px)" },
  { label: "Bright",     value: "brightness(1.5)" },
  { label: "Contrast",   value: "contrast(1.6)" },
  { label: "Vintage",    value: "sepia(50%) contrast(1.2) brightness(0.9)" },
];

// ── Types ──────────────────────────────────────────────────────────────────────
interface ImageEntry {
  file: File;
  src: string;
  w: number;
  h: number;
}

interface BulkProgress {
  done: number;
  total: number;
}

interface WatermarkConfig {
  wmType: string;
  wmText: string;
  wmLink: string;
  wmColor: string;
  wmFont: string;
  wmSize: number;
  wmOpacity: number;
  wmBold: boolean;
  wmShadow: boolean;
  wmPos: { x: number; y: number };
  wmImgEl: HTMLImageElement | null;
  wmFilter: string;
}

type MaskType = "blur" | "box" | "pixelate";
interface Mask {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: MaskType;
  isAuto?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
/**
 * Returns a Promise<{width,height}> for an image File.
 * Used to pre-detect resolution before it's drawn to canvas.
 */
function detectImageResolution(file: File): Promise<{ w: number, h: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/**
 * Draws a single watermark layer onto an existing canvas context.
 * Extracted so both live-preview and batch-export share the same logic.
 */
function applyWatermark(ctx: CanvasRenderingContext2D, W: number, H: number, config: any) {
  const { wmType, wmText, wmLink, wmColor, wmFont, wmSize,
    wmOpacity, wmBold, wmShadow, wmPos, wmImgEl } = config;

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

/**
 * Draws masks (blur or solid box) onto the canvas.
 */
function applyMasks(ctx: CanvasRenderingContext2D, W: number, H: number, masks: Mask[]) {
  masks.forEach(m => {
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
      const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h);
      const sw = Math.max(1, Math.floor(rw / pSize));
      const sh = Math.max(1, Math.floor(rh / pSize));
      const off = document.createElement("canvas");
      off.width = sw; off.height = sh;
      const octx = off.getContext("2d");
      if (octx) {
        octx.drawImage(ctx.canvas, rx, ry, rw, rh, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, sw, sh, rx, ry, rw, rh);
        ctx.imageSmoothingEnabled = true;
      }
    } else { // box
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
export default function WatermarkStudio() {

  // Load fonts
  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600;700&display=swap";
    document.head.appendChild(l);
    return () => { try { document.head.removeChild(l); } catch (_) { } };
  }, []);

  // ── Image gallery state ──────────────────────────────────────────────────────
  /**
   * Each entry: { file: File, src: string (objectURL), w: number, h: number }
   * Resolved asynchronously after file selection.
   */
  const [images, setImages] = useState<ImageEntry[]>([]);          // gallery entries
  const [selectedIdx, setSelectedIdx] = useState(0);           // active preview index
  const [imgReady, setImgReady] = useState(false);       // canvas sized & drawn

  // ── Video state (single) ─────────────────────────────────────────────────────
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(true);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);

  // ── Mode: "image" | "video" | null ──────────────────────────────────────────
  const [mode, setMode] = useState<"image" | "video" | null>(null);

  // ── Drop-zone ────────────────────────────────────────────────────────────────
  const [dropActive, setDropActive] = useState(false);
  const [fileError, setFileError] = useState("");

  // ── Watermark config ─────────────────────────────────────────────────────────
  const [wmType, setWmType] = useState(WM.TEXT);
  const [wmText, setWmText] = useState("© Your Brand");
  const [wmLink, setWmLink] = useState("https://yourbrand.com");
  const [wmImgFile, setWmImgFile] = useState<File | null>(null);
  const [wmColor, setWmColor] = useState("#ffffff");
  const [wmFont, setWmFont] = useState(FONTS[0].value);
  const [wmSize, setWmSize] = useState(44);
  const [wmOpacity, setWmOpacity] = useState(75);
  const [wmBold, setWmBold] = useState(false);
  const [wmShadow, setWmShadow] = useState(true);
  const [wmPos, setWmPos] = useState({ x: .50, y: .93 });
  const [wmFilter, setWmFilter] = useState("none");
  const [exportPrefix, setExportPrefix] = useState("watermarked_");
  const [masks, setMasks] = useState<Mask[]>([]);
  const [maskingMode, setMaskingMode] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>("bc");
  const [selMaskIdx, setSelMaskIdx] = useState<number | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [autoMaskEnabled, setAutoMaskEnabled] = useState(true);
  const [maskType, setMaskType] = useState<Mask["type"]>("blur");

  // ── Face Detection Model Loading ─────────────────────────────────────────────
  useEffect(() => {
    const loadModels = async () => {
      try {
        const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        ]);
        setModelsLoaded(true);
      } catch (err) {
        console.error("Failed to load face-api models:", err);
      }
    }
    loadModels();
  }, []);

  const autoDetectFaces = useCallback(async () => {
    if (!modelsLoaded || !mode) return;
    let input: HTMLImageElement | HTMLVideoElement | null = null;
    let inputW = 0, inputH = 0;

    if (mode === "image" && images.length > 0) {
      const entry = images[selectedIdx];
      if (!entry) return;
      const img = new Image();
      img.src = entry.src;
      await new Promise(r => img.onload = r);
      input = img;
      inputW = img.naturalWidth;
      inputH = img.naturalHeight;
    } else if (mode === "video" && vidElRef.current) {
      input = vidElRef.current;
      inputW = input.videoWidth;
      inputH = input.videoHeight;
    }

    if (!input || !inputW || !inputH) return;

    const detections = await faceapi.detectAllFaces(input, new faceapi.TinyFaceDetectorOptions());
    if (detections.length > 0) {
      const newMasks: Mask[] = detections.map(d => ({
        id: Math.random().toString(36).substr(2, 9),
        x: d.box.x / inputW,
        y: d.box.y / inputH,
        w: d.box.width / inputW,
        h: d.box.height / inputH,
        type: maskType,
        isAuto: true
      }));
      setMasks(prev => [...prev, ...newMasks]);
    }
  }, [modelsLoaded, mode, images, selectedIdx, maskType]);

  const scanVideo = useCallback(async () => {
    if (!modelsLoaded || mode !== "video" || !vidElRef.current) return;
    const vid = vidElRef.current;
    const originalTime = vid.currentTime;
    const duration = vid.duration;
    const steps = 6; 
    
    setExporting(true);
    setExportMsg("Scanning video for faces...");

    for (let i = 0; i < steps; i++) {
      vid.currentTime = (i / (steps - 1)) * duration;
      await new Promise(r => vid.onseeked = r);
      await autoDetectFaces();
      setExpPct(Math.round((i / (steps - 1)) * 100));
    }

    vid.currentTime = originalTime;
    setExporting(false);
    setExportMsg("");
    setExpPct(0);
  }, [modelsLoaded, mode, autoDetectFaces]);

  // Auto-detect when media changes
  useEffect(() => {
    if (modelsLoaded && maskingMode && autoMaskEnabled) {
      if (mode === "image" && imgReady) {
        autoDetectFaces();
      } else if (mode === "video" && videoReady) {
        autoDetectFaces();
      }
    }
  }, [modelsLoaded, mode, imgReady, videoReady, autoDetectFaces, selectedIdx, maskingMode, autoMaskEnabled]);

  // ── Export state ─────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [expPct, setExpPct] = useState(0);
  const [exported, setExported] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null); // null | { done, total }

  // ── Canvas / media refs ───────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);   // active <img> element (hidden off-screen)
  const vidElRef = useRef<HTMLVideoElement | null>(null);   // hidden <video> element
  const wmImgEl = useRef<HTMLImageElement | null>(null);   // loaded watermark logo Image
  const animRef = useRef<number | null>(null);   // rAF id for video loop
  const dragging = useRef<boolean>(false);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 }); // for display

  // ── Revoke old object URLs when gallery changes ───────────────────────────────
  useEffect(() => {
    return () => {
      images.forEach(img => { try { URL.revokeObjectURL(img.src); } catch (_) { } });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load watermark logo ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!wmImgFile) {
      wmImgEl.current = null;
      return;
    }
    const url = URL.createObjectURL(wmImgFile);
    const img = new Image();
    img.onload = () => { wmImgEl.current = img; };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [wmImgFile]);

  // ── Sync canvas when selectedIdx changes ─────────────────────────────────────
  useEffect(() => {
    setImgReady(false);
    setExported(false);
  }, [selectedIdx]);

  // ── Video src lifecycle ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoSrc(url);
    setVideoReady(false);
    setExported(false);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  // ── Watermark config as object for applyWatermark() ─────────────────────────
  const wmConfig = useCallback((): WatermarkConfig => ({
    wmType, wmText, wmLink, wmColor, wmFont, wmSize,
    wmOpacity, wmBold, wmShadow, wmPos,
    wmImgEl: wmImgEl.current,
    wmFilter,
  }), [wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter]);

  // ── Settings Import/Export ───────────────────────────────────────────────────
  const exportConfigJson = () => {
    const cfg = {
      wmType, wmText, wmLink, wmColor, wmFont, wmSize,
      wmOpacity, wmBold, wmShadow, wmPos, wmFilter, exportPrefix
    };
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "watermark_settings.json";
    a.click();
  };

  const importConfigJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
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
        if (cfg.exportPrefix) setExportPrefix(cfg.exportPrefix);
      } catch (err) {
        setFileError("Invalid configuration file.");
      }
    };
    reader.readAsText(file);
  };

  // ── Core draw: composites active media + watermark onto preview canvas ────────
  const draw = useCallback(() => {
    const cvs = canvasRef.current;
    const med = mode === "video" ? vidElRef.current : imgElRef.current;
    const ready = mode === "video" ? videoReady : imgReady;
    if (!cvs || !med || !ready) return;

    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const cfg = wmConfig();
    ctx.filter = cfg.wmFilter || "none";
    ctx.drawImage(med, 0, 0, cvs.width, cvs.height);
    ctx.filter = "none";
    applyMasks(ctx, cvs.width, cvs.height, masks);
    applyWatermark(ctx, cvs.width, cvs.height, cfg);
  }, [mode, imgReady, videoReady, wmConfig, masks]);

  // ── Image: redraw on any config change ───────────────────────────────────────
  useEffect(() => {
    if (mode === "image" && imgReady) draw();
  }, [draw, mode, imgReady]);

  // ── Video: rAF loop ───────────────────────────────────────────────────────────
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

  // ── When the hidden <img> loads, size the canvas to native resolution ─────────
  const onImgLoad = useCallback((el: HTMLImageElement) => {
    if (!el || !canvasRef.current) return;
    const w = el.naturalWidth, h = el.naturalHeight;
    canvasRef.current.width = w;
    canvasRef.current.height = h;
    imgElRef.current = el;
    setCanvasDims({ w, h });
    setImgReady(true);
  }, []);

  // ── When the hidden <video> metadata loads, size the canvas ──────────────────
  const onVideoLoad = useCallback((el: HTMLVideoElement) => {
    if (!el || !canvasRef.current) return;
    const w = el.videoWidth || 1280, h = el.videoHeight || 720;
    canvasRef.current.width = w;
    canvasRef.current.height = h;
    vidElRef.current = el;
    setCanvasDims({ w, h });
    setVideoDur(el.duration);
    setVideoReady(true);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // FILE INGESTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Accepts an array of File objects. Filters by type, enforces MAX_FILES cap,
   * detects resolutions asynchronously, and updates gallery state.
   */
  const ingestFiles = useCallback(async (fileList: FileList | File[]) => {
    setFileError("");
    const incoming = Array.from(fileList);

    // Separate images from videos
    const newImages = incoming.filter(f => f.type.startsWith("image"));
    const newVideos = incoming.filter(f => f.type.startsWith("video"));

    if (newVideos.length > 0) {
      // Video mode: take the first video, ignore rest
      setVideoFile(newVideos[0]);
      setMode("video");
      setImages([]);
      return;
    }

    if (newImages.length === 0) {
      setFileError("Unsupported file type. Please upload images or a video.");
      return;
    }

    setMode("image");

    // Enforce cap
    const combined = [...images, ...newImages].slice(0, MAX_FILES);
    if (images.length + newImages.length > MAX_FILES) {
      setFileError(`Maximum ${MAX_FILES} images allowed. Extra files were ignored.`);
    }

    // Build entries with pre-detected resolution
    const entries = await Promise.all(
      combined.map(async (item): Promise<ImageEntry> => {
        // Already processed entries pass through
        if ("src" in item) return item as ImageEntry;
        const file = item as File;
        const { w, h } = await detectImageResolution(file);
        return { file, src: URL.createObjectURL(file), w, h };
      })
    );

    setImages(entries);
    setSelectedIdx(0);
  }, [images]);

  const onMediaDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (e.dataTransfer.files) ingestFiles(e.dataTransfer.files);
  };

  /** Remove one image from the gallery */
  const removeImage = (idx: number) => {
    setImages(prev => {
      URL.revokeObjectURL(prev[idx].src);
      const next = prev.filter((_, i) => i !== idx);
      return next;
    });
    setSelectedIdx(prev => Math.max(0, prev >= idx ? prev - 1 : prev));
    if (images.length === 1) { setMode(null); setImgReady(false); }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // CANVAS DRAG – free watermark repositioning / Masking
  // ─────────────────────────────────────────────────────────────────────────────
  const maskStart = useRef<{ x: number, y: number } | null>(null);

  const posFromEvent = (e: any) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)),
    };
  };

  const onPtrDown = (e: React.MouseEvent | React.TouchEvent) => {
    dragging.current = true;
    const pos = posFromEvent(e);
    if (maskingMode) {
      maskStart.current = pos;
      // Add a temporary mask using the current style
      setMasks(prev => [...prev, { id: Date.now().toString(), ...pos, w: 0, h: 0, type: maskType, isAuto: false }]);
      setSelMaskIdx(masks.length); // Select the new mask
    } else {
      setActivePreset(null);
      setWmPos(pos);
    }
  };

  const onPtrMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (dragging.current) {
      e.preventDefault();
      const pos = posFromEvent(e);
      if (maskingMode && maskStart.current) {
        setMasks(prev => {
          const next = [...prev];
          const curr = next[next.length - 1];
          if (!curr) return prev;
          curr.w = pos.x - maskStart.current!.x;
          curr.h = pos.y - maskStart.current!.y;
          return next;
        });
      } else {
        setWmPos(pos);
      }
    }
  };

  const onPtrUp = () => {
    dragging.current = false;
    maskStart.current = null;
    // Normalize negative width/height
    if (maskingMode) {
      setMasks(prev => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = next[next.length - 1];
        if (last.w < 0) { last.x += last.w; last.w = Math.abs(last.w); }
        if (last.h < 0) { last.y += last.h; last.h = Math.abs(last.h); }
        // Remove tiny masks
        if (Math.abs(last.w) < 0.005 && Math.abs(last.h) < 0.005) return next.slice(0, -1);
        return next;
      });
    }
  };
  const applyPreset = (p: { id: string, x: number, y: number }) => { setActivePreset(p.id); setWmPos({ x: p.x, y: p.y }); };

  const updateMask = (idx: number, updates: Partial<Mask>) => {
    setMasks(prev => prev.map((m, i) => i === idx ? { ...m, ...updates } : m));
  };
  const removeMask = (idx: number) => {
    setMasks(prev => prev.filter((_, i) => i !== idx));
    setSelMaskIdx(null);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // EXPORT – Single image
  // ─────────────────────────────────────────────────────────────────────────────
  const exportSingleImage = () => {
    draw(); // ensure latest frame
    const isPng = images[selectedIdx]?.file?.type === "image/png";
    if (!canvasRef.current) return;
    canvasRef.current.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${exportPrefix}${images[selectedIdx]?.file?.name ?? "image"}.${isPng ? "png" : "jpg"}`;
      a.click();
      setExported(true);
    }, isPng ? "image/png" : "image/jpeg", 0.96);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // EXPORT – Bulk ZIP (all images)
  // ─────────────────────────────────────────────────────────────────────────────
  const exportBulkZip = async () => {
    if (images.length === 0) return;
    setBulkProgress({ done: 0, total: images.length });
    setExportMsg("Building ZIP…");

    const zip = new JSZip();
    const folder = zip.folder("watermarked");
    const cfg = wmConfig();

    for (let i = 0; i < images.length; i++) {
      const entry = images[i];
      setBulkProgress({ done: i, total: images.length });
      setExportMsg(`Processing ${i + 1} / ${images.length}…`);

      // Load image into an off-screen canvas
      const imgEl = await new Promise<HTMLImageElement>((resolve) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.src = entry.src;
      });

      const offscr = document.createElement("canvas");
      offscr.width = imgEl.naturalWidth;
      offscr.height = imgEl.naturalHeight;
      const ctx = offscr.getContext("2d");
      if (!ctx) continue;
      ctx.filter = cfg.wmFilter || "none";
      ctx.drawImage(imgEl, 0, 0);
      ctx.filter = "none";
      applyMasks(ctx, offscr.width, offscr.height, masks);
      applyWatermark(ctx, offscr.width, offscr.height, cfg);

      const blob = await new Promise<Blob | null>(res =>
        offscr.toBlob(res, entry.file.type === "image/png" ? "image/png" : "image/jpeg", 0.96)
      );
      if (blob) {
        const buf = await blob.arrayBuffer();
        const ext = entry.file.type === "image/png" ? "png" : "jpg";
        const name = `${exportPrefix}${entry.file.name.replace(/\.[^.]+$/, "")}.${ext}`;
        folder!.file(name, buf);
      }
    }

    setBulkProgress({ done: images.length, total: images.length });
    setExportMsg("Compressing…");

    const zipBlob = await zip.generateAsync({ type: "blob" }, (meta: { percent: number }) => {
      setExpPct(Math.round(meta.percent));
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipBlob);
    a.download = "watermarked_images.zip";
    a.click();

    setBulkProgress(null);
    setExportMsg("");
    setExpPct(0);
    setExported(true);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // EXPORT – Video
  // ─────────────────────────────────────────────────────────────────────────────
  const exportVideo = () => {
    const cvs = canvasRef.current, vid = vidElRef.current;
    if (!cvs || !vid) return;

    // Use a high-quality mime type
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const stream = (cvs as any).captureStream(60); // Request higher frame rate for potential speedup
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${exportPrefix}video_watermarked_${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setExporting(false);
      setExpPct(0);
      setExported(true);
      if (vidElRef.current) vidElRef.current.playbackRate = 1.0;
      setTimeout(() => URL.revokeObjectURL(url), 1000); // Wait bit before revoking
    };

    vid.currentTime = 0;
    vid.playbackRate = 4.0; 
    setExporting(true);
    setVideoPaused(false); // Enable rAF draw loop
    recorder.start();
    vid.play();

    const onProg = () => {
      setExpPct(vid.duration ? Math.round((vid.currentTime / vid.duration) * 100) : 0);
    };
    vid.addEventListener("timeupdate", onProg);
    vid.addEventListener("ended", () => {
      recorder.stop();
      vid.removeEventListener("timeupdate", onProg);
    }, { once: true });
  };

// ─────────────────────────────────────────────────────────────────────────────
// MICRO-COMPONENTS (Defined MUST be outside to prevent focus-loss on re-render)
// ─────────────────────────────────────────────────────────────────────────────

/** Section divider label */
const Sect = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, letterSpacing: 2.5, textTransform: "uppercase", color: C.muted, marginBottom: 10, paddingBottom: 7, borderBottom: `1px solid ${C.border}` }}>
    {children}
  </div>
);

/** Gradient-track slider */
const Slider = ({ label, value, min, max, step = 1, onChange, fmt }: { label: string, value: number, min: number, max: number, step?: number, onChange: (v: number) => void, fmt?: (v: number) => string }) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: C.gold }}>{fmt ? fmt(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{
          width: "100%", cursor: "pointer", height: 3, borderRadius: 2, outline: "none", border: "none",
          WebkitAppearance: "none", appearance: "none",
          background: `linear-gradient(to right, ${C.gold} ${pct}%, ${C.subtle} ${pct}%)`
        }}
      />
    </div>
  );
};

/** Watermark type pill tab */
const TypeTab = ({ label, id, active, onSelect }: { label: string, id: string, active: boolean, onSelect: (id: string) => void }) => {
  return (
    <button onClick={() => onSelect(id)} style={{ flex: 1, padding: "8px 0", background: active ? C.gold : "transparent", border: `1px solid ${active ? C.gold : C.border}`, borderRadius: 7, color: active ? C.bg : C.muted, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: 1.5, cursor: "pointer", fontWeight: active ? 700 : 500, transition: "all .14s" }}>
      {label}
    </button>
  );
};

/** Toggle switch */
const Toggle = ({ label, value, onChange }: { label: string, value: boolean, onChange: (v: boolean) => void }) => (
  <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", userSelect: "none" }}>
    <div onClick={() => onChange(!value)} style={{ width: 34, height: 18, borderRadius: 9, position: "relative", background: value ? C.gold : C.subtle, transition: "background .18s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: value ? 17 : 3, width: 12, height: 12, borderRadius: "50%", background: value ? C.bg : C.muted, transition: "left .18s" }} />
    </div>
    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: C.muted }}>{label}</span>
  </label>
);

/** Styled text input */
const TI = ({ value, onChange, placeholder }: { value: string, onChange: (v: string) => void, placeholder?: string }) => (
  <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    style={{ width: "100%", boxSizing: "border-box", background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "9px 12px", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, outline: "none", transition: "border-color .15s" }}
    onFocus={e => (e.target as HTMLInputElement).style.borderColor = C.goldDim}
    onBlur={e => (e.target as HTMLInputElement).style.borderColor = C.border}
  />
);

/** Small field label */
const FL = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>{children}</div>
);

  // ─────────────────────────────────────────────────────────────────────────────
  // Resolve active image entry for the hidden <img> key
  const activeImg = mode === "image" && images.length > 0 ? images[selectedIdx] : null;

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.bg, color: C.text, fontFamily: "'JetBrains Mono',monospace", overflow: "hidden" }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 22px", background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif", fontSize: 21, color: C.gold, letterSpacing: .5, whiteSpace: "nowrap" }}>
          Watermark Studio
        </span>
        <div style={{ width: 1, height: 16, background: C.border, flexShrink: 0 }} />
        <div style={{ display: "flex", gap: 5 }}>
          {["Multi-Image", "Video", "Text", "Logo", "Link", "ZIP Export"].map(t => (
            <span key={t} style={{ fontSize: 8, padding: "2px 7px", borderRadius: 3, background: C.card, border: `1px solid ${C.border}`, color: C.muted, letterSpacing: 1.2, whiteSpace: "nowrap" }}>{t}</span>
          ))}
        </div>

        {/* File count badge */}
        {images.length > 0 && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 4, background: C.goldBg, color: C.gold, border: `1px solid ${C.goldDim}` }}>
              {images.length} / {MAX_FILES} images
            </span>
          </div>
        )}
        {mode === "video" && videoFile && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 9, color: C.muted, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{videoFile.name}</span>
            <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 4, background: C.purpleBg, color: C.purple, border: `1px solid ${C.purple}` }}>VIDEO</span>
          </div>
        )}
      </header>

      {/* ── BODY ───────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ══ LEFT SIDEBAR ═════════════════════════════════════════════════ */}
        <aside style={{ width: 278, flexShrink: 0, background: C.panel, borderRight: `1px solid ${C.border}`, overflowY: "auto", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* 1. SOURCE MEDIA */}
          <div>
            <Sect>Source Media</Sect>

            {/* Drop zone */}
            <div
              onClick={() => document.getElementById("__mi")?.click()}
              onDragOver={e => { e.preventDefault(); setDropActive(true); }}
              onDragLeave={() => setDropActive(false)}
              onDrop={onMediaDrop}
              style={{ border: `2px dashed ${dropActive ? C.gold : C.border}`, borderRadius: 10, padding: "16px 12px", textAlign: "center", cursor: "pointer", background: dropActive ? C.goldBg : C.card, transition: "all .18s" }}
            >
              <div style={{ fontSize: 22, marginBottom: 5 }}>📂</div>
              <div style={{ fontSize: 11, color: C.text, marginBottom: 3 }}>
                {images.length > 0 ? `Add more images (${images.length}/${MAX_FILES})` : "Drop files or click to upload"}
              </div>
              <div style={{ fontSize: 9, color: C.muted, letterSpacing: .8 }}>
                JPG · PNG · GIF  ·  MP4 · WEBM  ·  Max {MAX_FILES} images
              </div>
            </div>
            <input id="__mi" type="file" accept="image/*,video/*" multiple style={{ display: "none" }}
              onChange={e => e.target.files && ingestFiles(e.target.files)} />

            {/* Error message */}
            {fileError && (
              <div style={{ marginTop: 8, fontSize: 9, color: C.red, lineHeight: 1.5, letterSpacing: .5 }}>{fileError}</div>
            )}
          </div>

          {/* 2. WATERMARK TYPE */}
          <div>
            <Sect>Watermark Type</Sect>
            <div style={{ display: "flex", gap: 5 }}>
              <TypeTab label="TEXT" id={WM.TEXT} active={wmType === WM.TEXT} onSelect={setWmType} />
              <TypeTab label="IMAGE" id={WM.IMG} active={wmType === WM.IMG} onSelect={setWmType} />
              <TypeTab label="LINK" id={WM.LINK} active={wmType === WM.LINK} onSelect={setWmType} />
            </div>
          </div>

          {/* 3. CONTENT */}
          <div>
            <Sect>Content</Sect>
            {wmType === WM.TEXT && (<><FL>Watermark Text</FL><TI value={wmText} onChange={setWmText} placeholder="© Your Brand" /></>)}
            {wmType === WM.LINK && (
              <>
                <FL>URL / Link Label</FL>
                <TI value={wmLink} onChange={setWmLink} placeholder="https://yourbrand.com" />
                <div style={{ fontSize: 9, color: C.muted, marginTop: 6 }}>Rendered with underline cue on export</div>
              </>
            )}
            {wmType === WM.IMG && (
              <>
                <FL>Logo / Watermark Image</FL>
                <div onClick={() => document.getElementById("__wi")?.click()}
                  style={{ border: `1px dashed ${wmImgFile ? C.goldDim : C.border}`, borderRadius: 8, padding: 14, textAlign: "center", cursor: "pointer", background: C.card, transition: "all .15s" }}>
                  <div style={{ fontSize: 11, color: wmImgFile ? C.gold : C.muted }}>
                    {wmImgFile ? (wmImgFile.name.length > 22 ? wmImgFile.name.slice(0, 20) + "…" : wmImgFile.name) : "Upload PNG logo (transparent BG ideal)"}
                  </div>
                </div>
                <input id="__wi" type="file" accept="image/*" style={{ display: "none" }}
                  onChange={e => e.target.files && e.target.files[0] && setWmImgFile(e.target.files[0])} />
              </>
            )}
          </div>

          {/* 4. APPEARANCE (text / link) */}
          {(wmType === WM.TEXT || wmType === WM.LINK) && (
            <div>
              <Sect>Appearance</Sect>
              <FL>Colour</FL>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input type="color" value={wmColor} onChange={e => setWmColor(e.target.value)}
                  style={{ width: 36, height: 32, border: `1px solid ${C.border}`, borderRadius: 7, cursor: "pointer", padding: 2, background: "none" }} />
                <input value={wmColor} onChange={e => setWmColor(e.target.value)}
                  style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "7px 10px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none" }} />
              </div>
              <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
                {PALETTE.map(clr => (
                  <div key={clr} onClick={() => setWmColor(clr)} style={{ width: 24, height: 24, borderRadius: 5, background: clr, cursor: "pointer", border: wmColor === clr ? `2px solid ${C.gold}` : `1px solid ${C.border}`, boxSizing: "border-box", flexShrink: 0, transition: "transform .1s" }} />
                ))}
              </div>
              <FL>Font</FL>
              <select value={wmFont} onChange={e => setWmFont(e.target.value)}
                style={{
                  width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "8px 28px 8px 10px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none", cursor: "pointer", marginBottom: 14, WebkitAppearance: "none", appearance: "none",
                  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234a5570'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center"
                }}>
                {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <div style={{ display: "flex", gap: 18 }}>
                <Toggle label="Bold" value={wmBold} onChange={setWmBold} />
                <Toggle label="Shadow" value={wmShadow} onChange={setWmShadow} />
              </div>
            </div>
          )}
          {wmType === WM.IMG && (
            <div><Sect>Appearance</Sect><Toggle label="Drop Shadow" value={wmShadow} onChange={setWmShadow} /></div>
          )}

          {/* 5. SIZE & OPACITY */}
          <div>
            {/* Conditional masking UI: hidden during video playback */}
            {!(mode === "video" && !videoPaused) ? (
              <>
                <Sect>Masking</Sect>
                <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                  <Toggle label="Masking Mode" value={maskingMode} onChange={setMaskingMode} />
                  {maskingMode && (
                    <Toggle label="Auto-Mask Faces" value={autoMaskEnabled} onChange={(val) => {
                      setAutoMaskEnabled(val);
                      if (!val) {
                        // Clear all auto-detected masks
                        setMasks(prev => prev.filter(m => !m.isAuto));
                        setSelMaskIdx(null);
                      } else {
                        // Trigger detection
                        autoDetectFaces();
                      }
                    }} />
                  )}
                  <div style={{ fontSize: 9, color: C.muted, fontStyle: "italic" }}>
                    {maskingMode ? "Auto-detecting faces + Manual draw" : "Reposition watermark"}
                  </div>
                </div>
                {mode === "video" && maskingMode && (
                  <div style={{ marginBottom: 12 }}>
                    <button onClick={scanVideo} disabled={!modelsLoaded || !videoReady} style={{ width: "100%", padding: "8px", background: C.purpleBg, border: `1px solid ${C.purple}`, borderRadius: 6, color: C.purple, fontSize: 9, cursor: (modelsLoaded && videoReady) ? "pointer" : "not-allowed", fontWeight: 600 }}>
                      SCAN ENTIRE VIDEO FOR FACES
                    </button>
                  </div>
                )}
                {maskingMode && (
                  <div style={{ marginBottom: 12 }}>
                    <FL>Default Mask Style</FL>
                    <div style={{ display: "flex", gap: 5 }}>
                      {["blur", "pixelate", "box"].map(m => (
                        <button key={m} onClick={() => {
                          const mt = m as Mask["type"];
                          setMaskType(mt);
                          if (selMaskIdx !== null) {
                            updateMask(selMaskIdx, { type: mt });
                          }
                        }} style={{
                          flex: 1, padding: "6px 0",
                          background: maskType === m ? C.gold : C.card,
                          border: maskType === m ? `1px solid ${C.gold}` : `1px solid ${C.border}`,
                          borderRadius: 5,
                          color: maskType === m ? C.bg : C.muted,
                          fontSize: 9, cursor: "pointer", textTransform: "uppercase", fontWeight: maskType === m ? 700 : 400
                        }}>
                          {m === "pixelate" ? "PIXEL" : m}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {masks.length > 0 && (
                  <button onClick={() => setMasks([])} style={{ width: "100%", padding: "7px", background: "#3d1414", border: "1px solid #632222", borderRadius: 6, color: "#ff8a8a", fontSize: 8, letterSpacing: 1.5, cursor: "pointer" }}>CLEAR ALL MASKS ({masks.length})</button>
                )}
                <div style={{ height: 16 }} />
              </>
            ) : (
              <div style={{ padding: "10px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 16 }}>
                <div style={{ fontSize: 9, color: C.gold, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Masking Locked</div>
                <div style={{ fontSize: 8, color: C.muted }}>Pause video to edit masks.</div>
              </div>
            )}
            <Sect>Size &amp; Opacity</Sect>
            <Slider label={wmType === WM.IMG ? "Logo Width" : "Font Size"} value={wmSize} min={8} max={120}
              fmt={v => wmType === WM.IMG ? `${v * 5}px` : `${v}px`} onChange={setWmSize} />
            <Slider label="Opacity" value={wmOpacity} min={5} max={100} fmt={v => `${v}%`} onChange={setWmOpacity} />
            <FL>Global Filter</FL>
            <select value={wmFilter} onChange={e => setWmFilter(e.target.value)}
              style={{
                width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "8px 28px 8px 10px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none", cursor: "pointer", WebkitAppearance: "none", appearance: "none",
                backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234a5570'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center"
              }}>
              {FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>

          {/* 6. POSITION PRESETS */}
          <div>
            <Sect>Position</Sect>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 4, marginBottom: 8 }}>
              {PRESETS.map(p => {
                const active = activePreset === p.id;
                return (
                  <button key={p.id} onClick={() => applyPreset(p)} style={{ padding: "9px 0", background: active ? C.gold : C.card, border: `1px solid ${active ? C.gold : C.border}`, borderRadius: 7, cursor: "pointer", color: active ? C.bg : C.muted, fontSize: 16, transition: "all .12s" }}>
                    {p.icon}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 9, color: C.muted, textAlign: "center", letterSpacing: 1.5 }}>OR DRAG ON CANVAS</div>
          </div>

          {/* 7. EXPORT */}
          <div>
            <Sect>Export Settings</Sect>
            <FL>Filename Prefix</FL>
            <TI value={exportPrefix} onChange={setExportPrefix} placeholder="e.g. watermarked_" />
            <div style={{ height: 12 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={exportConfigJson} style={{ flex: 1, padding: "7px", background: C.subtle, border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, fontSize: 8, letterSpacing: 1.5, cursor: "pointer" }}>EXPORT CONFIG</button>
              <button onClick={() => document.getElementById("__ic")?.click()} style={{ flex: 1, padding: "7px", background: C.subtle, border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, fontSize: 8, letterSpacing: 1.5, cursor: "pointer" }}>IMPORT CONFIG</button>
              <input id="__ic" type="file" accept=".json" style={{ display: "none" }} onChange={e => e.target.files?.[0] && importConfigJson(e.target.files[0])} />
            </div>
            <div style={{ height: 16 }} />
            <Sect>Export Actions</Sect>

            {/* Single export */}
            {mode === "image" && (
              <button onClick={exportSingleImage} disabled={!imgReady}
                style={{ width: "100%", padding: "11px", marginBottom: 8, background: imgReady ? C.gold : C.card, border: `1px solid ${imgReady ? C.gold : C.border}`, borderRadius: 8, color: imgReady ? C.bg : C.muted, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 700, letterSpacing: 2, cursor: imgReady ? "pointer" : "not-allowed", transition: "all .15s" }}>
                ↓ EXPORT CURRENT IMAGE
              </button>
            )}

            {/* Bulk ZIP export */}
            {mode === "image" && images.length > 1 && (
              <button onClick={exportBulkZip} disabled={!!bulkProgress}
                style={{ width: "100%", padding: "11px", background: bulkProgress ? C.card : C.tealBg, border: `1px solid ${bulkProgress ? C.border : C.teal}`, borderRadius: 8, color: bulkProgress ? C.muted : C.teal, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 700, letterSpacing: 2, cursor: bulkProgress ? "not-allowed" : "pointer", transition: "all .15s" }}>
                {bulkProgress
                  ? `⏳ ${exportMsg || `${bulkProgress.done}/${bulkProgress.total}`}`
                  : `⬇ EXPORT ALL AS ZIP (${images.length})`}
              </button>
            )}

            {/* ZIP progress bar */}
            {bulkProgress && (
              <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: C.border }}>
                <div style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%`, height: "100%", background: C.teal, borderRadius: 2, transition: "width .3s" }} />
              </div>
            )}

            {/* Video export */}
            {mode === "video" && (
              <>
                <button onClick={exportVideo} disabled={!videoReady || exporting}
                  style={{ width: "100%", padding: "11px", background: videoReady && !exporting ? C.gold : C.card, border: `1px solid ${videoReady && !exporting ? C.gold : C.border}`, borderRadius: 8, color: videoReady && !exporting ? C.bg : C.muted, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 700, letterSpacing: 2, cursor: videoReady && !exporting ? "pointer" : "not-allowed", transition: "all .15s" }}>
                  {exporting ? `● RECORDING  ${expPct}%` : "↓ EXPORT VIDEO"}
                </button>
                {exporting && (
                  <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: C.border }}>
                    <div style={{ width: `${expPct}%`, height: "100%", background: C.gold, borderRadius: 2, transition: "width .3s" }} />
                  </div>
                )}
              </>
            )}

            {exported && !bulkProgress && (
              <div style={{ marginTop: 10, textAlign: "center", fontSize: 10, color: C.teal, letterSpacing: 1 }}>✓ SAVED TO DOWNLOADS</div>
            )}
          </div>
        </aside>

        {/* ══ RIGHT — PREVIEW + THUMBNAIL STRIP ════════════════════════════ */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", background: C.bg, overflow: "hidden" }}>

          {/* ── Preview area ─────────────────────────────────────────────── */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 24px 12px", overflow: "hidden", position: "relative" }}>

            {!mode ? (
              /* Empty state */
              <div style={{ textAlign: "center", opacity: .28, pointerEvents: "none" }}>
                <div style={{ fontSize: 56, marginBottom: 14 }}>🎞</div>
                <div style={{ fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, fontSize: 18, color: C.text, marginBottom: 4 }}>Upload media to begin</div>
                <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5 }}>Up to {MAX_FILES} images · or one video · Drag-and-drop or browse</div>
              </div>
            ) : (
              <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", gap: 10 }}>

                {/* Info bar */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1.5 }}>DRAG ON CANVAS TO REPOSITION WATERMARK</div>
                  {canvasDims.w > 0 && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 9, color: C.muted, letterSpacing: 1 }}>AUTO-DETECTED:</span>
                      <span style={{ fontSize: 10, color: C.gold, fontWeight: 600 }}>{canvasDims.w} × {canvasDims.h} px</span>
                      <span style={{ fontSize: 9, color: C.muted }}>
                        {canvasDims.w > 0 ? `(${(canvasDims.w / canvasDims.h).toFixed(2)}:1)` : ""}
                      </span>
                    </div>
                  )}
                </div>

                {/* Canvas — correct aspect ratio via max-width + height:auto */}
                <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: `1px solid ${C.border}`, boxShadow: "0 20px 70px rgba(0,0,0,.8)", background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <canvas
                    ref={canvasRef}
                    style={{
                      display: "block",
                      /* 
                       * KEY FIX for horizontal stretching:
                       * maxWidth: 100% → never wider than container
                       * height: auto   → browser scales proportionally
                       *                  using the canvas's intrinsic w×h attributes
                       * maxHeight      → prevents very tall images overflowing viewport
                       */
                      maxWidth: "100%",
                      height: "auto",
                      maxHeight: "58vh",
                      cursor: "crosshair",
                    }}
                    onMouseDown={onPtrDown} onMouseMove={onPtrMove} onMouseUp={onPtrUp} onMouseLeave={onPtrUp}
                    onTouchStart={e => { e.preventDefault(); onPtrDown(e); }}
                    onTouchMove={e => { e.preventDefault(); onPtrMove(e); }}
                    onTouchEnd={onPtrUp}
                  />

                  {/* LIVE PREVIEW badge */}
                  {(imgReady || videoReady) && (
                    <div style={{ position: "absolute", top: 10, right: 10, fontSize: 9, letterSpacing: 1.5, color: C.gold, background: `${C.bg}dd`, padding: "3px 8px", borderRadius: 4, border: `1px solid ${C.goldDim}`, pointerEvents: "none" }}>
                      LIVE PREVIEW
                    </div>
                  )}

                  {/* Loading overlay */}
                  {mode && !(imgReady || videoReady) && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: C.card, color: C.muted, fontSize: 11, letterSpacing: 1.5 }}>
                      LOADING MEDIA…
                    </div>
                  )}
                </div>

                {/* Stats strip */}
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
                        <div style={{ fontSize: 10, color: C.gold, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Video controls */}
                {mode === "video" && videoReady && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.panel, padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}` }}>
                    <button onClick={() => setVideoPaused(!videoPaused)} style={{ background: "none", border: "none", color: C.gold, fontSize: 16, cursor: "pointer", width: 24 }}>
                      {videoPaused ? "▶" : "Ⅱ"}
                    </button>
                    <button onClick={() => setVideoMuted(!videoMuted)} style={{ background: "none", border: "none", color: C.gold, fontSize: 16, cursor: "pointer", width: 24, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {videoMuted ? "🔇" : "🔊"}
                    </button>
                    <input type="range" min={0} max={videoDur || 100} step={0.01} value={videoTime} onChange={e => {
                      const t = Number(e.target.value);
                      if (vidElRef.current) vidElRef.current.currentTime = t;
                      setVideoTime(t);
                    }} style={{ flex: 1, cursor: "pointer", height: 3, borderRadius: 2, background: C.subtle, accentColor: C.gold }} />
                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>
                      {Math.floor(videoTime / 60)}:{Math.floor(videoTime % 60).toString().padStart(2, "0")} / {Math.floor(videoDur / 60)}:{Math.floor(videoDur % 60).toString().padStart(2, "0")}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── THUMBNAIL STRIP (images only) ───────────────────────────── */}
          {mode === "image" && images.length > 0 && (
            <div style={{ flexShrink: 0, borderTop: `1px solid ${C.border}`, background: C.panel, padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, letterSpacing: 2.5, textTransform: "uppercase", color: C.muted }}>
                  Image Gallery
                </div>
                <span style={{ fontSize: 9, color: C.gold }}>{images.length} file{images.length !== 1 ? "s" : ""}</span>
                <button onClick={() => { images.forEach(img => URL.revokeObjectURL(img.src)); setImages([]); setMode(null); setImgReady(false); }}
                  style={{ marginLeft: "auto", fontSize: 9, color: C.muted, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 9px", cursor: "pointer", letterSpacing: 1 }}>
                  CLEAR ALL
                </button>
                {images.length < MAX_FILES && (
                  <button onClick={() => document.getElementById("__mi")?.click()}
                    style={{ fontSize: 9, color: C.gold, background: C.goldBg, border: `1px solid ${C.goldDim}`, borderRadius: 5, padding: "3px 9px", cursor: "pointer", letterSpacing: 1 }}>
                    + ADD MORE
                  </button>
                )}
              </div>

              {/* Horizontally scrollable thumbnail grid */}
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
                {images.map((img, idx) => (
                  <div
                    key={img.src}
                    onClick={() => setSelectedIdx(idx)}
                    style={{
                      position: "relative", flexShrink: 0,
                      width: 88, borderRadius: 7, overflow: "hidden",
                      border: `2px solid ${selectedIdx === idx ? C.gold : C.border}`,
                      cursor: "pointer", transition: "border-color .15s",
                      background: C.card,
                    }}
                  >
                    {/* Thumbnail image — natural aspect ratio via height:auto */}
                    <img
                      src={img.src} alt={img.file.name}
                      style={{ display: "block", width: "100%", height: "auto", maxHeight: 62, objectFit: "cover" }}
                    />

                    {/* Resolution badge */}
                    {img.w > 0 && (
                      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(7,8,15,.82)", padding: "2px 4px", fontSize: 7, color: C.gold, letterSpacing: .5, textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {img.w}×{img.h}
                      </div>
                    )}

                    {/* Selected check */}
                    {selectedIdx === idx && (
                      <div style={{ position: "absolute", top: 4, left: 4, width: 14, height: 14, borderRadius: "50%", background: C.gold, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: C.bg, fontWeight: 700 }}>✓</div>
                    )}

                    {/* Remove button */}
                    <button
                      onClick={e => { e.stopPropagation(); removeImage(idx); }}
                      style={{ position: "absolute", top: 3, right: 3, width: 16, height: 16, borderRadius: "50%", background: "rgba(248,113,113,.9)", border: "none", cursor: "pointer", fontSize: 9, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, lineHeight: 1 }}
                    >✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ── Hidden draw sources (off-screen) ─────────────────────────────────── */}

      {/* Active image — key forces remount + onLoad when selection changes */}
      {activeImg && (
        <img
          key={activeImg.src}
          src={activeImg.src}
          alt=""
          crossOrigin="anonymous"
          onLoad={e => onImgLoad(e.target as HTMLImageElement)}
          style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none" }}
        />
      )}

      {/* Video */}
      {videoSrc && mode === "video" && (
        <video
          key={videoSrc}
          src={videoSrc}
          crossOrigin="anonymous"
          onLoadedMetadata={e => onVideoLoad(e.target as HTMLVideoElement)}
          autoPlay loop muted={videoMuted} playsInline
          style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        />
      )}
    </div>
  );
}