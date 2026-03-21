import { useState, useRef, useEffect, useCallback } from "react";
import JSZip from "jszip";
import * as faceapi from "face-api.js";
import { ImageEntry, BulkProgress, WatermarkConfig, Mask } from "../types";
import { WM, MAX_FILES, FONTS } from "../constants/config";
import { detectImageResolution } from "../helpers/media";
import { applyMasks, applyWatermark } from "../utils/canvas";

export function useWatermarkStudio() {
  // ── Image gallery state ──────────────────────────────────────────────────────
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [imgReady, setImgReady] = useState(false);

  // ── Video state ─────────────────────────────────────────────────────
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(true);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);

  // ── Mode: "image" | "video" | null ──────────────────────────────────────────
  const [mode, setMode] = useState<"image" | "video" | null>(null);

  // ── UI State ────────────────────────────────────────────────────────────────
  const [dropActive, setDropActive] = useState(false);
  const [fileError, setFileError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [expPct, setExpPct] = useState(0);
  const [exported, setExported] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);

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
  const [wmPos, setWmPos] = useState({ x: 0.5, y: 0.93 });
  const [wmFilter, setWmFilter] = useState("none");
  const [exportPrefix, setExportPrefix] = useState("watermarked_");

  // ── Masking state ────────────────────────────────────────────────────────────
  const [masks, setMasks] = useState<Mask[]>([]);
  const [maskingMode, setMaskingMode] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>("bc");
  const [selMaskIdx, setSelMaskIdx] = useState<number | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [autoMaskEnabled, setAutoMaskEnabled] = useState(true);
  const [maskType, setMaskType] = useState<Mask["type"]>("blur");

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const vidElRef = useRef<HTMLVideoElement | null>(null);
  const wmImgEl = useRef<HTMLImageElement | null>(null);
  const animRef = useRef<number | null>(null);
  const dragging = useRef<boolean>(false);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });

  // ── Face Detection Model Loading ─────────────────────────────────────────────
  useEffect(() => {
    const loadModels = async () => {
      try {
        const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        setModelsLoaded(true);
      } catch (err) {
        console.error("Failed to load face-api models:", err);
      }
    };
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
      await new Promise((r) => (img.onload = r));
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
      const newMasks: Mask[] = detections.map((d) => ({
        id: Math.random().toString(36).substr(2, 9),
        x: d.box.x / inputW,
        y: d.box.y / inputH,
        w: d.box.width / inputW,
        h: d.box.height / inputH,
        type: maskType,
        isAuto: true,
      }));
      setMasks((prev) => [...prev, ...newMasks]);
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
      await new Promise((r) => (vid.onseeked = r));
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

  // ── Export logic ─────────────────────────────────────────────────────────────
  const exportSingleImage = useCallback(() => {
    const isPng = images[selectedIdx]?.file?.type === "image/png";
    if (!canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${exportPrefix}${images[selectedIdx]?.file?.name ?? "image"}.${isPng ? "png" : "jpg"}`;
      a.click();
      setExported(true);
    }, isPng ? "image/png" : "image/jpeg", 0.96);
  }, [images, selectedIdx, exportPrefix]);

  const exportBulkZip = useCallback(async () => {
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

      const blob = await new Promise<Blob | null>((res) =>
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
  }, [images, exportPrefix, wmConfig, masks]);

  const exportVideo = useCallback(() => {
    const cvs = canvasRef.current, vid = vidElRef.current;
    if (!cvs || !vid) return;

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const stream = (cvs as any).captureStream(60);
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
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    vid.currentTime = 0;
    vid.playbackRate = 4.0;
    setExporting(true);
    setVideoPaused(false);
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
  }, [exportPrefix]);

  return {
    state: {
      images, selectedIdx, imgReady, videoFile, videoSrc, videoReady, videoPaused, videoMuted, videoTime, videoDur,
      mode, dropActive, fileError, exporting, exportMsg, expPct, exported, bulkProgress,
      wmType, wmText, wmLink, wmImgFile, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter,
      exportPrefix, masks, maskingMode, activePreset, selMaskIdx, modelsLoaded, autoMaskEnabled, maskType, canvasDims
    },
    setters: {
      setImages, setSelectedIdx, setImgReady, setVideoFile, setVideoSrc, setVideoReady, setVideoPaused, setVideoMuted, setVideoTime, setVideoDur,
      setMode, setDropActive, setFileError, setExporting, setExportMsg, setExpPct, setExported, setBulkProgress,
      setWmType, setWmText, setWmLink, setWmImgFile, setWmColor, setWmFont, setWmSize, setWmOpacity, setWmBold, setWmShadow, setWmPos, setWmFilter,
      setExportPrefix, setMasks, setMaskingMode, setActivePreset, setSelMaskIdx, setAutoMaskEnabled, setMaskType, setCanvasDims
    },
    refs: { canvasRef, imgElRef, vidElRef, wmImgEl, animRef, dragging },
    actions: { autoDetectFaces, scanVideo, exportSingleImage, exportBulkZip, exportVideo, wmConfig }
  };
}
