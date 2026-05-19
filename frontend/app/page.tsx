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

// ─── Atoms ────────────────────────────────────────────────────────────────────

function FormBadge({ form }: { form: string }) {
  const c = formColor(form);
  return (
    <span style={{
      fontSize: 13, letterSpacing: "0.08em", padding: "4px 10px",
      border: `1px solid ${c}44`, color: c, background: `${c}0d`,
      borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0,
    }}>
      {form}
    </span>
  );
}

function FlagChip({ label, tone }: { label: string; tone: "warn" | "alert" }) {
  const c = tone === "alert" ? "var(--alert)" : "var(--warn)";
  return (
    <span style={{
      fontSize: 14, padding: "5px 12px", borderRadius: 4, whiteSpace: "nowrap",
      background: tone === "alert" ? "var(--tint-alert)" : "var(--tint-warn)",
      color: c,
      display: "inline-flex", alignItems: "center", gap: 6,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: c, display: "inline-block", flexShrink: 0 }} />
      {label}
    </span>
  );
}

function CompanyMark({ ticker, size = 36 }: { ticker: string; size?: number }) {
  const hue = tickerHue(ticker);
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: `oklch(0.25 0.07 ${hue})`,
      border: `1px solid oklch(0.38 0.09 ${hue})`,
      borderRadius: 7,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.31, fontWeight: 700,
      color: `oklch(0.82 0.14 ${hue})`,
      letterSpacing: "0.04em",
    }}>
      {ticker.slice(0, 2)}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div style={{
      background: "var(--bg-2)", border: "1px solid var(--border-1)",
      borderRadius: 8, padding: "22px 26px",
      display: "flex", gap: 15, opacity: 0.5,
    }}>
      <div className="skeleton-shimmer" style={{ width: 42, height: 42, borderRadius: 8, flexShrink: 0 }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 11 }}>
        <div className="skeleton-shimmer" style={{ height: 16, width: "42%", borderRadius: 3 }} />
        <div className="skeleton-shimmer" style={{ height: 14, width: "64%", borderRadius: 3 }} />
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
  return (
    <div
      className={`filing-card anim-fade-up${filing.signals_flagged ? " card-flagged-stripe flagged" : ""}`}
      style={{
        position: "relative",
        background: "var(--bg-2)",
        border: `1px solid ${filing.signals_flagged ? "var(--alert)22" : "var(--border-1)"}`,
        borderRadius: 8,
        padding: "22px 28px",
        display: "flex", flexDirection: "column", gap: 14,
        animationDelay: `${index * 30}ms`,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <CompanyMark ticker={filing.ticker} size={42} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Name + time */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
            <button
              onClick={() => onCompanyClick(filing.cik)}
              style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                fontSize: 18, fontWeight: 600, color: "var(--fg-0)", fontFamily: "inherit",
                textAlign: "left", lineHeight: 1.3,
              }}
            >
              {filing.company_name}
            </button>
            <span style={{ fontSize: 15, color: "var(--fg-3)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {elapsed(filing.filed_at)}
            </span>
          </div>
          {/* Meta + view link */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
              <span style={{ fontSize: 14, color: "var(--accent)", fontWeight: 600 }}>{filing.ticker}</span>
              <span style={{ color: "var(--border-2)" }}>·</span>
              <FormBadge form={filing.form_type} />
              {filing.period_of_report && (
                <>
                  <span style={{ color: "var(--border-2)" }}>·</span>
                  <span className="caption">{fmtDate(filing.period_of_report)}</span>
                </>
              )}
            </div>
            {filing.filing_url && (
              <a
                href={filing.filing_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 14, color: "var(--fg-3)", textDecoration: "none",
                  flexShrink: 0, transition: "color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-3)"; }}
              >
                View ↗
              </a>
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

// ─── Company detail ───────────────────────────────────────────────────────────

function CompanyFilingsView({
  cik, filings, onBack,
}: {
  cik: string; filings: Filing[]; onBack: () => void;
}) {
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
          background: "none", border: "none", padding: 0, cursor: "pointer",
          color: "var(--fg-3)", fontSize: 16, fontFamily: "inherit",
          display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start",
          transition: "color 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-1)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-3)"; }}
      >
        ← Back
      </button>

      {/* Company header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <CompanyMark ticker={meta.ticker} size={60} />
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 600, color: "var(--fg-0)", margin: "0 0 4px", letterSpacing: "-0.01em" }}>
            {meta.company_name}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, color: "var(--accent)", fontWeight: 600 }}>{meta.ticker}</span>
            <span className="caption">CIK {meta.cik}</span>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{
        display: "flex", gap: 0,
        background: "var(--border-1)", border: "1px solid var(--border-1)",
        borderRadius: 7, overflow: "hidden",
      }}>
        {[
          { label: "Filings",      value: all.length },
          { label: "Flagged",      value: all.filter((f) => f.signals_flagged).length },
          { label: "Friday Dumps", value: all.filter((f) => f.friday_dump).length },
        ].map((s) => (
          <div key={s.label} style={{ flex: 1, padding: "12px 18px", background: "var(--bg-2)" }}>
            <div className="label-caps">{s.label}</div>
            <div className="metric-val" style={{ marginTop: 3 }}>{s.value}</div>
          </div>
        ))}
        <div style={{ flex: 2, padding: "12px 18px", background: "var(--bg-2)" }}>
          <div className="label-caps" style={{ marginBottom: 6 }}>Form types</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {Object.entries(formCounts).map(([form, cnt]) => (
              <span key={form} style={{ fontSize: 11, color: formColor(form) }}>
                {form} × {cnt}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Filing timeline */}
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

  const displayed = useMemo(() => {
    let r = filings;
    if (activeTypes.length > 0) r = r.filter((f) => activeTypes.includes(f.form_type));
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((f) =>
        f.company_name.toLowerCase().includes(q) || f.ticker.toLowerCase().includes(q),
      );
    }
    return r;
  }, [filings, search, activeTypes]);

  const uniqueCompanies = new Set(displayed.map((f) => f.cik)).size;
  const isFiltered = activeTypes.length > 0 || search.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, color: "var(--fg-0)", margin: 0, letterSpacing: "-0.01em" }}>
            Recent Filings
          </h1>
          <span className="live-badge">
            <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
            LIVE
          </span>
        </div>
        {!loading && filings.length > 0 && (
          <div style={{
            display: "flex", gap: 0,
            background: "var(--border-1)", border: "1px solid var(--border-1)",
            borderRadius: 7, overflow: "hidden",
          }}>
            {FEED_FORM_TYPES.map((t) => typeCounts[t] > 0 && (
              <div key={t} style={{
                padding: "10px 18px", background: "var(--bg-2)",
                flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 3,
              }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: formColor(t), fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                  {typeCounts[t]}
                </div>
                <div className="label-caps" style={{ fontSize: 12 }}>{t}</div>
              </div>
            ))}
            <div style={{
              padding: "10px 18px", background: "var(--bg-2)",
              flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 3,
            }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: "var(--fg-1)", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                {uniqueCompanies}
              </div>
              <div className="label-caps" style={{ fontSize: 12 }}>Companies</div>
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
        <h1 style={{ fontSize: 28, fontWeight: 600, color: "var(--fg-0)", margin: "0 0 4px", letterSpacing: "-0.01em" }}>
          Watchlist Companies
        </h1>
        <p style={{ fontSize: 16, color: "var(--fg-3)", margin: 0 }}>
          {companies.length} companies tracked — click to view filing timeline.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {companies.map((c) => (
          <button
            key={c.cik}
            onClick={() => onCompanyClick(c.cik)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              background: "var(--bg-2)", border: "1px solid var(--border-1)",
              borderRadius: 8, padding: "20px 24px",
              cursor: "pointer", fontFamily: "inherit", textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
              width: "100%",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--border-2)";
              e.currentTarget.style.background  = "var(--bg-3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border-1)";
              e.currentTarget.style.background  = "var(--bg-2)";
            }}
          >
            <CompanyMark ticker={c.ticker} size={48} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
                <span style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-0)" }}>{c.name}</span>
                <span style={{ fontSize: 14, color: "var(--accent)" }}>{c.ticker}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span className="caption">{c.count} filings</span>
                <span className="caption">·</span>
                <span className="caption">{elapsed(c.latest.filed_at)}</span>
                <span className="caption">·</span>
                <FormBadge form={c.latest.form_type} />
              </div>
            </div>
            <span style={{ fontSize: 20, color: "var(--fg-3)", flexShrink: 0 }}>›</span>
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
        <h1 style={{ fontSize: 28, fontWeight: 600, color: "var(--fg-0)", margin: "0 0 4px", letterSpacing: "-0.01em" }}>
          Flagged Filings
        </h1>
        <p style={{ fontSize: 16, color: "var(--fg-3)", margin: 0, maxWidth: 540 }}>
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
    <div style={{ display: "flex", borderBottom: "1px solid var(--border-1)", marginBottom: 28 }}>
      {tabs.map((t) => {
        const isActive = active === t.hash;
        return (
          <button
            key={t.hash}
            onClick={() => onNavigate(t.hash)}
            style={{
              padding: "14px 28px",
              border: "none",
              borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: -1,
              background: isActive ? "#4fd4c210" : "transparent",
              color: isActive ? "var(--fg-0)" : "var(--fg-3)",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 17,
              fontWeight: isActive ? 600 : 400,
              transition: "color 0.15s, border-color 0.15s",
              display: "flex", alignItems: "center", gap: 7,
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = "var(--fg-1)"; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = "var(--fg-3)"; }}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span style={{
                fontSize: 13, padding: "3px 8px", borderRadius: 4,
                fontVariantNumeric: "tabular-nums",
                background: isActive ? "var(--accent)20" : "var(--bg-3)",
                color: isActive ? "var(--accent)" : "var(--fg-4)",
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
  filings, activeView, activeCik, onNavigate,
}: {
  filings: Filing[];
  activeView: Exclude<View, "home">;
  activeCik: string | null;
  onNavigate: (hash: string) => void;
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
    <aside className="sidebar">
      {/* Brand */}
      <div style={{ padding: "22px 20px 18px", borderBottom: "1px solid var(--border-1)", flexShrink: 0 }}>
        <button
          onClick={() => onNavigate("home")}
          style={{
            background: "none", border: "none", padding: 0,
            cursor: "pointer", fontFamily: "inherit", display: "block", width: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.2em", color: "var(--fg-0)" }}>
              SUMMA
            </div>
            <span className="live-badge">
              <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
              LIVE
            </span>
          </div>
          <div style={{ fontSize: 14, color: "var(--fg-4)", marginTop: 4 }}>
            SEC Filing Intelligence
          </div>
        </button>
      </div>

      {/* Nav */}
      <div style={{ padding: "8px 0 4px", borderBottom: "1px solid var(--border-1)", flexShrink: 0 }}>
        {navItems.map((item) => {
          const active = !item.disabled && activeCik === null && (item.group as string[]).includes(activeView);
          return (
            <button
              key={item.hash}
              onClick={item.disabled ? undefined : () => onNavigate(item.hash)}
              style={{
                width: "100%", textAlign: "left", padding: "12px 20px",
                background: active ? "#4fd4c214" : "transparent",
                border: "none",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--fg-0)" : item.disabled ? "var(--fg-4)" : "var(--fg-3)",
                fontSize: 16,
                cursor: item.disabled ? "default" : "pointer",
                fontFamily: "inherit",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                transition: "color 0.1s, background 0.1s",
              }}
              onMouseEnter={(e) => { if (!active && !item.disabled) e.currentTarget.style.color = "var(--fg-1)"; }}
              onMouseLeave={(e) => { if (!active && !item.disabled) e.currentTarget.style.color = "var(--fg-3)"; }}
            >
              {item.label}
              {item.disabled && (
                <span style={{ fontSize: 12, letterSpacing: "0.1em", color: "var(--fg-4)" }}>soon</span>
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
                display: "flex", flexDirection: "column", gap: 3,
                width: "100%", textAlign: "left", padding: "13px 20px",
                background: active ? "#4fd4c210" : "transparent",
                border: "none",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                cursor: "pointer", fontFamily: "inherit",
                transition: "background 0.1s, border-color 0.1s",
              }}
              onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = "var(--bg-2)"; e.currentTarget.style.borderLeftColor = "var(--border-2)"; } }}
              onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderLeftColor = "transparent"; } }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                <span style={{
                  fontSize: 15, fontWeight: 500,
                  color: active ? "var(--fg-0)" : "var(--fg-1)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {c.name}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  {c.hasFlagged && (
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--alert)", display: "inline-block" }} />
                  )}
                  <span className="caption">{c.count}</span>
                </div>
              </div>
              <span style={{ fontSize: 14, color: "var(--fg-4)" }}>{c.ticker}</span>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border-1)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--pos)", display: "inline-block" }} />
            <span className="caption">EDGAR connected</span>
          </div>
          <span className="caption">{filings.length} filings</span>
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
    const t = setTimeout(() => {
      const start = performance.now();
      const duration = 900;
      const tick = () => {
        const p = Math.min((performance.now() - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        setVal(Math.round(eased * target));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delayMs);
    return () => clearTimeout(t);
  }, [target, delayMs]);
  return val;
}

// ─── Home page ────────────────────────────────────────────────────────────────

function HomeView({
  filings, onNavigate,
}: {
  filings: Filing[]; onNavigate: (hash: string) => void;
}) {
  const totalCompanies = new Set(filings.map((f) => f.cik)).size;
  const flaggedCount   = filings.filter((f) => f.signals_flagged || f.friday_dump).length;

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
      background: "radial-gradient(ellipse 70% 55% at 50% 42%, #4fd4c209 0%, transparent 70%)",
    }}>
      <div className="scan-line" />

      {/* Status */}
      <div
        className="status-line"
        style={{ fontSize: 14, color: "var(--fg-4)", marginBottom: 52, display: "flex", alignItems: "center", gap: 10 }}
      >
        <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
        <span style={{ color: "var(--accent)" }}>feed active</span>
        <span style={{ color: "var(--border-2)" }}>·</span>
        <span>{filings.length} filings indexed</span>
      </div>

      {/* Brand */}
      <div className="anim-slide-up" style={{ textAlign: "center", marginBottom: 64, animationDelay: "60ms" }}>
        <div style={{ fontSize: 70, fontWeight: 700, letterSpacing: "0.22em", color: "var(--fg-0)", marginBottom: 18, lineHeight: 1 }}>
          <span className="accent-glow" style={{ color: "var(--accent)" }}>S</span>UMMA
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 16 }}>
          <span style={{ fontSize: 14, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
            SEC Filing Intelligence
          </span>
          <span className="blink-cursor" style={{ color: "var(--accent)", fontWeight: 700, fontSize: 15 }}>_</span>
        </div>
        <p style={{ fontSize: 17, color: "var(--fg-3)", margin: 0, maxWidth: 500, lineHeight: 1.8 }}>
          Automated signal detection for EDGAR filings. Monitors 10-K, 10-Q, 8-K, and DEF&nbsp;14A
          every 10&nbsp;minutes.
        </p>
      </div>

      {/* Enter button */}
      <div className="anim-slide-up" style={{ marginBottom: 60, animationDelay: "160ms" }}>
        <button
          onClick={() => onNavigate("feed")}
          className="nav-card"
          style={{
            background: "var(--bg-1)", border: "1px solid var(--border-2)",
            borderRadius: 8, padding: "20px 36px",
            cursor: "pointer", fontFamily: "inherit",
            display: "flex", alignItems: "center", gap: 14,
          }}
        >
          <span style={{ fontSize: 14, color: "var(--fg-3)", letterSpacing: "0.06em" }}>
            {filings.length} filings · {totalCompanies} companies
          </span>
          <span style={{ color: "var(--border-2)", fontSize: 16 }}>—</span>
          <span style={{ fontSize: 14, color: "var(--accent)", letterSpacing: "0.12em" }}>
            Open →
          </span>
        </button>
      </div>

      {/* Stats */}
      <div
        className="anim-slide-up"
        style={{ display: "flex", gap: 8, animationDelay: "280ms" }}
      >
        {[
          { label: "Companies",       value: countCompanies, color: "var(--accent)" },
          { label: "Filings indexed", value: countFilings,   color: "var(--fg-0)"   },
          { label: "Signals flagged", value: countFlagged,   color: "var(--alert)"  },
        ].map((s) => (
          <div key={s.label} style={{
            padding: "20px 36px",
            background: "var(--bg-2)",
            border: "1px solid var(--border-1)",
            borderRadius: 7,
            textAlign: "center",
            minWidth: 150,
          }}>
            <div style={{
              fontSize: 38, fontWeight: 600, color: s.color,
              fontVariantNumeric: "tabular-nums", lineHeight: 1,
              textShadow: s.color === "var(--accent)" ? "0 0 20px #4fd4c228" : undefined,
            }}>
              {s.value}
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-4)", marginTop: 9, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const [filings, setFilings]     = useState<Filing[]>([]);
  const [loading, setLoading]     = useState(true);
  const [view, setView]           = useState<View>("home");
  const [activeCik, setActiveCik] = useState<string | null>(null);

  useEffect(() => {
    const watchlistCiks = CORE_WATCHLIST.map((c) => c.cik);
    const since = new Date();
    since.setDate(since.getDate() - 30);

    supabase
      .from("filings")
      .select("id,accession_number,cik,ticker,company_name,form_type,filed_at,filing_url,friday_dump,signals_flagged,period_of_report")
      .in("cik", watchlistCiks)
      .gte("filed_at", since.toISOString())
      .order("filed_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (data) setFilings(data as Filing[]);
        setLoading(false);
      });

    const channel = supabase
      .channel("filings_live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "filings" },
        (payload) => setFilings((prev) => [payload.new as Filing, ...prev]),
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
    <div className="app-shell">
      <Sidebar
        filings={filings}
        activeView={dashView}
        activeCik={activeCik}
        onNavigate={navigate}
      />
      <main className="main-area">
        <div className="main-content">
          {mainContent}
        </div>
      </main>
    </div>
  );
}
