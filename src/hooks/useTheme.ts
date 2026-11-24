import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "obscurax.theme";

/** Light / dark / follow-the-computer. index.html applies the saved value before first paint. */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch { return "system"; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") delete root.dataset.theme; else root.dataset.theme = mode;
    try { localStorage.setItem(KEY, mode); } catch { /* storage unavailable */ }
  }, [mode]);
  const cycle = () => setMode(m => (m === "system" ? "light" : m === "light" ? "dark" : "system"));
  return { mode, cycle };
}
