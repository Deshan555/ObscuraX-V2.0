import React, { FC, useEffect, useId, useState } from "react";

// Shared controls. Styling lives in src/index.css; these only set classes and ARIA.

export const Field: FC<{ label: string; children: React.ReactNode; htmlFor?: string }> = ({ label, children, htmlFor }) => (
  <div className="field">
    {htmlFor ? <label className="lbl" htmlFor={htmlFor}>{label}</label> : <div className="lbl">{label}</div>}
    {children}
  </div>
);

export const TextInput: FC<{ value: string; onChange: (v: string) => void; placeholder?: string; id?: string; label?: string }> = ({ value, onChange, placeholder, id, label }) => (
  <input id={id} className="input" value={value} placeholder={placeholder} aria-label={id ? undefined : label} onChange={e => onChange(e.target.value)} />
);

export const Select: FC<{ value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; id?: string; label?: string }> = ({ value, onChange, options, id, label }) => (
  <div className="select">
    <select id={id} className="input" value={value} aria-label={id ? undefined : label} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

/** A settings row: text on the left, switch on the right. */
export const SwitchRow: FC<{ label: string; sub?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ label, sub, value, onChange, disabled }) => {
  const id = useId();
  return (
    <div className="set-row">
      <div className="set-text">
        <div id={id}>{label}</div>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <button type="button" role="switch" className="switch" aria-checked={value} aria-labelledby={id} disabled={disabled} onClick={() => onChange(!value)} />
    </div>
  );
};

interface RangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}

export const Range: FC<RangeProps> = ({ label, value, min, max, step = 1, onChange, fmt }) => {
  const id = useId();
  return (
    <div className="range">
      <div className="range-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{fmt ? fmt(value) : value}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
};

interface SegProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}

/** Segmented control: a pill track with one chosen option. */
export function Seg<T extends string>({ options, value, onChange, label }: SegProps<T>) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/**
 * Destructive button that confirms in place: the first click arms it
 * ("Confirm?"), a second click within 3 seconds runs the action.
 */
export const ArmedBtn: FC<{ children: React.ReactNode; onConfirm: () => void; className?: string; disabled?: boolean }> = ({ children, onConfirm, className = "", disabled }) => {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={`btn danger ${armed ? "armed" : ""} ${className}`} disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? "Confirm?" : children}
    </button>
  );
};

export const Spinner: FC = () => <span className="spin" aria-hidden="true" />;

export const Progress: FC<{ label: string; meta?: string; pct: number }> = ({ label, meta, pct }) => (
  <div className="pg">
    <div className="pg-line"><span>{label}</span>{meta && <span className="pg-meta">{meta}</span>}</div>
    <div className="bar" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  </div>
);
