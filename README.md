# ObscuraX

> **Privacy-first watermarking & face-redaction studio — runs 100% in the browser, zero server uploads, works offline.**

ObscuraX is a professional-grade media protection tool built with React + TypeScript. It lets you watermark images and videos, automatically detect and blur faces using on-device AI, draw custom privacy masks, and export everything as high-quality downloads — all without a single byte leaving your machine.

After the first visit it works with no internet connection at all, and it can be installed to a phone's home screen or a desktop as an app.

---

## ✨ Features

| Category | Capability |
|---|---|
| **Watermarking** | Text, image logo, or URL link overlays |
| **Styling** | Font family, colour (hex picker + palette), size, opacity, bold, drop shadow |
| **Positioning** | 9-point grid presets + freehand drag on canvas |
| **Filters** | Grayscale, Sepia, Invert, Blur, Soft blur, Brightness, Contrast, Vintage |
| **Face Detection** | Automatic face-detection with oval or rectangle masks (blur / pixelate / solid), soft edges, per-face on/off |
| **Nudity Blur** | Optional automatic blurring of exposed intimate areas (breasts, genitals, buttocks; male chest optional), on-device |
| **Manual Masking** | Draw custom areas for anything else you want to redact |
| **Video Support** | Faces are tracked frame to frame; timeline scrubber, mute/unmute; exports keep the sound (WebM, or MP4 on Safari) |
| **Bulk Export** | Process up to 20 images and download as a single ZIP archive |
| **Upscaling** | Export images at 2×, 3× or 4× with sharpening |
| **Undo / Redo** | Every edit (drawn areas, faces turned on/off, watermark, filter, mask style) — buttons or Ctrl/⌘ + Z |
| **Keeps your work** | Settings are remembered; the last photos or video, with their masks, are offered back on the next visit |
| **Config Persistence** | Export/import your full watermark settings as a `.json` file |
| **Offline & installable** | Service worker caches the app and face model; installable as a PWA |
| **Mobile** | Phone layout with bottom tab bar, touch drawing, pinch-to-zoom, share-to-Photos |
| **Privacy** | All processing runs client-side via Canvas API — no backend, no uploads |

---

## 🏗️ Technology Stack

### Core Framework
| Technology | Role |
|---|---|
| **React 19** | UI component model, hooks-based state management |
| **TypeScript** | Static typing across all components, utilities, and config |
| **Vite** | Dev server with HMR, production bundler |

### AI & Machine Learning
| Technology | Role |
|---|---|
| **face-api.js** | In-browser face detection via TensorFlow\.js backend (WebGL) |
| **SSD-MobileNet v1** | Single-shot face detector (≈ 5.4 MB quantised weights) |
| **NudeNet 320n** | YOLOv8n nudity detector (12 MB, ONNX), loaded only when nudity blur is on — AGPL-3.0 |
| **onnxruntime-web** | Runs NudeNet in WebAssembly (single-threaded), served with the app |
| **Bundled weights** | Served from `public/models/` with the app and cached by the service worker — no CDN, works offline |

### Media Processing
| Technology | Role |
|---|---|
| **HTML5 Canvas API** | All compositing, watermark rendering, mask application |
| **MediaRecorder API** | Captures canvas stream to WebM (or MP4 on Safari) video for export |
| **Web Audio API** | Routes the video's soundtrack into the recording |
| **IndexedDB / localStorage** | Saved session (media + masks) and preferences, on the device only |
| **JSZip** | In-browser ZIP creation for bulk image download |
| **FileReader / Blob / URL.createObjectURL** | Zero-copy image/video loading and download |
| **Web Share API** | On phones, hands exports to the share sheet (e.g. Save Image to Photos) |

### Offline
| Technology | Role |
|---|---|
| **Service worker** | `src/sw-template.js`, built to `dist/sw.js`; precaches every built file |
| **Web App Manifest** | `public/manifest.webmanifest` + icons in `public/icons/`; makes the app installable |

---

## 🤖 Face Detection — How It Works

### Model: SSD-MobileNet v1

ObscuraX uses the **SSD-MobileNet v1** face detector from [face-api.js](https://github.com/justadudewhohacks/face-api.js), a single-shot detector that runs in the browser on TensorFlow.js. Its weights ship with the app in `public/models/`, so detection needs no network.

```
Input Frame / Image
       │
       ▼
  Scale a copy to ≤ 2048 px
  (the model sees 512 px anyway; also keeps
   iOS Safari under its 16.7 MP canvas limit)
       │
       ▼
┌─────────────────────────────┐
│  SSD-MobileNet v1 (CNN)     │
│  • Input: 512 × 512 RGB     │
│  • Backbone: MobileNet,     │
│    depthwise separable conv │
│  • Output: bounding boxes + │
│    confidence scores        │
└─────────────────────────────┘
       │
       ▼
  "Find small faces": large photos are also
  scanned in overlapping tiles; results merged
       │
       ▼
  Confidence filter (Sensitivity slider)
       │
       ▼
  Normalise to [0–1] fractions
  (relative to frame dimensions)
       │
       ▼
  Store as Mask objects in state
  { id, x, y, w, h, type, isAuto, score }
       │
       ▼
  Canvas Render Pass → applyMasks()
  (blur / pixelate / solid)
```

### Architecture Details

- **Input resolution:** every input is resized to 512 × 512 before inference, so small faces in a large photo shrink to a few pixels. The optional tiled pass scans 2 × 2 or 3 × 3 overlapping sections at higher effective resolution to catch them.
- **Single-shot detection:** boxes come out of a single forward pass over multi-scale feature maps, with no separate region-proposal stage.
- **Merging:** overlapping boxes from the full frame and the tiles are unioned rather than dropped, so when in doubt more is covered.
- **Weights size:** ≈ 5.4 MB (quantised), in `public/models/`. Downloaded once with the app and kept by the service worker.

### Detection Pipeline in Code

```
1. faceapi.nets.ssdMobilenetv1.loadFromUri("./models")
        ↓ (once, on mount — from the offline cache after the first visit)
2. detectFaces(image | video, { minConfidence, smallFaceBoost })
        ↓   src/utils/faceDetection.ts
3. detections[].box → { x, y, width, height }  (pixel coords)
        ↓
4. Normalise:
        maskX = box.x / imageWidth
        maskY = box.y / imageHeight
        maskW = box.width / imageWidth
        maskH = box.height / imageHeight
        ↓
5. Merge with the image's masks (faces turned off stay off)
        ↓
6. draw() → applyMasks(ctx, canvasW, canvasH, masks, maskStyle)
```

### Mask Rendering Algorithms

Once bounding boxes are known, `applyMasks()` in `src/utils/canvas.ts` applies one of three visual effects inside each rectangle:

| Mode | Algorithm |
|---|---|
| **Blur** | `ctx.filter = "blur(Npx)"` applied to a clipped region, strength scales with mask size |
| **Pixelate** | Sample pixel colour at every N-pixel grid point, fill N×N rectangles — produces the classic mosaic |
| **Box** | Solid filled rectangle in a configurable colour — fastest, zero visual information leakage |

### Video Scanning

For video files, ObscuraX samples the video at the **scan rate** (2–15 frames per second, default 5), detects faces in each sample, and links the boxes into **tracks** so each face is one item that can be turned on or off:

```
t=0.0s  t=0.2s  t=0.4s  t=0.6s  …
   │       │       │       │
   └───────┴───────┴───────┴──── detectFaces() per sample
                 ↓
       Link boxes into face tracks
                 ↓
   During playback and export, interpolate each
   face's box between the two nearest samples
```

A face the detector misses in one sample stays covered for the whole gap instead of flashing into view. Export rescans first if settings changed.

---

## 📁 Project Structure

```
watermark-studio/
├── src/
│   ├── ObscuraX.tsx          # Root application component (editor, export)
│   ├── App.jsx               # Entry point wrapper
│   ├── main.jsx              # Vite/React bootstrap; registers the service worker
│   ├── pwa.ts                # Service worker registration, update prompt, online state
│   ├── sw-template.js        # Service worker source (built to dist/sw.js)
│   ├── index.css             # Styles, including phone and touch layouts
│   ├── components/
│   │   └── common/
│   │       └── Atoms.tsx     # Shared UI primitives (Field, Range, Seg, Modal…)
│   ├── constants/
│   │   ├── config.ts         # WM types, font list, filter list, presets
│   │   └── theme.ts          # Colour tokens
│   ├── hooks/
│   │   ├── useHistory.ts     # Undo / redo stack
│   │   └── useTheme.ts       # Light / dark / system colour mode
│   ├── types/
│   │   └── index.ts          # ImageEntry, Mask, WatermarkConfig interfaces
│   ├── utils/
│   │   ├── canvas.ts         # applyWatermark(), applyMasks() — pure canvas logic
│   │   ├── faceDetection.ts  # Model loading, detection, video face tracking
│   │   ├── bodyDetection.ts  # NudeNet nudity detection (onnxruntime-web)
│   │   ├── upscale.ts        # Export upscaling and sharpening
│   │   ├── session.ts        # Saved preferences and session (localStorage, IndexedDB)
│   │   └── device.ts         # Per-device canvas limits (phones, iOS Safari)
│   └── helpers/
│       └── media.ts          # detectImageResolution() helper
├── public/
│   ├── models/               # Face model weights; NudeNet model + its AGPL-3.0 license
│   ├── icons/                # App icons (SVG sources + PNG sizes)
│   └── manifest.webmanifest  # Install metadata
├── index.html
├── vite.config.js            # Includes the build step that writes dist/sw.js
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
npm run build        # Output to /dist, including sw.js
npm run preview      # Preview production build locally
```

The service worker only runs in the production build (`npm run build` + `npm run preview`, or a deployed copy), not under `npm run dev`.

### Deploying

`dist/` is a static site and can be hosted anywhere (Netlify, Vercel, GitHub Pages, S3, nginx…). Asset paths are relative, so it also works from a sub-path.

- **Serve over HTTPS.** Browsers only run service workers on HTTPS (or `localhost`); without it the app still works online but not offline.
- **Don't cache `sw.js` for long.** Serve it with `Cache-Control: no-cache` (or a short max-age) so users pick up new versions promptly. The files in `assets/` are content-hashed and can be cached forever.
- **Serve `manifest.webmanifest`** as `application/manifest+json` (most hosts do this already).

---

## 🔞 Nudity Blur

Turn on **Blur nudity automatically** in the *Blur* panel to find and cover exposed intimate areas, in photos and videos, the same way faces are covered.

- **What's covered:** choose *Breasts*, *Genitals* (including anus), *Buttocks* and, optionally, *Male chest*. Covered (clothed) areas are ignored.
- **Sensitivity:** lower thresholds find more; the default (75%) matches NudeNet's own threshold.
- Each detected area appears in *Blurred areas* as "Breast 1", "Buttocks 1"… with an icon instead of a thumbnail, and can be turned off like a face. Undo, saved sessions and video tracking work the same as for faces.
- **Model:** [NudeNet](https://github.com/notAI-tech/NudeNet) 320n (YOLOv8n, 320 × 320 input), run through onnxruntime-web in WebAssembly. Pre- and post-processing follow NudeNet's reference implementation. Nothing is uploaded.
- **Download:** the model (12 MB) and runtime (15 MB) download the first time the option is turned on, then the service worker keeps them for offline use, including across app updates.
- Detection is a safety net, not a guarantee: check the result before sharing, and draw extra areas where needed.

---

## ↩️ Undo & Saved Work

- **Undo / redo** covers your own edits: drawing and deleting blur areas, turning faces on or off, clearing masks, and watermark, filter and mask-style changes (a slider drag is one step). Use the arrows in the top bar, or Ctrl/⌘ + Z and Ctrl/⌘ + Shift + Z (Ctrl + Y on Windows).
- Face detection results are never undone on their own: undo can't make a face that was found go unblurred unless you turned it off yourself. Undoing *Clear all masks* finds the faces again.
- **Preferences** (watermark text, logo, style, position, filter, mask style, detection and export options) are remembered automatically.
- **Your last session** (photos or video, drawn areas, face choices and the video's face track) is saved on this device as you work. Next time, the start screen offers *Continue where you left off?*. Choose *Start over* to delete it; *Remove all* also deletes it. Videos over 500 MB aren't kept.
- Everything is stored in this browser only (IndexedDB and localStorage), never uploaded.

---

## 🎬 Video Export

The video plays through once in real time while it's recorded, so the export has the same length and speed as the original, **with its sound**. The soundtrack is routed through the Web Audio API into the recording (the mute button only affects your speakers). Use *Stop* in the timeline to cancel. If a browser refuses to start the sound, the video is saved without it and the message says so.

---

## 📴 Offline & Install

On the first visit the service worker downloads and caches everything the app needs (≈ 7 MB: app code, fonts, icons and the face model) and shows **"Ready to work offline"**. After that ObscuraX opens and works with no connection, including face detection and every export.

- **Install:** in Chrome/Edge use *Install app* in the address bar; on Android, *Add to Home screen*; on iPhone/iPad, Safari's *Share → Add to Home Screen*.
- **Updates:** a new deploy is downloaded in the background. The app then shows **"A new version is ready"** with a *Reload* button. It never reloads by itself; your work is saved first and offered back after the reload.
- **Offline indicator:** the top bar shows *Offline* when there's no connection, as a reminder that everything still works.
- **How it works:** at build time, `vite.config.js` lists every file in `dist/`, hashes their contents into a version, and writes `dist/sw.js` from `src/sw-template.js`. Each new version gets its own cache, and old caches are deleted once it takes over.
- **Optional large files:** the nudity detector and its WebAssembly runtime aren't downloaded on install. They're cached the first time nudity blur is used, in a separate cache that's kept across versions (files a version no longer uses are pruned).

---

## 📱 Mobile

On screens narrower than 760 px the editor switches to a phone layout:

- **Bottom tab bar** for Face blur, Watermark, Adjust and Theme. Tap the active tab (or the chevron) to hide the settings panel and give the image more room.
- **Touch:** one finger draws a blur area or moves the watermark; two fingers pinch to zoom and drag to pan. In Adjust, one finger pans.
- **Export** opens as a bottom sheet. After saving, *Share or save* hands the file to the share sheet (e.g. *Save Image* to Photos).
- **Large photos:** iOS Safari can't draw canvases over 16.7 MP, and recent iPhones take 24 MP photos. ObscuraX keeps the preview at ≤ 8 MP on phones, runs face detection on a scaled copy, and saves exports that are too large for the device at the largest size it can handle (the export dialog says when this happens).
- **Video** records at normal speed on phones, and as MP4 where WebM isn't supported (Safari).

---

## 🎯 Usage Guide

1. **Upload media** — drag-and-drop or click (tap on phones) the upload zone. Supports JPG, PNG, GIF (images) and MP4, WebM (video). Up to 20 images at once.
2. **Choose watermark type** — TEXT, IMAGE (logo PNG), or LINK.
3. **Style it** — pick font, colour, size, opacity; toggle bold and shadow.
4. **Position it** — click a preset or drag directly on the live canvas preview.
5. **Enable masking** — toggle Masking Mode. Faces are detected automatically; draw additional rectangles manually.
6. **Export** — single image (optionally upscaled), bulk ZIP, or WebM/MP4 video with sound.
7. **Save settings** — use Export Config / Import Config to reuse your setup.

---

## 🔒 Privacy Guarantee

All media stays on your device. ObscuraX is a **pure client-side application**:
- No image or video data is ever transmitted to a server.
- Face detection runs on-device using the browser's JavaScript engine.
- The face-detection model ships with the app and is cached on your device; there are no requests to third-party servers.
- After the first visit the app makes no network requests at all, except checking its own host for updates.

---

## 📄 License

ObscuraX's own code is MIT © [Deshan](https://github.com/Deshan555).

The bundled nudity detector, [NudeNet](https://github.com/notAI-tech/NudeNet) (`public/models/nudenet-320n.onnx`), is licensed **AGPL-3.0** (full text in `public/models/NUDENET-LICENSE.txt`). The built app includes it, so distributing or hosting ObscuraX must follow the AGPL-3.0 as well: the complete corresponding source has to be available to its users. This public repository provides that, and the app links to it from the Blur panel. If you fork and host it, keep your source public and update `SOURCE_URL` in `src/constants/config.ts`, or remove the nudity feature.

Other components: face-api.js (MIT), onnxruntime-web (MIT), React (MIT), JSZip (MIT or GPL-3.0), lucide-react (ISC), Poppins font (OFL-1.1).
