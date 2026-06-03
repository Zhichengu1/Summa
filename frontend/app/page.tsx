"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { DataTable, type Column } from "../components/DataTable";
import {
  ComboChart, MultiLineChart, SimpleBarChart, PairedBarChart,
  StackedBarChart, DivergingBarChart, HorizontalBarChart, CumulativeLineChart,
} from "../components/charts";
import {
  pivotStatement, seriesFor, deriveKpis, yoyGrowth, METRICS,
} from "../lib/fundamentals";
import {
  fetchCompanies, fetchFilings, fetchFilingsForCik, fetchFinancialFacts,
  subscribeFilings, fetchInsiderTransactions, fetchInstitutionalHoldings,
  fetchCorporateEvents, fetchEarningsEvents, fetchLateFilings,
  fetchSecuritiesOfferings, fetchBeneficialOwnership, fetchProposedSales,
} from "../lib/data";
import {
  fmtUSD, fmtNum, fmtPct, fmtDelta, fmtDate, elapsed, fmtPeriodLabel, formColorVar,
} from "../lib/format";
import type {
  Company, FinancialFact, Filing,
  InsiderTransaction, InstitutionalHolding,
  CorporateEvent, EarningsEvent, LateFiling, SecuritiesOffering,
  BeneficialOwnership, ProposedSale,
  StatementKind, PeriodType,
} from "../lib/types";

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtStatValue(v: number): string {
  return Math.abs(v) < 1000 ? v.toFixed(2) : fmtUSD(v);
}

// ─── Local types ──────────────────────────────────────────────────────────────

type MainView = "overview" | "feed" | "company";
type CompanyTab = "overview" | "fundamentals" | "ownership" | "catalysts" | "filings";

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
      <div className="k-label">{label}</div>
      <div className="k-value">{formatted}</div>
      <div className="k-delta">
        {qoq != null && <span className={qoq >= 0 ? "pos" : "neg"}>{fmtDelta(qoq)} QoQ</span>}
        {yoy != null && <span className={yoy >= 0 ? "pos" : "neg"}>{fmtDelta(yoy)} YoY</span>}
      </div>
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
  companies, filings, activeCik, view,
  onCompany, onOverview, onFeed, q, setQ,
}: {
  companies: Company[]; filings: Filing[];
  activeCik: string | null; view: MainView;
  onCompany: (cik: string) => void;
  onOverview: () => void; onFeed: () => void;
  q: string; setQ: (v: string) => void;
}) {
  const filtered = useMemo(() => {
    if (!q.trim()) return companies;
    const n = q.toLowerCase();
    return companies.filter(
      (c) => (c.ticker ?? "").toLowerCase().includes(n) ||
             (c.name ?? "").toLowerCase().includes(n),
    );
  }, [companies, q]);

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
        <div className={`nav-item${view === "feed" ? " active" : ""}`} onClick={onFeed}>
          ≡ Feed
        </div>
      </nav>
      <div className="sidebar-search">
        <input
          className="sidebar-input"
          placeholder="Search companies…" value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="sidebar-list">
        {filtered.map((c) => {
          const cnt = recent30.get(c.cik) ?? 0;
          return (
            <div
              key={c.cik}
              className={`company-row${activeCik === c.cik ? " active" : ""}`}
              onClick={() => onCompany(c.cik)}
            >
              <CompanyMark ticker={c.ticker ?? "?"} size={22} />
              <span className="tkr">{c.ticker}</span>
              <span className="nm">{c.name}</span>
              {cnt > 0 && <span className="cnt">{cnt}</span>}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ─── Overview page ────────────────────────────────────────────────────────────

function OverviewPage({
  companies, filings, onCompany,
}: { companies: Company[]; filings: Filing[]; onCompany: (cik: string) => void }) {
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
      key: "sector", header: "Sector",
      value: (c) => c.sector ?? "",
      render: (c) => <span className="dimmed">{c.sector ?? "—"}</span>,
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
  cik, tab, companies, onTab,
}: { cik: string; tab: CompanyTab; companies: Company[]; onTab: (t: CompanyTab) => void }) {
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

  const TABS: { key: CompanyTab; label: string }[] = [
    { key: "overview",      label: "Overview" },
    { key: "fundamentals",  label: "Fundamentals" },
    { key: "ownership",     label: "Ownership" },
    { key: "catalysts",     label: "Catalysts" },
    { key: "filings",       label: "Filings" },
  ];

  return (
    <div>
      <div className="page-head-row">
        <CompanyMark ticker={ticker} size={44} />
        <div>
          <h1 className="page-title">{name}</h1>
          <div className="page-sub">
            {ticker} · CIK {cik}
            {company?.sector ? ` · ${company.sector}` : ""}
            {company?.industry ? ` · ${company.industry}` : ""}
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.key} className={`tab${tab === t.key ? " active" : ""}`} onClick={() => onTab(t.key)}>
            {t.label}
          </div>
        ))}
      </div>

      {tab === "overview"     && <CompanyOverviewTab cik={cik} facts={facts} loading={loadingFacts} />}
      {tab === "fundamentals" && <FundamentalsTab facts={facts} loading={loadingFacts} />}
      {tab === "ownership"    && <OwnershipTab cik={cik} />}
      {tab === "catalysts"    && <CatalystsTab cik={cik} />}
      {tab === "filings"      && <FilingsTab cik={cik} />}
    </div>
  );
}

// ─── Company Overview tab ─────────────────────────────────────────────────────

function CompanyOverviewTab({
  cik, facts, loading,
}: { cik: string; facts: FinancialFact[]; loading: boolean }) {
  const [recentFilings, setRecentFilings] = useState<Filing[]>([]);
  const [loadingFilings, setLoadingFilings] = useState(true);

  useEffect(() => {
    setLoadingFilings(true);
    fetchFilingsForCik(cik, 10).then((d) => { setRecentFilings(d); setLoadingFilings(false); });
  }, [cik]);

  const kpis = useMemo(() => {
    if (loading || !facts.length) return [];
    return deriveKpis(facts, "quarterly");
  }, [facts, loading]);

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
    <div>
      {kpis.length > 0 && (
        <div className="kpi-strip">
          {kpis.map((k) => (
            <KpiTile key={k.label} label={k.label} value={k.value} fmt={k.fmt} qoq={k.qoq} yoy={k.yoy} />
          ))}
        </div>
      )}
      <div className="section">
        <div className="section-title">Recent Filings</div>
        {loadingFilings ? (
          <div className="skeleton-block">
            <div className="skeleton" style={{ height: 36, borderRadius: 4 }} />
            {[0,1,2,3,4].map((i) => <div key={i} className="skeleton" style={{ height: 32, borderRadius: 4, opacity: 0.7 - i * 0.1 }} />)}
          </div>
        ) : (
          <DataTable
            columns={filCols} rows={recentFilings} rowKey={(f) => f.accession_number}
            initialSort={{ key: "filed", dir: "desc" }} empty="No filings."
          />
        )}
      </div>
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
            <ComboChart data={revData} barKey="rev" lineKey="yoy" barName="Revenue" lineName="YoY %" title="Revenue & YoY Growth" />
          )}
          {incomeData.length > 1 && oi.length > 1 && (
            <PairedBarChart data={incomeData} keyA="Operating Income" keyB="Net Income" nameA="Op. Income" nameB="Net Income" title="Operating & Net Income" />
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
            />
          )}
          {epsData.length > 1 && (
            <SimpleBarChart data={epsData} barKey="EPS" title="Diluted EPS" signed />
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
              <PairedBarChart data={cashDebt} keyA="Cash" keyB="Debt" nameA="Cash" nameB="L/T Debt" title="Cash vs Long-Term Debt" />
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
              <SimpleBarChart data={fcfData} barKey="FCF" title="Free Cash Flow" signed />
            )}
            {cfData.length > 1 && (
              <PairedBarChart data={cfData} keyA="Operating" keyB="CapEx" nameA="Operating CF" nameB="CapEx" title="Operating CF vs CapEx" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Ownership tab ────────────────────────────────────────────────────────────

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
      render: (t) => (
        <span className={`badge badge-${t.acquired_disposed === "A" ? "buy" : "sell"}`}>
          {t.transaction_code ?? (t.acquired_disposed === "A" ? "BUY" : "SELL")}
        </span>
      ),
    },
    { key: "shares", header: "Shares", align: "right", value: (t) => t.shares ?? 0, render: (t) => <span className="dt-num">{fmtNum(t.shares, 0)}</span> },
    { key: "price",  header: "Price",  align: "right", value: (t) => t.price  ?? 0, render: (t) => <span className="dt-num">{fmtUSD(t.price)}</span> },
    { key: "value",  header: "Value",  align: "right", value: (t) => t.value  ?? 0, render: (t) => <span className="dt-num">{fmtUSD(t.value)}</span> },
    { key: "after",  header: "Shares After", align: "right", value: (t) => t.shares_after ?? 0, render: (t) => <span className="dt-num dimmed">{fmtNum(t.shares_after, 0)}</span> },
  ];

  const holdingsCols: Column<InstitutionalHolding>[] = [
    { key: "manager", header: "Manager",   value: (h) => h.manager_name },
    { key: "period",  header: "Period",    value: (h) => h.period_of_report, render: (h) => <span className="muted">{fmtDate(h.period_of_report)}</span> },
    { key: "shares",  header: "Shares",    align: "right", value: (h) => h.shares ?? 0, render: (h) => <span className="dt-num">{fmtNum(h.shares, 0)}</span> },
    { key: "value",   header: "Value",     align: "right", value: (h) => h.value  ?? 0, render: (h) => <span className="dt-num">{fmtUSD(h.value)}</span> },
    { key: "pct",     header: "% of Fund", align: "right", value: (h) => h.pct_of_portfolio ?? 0, render: (h) => <span className="dt-num">{fmtPct(h.pct_of_portfolio)}</span> },
  ];

  type QoQRow = { manager: string; action: string; shares: number; delta: number; value: number };
  const qoqCols: Column<QoQRow>[] = [
    { key: "manager", header: "Manager", value: (r) => r.manager },
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
    { key: "filer",    header: "Filer",    value: (b) => b.filer_name ?? "" },
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
        <div className="section-title">Insider Activity (Form 4)</div>
        {insider.length === 0 ? <div className="empty-note">No insider transaction data yet.</div> : (
          <>
            <div className="chart-grid charts-below">
              {netFlowData.length > 1 && (
                <DivergingBarChart data={netFlowData} barKey="net" title="Net Shares Bought / Sold by Month" />
              )}
              {cumulativeData.length > 1 && (
                <CumulativeLineChart data={cumulativeData} lineKey="cumulative" title="Cumulative Net Insider Shares" signed />
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
        <div className="section-title">Institutional Holdings (13F-HR)</div>
        {holdings.length === 0 ? <div className="empty-note">No institutional holdings data yet.</div> : (
          <>
            <div className="chart-grid charts-below">
              {topHoldersData.length > 0 && (
                <HorizontalBarChart data={topHoldersData} barKey="value" labelKey="label" title="Top Holders by Position Value (Latest Quarter)" />
              )}
              {managerCountData.length > 1 && (
                <SimpleBarChart data={managerCountData} barKey="Managers" title="Number of Major Institutions Holding Stock by Quarter" />
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
          <div className="section-title">Beneficial Ownership — Large Stakes (SC 13D / 13G)</div>
          <DataTable columns={beneficialCols} rows={beneficial}
            rowKey={(b) => b.accession_number}
            initialSort={{ key: "filed", dir: "desc" }} maxHeight="240px" empty="None."
          />
        </div>
      )}

      {/* ── Proposed Sales (Form 144) ─────────────────────────────────────── */}
      {proposed.length > 0 && (
        <div className="section">
          <div className="section-title">Proposed Insider Sales (Form 144)</div>
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
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchCorporateEvents(cik), fetchEarningsEvents(cik),
      fetchLateFilings(cik), fetchSecuritiesOfferings(cik),
    ]).then(([ev, ea, la, of]) => {
      setEvents(ev); setEarnings(ea); setLateF(la); setOffers(of);
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
    { key: "summary", header: "Summary", value: (e) => e.summary ?? "", render: (e) => <span className="muted" style={{ maxWidth: 320, display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{e.summary ?? "—"}</span> },
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
  const [sidebarQ, setSidebarQ]   = useState("");
  const [loading, setLoading]     = useState(true);

  // Hash routing
  useEffect(() => {
    function parse() {
      const h = window.location.hash.replace(/^#/, "");
      if (h === "feed") { setView("feed"); setActiveCik(null); return; }
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

  // Initial load
  useEffect(() => {
    Promise.all([fetchCompanies(), fetchFilings(200)]).then(([cos, fils]) => {
      setCompanies(cos);
      setFilings(fils);
      setLoading(false);
    });
  }, []);

  // Realtime subscription
  useEffect(() => subscribeFilings((f) => setFilings((p) => [f, ...p].slice(0, 200))), []);

  const navigate = useCallback((hash: string) => { window.location.hash = hash; }, []);
  const openCompany = useCallback((cik: string, tab: CompanyTab = "overview") => {
    navigate(`c=${cik}${tab !== "overview" ? `/${tab}` : ""}`);
  }, [navigate]);

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
        companies={companies} filings={filings}
        activeCik={activeCik} view={view}
        onCompany={(cik) => openCompany(cik)}
        onOverview={() => navigate("overview")}
        onFeed={() => navigate("feed")}
        q={sidebarQ} setQ={setSidebarQ}
      />
      <main className="main-area">
        <div key={view + activeCik + activeTab} className="page-content">
          {view === "overview" && (
            <OverviewPage companies={companies} filings={filings} onCompany={openCompany} />
          )}
          {view === "feed" && (
            <FeedPage filings={filings} onCompany={openCompany} />
          )}
          {view === "company" && activeCik && (
            <CompanyPage
              cik={activeCik} tab={activeTab} companies={companies}
              onTab={(tab) => openCompany(activeCik, tab)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
