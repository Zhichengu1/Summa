"use client";

import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase";

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
  "10-K":    "oklch(0.82 0.13 290)",
  "10-Q":    "oklch(0.82 0.13 220)",
  "8-K":     "oklch(0.83 0.14 75)",
  "DEF 14A": "oklch(0.77 0.13 175)",
};
function formColor(form: string): string {
  return FORM_COLORS[form] ?? "var(--fg-3)";
}

// ─── Atoms ────────────────────────────────────────────────────────────────────

function FormBadge({ form }: { form: string }) {
  const c = formColor(form);
  return (
    <span style={{
      fontSize: 10, letterSpacing: "0.12em", padding: "2px 6px",
      border: `1px solid ${c}44`, color: c,
      borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
    }}>
      {form}
    </span>
  );
}

function FlagChip({ label, tone }: { label: string; tone: "warn" | "alert" }) {
  const c = tone === "alert" ? "var(--alert)" : "var(--warn)";
  return (
    <span style={{
      fontSize: 10, letterSpacing: "0.14em", padding: "2px 7px",
      border: `1px solid ${c}55`, color: c, borderRadius: 3, whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

function CompanyMark({ ticker, size = 36 }: { ticker: string; size?: number }) {
  const hue = tickerHue(ticker);
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: `oklch(0.22 0.05 ${hue})`,
      border: `1px solid oklch(0.35 0.07 ${hue})`,
      borderRadius: 6,
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
      borderRadius: 6, padding: "18px 20px",
      display: "flex", flexDirection: "column", gap: 12, opacity: 0.45,
    }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ width: 36, height: 36, background: "var(--bg-3)", borderRadius: 6, flexShrink: 0 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ height: 14, width: "42%", background: "var(--bg-3)", borderRadius: 3 }} />
          <div style={{ height: 11, width: "65%", background: "var(--bg-3)", borderRadius: 3 }} />
        </div>
        <div style={{ height: 12, width: 56, background: "var(--bg-3)", borderRadius: 3 }} />
      </div>
      <div style={{ height: 1, background: "var(--border-1)" }} />
      <div style={{ height: 11, width: "28%", background: "var(--bg-3)", borderRadius: 3 }} />
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
        border: `1px solid ${filing.signals_flagged ? "var(--alert)33" : "var(--border-1)"}`,
        borderRadius: 6,
        padding: "18px 20px",
        display: "flex", flexDirection: "column", gap: 12,
        animationDelay: `${index * 35}ms`,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
          <CompanyMark ticker={filing.ticker} size={36} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px" }}>
              <button
                onClick={() => onCompanyClick(filing.cik)}
                style={{
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  fontSize: 14, fontWeight: 600, color: "var(--fg-0)", fontFamily: "inherit",
                  textAlign: "left",
                }}
              >
                {filing.company_name}
              </button>
              <span style={{ fontSize: 11, color: "var(--accent)" }}>{filing.ticker}</span>
              <FormBadge form={filing.form_type} />
            </div>
            {filing.period_of_report && (
              <div className="caption">Period: {fmtDate(filing.period_of_report)}</div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{elapsed(filing.filed_at)}</span>
          <span className="caption">{fmtDate(filing.filed_at)}</span>
        </div>
      </div>

      {/* Flag chips */}
      {(filing.friday_dump || filing.signals_flagged) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {filing.friday_dump    && <FlagChip label="FRIDAY DUMP"       tone="warn"  />}
          {filing.signals_flagged && <FlagChip label="SIGNALS DETECTED" tone="alert" />}
        </div>
      )}

      {/* Footer */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        paddingTop: 10, borderTop: "1px solid var(--border-1)",
      }}>
        <span
          className="caption"
          title={filing.accession_number}
          style={{ fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}
        >
          {filing.accession_number}
        </span>
        {filing.filing_url ? (
          <a
            href={filing.filing_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11, color: "var(--accent)", letterSpacing: "0.12em",
              textDecoration: "none",
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "5px 12px",
              border: "1px solid var(--accent)44",
              borderRadius: 3,
              transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background    = "var(--accent)14";
              e.currentTarget.style.borderColor   = "var(--accent)88";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background    = "transparent";
              e.currentTarget.style.borderColor   = "var(--accent)44";
            }}
          >
            VIEW FILING →
          </a>
        ) : (
          <span className="caption" style={{ color: "var(--fg-4)" }}>no url</span>
        )}
      </div>
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
          color: "var(--accent)", fontSize: 12, letterSpacing: "0.12em",
          fontFamily: "inherit",
          display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start",
        }}
      >
        ← Back
      </button>

      {/* Company header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <CompanyMark ticker={meta.ticker} size={52} />
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 400, color: "var(--fg-0)", margin: "0 0 4px", letterSpacing: "-0.01em" }}>
            {meta.company_name}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, color: "var(--accent)", fontWeight: 600 }}>{meta.ticker}</span>
            <span className="caption">CIK {meta.cik}</span>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{
        display: "flex", gap: 0,
        background: "var(--border-1)", border: "1px solid var(--border-1)",
        borderRadius: 6, overflow: "hidden",
      }}>
        {[
          { label: "Total Filings",  value: all.length },
          { label: "Flagged",        value: all.filter((f) => f.signals_flagged).length },
          { label: "Friday Dumps",   value: all.filter((f) => f.friday_dump).length },
        ].map((s) => (
          <div key={s.label} style={{ flex: 1, padding: "12px 18px", background: "var(--bg-2)" }}>
            <div className="label-caps">{s.label}</div>
            <div className="metric-val" style={{ marginTop: 4 }}>{s.value}</div>
          </div>
        ))}
        <div style={{ flex: 2, padding: "12px 18px", background: "var(--bg-2)" }}>
          <div className="label-caps" style={{ marginBottom: 6 }}>Form Breakdown</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {Object.entries(formCounts).map(([form, cnt]) => (
              <span key={form} style={{ fontSize: 11, color: formColor(form), letterSpacing: "0.08em" }}>
                {form} × {cnt}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Filing timeline */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-2)", letterSpacing: "0.08em", marginBottom: 16 }}>
          FILING TIMELINE — {all.length} ENTRIES
        </div>
        {all.map((f, i) => (
          <div key={f.id} style={{ display: "flex", gap: 14, paddingBottom: i < all.length - 1 ? 20 : 0 }}>
            {/* Date rail */}
            <div style={{
              width: 88, flexShrink: 0,
              display: "flex", flexDirection: "column", alignItems: "flex-end",
              paddingTop: 10, gap: 2,
            }}>
              <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{fmtDate(f.filed_at).replace(/, \d{4}$/, "")}</span>
              <span className="caption">{new Date(f.filed_at ?? "").getFullYear()}</span>
            </div>
            {/* Rail */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
              <div style={{
                width: 9, height: 9, borderRadius: "50%", marginTop: 12, flexShrink: 0,
                background: f.signals_flagged ? "var(--alert)" : f.friday_dump ? "var(--warn)" : "var(--border-2)",
              }} />
              {i < all.length - 1 && (
                <div style={{ width: 1, flex: 1, minHeight: 16, background: "var(--border-1)", marginTop: 2 }} />
              )}
            </div>
            {/* Card */}
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
      <div>
        <div className="label-caps">Filing Feed</div>
        <h1 style={{ fontSize: 24, fontWeight: 400, color: "var(--fg-0)", margin: "4px 0 10px", letterSpacing: "-0.01em" }}>
          Recent Filings
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {FEED_FORM_TYPES.map((t) => typeCounts[t] > 0 && (
            <span key={t} style={{ fontSize: 11, color: formColor(t) }}>
              {typeCounts[t]}<span style={{ opacity: 0.55, marginLeft: 3 }}>{t}</span>
            </span>
          ))}
          {!loading && filings.length > 0 && (
            <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
              · {isFiltered ? `${displayed.length} of ${filings.length}` : displayed.length} filings · {uniqueCompanies} companies
            </span>
          )}
        </div>
      </div>

      {/* Filter bar */}
      {!loading && filings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            className="search-input"
            placeholder="Search company or ticker…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {FEED_FORM_TYPES.map((t) => (
              <button
                key={t}
                className={`filter-chip${activeTypes.includes(t) ? " active" : ""}`}
                onClick={() => toggleType(t)}
              >
                {t}{typeCounts[t] > 0 && <span style={{ marginLeft: 5, opacity: 0.55 }}>{typeCounts[t]}</span>}
              </button>
            ))}
            {isFiltered && (
              <button
                className="filter-chip"
                onClick={() => { setActiveTypes([]); setSearch(""); }}
                style={{ color: "var(--alert)", borderColor: "var(--alert)44" }}
              >
                clear ×
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ height: 1, background: "var(--border-1)" }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : displayed.length === 0
          ? (
            <div style={{ padding: "48px 0", textAlign: "center", color: "var(--fg-4)", fontSize: 13 }}>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <div className="label-caps">By Company</div>
        <h1 style={{ fontSize: 24, fontWeight: 400, color: "var(--fg-0)", margin: "4px 0 0", letterSpacing: "-0.01em" }}>
          Watchlist Companies
        </h1>
        <p style={{ fontSize: 13, color: "var(--fg-3)", margin: "6px 0 0" }}>
          {companies.length} companies tracked — click to see full filing timeline.
        </p>
      </div>
      <div style={{ height: 1, background: "var(--border-1)" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {companies.map((c) => (
          <button
            key={c.cik}
            onClick={() => onCompanyClick(c.cik)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              background: "var(--bg-2)", border: "1px solid var(--border-1)",
              borderRadius: 6, padding: "14px 18px",
              cursor: "pointer", fontFamily: "inherit", textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
              width: "100%",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--accent)66";
              e.currentTarget.style.background  = "var(--bg-3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border-1)";
              e.currentTarget.style.background  = "var(--bg-2)";
            }}
          >
            <CompanyMark ticker={c.ticker} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>{c.name}</span>
                <span style={{ fontSize: 12, color: "var(--accent)" }}>{c.ticker}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <span className="caption">{c.count} filings</span>
                <span className="caption">·</span>
                <span className="caption">latest {elapsed(c.latest.filed_at)}</span>
                <span className="caption">·</span>
                <FormBadge form={c.latest.form_type} />
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--accent)", letterSpacing: "0.14em", flexShrink: 0 }}>
              VIEW →
            </span>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <div className="label-caps">Flagged</div>
        <h1 style={{ fontSize: 24, fontWeight: 400, color: "var(--fg-0)", margin: "4px 0 0", letterSpacing: "-0.01em" }}>
          Flagged Filings
        </h1>
        <p style={{ fontSize: 13, color: "var(--fg-3)", margin: "6px 0 0", maxWidth: 480 }}>
          Filings where signals were detected — Friday after-hours dumps, burst patterns, and algorithm flags.
        </p>
      </div>
      <div style={{ height: 1, background: "var(--border-1)" }} />
      {flagged.length === 0 ? (
        <div style={{
          padding: "52px 32px", textAlign: "center",
          border: "1px dashed var(--border-1)", borderRadius: 8,
        }}>
          <div style={{ fontSize: 32, marginBottom: 14, color: "var(--fg-4)", lineHeight: 1 }}>◎</div>
          <div style={{ fontSize: 14, color: "var(--fg-3)", marginBottom: 6 }}>No flagged filings yet</div>
          <div className="caption">
            Signal extraction runs when the pipeline processes new filings.
            <br />Build <code style={{ color: "var(--accent)" }}>signal_extractor.py</code> to activate scoring.
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
  active, onNavigate,
}: {
  active: Exclude<View, "home">; onNavigate: (hash: string) => void;
}) {
  const tabs = [
    { label: "Feed",      hash: "feed"    },
    { label: "Companies", hash: "company" },
    { label: "Flagged",   hash: "flagged" },
  ] as const;
  return (
    <div style={{ display: "flex", borderBottom: "1px solid var(--border-1)", marginBottom: 32 }}>
      {tabs.map((t) => (
        <button
          key={t.hash}
          onClick={() => onNavigate(t.hash)}
          style={{
            padding: "9px 20px",
            border: "none",
            borderBottom: active === t.hash ? "2px solid var(--accent)" : "2px solid transparent",
            marginBottom: -1,
            background: "transparent",
            color: active === t.hash ? "var(--fg-0)" : "var(--fg-3)",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12,
            letterSpacing: "0.1em",
            transition: "color 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => { if (active !== t.hash) e.currentTarget.style.color = "var(--fg-1)"; }}
          onMouseLeave={(e) => { if (active !== t.hash) e.currentTarget.style.color = "var(--fg-3)"; }}
        >
          {t.label}
        </button>
      ))}
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
    { label: "Filings", hash: "feed",    group: ["feed", "company", "flagged"], icon: "▦", disabled: false },
    { label: "Search",  hash: "search",  group: ["search"],                     icon: "◎", disabled: true  },
    { label: "Signals", hash: "signals", group: ["signals"],                    icon: "◈", disabled: true  },
  ];

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div style={{ padding: "18px 16px 14px", borderBottom: "1px solid var(--border-1)", flexShrink: 0 }}>
        <button
          onClick={() => onNavigate("home")}
          style={{
            background: "none", border: "none", padding: 0,
            cursor: "pointer", fontFamily: "inherit", display: "block", width: "100%",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "0.3em", color: "var(--fg-0)", textAlign: "left" }}>
            <span style={{ color: "var(--accent)" }}>▚</span> SUMMA
          </div>
        </button>
        <div className="label-caps" style={{ marginTop: 4 }}>SEC FILING INTELLIGENCE</div>
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
                width: "100%", textAlign: "left", padding: "9px 16px",
                background: active ? "var(--bg-2)" : "transparent",
                border: "none",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--fg-0)" : item.disabled ? "var(--fg-4)" : "var(--fg-3)",
                fontSize: 12, letterSpacing: "0.1em",
                cursor: item.disabled ? "default" : "pointer",
                fontFamily: "inherit",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: active ? "var(--accent)" : "inherit", fontSize: 11, lineHeight: 1 }}>
                  {item.icon}
                </span>
                {item.label}
              </div>
              {item.disabled && (
                <span style={{
                  fontSize: 9, letterSpacing: "0.12em", color: "var(--fg-4)",
                  border: "1px solid var(--border-1)", padding: "1px 5px", borderRadius: 2,
                }}>
                  SOON
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Company list */}
      <div style={{ padding: "8px 16px 4px", flexShrink: 0 }}>
        <span className="label-caps">Companies ({companies.length})</span>
      </div>
      {companies.length > 0 && (
        <div style={{ padding: "4px 10px 6px", flexShrink: 0 }}>
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
                width: "100%", textAlign: "left", padding: "9px 16px",
                background: active ? "var(--bg-2)" : "transparent",
                border: "none",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                cursor: "pointer", fontFamily: "inherit",
                transition: "background 0.1s",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontWeight: 700, fontSize: 12, color: active ? "var(--fg-0)" : "var(--fg-1)", letterSpacing: "0.06em" }}>
                    {c.ticker}
                  </span>
                  {c.hasFlagged && (
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--alert)", flexShrink: 0, display: "inline-block" }} />
                  )}
                </div>
                <span className="caption">{c.count}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.name}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-4)" }}>{elapsed(c.latest.filed_at)}</div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{
        padding: "10px 16px", borderTop: "1px solid var(--border-1)",
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
      }}>
        <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
        <span className="caption">EDGAR feed · live</span>
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

  const cards = [
    {
      id: "feed", icon: "▦",
      label: "Filings",
      description: "Live feed of 10-K, 10-Q, 8-K, and DEF 14A filings. Filter by form type, search by company, browse timelines, and review flagged signals — all in one place.",
      stat: `${filings.length} filings · ${totalCompanies} companies`,
      available: true,
    },
  ];

  const countCompanies = useCountUp(totalCompanies, 620);
  const countFilings   = useCountUp(filings.length,  680);
  const countFlagged   = useCountUp(flaggedCount,     740);

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: "60px 32px",
      position: "relative", zIndex: 1,
      background: "radial-gradient(ellipse 70% 55% at 50% 42%, #67d5c809 0%, transparent 70%)",
    }}>
      {/* One-shot scan line */}
      <div className="scan-line" />

      {/* Terminal status line */}
      <div
        className="status-line"
        style={{
          fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.1em",
          marginBottom: 40,
          display: "flex", alignItems: "center", gap: 10,
          flexWrap: "wrap", justifyContent: "center",
        }}
      >
        <span style={{ color: "var(--accent)" }}>▸</span>
        <span>monitoring {totalCompanies} companies</span>
        <span style={{ color: "var(--border-2)" }}>·</span>
        <span>{filings.length} filings indexed</span>
        <span style={{ color: "var(--border-2)" }}>·</span>
        <span style={{ color: "var(--accent)" }}>realtime feed active</span>
        <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
      </div>

      {/* Brand */}
      <div className="anim-slide-up" style={{ textAlign: "center", marginBottom: 48, animationDelay: "60ms" }}>
        <div style={{ fontSize: 52, fontWeight: 700, letterSpacing: "0.28em", color: "var(--fg-0)", marginBottom: 12, lineHeight: 1 }}>
          <span className="accent-glow" style={{ color: "var(--accent)" }}>▚</span>
          {" SUMMA"}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18 }}>
          <span className="label-caps" style={{ letterSpacing: "0.28em" }}>SEC FILING INTELLIGENCE</span>
          <span className="blink-cursor" style={{ color: "var(--accent)", marginLeft: 3, fontWeight: 700, fontSize: 12 }}>_</span>
        </div>
        <p style={{ fontSize: 14, color: "var(--fg-3)", margin: 0, maxWidth: 440, lineHeight: 1.85 }}>
          Automated signal detection for EDGAR filings. Monitors 10-K, 10-Q, 8-K, and DEF&nbsp;14A
          every 10&nbsp;minutes across your watchlist.
        </p>
      </div>

      {/* Nav cards — staggered entrance + CSS hover via .nav-card */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 480px)",
        gap: 12, marginBottom: 44,
        width: "100%",
      }}>
        {cards.map((card, i) => (
          <button
            key={card.id}
            onClick={card.available ? () => onNavigate(card.id) : undefined}
            disabled={!card.available}
            className="nav-card anim-slide-up"
            style={{
              background: "var(--bg-1)", border: "1px solid var(--border-2)",
              borderRadius: 8, padding: "20px 22px",
              textAlign: "left", cursor: card.available ? "pointer" : "default",
              opacity: card.available ? 1 : 0.35,
              fontFamily: "inherit",
              display: "flex", flexDirection: "column", gap: 10,
              animationDelay: `${160 + i * 80}ms`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 20, color: card.available ? "var(--accent)" : "var(--fg-4)", lineHeight: 1 }}>
                {card.icon}
              </span>
              <span style={{
                fontSize: 10, letterSpacing: "0.12em", padding: "2px 7px",
                border: `1px solid ${card.available ? "var(--accent)44" : "var(--border-1)"}`,
                color: card.available ? "var(--accent)" : "var(--fg-4)",
                borderRadius: 3,
              }}>
                {card.stat}
              </span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)", letterSpacing: "0.02em" }}>
              {card.label}
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.7, flex: 1 }}>
              {card.description}
            </div>
            {card.available && (
              <div style={{ fontSize: 10, color: "var(--accent)", letterSpacing: "0.18em", marginTop: 2 }}>
                ENTER →
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Stats bar — count-up */}
      <div
        className="anim-slide-up"
        style={{
          display: "flex", gap: 0,
          background: "var(--border-1)", border: "1px solid var(--border-1)",
          borderRadius: 6, overflow: "hidden",
          animationDelay: "560ms",
        }}
      >
        {[
          { label: "Companies Tracked", value: countCompanies },
          { label: "Filings Indexed",   value: countFilings   },
          { label: "Signals Flagged",   value: countFlagged   },
        ].map((s, i) => (
          <div key={s.label} style={{
            padding: "14px 28px", background: "var(--bg-2)", textAlign: "center",
            borderRight: i < 2 ? "1px solid var(--border-1)" : "none",
          }}>
            <div style={{ fontSize: 26, fontWeight: 600, color: "var(--fg-0)", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
              {s.value}
            </div>
            <div className="label-caps" style={{ marginTop: 6 }}>{s.label}</div>
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

  // Fetch + realtime
  useEffect(() => {
    supabase
      .from("filings")
      .select("id,accession_number,cik,ticker,company_name,form_type,filed_at,filing_url,friday_dump,signals_flagged,period_of_report")
      .order("filed_at", { ascending: false })
      .limit(200)
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

  // Hash routing
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
      <FilingsTabs active={dashView} onNavigate={navigate} />
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
