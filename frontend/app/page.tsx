"use client";

import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { CORE_WATCHLIST } from "../lib/watchlist";

// ─── Types ────────────────────────────────────────────────────────────────────

type Filing = {
  id: string;
  accession_number: string;
  cik: string;
  ticker: string;
  company_name: string;
  form_type: string;
  filed_at: string | null;
  filing_url: string | null;
  friday_dump: boolean;
  signals_flagged: boolean;
  period_of_report: string | null;
};

type View = "home" | "feed" | "company" | "flagged";

// ─── Utilities ────────────────────────────────────────────────────────────────

function elapsed(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const m  = Math.floor(ms / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1d ago" : `${d}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function formatPeriod(iso: string | null, formType?: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  const month = d.getUTCMonth();
  const year  = d.getUTCFullYear();
  if (formType === "10-K" || formType === "DEF 14A") return `FY ${year}`;
  const quarter = Math.floor(month / 3) + 1;
  return `Q${quarter} ${year}`;
}

const FORM_DESCRIPTIONS: Record<string, string> = {
  "10-K":    "Annual Report",
  "10-Q":    "Quarterly Report",
  "8-K":     "Material Event",
  "DEF 14A": "Proxy Statement",
};

function tickerHue(ticker: string): number {
  let h = 0;
  for (const c of ticker) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const FORM_COLORS: Record<string, string> = {
  "10-K":    "oklch(0.78 0.14 290)",
  "10-Q":    "oklch(0.78 0.14 220)",
  "8-K":     "oklch(0.80 0.15 60)",
  "DEF 14A": "oklch(0.74 0.14 160)",
};
function formColor(form: string): string {
  return FORM_COLORS[form] ?? "var(--fg-3)";
}

// Only allow http/https URLs in <a href>. Blocks javascript: and data: injection.
function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

// ─── Atoms ────────────────────────────────────────────────────────────────────

function FormBadge({ form }: { form: string }) {
  const c = formColor(form);
  return (
    <span style={{
      fontSize: 11, letterSpacing: "0.1em", padding: "3px 10px",
      border: `1px solid ${c}44`, color: c, background: `${c}14`,
      borderRadius: 100, whiteSpace: "nowrap", flexShrink: 0,
      fontWeight: 700,
    }}>
      {form}
    </span>
  );
}

function FlagChip({ label, tone }: { label: string; tone: "warn" | "alert" }) {
  const c = tone === "alert" ? "var(--alert)" : "var(--warn)";
  const border = tone === "alert" ? "#e8404044" : "#f0b03044";
  return (
    <span style={{
      fontSize: 11, padding: "4px 11px", borderRadius: 100, whiteSpace: "nowrap",
      background: tone === "alert" ? "var(--tint-alert)" : "var(--tint-warn)",
      border: `1px solid ${border}`,
      color: c,
      display: "inline-flex", alignItems: "center", gap: 6,
      letterSpacing: "0.06em", fontWeight: 600,
    }}>
      <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: c, display: "inline-block", flexShrink: 0 }} />
      {label}
    </span>
  );
}

function CompanyMark({ ticker, size = 36 }: { ticker: string; size?: number }) {
  const hue = tickerHue(ticker);
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: `linear-gradient(135deg, oklch(0.20 0.08 ${hue}), oklch(0.28 0.07 ${hue}))`,
      borderRadius: Math.round(size * 0.22),
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.31, fontWeight: 700,
      color: `oklch(0.82 0.14 ${hue})`,
      letterSpacing: "0.04em",
      boxShadow: `0 0 0 1px oklch(0.38 0.10 ${hue})55, inset 0 1px 0 oklch(0.55 0.10 ${hue})18, 0 2px 8px oklch(0.12 0.06 ${hue})80`,
      textShadow: `0 0 10px oklch(0.82 0.14 ${hue})35`,
    }}>
      {ticker.slice(0, 2)}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div style={{
      background: "var(--bg-2)", border: "1px solid var(--border-1)",
      borderRadius: 10, padding: "22px 26px",
      display: "flex", gap: 15, opacity: 0.55,
    }}>
      <div className="skeleton-shimmer" style={{ width: 42, height: 42, borderRadius: 9, flexShrink: 0 }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="skeleton-shimmer" style={{ height: 15, width: "38%", borderRadius: 4 }} />
        <div className="skeleton-shimmer" style={{ height: 13, width: "58%", borderRadius: 4 }} />
        <div className="skeleton-shimmer" style={{ height: 11, width: "28%", borderRadius: 4 }} />
      </div>
    </div>
  );
}

// ─── FilingCard ───────────────────────────────────────────────────────────────

function FilingCard({
  filing, onCompanyClick, index = 0,
}: {
  filing: Filing;
  onCompanyClick: (cik: string) => void;
  index?: number;
}) {
  const [copied, setCopied] = useState(false);
  const fileHref = safeHref(filing.filing_url);

  function copyAccession() {
    navigator.clipboard.writeText(filing.accession_number).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => { /* clipboard access denied — fail silently */ });
  }

  return (
    <div
      className={`filing-card anim-fade-up${filing.signals_flagged ? " card-flagged-stripe flagged" : ""}`}
      style={{
        position: "relative",
        background: "var(--bg-2)",
        border: `1px solid ${filing.signals_flagged ? "var(--alert)22" : "var(--border-1)"}`,
        borderRadius: 10,
        padding: "20px 24px",
        display: "flex", flexDirection: "column", gap: 12,
        animationDelay: `${index * 35}ms`,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <CompanyMark ticker={filing.ticker} size={42} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Row 1: company name + elapsed */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <button
              onClick={() => onCompanyClick(filing.cik)}
              style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                fontSize: 17, fontWeight: 700, color: "var(--fg-0)", fontFamily: "inherit",
                textAlign: "left", lineHeight: 1.3,
                transition: "color 0.14s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-0)"; }}
            >
              {filing.company_name}
            </button>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
              <span style={{ fontSize: 13, color: "var(--fg-3)", fontVariantNumeric: "tabular-nums" }}>
                {elapsed(filing.filed_at)}
              </span>
              <span style={{ fontSize: 11, color: "var(--fg-4)", fontVariantNumeric: "tabular-nums" }}>
                {fmtDate(filing.filed_at)}
              </span>
            </div>
          </div>

          {/* Row 2: ticker · badge · description + view link */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", minWidth: 0 }}>
              <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 700, letterSpacing: "0.04em" }}>{filing.ticker}</span>
              <span style={{ color: "var(--border-1)" }}>·</span>
              <FormBadge form={filing.form_type} />
              <span style={{ fontSize: 12, color: "var(--fg-4)", letterSpacing: "0.02em" }}>
                {FORM_DESCRIPTIONS[filing.form_type] ?? filing.form_type}
              </span>
            </div>
            {fileHref && (
              <a
                href={fileHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 12, color: "var(--fg-3)", textDecoration: "none",
                  flexShrink: 0, transition: "color 0.12s",
                  display: "inline-flex", alignItems: "center", gap: 3,
                  padding: "3px 8px", borderRadius: 5,
                  border: "1px solid transparent",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "var(--accent)33";
                  e.currentTarget.style.background = "var(--accent-08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--fg-3)";
                  e.currentTarget.style.borderColor = "transparent";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                View ↗
              </a>
            )}
          </div>

          {/* Row 3: period + accession (clickable copy) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {filing.period_of_report && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="label-caps">Period</span>
                <span style={{ fontSize: 12, color: "var(--fg-1)", fontWeight: 700 }}>
                  {formatPeriod(filing.period_of_report, filing.form_type)}
                </span>
                <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
                  ({fmtDate(filing.period_of_report)})
                </span>
              </div>
            )}
            {filing.period_of_report && filing.accession_number && (
              <span style={{ color: "var(--border-1)" }}>·</span>
            )}
            {filing.accession_number && (
              <button
                onClick={copyAccession}
                className={`copy-btn${copied ? " copied" : ""}`}
                title={copied ? "Copied!" : "Click to copy accession number"}
                style={{ fontSize: 11, color: copied ? "var(--pos)" : "var(--fg-4)" }}
              >
                {copied ? "copied ✓" : filing.accession_number}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Flag chips */}
      {(filing.friday_dump || filing.signals_flagged) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {filing.friday_dump     && <FlagChip label="Friday dump"      tone="warn"  />}
          {filing.signals_flagged && <FlagChip label="Signals detected" tone="alert" />}
        </div>
      )}
    </div>
  );
}

// ─── Quarterly 10-Q view ─────────────────────────────────────────────────────

function calcVelocityDays(periodEnd: string | null, filedAt: string | null): number | null {
  if (!periodEnd || !filedAt) return null;
  const days = Math.round(
    (new Date(filedAt).getTime() - new Date(periodEnd + "T00:00:00Z").getTime()) / 86_400_000,
  );
  return days >= 0 ? days : null;
}

function VelocityBadge({ days }: { days: number }) {
  const fast   = days <= 35;
  const late   = days > 45;
  const color  = fast ? "var(--pos)"  : late ? "var(--warn)" : "var(--fg-2)";
  const bg     = fast ? "#2ecc7114"  : late ? "#f0b03014"  : "var(--bg-3)";
  const border = fast ? "#2ecc7130"  : late ? "#f0b03030"  : "var(--border-1)";
  const label  = fast ? "Fast"       : late ? "Late"       : "On time";
  return (
    <span style={{
      fontSize: 12, padding: "3px 10px", borderRadius: 100,
      background: bg, border: `1px solid ${border}`, color,
      display: "inline-flex", alignItems: "center", gap: 5,
      fontWeight: 600,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, flexShrink: 0, display: "inline-block" }} />
      {days}d · {label}
    </span>
  );
}

const GUIDE_METRICS: { name: string; detail: string; impact: string; color: string }[] = [
  {
    name: "Revenue & EPS",
    detail: "Beat or miss vs. Wall Street consensus estimates. The single most watched number — a ±5% surprise routinely moves a stock 5–15% at open.",
    impact: "Critical", color: "var(--alert)",
  },
  {
    name: "Forward Guidance",
    detail: "Management's outlook for next quarter or full year. A guidance raise or cut typically has more long-term price impact than the reported quarter itself.",
    impact: "Critical", color: "var(--alert)",
  },
  {
    name: "Gross Margin",
    detail: "Revenue minus cost of goods sold, as a percentage. Expanding margins signal pricing power or cost efficiency; compression signals competitive pressure or rising input costs.",
    impact: "High", color: "oklch(0.78 0.14 220)",
  },
  {
    name: "MD&A Language",
    detail: "Management's Discussion & Analysis. Rising hedge words — 'uncertainty', 'headwinds', 'challenging environment' — signal softening confidence before the numbers deteriorate.",
    impact: "High", color: "oklch(0.78 0.14 220)",
  },
  {
    name: "Operating Cash Flow",
    detail: "Cash generated from core operations. Strong OCF relative to net income confirms earnings quality. A sustained gap between the two is a red flag for aggressive accounting.",
    impact: "Medium", color: "var(--fg-3)",
  },
  {
    name: "Risk Factor Updates",
    detail: "New or materially escalated risk disclosures. Fresh litigation, regulatory inquiry, or macro exposure added here signals that management is concerned enough to document it legally.",
    impact: "Medium", color: "var(--fg-3)",
  },
  {
    name: "One-time Items",
    detail: "Restructuring charges, asset impairments, or gains on disposals. Check whether these are excluded from non-GAAP figures in guidance — that is where accounting choices can obscure real trends.",
    impact: "Medium", color: "var(--fg-3)",
  },
];

const BULLISH_SIGNALS = [
  "EPS beats Wall Street estimate",
  "Revenue guidance raised",
  "Gross margin expanding",
  "Operating cash flow accelerating",
  "Share buyback announced or increased",
  "Debt reduced ahead of schedule",
];

const BEARISH_SIGNALS = [
  "EPS misses estimate",
  "Guidance lowered or withdrawn",
  "Gross margin compressing",
  "New material risk factor added",
  "Unexpected impairment or write-off",
  "Inventory or days-sales-outstanding rising",
];

function QuarterlyGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-1)", borderRadius: 8, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", background: "none", border: "none", cursor: "pointer",
          fontFamily: "inherit", transition: "background 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-1)" }}>How to read a 10-Q</span>
          <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--fg-4)", background: "var(--bg-3)", padding: "2px 7px", borderRadius: 3 }}>
            GUIDE
          </span>
        </div>
        <span style={{ fontSize: 18, color: "var(--fg-4)", lineHeight: 1, fontWeight: 300 }}>{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--border-1)", padding: "22px 20px", display: "flex", flexDirection: "column", gap: 24 }}>

          {/* Definition */}
          <div>
            <div className="label-caps" style={{ marginBottom: 10 }}>What is a 10-Q</div>
            <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.85, margin: 0 }}>
              A <strong style={{ color: "var(--fg-0)" }}>10-Q</strong> is a mandatory quarterly report filed with the SEC within{" "}
              <strong style={{ color: "var(--fg-0)" }}>40 days</strong> of each quarter end for large companies (45 days for smaller
              ones). It covers <strong style={{ color: "var(--fg-0)" }}>Q1, Q2, and Q3</strong> of each fiscal year — the fourth
              quarter is rolled into the annual <strong style={{ color: "var(--fg-0)" }}>10-K</strong>. Unlike the 10-K, the
              financial statements inside are <em>unaudited</em>, meaning restatements are possible. Companies must disclose any
              material changes in financial condition, operations, liquidity, and risk factors since the prior filing. Reading a
              10-Q before the market digests it gives you the same primary source the analysts are working from.
            </p>
          </div>

          {/* Key metrics table */}
          <div>
            <div className="label-caps" style={{ marginBottom: 12 }}>What to look for — and why it moves the stock</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0, border: "1px solid var(--border-1)", borderRadius: 6, overflow: "hidden" }}>
              {GUIDE_METRICS.map((m, i) => (
                <div
                  key={m.name}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 14, padding: "13px 16px",
                    background: i % 2 === 0 ? "var(--bg-1)" : "var(--bg-2)",
                    borderBottom: i < GUIDE_METRICS.length - 1 ? "1px solid var(--border-1)" : "none",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{m.name}</span>
                      <span style={{
                        fontSize: 10, padding: "2px 6px", borderRadius: 3, letterSpacing: "0.06em",
                        color: m.color, border: `1px solid ${m.color}44`, background: `${m.color}10`,
                      }}>
                        {m.impact}
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: "var(--fg-3)", margin: 0, lineHeight: 1.75 }}>{m.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Price signal grid */}
          <div>
            <div className="label-caps" style={{ marginBottom: 12 }}>Signals that move the stock price</div>
            <div className="two-col-grid">
              <div style={{ background: "var(--bg-1)", border: "1px solid #2ecc7120", borderRadius: 6, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: "var(--pos)", letterSpacing: "0.14em", fontWeight: 700, marginBottom: 12 }}>BULLISH</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {BULLISH_SIGNALS.map((s) => (
                    <div key={s} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--pos)", flexShrink: 0, marginTop: 5, display: "inline-block" }} />
                      <span style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: "var(--bg-1)", border: "1px solid var(--alert)20", borderRadius: 6, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: "var(--alert)", letterSpacing: "0.14em", fontWeight: 700, marginBottom: 12 }}>BEARISH</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {BEARISH_SIGNALS.map((s) => (
                    <div key={s} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--alert)", flexShrink: 0, marginTop: 5, display: "inline-block" }} />
                      <span style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Filing deadline note */}
          <div style={{
            background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 6,
            padding: "12px 16px", display: "flex", alignItems: "flex-start", gap: 10,
          }}>
            <span style={{ fontSize: 11, color: "var(--accent)", letterSpacing: "0.1em", fontWeight: 700, flexShrink: 0, paddingTop: 1 }}>NOTE</span>
            <p style={{ fontSize: 12, color: "var(--fg-3)", margin: 0, lineHeight: 1.7 }}>
              Large accelerated filers (market cap ≥ $700M — all companies in this watchlist) must file within{" "}
              <strong style={{ color: "var(--fg-1)" }}>40 days</strong>. Filing significantly earlier can signal strong quarters;
              filing very close to the deadline, or on a Friday after market close, sometimes precedes negative news.
              The <strong style={{ color: "var(--fg-1)" }}>filing velocity</strong> and{" "}
              <strong style={{ color: "var(--fg-1)" }}>Friday dump</strong> indicators on each card track exactly this.
            </p>
          </div>

        </div>
      )}
    </div>
  );
}

function QuarterlyView({ cik, filings }: { cik: string; filings: Filing[] }) {
  // Fetch the last 10 10-Qs from Supabase directly — the main `filings` state
  // only covers the current month, so older quarters would be missing from it.
  const [history, setHistory] = useState<Filing[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    setHistoryLoading(true);
    supabase
      .from("filings")
      .select("id,accession_number,cik,ticker,company_name,form_type,filed_at,filing_url,friday_dump,signals_flagged,period_of_report")
      .eq("cik", cik)
      .eq("form_type", "10-Q")
      .order("filed_at", { ascending: false })
      .limit(10)
      .then(
        ({ data }) => { setHistory((data as Filing[]) ?? []); setHistoryLoading(false); },
        ()         => { setHistory([]); setHistoryLoading(false); },
      );
  }, [cik]);

  // Merge: live Realtime inserts from the parent state take precedence over cached history.
  const quarters = useMemo(() => {
    const live = filings.filter((f) => f.cik === cik && f.form_type === "10-Q");
    const seen  = new Set<string>();
    const merged: Filing[] = [];
    for (const f of [...live, ...history]) {
      if (!seen.has(f.accession_number)) {
        seen.add(f.accession_number);
        merged.push(f);
      }
    }
    return merged
      .sort((a, b) =>
        (b.period_of_report ?? b.filed_at ?? "").localeCompare(
          a.period_of_report ?? a.filed_at ?? "",
        ),
      )
      .slice(0, 10);
  }, [history, filings, cik]);

  const velocities = useMemo(
    () => quarters.map((q) => calcVelocityDays(q.period_of_report, q.filed_at)),
    [quarters],
  );

  const avgVelocity = useMemo(() => {
    const valid = velocities.filter((v): v is number => v !== null);
    return valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
  }, [velocities]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <QuarterlyGuide />

      {historyLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : quarters.length === 0 ? (
        <div style={{
          padding: "52px 40px", textAlign: "center",
          border: "1px dashed var(--border-2)", borderRadius: 10,
          background: "var(--bg-1)",
        }}>
          <div style={{ fontSize: 28, color: "var(--fg-4)", marginBottom: 12, lineHeight: 1 }}>◎</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-2)", marginBottom: 8 }}>
            No 10-Q filings found
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-4)" }}>
            Run <code style={{ color: "var(--accent)" }}>python sec_scraper.py --backfill</code> to load recent quarterly reports.
          </div>
        </div>
      ) : (
        <>
          {/* Summary bar */}
          <div className="stats-bar">
            {[
              { label: "Quarters tracked", value: quarters.length },
              { label: "Signals detected", value: quarters.filter((q) => q.signals_flagged).length },
              { label: "Friday dumps",     value: quarters.filter((q) => q.friday_dump).length },
              { label: "Avg days to file", value: avgVelocity !== null ? `${avgVelocity}d` : "—" },
            ].map((s) => (
              <div key={s.label}>
                <div className="label-caps">{s.label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-0)", marginTop: 4, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>

          {/* Quarter cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {quarters.map((q, i) => {
              const vel       = velocities[i];
              const fast      = vel !== null && vel <= 35;
              const late      = vel !== null && vel > 45;
              const qHref     = safeHref(q.filing_url);
              const leftColor = q.signals_flagged ? "var(--alert)"
                : fast ? "#2ecc71"
                : late ? "var(--warn)"
                : "var(--accent)";

              return (
                <div
                  key={q.id}
                  style={{
                    background: "var(--bg-2)",
                    border: `1px solid ${q.signals_flagged ? "var(--alert)33" : "var(--border-1)"}`,
                    borderLeft: `3px solid ${leftColor}`,
                    borderRadius: 8, padding: "20px 24px",
                    display: "flex", flexDirection: "column", gap: 16,
                  }}
                >
                  {/* Header: quarter label + link */}
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>
                          {formatPeriod(q.period_of_report, "10-Q")}
                        </span>
                        <FormBadge form="10-Q" />
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {q.period_of_report && (
                          <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Period ending {fmtDate(q.period_of_report)}</span>
                        )}
                        {q.period_of_report && q.filed_at && <span style={{ color: "var(--border-2)" }}>·</span>}
                        {q.filed_at && (
                          <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Filed {fmtDate(q.filed_at)}</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                      <span style={{ fontSize: 13, color: "var(--fg-4)" }}>{elapsed(q.filed_at)}</span>
                      {qHref && (
                        <a
                          href={qHref} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
                          onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                        >
                          View 10-Q ↗
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Metrics grid */}
                  <div className="metrics-grid-3">
                    {[
                      {
                        label: "Filing velocity",
                        node: vel !== null ? <VelocityBadge days={vel} /> : <span style={{ fontSize: 12, color: "var(--fg-4)" }}>—</span>,
                      },
                      {
                        label: "Signals",
                        node: q.signals_flagged
                          ? <FlagChip label="Detected" tone="alert" />
                          : <span style={{ fontSize: 12, color: "var(--fg-4)" }}>None detected</span>,
                      },
                      {
                        label: "Timing",
                        node: q.friday_dump
                          ? <FlagChip label="Friday dump" tone="warn" />
                          : <span style={{ fontSize: 12, color: "var(--fg-4)" }}>Normal</span>,
                      },
                    ].map((m) => (
                      <div
                        key={m.label}
                      >
                        <div className="label-caps" style={{ marginBottom: 8 }}>{m.label}</div>
                        {m.node}
                      </div>
                    ))}
                  </div>

                  {q.accession_number && (
                    <span style={{ fontSize: 11, color: "var(--fg-4)", fontFamily: "monospace", letterSpacing: "0.02em" }}>
                      {q.accession_number}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Annual 10-K view ────────────────────────────────────────────────────────

const ANNUAL_GUIDE_METRICS: { name: string; detail: string; impact: string; color: string }[] = [
  {
    name: "Revenue & EPS vs Prior Year",
    detail: "Year-over-year growth rate. A slowdown from prior annual rates — even with positive growth — is often treated as a miss by the market.",
    impact: "Critical", color: "var(--alert)",
  },
  {
    name: "Annual Guidance / Outlook",
    detail: "Full-year outlook issued alongside the 10-K. Raised guidance moves stocks up; withdrawn or cut guidance often triggers larger drops than a single-quarter miss.",
    impact: "Critical", color: "var(--alert)",
  },
  {
    name: "Gross & Operating Margins",
    detail: "Full-year margin trends. Annual margins remove seasonal noise and reveal true structural shifts in pricing power or cost structure.",
    impact: "High", color: "oklch(0.78 0.14 220)",
  },
  {
    name: "Free Cash Flow",
    detail: "Operating cash flow minus capex. The cleanest measure of earnings quality — companies can manipulate GAAP net income but not sustained cash generation.",
    impact: "High", color: "oklch(0.78 0.14 220)",
  },
  {
    name: "Balance Sheet & Debt",
    detail: "Net debt position, debt-to-equity, and liquidity runway. Rising leverage during a revenue slowdown is a compounding risk flag.",
    impact: "Medium", color: "var(--fg-3)",
  },
  {
    name: "Risk Factor Changes",
    detail: "New or substantially rewritten risks vs. the prior year's 10-K. Material additions — new regulatory exposure, supply chain dependency, litigation — signal known threats management is now documenting.",
    impact: "Medium", color: "var(--fg-3)",
  },
  {
    name: "Auditor Opinion",
    detail: "Any qualification, emphasis of matter, or going-concern language is a serious flag. A 'clean' unqualified opinion is baseline; anything else requires immediate attention.",
    impact: "Medium", color: "var(--fg-3)",
  },
];

const ANNUAL_BULLISH = [
  "Revenue accelerating YoY",
  "Full-year guidance raised",
  "Operating margin expanding",
  "Free cash flow exceeding net income",
  "Debt reduced or refinanced at lower rate",
  "Clean unqualified auditor opinion",
];

const ANNUAL_BEARISH = [
  "Revenue growth decelerating",
  "Full-year guidance cut or withdrawn",
  "Margin compression (pricing or cost pressure)",
  "Goodwill impairment or asset write-down",
  "Auditor change or going-concern language",
  "New material litigation or regulatory risk",
];

function AnnualGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-1)", borderRadius: 8, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", transition: "background 0.12s" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-1)" }}>How to read a 10-K</span>
          <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--fg-4)", background: "var(--bg-3)", padding: "2px 7px", borderRadius: 3 }}>GUIDE</span>
        </div>
        <span style={{ fontSize: 18, color: "var(--fg-4)", lineHeight: 1, fontWeight: 300 }}>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--border-1)", padding: "22px 20px", display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div className="label-caps" style={{ marginBottom: 10 }}>What is a 10-K</div>
            <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.85, margin: 0 }}>
              A <strong style={{ color: "var(--fg-0)" }}>10-K</strong> is the mandatory annual report every public company files with the SEC within{" "}
              <strong style={{ color: "var(--fg-0)" }}>60 days</strong> of fiscal year end (large accelerated filers). Unlike the quarterly 10-Q, the financials inside are{" "}
              <strong style={{ color: "var(--fg-0)" }}>fully audited</strong> by an independent accounting firm. It is the most comprehensive and legally significant document a company produces —
              covering the full-year income statement, balance sheet, cash flow statement, MD&A, executive compensation, risk factors, and auditor opinion. It is the single document analysts use to set their annual price targets.
            </p>
          </div>
          <div>
            <div className="label-caps" style={{ marginBottom: 12 }}>What to look for — and why it moves the stock</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0, border: "1px solid var(--border-1)", borderRadius: 6, overflow: "hidden" }}>
              {ANNUAL_GUIDE_METRICS.map((m, i) => (
                <div key={m.name} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "13px 16px", background: i % 2 === 0 ? "var(--bg-1)" : "var(--bg-2)", borderBottom: i < ANNUAL_GUIDE_METRICS.length - 1 ? "1px solid var(--border-1)" : "none" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{m.name}</span>
                      <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, letterSpacing: "0.06em", color: m.color, border: `1px solid ${m.color}44`, background: `${m.color}10` }}>{m.impact}</span>
                    </div>
                    <p style={{ fontSize: 12, color: "var(--fg-3)", margin: 0, lineHeight: 1.75 }}>{m.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="label-caps" style={{ marginBottom: 12 }}>Signals that move the stock price</div>
            <div className="two-col-grid">
              <div style={{ background: "var(--bg-1)", border: "1px solid #2ecc7120", borderRadius: 6, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: "var(--pos)", letterSpacing: "0.14em", fontWeight: 700, marginBottom: 12 }}>BULLISH</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {ANNUAL_BULLISH.map((s) => (
                    <div key={s} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--pos)", flexShrink: 0, marginTop: 5, display: "inline-block" }} />
                      <span style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: "var(--bg-1)", border: "1px solid var(--alert)20", borderRadius: 6, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: "var(--alert)", letterSpacing: "0.14em", fontWeight: 700, marginBottom: 12 }}>BEARISH</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {ANNUAL_BEARISH.map((s) => (
                    <div key={s} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--alert)", flexShrink: 0, marginTop: 5, display: "inline-block" }} />
                      <span style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 6, padding: "12px 16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 11, color: "var(--accent)", letterSpacing: "0.1em", fontWeight: 700, flexShrink: 0, paddingTop: 1 }}>NOTE</span>
            <p style={{ fontSize: 12, color: "var(--fg-3)", margin: 0, lineHeight: 1.7 }}>
              Large accelerated filers must file within <strong style={{ color: "var(--fg-1)" }}>60 days</strong> of fiscal year end.
              Earnings calls typically precede the 10-K by 1–3 weeks — the 10-K confirms the call numbers with full audited detail
              and is where analysts look for discrepancies between what management said and what was formally reported.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function AnnualView({ cik, filings }: { cik: string; filings: Filing[] }) {
  const [history, setHistory]           = useState<Filing[]>([]);
  const [historyLoading, setHistLoading] = useState(true);

  useEffect(() => {
    setHistLoading(true);
    supabase
      .from("filings")
      .select("id,accession_number,cik,ticker,company_name,form_type,filed_at,filing_url,friday_dump,signals_flagged,period_of_report")
      .eq("cik", cik)
      .eq("form_type", "10-K")
      .order("filed_at", { ascending: false })
      .limit(2)
      .then(
        ({ data }) => { setHistory((data as Filing[]) ?? []); setHistLoading(false); },
        ()         => { setHistory([]); setHistLoading(false); },
      );
  }, [cik]);

  const annuals = useMemo(() => {
    const live = filings.filter((f) => f.cik === cik && f.form_type === "10-K");
    const seen  = new Set<string>();
    const merged: Filing[] = [];
    for (const f of [...live, ...history]) {
      if (!seen.has(f.accession_number)) { seen.add(f.accession_number); merged.push(f); }
    }
    return merged.sort((a, b) => (b.filed_at ?? "").localeCompare(a.filed_at ?? "")).slice(0, 2);
  }, [history, filings, cik]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <AnnualGuide />
      {historyLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Array.from({ length: 2 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : annuals.length === 0 ? (
        <div style={{ padding: "52px 40px", textAlign: "center", border: "1px dashed var(--border-2)", borderRadius: 10, background: "var(--bg-1)" }}>
          <div style={{ fontSize: 28, color: "var(--fg-4)", marginBottom: 12 }}>◎</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-2)", marginBottom: 8 }}>No annual reports found</div>
          <div style={{ fontSize: 13, color: "var(--fg-4)" }}>
            Run <code style={{ color: "var(--accent)" }}>python sec_scraper.py --backfill</code> to load annual reports.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {annuals.map((a) => {
            const vel       = calcVelocityDays(a.period_of_report, a.filed_at);
            const fast      = vel !== null && vel <= 55;
            const late      = vel !== null && vel > 70;
            const aHref     = safeHref(a.filing_url);
            const leftColor = a.signals_flagged ? "var(--alert)" : fast ? "#2ecc71" : late ? "var(--warn)" : "var(--accent)";
            return (
              <div key={a.id} style={{ background: "var(--bg-2)", border: `1px solid ${a.signals_flagged ? "var(--alert)33" : "var(--border-1)"}`, borderLeft: `3px solid ${leftColor}`, borderRadius: 8, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>
                        {formatPeriod(a.period_of_report, "10-K")}
                      </span>
                      <FormBadge form="10-K" />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {a.period_of_report && <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Period ending {fmtDate(a.period_of_report)}</span>}
                      {a.period_of_report && a.filed_at && <span style={{ color: "var(--border-2)" }}>·</span>}
                      {a.filed_at && <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Filed {fmtDate(a.filed_at)}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, color: "var(--fg-4)" }}>{elapsed(a.filed_at)}</span>
                    {aHref && (
                      <a href={aHref} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}>
                        View 10-K ↗
                      </a>
                    )}
                  </div>
                </div>
                <div className="metrics-grid-3">
                  {[
                    { label: "Filing velocity", node: vel !== null ? <VelocityBadge days={vel} /> : <span style={{ fontSize: 12, color: "var(--fg-4)" }}>—</span> },
                    { label: "Signals", node: a.signals_flagged ? <FlagChip label="Detected" tone="alert" /> : <span style={{ fontSize: 12, color: "var(--fg-4)" }}>None detected</span> },
                    { label: "Timing", node: a.friday_dump ? <FlagChip label="Friday dump" tone="warn" /> : <span style={{ fontSize: 12, color: "var(--fg-4)" }}>Normal timing</span> },
                  ].map((cell) => (
                    <div key={cell.label}>
                      <div className="label-caps" style={{ marginBottom: 8 }}>{cell.label}</div>
                      {cell.node}
                    </div>
                  ))}
                </div>
                {(a.friday_dump || a.signals_flagged) && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {a.friday_dump && <FlagChip label="Friday dump" tone="warn" />}
                    {a.signals_flagged && <FlagChip label="Signals detected" tone="alert" />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 8-K events view ──────────────────────────────────────────────────────────

const EVENT_TYPE_GUIDE: { item: string; label: string; impact: string; color: string; note: string }[] = [
  { item: "2.02", label: "Results of Operations (Earnings Release)", impact: "Critical", color: "var(--alert)", note: "Quarterly or annual earnings data. The single highest-volume trading event — price moves of 5–20% at open are common on surprise beats or misses." },
  { item: "2.01", label: "Acquisition or Disposition Completed", impact: "Critical", color: "var(--alert)", note: "Company acquired or sold a significant business. Acquisition premium pricing instantly reprices the acquirer; disposals free up capital." },
  { item: "5.01", label: "Change in Control",                         impact: "Critical", color: "var(--alert)", note: "Ownership change or merger in progress. Typically triggers a sharp rerating of both acquirer and target." },
  { item: "4.02", label: "Non-Reliance on Prior Financials",          impact: "Critical", color: "var(--alert)", note: "Company is restating previously issued financials. Severe negative signal — implies accounting error or fraud investigation." },
  { item: "1.01", label: "Material Definitive Agreement",             impact: "High",     color: "oklch(0.78 0.14 220)", note: "Major contract, licensing deal, or partnership signed. Impact depends on deal size relative to revenue." },
  { item: "1.02", label: "Termination of Material Agreement",         impact: "High",     color: "oklch(0.78 0.14 220)", note: "A previously material contract ended. Loss of a major customer or partner is a direct revenue risk." },
  { item: "5.02", label: "Executive Departure or Appointment",        impact: "High",     color: "oklch(0.78 0.14 220)", note: "CEO or CFO changes in particular move stocks. Sudden unexplained departures are more bearish than planned transitions." },
  { item: "4.01", label: "Change in Certifying Accountant",           impact: "High",     color: "oklch(0.78 0.14 220)", note: "Auditor switch mid-year is a yellow flag. Check whether the auditor resigned or was dismissed and why." },
  { item: "3.01", label: "Notice of Delisting",                       impact: "Critical", color: "var(--alert)", note: "Exchange notified company it does not meet listing standards. Delisting risk materially compresses valuation multiples." },
  { item: "7.01", label: "Regulation FD Disclosure",                  impact: "Medium",   color: "var(--fg-3)", note: "Material non-public information shared at an investor day or conference, now made public. Often a guidance update or strategic announcement." },
];

function EventsGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-1)", borderRadius: 8, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", transition: "background 0.12s" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-1)" }}>How to read an 8-K</span>
          <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--fg-4)", background: "var(--bg-3)", padding: "2px 7px", borderRadius: 3 }}>GUIDE</span>
        </div>
        <span style={{ fontSize: 18, color: "var(--fg-4)", lineHeight: 1, fontWeight: 300 }}>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--border-1)", padding: "22px 20px", display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div className="label-caps" style={{ marginBottom: 10 }}>What is an 8-K</div>
            <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.85, margin: 0 }}>
              An <strong style={{ color: "var(--fg-0)" }}>8-K</strong> is a current report filed within{" "}
              <strong style={{ color: "var(--fg-0)" }}>4 business days</strong> of any material event that shareholders need to know about.
              Unlike the 10-K or 10-Q which cover scheduled periods, 8-Ks are{" "}
              <strong style={{ color: "var(--fg-0)" }}>event-driven</strong> — each one is a distinct disclosure triggered by something that just happened.
              The content is identified by item numbers (e.g. Item 2.02 = earnings, Item 5.02 = executive change). The item number is the first thing
              to check — it tells you immediately whether the filing is price-moving or routine.
            </p>
          </div>
          <div>
            <div className="label-caps" style={{ marginBottom: 12 }}>Item types and their price impact</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0, border: "1px solid var(--border-1)", borderRadius: 6, overflow: "hidden" }}>
              {EVENT_TYPE_GUIDE.map((e, i) => (
                <div key={e.item} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "13px 16px", background: i % 2 === 0 ? "var(--bg-1)" : "var(--bg-2)", borderBottom: i < EVENT_TYPE_GUIDE.length - 1 ? "1px solid var(--border-1)" : "none" }}>
                  <div style={{ flexShrink: 0, width: 36, paddingTop: 2 }}>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--fg-4)", letterSpacing: "0.04em" }}>{e.item}</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{e.label}</span>
                      <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, letterSpacing: "0.06em", color: e.color, border: `1px solid ${e.color}44`, background: `${e.color}10` }}>{e.impact}</span>
                    </div>
                    <p style={{ fontSize: 12, color: "var(--fg-3)", margin: 0, lineHeight: 1.75 }}>{e.note}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 6, padding: "12px 16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 11, color: "var(--accent)", letterSpacing: "0.1em", fontWeight: 700, flexShrink: 0, paddingTop: 1 }}>NOTE</span>
            <p style={{ fontSize: 12, color: "var(--fg-3)", margin: 0, lineHeight: 1.7 }}>
              A single 8-K can cover multiple items (e.g. an earnings release filed with an executive appointment). Always read all items in the filing.
              High-frequency 8-K filers — 3 or more in 30 days — trigger the <strong style={{ color: "var(--fg-1)" }}>8-K Burst</strong> signal in this pipeline, which indicates elevated corporate activity worth monitoring.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function EventsView({ cik, filings }: { cik: string; filings: Filing[] }) {
  const [history, setHistory]           = useState<Filing[]>([]);
  const [historyLoading, setHistLoading] = useState(true);

  useEffect(() => {
    setHistLoading(true);
    supabase
      .from("filings")
      .select("id,accession_number,cik,ticker,company_name,form_type,filed_at,filing_url,friday_dump,signals_flagged,period_of_report")
      .eq("cik", cik)
      .eq("form_type", "8-K")
      .order("filed_at", { ascending: false })
      .limit(10)
      .then(
        ({ data }) => { setHistory((data as Filing[]) ?? []); setHistLoading(false); },
        ()         => { setHistory([]); setHistLoading(false); },
      );
  }, [cik]);

  const events = useMemo(() => {
    const live = filings.filter((f) => f.cik === cik && f.form_type === "8-K");
    const seen  = new Set<string>();
    const merged: Filing[] = [];
    for (const f of [...live, ...history]) {
      if (!seen.has(f.accession_number)) { seen.add(f.accession_number); merged.push(f); }
    }
    return merged.sort((a, b) => (b.filed_at ?? "").localeCompare(a.filed_at ?? "")).slice(0, 10);
  }, [history, filings, cik]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <EventsGuide />
      {historyLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : events.length === 0 ? (
        <div style={{ padding: "52px 40px", textAlign: "center", border: "1px dashed var(--border-2)", borderRadius: 10, background: "var(--bg-1)" }}>
          <div style={{ fontSize: 28, color: "var(--fg-4)", marginBottom: 12 }}>◎</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-2)", marginBottom: 8 }}>No 8-K events found</div>
          <div style={{ fontSize: 13, color: "var(--fg-4)" }}>
            Run <code style={{ color: "var(--accent)" }}>python sec_scraper.py --backfill</code> to load material events.
          </div>
        </div>
      ) : (
        <>
          <div className="stats-bar">
            {[
              { label: "Events tracked",    value: events.length },
              { label: "Signals detected",  value: events.filter((e) => e.signals_flagged).length },
              { label: "Friday dumps",      value: events.filter((e) => e.friday_dump).length },
            ].map((s) => (
              <div key={s.label}>
                <div className="label-caps">{s.label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-0)", marginTop: 4, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{s.value}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {events.map((ev) => {
              const evHref = safeHref(ev.filing_url);
              return (
                <div key={ev.id} style={{ background: "var(--bg-2)", border: `1px solid ${ev.signals_flagged ? "var(--alert)33" : "var(--border-1)"}`, borderLeft: `3px solid ${ev.signals_flagged ? "var(--alert)" : ev.friday_dump ? "var(--warn)" : "oklch(0.80 0.15 60)"}`, borderRadius: 8, padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <FormBadge form="8-K" />
                        {ev.signals_flagged && <FlagChip label="Signals detected" tone="alert" />}
                        {ev.friday_dump     && <FlagChip label="Friday dump"      tone="warn"  />}
                      </div>
                      <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Filed {fmtDate(ev.filed_at)}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                      <span style={{ fontSize: 13, color: "var(--fg-4)" }}>{elapsed(ev.filed_at)}</span>
                      {evHref && (
                        <a href={evHref} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
                          onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}>
                          View 8-K ↗
                        </a>
                      )}
                    </div>
                  </div>
                  {ev.accession_number && (
                    <span style={{ fontSize: 11, color: "var(--fg-4)", fontFamily: "monospace" }}>{ev.accession_number}</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Company detail ───────────────────────────────────────────────────────────

function CompanyFilingsView({
  cik, filings, onBack,
}: {
  cik: string; filings: Filing[]; onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"quarterly" | "annual" | "events" | "all">("quarterly");

  const all = useMemo(
    () => filings
      .filter((f) => f.cik === cik)
      .sort((a, b) => (b.filed_at ?? "").localeCompare(a.filed_at ?? "")),
    [filings, cik],
  );

  const meta = all[0];
  if (!meta) {
    return (
      <div style={{ color: "var(--fg-4)", padding: "40px 0", textAlign: "center" }}>
        No filings found for this company.
      </div>
    );
  }

  const formCounts = all.reduce<Record<string, number>>((acc, f) => {
    acc[f.form_type] = (acc[f.form_type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <button
        onClick={onBack}
        style={{
          background: "var(--bg-2)", border: "1px solid var(--border-1)",
          padding: "7px 14px", borderRadius: 6, cursor: "pointer",
          color: "var(--fg-3)", fontSize: 13, fontFamily: "inherit",
          display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start",
          transition: "color 0.12s, border-color 0.12s, background 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--fg-1)";
          e.currentTarget.style.borderColor = "var(--border-2)";
          e.currentTarget.style.background = "var(--bg-3)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--fg-3)";
          e.currentTarget.style.borderColor = "var(--border-1)";
          e.currentTarget.style.background = "var(--bg-2)";
        }}
      >
        ← Back
      </button>

      {/* Company header */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap",
        padding: "20px 24px",
        background: "var(--bg-2)", border: "1px solid var(--border-1)",
        borderRadius: 12,
      }}>
        <CompanyMark ticker={meta.ticker} size={60} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-0)", margin: "0 0 8px", letterSpacing: "-0.02em" }}>
            {meta.company_name}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{
              fontSize: 13, color: "var(--accent)", fontWeight: 700,
              background: "var(--accent-12)", border: "1px solid var(--accent-20)",
              borderRadius: 100, padding: "2px 10px", letterSpacing: "0.06em",
            }}>{meta.ticker}</span>
            <span className="caption" style={{ fontSize: 11, color: "var(--fg-4)", fontFamily: "monospace" }}>CIK {meta.cik}</span>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="stats-bar">
        {[
          { label: "Filings",      value: all.length },
          { label: "Flagged",      value: all.filter((f) => f.signals_flagged).length },
          { label: "Friday Dumps", value: all.filter((f) => f.friday_dump).length },
        ].map((s) => (
          <div key={s.label}>
            <div className="label-caps">{s.label}</div>
            <div className="metric-val" style={{ marginTop: 4 }}>{s.value}</div>
          </div>
        ))}
        <div style={{ flex: 2 }}>
          <div className="label-caps" style={{ marginBottom: 8 }}>Form types</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {Object.entries(formCounts).map(([form, cnt]) => (
              <span key={form} style={{ fontSize: 12, color: formColor(form), fontWeight: 600 }}>
                {form} <span style={{ opacity: 0.6, fontWeight: 400 }}>× {cnt}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-pills">
        {([
          { key: "quarterly", label: "10-Q Reports",  formType: "10-Q"  },
          { key: "annual",    label: "Annual (10-K)", formType: "10-K"  },
          { key: "events",    label: "Events (8-K)",  formType: "8-K"   },
          { key: "all",       label: "All Filings",   formType: null    },
        ] as const).map(({ key, label, formType }) => {
          const count    = formType ? all.filter((f) => f.form_type === formType).length : all.length;
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`tab-pill${isActive ? " active" : ""}`}
            >
              {label}
              {count > 0 && (
                <span style={{
                  fontSize: 12, padding: "2px 7px", borderRadius: 4,
                  fontVariantNumeric: "tabular-nums",
                  background: isActive ? "var(--accent-20)" : "var(--bg-4, #253050)",
                  color: isActive ? "var(--accent)" : "var(--fg-3)",
                }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "quarterly" ? (
        <QuarterlyView cik={cik} filings={filings} />
      ) : activeTab === "annual" ? (
        <AnnualView cik={cik} filings={filings} />
      ) : activeTab === "events" ? (
        <EventsView cik={cik} filings={filings} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <div style={{ fontSize: 13, color: "var(--fg-3)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 20 }}>
            Filing history · {all.length} entries
          </div>
          {all.map((f, i) => (
            <div key={f.id} style={{ display: "flex", gap: 14, paddingBottom: i < all.length - 1 ? 20 : 0 }}>
              <div style={{
                width: 80, flexShrink: 0,
                display: "flex", flexDirection: "column", alignItems: "flex-end",
                paddingTop: 10, gap: 2,
              }}>
                <span style={{ fontSize: 14, color: "var(--fg-3)" }}>{fmtDate(f.filed_at).replace(/, \d{4}$/, "")}</span>
                <span className="caption">{new Date(f.filed_at ?? "").getFullYear()}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: "50%", marginTop: 13, flexShrink: 0,
                  background: f.signals_flagged ? "var(--alert)" : f.friday_dump ? "var(--warn)" : "var(--border-2)",
                }} />
                {i < all.length - 1 && (
                  <div style={{ width: 1, flex: 1, minHeight: 16, background: "var(--border-1)", marginTop: 3 }} />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <FilingCard filing={f} onCompanyClick={() => {}} index={i} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Feed view ────────────────────────────────────────────────────────────────

const FEED_FORM_TYPES = ["10-K", "10-Q", "8-K", "DEF 14A"] as const;

function FeedView({
  filings, loading, onCompanyClick,
}: {
  filings: Filing[]; loading: boolean; onCompanyClick: (cik: string) => void;
}) {
  const [search, setSearch]           = useState("");
  const [activeTypes, setActiveTypes] = useState<string[]>([]);

  function toggleType(t: string) {
    setActiveTypes((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
  }

  const typeCounts = useMemo(() =>
    FEED_FORM_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = filings.filter((f) => f.form_type === t).length;
      return acc;
    }, {}),
  [filings]);

  const { displayed, uniqueCompanies } = useMemo(() => {
    let r = filings;
    if (activeTypes.length > 0) r = r.filter((f) => activeTypes.includes(f.form_type));
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((f) =>
        f.company_name.toLowerCase().includes(q) || f.ticker.toLowerCase().includes(q),
      );
    }
    return { displayed: r, uniqueCompanies: new Set(r.map((f) => f.cik)).size };
  }, [filings, search, activeTypes]);

  const isFiltered = activeTypes.length > 0 || search.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-0)", margin: 0, letterSpacing: "-0.02em" }}>
            Recent Filings
          </h1>
          <span className="live-badge">
            <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
            LIVE
          </span>
        </div>
        {!loading && filings.length > 0 && (
          <div className="stats-bar">
            {FEED_FORM_TYPES.map((t) => typeCounts[t] > 0 && (
              <div key={t} style={{
                flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 4,
              }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: formColor(t), fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                  {typeCounts[t]}
                </div>
                <div className="label-caps">{t}</div>
              </div>
            ))}
            <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-1)", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                {uniqueCompanies}
              </div>
              <div className="label-caps">Companies</div>
            </div>
          </div>
        )}
      </div>

      {/* Filter bar */}
      {!loading && filings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="search-input-wrap">
            <input
              className="search-input"
              placeholder="Search company or ticker…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {FEED_FORM_TYPES.map((t) => (
              <button
                key={t}
                className={`filter-chip${activeTypes.includes(t) ? " active" : ""}`}
                onClick={() => toggleType(t)}
              >
                {t}
                {typeCounts[t] > 0 && <span style={{ marginLeft: 5, opacity: 0.5 }}>{typeCounts[t]}</span>}
              </button>
            ))}
            {isFiltered && (
              <button
                className="filter-chip"
                onClick={() => { setActiveTypes([]); setSearch(""); }}
                style={{ color: "var(--alert)", borderColor: "var(--alert)33" }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Card list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
          : displayed.length === 0
          ? (
            <div style={{ padding: "52px 0", textAlign: "center", color: "var(--fg-4)", fontSize: 13 }}>
              {filings.length === 0
                ? "No filings yet — run the scraper to populate data."
                : "No filings match the current filters."}
            </div>
          )
          : displayed.map((f, i) => (
            <FilingCard key={f.id} filing={f} onCompanyClick={onCompanyClick} index={i} />
          ))
        }
      </div>
    </div>
  );
}

// ─── Company list view ────────────────────────────────────────────────────────

function CompanyListView({
  filings, onCompanyClick,
}: {
  filings: Filing[]; onCompanyClick: (cik: string) => void;
}) {
  const companies = useMemo(() => {
    const map = new Map<string, { ticker: string; name: string; filings: Filing[] }>();
    for (const f of filings) {
      const entry = map.get(f.cik) ?? { ticker: f.ticker, name: f.company_name, filings: [] };
      entry.filings.push(f);
      map.set(f.cik, entry);
    }
    return Array.from(map.entries())
      .map(([cik, v]) => {
        const sorted = [...v.filings].sort((a, b) => (b.filed_at ?? "").localeCompare(a.filed_at ?? ""));
        return { cik, ticker: v.ticker, name: v.name, latest: sorted[0], count: sorted.length };
      })
      .sort((a, b) => (b.latest.filed_at ?? "").localeCompare(a.latest.filed_at ?? ""));
  }, [filings]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-0)", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
          Watchlist
        </h1>
        <p style={{ fontSize: 14, color: "var(--fg-3)", margin: 0 }}>
          {companies.length} companies · click to view filing history
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {companies.map((c) => (
          <button
            key={c.cik}
            onClick={() => onCompanyClick(c.cik)}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              background: "var(--bg-2)", border: "1px solid var(--border-1)",
              borderRadius: 10, padding: "18px 22px",
              cursor: "pointer", fontFamily: "inherit", textAlign: "left",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.15s",
              width: "100%",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--border-2)";
              e.currentTarget.style.background  = "var(--bg-3)";
              e.currentTarget.style.boxShadow   = "var(--shadow-sm)";
              e.currentTarget.style.transform   = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border-1)";
              e.currentTarget.style.background  = "var(--bg-2)";
              e.currentTarget.style.boxShadow   = "none";
              e.currentTarget.style.transform   = "none";
            }}
          >
            <CompanyMark ticker={c.ticker} size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
                <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-0)" }}>{c.name}</span>
                <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>{c.ticker}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span className="caption">{c.count} filings</span>
                <span className="caption">·</span>
                <span className="caption">{elapsed(c.latest.filed_at)}</span>
                <span className="caption">·</span>
                <FormBadge form={c.latest.form_type} />
              </div>
            </div>
            <span style={{ fontSize: 18, color: "var(--fg-3)", flexShrink: 0 }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Flagged view ─────────────────────────────────────────────────────────────

function FlaggedView({
  filings, onCompanyClick,
}: {
  filings: Filing[]; onCompanyClick: (cik: string) => void;
}) {
  const flagged = useMemo(
    () => filings
      .filter((f) => f.signals_flagged || f.friday_dump)
      .sort((a, b) => (b.filed_at ?? "").localeCompare(a.filed_at ?? "")),
    [filings],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-0)", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
          Flagged Filings
        </h1>
        <p style={{ fontSize: 14, color: "var(--fg-3)", margin: 0, maxWidth: 520 }}>
          Friday after-hours dumps, burst patterns, and algorithm flags.
        </p>
      </div>
      {flagged.length === 0 ? (
        <div style={{
          padding: "56px 40px", textAlign: "center",
          border: "1px dashed var(--border-2)", borderRadius: 10,
          background: "var(--bg-1)",
        }}>
          <div style={{ fontSize: 30, marginBottom: 14, color: "var(--fg-4)", lineHeight: 1 }}>◎</div>
          <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-2)", marginBottom: 10 }}>No flagged filings yet</div>
          <div style={{ fontSize: 14, color: "var(--fg-4)", lineHeight: 1.8, maxWidth: 380, margin: "0 auto" }}>
            Signal extraction runs automatically when the pipeline processes new filings.
            Wire up <code style={{ color: "var(--accent)" }}>signal_extractor.py</code> to activate scoring.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {flagged.map((f, i) => (
            <FilingCard key={f.id} filing={f} onCompanyClick={onCompanyClick} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Filings tabs ─────────────────────────────────────────────────────────────

function FilingsTabs({
  active, onNavigate, counts,
}: {
  active: Exclude<View, "home">;
  onNavigate: (hash: string) => void;
  counts?: { feed: number; company: number; flagged: number };
}) {
  const tabs = [
    { label: "Feed",      hash: "feed"    as const, count: counts?.feed },
    { label: "Companies", hash: "company" as const, count: counts?.company },
    { label: "Flagged",   hash: "flagged" as const, count: counts?.flagged },
  ];
  return (
    <div className="tab-pills">
      {tabs.map((t) => {
        const isActive = active === t.hash;
        return (
          <button
            key={t.hash}
            onClick={() => onNavigate(t.hash)}
            className={`tab-pill${isActive ? " active" : ""}`}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span style={{
                fontSize: 12, padding: "2px 7px", borderRadius: 4,
                fontVariantNumeric: "tabular-nums",
                background: isActive ? "var(--accent-20)" : "var(--bg-4, #253050)",
                color: isActive ? "var(--accent)" : "var(--fg-3)",
              }}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({
  filings, activeView, activeCik, onNavigate, mobileOpen, onMobileClose,
}: {
  filings: Filing[];
  activeView: Exclude<View, "home">;
  activeCik: string | null;
  onNavigate: (hash: string) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const [companySearch, setCompanySearch] = useState("");

  const companies = useMemo(() => {
    const map = new Map<string, { ticker: string; name: string; latest: Filing; count: number; hasFlagged: boolean }>();
    for (const f of [...filings].sort((a, b) => (b.filed_at ?? "").localeCompare(a.filed_at ?? ""))) {
      const entry = map.get(f.cik);
      if (!entry) {
        map.set(f.cik, { ticker: f.ticker, name: f.company_name, latest: f, count: 1, hasFlagged: f.signals_flagged || f.friday_dump });
      } else {
        entry.count++;
        if (f.signals_flagged || f.friday_dump) entry.hasFlagged = true;
      }
    }
    return Array.from(map.entries()).map(([cik, v]) => ({ cik, ...v }));
  }, [filings]);

  const visibleCompanies = useMemo(() =>
    companySearch.trim()
      ? companies.filter((c) =>
          c.ticker.toLowerCase().includes(companySearch.toLowerCase()) ||
          c.name.toLowerCase().includes(companySearch.toLowerCase()),
        )
      : companies,
  [companies, companySearch]);

  const navItems = [
    { label: "Filings", hash: "feed",    group: ["feed", "company", "flagged"], disabled: false },
    { label: "Search",  hash: "search",  group: ["search"],                     disabled: true  },
    { label: "Signals", hash: "signals", group: ["signals"],                    disabled: true  },
  ];

  return (
    <aside className={`sidebar${mobileOpen ? " mobile-open" : ""}`}>
      {/* Brand */}
      <div style={{ padding: "18px 16px 14px", borderBottom: "1px solid var(--border-1)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => onNavigate("home")}
          style={{
            background: "none", border: "none", padding: 0,
            cursor: "pointer", fontFamily: "inherit", flex: 1, minWidth: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "0.24em", color: "var(--fg-0)" }}>
              SUMMA
            </div>
            <span className="live-badge">
              <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
              LIVE
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.1em" }}>
            SEC Filing Intelligence
          </div>
        </button>
        <button
          onClick={onMobileClose}
          className="sidebar-close-btn"
          aria-label="Close menu"
          style={{ fontFamily: "inherit" }}
        >
          ✕
        </button>
      </div>

      {/* Nav */}
      <div style={{ padding: "6px 0", borderBottom: "1px solid var(--border-1)", flexShrink: 0 }}>
        {navItems.map((item) => {
          const active = !item.disabled && activeCik === null && (item.group as string[]).includes(activeView);
          return (
            <button
              key={item.hash}
              onClick={item.disabled ? undefined : () => onNavigate(item.hash)}
              style={{
                width: "100%", textAlign: "left", padding: "11px 18px",
                background: active ? "linear-gradient(90deg, var(--accent-12) 0%, var(--accent-08) 100%)" : "transparent",
                border: "none",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--fg-0)" : item.disabled ? "var(--fg-4)" : "var(--fg-2)",
                fontSize: 15,
                fontWeight: active ? 600 : 400,
                cursor: item.disabled ? "default" : "pointer",
                fontFamily: "inherit",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                transition: "color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => {
                if (!active && !item.disabled) {
                  e.currentTarget.style.color = "var(--fg-1)";
                  e.currentTarget.style.background = "rgba(255,255,255,0.025)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active && !item.disabled) {
                  e.currentTarget.style.color = "var(--fg-2)";
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              {item.label}
              {item.disabled && (
                <span style={{
                  fontSize: 10, letterSpacing: "0.12em", color: "var(--fg-4)",
                  background: "var(--bg-3)", padding: "2px 6px", borderRadius: 3,
                }}>
                  SOON
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Company list */}
      <div style={{ padding: "14px 20px 8px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: "var(--fg-3)", letterSpacing: "0.12em", textTransform: "uppercase" }}>Companies</span>
        <span className="caption">{companies.length}</span>
      </div>
      {companies.length > 0 && (
        <div style={{ padding: "0 12px 10px", flexShrink: 0 }}>
          <input
            className="sidebar-search"
            placeholder="Filter…"
            value={companySearch}
            onChange={(e) => setCompanySearch(e.target.value)}
          />
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {visibleCompanies.map((c) => {
          const active = activeCik === c.cik;
          return (
            <button
              key={c.cik}
              onClick={() => onNavigate(`c=${c.cik}`)}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                width: "100%", textAlign: "left", padding: "10px 14px 10px 16px",
                background: active ? "linear-gradient(90deg, var(--accent-12) 0%, var(--accent-08) 100%)" : "transparent",
                border: "none",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                cursor: "pointer", fontFamily: "inherit",
                transition: "background 0.15s, border-color 0.15s, transform 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.background = "rgba(79,212,194,0.03)";
                  e.currentTarget.style.borderLeftColor = "var(--accent)33";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderLeftColor = "transparent";
                }
              }}
            >
              <CompanyMark ticker={c.ticker} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                  <span style={{
                    fontSize: 13, fontWeight: active ? 600 : 500,
                    color: active ? "var(--fg-0)" : "var(--fg-1)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {c.name}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                    {c.hasFlagged && (
                      <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--alert)", display: "inline-block" }} />
                    )}
                    <span style={{
                      fontSize: 11, padding: "1px 6px", borderRadius: 100,
                      background: active ? "var(--accent-20)" : "var(--bg-3)",
                      color: active ? "var(--accent)" : "var(--fg-4)",
                      fontVariantNumeric: "tabular-nums",
                    }}>
                      {c.count}
                    </span>
                  </div>
                </div>
                <span style={{ fontSize: 11, color: active ? "var(--accent)99" : "var(--fg-4)", letterSpacing: "0.06em" }}>{c.ticker}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border-1)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--pos)", display: "inline-block", flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.04em" }}>EDGAR connected</span>
          </div>
          <span style={{ fontSize: 11, color: "var(--fg-4)", fontVariantNumeric: "tabular-nums" }}>{filings.length} filings</span>
        </div>
      </div>
    </aside>
  );
}

// ─── useCountUp ───────────────────────────────────────────────────────────────

function useCountUp(target: number, delayMs = 0): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (target === 0) { setVal(0); return; }
    let rafId = 0;
    let alive = true;
    const t = setTimeout(() => {
      const start = performance.now();
      const duration = 900;
      const tick = () => {
        if (!alive) return;
        const p = Math.min((performance.now() - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        setVal(Math.round(eased * target));
        if (p < 1) rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }, delayMs);
    return () => {
      alive = false;
      clearTimeout(t);
      cancelAnimationFrame(rafId);
    };
  }, [target, delayMs]);
  return val;
}

// ─── Home page ────────────────────────────────────────────────────────────────

function HomeView({
  filings, onNavigate,
}: {
  filings: Filing[]; onNavigate: (hash: string) => void;
}) {
  const { totalCompanies, flaggedCount } = useMemo(() => ({
    totalCompanies: new Set(filings.map((f) => f.cik)).size,
    flaggedCount: filings.filter((f) => f.signals_flagged || f.friday_dump).length,
  }), [filings]);

  const countCompanies = useCountUp(totalCompanies, 500);
  const countFilings   = useCountUp(filings.length,  560);
  const countFlagged   = useCountUp(flaggedCount,     620);

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: "60px 32px",
      position: "relative", zIndex: 1,
    }}>
      <div className="scan-line" />

      {/* Status pill */}
      <div
        className="status-line"
        style={{ marginBottom: 56, display: "flex", alignItems: "center", gap: 8 }}
      >
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "6px 16px", borderRadius: 100,
          background: "var(--bg-2)", border: "1px solid var(--border-1)",
          fontSize: 13, color: "var(--fg-3)",
        }}>
          <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>Live</span>
          <span style={{ color: "var(--border-2)" }}>·</span>
          <span>{filings.length} filings indexed</span>
          <span style={{ color: "var(--border-2)" }}>·</span>
          <span>{totalCompanies} companies</span>
        </span>
      </div>

      {/* Brand */}
      <div className="anim-slide-up" style={{ textAlign: "center", marginBottom: 48, animationDelay: "60ms" }}>
        <div style={{ fontSize: 76, fontWeight: 800, letterSpacing: "0.22em", marginBottom: 20, lineHeight: 1, position: "relative", display: "inline-block" }}>
          <span className="accent-glow" style={{ color: "var(--accent)" }}>S</span>
          <span style={{ color: "var(--fg-0)" }}>UMMA</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 20 }}>
          <span style={{ width: 32, height: 1, background: "linear-gradient(90deg, transparent, var(--border-2))", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.28em", textTransform: "uppercase" }}>
            SEC Filing Intelligence
          </span>
          <span className="blink-cursor" style={{ color: "var(--accent)", fontWeight: 700, fontSize: 13 }}>_</span>
          <span style={{ width: 32, height: 1, background: "linear-gradient(90deg, var(--border-2), transparent)", display: "inline-block" }} />
        </div>
        <p style={{ fontSize: 15, color: "var(--fg-3)", margin: "0 auto", maxWidth: 440, lineHeight: 2 }}>
          Automated signal detection for EDGAR filings.<br />
          10-K · 10-Q · 8-K · DEF&nbsp;14A — monitored every 10&nbsp;minutes.
        </p>
      </div>

      {/* Enter button */}
      <div className="anim-slide-up" style={{ marginBottom: 56, animationDelay: "160ms" }}>
        <button
          onClick={() => onNavigate("feed")}
          className="nav-card"
          style={{
            background: "var(--bg-2)", border: "1px solid var(--border-2)",
            borderRadius: 14, padding: "18px 56px",
            cursor: "pointer", fontFamily: "inherit",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
            position: "relative", overflow: "hidden",
          }}
        >
          <span style={{ fontSize: 16, color: "var(--accent)", letterSpacing: "0.08em", fontWeight: 700 }}>
            Open live feed →
          </span>
          <span style={{ fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.06em" }}>
            press <span className="kbd">F</span> to jump in
          </span>
        </button>
      </div>

      {/* Stats */}
      <div
        className="anim-slide-up"
        style={{ display: "flex", gap: 12, animationDelay: "280ms", flexWrap: "wrap", justifyContent: "center" }}
      >
        {[
          { label: "Companies",       value: countCompanies, color: "var(--accent)",  glow: "#4fd4c232" },
          { label: "Filings indexed", value: countFilings,   color: "var(--fg-0)",    glow: undefined   },
          { label: "Signals flagged", value: countFlagged,   color: "var(--alert)",   glow: "#e8404030" },
        ].map((s) => (
          <div key={s.label} className="hero-stat">
            <div style={{
              fontSize: 48, fontWeight: 700, color: s.color,
              fontVariantNumeric: "tabular-nums", lineHeight: 1,
              textShadow: s.glow ? `0 0 28px ${s.glow}` : undefined,
            }}>
              {s.value}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 12, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 600 }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* Keyboard hint */}
      <div className="anim-slide-up" style={{ marginTop: 40, animationDelay: "380ms", display: "flex", alignItems: "center", gap: 16 }}>
        {[
          { key: "F", label: "Feed" },
          { key: "C", label: "Companies" },
          { key: "L", label: "Flagged" },
        ].map((k) => (
          <span key={k.key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--fg-4)" }}>
            <span className="kbd">{k.key}</span>
            <span>{k.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const [filings, setFilings]         = useState<Filing[]>([]);
  const [loading, setLoading]         = useState(true);
  const [view, setView]               = useState<View>("home");
  const [activeCik, setActiveCik]     = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const watchlistCiks = CORE_WATCHLIST.map((c) => c.cik);
    const watchlistCikSet = new Set(watchlistCiks);
    const since = new Date();
    since.setDate(1);        // first day of the current calendar month
    since.setHours(0, 0, 0, 0);

    supabase
      .from("filings")
      .select("id,accession_number,cik,ticker,company_name,form_type,filed_at,filing_url,friday_dump,signals_flagged,period_of_report")
      .in("cik", watchlistCiks)
      .gte("filed_at", since.toISOString())
      .order("filed_at", { ascending: false })
      .limit(300)
      .then(({ data }) => {
        if (data) setFilings(data as Filing[]);
        setLoading(false);
      });

    const channel = supabase
      .channel("filings_live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "filings" },
        (payload) => {
          const f = payload.new as Filing;
          if (!watchlistCikSet.has(f.cik)) return;
          setFilings((prev) => {
            const next = [f, ...prev];
            return next.length > 200 ? next.slice(0, 200) : next;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "filings" },
        (payload) => setFilings((prev) =>
          prev.map((f) => f.id === (payload.new as Filing).id ? (payload.new as Filing) : f),
        ),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "filings" },
        (payload) => setFilings((prev) =>
          prev.filter((f) => f.id !== (payload.old as { id: string }).id),
        ),
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1);
      if (h.startsWith("c=")) {
        setActiveCik(h.slice(2));
        setView((prev) => (prev === "home" ? "feed" : prev));
      } else if (h === "feed" || h === "company" || h === "flagged") {
        setActiveCik(null);
        setView(h);
      } else {
        setActiveCik(null);
        setView("home");
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  function navigate(hash: string) {
    window.location.hash = hash;
  }

  // Keyboard shortcuts: f=Feed, c=Companies, l=Flagged, Esc=close mobile menu
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f") navigate("feed");
      else if (e.key === "c") navigate("company");
      else if (e.key === "l") navigate("flagged");
      else if (e.key === "Escape") setMobileMenuOpen(false);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const tabCounts = useMemo(() => ({
    feed: filings.length,
    company: new Set(filings.map((f) => f.cik)).size,
    flagged: filings.filter((f) => f.signals_flagged || f.friday_dump).length,
  }), [filings]);

  if (view === "home") {
    return <HomeView filings={filings} onNavigate={navigate} />;
  }

  const dashView = view as Exclude<View, "home">;

  const mainContent = activeCik ? (
    <CompanyFilingsView
      cik={activeCik}
      filings={filings}
      onBack={() => navigate(dashView === "feed" || dashView === "flagged" ? dashView : "company")}
    />
  ) : (
    <>
      <FilingsTabs active={dashView} onNavigate={navigate} counts={tabCounts} />
      {dashView === "company" ? (
        <CompanyListView filings={filings} onCompanyClick={(cik) => navigate(`c=${cik}`)} />
      ) : dashView === "flagged" ? (
        <FlaggedView filings={filings} onCompanyClick={(cik) => navigate(`c=${cik}`)} />
      ) : (
        <FeedView filings={filings} loading={loading} onCompanyClick={(cik) => navigate(`c=${cik}`)} />
      )}
    </>
  );

  return (
    <>
      {/* Mobile header — CSS-hidden on desktop, sticky bar on mobile */}
      <div className="mobile-header">
        <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.24em", color: "var(--fg-0)" }}>SUMMA</div>
        <span className="live-badge">
          <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
          LIVE
        </span>
        <button
          onClick={() => setMobileMenuOpen((o) => !o)}
          style={{
            background: "none", border: "1px solid var(--border-1)", borderRadius: 6,
            padding: "6px 12px", cursor: "pointer", color: "var(--fg-2)",
            fontFamily: "inherit", fontSize: 18, lineHeight: 1,
          }}
          aria-label="Toggle menu"
        >
          ☰
        </button>
      </div>

      {/* Overlay — closes drawer when tapped */}
      <div
        className={`mobile-overlay${mobileMenuOpen ? " active" : ""}`}
        onClick={() => setMobileMenuOpen(false)}
      />

      <div className="app-shell">
        <Sidebar
          filings={filings}
          activeView={dashView}
          activeCik={activeCik}
          onNavigate={(h) => { navigate(h); setMobileMenuOpen(false); }}
          mobileOpen={mobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
        />
        <main className="main-area">
          <div className="main-content">
            {mainContent}
          </div>
        </main>
      </div>

      {/* Mobile bottom nav — CSS-hidden on desktop */}
      <nav className="mobile-bottom-nav">
        {([
          { label: "Feed",      hash: "feed"    },
          { label: "Companies", hash: "company" },
          { label: "Flagged",   hash: "flagged" },
        ] as const).map((item) => (
          <button
            key={item.hash}
            onClick={() => navigate(item.hash)}
            className={`mobile-nav-item${dashView === item.hash && !activeCik ? " active" : ""}`}
          >
            <span className="mobile-nav-dot">
              {item.hash === "feed" ? "◈" : item.hash === "company" ? "◉" : "◎"}
            </span>
            {item.label}
          </button>
        ))}
      </nav>
    </>
  );
}
