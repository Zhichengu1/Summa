"use client";
// SearchField — the one search/filter text box used across the app (page toolbars,
// the DataTable filter, the sidebar watchlist filter). Leading glass icon, a clear
// button once there is text, and Escape clears in place. Pure presentational.
import { useRef } from "react";

import { Icon } from "./Icon";

export function SearchField({
  value, onChange, placeholder = "Search…", width, autoFocus = false, ariaLabel, size = "md",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** CSS width (defaults to the container width). */
  width?: number | string;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** "sm" is the compact variant for the sidebar. */
  size?: "sm" | "md";
}) {
  const ref = useRef<HTMLInputElement>(null);
  const clear = () => { onChange(""); ref.current?.focus(); };
  return (
    <div className={`field-search${size === "sm" ? " sm" : ""}`} style={width != null ? { width } : undefined}>
      <span className="field-icon" aria-hidden><Icon name="search" size={13} /></span>
      <input
        ref={ref}
        className="field-input"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); clear(); } }}
      />
      {value && (
        <button type="button" className="field-clear" onClick={clear} aria-label="Clear search" title="Clear (Esc)"><Icon name="x" size={12} strokeWidth={2} /></button>
      )}
    </div>
  );
}
