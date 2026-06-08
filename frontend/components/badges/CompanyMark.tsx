// CompanyMark — the small rounded ticker badge (first two letters over a
// deterministic per-ticker gradient). Styles are cached by ticker+size so the
// many table rows that render a mark don't recompute the gradient string.
import type { CSSProperties } from "react";

function tickerHue(t: string): number {
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const _markCache = new Map<string, CSSProperties>();
function companyMarkStyle(ticker: string, size: number): CSSProperties {
  const key = `${ticker}:${size}`;
  if (_markCache.has(key)) return _markCache.get(key)!;
  const h = tickerHue(ticker);
  const s: CSSProperties = {
    width: size, height: size, flexShrink: 0, borderRadius: Math.round(size * 0.22),
    background: `linear-gradient(135deg, oklch(0.20 0.08 ${h}), oklch(0.28 0.07 ${h}))`,
    border: `1px solid oklch(0.38 0.10 ${h})55`,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: size * 0.31, fontWeight: 700,
    color: `oklch(0.82 0.14 ${h})`, letterSpacing: "0.04em",
  };
  _markCache.set(key, s);
  return s;
}

export function CompanyMark({ ticker, size = 32 }: { ticker: string; size?: number }) {
  return <div style={companyMarkStyle(ticker, size)}>{ticker.slice(0, 2)}</div>;
}
