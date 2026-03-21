export const WM = { TEXT: "text", IMG: "img", LINK: "link" } as const;

export const PRESETS = [
  { id: "tl", x: 0.07, y: 0.07, icon: "↖" },
  { id: "tc", x: 0.50, y: 0.07, icon: "↑" },
  { id: "tr", x: 0.93, y: 0.07, icon: "↗" },
  { id: "ml", x: 0.07, y: 0.50, icon: "←" },
  { id: "cc", x: 0.50, y: 0.50, icon: "·" },
  { id: "mr", x: 0.93, y: 0.50, icon: "→" },
  { id: "bl", x: 0.07, y: 0.93, icon: "↙" },
  { id: "bc", x: 0.50, y: 0.93, icon: "↓" },
  { id: "br", x: 0.93, y: 0.93, icon: "↘" },
] as const;

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
] as const;

export const MAX_FILES = 20;

export const FILTERS = [
  { label: "None", value: "none" },
  { label: "Grayscale", value: "grayscale(100%)" },
  { label: "Sepia", value: "sepia(100%)" },
  { label: "Invert", value: "invert(100%)" },
  { label: "Blur", value: "blur(4px)" },
  { label: "Bright", value: "brightness(1.5)" },
  { label: "Contrast", value: "contrast(1.6)" },
  { label: "Vintage", value: "sepia(50%) contrast(1.2) brightness(0.9)" },
] as const;
