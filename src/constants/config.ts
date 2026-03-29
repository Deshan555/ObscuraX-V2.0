export const WM = { TEXT: "text", IMG: "img", LINK: "link" } as const;

export const PRESETS = [
  { id: "tl", x: .07, y: .07, icon: "↖" }, { id: "tc", x: .50, y: .07, icon: "↑" }, { id: "tr", x: .93, y: .07, icon: "↗" },
  { id: "ml", x: .07, y: .50, icon: "←" }, { id: "cc", x: .50, y: .50, icon: "·" }, { id: "mr", x: .93, y: .50, icon: "→" },
  { id: "bl", x: .07, y: .93, icon: "↙" }, { id: "bc", x: .50, y: .93, icon: "↓" }, { id: "br", x: .93, y: .93, icon: "↘" },
];

export const FONTS = [
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

export const PALETTE = ["#ffffff", "#000000", "#e8b86d", "#ff4d4d", "#4d94ff", "#3ecf8e"];

export const MAX_FILES = 20;

export const FILTERS = [
  { label: "None",      value: "none" },
  { label: "Grayscale", value: "grayscale(100%)" },
  { label: "Sepia",     value: "sepia(100%)" },
  { label: "Invert",    value: "invert(100%)" },
  { label: "Blur",      value: "blur" },
  { label: "Bright",    value: "brightness(1.5)" },
  { label: "Contrast",  value: "contrast(1.6)" },
  { label: "Vintage",   value: "sepia(50%) contrast(1.2) brightness(0.9)" },
];
