import React, { FC } from "react";
import { C } from "../../constants/theme";

export const Sect: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, letterSpacing: 2.5, textTransform: "uppercase", color: C.muted, marginBottom: 10, paddingBottom: 7, borderBottom: `1px solid ${C.border}` }}>
    {children}
  </div>
);

export const FL: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>
    {children}
  </div>
);

export const TI: FC<{ value: string; onChange: (v: string) => void; placeholder?: string }> = ({ value, onChange, placeholder }) => (
  <input
    value={value}
    onChange={e => onChange(e.target.value)}
    placeholder={placeholder}
    style={{ width: "100%", boxSizing: "border-box", background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: "9px 12px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, outline: "none", display: "block" }}
    onFocus={e => (e.target.style.borderColor = C.goldDim)}
    onBlur={e => (e.target.style.borderColor = C.border)}
  />
);

export const Toggle: FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({ label, value, onChange }) => (
  <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", userSelect: "none" }}>
    <div onClick={() => onChange(!value)} style={{ width: 34, height: 18, borderRadius: 9, position: "relative", background: value ? C.gold : C.subtle, transition: "background .18s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: value ? 17 : 3, width: 12, height: 12, borderRadius: "50%", background: value ? C.bg : C.muted, transition: "left .18s" }} />
    </div>
    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: C.muted }}>{label}</span>
  </label>
);

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
  accent?: string;
}

export const Slider: FC<SliderProps> = ({ label, value, min, max, step = 1, onChange, fmt, accent = C.gold }) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: accent }}>{fmt ? fmt(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", cursor: "pointer", height: 3, borderRadius: 2, outline: "none", border: "none", WebkitAppearance: "none", appearance: "none", background: `linear-gradient(to right,${accent} ${pct}%,${C.subtle} ${pct}%)` }}
      />
    </div>
  );
};

interface BtnProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  color?: string;
  mb?: number;
}

export const Btn: FC<BtnProps> = ({ children, onClick, disabled = false, color = C.gold, mb = 8 }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      width: "100%", marginBottom: mb, padding: "11px", fontFamily: "'JetBrains Mono',monospace", fontSize: 10,
      fontWeight: 700, letterSpacing: 2, borderRadius: 8, display: "block",
      cursor: disabled ? "not-allowed" : "pointer", transition: "all .15s",
      background: disabled ? C.card : color === C.gold ? C.gold : `${color}25`,
      border: `1px solid ${disabled ? C.border : color}`,
      color: disabled ? C.muted : color === C.gold ? C.bg : color,
    }}
  >
    {children}
  </button>
);

export const WmTab: FC<{ id: string; label: string; active: boolean; onSelect: (id: string) => void }> = ({ id, label, active, onSelect }) => (
  <button
    onClick={() => onSelect(id)}
    style={{ flex: 1, padding: "8px 0", background: active ? C.gold : "transparent", border: `1px solid ${active ? C.gold : C.border}`, borderRadius: 7, color: active ? C.bg : C.muted, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: 1.5, cursor: "pointer", fontWeight: active ? 700 : 500, transition: "all .14s" }}
  >
    {label}
  </button>
);
