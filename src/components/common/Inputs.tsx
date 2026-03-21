import React from "react";
import { C } from "../../constants/theme";

/** Section divider label */
export const Sect = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      letterSpacing: 2.5,
      textTransform: "uppercase",
      color: C.muted,
      marginBottom: 10,
      paddingBottom: 7,
      borderBottom: `1px solid ${C.border}`,
    }}
  >
    {children}
  </div>
);

/** Gradient-track slider */
export const Slider = ({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  fmt,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            color: C.muted,
            letterSpacing: 1.5,
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: C.gold,
          }}
        >
          {fmt ? fmt(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          cursor: "pointer",
          height: 3,
          borderRadius: 2,
          outline: "none",
          border: "none",
          WebkitAppearance: "none",
          appearance: "none",
          background: `linear-gradient(to right, ${C.gold} ${pct}%, ${C.subtle} ${pct}%)`,
        }}
      />
    </div>
  );
};

/** Watermark type pill tab */
export const TypeTab = ({
  label,
  id,
  active,
  onSelect,
}: {
  label: string;
  id: string;
  active: boolean;
  onSelect: (id: string) => void;
}) => {
  return (
    <button
      onClick={() => onSelect(id)}
      style={{
        flex: 1,
        padding: "8px 0",
        background: active ? C.gold : "transparent",
        border: `1px solid ${active ? C.gold : C.border}`,
        borderRadius: 7,
        color: active ? C.bg : C.muted,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        letterSpacing: 1.5,
        cursor: "pointer",
        fontWeight: active ? 700 : 500,
        transition: "all 0.14s",
      }}
    >
      {label}
    </button>
  );
};

/** Toggle switch */
export const Toggle = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) => (
  <label
    style={{
      display: "flex",
      alignItems: "center",
      gap: 9,
      cursor: "pointer",
      userSelect: "none",
    }}
  >
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 34,
        height: 18,
        borderRadius: 9,
        position: "relative",
        background: value ? C.gold : C.subtle,
        transition: "background 0.18s",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: value ? 17 : 3,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: value ? C.bg : C.muted,
          transition: "left 0.18s",
        }}
      />
    </div>
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        color: C.muted,
      }}
    >
      {label}
    </span>
  </label>
);

/** Styled text input */
export const TI = ({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) => {
  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = C.goldDim;
  };
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = C.border;
  };

  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      onFocus={handleFocus}
      onBlur={handleBlur}
      style={{
        width: "100%",
        boxSizing: "border-box",
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 7,
        color: C.text,
        padding: "9px 12px",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        outline: "none",
        transition: "border-color 0.15s",
      }}
    />
  );
};

/** Small field label */
export const FL = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: C.muted,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 6,
    }}
  >
    {children}
  </div>
);
