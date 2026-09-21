// CompanyMark — the small square ticker badge (first two letters). Deliberately
// neutral: one graphite surface for every company, so colour in the UI is reserved
// for data (direction, status) rather than identity. Styles are cached by size so
// the many table rows that render a mark don't rebuild the object.
import type { CSSProperties } from "react";

const _markCache = new Map<number, CSSProperties>();
function companyMarkStyle(size: number): CSSProperties {
  const cached = _markCache.get(size);
  if (cached) return cached;
  const s: CSSProperties = {
    width: size, height: size, flexShrink: 0, borderRadius: Math.max(4, Math.round(size * 0.18)),
    background: "var(--bg-3)",
    border: "1px solid var(--border-2)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "var(--font-mono)", fontSize: Math.round(size * 0.34), fontWeight: 700,
    color: "var(--fg-1)", letterSpacing: "0.02em", lineHeight: 1,
  };
  _markCache.set(size, s);
  return s;
}

export function CompanyMark({ ticker, size = 32 }: { ticker: string; size?: number }) {
  return <div style={companyMarkStyle(size)} aria-hidden>{ticker.slice(0, 2)}</div>;
}
