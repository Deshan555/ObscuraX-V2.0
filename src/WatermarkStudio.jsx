import { useState, useRef, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   WATERMARK STUDIO
   ─ Upload images or videos
   ─ Apply text, image-logo, or link watermarks
   ─ Drag to reposition on canvas, or use 9-grid presets
   ─ Control size, opacity, colour, font, shadow, bold
   ─ Real-time canvas preview
   ─ Export full-resolution image (JPEG/PNG) or video (WebM)
═══════════════════════════════════════════════════════════════════════════ */

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:      "#070710",
  panel:   "#0d0d1c",
  card:    "#111122",
  border:  "#1a1a30",
  hi:      "#20203a",
  gold:    "#e8b86d",
  goldDim: "#7a5a28",
  goldBg:  "#e8b86d18",
  purple:  "#8b7cf8",
  purpleBg:"#8b7cf820",
  text:    "#dde4f2",
  muted:   "#4e5a72",
  subtle:  "#2a3048",
  green:   "#3ecf8e",
  danger:  "#f87171",
};

// ── Watermark type enum ───────────────────────────────────────────────────────
const WM = { TEXT: "text", IMG: "img", LINK: "link" };

// ── 9-grid position presets (normalised 0-1) ──────────────────────────────────
const PRESETS = [
  { id: "tl", x: 0.07, y: 0.07, icon: "↖" },
  { id: "tc", x: 0.50, y: 0.07, icon: "↑" },
  { id: "tr", x: 0.93, y: 0.07, icon: "↗" },
  { id: "ml", x: 0.07, y: 0.50, icon: "←" },
  { id: "cc", x: 0.50, y: 0.50, icon: "·" },
  { id: "mr", x: 0.93, y: 0.50, icon: "→" },
  { id: "bl", x: 0.07, y: 0.93, icon: "↙" },
  { id: "bc", x: 0.50, y: 0.93, icon: "↓" },
  { id: "br", x: 0.93, y: 0.93, icon: "↘" },
];

// ── Font choices ──────────────────────────────────────────────────────────────
const FONTS = [
  { label: "Serif",   value: "Georgia, 'Times New Roman', serif" },
  { label: "Sans",    value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: "Mono",    value: "'Courier New', Courier, monospace" },
  { label: "Impact",  value: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif" },
];

// ── Quick colour palette ──────────────────────────────────────────────────────
const QUICK_COLORS = ["#ffffff", "#000000", "#e8b86d", "#ff4d4d", "#4d94ff", "#3ecf8e"];

// ═════════════════════════════════════════════════════════════════════════════
export default function WatermarkStudio() {

  // ── Load custom fonts via link injection ─────────────────────────────────
  useEffect(() => {
    const link = document.createElement("link");
    link.rel  = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch (_) {} };
  }, []);

  // ── Media state ──────────────────────────────────────────────────────────
  const [mediaFile,  setMediaFile]  = useState(null);      // File object
  const [mediaType,  setMediaType]  = useState(null);      // "image" | "video"
  const [mediaSrc,   setMediaSrc]   = useState(null);      // object URL
  const [mediaReady, setMediaReady] = useState(false);     // canvas sized & ready
  const [dropActive, setDropActive] = useState(false);     // drag-over state

  // ── Watermark config ─────────────────────────────────────────────────────
  const [wmType,    setWmType]    = useState(WM.TEXT);
  const [wmText,    setWmText]    = useState("© Your Brand");
  const [wmLink,    setWmLink]    = useState("https://yourbrand.com");
  const [wmImgFile, setWmImgFile] = useState(null);         // logo file
  const [wmColor,   setWmColor]   = useState("#ffffff");
  const [wmFont,    setWmFont]    = useState(FONTS[0].value);
  const [wmSize,    setWmSize]    = useState(44);           // px (font) or relative (img)
  const [wmOpacity, setWmOpacity] = useState(75);           // 0-100 integer
  const [wmBold,    setWmBold]    = useState(false);
  const [wmShadow,  setWmShadow]  = useState(true);
  const [wmPos,     setWmPos]     = useState({ x: 0.50, y: 0.93 }); // normalised
  const [activePreset, setActivePreset] = useState("bc");

  // ── Export state ─────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [expPct,    setExpPct]    = useState(0);
  const [exported,  setExported]  = useState(false);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const canvasRef  = useRef(null);   // <canvas> for preview + export
  const mediaElRef = useRef(null);   // hidden <img> or <video>
  const wmImgEl    = useRef(null);   // loaded watermark Image object
  const animRef    = useRef(null);   // rAF id for video loop
  const dragging   = useRef(false);  // pointer drag flag

  // ── Derive object URL whenever a new media file is selected ───────────────
  useEffect(() => {
    if (!mediaFile) return;
    const url  = URL.createObjectURL(mediaFile);
    const type = mediaFile.type.startsWith("video") ? "video" : "image";
    setMediaSrc(url);
    setMediaType(type);
    setMediaReady(false);
    setExported(false);
    return () => URL.revokeObjectURL(url);
  }, [mediaFile]);

  // ── Load watermark logo image when file chosen ────────────────────────────
  useEffect(() => {
    if (!wmImgFile) return;
    const url = URL.createObjectURL(wmImgFile);
    const img = new Image();
    img.onload = () => { wmImgEl.current = img; };
    img.src    = url;
    return () => URL.revokeObjectURL(url);
  }, [wmImgFile]);

  /* ─────────────────────────────────────────────────────────────────────────
     CORE DRAW FUNCTION
     Renders the media frame + watermark overlay onto the canvas.
     Called every rAF frame for video, or reactively for images.
  ───────────────────────────────────────────────────────────────────────── */
  const draw = useCallback(() => {
    const cvs = canvasRef.current;
    const med = mediaElRef.current;
    if (!cvs || !med || !mediaReady) return;

    const ctx = cvs.getContext("2d");
    const W   = cvs.width;
    const H   = cvs.height;

    // Clear and draw the source media
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(med, 0, 0, W, H);

    // Watermark anchor point in canvas pixels
    const wx = wmPos.x * W;
    const wy = wmPos.y * H;

    ctx.save();
    ctx.globalAlpha = wmOpacity / 100;

    // Drop-shadow for legibility
    if (wmShadow) {
      ctx.shadowColor   = "rgba(0,0,0,0.7)";
      ctx.shadowBlur    = Math.max(6, wmSize * 0.25);
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 2;
    }

    if (wmType === WM.TEXT || wmType === WM.LINK) {
      // ── Text / Link watermark ────────────────────────────────────────────
      const content  = wmType === WM.LINK ? wmLink : wmText;
      const fontDecl = `${wmBold ? "bold " : ""}${wmSize}px ${wmFont}`;

      ctx.font         = fontDecl;
      ctx.fillStyle    = wmColor;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";

      // Underline cue for link type
      if (wmType === WM.LINK) {
        const mw = ctx.measureText(content).width;
        const uly = wy + wmSize * 0.6;
        const ulh = Math.max(1.5, wmSize * 0.06);
        ctx.fillRect(wx - mw / 2, uly, mw, ulh);
      }

      ctx.fillText(content, wx, wy);

    } else if (wmType === WM.IMG && wmImgEl.current) {
      // ── Image / logo watermark ───────────────────────────────────────────
      const img   = wmImgEl.current;
      const ratio = img.naturalHeight / img.naturalWidth;
      const iw    = wmSize * 5;      // scale factor: slider 8-120 → 40-600 px
      const ih    = iw * ratio;
      ctx.drawImage(img, wx - iw / 2, wy - ih / 2, iw, ih);
    }

    ctx.restore();
  }, [wmType, wmText, wmLink, wmColor, wmFont, wmSize, wmOpacity, wmBold, wmShadow, wmPos, mediaReady]);

  /* ─────────────────────────────────────────────────────────────────────────
     Media ready handler — called when <img>.onLoad or <video>.onLoadedMetadata
     fires. Sizes the canvas to the natural media resolution.
  ───────────────────────────────────────────────────────────────────────── */
  const onMediaReady = useCallback((el) => {
    if (!el || !canvasRef.current) return;
    const w = el.videoWidth  || el.naturalWidth  || 1280;
    const h = el.videoHeight || el.naturalHeight || 720;
    canvasRef.current.width  = w;
    canvasRef.current.height = h;
    mediaElRef.current = el;
    setMediaReady(true);
  }, []);

  // ── Image: redraw whenever any watermark setting changes ──────────────────
  useEffect(() => {
    if (mediaType === "image" && mediaReady) draw();
  }, [draw, mediaType, mediaReady]);

  // ── Video: continuous rAF loop for live preview ───────────────────────────
  useEffect(() => {
    if (mediaType !== "video" || !mediaReady) return;
    const loop = () => { draw(); animRef.current = requestAnimationFrame(loop); };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw, mediaType, mediaReady]);

  /* ─────────────────────────────────────────────────────────────────────────
     CANVAS DRAG – pointer events for free watermark repositioning
  ───────────────────────────────────────────────────────────────────────── */
  const posFromEvent = (e) => {
    const cvs  = canvasRef.current;
    const rect = cvs.getBoundingClientRect();
    const cx   = e.touches ? e.touches[0].clientX : e.clientX;
    const cy   = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(1, (cx - rect.left)  / rect.width)),
      y: Math.max(0, Math.min(1, (cy - rect.top)   / rect.height)),
    };
  };

  const onPtrDown  = (e) => {
    dragging.current = true;
    setActivePreset(null);
    setWmPos(posFromEvent(e));
  };
  const onPtrMove  = (e) => { if (dragging.current) { e.preventDefault(); setWmPos(posFromEvent(e)); } };
  const onPtrUp    = ()  => { dragging.current = false; };

  // ── Preset grid click ─────────────────────────────────────────────────────
  const applyPreset = (p) => { setActivePreset(p.id); setWmPos({ x: p.x, y: p.y }); };

  /* ─────────────────────────────────────────────────────────────────────────
     MEDIA UPLOAD – drag-and-drop + file input
  ───────────────────────────────────────────────────────────────────────── */
  const onMediaDrop = (e) => {
    e.preventDefault();
    setDropActive(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.type.startsWith("image") || file.type.startsWith("video"))) {
      setMediaFile(file);
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     EXPORT IMAGE  –  canvas → Blob → download
  ───────────────────────────────────────────────────────────────────────── */
  const exportImage = () => {
    draw();
    const isPng = mediaFile?.type === "image/png";
    canvasRef.current.toBlob((blob) => {
      const a = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = `watermarked.${isPng ? "png" : "jpg"}`;
      a.click();
      setExported(true);
    }, isPng ? "image/png" : "image/jpeg", 0.96);
  };

  /* ─────────────────────────────────────────────────────────────────────────
     EXPORT VIDEO  –  canvas.captureStream + MediaRecorder → WebM download
  ───────────────────────────────────────────────────────────────────────── */
  const exportVideo = () => {
    const cvs = canvasRef.current;
    const vid = mediaElRef.current;
    if (!cvs || !vid) return;

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
                   ? "video/webm;codecs=vp9" : "video/webm";
    const stream   = cvs.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks   = [];

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = "watermarked.webm";
      a.click();
      setExporting(false);
      setExpPct(0);
      setExported(true);
    };

    vid.currentTime = 0;
    setExporting(true);
    recorder.start(200);
    vid.play();

    const onProgress = () =>
      setExpPct(vid.duration ? Math.round((vid.currentTime / vid.duration) * 100) : 0);

    vid.addEventListener("timeupdate", onProgress);
    vid.addEventListener("ended", () => {
      recorder.stop();
      vid.removeEventListener("timeupdate", onProgress);
    }, { once: true });
  };

  const doExport = () => {
    if (mediaType === "image") exportImage();
    else exportVideo();
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ── Reusable micro-components ────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────

  /** Section label */
  const Sect = ({ children }) => (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9, letterSpacing: 2.5, textTransform: "uppercase",
      color: C.muted, marginBottom: 10, paddingBottom: 7,
      borderBottom: `1px solid ${C.border}`,
    }}>{children}</div>
  );

  /** Slider with label + live value */
  const Slider = ({ label, value, min, max, step = 1, onChange, fmt }) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase" }}>
          {label}
        </span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.gold }}>
          {fmt ? fmt(value) : value}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: C.gold, cursor: "pointer", height: 3, borderRadius: 2 }}
      />
    </div>
  );

  /** Type tab pill */
  const TypeTab = ({ label, id }) => {
    const active = wmType === id;
    return (
      <button onClick={() => setWmType(id)} style={{
        flex: 1, padding: "9px 0",
        background: active ? C.gold : "transparent",
        border: `1px solid ${active ? C.gold : C.border}`,
        borderRadius: 7,
        color: active ? C.bg : C.muted,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10, letterSpacing: 1.5,
        cursor: "pointer", fontWeight: active ? 700 : 500,
        transition: "all 0.14s",
      }}>{label}</button>
    );
  };

  /** Toggle switch */
  const Toggle = ({ label, value, onChange }) => (
    <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", userSelect: "none" }}>
      <div onClick={() => onChange(!value)} style={{
        width: 34, height: 18, borderRadius: 9, position: "relative",
        background: value ? C.gold : C.subtle,
        transition: "background 0.18s", flexShrink: 0, cursor: "pointer",
      }}>
        <div style={{
          position: "absolute", top: 3, left: value ? 17 : 3,
          width: 12, height: 12, borderRadius: "50%",
          background: value ? C.bg : C.muted,
          transition: "left 0.18s",
        }} />
      </div>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: C.muted }}>{label}</span>
    </label>
  );

  /** Styled text input */
  const TextInput = ({ value, onChange, placeholder }) => (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%", boxSizing: "border-box",
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 7, color: C.text,
        padding: "9px 12px",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
        outline: "none", transition: "border-color 0.15s",
      }}
      onFocus={(e) => (e.target.style.borderColor = C.goldDim)}
      onBlur={(e)  => (e.target.style.borderColor = C.border)}
    />
  );

  /** Small field label */
  const FieldLabel = ({ children }) => (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
      color: C.muted, letterSpacing: 1.5, textTransform: "uppercase",
      marginBottom: 6,
    }}>{children}</div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      fontFamily: "'JetBrains Mono', monospace",
    }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header style={{
        display: "flex", alignItems: "center", gap: 14,
        padding: "13px 24px",
        background: C.panel,
        borderBottom: `1px solid ${C.border}`,
        flexShrink: 0,
      }}>
        {/* Brand */}
        <div style={{
          fontFamily: "'Instrument Serif', Georgia, serif",
          fontStyle: "italic",
          fontSize: 21,
          color: C.gold,
          letterSpacing: 0.5,
        }}>
          Watermark Studio
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 16, background: C.border }} />

        <div style={{ fontSize: 9, color: C.muted, letterSpacing: 2 }}>
          IMAGES · VIDEOS · TEXT · IMAGE · LINK
        </div>

        {/* File badge */}
        {mediaFile && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 9, color: C.muted, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {mediaFile.name}
            </span>
            <span style={{
              fontSize: 9, letterSpacing: 1,
              background: mediaType === "video" ? C.purpleBg : C.goldBg,
              color: mediaType === "video" ? C.purple : C.gold,
              border: `1px solid ${mediaType === "video" ? C.purple : C.goldDim}`,
              padding: "2px 7px", borderRadius: 4,
            }}>
              {mediaType?.toUpperCase()}
            </span>
          </div>
        )}
      </header>

      {/* ── BODY ───────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ══ LEFT SIDEBAR ═════════════════════════════════════════════════ */}
        <aside style={{
          width: 288, flexShrink: 0,
          background: C.panel,
          borderRight: `1px solid ${C.border}`,
          overflowY: "auto",
          padding: "20px 18px",
          display: "flex", flexDirection: "column", gap: 22,
        }}>

          {/* ── 1. SOURCE MEDIA ──────────────────────────────────────────── */}
          <div>
            <Sect>Source Media</Sect>
            {/* Drop zone */}
            <div
              onClick={() => document.getElementById("__mediaInput").click()}
              onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
              onDragLeave={() => setDropActive(false)}
              onDrop={onMediaDrop}
              style={{
                border: `2px dashed ${dropActive ? C.gold : C.border}`,
                borderRadius: 10, padding: "20px 14px",
                textAlign: "center", cursor: "pointer",
                background: dropActive ? C.goldBg : C.card,
                transition: "all 0.18s",
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 6 }}>
                {mediaFile ? "🎬" : "📁"}
              </div>
              <div style={{ fontSize: 11, color: C.text, marginBottom: 3 }}>
                {mediaFile
                  ? (mediaFile.name.length > 26 ? mediaFile.name.slice(0, 24) + "…" : mediaFile.name)
                  : "Drop or click to upload"}
              </div>
              <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1 }}>
                JPG · PNG · GIF · MP4 · MOV · WEBM
              </div>
            </div>
            <input id="__mediaInput" type="file" accept="image/*,video/*"
              style={{ display: "none" }}
              onChange={(e) => e.target.files[0] && setMediaFile(e.target.files[0])}
            />
          </div>

          {/* ── 2. WATERMARK TYPE ────────────────────────────────────────── */}
          <div>
            <Sect>Watermark Type</Sect>
            <div style={{ display: "flex", gap: 5 }}>
              <TypeTab label="TEXT"  id={WM.TEXT} />
              <TypeTab label="IMAGE" id={WM.IMG}  />
              <TypeTab label="LINK"  id={WM.LINK} />
            </div>
          </div>

          {/* ── 3. WATERMARK CONTENT ─────────────────────────────────────── */}
          <div>
            <Sect>Content</Sect>

            {wmType === WM.TEXT && (
              <>
                <FieldLabel>Watermark Text</FieldLabel>
                <TextInput value={wmText} onChange={setWmText} placeholder="© Your Brand" />
              </>
            )}

            {wmType === WM.LINK && (
              <>
                <FieldLabel>URL / Link Label</FieldLabel>
                <TextInput value={wmLink} onChange={setWmLink} placeholder="https://yourbrand.com" />
                <div style={{ fontSize: 9, color: C.muted, marginTop: 6 }}>
                  Rendered with an underline cue on export
                </div>
              </>
            )}

            {wmType === WM.IMG && (
              <>
                <FieldLabel>Logo / Watermark Image</FieldLabel>
                <div
                  onClick={() => document.getElementById("__wmImgInput").click()}
                  style={{
                    border: `1px dashed ${wmImgFile ? C.goldDim : C.border}`,
                    borderRadius: 8, padding: 14,
                    textAlign: "center", cursor: "pointer",
                    background: C.card, transition: "all 0.15s",
                  }}
                >
                  <div style={{ fontSize: 11, color: wmImgFile ? C.gold : C.muted }}>
                    {wmImgFile
                      ? (wmImgFile.name.length > 24 ? wmImgFile.name.slice(0, 22) + "…" : wmImgFile.name)
                      : "Upload PNG logo (with transparency)"}
                  </div>
                </div>
                <input id="__wmImgInput" type="file" accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => e.target.files[0] && setWmImgFile(e.target.files[0])}
                />
              </>
            )}
          </div>

          {/* ── 4. APPEARANCE (text / link only) ─────────────────────────── */}
          {(wmType === WM.TEXT || wmType === WM.LINK) && (
            <div>
              <Sect>Appearance</Sect>

              {/* Colour picker + hex input */}
              <FieldLabel>Colour</FieldLabel>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input type="color" value={wmColor}
                  onChange={(e) => setWmColor(e.target.value)}
                  style={{ width: 38, height: 34, border: `1px solid ${C.border}`, borderRadius: 7, cursor: "pointer", padding: 2, background: "none" }}
                />
                <input value={wmColor}
                  onChange={(e) => setWmColor(e.target.value)}
                  style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "8px 10px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, outline: "none" }}
                />
              </div>

              {/* Quick palette */}
              <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
                {QUICK_COLORS.map((c) => (
                  <div key={c} onClick={() => setWmColor(c)}
                    style={{
                      width: 26, height: 26, borderRadius: 5,
                      background: c, cursor: "pointer",
                      border: wmColor === c ? `2px solid ${C.gold}` : `1px solid ${C.border}`,
                      boxSizing: "border-box", flexShrink: 0,
                    }}
                  />
                ))}
              </div>

              {/* Font family */}
              <FieldLabel>Font</FieldLabel>
              <select value={wmFont} onChange={(e) => setWmFont(e.target.value)}
                style={{
                  width: "100%", background: C.card, border: `1px solid ${C.border}`,
                  borderRadius: 7, color: C.text, padding: "9px 10px",
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                  outline: "none", cursor: "pointer", marginBottom: 14,
                }}>
                {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>

              {/* Toggles */}
              <div style={{ display: "flex", gap: 18 }}>
                <Toggle label="Bold"   value={wmBold}   onChange={setWmBold}   />
                <Toggle label="Shadow" value={wmShadow} onChange={setWmShadow} />
              </div>
            </div>
          )}

          {/* Shadow toggle for image watermarks */}
          {wmType === WM.IMG && (
            <div>
              <Sect>Appearance</Sect>
              <Toggle label="Drop Shadow" value={wmShadow} onChange={setWmShadow} />
            </div>
          )}

          {/* ── 5. SIZE & OPACITY ────────────────────────────────────────── */}
          <div>
            <Sect>Size & Opacity</Sect>
            <Slider
              label={wmType === WM.IMG ? "Logo Width" : "Font Size"}
              value={wmSize} min={8} max={120}
              fmt={(v) => wmType === WM.IMG ? `${v * 5}px` : `${v}px`}
              onChange={setWmSize}
            />
            <Slider
              label="Opacity"
              value={wmOpacity} min={5} max={100}
              fmt={(v) => `${v}%`}
              onChange={setWmOpacity}
            />
          </div>

          {/* ── 6. POSITION PRESETS ──────────────────────────────────────── */}
          <div>
            <Sect>Position</Sect>
            {/* 3×3 grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginBottom: 8 }}>
              {PRESETS.map((p) => {
                const active = activePreset === p.id;
                return (
                  <button key={p.id} onClick={() => applyPreset(p)} style={{
                    padding: "10px 0",
                    background: active ? C.gold : C.card,
                    border: `1px solid ${active ? C.gold : C.border}`,
                    borderRadius: 7, cursor: "pointer",
                    color: active ? C.bg : C.muted,
                    fontSize: 16, transition: "all 0.12s",
                  }}>
                    {p.icon}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 9, color: C.muted, textAlign: "center", letterSpacing: 1.5 }}>
              OR DRAG WATERMARK ON PREVIEW
            </div>
          </div>

          {/* ── 7. EXPORT ────────────────────────────────────────────────── */}
          <div>
            <Sect>Export</Sect>
            <button
              onClick={doExport}
              disabled={!mediaReady || exporting}
              style={{
                width: "100%", padding: "13px",
                background: mediaReady && !exporting ? C.gold : C.card,
                border: `1px solid ${mediaReady && !exporting ? C.gold : C.border}`,
                borderRadius: 8,
                color: mediaReady && !exporting ? C.bg : C.muted,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11, fontWeight: 700, letterSpacing: 2,
                cursor: mediaReady && !exporting ? "pointer" : "not-allowed",
                transition: "all 0.15s",
              }}
            >
              {exporting
                ? `● RECORDING  ${expPct}%`
                : `EXPORT ${mediaType === "video" ? "VIDEO" : "IMAGE"}`}
            </button>

            {/* Progress bar for video */}
            {exporting && (
              <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: C.border }}>
                <div style={{ width: `${expPct}%`, height: "100%", background: C.gold, borderRadius: 2, transition: "width 0.3s" }} />
              </div>
            )}

            {/* Format note */}
            {mediaReady && !exporting && (
              <div style={{ fontSize: 9, color: C.muted, marginTop: 7, textAlign: "center", letterSpacing: 1 }}>
                {mediaType === "video"
                  ? "EXPORTS AS .WEBM · FULL RESOLUTION"
                  : "EXPORTS AS .JPG / .PNG · LOSSLESS"}
              </div>
            )}

            {/* Success badge */}
            {exported && (
              <div style={{
                marginTop: 10, textAlign: "center", fontSize: 10,
                color: C.green, letterSpacing: 1,
              }}>
                ✓ SAVED TO DOWNLOADS
              </div>
            )}
          </div>

        </aside>

        {/* ══ RIGHT PREVIEW AREA ═══════════════════════════════════════════ */}
        <main style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          overflowY: "auto",
          background: C.bg,
          position: "relative",
        }}>

          {!mediaSrc ? (
            /* ── Empty state ─────────────────────────────────────────────── */
            <div style={{ textAlign: "center", opacity: 0.35, pointerEvents: "none" }}>
              <div style={{ fontSize: 62, marginBottom: 18 }}>🎞</div>
              <div style={{
                fontFamily: "'Instrument Serif', serif",
                fontStyle: "italic",
                fontSize: 30,
                color: C.text,
                marginBottom: 10,
              }}>
                Upload media to begin
              </div>
              <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1.5 }}>
                Supports images & videos · Drag-and-drop or browse
              </div>
            </div>

          ) : (
            /* ── Canvas preview ──────────────────────────────────────────── */
            <div style={{ width: "100%", maxWidth: 820 }}>

              {/* Instruction bar */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 12,
              }}>
                <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1.5 }}>
                  DRAG ON CANVAS TO REPOSITION WATERMARK
                </div>
                {mediaReady && (
                  <div style={{ fontSize: 9, color: C.muted }}>
                    {canvasRef.current?.width ?? "–"} × {canvasRef.current?.height ?? "–"} px
                  </div>
                )}
              </div>

              {/* Canvas container */}
              <div style={{
                position: "relative",
                borderRadius: 10, overflow: "hidden",
                border: `1px solid ${C.border}`,
                boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
                cursor: "crosshair",
                background: "#000",
              }}>
                <canvas
                  ref={canvasRef}
                  style={{ display: "block", width: "100%", height: "auto", maxHeight: "62vh" }}
                  onMouseDown={onPtrDown}
                  onMouseMove={onPtrMove}
                  onMouseUp={onPtrUp}
                  onMouseLeave={onPtrUp}
                  onTouchStart={(e) => { e.preventDefault(); onPtrDown(e); }}
                  onTouchMove={(e) => { e.preventDefault(); onPtrMove(e); }}
                  onTouchEnd={onPtrUp}
                />

                {/* PREVIEW badge */}
                {mediaReady && (
                  <div style={{
                    position: "absolute", top: 10, right: 10,
                    fontSize: 9, letterSpacing: 1.5,
                    color: C.gold, background: `${C.bg}cc`,
                    padding: "3px 8px", borderRadius: 4,
                    border: `1px solid ${C.goldDim}`,
                  }}>
                    PREVIEW
                  </div>
                )}

                {/* Loading spinner */}
                {mediaSrc && !mediaReady && (
                  <div style={{
                    position: "absolute", inset: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: C.card, color: C.muted, fontSize: 11, letterSpacing: 1.5,
                  }}>
                    LOADING MEDIA…
                  </div>
                )}
              </div>

              {/* Info strip */}
              {mediaReady && (
                <div style={{
                  display: "flex", gap: 0, marginTop: 14,
                  background: C.panel, borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  overflow: "hidden",
                }}>
                  {[
                    { label: "TYPE",    value: wmType.toUpperCase() },
                    { label: "SIZE",    value: wmType === WM.IMG ? `${wmSize * 5}px` : `${wmSize}px` },
                    { label: "OPACITY", value: `${wmOpacity}%` },
                    { label: "X",       value: `${Math.round(wmPos.x * 100)}%` },
                    { label: "Y",       value: `${Math.round(wmPos.y * 100)}%` },
                  ].map(({ label, value }, i, arr) => (
                    <div key={label} style={{
                      flex: 1, textAlign: "center", padding: "10px 4px",
                      borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                    }}>
                      <div style={{ fontSize: 8, color: C.muted, letterSpacing: 1.5, marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 11, color: C.gold, fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Hidden media elements (draw sources) ─────────────────────── */}
          {/* These are rendered off-screen so the canvas can drawImage() from them */}

          {mediaSrc && mediaType === "image" && (
            <img
              key={mediaSrc}
              src={mediaSrc}
              alt=""
              crossOrigin="anonymous"
              onLoad={(e) => onMediaReady(e.target)}
              style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none" }}
            />
          )}

          {mediaSrc && mediaType === "video" && (
            <video
              key={mediaSrc}
              src={mediaSrc}
              crossOrigin="anonymous"
              onLoadedMetadata={(e) => onMediaReady(e.target)}
              autoPlay loop muted playsInline
              style={{ position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
            />
          )}

        </main>
      </div>
    </div>
  );
}