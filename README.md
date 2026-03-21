# ObscuraX

> **Privacy-first watermarking & face-redaction studio — runs 100% in the browser, zero server uploads.**

ObscuraX is a professional-grade media protection tool built with React + TypeScript. It lets you watermark images and videos, automatically detect and blur faces using on-device AI, draw custom privacy masks, and export everything as high-quality downloads — all without a single byte leaving your machine.

---

## ✨ Features

| Category | Capability |
|---|---|
| **Watermarking** | Text, image logo, or URL link overlays |
| **Styling** | Font family, colour (hex picker + palette), size, opacity, bold, drop shadow |
| **Positioning** | 9-point grid presets + freehand drag on canvas |
| **Filters** | Grayscale, Sepia, Invert, Blur, Brightness, Contrast, Vintage |
| **Face Detection** | Automatic face-detection with bounding-box masking (blur / pixelate / solid box) |
| **Manual Masking** | Draw custom rectangles for any region you want to redact |
| **Video Support** | Full video watermarking with timeline scrubber, mute/unmute, and WebM export |
| **Bulk Export** | Process up to 20 images and download as a single ZIP archive |
| **Config Persistence** | Export/import your full watermark settings as a `.json` file |
| **Privacy** | All processing runs client-side via Canvas API — no backend, no uploads |

---

## 🏗️ Technology Stack

### Core Framework
| Technology | Role |
|---|---|
| **React 18** | UI component model, hooks-based state management |
| **TypeScript** | Static typing across all components, utilities, and config |
| **Vite** | Dev server with HMR, production bundler |

### AI & Machine Learning
| Technology | Role |
|---|---|
| **face-api.js** | In-browser face detection via TensorFlow\.js backend |
| **Tiny Face Detector** | Lightweight CNN model (< 190 KB weights), runs on CPU |
| **CDN-loaded weights** | Model weights fetched from `jsdelivr` CDN at startup — no bundling required |

### Media Processing
| Technology | Role |
|---|---|
| **HTML5 Canvas API** | All compositing, watermark rendering, mask application |
| **MediaRecorder API** | Captures canvas stream to WebM video for export |
| **JSZip** | In-browser ZIP creation for bulk image download |
| **FileReader / Blob / URL.createObjectURL** | Zero-copy image/video loading and download |

---

## 🤖 Face Detection — How It Works

### Model: Tiny Face Detector

ObscuraX uses the **Tiny Face Detector** from [face-api.js](https://github.com/justadudewhohacks/face-api.js), a compact neural network designed for real-time in-browser inference.

```
Input Frame / Image
       │
       ▼
┌─────────────────────────────┐
│  Tiny Face Detector (CNN)   │
│  • Input: RGB image tensor  │
│  • Backbone: MobileNet-like │
│    depthwise separable conv │
│  • Output: bounding boxes + │
│    confidence scores        │
└─────────────────────────────┘
       │
       ▼
  Confidence Filter
  (default threshold)
       │
       ▼
  Face Bounding Boxes
  [ { x, y, width, height } ]
       │
       ▼
  Normalise to [0–1] fractions
  (relative to frame dimensions)
       │
       ▼
  Store as Mask objects in state
  { id, x, y, w, h, type, isAuto }
       │
       ▼
  Canvas Render Pass → applyMasks()
  (blur / pixelate / solid box)
```

### Architecture Details

The Tiny Face Detector uses a **MobileNet-inspired depthwise separable convolutional architecture**:

- **Input resolution:** Scales the image down to a fixed detection resolution (default 416 × 416) before inference to keep latency under 50 ms on modern hardware.
- **Feature pyramid:** A series of depthwise + pointwise conv blocks extract spatial features across multiple receptive fields.
- **Single-shot detection:** Unlike two-stage detectors (e.g., Faster R-CNN), this model outputs bounding boxes directly in a single forward pass — making it fast enough to run frame-by-frame on video.
- **Anchor-free output:** Bounding boxes are regressed directly from feature map cells, removing the need to pre-define anchor shapes.
- **Weights size:** ≈ 190 KB (quantised) — small enough to load over a CDN in under a second on a typical connection.

### Detection Pipeline in Code

```
1. faceapi.nets.tinyFaceDetector.loadFromUri(CDN_URL)
        ↓ (once, on mount)
2. faceapi.detectAllFaces(imageElement | videoElement,
        new faceapi.TinyFaceDetectorOptions())
        ↓
3. detections[].box → { x, y, width, height }  (pixel coords)
        ↓
4. Normalise:
        maskX = box.x / imageWidth
        maskY = box.y / imageHeight
        maskW = box.width / imageWidth
        maskH = box.height / imageHeight
        ↓
5. Push Mask objects → setMasks(prev => [...prev, ...newMasks])
        ↓
6. draw() → applyMasks(ctx, canvasW, canvasH, masks)
```

### Mask Rendering Algorithms

Once bounding boxes are known, `applyMasks()` in `src/utils/canvas.ts` applies one of three visual effects inside each rectangle:

| Mode | Algorithm |
|---|---|
| **Blur** | `ctx.filter = "blur(Npx)"` applied to a clipped region, strength scales with mask size |
| **Pixelate** | Sample pixel colour at every N-pixel grid point, fill N×N rectangles — produces the classic mosaic |
| **Box** | Solid filled rectangle in a configurable colour — fastest, zero visual information leakage |

### Video Scanning

For video files, ObscuraX samples **6 evenly-spaced frames** across the full duration, runs face detection on each, and accumulates all unique masks:

```
t=0%  t=20%  t=40%  t=60%  t=80%  t=100%
  │      │      │      │      │      │
  └──────┴──────┴──────┴──────┴──────┘
         detectAllFaces() × 6
               ↓
         Union all boxes
               ↓
         setMasks(accumulated)
```

This gives robust coverage of faces that appear at different points in the video without processing every frame.

---

## 📁 Project Structure

```
watermark-studio/
├── src/
│   ├── ObscuraX.tsx          # Root application component
│   ├── App.jsx               # Entry point wrapper
│   ├── main.jsx              # Vite/React bootstrap
│   ├── components/
│   │   └── common/
│   │       └── Atoms.tsx     # Shared UI primitives (Slider, Toggle, Btn, WmTab…)
│   ├── constants/
│   │   ├── config.ts         # WM types, font list, filter list, presets
│   │   └── theme.ts          # Colour tokens (C.gold, C.bg, C.panel…)
│   ├── types/
│   │   └── index.ts          # ImageEntry, Mask, WatermarkConfig interfaces
│   ├── utils/
│   │   └── canvas.ts         # applyWatermark(), applyMasks() — pure canvas logic
│   └── helpers/
│       └── media.ts          # detectImageResolution() helper
├── public/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js ≥ 18
- npm ≥ 9

### Install & Run

```bash
# Clone the repository
git clone https://github.com/Deshan555/ObscuraX.git
cd ObscuraX

# Install dependencies
npm install

# Start development server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Production Build

```bash
npm run build        # Output to /dist
npm run preview      # Preview production build locally
```

---

## 🎯 Usage Guide

1. **Upload media** — drag-and-drop or click the upload zone. Supports JPG, PNG, GIF (images) and MP4, WebM (video). Up to 20 images at once.
2. **Choose watermark type** — TEXT, IMAGE (logo PNG), or LINK.
3. **Style it** — pick font, colour, size, opacity; toggle bold and shadow.
4. **Position it** — click a preset or drag directly on the live canvas preview.
5. **Enable masking** — toggle Masking Mode. Faces are detected automatically; draw additional rectangles manually.
6. **Export** — single image, bulk ZIP, or WebM video.
7. **Save settings** — use Export Config / Import Config to reuse your setup.

---

## 🔒 Privacy Guarantee

All media stays on your device. ObscuraX is a **pure client-side application**:
- No image or video data is ever transmitted to a server.
- Face detection runs on-device using the browser's JavaScript engine.
- The only network request is fetching the face-detection model weights (~190 KB) from a public CDN on first load; these are small read-only files with no user data.

---

## 📄 License

MIT © [Deshan](https://github.com/Deshan555)
