import { useState, useRef, useEffect, useCallback } from "react";
import JSZip from "jszip/dist/jszip.min.js";
import * as faceapi from "face-api.js";

import { ImageEntry, BulkProgress, WatermarkConfig, Mask } from "./types";
import { C } from "./constants/theme";
import { WM, PRESETS, FONTS, PALETTE, MAX_FILES, FILTERS } from "./constants/config";
import { applyWatermark, applyMasks } from "./utils/canvas";
import { detectImageResolution } from "./helpers/media";
import { Sect, FL, TI, Toggle, Slider, Btn, WmTab } from "./components/common/Atoms";

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
  const [exportPrefix, setExportPrefix] = useState("watermarked_");

  const [masks, setMasks] = useState<Mask[]>([]);
  const [maskingMode, setMaskingMode] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>("bc");
  const [selMaskIdx, setSelMaskIdx] = useState<number | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [autoMaskEnabled, setAutoMaskEnabled] = useState(true);
  const [maskType, setMaskType] = useState<Mask["type"]>("blur");

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
    (async () => {
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(
          "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights"
        );
        setModelsLoaded(true);
      } catch (_) {}
    })();
  }, []);

  useEffect(() => {
    if (!wmImgFile) { wmImgEl.current = null; return; }
    const url = URL.createObjectURL(wmImgFile);
    const img = new Image();
    img.onload = () => { wmImgEl.current = img; };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [wmImgFile]);

  useEffect(() => { setImgReady(false); setExported(false); }, [selectedIdx]);

  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoSrc(url); setVideoReady(false); setExported(false);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const wmConfig = useCallback((): WatermarkConfig => ({
    wmType, wmText, wmLink, wmColor, wmFont, wmSize,
    wmOpacity, wmBold, wmShadow, wmPos,
    wmImgEl: wmImgEl.current,
    wmFilter,
  }), [wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter]);

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

  useEffect(() => { if (mode === "image" && imgReady) draw(); }, [draw, mode, imgReady]);

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

  const autoDetectFaces = useCallback(async () => {
    if (!modelsLoaded || !mode) return;
    let input: HTMLImageElement | HTMLVideoElement | null = null;
    let inputW = 0, inputH = 0;
    if (mode === "image" && images.length > 0) {
      const entry = images[selectedIdx];
      if (!entry) return;
      const img = new Image();
      img.src = entry.src;
      await new Promise(r => (img.onload = r));
      input = img; inputW = img.naturalWidth; inputH = img.naturalHeight;
    } else if (mode === "video" && vidElRef.current) {
      input = vidElRef.current; inputW = input.videoWidth; inputH = input.videoHeight;
    }
    if (!input || !inputW || !inputH) return;
    const detections = await faceapi.detectAllFaces(input, new faceapi.TinyFaceDetectorOptions());
    if (detections.length > 0) {
      const newMasks: Mask[] = detections.map(d => ({
        id: Math.random().toString(36).substr(2, 9),
        x: d.box.x / inputW, y: d.box.y / inputH,
        w: d.box.width / inputW, h: d.box.height / inputH,
        type: maskType, isAuto: true,
      }));
      setMasks(prev => [...prev, ...newMasks]);
    }
  }, [modelsLoaded, mode, images, selectedIdx, maskType]);

  const scanVideo = useCallback(async () => {
    if (!modelsLoaded || mode !== "video" || !vidElRef.current) return;
    const vid = vidElRef.current;
    const originalTime = vid.currentTime;
    const steps = 6;
    setExporting(true); setExportMsg("Scanning video for faces...");
    for (let i = 0; i < steps; i++) {
      vid.currentTime = (i / (steps - 1)) * vid.duration;
      await new Promise(r => (vid.onseeked = r));
      await autoDetectFaces();
      setExpPct(Math.round((i / (steps - 1)) * 100));
    }
    vid.currentTime = originalTime;
    setExporting(false); setExportMsg(""); setExpPct(0);
  }, [modelsLoaded, mode, autoDetectFaces]);

  useEffect(() => {
    if (modelsLoaded && maskingMode && autoMaskEnabled) {
      if (mode === "image" && imgReady) autoDetectFaces();
      else if (mode === "video" && videoReady) autoDetectFaces();
    }
  }, [modelsLoaded, mode, imgReady, videoReady, autoDetectFaces, selectedIdx, maskingMode, autoMaskEnabled]);

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
        return { file, src: URL.createObjectURL(file), w, h };
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
      setMasks(prev => [...prev, { id: Date.now().toString(), ...pos, w: 0, h: 0, type: maskType, isAuto: false }]);
      setSelMaskIdx(masks.length);
    } else { setActivePreset(null); setWmPos(pos); }
  };

  const onPtrMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!dragging.current) return;
    e.preventDefault();
    const pos = posFromEvent(e);
    if (maskingMode && maskStart.current) {
      setMasks(prev => { const next = [...prev]; const curr = next[next.length - 1]; if (!curr) return prev; curr.w = pos.x - maskStart.current!.x; curr.h = pos.y - maskStart.current!.y; return next; });
    } else { setWmPos(pos); }
  };

  const onPtrUp = () => {
    dragging.current = false; maskStart.current = null;
    if (maskingMode) {
      setMasks(prev => {
        if (!prev.length) return prev;
        const next = [...prev]; const last = next[next.length - 1];
        if (last.w < 0) { last.x += last.w; last.w = Math.abs(last.w); }
        if (last.h < 0) { last.y += last.h; last.h = Math.abs(last.h); }
        if (Math.abs(last.w) < 0.005 && Math.abs(last.h) < 0.005) return next.slice(0, -1);
        return next;
      });
    }
  };

  const exportConfigJson = () => {
    const cfg = { wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, wmFilter, exportPrefix };
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
        if (cfg.exportPrefix) setExportPrefix(cfg.exportPrefix);
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
    setBulkProgress({ done: 0, total: images.length }); setExportMsg("Building ZIP…");
    const zip = new JSZip(); const folder = zip.folder("watermarked"); const cfg = wmConfig();
    for (let i = 0; i < images.length; i++) {
      const entry = images[i];
      setBulkProgress({ done: i, total: images.length }); setExportMsg(`Processing ${i + 1} / ${images.length}…`);
      const imgEl = await new Promise<HTMLImageElement>(resolve => { const el = new Image(); el.onload = () => resolve(el); el.src = entry.src; });
      const offscr = document.createElement("canvas"); offscr.width = imgEl.naturalWidth; offscr.height = imgEl.naturalHeight;
      const ctx = offscr.getContext("2d"); if (!ctx) continue;
      ctx.filter = cfg.wmFilter || "none"; ctx.drawImage(imgEl, 0, 0); ctx.filter = "none";
      applyMasks(ctx, offscr.width, offscr.height, masks); applyWatermark(ctx, offscr.width, offscr.height, cfg);
      const blob = await new Promise<Blob | null>(res => offscr.toBlob(res, entry.file.type === "image/png" ? "image/png" : "image/jpeg", 0.96));
      if (blob) { const buf = await blob.arrayBuffer(); const ext = entry.file.type === "image/png" ? "png" : "jpg"; folder!.file(`${exportPrefix}${entry.file.name.replace(/\.[^.]+$/, "")}.${ext}`, buf); }
    }
    setBulkProgress({ done: images.length, total: images.length }); setExportMsg("Compressing…");
    const zipBlob = await zip.generateAsync({ type: "blob" }, (meta: { percent: number }) => setExpPct(Math.round(meta.percent)));
    const a = document.createElement("a"); a.href = URL.createObjectURL(zipBlob); a.download = `${exportPrefix}images.zip`; a.click();
    setBulkProgress(null); setExportMsg(""); setExpPct(0); setExported(true);
  };

  const exportVideo = () => {
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
              {maskingMode && (
                <Toggle label="Auto-Mask Faces" value={autoMaskEnabled} onChange={val => {
                  setAutoMaskEnabled(val);
                  if (!val) { setMasks(prev => prev.filter(m => !m.isAuto)); setSelMaskIdx(null); }
                  else autoDetectFaces();
                }} />
              )}
              <div style={{ fontSize: 9, color: C.muted, fontStyle: "italic" }}>{maskingMode ? "Auto-detecting faces + Manual draw" : "Reposition watermark"}</div>
            </div>
            {mode === "video" && maskingMode && (
              <div style={{ marginBottom: 12 }}>
                <button onClick={scanVideo} disabled={!modelsLoaded || !videoReady} style={{ width: "100%", padding: "8px", background: C.purpleBg, border: `1px solid ${C.purple}`, borderRadius: 6, color: C.purple, fontSize: 9, cursor: "pointer", fontWeight: 600 }}>
                  SCAN ENTIRE VIDEO FOR FACES
                </button>
              </div>
            )}
            {maskingMode && (
              <div style={{ marginBottom: 12 }}>
                <FL>Mask Style</FL>
                <div style={{ display: "flex", gap: 5 }}>
                  {(["blur", "pixelate", "box"] as Mask["type"][]).map(m => (
                    <button key={m} onClick={() => { setMaskType(m); }} style={{ flex: 1, padding: "6px 0", background: maskType === m ? C.gold : C.card, border: `1px solid ${maskType === m ? C.gold : C.border}`, borderRadius: 5, color: maskType === m ? C.bg : C.muted, fontSize: 9, cursor: "pointer", textTransform: "uppercase", fontWeight: maskType === m ? 700 : 400 }}>
                      {m === "pixelate" ? "PIXEL" : m}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {masks.length > 0 && (
              <button onClick={() => setMasks([])} style={{ width: "100%", padding: "7px", background: "#3d1414", border: "1px solid #632222", borderRadius: 6, color: "#ff8a8a", fontSize: 8, letterSpacing: 1.5, cursor: "pointer" }}>
                CLEAR ALL MASKS ({masks.length})
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
                <Btn onClick={exportVideo} disabled={!videoReady || exporting}>
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
          autoPlay loop muted={videoMuted} playsInline
          style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        />
      )}
    </div>
  );
}
