"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { DataTable, type Column } from "../components/DataTable";
import { InfoTip, Term } from "../components/InfoTip";
import {
  ComboChart, MultiLineChart, SimpleBarChart, PairedBarChart,
  StackedBarChart, DivergingBarChart, HorizontalBarChart, CumulativeLineChart, PriceChart,
} from "../components/charts";
import { Sparkline } from "../components/Sparkline";
import {
  pivotStatement, seriesFor, deriveKpis, yoyGrowth, METRICS,
} from "../lib/fundamentals";
import {
  fetchCompanies, fetchFilings, fetchFilingsForCik, fetchFinancialFacts,
  subscribeFilings, fetchInsiderTransactions, fetchInstitutionalHoldings,
  fetchCorporateEvents, fetchEarningsEvents, fetchLateFilings,
  fetchSecuritiesOfferings, fetchBeneficialOwnership, fetchProposedSales,
  fetchManagerHoldings, fetchPrices, fetchRecentPrices, fetchIncomeFactsForCiks,
  fetchRecentInsider, fetchRecentEarnings, fetchRecentEvents,
  fetchRecentBeneficial, fetchRecentOfferings, fetchRecentLateFilings,
  fetchCompanyProfiles, fetchCompanyThemes, fetchEntities, queueWatchlist,
} from "../lib/data";
import { profileFor, loadProfiles } from "../lib/taxonomy";
import { entityContext, loadEntities } from "../lib/entities";
import { useWatchlist, type WatchItem } from "../lib/useWatchlist";
import { useLastSeen } from "../lib/useLastSeen";
import { loadSecIndex, searchSec, type SecCompany } from "../lib/secIndex";
import {
  fmtUSD, fmtNum, fmtPct, fmtDelta, fmtDate, elapsed, fmtPeriodLabel, formColorVar,
} from "../lib/format";
import {
  buildTape, buildSignals, buildWatchlistSignals, buildWatchlistTape, EVENT_CLASS_DIR,
  type Direction, type TapeItem, type Signal, type CompanyData, type WatchEntry,
} from "../lib/pulse";
import { analyzeInsider, TX_CODE_INFO } from "../lib/insider";
import { derivePriceKpis, reactionAround } from "../lib/prices";
import { deriveValuation } from "../lib/valuation";
import { smaSeries } from "../lib/technicals";
import type {
  Company, FinancialFact, Filing,
  InsiderTransaction, InstitutionalHolding,
  CorporateEvent, EarningsEvent, LateFiling, SecuritiesOffering,
  BeneficialOwnership, ProposedSale, DailyPrice,
  StatementKind, PeriodType,
} from "../lib/types";

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtStatValue(v: number): string {
  return Math.abs(v) < 1000 ? v.toFixed(2) : fmtUSD(v);
}

// ─── Local types ──────────────────────────────────────────────────────────────

type MainView = "overview" | "search" | "feed" | "calendar" | "guide" | "company";
type CompanyTab = "overview" | "strategy" | "fundamentals" | "peers" | "ownership" | "catalysts" | "filings";

// ─── Utilities ────────────────────────────────────────────────────────────────

function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch { return undefined; }
}

function tickerHue(t: string): number {
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// ─── Atoms ────────────────────────────────────────────────────────────────────

function FormBadge({ form }: { form: string }) {
  const c = formColorVar(form);
  return (
    <span style={{
      fontSize: 10, letterSpacing: "0.08em", padding: "2px 7px",
      border: `1px solid ${c}44`, color: c, background: `${c}14`,
      borderRadius: 4, whiteSpace: "nowrap", fontWeight: 700, display: "inline-block",
    }}>
      {form}
    </span>
  );
}

// Cache CompanyMark styles by ticker+size to avoid string recomputation
const _markCache = new Map<string, React.CSSProperties>();
function companyMarkStyle(ticker: string, size: number): React.CSSProperties {
  const key = `${ticker}:${size}`;
  if (_markCache.has(key)) return _markCache.get(key)!;
  const h = tickerHue(ticker);
  const s: React.CSSProperties = {
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

function CompanyMark({ ticker, size = 32 }: { ticker: string; size?: number }) {
  return <div style={companyMarkStyle(ticker, size)}>{ticker.slice(0, 2)}</div>;
}

// A filer/manager name with an inline context tooltip when it's a known entity
// (index manager, activist, bank, etc.) — and a small "who" tag for activists.
function NameContext({ name }: { name: string | null | undefined }) {
  if (!name) return <span className="dimmed">—</span>;
  const e = entityContext(name);
  if (!e) return <span>{name}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {name}
      <InfoTip def={`${e.label}. ${e.note}`} />
    </span>
  );
}

function KpiTile({
  label, value, fmt, qoq, yoy,
}: {
  label: string; value: number | null;
  fmt: "usd" | "pct" | "num";
  qoq: number | null; yoy: number | null;
}) {
  const formatted =
    fmt === "usd" ? fmtUSD(value) :
    fmt === "pct" ? fmtPct(value) :
    fmtNum(value);
  return (
    <div className="kpi">
      <div className="k-label">{label}<InfoTip term={label} /></div>
      <div className="k-value">{formatted}</div>
      <div className="k-delta">
        {qoq != null && <span className={qoq >= 0 ? "pos" : "neg"}>{fmtDelta(qoq)} QoQ</span>}
        {yoy != null && <span className={yoy >= 0 ? "pos" : "neg"}>{fmtDelta(yoy)} YoY</span>}
      </div>
    </div>
  );
}

// Compact EOD-price metric strip: last close, distance from the 52-week high, and
// trailing returns. Returns are colored; price feed is end-of-day, not realtime.
function PriceStrip({ k }: { k: ReturnType<typeof derivePriceKpis> }) {
  const Ret = ({ label, v }: { label: string; v: number | null }) => (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className={`k-value ${v == null ? "" : v >= 0 ? "pos" : "neg"}`}>{v == null ? "—" : fmtDelta(v)}</div>
    </div>
  );
  return (
    <div className="kpi-strip dense">
      <div className="kpi">
        <div className="k-label">Last<InfoTip term="EOD price" /></div>
        <div className="k-value">{fmtUSD(k.last)}</div>
        <div className="k-delta"><span className="muted">{k.asOf ? fmtDate(k.asOf) : ""}</span></div>
      </div>
      <div className="kpi">
        <div className="k-label">Off 52-wk High<InfoTip term="% off 52-wk high" /></div>
        <div className={`k-value ${k.pctOffHigh == null ? "" : k.pctOffHigh > -3 ? "pos" : k.pctOffHigh < -25 ? "neg" : ""}`}>
          {k.pctOffHigh == null ? "—" : fmtPct(k.pctOffHigh)}
        </div>
      </div>
      <Ret label="YTD" v={k.retYTD} />
      <Ret label="3M" v={k.ret3M} />
      <Ret label="1M" v={k.ret1M} />
    </div>
  );
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function SkeletonKpi() {
  return (
    <div className="skeleton-kpi">
      <div className="skeleton" style={{ height: 10, width: "45%" }} />
      <div className="skeleton" style={{ height: 26, width: "65%" }} />
      <div className="skeleton" style={{ height: 10, width: "55%" }} />
    </div>
  );
}

function SkeletonChart({ height = 220 }: { height?: number }) {
  return (
    <div className="skeleton-chart">
      <div className="skeleton" style={{ height: 10, width: "35%", marginBottom: 14 }} />
      <div className="skeleton" style={{ height }} />
    </div>
  );
}

function LoadingFundamentals() {
  return (
    <div className="skeleton-block">
      <div className="kpi-strip">
        {[0, 1, 2, 3, 4, 5].map((i) => <SkeletonKpi key={i} />)}
      </div>
      <SkeletonChart height={300} />
      <div className="chart-grid">
        <SkeletonChart /><SkeletonChart /><SkeletonChart /><SkeletonChart />
      </div>
    </div>
  );
}

function LoadingOwnership() {
  return (
    <div className="skeleton-block">
      <div className="chart-grid">
        <SkeletonChart /><SkeletonChart />
      </div>
      <SkeletonChart height={180} />
    </div>
  );
}

function LoadingCatalysts() {
  return (
    <div className="skeleton-block">
      <div className="chart-grid">
        <SkeletonChart /><SkeletonChart />
      </div>
      <SkeletonChart height={160} />
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({
  companies, filings, activeCik, view, ingestedCiks,
  onCompany, onOverview, onSearch, onFeed, onCalendar, onGuide, onRemove, newFilings = 0,
}: {
  companies: Company[]; filings: Filing[];
  activeCik: string | null; view: MainView;
  ingestedCiks: Set<string>;
  onCompany: (cik: string) => void;
  onOverview: () => void; onSearch: () => void; onFeed: () => void; onCalendar: () => void; onGuide: () => void;
  onRemove: (cik: string) => void;
  newFilings?: number;
}) {
  const recent30 = useMemo(() => {
    const cutoff = Date.now() - 30 * 86_400_000;
    const m = new Map<string, number>();
    for (const f of filings) {
      if (f.filed_at && new Date(f.filed_at).getTime() > cutoff)
        m.set(f.cik, (m.get(f.cik) ?? 0) + 1);
    }
    return m;
  }, [filings]);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand" onClick={onOverview}>
        Summa<span className="dot">.</span>
      </div>
      <nav className="sidebar-nav">
        <div className={`nav-item${view === "overview" ? " active" : ""}`} onClick={onOverview}>
          ◈ Overview
        </div>
        <div className={`nav-item${view === "search" ? " active" : ""}`} onClick={onSearch}>
          ⌕ Search Companies
        </div>
        <div className={`nav-item${view === "feed" ? " active" : ""}`} onClick={onFeed}>
          ≡ Feed
          {newFilings > 0 && <span className="nav-badge" title={`${newFilings} new since your last visit`}>{newFilings > 99 ? "99+" : newFilings}</span>}
        </div>
        <div className={`nav-item${view === "calendar" ? " active" : ""}`} onClick={onCalendar}>
          ◷ Calendar
        </div>
        <div className={`nav-item${view === "guide" ? " active" : ""}`} onClick={onGuide}>
          ◇ Data Guide
        </div>
      </nav>
      <div className="sidebar-list-head">
        <span className="label-caps">Watchlist · {companies.length}</span>
        <button className="sidebar-add-btn" title="Search & add companies" onClick={onSearch}>+ Add</button>
      </div>
      <div className="sidebar-list">
        {companies.map((c) => {
          const cnt = recent30.get(c.cik) ?? 0;
          const pending = !ingestedCiks.has(c.cik);
          return (
            <div
              key={c.cik}
              className={`company-row${activeCik === c.cik ? " active" : ""}`}
              onClick={() => onCompany(c.cik)}
            >
              <CompanyMark ticker={c.ticker ?? "?"} size={22} />
              <span className="tkr">{c.ticker}</span>
              <span className="nm">{c.name}</span>
              {pending ? <span className="pending-dot" title="Queued — data appears after the next pipeline run">⏳</span>
                       : cnt > 0 ? <span className="cnt">{cnt}</span> : null}
              <button
                className="row-remove" title="Remove from watchlist"
                onClick={(e) => { e.stopPropagation(); onRemove(c.cik); }}
              >×</button>
            </div>
          );
        })}
        {companies.length === 0 && (
          <div className="sidebar-empty">Your watchlist is empty. <span className="link-like" onClick={onSearch}>Search companies</span> to add some.</div>
        )}
      </div>
    </aside>
  );
}

// ─── Watchlist-wide pulse (shared by Scanner + Calendar) ────────────────────────
//
// Fetches the six event-driven slices across the whole watchlist in one pass and
// partitions them per company into the CompanyData bundle that pulse.ts consumes.
// Deliberately omits heavy fundamentals/13F/prices: the scanner and calendar are
// catalyst surfaces ("what just happened / what's actionable"), and buildSignals
// degrades gracefully when those slices are absent.
function useWatchlistPulse(companies: Company[]): { entries: WatchEntry[]; loading: boolean } {
  const [bundles, setBundles] = useState<Record<string, CompanyData>>({});
  const [loading, setLoading] = useState(true);
  const ciks = useMemo(() => companies.map((c) => c.cik), [companies]);
  const cikKey = ciks.join(",");

  useEffect(() => {
    if (!ciks.length) { setBundles({}); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchRecentInsider(ciks), fetchRecentEarnings(ciks), fetchRecentEvents(ciks),
      fetchRecentBeneficial(ciks), fetchRecentOfferings(ciks), fetchRecentLateFilings(ciks),
    ]).then(([ins, ea, ev, ben, off, late]) => {
      if (cancelled) return;
      const by: Record<string, CompanyData> = {};
      const slot = (cik: string) =>
        (by[cik] ??= { insider: [], earnings: [], events: [], beneficial: [], offers: [], lateF: [] });
      for (const r of ins)  slot(r.cik).insider!.push(r);
      for (const r of ea)   slot(r.cik).earnings!.push(r);
      for (const r of ev)   slot(r.cik).events!.push(r);
      for (const r of ben)  slot(r.cik).beneficial!.push(r);
      for (const r of off)  slot(r.cik).offers!.push(r);
      for (const r of late) slot(r.cik).lateF!.push(r);
      setBundles(by);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cikKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo<WatchEntry[]>(
    () => companies.map((c) => ({
      cik: c.cik, ticker: c.ticker ?? "?", name: c.name ?? c.cik, data: bundles[c.cik] ?? {},
    })),
    [companies, bundles],
  );
  return { entries, loading };
}

// ─── Signal Scanner (watchlist-wide, ranked) ────────────────────────────────────
// The landing surface: every actionable signal across the watchlist, ranked most-
// actionable first (see buildWatchlistSignals), filterable by direction. Reuses the
// exact SignalCard used inside the company cockpit.
function ScannerSection({
  companies, onCompany, isNew,
}: { companies: Company[]; onCompany: (cik: string) => void; isNew?: (iso: string | null | undefined) => boolean }) {
  const { entries, loading } = useWatchlistPulse(companies);
  const [dir, setDir] = useState<Direction | "all">("all");

  const rows = useMemo(() => buildWatchlistSignals(entries).filter((r) => r.signals.length > 0), [entries]);
  const shown = useMemo(() => {
    if (dir === "all") return rows;
    return rows
      .map((r) => ({ ...r, signals: r.signals.filter((s) => s.dir === dir) }))
      .filter((r) => r.signals.length > 0);
  }, [rows, dir]);
  const counts = useMemo(() => {
    let bull = 0, bear = 0, flag = 0;
    for (const r of rows) for (const s of r.signals) {
      if (s.dir === "bull") bull++; else if (s.dir === "bear") bear++; else if (s.dir === "flag") flag++;
    }
    return { bull, bear, flag };
  }, [rows]);

  return (
    <div className="section">
      <div className="section-title">Live Signals · {rows.length} compan{rows.length === 1 ? "y" : "ies"} active</div>
      <div className="toggle-row">
        <button className={`chip${dir === "all" ? " active" : ""}`} onClick={() => setDir("all")}>All</button>
        <button className={`chip${dir === "bull" ? " active" : ""}`} onClick={() => setDir(dir === "bull" ? "all" : "bull")}>▲ Bullish {counts.bull}</button>
        <button className={`chip${dir === "bear" ? " active" : ""}`} onClick={() => setDir(dir === "bear" ? "all" : "bear")}>▼ Bearish {counts.bear}</button>
        <button className={`chip${dir === "flag" ? " active" : ""}`} onClick={() => setDir(dir === "flag" ? "all" : "flag")}>◆ Flags {counts.flag}</button>
      </div>
      {loading ? (
        <div className="skeleton-block">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 84, borderRadius: 6, opacity: 0.8 - i * 0.18 }} />)}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-note">No active signals across your watchlist yet. Signals appear as filings are ingested.</div>
      ) : (
        <div className="scan-list">
          {shown.map((r) => (
            <div
              key={r.cik} className={`scan-row dir-${r.dominant}`} role="button" tabIndex={0}
              onClick={() => onCompany(r.cik)}
              onKeyDown={(e) => { if (e.key === "Enter") onCompany(r.cik); }}
            >
              <div className="scan-head">
                <CompanyMark ticker={r.ticker} size={26} />
                <strong style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>{r.ticker}</strong>
                <span className="dimmed" style={{ fontSize: 12 }}>{r.name}</span>
                <span className="scan-meta">
                  {isNew?.(r.latest) && <span className="new-dot" title="New activity since your last visit">NEW</span>}
                  {r.insider.clusterBuy && <span className="dir-bull" style={{ fontSize: 11 }}>⚑ cluster buy</span>}
                  {elapsed(r.latest) && <span className="muted" style={{ fontSize: 11 }} title={fmtDate(r.latest)}>{elapsed(r.latest)}</span>}
                </span>
              </div>
              <div className="signal-stack">
                {r.signals.map((s) => <SignalCard key={s.label} s={s} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Catalyst Calendar (watchlist-wide event timeline) ──────────────────────────
function CalendarView({
  companies, onCompany,
}: { companies: Company[]; onCompany: (cik: string) => void }) {
  const { entries, loading } = useWatchlistPulse(companies);
  const [kind, setKind] = useState<string>("all");

  const tape = useMemo(() => buildWatchlistTape(entries), [entries]);
  const kinds = useMemo(() => Array.from(new Set(tape.map((t) => t.kind))), [tape]);
  const shown = useMemo(() => (kind === "all" ? tape : tape.filter((t) => t.kind === kind)), [tape, kind]);

  // Group by calendar day; `tape` is already date-desc so groups stay newest-first.
  const groups = useMemo(() => {
    const m = new Map<string, TapeItem[]>();
    for (const t of shown) {
      const day = t.date.slice(0, 10);
      const arr = m.get(day) ?? [];
      arr.push(t);
      m.set(day, arr);
    }
    return Array.from(m.entries());
  }, [shown]);

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Catalyst Calendar</h1>
        <div className="page-sub">{tape.length} events across {companies.length} compan{companies.length === 1 ? "y" : "ies"} · recent &amp; dated disclosures</div>
      </div>
      <div className="toggle-row">
        <button className={`chip${kind === "all" ? " active" : ""}`} onClick={() => setKind("all")}>All</button>
        {kinds.map((k) => (
          <button key={k} className={`chip${kind === k ? " active" : ""}`} onClick={() => setKind(kind === k ? "all" : k)}>{k}</button>
        ))}
      </div>
      {loading ? (
        <div className="skeleton-block">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 30, borderRadius: 4, opacity: 0.85 - i * 0.12 }} />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="empty-note">No catalyst events recorded across your watchlist yet.</div>
      ) : (
        <div className="cal-groups">
          {groups.map(([day, items]) => (
            <div key={day} className="cal-group">
              <div className="cal-date">{fmtDate(day)}</div>
              <div className="cal-items">
                {items.map((t, i) => (
                  <div
                    key={`${t.cik}-${i}`} className={`tape-row dir-${t.dir}`} role="button" tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => t.cik && onCompany(t.cik)}
                    onKeyDown={(e) => { if (e.key === "Enter" && t.cik) onCompany(t.cik); }}
                  >
                    <span className="tape-kind" style={{ minWidth: 70 }}>{t.kind}</span>
                    <strong style={{ color: "var(--accent)", minWidth: 52, letterSpacing: "0.04em" }}>{t.ticker}</strong>
                    <span className="tape-head">
                      <span className="tape-head-text" title={t.headline}>{t.headline}</span>
                      {t.note && <InfoTip def={t.note} />}
                    </span>
                    <DirMark dir={t.dir} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Search / Browse all companies ──────────────────────────────────────────────
// The universal company finder, promoted from the sidebar into a full dashboard
// view. Searches the bundled SEC index (~all US public companies) client-side and
// lets the user add any of them to the watchlist (which queues backend ingestion).
function SearchPage({
  secIndex, watched, ingestedCiks, onAdd, onCompany,
}: {
  secIndex: SecCompany[];
  watched: Set<string>;
  ingestedCiks: Set<string>;
  onAdd: (c: SecCompany) => void;
  onCompany: (cik: string) => void;
}) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");   // settled query — only updates once typing pauses

  // Nothing is shown while you're typing; the search runs ~350ms after you stop, so
  // "blackrock"/"BLK" resolves once you've finished the word rather than flashing
  // partial matches for "b", "bl", "bla"…
  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(id);
  }, [q]);

  const typing = q.trim() !== query;   // entered text hasn't settled into a search yet

  const results = useMemo(
    () => (query ? searchSec(secIndex, query, 250) : []),
    [query, secIndex],
  );

  const cols: Column<SecCompany>[] = [
    {
      key: "ticker", header: "Ticker", width: "130px", value: (c) => c.ticker,
      render: (c) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CompanyMark ticker={c.ticker || "?"} size={22} />
          <strong style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>{c.ticker}</strong>
        </div>
      ),
    },
    { key: "name", header: "Company", value: (c) => c.name },
    {
      key: "status", header: "Status", width: "140px",
      value: (c) => (ingestedCiks.has(c.cik) ? "2" : watched.has(c.cik) ? "1" : "0"),
      render: (c) => ingestedCiks.has(c.cik)
        ? <span className="cat-chip sector">In warehouse</span>
        : watched.has(c.cik)
          ? <span className="cat-chip">Watchlisted</span>
          : <span className="dimmed">—</span>,
    },
    {
      key: "action", header: "", width: "92px", align: "right", value: () => "",
      render: (c) => watched.has(c.cik)
        ? <span style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12 }} title="Open">Open ↗</span>
        : <button className="chip" onClick={(e) => { e.stopPropagation(); onAdd(c); }}>+ Add</button>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Search Companies</h1>
        <div className="page-sub">
          {secIndex.length.toLocaleString()} US public companies · search any ticker or name and add it to your watchlist to ingest its filings.
        </div>
      </div>
      <div className="toggle-row">
        <input
          className="dt-filter" style={{ borderRadius: 5, width: 340 }}
          placeholder="Search ticker or company name…" value={q}
          onChange={(e) => setQ(e.target.value)} autoFocus
        />
      </div>
      {query && !typing && (
        <div className="section">
          <div className="section-title">Results for “{query}” · {results.length.toLocaleString()}{results.length === 250 ? "+" : ""}</div>
          <DataTable
            columns={cols} rows={results} rowKey={(c) => c.cik}
            onRowClick={(c) => (watched.has(c.cik) || ingestedCiks.has(c.cik) ? onCompany(c.cik) : onAdd(c))}
            filterable={false}
            empty={secIndex.length ? "No company matches your search." : "Company index not loaded yet."}
          />
        </div>
      )}
      {q.trim() && typing && (
        <div className="empty-note" style={{ marginTop: 4 }}>Searching…</div>
      )}
      {!q.trim() && (
        <div className="empty-note" style={{ marginTop: 4 }}>
          Start typing a ticker or company name to search {secIndex.length.toLocaleString()} companies, then pause to see matches.
        </div>
      )}
    </div>
  );
}

// ─── Overview page ────────────────────────────────────────────────────────────

type PriceRow = { last: number | null; chg1d: number | null; offHigh: number | null; spark: number[] };

function OverviewPage({
  companies, filings, onCompany, isNew,
}: { companies: Company[]; filings: Filing[]; onCompany: (cik: string) => void; isNew?: (iso: string | null | undefined) => boolean }) {
  // Per-company recent prices for the sparkline + price columns (one batched fetch).
  const [priceRows, setPriceRows] = useState<Record<string, PriceRow>>({});
  const ciks = useMemo(() => companies.map((c) => c.cik), [companies]);
  const cikKey = ciks.join(",");
  useEffect(() => {
    if (!ciks.length) { setPriceRows({}); return; }
    let cancelled = false;
    fetchRecentPrices(ciks, 370).then((rows) => {
      if (cancelled) return;
      const by = new Map<string, DailyPrice[]>();
      for (const r of rows) { const a = by.get(r.cik) ?? []; a.push(r); by.set(r.cik, a); }
      const out: Record<string, PriceRow> = {};
      for (const [cik, prc] of by) {
        const k = derivePriceKpis(prc);
        const closes = prc.map((p) => p.close).filter((x): x is number => x != null);
        const prev = closes.length > 1 ? closes[closes.length - 2] : null;
        const chg1d = k.last != null && prev != null && prev !== 0 ? ((k.last - prev) / prev) * 100 : null;
        out[cik] = { last: k.last, chg1d, offHigh: k.pctOffHigh, spark: closes.slice(-60) };
      }
      setPriceRows(out);
    });
    return () => { cancelled = true; };
  }, [cikKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  const volumeData = useMemo(() => {
    const buckets = new Map<string, Record<string, number>>();
    for (const f of filings) {
      if (!f.filed_at) continue;
      const d = new Date(f.filed_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key) ?? {};
      b[f.form_type] = (b[f.form_type] ?? 0) + 1;
      buckets.set(key, b);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, counts]) => ({ x: key, ...counts }));
  }, [filings]);

  const formTypes = useMemo(() => {
    const s = new Set<string>();
    for (const f of filings) s.add(f.form_type);
    return Array.from(s).sort();
  }, [filings]);

  const lastFiling = useMemo(() => {
    const m = new Map<string, Filing>();
    for (const f of [...filings].reverse()) {
      if (!m.has(f.cik)) m.set(f.cik, f);
    }
    return m;
  }, [filings]);

  const cnt30 = useMemo(() => {
    const cutoff = Date.now() - 30 * 86_400_000;
    const m = new Map<string, number>();
    for (const f of filings) {
      if (f.filed_at && new Date(f.filed_at).getTime() > cutoff)
        m.set(f.cik, (m.get(f.cik) ?? 0) + 1);
    }
    return m;
  }, [filings]);

  const cols: Column<Company>[] = [
    {
      key: "ticker", header: "Ticker", width: "110px",
      value: (c) => c.ticker ?? "",
      render: (c) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CompanyMark ticker={c.ticker ?? "?"} size={22} />
          <strong style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>{c.ticker}</strong>
        </div>
      ),
    },
    { key: "name", header: "Company", value: (c) => c.name ?? "" },
    {
      key: "sector", header: "Industry",
      value: (c) => profileFor(c.ticker, c.sector, c.industry, c.cik)?.industry ?? "",
      render: (c) => {
        const p = profileFor(c.ticker, c.sector, c.industry, c.cik);
        if (!p) return <span className="dimmed">—</span>;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>{p.industry !== "—" ? p.industry : (p.sector !== "—" ? p.sector : "—")}</span>
            {p.sector !== "—" && p.industry !== "—" && <span className="dimmed" style={{ fontSize: 10 }}>{p.sector}</span>}
          </div>
        );
      },
    },
    {
      key: "last", header: "Last", align: "right", width: "78px",
      value: (c) => priceRows[c.cik]?.last ?? -1,
      render: (c) => { const p = priceRows[c.cik]; return p?.last != null ? <span className="dt-num">{fmtUSD(p.last)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "chg1d", header: "Δ% 1d", align: "right", width: "70px",
      value: (c) => priceRows[c.cik]?.chg1d ?? -999,
      render: (c) => { const v = priceRows[c.cik]?.chg1d; return v != null ? <span className={`dt-num ${v >= 0 ? "pos" : "neg"}`}>{fmtDelta(v)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "offhi", header: "Off Hi", align: "right", width: "70px",
      value: (c) => priceRows[c.cik]?.offHigh ?? -999,
      render: (c) => { const v = priceRows[c.cik]?.offHigh; return v != null ? <span className={`dt-num ${v > -3 ? "pos" : v < -25 ? "neg" : "muted"}`}>{fmtPct(v)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "trend", header: "Trend (3mo)", width: "84px",
      value: () => "",
      render: (c) => { const s = priceRows[c.cik]?.spark; return s && s.length > 1 ? <Sparkline values={s} /> : <span className="dimmed">—</span>; },
    },
    {
      key: "last_filing", header: "Last Filing",
      value: (c) => lastFiling.get(c.cik)?.filed_at ?? "",
      render: (c) => {
        const lf = lastFiling.get(c.cik);
        if (!lf) return <span className="dimmed">—</span>;
        const ago = elapsed(lf.filed_at);
        return (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <FormBadge form={lf.form_type} />
            <span className="muted" title={fmtDate(lf.filed_at)}>{ago || fmtDate(lf.filed_at)}</span>
          </div>
        );
      },
    },
    {
      key: "cnt", header: "30d", align: "right", width: "55px",
      value: (c) => cnt30.get(c.cik) ?? 0,
      render: (c) => {
        const n = cnt30.get(c.cik) ?? 0;
        return <span className="dt-num" style={{ color: n > 0 ? "var(--accent)" : "var(--fg-4)" }}>{n}</span>;
      },
    },
  ];

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Watchlist Overview</h1>
        <div className="page-sub">{companies.length} companies · {filings.length} filings loaded</div>
      </div>

      {/* What's actionable right now, across the whole watchlist. */}
      <ScannerSection companies={companies} onCompany={onCompany} isNew={isNew} />

      <div className="section">
        <div className="section-title">Watchlist · {companies.length} companies</div>
        <DataTable
          columns={cols} rows={companies} rowKey={(c) => c.cik}
          onRowClick={(c) => onCompany(c.cik)}
          initialSort={{ key: "ticker", dir: "asc" }}
          filterable filterPlaceholder="Filter companies…"
          empty="No companies."
        />
      </div>

      {volumeData.length > 1 && (
        <div className="section">
          <div className="section-title">Filing Volume by Month</div>
          <StackedBarChart
            data={volumeData}
            keys={formTypes.map((ft) => ({ key: ft, name: ft }))}
            title="Filings by form type"
          />
        </div>
      )}
    </div>
  );
}

// ─── Data Guide page ────────────────────────────────────────────────────────
//
// Reference glossary. Every data domain the warehouse tracks is defined here and
// ranked by how directly it tends to move the share price, so a shareholder knows
// what to watch first. Tiers are ordered high → low impact intentionally.

type ImpactTier = "high" | "medium" | "signal";

type DataDef = {
  name: string;
  source: string;        // SEC form / feed the data comes from
  where: string;         // where in this app to find it
  definition: string;    // what the numbers actually are
  why: string;           // why it moves the stock for shareholders
};

const IMPACT_TIERS: { tier: ImpactTier; label: string; blurb: string; items: DataDef[] }[] = [
  {
    tier: "high",
    label: "High impact — direct price drivers",
    blurb: "Disclosures that routinely move a stock the same day they hit the wire. Watch these first.",
    items: [
      {
        name: "Earnings Results & Guidance",
        source: "8-K · Item 2.02",
        where: "Company → Catalysts",
        definition: "Quarterly revenue, diluted EPS, and net income, plus any change to forward guidance (raised / lowered / withdrawn / maintained).",
        why: "A beat or miss versus analyst expectations is the single most common cause of a large one-day move. A guidance change resets the market's whole forward valuation.",
      },
      {
        name: "Material Corporate Events",
        source: "8-K",
        where: "Company → Catalysts",
        definition: "Classified disclosures of mergers & acquisitions, financial restatements, executive departures, capital returns (buybacks / dividends), and cyber incidents.",
        why: "An 8-K exists precisely to flag events a reasonable investor would consider important. M&A and restatements can move a stock 20%+ in a session.",
      },
      {
        name: "Activist & Large-Stake Ownership",
        source: "SC 13D / 13G",
        where: "Company → Ownership",
        definition: "A filing triggered when an investor crosses 5% ownership. 13D signals intent to influence the company (activist); 13G is a passive stake.",
        why: "Activist positions often precede board fights, spin-offs, or buyout pressure. The market reacts to the filer's reputation and the stated purpose of the stake.",
      },
      {
        name: "Insider Transactions",
        source: "Form 4",
        where: "Company → Ownership",
        definition: "Open-market buys and sells by officers and directors, with price, share count, resulting holdings, and whether the trade was under a pre-planned 10b5-1 plan.",
        why: "Cluster buying by insiders is a well-documented bullish signal; large discretionary selling can signal lost confidence in the near-term outlook.",
      },
    ],
  },
  {
    tier: "medium",
    label: "Medium impact — valuation & capital flows",
    blurb: "Sets the fair value of the equity and the supply of shares. Moves the price over quarters more than over hours.",
    items: [
      {
        name: "Fundamentals (Financial Statements)",
        source: "10-K · 10-Q",
        where: "Company → Fundamentals",
        definition: "Income statement, balance sheet, and cash-flow trends — revenue growth, margins, debt levels, and free cash flow over time.",
        why: "These anchor the long-term fair value. Deteriorating margins or rising leverage erode the price gradually even when no single headline lands.",
      },
      {
        name: "Securities Offerings",
        source: "S-1 · S-3 · 424B",
        where: "Company → Catalysts",
        definition: "New issuance of stock or debt and the dollar amount raised.",
        why: "Equity offerings dilute existing shareholders and usually pressure the price short-term. Debt raises change the company's risk profile and interest burden.",
      },
      {
        name: "Institutional Holdings",
        source: "13F-HR",
        where: "Company → Ownership",
        definition: "Quarterly positions of institutional managers (>$100M AUM): shares held, position value, and quarter-over-quarter change.",
        why: "Shows 'smart money' accumulation or distribution — but it is filed up to 45 days after quarter-end, so it confirms a trend rather than predicting one.",
      },
    ],
  },
  {
    tier: "signal",
    label: "Signals & red flags — early-warning context",
    blurb: "Rarely move the price alone, but they front-run the disclosures above. Treat them as leading indicators.",
    items: [
      {
        name: "Late-Filing Notices",
        source: "NT 10-K · NT 10-Q",
        where: "Company → Catalysts",
        definition: "A notification that a required report will be filed late, together with the stated reason.",
        why: "Often the first public sign of accounting problems, internal-control weakness, or distress — frequently a leading indicator of a sharp decline.",
      },
      {
        name: "Proposed Insider Sales",
        source: "Form 144",
        where: "Company → Ownership",
        definition: "An insider's notice of intent to sell restricted stock — proposed share count and approximate value, before any sale executes.",
        why: "Signals selling intent ahead of the executed Form 4. Weaker than an actual transaction, but a useful early warning of insider distribution.",
      },
      {
        name: "Filing Volume & Velocity",
        source: "All forms",
        where: "Overview · Feed",
        definition: "How many filings a company submits and how fast, surfaced as the 30-day count and the filing-volume chart.",
        why: "A sudden burst of 8-Ks or an unusual filing cadence is context, not a verdict — it tells you where to look closer among the higher-impact data.",
      },
    ],
  },
];

function ImpactPill({ tier }: { tier: ImpactTier }) {
  const label = tier === "high" ? "High" : tier === "medium" ? "Medium" : "Signal";
  return <span className={`impact-pill impact-${tier}`}>{label}</span>;
}

function GuidePage() {
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Data Guide</h1>
        <div className="page-sub">
          What every data point means — and how much it tends to move the share price. Ordered most to least impactful.
        </div>
      </div>

      {IMPACT_TIERS.map((group) => (
        <div className="section" key={group.tier}>
          <div className="guide-tier-head">
            <ImpactPill tier={group.tier} />
            <div>
              <div className={`guide-tier-label tier-${group.tier}`}>{group.label}</div>
              <div className="guide-tier-blurb">{group.blurb}</div>
            </div>
          </div>
          <div className="guide-grid">
            {group.items.map((d) => (
              <div className={`guide-card tier-${group.tier}`} key={d.name}>
                <div className="guide-card-head">
                  <span className="guide-card-name">{d.name}</span>
                  <span className="guide-card-source">{d.source}</span>
                </div>
                <div className="guide-def">{d.definition}</div>
                <div className="guide-why">
                  <span className="guide-why-label">Why it matters</span> {d.why}
                </div>
                <div className="guide-where">Find it in: <span>{d.where}</span></div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Feed page ────────────────────────────────────────────────────────────────

function FeedPage({ filings, onCompany }: { filings: Filing[]; onCompany: (cik: string) => void }) {
  const [q, setQ] = useState("");
  const [formFilter, setFormFilter] = useState<string | null>(null);

  const formTypes = useMemo(() => {
    const s = new Set<string>();
    for (const f of filings) s.add(f.form_type);
    return Array.from(s).sort();
  }, [filings]);

  const displayed = useMemo(() => {
    let r = filings;
    if (formFilter) r = r.filter((f) => f.form_type === formFilter);
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((f) =>
        (f.company_name ?? "").toLowerCase().includes(n) ||
        (f.ticker ?? "").toLowerCase().includes(n),
      );
    }
    return r;
  }, [filings, q, formFilter]);

  const cols: Column<Filing>[] = [
    {
      key: "ticker", header: "Ticker", width: "70px",
      value: (f) => f.ticker ?? "",
      render: (f) => (
        <button
          style={{
            background: "none", border: "none", padding: 0, cursor: "pointer",
            color: "var(--accent)", fontWeight: 700,
            fontFamily: "inherit", fontSize: "inherit",
          }}
          onClick={(e) => { e.stopPropagation(); onCompany(f.cik); }}
        >
          {f.ticker}
        </button>
      ),
    },
    { key: "company", header: "Company", value: (f) => f.company_name ?? "" },
    {
      key: "form", header: "Form", width: "80px",
      value: (f) => f.form_type,
      render: (f) => <FormBadge form={f.form_type} />,
    },
    {
      key: "filed", header: "Filed",
      value: (f) => f.filed_at ?? "",
      render: (f) => {
        const ago = elapsed(f.filed_at);
        return (
          <span className="muted" title={fmtDate(f.filed_at)}>
            {ago || fmtDate(f.filed_at)}
          </span>
        );
      },
    },
    {
      key: "period", header: "Period",
      value: (f) => f.period_of_report ?? "",
      render: (f) => <span className="dimmed">{fmtDate(f.period_of_report)}</span>,
    },
    {
      key: "link", header: "", width: "30px",
      value: () => "",
      render: (f) => {
        const href = safeHref(f.filing_url);
        return href
          ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-4)" }}>↗</a>
          : null;
      },
    },
  ];

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          Filing Feed
          <span className="live-dot" title="Live — new filings appear in real time" />
        </h1>
        <div className="page-sub">{filings.length} filings loaded · updates in real time</div>
      </div>
      <div className="toggle-row">
        <input
          className="dt-filter"
          style={{ borderRadius: 5, width: 220 }}
          placeholder="Search…" value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className={`chip${formFilter === null ? " active" : ""}`} onClick={() => setFormFilter(null)}>
          All
        </button>
        {formTypes.map((ft) => (
          <button
            key={ft}
            className={`chip${formFilter === ft ? " active" : ""}`}
            onClick={() => setFormFilter(formFilter === ft ? null : ft)}
          >
            {ft}
          </button>
        ))}
      </div>
      <DataTable
        columns={cols} rows={displayed} rowKey={(f) => f.accession_number}
        filterable={false}
        initialSort={{ key: "filed", dir: "desc" }}
        empty="No filings match." maxHeight="calc(100vh - 240px)"
      />
    </div>
  );
}

// ─── Company page ─────────────────────────────────────────────────────────────

function CompanyPage({
  cik, tab, companies, onTab, pending = false,
}: { cik: string; tab: CompanyTab; companies: Company[]; onTab: (t: CompanyTab) => void; pending?: boolean }) {
  const company = companies.find((c) => c.cik === cik) ?? null;
  const [facts, setFacts] = useState<FinancialFact[]>([]);
  const [loadingFacts, setLoadingFacts] = useState(true);

  useEffect(() => {
    setFacts([]);
    setLoadingFacts(true);
    fetchFinancialFacts(cik).then((d) => { setFacts(d); setLoadingFacts(false); });
  }, [cik]);

  const ticker = company?.ticker ?? "?";
  const name = company?.name ?? cik;
  const profile = profileFor(ticker, company?.sector, company?.industry, cik);

  const TABS: { key: CompanyTab; label: string }[] = [
    { key: "overview",      label: "Overview" },
    { key: "strategy",      label: "Strategy & Investments" },
    { key: "fundamentals",  label: "Fundamentals" },
    { key: "peers",         label: "Peers" },
    { key: "ownership",     label: "Ownership" },
    { key: "catalysts",     label: "Catalysts" },
    { key: "filings",       label: "Filings" },
  ];

  return (
    <div>
      <div className="page-head-row">
        <CompanyMark ticker={ticker} size={44} />
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">{name}</h1>
          <div className="page-sub" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span>{ticker} · CIK {cik}</span>
            {profile && profile.sector !== "—" && <span className="cat-chip sector">{profile.sector}</span>}
            {profile && profile.industry !== "—" && <span className="cat-chip">{profile.industry}</span>}
          </div>
        </div>
      </div>

      {pending && (
        <div className="pending-banner">
          <strong>⏳ Queued for ingestion.</strong> This company was added to your watchlist and
          will be pulled on the next pipeline run. Its data appears here once the backend ingests it.
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.key} className={`tab${tab === t.key ? " active" : ""}`} onClick={() => onTab(t.key)}>
            {t.label}
          </div>
        ))}
      </div>

      {tab === "overview"     && <CompanyOverviewTab cik={cik} facts={facts} loading={loadingFacts} />}
      {tab === "strategy"     && <StrategyTab cik={cik} ticker={ticker} facts={facts} loading={loadingFacts} />}
      {tab === "fundamentals" && <FundamentalsTab facts={facts} loading={loadingFacts} />}
      {tab === "peers"        && <PeersTab cik={cik} peers={companies} />}
      {tab === "ownership"    && <OwnershipTab cik={cik} />}
      {tab === "catalysts"    && <CatalystsTab cik={cik} />}
      {tab === "filings"      && <FilingsTab cik={cik} />}
    </div>
  );
}

// ─── Company cockpit ("Overview" tab) ─────────────────────────────────────────
//
// A terminal-style dashboard that answers three questions at a glance, with every
// element ranked by how directly it moves the share price:
//   01 NOW       — where the company stands (headline fundamentals)
//   02 HAPPENED  — a merged tape of recent price-moving disclosures
//   03 GOING     — synthesized forward-looking signals
// The deep dives (Fundamentals / Ownership / Catalysts / Filings) stay as tabs.

function DirMark({ dir }: { dir: Direction }) {
  const mark = dir === "bull" ? "▲" : dir === "bear" ? "▼" : dir === "flag" ? "◆" : "●";
  return <span className={`dir-mark dir-${dir}`}>{mark}</span>;
}

function TapeRow({ t }: { t: TapeItem }) {
  return (
    <div className={`tape-row dir-${t.dir}`}>
      <span className="tape-date">{fmtDate(t.date)}</span>
      <span className="tape-kind">{t.kind}</span>
      <span className="tape-head">
        <span className="tape-head-text" title={t.headline}>{t.headline}</span>
        {t.note && <InfoTip def={t.note} />}
      </span>
      <DirMark dir={t.dir} />
    </div>
  );
}

// Map each derived signal to the glossary term that explains the concept behind it.
const SIGNAL_TERM: Record<string, string> = {
  "Guidance": "Guidance",
  "Revenue Momentum": "YoY",
  "Net Margin": "Net Margin",
  "Insider Flow · 90d": "Insider",
  "Institutional Flow": "Institutional Holdings",
  "Activist Watch": "Activist",
  "Dilution Risk": "Dilution",
  "Filing Integrity": "NT 10-K",
  "Insider Cluster Buy": "Cluster buying",
  "Price vs 52-wk High": "% off 52-wk high",
  "Golden Cross": "Golden Cross",
  "Death Cross": "Death Cross",
  "52-wk Breakout": "52-wk Breakout",
  "RSI": "RSI",
  "Volume Spike": "Volume Spike",
};

function SignalCard({ s }: { s: Signal }) {
  const term = SIGNAL_TERM[s.label];
  const age = elapsed(s.date);
  return (
    <div className={`signal dir-${s.dir}`}>
      <div className="sig-top">
        <span className="sig-label">{s.label}{term && <InfoTip term={term} />}</span>
        {age && <span className="sig-age" title={fmtDate(s.date)}>{age}</span>}
        <DirMark dir={s.dir} />
      </div>
      <div className="sig-status">{s.status}</div>
      <div className="sig-detail">{s.detail}</div>
    </div>
  );
}

// ─── Health Scorecard ─────────────────────────────────────────────────────────
//
// Turns the raw data into a plain-English read a non-analyst can act on: a grade
// per dimension a shareholder cares about, an overall verdict, and a sentence or
// two of summary. Derived entirely from data the cockpit already fetched — no
// extra Supabase load.

type Grade = "strong" | "good" | "mixed" | "weak" | "na";
type ScoreDim = { label: string; grade: Grade; detail: string; term?: string };

const GRADE_RANK:  Record<Grade, number> = { strong: 2, good: 1, na: 0, mixed: -1, weak: -2 };
const GRADE_LABEL: Record<Grade, string> = { strong: "Strong", good: "Good", mixed: "Mixed", weak: "Weak", na: "—" };

function buildScorecard(d: {
  facts: FinancialFact[]; insider: InsiderTransaction[];
  offers: SecuritiesOffering[]; lateF: LateFiling[]; events: CorporateEvent[];
}): { dims: ScoreDim[]; overall: Grade; summary: string } {
  const Q = "quarterly" as const;
  const rev   = seriesFor(d.facts, "income",   Q, METRICS.revenue);
  const ni    = seriesFor(d.facts, "income",   Q, METRICS.netIncome);
  const cash  = seriesFor(d.facts, "balance",  Q, METRICS.cash);
  const debt  = seriesFor(d.facts, "balance",  Q, METRICS.longTermDebt);
  const ocf   = seriesFor(d.facts, "cashflow", Q, METRICS.operatingCF);
  const capex = seriesFor(d.facts, "cashflow", Q, METRICS.capex);
  const last = (p: { value: number }[]) => (p.length ? p[p.length - 1].value : null);
  const back = (p: { value: number }[], n: number) => (p.length > n ? p[p.length - 1 - n].value : null);

  const dims: ScoreDim[] = [];

  // Revenue growth (YoY)
  {
    const cur = last(rev), yago = back(rev, 4);
    if (cur != null && yago) {
      const g = ((cur - yago) / Math.abs(yago)) * 100;
      dims.push({
        label: "Revenue Growth", term: "YoY",
        grade: g >= 15 ? "strong" : g >= 5 ? "good" : g >= 0 ? "mixed" : "weak",
        detail: `${fmtDelta(g)} year-over-year`,
      });
    } else dims.push({ label: "Revenue Growth", grade: "na", detail: "Not enough history", term: "YoY" });
  }

  // Profitability (net margin)
  {
    const r = last(rev), n = last(ni);
    if (r && n != null) {
      const m = (n / r) * 100;
      dims.push({
        label: "Profitability", term: "Net Margin",
        grade: m >= 15 ? "strong" : m >= 5 ? "good" : m > 0 ? "mixed" : "weak",
        detail: `${fmtPct(m)} net margin`,
      });
    } else dims.push({ label: "Profitability", grade: "na", detail: "No earnings data", term: "Net Margin" });
  }

  // Balance sheet (cash vs long-term debt)
  {
    const c = last(cash);
    if (c != null) {
      const dbt = last(debt) ?? 0;
      const ratio = dbt > 0 ? c / dbt : Infinity;
      dims.push({
        label: "Balance Sheet", term: "Long-Term Debt",
        grade: ratio >= 1.5 ? "strong" : ratio >= 0.8 ? "good" : ratio >= 0.4 ? "mixed" : "weak",
        detail: dbt > 0 ? `${fmtUSD(c)} cash vs ${fmtUSD(dbt)} debt` : `${fmtUSD(c)} cash, minimal debt`,
      });
    } else dims.push({ label: "Balance Sheet", grade: "na", detail: "No balance-sheet data" });
  }

  // Cash generation (free cash flow)
  {
    const o = last(ocf);
    if (o != null) {
      const fcf = o - (last(capex) ?? 0);
      const prevO = back(ocf, 4), prevFcf = prevO != null ? prevO - (back(capex, 4) ?? 0) : null;
      const grade: Grade = fcf <= 0 ? "weak" : (prevFcf != null && fcf > prevFcf ? "strong" : "good");
      dims.push({ label: "Cash Generation", term: "Free Cash Flow", grade, detail: `${fmtUSD(fcf)} free cash flow` });
    } else dims.push({ label: "Cash Generation", grade: "na", detail: "No cash-flow data", term: "Free Cash Flow" });
  }

  // Insider sentiment (trailing 90 days) — open-market conviction only. Cluster
  // buying is the strongest tell; routine grants/options/tax sales don't count.
  {
    const ins = analyzeInsider(d.insider, 90);
    if (ins.clusterBuy) {
      dims.push({ label: "Insider Sentiment", term: "Cluster buying", grade: "strong",
        detail: `Cluster buy — ${ins.distinctBuyers} insiders bought ${fmtUSD(ins.buyValue)} open-market` });
    } else if (ins.anyOpenMarket) {
      const net = ins.netOpenMarket;
      dims.push({ label: "Insider Sentiment", term: "Open-market buy",
        grade: net > 0 ? "good" : net < 0 ? "weak" : "mixed",
        detail: net >= 0 ? `Net open-market buying (${fmtUSD(net, { sign: true })})` : `Net open-market selling (${fmtUSD(net, { sign: true })})` });
    } else if (ins.routineValue > 0) {
      dims.push({ label: "Insider Sentiment", term: "Insider", grade: "mixed",
        detail: "Routine grants / options only — no open-market trades" });
    } else {
      dims.push({ label: "Insider Sentiment", grade: "na", detail: "No recent insider trades", term: "Insider" });
    }
  }

  // Risk flags (late filings, restatements, dilution)
  {
    const restate = d.events.some((e) => e.event_class === "restatement");
    const yr = Date.now() - 365 * 86_400_000;
    const recentOffers = d.offers.filter((o) => o.filed_at && new Date(o.filed_at).getTime() > yr);
    const grade: Grade = (d.lateF.length || restate) ? "weak" : recentOffers.length ? "mixed" : "strong";
    const detail = d.lateF.length ? "Late-filing notice on record"
      : restate ? "Financial restatement on record"
      : recentOffers.length ? `${recentOffers.length} securities offering${recentOffers.length > 1 ? "s" : ""} (dilution)`
      : "No red flags detected";
    dims.push({ label: "Risk Flags", grade, detail, term: "NT 10-K" });
  }

  // Overall = average of graded dimensions.
  const graded = dims.filter((x) => x.grade !== "na");
  const avg = graded.length ? graded.reduce((s, x) => s + GRADE_RANK[x.grade], 0) / graded.length : 0;
  const overall: Grade = !graded.length ? "na" : avg >= 1.1 ? "strong" : avg >= 0.3 ? "good" : avg >= -0.6 ? "mixed" : "weak";

  // Plain-English summary.
  const wins = dims.filter((x) => x.grade === "strong" || x.grade === "good").map((x) => x.label.toLowerCase());
  const worries = dims.filter((x) => x.grade === "weak" || x.grade === "mixed");
  const verdict = { strong: "looks financially healthy", good: "is in reasonable shape", mixed: "is a mixed picture", weak: "shows signs of strain", na: "can't be assessed yet" }[overall];
  let summary = `On the numbers it has reported, this company ${verdict}.`;
  if (wins.length) summary += ` Strengths: ${wins.slice(0, 3).join(", ")}.`;
  if (worries.length) summary += ` Watch: ${worries.map((w) => `${w.label.toLowerCase()} (${w.detail.toLowerCase()})`).slice(0, 2).join("; ")}.`;
  summary += " Not investment advice — a read of the filings, not the share price.";

  return { dims, overall, summary };
}

function Scorecard({ card }: { card: { dims: ScoreDim[]; overall: Grade; summary: string } }) {
  return (
    <div className={`scorecard grade-${card.overall}`}>
      <div className="sc-top">
        <div className="sc-overall">
          <span className="sc-overall-label">Health check</span>
          <span className={`sc-badge grade-${card.overall}`}>{GRADE_LABEL[card.overall]}</span>
        </div>
        <p className="sc-summary">{card.summary}</p>
      </div>
      <div className="sc-grid">
        {card.dims.map((dm) => (
          <div key={dm.label} className={`sc-dim grade-${dm.grade}`}>
            <div className="sc-dim-top">
              <span className="sc-dim-label">{dm.label}{dm.term && <InfoTip term={dm.term} />}</span>
              <span className={`sc-dim-grade grade-${dm.grade}`}>{GRADE_LABEL[dm.grade]}</span>
            </div>
            <div className="sc-dim-detail">{dm.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompanyOverviewTab({
  cik, facts, loading,
}: { cik: string; facts: FinancialFact[]; loading: boolean }) {
  const [recentFilings, setRecentFilings] = useState<Filing[]>([]);
  const [earnings, setEarnings]     = useState<EarningsEvent[]>([]);
  const [events, setEvents]         = useState<CorporateEvent[]>([]);
  const [insider, setInsider]       = useState<InsiderTransaction[]>([]);
  const [holdings, setHoldings]     = useState<InstitutionalHolding[]>([]);
  const [beneficial, setBeneficial] = useState<BeneficialOwnership[]>([]);
  const [offers, setOffers]         = useState<SecuritiesOffering[]>([]);
  const [lateF, setLateF]           = useState<LateFiling[]>([]);
  const [prices, setPrices]         = useState<DailyPrice[]>([]);
  const [loadingAux, setLoadingAux] = useState(true);

  useEffect(() => {
    setLoadingAux(true);
    Promise.all([
      fetchFilingsForCik(cik, 10), fetchEarningsEvents(cik), fetchCorporateEvents(cik),
      fetchInsiderTransactions(cik), fetchInstitutionalHoldings(cik),
      fetchBeneficialOwnership(cik), fetchSecuritiesOfferings(cik), fetchLateFilings(cik),
      fetchPrices(cik),
    ]).then(([fil, ea, ev, ins, hol, ben, off, lat, prc]) => {
      setRecentFilings(fil); setEarnings(ea); setEvents(ev); setInsider(ins);
      setHoldings(hol); setBeneficial(ben); setOffers(off); setLateF(lat); setPrices(prc);
      setLoadingAux(false);
    });
  }, [cik]);

  const kpis = useMemo(() => (loading || !facts.length ? [] : deriveKpis(facts, "quarterly")), [facts, loading]);

  const revTrend = useMemo(() => {
    const rev = seriesFor(facts, "income", "quarterly", METRICS.revenue);
    const yoy = yoyGrowth(rev, 4);
    return rev.map((p, i) => ({ x: fmtPeriodLabel(p.period, "quarterly"), Revenue: p.value, YoY: yoy[i] }));
  }, [facts]);

  const tape    = useMemo(() => buildTape({ earnings, events, insider, beneficial, offers, lateF }), [earnings, events, insider, beneficial, offers, lateF]);
  const signals = useMemo(() => buildSignals({ facts, earnings, insider, holdings, beneficial, offers, lateF, prices }), [facts, earnings, insider, holdings, beneficial, offers, lateF, prices]);
  const scorecard = useMemo(() => buildScorecard({ facts, insider, offers, lateF, events }), [facts, insider, offers, lateF, events]);

  const priceKpis = useMemo(() => derivePriceKpis(prices), [prices]);
  const valuation = useMemo(() => deriveValuation(facts, prices), [facts, prices]);
  const priceSma  = useMemo(() => smaSeries(prices), [prices]);

  // Event markers on the price chart: snap each recent event to the close on/before
  // its date so the dot lands on a real bar, colored by the event's direction.
  const priceMarkers = useMemo(() => {
    if (priceSma.length < 2) return [];
    const dirColor: Record<string, string> = { bull: "#3fb950", bear: "#f05252", flag: "#f5a623", neutral: "#7aa2f7" };
    const out: { x: string; y: number; color: string }[] = [];
    for (const ev of events.slice(0, 24)) {
      const d = ev.event_date ?? ev.filed_at;
      if (!d) continue;
      const day = d.slice(0, 10);
      // last bar on/before the event day
      let bar: { x: string; Close: number } | null = null;
      for (const p of priceSma) { if (p.x <= day) bar = p; else break; }
      if (bar) out.push({ x: bar.x, y: bar.Close, color: dirColor[EVENT_CLASS_DIR[ev.event_class ?? "other"] ?? "neutral"] });
    }
    return out;
  }, [priceSma, events]);

  const bias = useMemo(() => {
    const b = signals.filter((s) => s.dir === "bull").length;
    const r = signals.filter((s) => s.dir === "bear").length;
    const f = signals.filter((s) => s.dir === "flag").length;
    return { b, r, f };
  }, [signals]);

  const filCols: Column<Filing>[] = [
    { key: "form", header: "Form", width: "80px", value: (f) => f.form_type, render: (f) => <FormBadge form={f.form_type} /> },
    { key: "period", header: "Period", value: (f) => f.period_of_report ?? "", render: (f) => <span className="dimmed">{fmtDate(f.period_of_report)}</span> },
    {
      key: "filed", header: "Filed", value: (f) => f.filed_at ?? "",
      render: (f) => {
        const ago = elapsed(f.filed_at);
        return <span className="muted" title={fmtDate(f.filed_at)}>{ago || fmtDate(f.filed_at)}</span>;
      },
    },
    {
      key: "link", header: "", width: "30px", value: () => "",
      render: (f) => {
        const href = safeHref(f.filing_url);
        return href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-3)" }}>↗</a> : null;
      },
    },
  ];

  return (
    <div className="cockpit">
      {/* ── 00 · HEALTH CHECK (plain-English verdict) ─────────────────────────── */}
      {loadingAux || loading ? (
        <div className="skeleton" style={{ height: 150, borderRadius: 8 }} />
      ) : (
        <Scorecard card={scorecard} />
      )}

      {/* ── 01 · NOW ──────────────────────────────────────────────────────────── */}
      <section className="ckpt-zone">
        <div className="ckpt-zone-head">
          <span className="ckpt-q">01</span> Where it stands
          <span className="ckpt-sub">latest reported fundamentals</span>
        </div>
        {kpis.length > 0 ? (
          <div className="kpi-strip dense">
            {kpis.map((k) => <KpiTile key={k.label} label={k.label} value={k.value} fmt={k.fmt} qoq={k.qoq} yoy={k.yoy} />)}
          </div>
        ) : (
          <div className="empty-note">No fundamentals parsed yet.</div>
        )}
        {priceKpis.last != null && (
          <>
            <PriceStrip k={priceKpis} />
            {valuation.marketCap != null && (
              <div className="kpi-strip dense">
                <div className="kpi">
                  <div className="k-label">Market Cap<InfoTip term="Market Cap" /></div>
                  <div className="k-value">{fmtUSD(valuation.marketCap)}</div>
                </div>
                <div className="kpi">
                  <div className="k-label">P/E (TTM)<InfoTip term="P/E (TTM)" /></div>
                  <div className="k-value">{valuation.peTTM != null ? fmtNum(valuation.peTTM, 1) : "—"}</div>
                  <div className="k-delta"><span className="muted">{valuation.epsTTM != null ? `EPS ${fmtUSD(valuation.epsTTM)}` : ""}</span></div>
                </div>
                <div className="kpi">
                  <div className="k-label">P/S (TTM)<InfoTip term="P/S (TTM)" /></div>
                  <div className="k-value">{valuation.psTTM != null ? fmtNum(valuation.psTTM, 1) : "—"}</div>
                  <div className="k-delta"><span className="muted">{valuation.revenueTTM != null ? `Rev ${fmtUSD(valuation.revenueTTM)}` : ""}</span></div>
                </div>
              </div>
            )}
            {priceSma.length > 1 && (
              <PriceChart
                data={priceSma} markers={priceMarkers}
                title="Share price (EOD, ~2y) · 50/200-day MA"
                info="End-of-day close (teal) with 50-day and 200-day moving averages. Dots mark recent 8-K events, colored by direction. Click a legend item to toggle a line; prices are EOD, not realtime."
              />
            )}
          </>
        )}
        {revTrend.length > 1 && (
          <ComboChart
            data={revTrend} barKey="Revenue" lineKey="YoY" barName="Revenue" lineName="YoY %"
            title="Revenue trend (quarterly)"
            info="Bars show quarterly revenue (left axis); the line is year-over-year growth in percent (right axis). Click a legend item to hide it; hover for exact values."
          />
        )}
      </section>

      {/* ── 02 · HAPPENED  ·  03 · GOING ──────────────────────────────────────── */}
      <div className="ckpt-split">
        <section className="ckpt-zone">
          <div className="ckpt-zone-head">
            <span className="ckpt-q">02</span> What just happened
            <span className="ckpt-sub">recent price-moving disclosures</span>
          </div>
          {loadingAux ? (
            <div className="skeleton-block">
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton" style={{ height: 30, borderRadius: 4, opacity: 0.8 - i * 0.1 }} />)}
            </div>
          ) : tape.length === 0 ? (
            <div className="empty-note">No catalyst events recorded yet.</div>
          ) : (
            <div className="tape">
              {tape.slice(0, 16).map((t, i) => <TapeRow key={`${t.date}-${t.kind}-${i}`} t={t} />)}
            </div>
          )}
        </section>

        <section className="ckpt-zone">
          <div className="ckpt-zone-head">
            <span className="ckpt-q">03</span> Where it&apos;s heading
            <span className="ckpt-sub">forward signals</span>
          </div>
          {!loadingAux && signals.length > 0 && (
            <div className="bias-bar">
              {bias.b > 0 && <span className="dir-bull">▲ {bias.b} bullish</span>}
              {bias.r > 0 && <span className="dir-bear">▼ {bias.r} bearish</span>}
              {bias.f > 0 && <span className="dir-flag">◆ {bias.f} flag{bias.f > 1 ? "s" : ""}</span>}
            </div>
          )}
          {loadingAux ? (
            <div className="skeleton-block">
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 4, opacity: 0.8 - i * 0.12 }} />)}
            </div>
          ) : signals.length === 0 ? (
            <div className="empty-note">Not enough history to derive signals.</div>
          ) : (
            <div className="signal-stack">
              {signals.map((s) => <SignalCard key={s.label} s={s} />)}
            </div>
          )}
        </section>
      </div>

      {/* ── Recent filings (raw tape) ─────────────────────────────────────────── */}
      <section className="ckpt-zone">
        <div className="ckpt-zone-head"><span className="ckpt-q">·</span> Recent filings</div>
        {loadingAux ? (
          <div className="skeleton-block">
            <div className="skeleton" style={{ height: 36, borderRadius: 4 }} />
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 32, borderRadius: 4, opacity: 0.7 - i * 0.1 }} />)}
          </div>
        ) : (
          <DataTable
            columns={filCols} rows={recentFilings} rowKey={(f) => f.accession_number}
            initialSort={{ key: "filed", dir: "desc" }} empty="No filings."
          />
        )}
      </section>
    </div>
  );
}

// ─── Strategy & Investments tab ───────────────────────────────────────────────
//
// Answers "what is this company investing in, and where is it heading?" from three
// angles: its industry category + forward themes (curated taxonomy), its own
// capital allocation (R&D and CapEx — money committed to the future), and its
// outbound investments in other companies (acquisitions + any 13F portfolio).

/** Prefer annual series for a clean multi-year story; fall back to quarterly. */
function annualOrQuarterly(facts: FinancialFact[], statement: StatementKind, match: (f: FinancialFact) => boolean) {
  const a = seriesFor(facts, statement, "annual", match);
  if (a.length > 1) return { points: a, period: "annual" as PeriodType };
  return { points: seriesFor(facts, statement, "quarterly", match), period: "quarterly" as PeriodType };
}

function StrategyTab({
  cik, ticker, facts, loading,
}: { cik: string; ticker: string; facts: FinancialFact[]; loading: boolean }) {
  const [events, setEvents]     = useState<CorporateEvent[]>([]);
  const [portfolio, setPortfolio] = useState<InstitutionalHolding[]>([]);
  const [loadingAux, setLoadingAux] = useState(true);

  useEffect(() => {
    setLoadingAux(true);
    Promise.all([fetchCorporateEvents(cik), fetchManagerHoldings(cik)])
      .then(([ev, pf]) => { setEvents(ev); setPortfolio(pf); setLoadingAux(false); });
  }, [cik]);

  const profile = profileFor(ticker, null, null, cik);

  // Capital allocation: R&D and CapEx are the clearest "investing in the future" lines.
  const rd     = useMemo(() => annualOrQuarterly(facts, "income", METRICS.rAndD), [facts]);
  const capex  = useMemo(() => annualOrQuarterly(facts, "cashflow", METRICS.capex), [facts]);

  const rdData = useMemo(() => {
    if (rd.points.length < 2) return [];
    const rev = seriesFor(facts, "income", rd.period, METRICS.revenue);
    const revAt = new Map(rev.map((p) => [p.period, p.value]));
    return rd.points.map((p) => {
      const r = revAt.get(p.period);
      return { x: fmtPeriodLabel(p.period, rd.period), rd: p.value, pct: r ? (p.value / r) * 100 : null };
    });
  }, [rd, facts]);

  const capexData = useMemo(
    () => (capex.points.length < 2 ? [] : capex.points.map((p) => ({ x: fmtPeriodLabel(p.period, capex.period), CapEx: p.value }))),
    [capex],
  );

  const acquisitions = useMemo(() => events.filter((e) => e.event_class === "M&A"), [events]);

  // Latest reported portfolio quarter, ranked by position value.
  const latestPortfolio = useMemo(() => {
    if (portfolio.length === 0) return [];
    const latest = portfolio.reduce((m, h) => (h.period_of_report > m ? h.period_of_report : m), portfolio[0].period_of_report);
    return portfolio.filter((h) => h.period_of_report === latest).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }, [portfolio]);

  const acqCols: Column<CorporateEvent>[] = [
    { key: "date", header: "Date", width: "110px", value: (e) => e.event_date ?? e.filed_at ?? "", render: (e) => <span className="muted">{fmtDate(e.event_date ?? e.filed_at)}</span> },
    { key: "summary", header: "Deal / Strategic Move", value: (e) => e.summary ?? "", render: (e) => <span>{e.summary ?? "—"}</span> },
  ];

  const pfCols: Column<InstitutionalHolding>[] = [
    { key: "ticker", header: "Holding", width: "90px", value: (h) => h.ticker ?? h.cik, render: (h) => <strong style={{ color: "var(--accent)" }}>{h.ticker ?? h.cik}</strong> },
    { key: "value", header: "Position Value", align: "right", value: (h) => h.value ?? 0, render: (h) => <span className="dt-num">{fmtUSD(h.value)}</span> },
    { key: "shares", header: "Shares", align: "right", value: (h) => h.shares ?? 0, render: (h) => <span className="dt-num">{fmtNum(h.shares, 0)}</span> },
    { key: "pct", header: "% of Portfolio", align: "right", value: (h) => h.pct_of_portfolio ?? 0, render: (h) => <span className="dt-num">{h.pct_of_portfolio != null ? fmtPct(h.pct_of_portfolio) : "—"}</span> },
  ];

  return (
    <div className="cockpit">
      {/* ── Direction: industry category + forward themes ─────────────────────── */}
      <section className="ckpt-zone">
        <div className="ckpt-zone-head">
          <span className="ckpt-q">◧</span> Industry &amp; future direction
          <span className="ckpt-sub">where the company plays, and what it&apos;s betting on next</span>
        </div>
        {profile ? (
          <div className="strategy-head">
            <div className="cat-row">
              {profile.sector !== "—" && <span className="cat-chip sector">{profile.sector}</span>}
              {profile.industry !== "—" && <span className="cat-chip">{profile.industry}</span>}
            </div>
            {profile.thesis && <p className="strategy-focus">{profile.thesis}</p>}
            {profile.themes.length > 0 && (
              <>
                <div className="label-caps" style={{ marginBottom: 10 }}>Investing in / next-trend bets</div>
                <div className="theme-grid">
                  {profile.themes.map((t) => (
                    <div key={t.name} className="theme-card">
                      <div className="theme-name">{t.name}</div>
                      <div className="theme-note">{t.note}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="empty-note">No industry profile on file for this company.</div>
        )}
      </section>

      {/* ── Capital allocation: money committed to the future ─────────────────── */}
      <section className="ckpt-zone">
        <div className="ckpt-zone-head">
          <span className="ckpt-q">$</span> Investment in the future
          <span className="ckpt-sub">R&amp;D and capital expenditure</span>
        </div>
        {loading ? (
          <div className="chart-grid"><SkeletonChart /><SkeletonChart /></div>
        ) : rdData.length === 0 && capexData.length === 0 ? (
          <div className="empty-note">No R&amp;D or CapEx history parsed yet.</div>
        ) : (
          <div className="chart-grid">
            {rdData.length > 1 && (
              <ComboChart
                data={rdData} barKey="rd" lineKey="pct" barName="R&D" lineName="% of Revenue"
                title="R&D Investment & Intensity"
                info="Bars: absolute research & development spend (left axis). Line: R&D as a percent of revenue (right axis) — how much of every sales dollar is reinvested into innovation."
              />
            )}
            {capexData.length > 1 && (
              <SimpleBarChart
                data={capexData} barKey="CapEx" title="Capital Expenditure"
                info="Cash spent on property, plant, and equipment — physical investment in future capacity (data centers, factories, fabs)."
              />
            )}
          </div>
        )}
      </section>

      {/* ── Outbound: investing in other companies ────────────────────────────── */}
      <section className="ckpt-zone">
        <div className="ckpt-zone-head">
          <span className="ckpt-q">⇄</span> Investing in other companies
          <span className="ckpt-sub">acquisitions &amp; strategic deals</span>
        </div>
        {loadingAux ? (
          <div className="skeleton-block">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 32, borderRadius: 4, opacity: 0.8 - i * 0.15 }} />)}</div>
        ) : acquisitions.length === 0 ? (
          <div className="empty-note">No M&amp;A or strategic-investment events recorded (from 8-K Item 1.01 / 2.01).</div>
        ) : (
          <DataTable columns={acqCols} rows={acquisitions} rowKey={(e) => e.accession_number}
            initialSort={{ key: "date", dir: "desc" }} maxHeight="320px" empty="None." />
        )}
      </section>

      {/* ── Disclosed equity portfolio (only if the company files 13F) ────────── */}
      {!loadingAux && latestPortfolio.length > 0 && (
        <section className="ckpt-zone">
          <div className="ckpt-zone-head">
            <span className="ckpt-q">▦</span> Disclosed equity portfolio
            <span className="ckpt-sub">stakes this company reports holding (Form 13F)</span>
          </div>
          <DataTable columns={pfCols} rows={latestPortfolio} rowKey={(h) => `${h.cik}|${h.period_of_report}`}
            initialSort={{ key: "value", dir: "desc" }} filterable filterPlaceholder="Filter holdings…" maxHeight="360px" />
        </section>
      )}
    </div>
  );
}

// ─── Fundamentals tab ─────────────────────────────────────────────────────────

function FundamentalsTab({ facts, loading }: { facts: FinancialFact[]; loading: boolean }) {
  const [periodType, setPeriodType] = useState<PeriodType>("quarterly");
  const [stmt, setStmt]             = useState<StatementKind>("income");

  const matrix = useMemo(() => facts.length ? pivotStatement(facts, stmt, periodType) : null, [facts, stmt, periodType]);
  const kpis   = useMemo(() => deriveKpis(facts, periodType), [facts, periodType]);
  const lag    = periodType === "quarterly" ? 4 : 1;

  // Income series
  const rev  = useMemo(() => seriesFor(facts, "income", periodType, METRICS.revenue),        [facts, periodType]);
  const gp   = useMemo(() => seriesFor(facts, "income", periodType, METRICS.grossProfit),     [facts, periodType]);
  const oi   = useMemo(() => seriesFor(facts, "income", periodType, METRICS.operatingIncome), [facts, periodType]);
  const ni   = useMemo(() => seriesFor(facts, "income", periodType, METRICS.netIncome),       [facts, periodType]);
  const eps  = useMemo(() => seriesFor(facts, "income", periodType, METRICS.epsDiluted),      [facts, periodType]);
  const rd   = useMemo(() => seriesFor(facts, "income", periodType, METRICS.rAndD),           [facts, periodType]);
  const sga  = useMemo(() => seriesFor(facts, "income", periodType, METRICS.sgAndA),          [facts, periodType]);

  // Balance sheet series
  const cash    = useMemo(() => seriesFor(facts, "balance", periodType, METRICS.cash),         [facts, periodType]);
  const debt    = useMemo(() => seriesFor(facts, "balance", periodType, METRICS.longTermDebt),  [facts, periodType]);
  const assets  = useMemo(() => seriesFor(facts, "balance", periodType, METRICS.totalAssets),   [facts, periodType]);
  const equity  = useMemo(() => seriesFor(facts, "balance", periodType, METRICS.equity),        [facts, periodType]);

  // Cash-flow series
  const ocf   = useMemo(() => seriesFor(facts, "cashflow", periodType, METRICS.operatingCF),  [facts, periodType]);
  const capex = useMemo(() => seriesFor(facts, "cashflow", periodType, METRICS.capex),         [facts, periodType]);

  const pt = (p: string) => fmtPeriodLabel(p, periodType);

  // Chart data
  const revData = useMemo(() => {
    const yoy = yoyGrowth(rev, lag);
    return rev.map((p, i) => ({ x: pt(p.period), rev: p.value, yoy: yoy[i] }));
  }, [rev, lag, periodType]);

  // Align income series by period using rev as anchor
  const incomeData = useMemo(() => {
    const byPeriod = new Map<string, Record<string, number | null>>();
    const add = (arr: typeof rev, key: string) => {
      for (const p of arr) {
        const row = byPeriod.get(p.period) ?? {};
        row[key] = p.value;
        byPeriod.set(p.period, row);
      }
    };
    add(oi, "Operating Income");
    add(ni, "Net Income");
    return Array.from(byPeriod.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, vals]) => ({ x: pt(period), ...vals }));
  }, [oi, ni, periodType]);

  const marginData = useMemo(() => {
    const byPeriod = new Map<string, Record<string, number | null>>();
    const revMap = new Map(rev.map((p) => [p.period, p.value]));
    const add = (arr: typeof rev, key: string, divisor?: Map<string, number>) => {
      for (const p of arr) {
        const d = (divisor ?? revMap).get(p.period);
        if (!d) continue;
        const row = byPeriod.get(p.period) ?? {};
        row[key] = (p.value / d) * 100;
        byPeriod.set(p.period, row);
      }
    };
    add(gp, "Gross %");
    add(oi, "Op %");
    add(ni, "Net %");
    return Array.from(byPeriod.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, vals]) => ({ x: pt(period), ...vals }))
      .filter((d) => Object.values(d).some((v) => typeof v === "number" && v !== null));
  }, [rev, gp, oi, ni, periodType]);

  const epsData     = useMemo(() => eps.map((p) => ({ x: pt(p.period), EPS: p.value })),         [eps, periodType]);
  const cashDebt    = useMemo(() => cash.map((p, i) => ({ x: pt(p.period), Cash: p.value, Debt: debt[i]?.value ?? 0 })), [cash, debt, periodType]);
  const assetEqData = useMemo(() => assets.map((p, i) => ({ x: pt(p.period), Assets: p.value, Equity: equity[i]?.value ?? 0 })), [assets, equity, periodType]);
  const expData     = useMemo(() => {
    const byPeriod = new Map<string, Record<string, number | null>>();
    const add = (arr: typeof rd, key: string) => {
      for (const p of arr) { const row = byPeriod.get(p.period) ?? {}; row[key] = p.value; byPeriod.set(p.period, row); }
    };
    add(rd, "R&D"); add(sga, "SG&A");
    return Array.from(byPeriod.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([period, v]) => ({ x: pt(period), ...v }));
  }, [rd, sga, periodType]);

  const fcfData = useMemo(() => {
    const m = new Map<string, { o: number; c: number }>();
    for (const p of ocf)   { m.set(p.period, { o: p.value, c: 0 }); }
    for (const p of capex) { const e = m.get(p.period); if (e) e.c = Math.abs(p.value); }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([period, { o, c }]) => ({ x: pt(period), FCF: o - c }));
  }, [ocf, capex, periodType]);

  const cfData = useMemo(() => {
    const m = new Map<string, Record<string, number | null>>();
    const add = (arr: typeof ocf, key: string) => {
      for (const p of arr) { const row = m.get(p.period) ?? {}; row[key] = p.value; m.set(p.period, row); }
    };
    add(ocf, "Operating"); add(capex, "CapEx");
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([period, v]) => ({ x: pt(period), ...v }));
  }, [ocf, capex, periodType]);

  // Additional series — per-share and working capital
  const shares    = useMemo(() => seriesFor(facts, "income",  periodType, METRICS.sharesOutstanding),     [facts, periodType]);
  const curAssets = useMemo(() => seriesFor(facts, "balance", periodType, METRICS.currentAssets),         [facts, periodType]);
  const curLiab   = useMemo(() => seriesFor(facts, "balance", periodType, METRICS.currentLiabilities),    [facts, periodType]);

  const sharesData = useMemo(() =>
    shares.map((p) => ({ x: pt(p.period), Shares: p.value })),
  [shares, periodType]);

  const workCapData = useMemo(() => {
    const m = new Map<string, { a: number; l: number }>();
    for (const p of curAssets) m.set(p.period, { a: p.value, l: 0 });
    for (const p of curLiab)  { const e = m.get(p.period); if (e) e.l = p.value; }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, { a, l }]) => ({ x: pt(period), "Working Capital": a - l }))
      .filter((d) => d["Working Capital"] !== 0);
  }, [curAssets, curLiab, periodType]);

  const stmtLabels: { key: StatementKind; label: string }[] = [
    { key: "income",   label: "Income" },
    { key: "balance",  label: "Balance Sheet" },
    { key: "cashflow", label: "Cash Flow" },
  ];

  if (loading) return <LoadingFundamentals />;
  if (!facts.length) return (
    <div className="empty-note">
      <strong>No financial data yet.</strong><br />
      Run <code>python main.py</code> in the backend to populate XBRL fundamentals.
    </div>
  );

  return (
    <div>
      {kpis.length > 0 && (
        <div className="kpi-strip">
          {kpis.map((k) => <KpiTile key={k.label} label={k.label} value={k.value} fmt={k.fmt} qoq={k.qoq} yoy={k.yoy} />)}
        </div>
      )}

      <div className="toggle-row">
        {(["quarterly", "annual"] as PeriodType[]).map((p) => (
          <button key={p} className={`chip${periodType === p ? " active" : ""}`} onClick={() => setPeriodType(p)}>
            {p === "quarterly" ? "Quarterly" : "Annual"}
          </button>
        ))}
        <span className="chip-sep">|</span>
        {stmtLabels.map((s) => (
          <button key={s.key} className={`chip${stmt === s.key ? " active" : ""}`} onClick={() => setStmt(s.key)}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Statement table */}
      {matrix && (
        <div className="section">
          <div className="dt-wrap">
            <div className="dt-scroll" style={{ maxHeight: 400, overflowY: "auto" }}>
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: 240, position: "sticky", left: 0, background: "var(--bg-1)", zIndex: 2 }}>Line Item</th>
                    {matrix.periods.slice(0, 8).map((p) => (
                      <th key={p} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {fmtPeriodLabel(p, periodType)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row) => {
                    const isHighlight = /^(total|net income|gross profit|operating income|revenue|earnings per)/i.test(row.label);
                    return (
                      <tr key={row.concept} style={isHighlight ? { fontWeight: 600 } : undefined}>
                        <td style={{
                          color: isHighlight ? "var(--fg-0)" : "var(--fg-1)",
                          position: "sticky", left: 0,
                          background: isHighlight ? "var(--bg-2)" : "var(--bg-1)",
                          paddingLeft: 12,
                        }}>
                          {row.label}
                        </td>
                        {row.values.slice(0, 8).map((v, i) => (
                          <td key={i} className="dt-num"
                            style={{ color: v != null ? (isHighlight ? "var(--fg-0)" : "var(--fg-1)") : "var(--fg-4)" }}>
                            {v != null ? fmtStatValue(v) : "—"}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Income charts */}
      <div className="section">
        <div className="section-title">Income</div>
        <div className="chart-grid">
          {revData.length > 1 && (
            <ComboChart data={revData} barKey="rev" lineKey="yoy" barName="Revenue" lineName="YoY %" title="Revenue & YoY Growth"
              info="Bars: total sales per period (left axis). Line: year-over-year growth rate, which strips out seasonality (right axis)." />
          )}
          {incomeData.length > 1 && oi.length > 1 && (
            <PairedBarChart data={incomeData} keyA="Operating Income" keyB="Net Income" nameA="Op. Income" nameB="Net Income" title="Operating & Net Income"
              info="Operating income is profit from core operations before interest and taxes. Net income is the final bottom line after everything." />
          )}
          {marginData.length > 1 && (
            <MultiLineChart
              data={marginData}
              lines={[
                ...(gp.length > 1 ? [{ key: "Gross %", name: "Gross Margin" }] : []),
                ...(oi.length > 1 ? [{ key: "Op %",    name: "Op. Margin"   }] : []),
                ...(ni.length > 1 ? [{ key: "Net %",   name: "Net Margin"   }] : []),
              ]}
              title="Margin Trends"
              info="Each line is a profit margin — profit as a percent of revenue — at a different stage. Rising margins mean the business is getting more efficient. Click the legend to isolate one."
            />
          )}
          {epsData.length > 1 && (
            <SimpleBarChart data={epsData} barKey="EPS" title="Diluted EPS" signed
              info="Diluted earnings per share: net income spread across all shares that would exist if every option and convertible were exercised — the most conservative per-share profit." />
          )}
          {expData.length > 1 && (rd.length > 1 || sga.length > 1) && (
            <StackedBarChart
              data={expData}
              keys={[
                ...(rd.length  > 1 ? [{ key: "R&D",   name: "R&D"   }] : []),
                ...(sga.length > 1 ? [{ key: "SG&A",  name: "SG&A"  }] : []),
              ]}
              title="Operating Expenses"
            />
          )}
        </div>
      </div>

      {/* Balance sheet charts */}
      {(cashDebt.length > 1 || assetEqData.length > 1 || workCapData.length > 1 || sharesData.length > 1) && (
        <div className="section">
          <div className="section-title">Balance Sheet & Per-Share</div>
          <div className="chart-grid">
            {cashDebt.length > 1 && (
              <PairedBarChart data={cashDebt} keyA="Cash" keyB="Debt" nameA="Cash" nameB="L/T Debt" title="Cash vs Long-Term Debt"
                info="Liquidity (cash & marketable securities) set against long-term borrowings. More cash than debt is a sign of balance-sheet strength." />
            )}
            {assetEqData.length > 1 && (
              <PairedBarChart data={assetEqData} keyA="Assets" keyB="Equity" nameA="Total Assets" nameB="Equity" title="Assets & Stockholders' Equity" />
            )}
            {workCapData.length > 1 && (
              <SimpleBarChart data={workCapData} barKey="Working Capital" title="Working Capital (Current Assets − Current Liabilities)" signed />
            )}
            {sharesData.length > 1 && (
              <SimpleBarChart data={sharesData} barKey="Shares" title="Diluted Shares Outstanding" />
            )}
          </div>
        </div>
      )}

      {/* Cash flow charts */}
      {(fcfData.length > 1 || cfData.length > 1) && (
        <div className="section">
          <div className="section-title">Cash Flow</div>
          <div className="chart-grid">
            {fcfData.length > 1 && (
              <SimpleBarChart data={fcfData} barKey="FCF" title="Free Cash Flow" signed
                info="Free cash flow = operating cash flow minus capital expenditures. The cash a business actually generates after funding its own operations and equipment." />
            )}
            {cfData.length > 1 && (
              <PairedBarChart data={cfData} keyA="Operating" keyB="CapEx" nameA="Operating CF" nameB="CapEx" title="Operating CF vs CapEx"
                info="Operating cash flow is cash from core operations; CapEx is cash spent on property and equipment. Operating CF comfortably above CapEx funds growth without borrowing." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Ownership tab ────────────────────────────────────────────────────────────

// ─── Peers tab — compare the company against the rest of the watchlist ──────────
type PeerRow = {
  cik: string; ticker: string; name: string;
  revG: number | null; netMargin: number | null; pe: number | null; ps: number | null; mcap: number | null;
};

function PeersTab({ cik, peers }: { cik: string; peers: Company[] }) {
  const [facts, setFacts]   = useState<FinancialFact[]>([]);
  const [prices, setPrices] = useState<DailyPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const ciks = useMemo(() => peers.map((p) => p.cik), [peers]);
  const cikKey = ciks.join(",");

  useEffect(() => {
    if (!ciks.length) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchIncomeFactsForCiks(ciks), fetchRecentPrices(ciks, 15)]).then(([f, p]) => {
      if (cancelled) return;
      setFacts(f); setPrices(p); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cikKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<PeerRow[]>(() => {
    const factsBy = new Map<string, FinancialFact[]>();
    for (const f of facts) { const a = factsBy.get(f.cik) ?? []; a.push(f); factsBy.set(f.cik, a); }
    const pxBy = new Map<string, DailyPrice[]>();
    for (const p of prices) { const a = pxBy.get(p.cik) ?? []; a.push(p); pxBy.set(p.cik, a); }
    return peers.map((c) => {
      const ff = factsBy.get(c.cik) ?? [];
      const rev = seriesFor(ff, "income", "quarterly", METRICS.revenue);
      const ni  = seriesFor(ff, "income", "quarterly", METRICS.netIncome);
      const revG = rev.length >= 5 && rev[rev.length - 5].value
        ? ((rev[rev.length - 1].value - rev[rev.length - 5].value) / Math.abs(rev[rev.length - 5].value)) * 100 : null;
      const r = rev.at(-1)?.value, n = ni.at(-1)?.value;
      const netMargin = r && n != null ? (n / r) * 100 : null;
      const val = deriveValuation(ff, pxBy.get(c.cik) ?? []);
      return { cik: c.cik, ticker: c.ticker ?? "?", name: c.name ?? c.cik, revG, netMargin, pe: val.peTTM, ps: val.psTTM, mcap: val.marketCap };
    });
  }, [peers, facts, prices]);

  const median = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const med = useMemo(() => ({
    revG: median(rows.map((r) => r.revG)), netMargin: median(rows.map((r) => r.netMargin)),
    pe: median(rows.map((r) => r.pe)), ps: median(rows.map((r) => r.ps)),
  }), [rows]);

  const cols: Column<PeerRow>[] = [
    { key: "ticker", header: "Ticker", width: "96px", value: (r) => r.ticker,
      render: (r) => <strong style={{ color: r.cik === cik ? "var(--accent)" : undefined }}>{r.ticker}{r.cik === cik ? " ◂" : ""}</strong> },
    { key: "revG", header: "Rev YoY", align: "right", value: (r) => r.revG ?? -9999,
      render: (r) => r.revG != null ? <span className={`dt-num ${r.revG >= 0 ? "pos" : "neg"}`}>{fmtDelta(r.revG)}</span> : <span className="dimmed">—</span> },
    { key: "nm", header: "Net Margin", align: "right", value: (r) => r.netMargin ?? -9999,
      render: (r) => r.netMargin != null ? <span className="dt-num">{fmtPct(r.netMargin)}</span> : <span className="dimmed">—</span> },
    { key: "pe", header: "P/E", align: "right", value: (r) => r.pe ?? -1,
      render: (r) => r.pe != null ? <span className="dt-num">{fmtNum(r.pe, 1)}</span> : <span className="dimmed">—</span> },
    { key: "ps", header: "P/S", align: "right", value: (r) => r.ps ?? -1,
      render: (r) => r.ps != null ? <span className="dt-num">{fmtNum(r.ps, 1)}</span> : <span className="dimmed">—</span> },
    { key: "mcap", header: "Market Cap", align: "right", value: (r) => r.mcap ?? -1,
      render: (r) => r.mcap != null ? <span className="dt-num">{fmtUSD(r.mcap)}</span> : <span className="dimmed">—</span> },
  ];

  if (loading) return <div className="section"><div className="skeleton" style={{ height: 160, borderRadius: 8 }} /></div>;
  if (peers.length < 2) return <div className="empty-note">Add more companies to your watchlist to compare peers.</div>;

  return (
    <div className="section">
      <div className="section-title">Peer comparison · your watchlist</div>
      <div className="page-sub" style={{ marginBottom: 10 }}>
        The active company (◂) vs your watchlist. Median — Rev YoY {med.revG != null ? fmtDelta(med.revG) : "—"} · Net margin {med.netMargin != null ? fmtPct(med.netMargin) : "—"} · P/E {med.pe != null ? fmtNum(med.pe, 1) : "—"} · P/S {med.ps != null ? fmtNum(med.ps, 1) : "—"}. Valuation uses a diluted-share proxy.
      </div>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.cik} initialSort={{ key: "mcap", dir: "desc" }} empty="No peer data." />
    </div>
  );
}

function OwnershipTab({ cik }: { cik: string }) {
  const [insider,    setInsider]    = useState<InsiderTransaction[]>([]);
  const [holdings,   setHoldings]   = useState<InstitutionalHolding[]>([]);
  const [beneficial, setBeneficial] = useState<BeneficialOwnership[]>([]);
  const [proposed,   setProposed]   = useState<ProposedSale[]>([]);
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchInsiderTransactions(cik),
      fetchInstitutionalHoldings(cik),
      fetchBeneficialOwnership(cik),
      fetchProposedSales(cik),
    ]).then(([ins, hld, ben, prop]) => {
      setInsider(ins); setHoldings(hld); setBeneficial(ben); setProposed(prop);
      setLoading(false);
    });
  }, [cik]);

  // ── Insider charts ─────────────────────────────────────────────────────────

  // Net share flow by month (diverging bar)
  const netFlowData = useMemo(() => {
    const m = new Map<string, number>();
    for (const tx of insider) {
      if (!tx.transaction_date) continue;
      const d = new Date(tx.transaction_date);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const sign = tx.acquired_disposed === "D" ? -1 : 1;
      m.set(key, (m.get(key) ?? 0) + (tx.shares ?? 0) * sign);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([x, net]) => ({ x, net }));
  }, [insider]);

  // Cumulative net shares over time
  const cumulativeData = useMemo(() => {
    let cum = 0;
    return netFlowData.map(({ x, net }) => { cum += net; return { x, cumulative: cum }; });
  }, [netFlowData]);

  // Open-market-only insider read for the quality strip (90-day window).
  const insiderRead = useMemo(() => analyzeInsider(insider, 90), [insider]);

  // Buy vs sell dollar volume by quarter
  const buySellData = useMemo(() => {
    const m = new Map<string, { Buy: number; Sell: number }>();
    for (const tx of insider) {
      if (!tx.transaction_date || !tx.value) continue;
      const d = new Date(tx.transaction_date);
      if (Number.isNaN(d.getTime())) continue;
      const q = Math.floor(d.getMonth() / 3) + 1;
      const key = `${d.getFullYear()} Q${q}`;
      const row = m.get(key) ?? { Buy: 0, Sell: 0 };
      if (tx.acquired_disposed === "A") row.Buy  += Math.abs(tx.value);
      else                               row.Sell += Math.abs(tx.value);
      m.set(key, row);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([x, v]) => ({ x, ...v }));
  }, [insider]);

  // Top insiders by total value bought or sold
  const topInsiderData = useMemo(() => {
    const m = new Map<string, number>();
    for (const tx of insider) {
      if (!tx.filer_name || !tx.value) continue;
      const name = tx.filer_name;
      m.set(name, (m.get(name) ?? 0) + Math.abs(tx.value));
    }
    return Array.from(m.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, value]) => ({ label: name, value }));
  }, [insider]);

  // ── Institutional charts ───────────────────────────────────────────────────

  // Top holders by value (latest period)
  const topHoldersData = useMemo(() => {
    const periods = Array.from(new Set(holdings.map((h) => h.period_of_report))).sort();
    const latest = periods[periods.length - 1];
    if (!latest) return [];
    return holdings
      .filter((h) => h.period_of_report === latest)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .slice(0, 12)
      .map((h) => ({
        label: h.manager_name.replace(/ (?:GROUP|CORP|CORPORATION|LLC|LLP|INC|LTD|ADVISORS|MANAGEMENT)\.?$/i, ""),
        value: h.value ?? 0,
      }));
  }, [holdings]);

  // Count of managers holding stock per quarter
  const managerCountData = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of holdings) m.set(h.period_of_report, (m.get(h.period_of_report) ?? 0) + 1);
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, count]) => ({ x: fmtDate(period), Managers: count }));
  }, [holdings]);

  // QoQ holdings change (latest two periods)
  const qoqDiff = useMemo(() => {
    const periods = Array.from(new Set(holdings.map((h) => h.period_of_report))).sort();
    if (periods.length < 2) return [];
    const latest = periods[periods.length - 1];
    const prior  = periods[periods.length - 2];
    const lMap = new Map(holdings.filter((h) => h.period_of_report === latest).map((h) => [h.manager_name, h]));
    const pMap = new Map(holdings.filter((h) => h.period_of_report === prior).map((h) => [h.manager_name, h]));
    const all = new Set([...lMap.keys(), ...pMap.keys()]);
    return Array.from(all).map((mgr) => {
      const cur  = lMap.get(mgr);
      const prev = pMap.get(mgr);
      const curShares  = cur?.shares  ?? 0;
      const prevShares = prev?.shares ?? 0;
      const delta = curShares - prevShares;
      const action = !prev ? "New" : !cur ? "Exited" : delta > 0 ? "Increased" : delta < 0 ? "Decreased" : "Unchanged";
      return { manager: mgr, action, shares: curShares, delta, value: cur?.value ?? prev?.value ?? 0 };
    }).filter((r) => r.action !== "Unchanged")
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [holdings]);

  // ── Column definitions ─────────────────────────────────────────────────────

  const insiderCols: Column<InsiderTransaction>[] = [
    { key: "date",  header: "Date",   value: (t) => t.transaction_date ?? "", render: (t) => <span className="muted">{fmtDate(t.transaction_date)}</span> },
    { key: "name",  header: "Insider", value: (t) => t.filer_name ?? "" },
    { key: "title", header: "Title",  value: (t) => t.filer_title ?? "", render: (t) => <span className="muted">{t.filer_title ?? "—"}</span> },
    {
      key: "type", header: "Code", width: "60px",
      value: (t) => t.transaction_code ?? t.acquired_disposed ?? "",
      render: (t) => {
        const code = (t.transaction_code ?? "").toUpperCase();
        const info = TX_CODE_INFO[code];
        return (
          <span
            className={`badge badge-${t.acquired_disposed === "A" ? "buy" : "sell"}`}
            title={info ? `${code} — ${info.label}: ${info.meaning}` : undefined}
          >
            {t.transaction_code ?? (t.acquired_disposed === "A" ? "BUY" : "SELL")}
          </span>
        );
      },
    },
    { key: "shares", header: "Shares", align: "right", value: (t) => t.shares ?? 0, render: (t) => <span className="dt-num">{fmtNum(t.shares, 0)}</span> },
    { key: "price",  header: "Price",  align: "right", value: (t) => t.price  ?? 0, render: (t) => <span className="dt-num">{fmtUSD(t.price)}</span> },
    { key: "value",  header: "Value",  align: "right", value: (t) => t.value  ?? 0, render: (t) => <span className="dt-num">{fmtUSD(t.value)}</span> },
    { key: "after",  header: "Shares After", align: "right", value: (t) => t.shares_after ?? 0, render: (t) => <span className="dt-num dimmed">{fmtNum(t.shares_after, 0)}</span> },
  ];

  const holdingsCols: Column<InstitutionalHolding>[] = [
    { key: "manager", header: "Manager",   value: (h) => h.manager_name, render: (h) => <NameContext name={h.manager_name} /> },
    { key: "period",  header: "Period",    value: (h) => h.period_of_report, render: (h) => <span className="muted">{fmtDate(h.period_of_report)}</span> },
    { key: "shares",  header: "Shares",    align: "right", value: (h) => h.shares ?? 0, render: (h) => <span className="dt-num">{fmtNum(h.shares, 0)}</span> },
    { key: "value",   header: "Value",     align: "right", value: (h) => h.value  ?? 0, render: (h) => <span className="dt-num">{fmtUSD(h.value)}</span> },
    { key: "pct",     header: "% of Fund", align: "right", value: (h) => h.pct_of_portfolio ?? 0, render: (h) => <span className="dt-num">{fmtPct(h.pct_of_portfolio)}</span> },
  ];

  type QoQRow = { manager: string; action: string; shares: number; delta: number; value: number };
  const qoqCols: Column<QoQRow>[] = [
    { key: "manager", header: "Manager", value: (r) => r.manager, render: (r) => <NameContext name={r.manager} /> },
    {
      key: "action", header: "Action", width: "80px",
      value: (r) => r.action,
      render: (r) => {
        const c = r.action === "New" ? "var(--pos)" : r.action === "Exited" ? "var(--neg)" :
                  r.action === "Increased" ? "var(--pos)" : "var(--neg)";
        return <span style={{ color: c, fontWeight: 600, fontSize: 11 }}>{r.action}</span>;
      },
    },
    { key: "delta",  header: "Δ Shares", align: "right", value: (r) => r.delta,  render: (r) => <span className={`dt-num ${r.delta >= 0 ? "pos" : "neg"}`}>{r.delta >= 0 ? "+" : ""}{fmtNum(r.delta, 0)}</span> },
    { key: "shares", header: "Shares",   align: "right", value: (r) => r.shares, render: (r) => <span className="dt-num">{fmtNum(r.shares, 0)}</span> },
    { key: "value",  header: "Value",    align: "right", value: (r) => r.value,  render: (r) => <span className="dt-num">{fmtUSD(r.value)}</span> },
  ];

  const beneficialCols: Column<BeneficialOwnership>[] = [
    { key: "filer",    header: "Filer",    value: (b) => b.filer_name ?? "", render: (b) => <NameContext name={b.filer_name} /> },
    { key: "schedule", header: "Schedule", value: (b) => b.schedule ?? "" },
    { key: "activist", header: "Activist", value: (b) => b.is_activist ? "Yes" : "No", render: (b) => b.is_activist ? <span className="pos" style={{ fontWeight: 600 }}>Yes</span> : <span className="dimmed">No</span> },
    { key: "pct",      header: "% Class",  align: "right", value: (b) => b.pct_of_class ?? 0, render: (b) => <span className="dt-num">{b.pct_of_class != null ? fmtPct(b.pct_of_class) : "—"}</span> },
    { key: "filed",    header: "Filed",    value: (b) => b.filed_at ?? "", render: (b) => <span className="muted">{fmtDate(b.filed_at)}</span> },
  ];

  const proposedCols: Column<ProposedSale>[] = [
    { key: "seller",  header: "Seller",       value: (p) => p.seller_name ?? "" },
    { key: "rel",     header: "Relationship", value: (p) => p.relationship ?? "", render: (p) => <span className="muted">{p.relationship ?? "—"}</span> },
    { key: "shares",  header: "Shares",       align: "right", value: (p) => p.shares ?? 0, render: (p) => <span className="dt-num">{fmtNum(p.shares, 0)}</span> },
    { key: "value",   header: "Approx Value", align: "right", value: (p) => p.approx_value ?? 0, render: (p) => <span className="dt-num">{fmtUSD(p.approx_value)}</span> },
    { key: "date",    header: "Approx Date",  value: (p) => p.approx_date ?? "", render: (p) => <span className="muted">{fmtDate(p.approx_date)}</span> },
    { key: "filed",   header: "Filed",        value: (p) => p.filed_at ?? "", render: (p) => <span className="muted">{fmtDate(p.filed_at)}</span> },
  ];

  if (loading) return <LoadingOwnership />;

  return (
    <div>
      {/* ── Insider Transactions ──────────────────────────────────────────── */}
      <div className="section">
        <div className="section-title">Insider Activity (<Term term="Form 4">Form 4</Term>)</div>
        {insider.length === 0 ? <div className="empty-note">No insider transaction data yet.</div> : (
          <>
            {/* Open-market conviction read — grants, option exercises and tax sales excluded. */}
            <div className="kpi-strip dense">
              <div className="kpi">
                <div className="k-label"><Term term="Open-market buy">Open-market net</Term> · 90d</div>
                <div className={`k-value ${insiderRead.anyOpenMarket ? (insiderRead.netOpenMarket >= 0 ? "pos" : "neg") : ""}`}>
                  {insiderRead.anyOpenMarket ? fmtUSD(insiderRead.netOpenMarket, { sign: true }) : "—"}
                </div>
                <div className="k-delta"><span className="muted">{fmtUSD(insiderRead.buyValue)} bought · {fmtUSD(insiderRead.sellValue)} sold</span></div>
              </div>
              <div className="kpi">
                <div className="k-label"><Term term="Cluster buying">Distinct buyers</Term></div>
                <div className={`k-value ${insiderRead.clusterBuy ? "pos" : ""}`}>{insiderRead.distinctBuyers}{insiderRead.clusterBuy ? " ⚑" : ""}</div>
                <div className="k-delta"><span className="muted">{insiderRead.distinctSellers} distinct seller{insiderRead.distinctSellers === 1 ? "" : "s"}</span></div>
              </div>
              <div className="kpi">
                <div className="k-label">Routine (excl.)</div>
                <div className="k-value dimmed">{fmtUSD(insiderRead.routineValue)}</div>
                <div className="k-delta"><span className="muted">grants / options / tax</span></div>
              </div>
            </div>
            <div className="chart-grid charts-below">
              {netFlowData.length > 1 && (
                <DivergingBarChart data={netFlowData} barKey="net" title="Net Shares Bought / Sold by Month"
                  info="Insiders' net trading each month: green above the line is net buying, red below is net selling. Cluster buying by insiders is a well-studied bullish signal." />
              )}
              {cumulativeData.length > 1 && (
                <CumulativeLineChart data={cumulativeData} lineKey="cumulative" title="Cumulative Net Insider Shares" signed
                  info="The running total of insider buys minus sells over time. A rising line means insiders have been net accumulators of their own stock." />
              )}
              {buySellData.length > 1 && (
                <PairedBarChart data={buySellData} keyA="Buy" keyB="Sell" nameA="Bought ($)" nameB="Sold ($)" title="Buy vs Sell Dollar Volume by Quarter" />
              )}
              {topInsiderData.length > 0 && (
                <HorizontalBarChart data={topInsiderData} barKey="value" labelKey="label" title="Top Insiders by Total Transaction Volume" />
              )}
            </div>
            <DataTable columns={insiderCols} rows={insider}
              rowKey={(t) => `${t.accession_number}|${t.transaction_date}|${t.transaction_code}|${t.shares}`}
              initialSort={{ key: "date", dir: "desc" }}
              filterable filterPlaceholder="Filter by insider or code…" maxHeight="320px"
            />
          </>
        )}
      </div>

      {/* ── Institutional Holdings (13F) ──────────────────────────────────── */}
      <div className="section">
        <div className="section-title">Institutional Holdings (<Term term="13F-HR">13F-HR</Term>)</div>
        {holdings.length === 0 ? <div className="empty-note">No institutional holdings data yet.</div> : (
          <>
            <div className="chart-grid charts-below">
              {topHoldersData.length > 0 && (
                <HorizontalBarChart data={topHoldersData} barKey="value" labelKey="label" title="Top Holders by Position Value (Latest Quarter)"
                  info="The largest institutional positions reported on Form 13F. These filings lag up to 45 days after quarter-end, so they confirm trends rather than predict them." />
              )}
              {managerCountData.length > 1 && (
                <SimpleBarChart data={managerCountData} barKey="Managers" title="Number of Major Institutions Holding Stock by Quarter"
                  info="How many large institutional managers hold the stock each quarter. A rising count signals broadening 'smart money' interest." />
              )}
            </div>

            {qoqDiff.length > 0 && (
              <div className="section charts-below">
                <div className="section-title">QoQ Change — Latest vs Prior Quarter</div>
                <DataTable columns={qoqCols} rows={qoqDiff}
                  rowKey={(r) => r.manager}
                  initialSort={{ key: "delta", dir: "desc" }} maxHeight="260px" empty="No changes."
                />
              </div>
            )}

            <DataTable columns={holdingsCols} rows={holdings}
              rowKey={(h) => `${h.manager_name}|${h.period_of_report}`}
              initialSort={{ key: "value", dir: "desc" }}
              filterable filterPlaceholder="Filter managers…" maxHeight="320px"
            />
          </>
        )}
      </div>

      {/* ── Beneficial Ownership (SC 13D/13G) ────────────────────────────── */}
      {beneficial.length > 0 && (
        <div className="section">
          <div className="section-title">Beneficial Ownership — Large Stakes (<Term term="SC 13D">SC 13D</Term> / <Term term="SC 13G">13G</Term>)</div>
          <DataTable columns={beneficialCols} rows={beneficial}
            rowKey={(b) => b.accession_number}
            initialSort={{ key: "filed", dir: "desc" }} maxHeight="240px" empty="None."
          />
        </div>
      )}

      {/* ── Proposed Sales (Form 144) ─────────────────────────────────────── */}
      {proposed.length > 0 && (
        <div className="section">
          <div className="section-title">Proposed Insider Sales (<Term term="Form 144">Form 144</Term>)</div>
          <DataTable columns={proposedCols} rows={proposed}
            rowKey={(p) => p.accession_number}
            initialSort={{ key: "filed", dir: "desc" }} maxHeight="200px" empty="None."
          />
        </div>
      )}
    </div>
  );
}

// ─── Catalysts tab ────────────────────────────────────────────────────────────

function EventClassBadge({ cls }: { cls: string | null }) {
  const colors: Record<string, string> = {
    "M&A": "#7aa2f7", dilution: "#f5a623", restatement: "#f05252",
    exec_change: "#bb9af7", earnings: "#4fd4c2", capital_return: "#3fb950",
    cyber: "#f05252", other: "var(--fg-4)",
  };
  const c = colors[cls ?? "other"] ?? "var(--fg-4)";
  return (
    <span style={{ color: c, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
      {cls ?? "other"}
    </span>
  );
}

function GuidanceBadge({ action }: { action: string }) {
  const c = action === "raised" ? "var(--pos)" : action === "lowered" ? "var(--neg)" : action === "withdrawn" ? "var(--warn)" : "var(--fg-2)";
  return <span style={{ color: c, fontWeight: 600 }}>{action}</span>;
}

function CatalystsTab({ cik }: { cik: string }) {
  const [events, setEvents]     = useState<CorporateEvent[]>([]);
  const [earnings, setEarnings] = useState<EarningsEvent[]>([]);
  const [lateF, setLateF]       = useState<LateFiling[]>([]);
  const [offers, setOffers]     = useState<SecuritiesOffering[]>([]);
  const [prices, setPrices]     = useState<DailyPrice[]>([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchCorporateEvents(cik), fetchEarningsEvents(cik),
      fetchLateFilings(cik), fetchSecuritiesOfferings(cik), fetchPrices(cik),
    ]).then(([ev, ea, la, of, prc]) => {
      setEvents(ev); setEarnings(ea); setLateF(la); setOffers(of); setPrices(prc);
      setLoading(false);
    });
  }, [cik]);

  // ── Chart data ─────────────────────────────────────────────────────────────

  // Event frequency by quarter, stacked by class
  const eventFreqData = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    for (const e of events) {
      if (!e.event_date) continue;
      const d = new Date(e.event_date);
      if (Number.isNaN(d.getTime())) continue;
      const q = Math.floor(d.getMonth() / 3) + 1;
      const key = `${d.getFullYear()} Q${q}`;
      const row = m.get(key) ?? {};
      const cls = e.event_class ?? "other";
      row[cls] = (row[cls] ?? 0) + 1;
      m.set(key, row);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([x, v]) => ({ x, ...v }));
  }, [events]);

  const eventClasses = useMemo(() => {
    const s = new Set(events.map((e) => e.event_class ?? "other"));
    return Array.from(s);
  }, [events]);

  // Event count by class (bar — which categories dominate)
  const classSummaryData = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.event_class ?? "other", (m.get(e.event_class ?? "other") ?? 0) + 1);
    return Array.from(m.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([label, count]) => ({ label, count }));
  }, [events]);

  // Offerings amount over time (bar)
  const offeringsData = useMemo(() =>
    offers
      .filter((o) => o.filed_at && o.amount)
      .sort((a, b) => (a.filed_at ?? "").localeCompare(b.filed_at ?? ""))
      .map((o) => ({ x: fmtDate(o.filed_at), Amount: o.amount! })),
  [offers]);

  // ── Column definitions ─────────────────────────────────────────────────────

  const eventCols: Column<CorporateEvent>[] = [
    { key: "date",    header: "Date",    value: (e) => e.event_date ?? "", render: (e) => <span className="muted">{fmtDate(e.event_date)}</span> },
    { key: "item",    header: "Item",    width: "65px", value: (e) => e.item_code ?? "", render: (e) => <strong>{e.item_code}</strong> },
    { key: "class",   header: "Class",   width: "90px", value: (e) => e.event_class ?? "", render: (e) => <EventClassBadge cls={e.event_class} /> },
    { key: "summary", header: "Summary", value: (e) => e.summary ?? "", render: (e) => <span className="muted" style={{ maxWidth: 280, display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{e.summary ?? "—"}</span> },
    {
      key: "reaction", header: "Px 1d/5d", align: "right", width: "108px",
      value: (e) => reactionAround(prices, e.event_date ?? e.filed_at).d1 ?? -999,
      render: (e) => {
        const r = reactionAround(prices, e.event_date ?? e.filed_at);
        if (r.d1 == null && r.d5 == null) return <span className="dimmed">—</span>;
        const cell = (v: number | null) => v == null ? <span className="dimmed">—</span> : <span className={v >= 0 ? "pos" : "neg"}>{fmtDelta(v)}</span>;
        return <span className="dt-num" title="Price return 1 and 5 trading days after the event">{cell(r.d1)} / {cell(r.d5)}</span>;
      },
    },
    { key: "filed",   header: "Filed",   value: (e) => e.filed_at ?? "", render: (e) => <span className="dimmed">{fmtDate(e.filed_at)}</span> },
  ];

  const earnCols: Column<EarningsEvent>[] = [
    { key: "date",    header: "Date",     value: (e) => e.reported_date ?? "", render: (e) => <span className="muted">{fmtDate(e.reported_date)}</span> },
    { key: "period",  header: "Period",   value: (e) => e.period ?? "", render: (e) => <span className="muted">{fmtDate(e.period)}</span> },
    { key: "rev",     header: "Revenue",  align: "right", value: (e) => e.revenue ?? 0, render: (e) => <span className="dt-num">{fmtUSD(e.revenue)}</span> },
    { key: "eps",     header: "EPS",      align: "right", value: (e) => e.diluted_eps ?? 0, render: (e) => <span className="dt-num">{fmtNum(e.diluted_eps)}</span> },
    { key: "guidance",header: "Guidance", value: (e) => e.guidance_action ?? "", render: (e) => e.guidance_action ? <GuidanceBadge action={e.guidance_action} /> : <span className="muted">—</span> },
  ];

  const lateCols: Column<LateFiling>[] = [
    { key: "filed",   header: "Filed",   value: (l) => l.filed_at ?? "",   render: (l) => <span className="muted">{fmtDate(l.filed_at)}</span> },
    { key: "form",    header: "NT Form", value: (l) => l.nt_form ?? "" },
    { key: "subject", header: "Subject", value: (l) => l.subject_form ?? "" },
    { key: "period",  header: "Period",  value: (l) => l.period ?? "",     render: (l) => <span className="muted">{fmtDate(l.period)}</span> },
    { key: "reason",  header: "Reason",  value: (l) => l.reason_excerpt ?? "", render: (l) => <span className="muted" style={{ maxWidth: 300, display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{l.reason_excerpt ?? "—"}</span> },
  ];

  const offerCols: Column<SecuritiesOffering>[] = [
    { key: "filed",  header: "Filed",       value: (o) => o.filed_at ?? "",       render: (o) => <span className="muted">{fmtDate(o.filed_at)}</span> },
    { key: "form",   header: "Form",        value: (o) => o.form ?? "" },
    { key: "type",   header: "Type",        value: (o) => o.offering_type ?? "",  render: (o) => <span className="muted">{o.offering_type ?? "—"}</span> },
    { key: "amount", header: "Amount",      align: "right", value: (o) => o.amount ?? 0, render: (o) => <span className="dt-num">{fmtUSD(o.amount)}</span> },
    { key: "shares", header: "Shares Sold", align: "right", value: (o) => o.shares ?? 0, render: (o) => <span className="dt-num">{fmtNum(o.shares, 0)}</span> },
  ];

  if (loading) return <LoadingCatalysts />;

  const empty = events.length === 0 && earnings.length === 0 && lateF.length === 0 && offers.length === 0;
  if (empty) return (
    <div className="empty-note">
      <strong>No catalyst data yet.</strong><br />
      Run the backend pipeline — 8-K, NT, and offering data populate automatically.
    </div>
  );

  return (
    <div>
      {/* Red flag: late filings first */}
      {lateF.length > 0 && (
        <div className="section">
          <div className="section-title alert">Late Filing Notices (NT 10-K / NT 10-Q)</div>
          <DataTable columns={lateCols} rows={lateF} rowKey={(l) => l.accession_number}
            initialSort={{ key: "filed", dir: "desc" }} maxHeight="200px" empty="None." />
        </div>
      )}

      {/* Corporate event charts */}
      {events.length > 0 && (
        <div className="section">
          <div className="section-title">Corporate Events (8-K) — {events.length} total</div>
          <div className="chart-grid charts-below">
            {eventFreqData.length > 1 && (
              <StackedBarChart
                data={eventFreqData}
                keys={eventClasses.map((cls) => ({ key: cls, name: cls }))}
                title="Event Frequency by Quarter (8-K items)"
              />
            )}
            {classSummaryData.length > 0 && (
              <HorizontalBarChart
                data={classSummaryData} barKey="count" labelKey="label"
                title="Event Count by Class" unit="events"
              />
            )}
          </div>
          <DataTable columns={eventCols} rows={events}
            rowKey={(e) => `${e.accession_number}|${e.item_code}`}
            initialSort={{ key: "date", dir: "desc" }}
            filterable filterPlaceholder="Filter by class or summary…" maxHeight="360px" empty="No events." />
        </div>
      )}

      {/* Earnings events */}
      {earnings.length > 0 && (
        <div className="section">
          <div className="section-title">Earnings Announcements (8-K Item 2.02)</div>
          <DataTable columns={earnCols} rows={earnings} rowKey={(e) => e.accession_number}
            initialSort={{ key: "date", dir: "desc" }} maxHeight="240px" empty="No earnings events." />
        </div>
      )}

      {/* Securities offerings */}
      {offers.length > 0 && (
        <div className="section">
          <div className="section-title">Securities Offerings (S-3 / 424B)</div>
          {offeringsData.length > 1 && (
            <div className="charts-below">
              <SimpleBarChart data={offeringsData} barKey="Amount" title="Offering Amount Over Time" />
            </div>
          )}
          <DataTable columns={offerCols} rows={offers} rowKey={(o) => o.accession_number}
            initialSort={{ key: "filed", dir: "desc" }} maxHeight="240px" empty="No offerings." />
        </div>
      )}
    </div>
  );
}

// ─── Filings tab ──────────────────────────────────────────────────────────────

function FilingsTab({ cik }: { cik: string }) {
  const [filings, setFilings] = useState<Filing[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchFilingsForCik(cik, 50).then((d) => { setFilings(d); setLoading(false); });
  }, [cik]);

  const cols: Column<Filing>[] = [
    { key: "form", header: "Form", width: "80px", value: (f) => f.form_type, render: (f) => <FormBadge form={f.form_type} /> },
    { key: "period", header: "Period", value: (f) => f.period_of_report ?? "", render: (f) => <span className="muted">{fmtDate(f.period_of_report)}</span> },
    { key: "filed", header: "Filed", value: (f) => f.filed_at ?? "", render: (f) => <span className="muted">{fmtDate(f.filed_at)}</span> },
    {
      key: "link", header: "", width: "30px", value: () => "",
      render: (f) => {
        const href = safeHref(f.filing_url);
        return href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-4)" }}>↗</a> : null;
      },
    },
  ];

  if (loading) return (
    <div className="skeleton-block">
      <div className="skeleton" style={{ height: 36, borderRadius: 4 }} />
      {[0,1,2,3,4,5,6].map((i) => <div key={i} className="skeleton" style={{ height: 32, borderRadius: 4, opacity: 0.8 - i * 0.08 }} />)}
    </div>
  );
  if (!filings.length) return <div className="empty-note">No filings found.</div>;

  return (
    <DataTable
      columns={cols} rows={filings} rowKey={(f) => f.accession_number}
      initialSort={{ key: "filed", dir: "desc" }}
      maxHeight="calc(100vh - 280px)" empty="No filings."
    />
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const [view, setView]           = useState<MainView>("overview");
  const [activeCik, setActiveCik] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CompanyTab>("overview");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [filings, setFilings]     = useState<Filing[]>([]);
  const [secIndex, setSecIndex]   = useState<SecCompany[]>([]);
  const [loading, setLoading]     = useState(true);
  const watch = useWatchlist();
  const seen = useLastSeen();

  // Hash routing
  useEffect(() => {
    function parse() {
      const h = window.location.hash.replace(/^#/, "");
      if (h === "search") { setView("search"); setActiveCik(null); return; }
      if (h === "feed") { setView("feed"); setActiveCik(null); return; }
      if (h === "calendar") { setView("calendar"); setActiveCik(null); return; }
      if (h === "guide") { setView("guide"); setActiveCik(null); return; }
      const m = h.match(/^c=([^/]+)(?:\/(.*))?$/);
      if (m) {
        setView("company");
        setActiveCik(m[1]);
        setActiveTab((m[2] ?? "overview") as CompanyTab);
        return;
      }
      setView("overview"); setActiveCik(null);
    }
    parse();
    window.addEventListener("hashchange", parse);
    return () => window.removeEventListener("hashchange", parse);
  }, []);

  // Initial load. Reference data (profiles/themes/entities) is fetched once here
  // and matched client-side thereafter — no per-row or per-page reads.
  useEffect(() => {
    Promise.all([
      fetchCompanies(), fetchFilings(200),
      fetchCompanyProfiles(), fetchCompanyThemes(), fetchEntities(),
    ]).then(([cos, fils, profiles, themes, entities]) => {
      loadProfiles(profiles, themes);
      loadEntities(entities);
      setCompanies(cos);
      setFilings(fils);
      setLoading(false);
    });
  }, []);

  // Realtime subscription
  useEffect(() => subscribeFilings((f) => setFilings((p) => [f, ...p].slice(0, 200))), []);

  // Bundled SEC index for universal company search (loaded once, client-side).
  useEffect(() => { loadSecIndex().then(setSecIndex); }, []);

  // First-ever visit: seed the personal watchlist from the ingested companies.
  useEffect(() => {
    if (loading) return;
    watch.seedIfEmpty(companies.map((c) => ({ cik: c.cik, ticker: c.ticker ?? "?", name: c.name ?? c.cik })));
  }, [loading, companies, watch.seedIfEmpty]);  // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = useCallback((hash: string) => { window.location.hash = hash; }, []);
  const openCompany = useCallback((cik: string, tab: CompanyTab = "overview") => {
    navigate(`c=${cik}${tab !== "overview" ? `/${tab}` : ""}`);
  }, [navigate]);

  // Ingested = data already in the warehouse; the rest of the watchlist is pending.
  const ingestedCiks = useMemo(() => new Set(companies.map((c) => c.cik)), [companies]);
  const ingestedMap  = useMemo(() => new Map(companies.map((c) => [c.cik, c])), [companies]);

  // The personal watchlist rendered as Company rows (enriched where ingested).
  const watchCompanies = useMemo<Company[]>(() =>
    watch.items.map((it) =>
      ingestedMap.get(it.cik) ?? { cik: it.cik, ticker: it.ticker, name: it.name, sector: null, industry: null },
    ), [watch.items, ingestedMap]);

  // Union used for name/ticker lookups on the company page (covers pending too).
  const lookupCompanies = useMemo<Company[]>(() => {
    const m = new Map<string, Company>(companies.map((c) => [c.cik, c]));
    for (const c of watchCompanies) if (!m.has(c.cik)) m.set(c.cik, c);
    return Array.from(m.values());
  }, [companies, watchCompanies]);

  const handleAdd = useCallback((c: SecCompany) => {
    const item: WatchItem = { cik: c.cik, ticker: c.ticker, name: c.name };
    watch.add(item);
    if (!ingestedCiks.has(c.cik)) void queueWatchlist(item);  // queue for backend ingest
    openCompany(c.cik);
  }, [watch, ingestedCiks, openCompany]);

  const handleRemove = useCallback((cik: string) => {
    watch.remove(cik);
    if (activeCik === cik) navigate("overview");
  }, [watch, activeCik, navigate]);

  // CIKs already on the personal watchlist — drives the Search page's add/open state.
  const watchedCiks = useMemo(() => new Set(watchCompanies.map((c) => c.cik)), [watchCompanies]);

  // New filings since the user's previous visit (drives the Feed nav badge).
  const newFilings = useMemo(
    () => filings.filter((f) => seen.isNew(f.filed_at)).length,
    [filings, seen],
  );

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: "var(--fg-4)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        companies={watchCompanies} filings={filings}
        activeCik={activeCik} view={view}
        ingestedCiks={ingestedCiks}
        onCompany={(cik) => openCompany(cik)}
        onOverview={() => navigate("overview")}
        onSearch={() => navigate("search")}
        onFeed={() => navigate("feed")}
        onCalendar={() => navigate("calendar")}
        onGuide={() => navigate("guide")}
        onRemove={handleRemove}
        newFilings={newFilings}
      />
      <main className="main-area">
        <div key={view + activeCik + activeTab} className="page-content">
          {view === "overview" && (
            <OverviewPage companies={watchCompanies} filings={filings} onCompany={openCompany} isNew={seen.isNew} />
          )}
          {view === "search" && (
            <SearchPage
              secIndex={secIndex} watched={watchedCiks} ingestedCiks={ingestedCiks}
              onAdd={handleAdd} onCompany={openCompany}
            />
          )}
          {view === "feed" && (
            <FeedPage filings={filings} onCompany={openCompany} />
          )}
          {view === "calendar" && (
            <CalendarView companies={watchCompanies} onCompany={openCompany} />
          )}
          {view === "guide" && <GuidePage />}
          {view === "company" && activeCik && (
            <CompanyPage
              cik={activeCik} tab={activeTab} companies={lookupCompanies}
              pending={!ingestedCiks.has(activeCik)}
              onTab={(tab) => openCompany(activeCik, tab)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
