// Display formatters. Financial values arrive in actual dollars.

export function fmtUSD(v: number | null | undefined, opts?: { sign?: boolean }): string {
  if (v == null || Number.isNaN(v)) return "—";
  const sign = v < 0 ? "-" : opts?.sign && v > 0 ? "+" : "";
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e12) s = `${(a / 1e12).toFixed(2)}T`;
  else if (a >= 1e9) s = `${(a / 1e9).toFixed(2)}B`;
  else if (a >= 1e6) s = `${(a / 1e6).toFixed(1)}M`;
  else if (a >= 1e3) s = `${(a / 1e3).toFixed(1)}K`;
  else s = a.toFixed(0);
  return `${sign}$${s}`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function fmtDelta(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtPeriodLabel(iso: string, periodType: "annual" | "quarterly"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (periodType === "annual") return `FY${d.getFullYear()}`;
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} '${String(d.getFullYear()).slice(2)}`;
}

export function elapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Form-type badge color tokens (resolved in globals.css).
export function formColorVar(form: string): string {
  if (form.startsWith("10-K")) return "var(--form-10k)";
  if (form.startsWith("10-Q")) return "var(--form-10q)";
  if (form.startsWith("8-K")) return "var(--form-8k)";
  if (form.startsWith("DEF 14A")) return "var(--form-def14a)";
  return "var(--fg-2)";
}
