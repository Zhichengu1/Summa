"use client";
// Dashboard (the landing view). Layout, top to bottom:
//   • header — title, subtitle, "latest filing" freshness + Add-company action
//   • stat row — companies tracked, new filings, new headlines, signals active
//   • two-column grid — LEFT: the watchlist table (the centerpiece) + the filing
//     volume chart; RIGHT: Signals, Momentum, and Latest filings panels
// Prices/technicals come from one paginated read of precomputed company_summary
// rows (O(companies) tiny rows), falling back to a client-side raw-price compute
// only until that precompute is populated. See "Scaling" in CLAUDE.md.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { Panel, PanelLink } from "../components/Panel";
import { CompanyMark } from "../components/badges/CompanyMark";
import { FormBadge } from "../components/badges/FormBadge";
import { Sparkline } from "../components/charts/Sparkline";
import { StackedBarChart } from "../components/charts/charts.lazy";
import { SignalsPanel, MomentumPanel, momentumSetups } from "./ScannerSection";
import { fetchRecentPrices, fetchCompanySummaries } from "../lib/data/data";
import { useWatchlistPulse } from "../lib/hooks/useWatchlistPulse";
import { buildWatchlistSignals } from "../lib/domain/pulse";
import { profileFor } from "../lib/domain/taxonomy";
import { derivePriceKpis } from "../lib/domain/prices";
import { deriveTechnicals, type Technicals } from "../lib/domain/technicals";
import { fmtUSD, fmtPct, fmtDelta, fmtDate, elapsed } from "../lib/utils/format";
import type { Company, Filing, DailyPrice, MainView } from "../lib/types";

type PriceRow = { last: number | null; chg1d: number | null; offHigh: number | null; spark: number[] };
type NavView = Exclude<MainView, "company">;

function StatCard({
  label, value, foot, onClick, title, tone,
}: {
  label: string; value: React.ReactNode; foot?: React.ReactNode;
  onClick?: () => void; title?: string; tone?: "accent" | "pos" | "neg" | "warn";
}) {
  const inner = (
    <>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` tone-${tone}` : ""}`}>{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </>
  );
  return onClick
    ? <button className="stat stat-link" onClick={onClick} title={title}>{inner}</button>
    : <div className="stat" title={title}>{inner}</div>;
}

export function OverviewPage({
  companies, filings, onCompany, isNew, newFilings = 0, newNews = 0, onNavigate,
}: {
  companies: Company[]; filings: Filing[];
  onCompany: (cik: string) => void;
  isNew?: (iso: string | null | undefined) => boolean;
  /** New-since-last-visit counts (shared with the nav badges) for the stat row. */
  newFilings?: number; newNews?: number;
  onNavigate?: (view: NavView) => void;
}) {
  // Per-company recent prices for the sparkline + price columns (one batched fetch).
  // The same ~1yr series also feeds the per-company technicals → Momentum panel.
  const [priceRows, setPriceRows] = useState<Record<string, PriceRow>>({});
  const [techRows, setTechRows] = useState<Record<string, Technicals>>({});
  const ciks = useMemo(() => companies.map((c) => c.cik), [companies]);
  const cikKey = ciks.join(",");
  useEffect(() => {
    if (!ciks.length) { setPriceRows({}); setTechRows({}); return; }
    let cancelled = false;
    const cikSet = new Set(ciks);

    // Fallback: compute client-side from raw prices (the original path). Capped at
    // ~80 companies by the 20k-row fetch — used only until company_summary is
    // populated by the backend, then the scalable path below supersedes it.
    const computeFromRawPrices = () => {
      fetchRecentPrices(ciks, 370).then((rows) => {
        if (cancelled) return;
        const by = new Map<string, DailyPrice[]>();
        for (const r of rows) { const a = by.get(r.cik) ?? []; a.push(r); by.set(r.cik, a); }
        const out: Record<string, PriceRow> = {};
        const techOut: Record<string, Technicals> = {};
        for (const [cik, prc] of by) {
          const k = derivePriceKpis(prc);
          const closes = prc.map((p) => p.close).filter((x): x is number => x != null);
          const prev = closes.length > 1 ? closes[closes.length - 2] : null;
          const chg1d = k.last != null && prev != null && prev !== 0 ? ((k.last - prev) / prev) * 100 : null;
          out[cik] = { last: k.last, chg1d, offHigh: k.pctOffHigh, spark: closes.slice(-60) };
          techOut[cik] = deriveTechnicals(prc);
        }
        setPriceRows(out);
        setTechRows(techOut);
      });
    };

    // Scalable path: one small paginated read of precomputed summaries (O(companies)
    // tiny rows, not O(companies × price history)). Map them into the existing
    // PriceRow / Technicals shapes so the table + Momentum panel are unchanged.
    fetchCompanySummaries().then((summaries) => {
      if (cancelled) return;
      const scoped = summaries.filter((s) => cikSet.has(s.cik));
      if (scoped.length === 0) { computeFromRawPrices(); return; }  // not populated yet
      const pr: Record<string, PriceRow> = {};
      const tr: Record<string, Technicals> = {};
      for (const s of scoped) {
        pr[s.cik] = { last: s.last_close, chg1d: s.chg_1d, offHigh: s.pct_off_high, spark: s.spark ?? [] };
        tr[s.cik] = {
          sma50: null, sma200: null, cross: s.ma_cross,
          pctFrom50: s.pct_from_50, pctFrom200: s.pct_from_200,
          rsi14: s.rsi14, volSpike: s.vol_spike, atrPct: null, histVol: null,
          new52wHigh: !!s.new_52w_high, new52wLow: !!s.new_52w_low, asOf: s.as_of,
        };
      }
      setPriceRows(pr);
      setTechRows(tr);
    });
    return () => { cancelled = true; };
  }, [cikKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Catalyst slices for the whole watchlist (one fetch, shared with the Signals panel).
  const pulse = useWatchlistPulse(companies);
  const signalRows = useMemo(() => buildWatchlistSignals(pulse.entries).filter((r) => r.signals.length > 0), [pulse.entries]);
  const momentumCount = useMemo(
    () => companies.filter((c) => techRows[c.cik] && momentumSetups(techRows[c.cik]).length > 0).length,
    [companies, techRows],
  );

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

  // Header + stat-row numbers.
  const glance = useMemo(() => {
    const cutoff7 = Date.now() - 7 * 86_400_000;
    let filings7 = 0;
    let latest: string | null = null;
    for (const f of filings) {
      if (!f.filed_at) continue;
      if (new Date(f.filed_at).getTime() > cutoff7) filings7++;
      if (!latest || f.filed_at > latest) latest = f.filed_at;
    }
    let up = 0, down = 0;
    for (const c of companies) {
      const v = priceRows[c.cik]?.chg1d;
      if (v == null) continue;
      if (v >= 0) up++; else down++;
    }
    return { filings7, latest, up, down };
  }, [filings, companies, priceRows]);

  // Watchlist filings, newest first, for the side panel.
  const latestFilings = useMemo(() => {
    const mine = new Set(ciks);
    return filings.filter((f) => mine.has(f.cik)).slice(0, 8);
  }, [filings, ciks]);

  const cols: Column<Company>[] = [
    {
      key: "ticker", header: "Company", width: "240px",
      value: (c) => c.ticker ?? "",
      render: (c) => {
        const p = profileFor(c.ticker, c.sector, c.industry, c.cik);
        const ind = p && p.industry !== "—" ? p.industry : p && p.sector !== "—" ? p.sector : null;
        return (
          <div className="co-cell">
            <CompanyMark ticker={c.ticker ?? "?"} size={28} />
            <div className="co-cell-text">
              <span className="co-cell-tkr">{c.ticker}</span>
              <span className="co-cell-name">{c.name}{ind ? <span className="co-cell-ind"> · {ind}</span> : null}</span>
            </div>
          </div>
        );
      },
    },
    {
      key: "last", header: "Last", align: "right", width: "90px",
      value: (c) => priceRows[c.cik]?.last ?? -1,
      render: (c) => { const p = priceRows[c.cik]; return p?.last != null ? <span className="dt-num strong">{fmtUSD(p.last)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "chg1d", header: "1D", align: "right", width: "84px",
      value: (c) => priceRows[c.cik]?.chg1d ?? -999,
      render: (c) => { const v = priceRows[c.cik]?.chg1d; return v != null ? <span className={`chg ${v >= 0 ? "pos" : "neg"}`}>{fmtDelta(v)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "offhi", header: "Off 52w high", align: "right", width: "110px",
      value: (c) => priceRows[c.cik]?.offHigh ?? -999,
      render: (c) => { const v = priceRows[c.cik]?.offHigh; return v != null ? <span className={`dt-num ${v > -3 ? "pos" : v < -25 ? "neg" : "muted"}`}>{fmtPct(v)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "trend", header: "3-month", width: "96px",
      value: () => "",
      render: (c) => { const s = priceRows[c.cik]?.spark; return s && s.length > 1 ? <Sparkline values={s} width={80} height={22} /> : <span className="dimmed">—</span>; },
    },
    {
      key: "last_filing", header: "Last filing",
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
      key: "cnt", header: "30d", align: "right", width: "56px",
      value: (c) => cnt30.get(c.cik) ?? 0,
      render: (c) => {
        const n = cnt30.get(c.cik) ?? 0;
        return n > 0 ? <span className="count-pill">{n}</span> : <span className="dimmed">0</span>;
      },
    },
  ];

  // First-run / empty watchlist: explain the app instead of showing empty panels.
  if (companies.length === 0) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Welcome to Summa</h1>
          <div className="page-sub">A research dashboard over every price-relevant SEC dataset. Add a company to get started.</div>
        </div>
        <div className="onboard">
          <div className="onboard-step">
            <span className="onboard-num">1</span>
            <div>
              <div className="onboard-title">Add companies to your watchlist</div>
              <div className="onboard-body">Search any US ticker or company name in the bar above, or use the Add companies page.</div>
              <button className="btn-primary" onClick={() => onNavigate?.("search")}>⌕ Find a company</button>
            </div>
          </div>
          <div className="onboard-step">
            <span className="onboard-num">2</span>
            <div>
              <div className="onboard-title">Wait for the first ingest</div>
              <div className="onboard-body">The pipeline runs every 10 minutes and pulls filings, fundamentals, insider and institutional data, prices and news for each new company.</div>
            </div>
          </div>
          <div className="onboard-step">
            <span className="onboard-num">3</span>
            <div>
              <div className="onboard-title">Read the signals</div>
              <div className="onboard-body">This page then shows live signals and momentum setups; each company page has a health check, catalysts, ownership and fundamentals.</div>
              <button className="btn-ghost" onClick={() => onNavigate?.("guide")}>◇ What the data means</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">Your {companies.length} compan{companies.length === 1 ? "y" : "ies"} at a glance — what moved, what was filed, and what the filings imply.</div>
        </div>
        <div className="dash-actions">
          {glance.latest && (
            <span className="dash-updated" title={`Latest filing across your watchlist: ${fmtDate(glance.latest)}`}>
              <span className="live-dot" /> Latest filing {elapsed(glance.latest)}
            </span>
          )}
          <button className="btn-primary" onClick={() => onNavigate?.("search")}>+ Add company</button>
        </div>
      </header>

      <div className="stat-grid">
        <StatCard
          label="Companies tracked" value={companies.length}
          foot={<><span className="pos">▲ {glance.up}</span> <span className="stat-sep">·</span> <span className="neg">▼ {glance.down}</span> <span>on the last close</span></>}
          title="Companies on your watchlist, and how many closed up vs down in the last session"
        />
        <StatCard
          label="New filings" value={newFilings} tone={newFilings > 0 ? "accent" : undefined}
          foot={<>{glance.filings7} in the last 7 days</>}
          onClick={() => onNavigate?.("feed")} title="Filings since your last visit — open the feed"
        />
        <StatCard
          label="New headlines" value={newNews} tone={newNews > 0 ? "accent" : undefined}
          foot={<>since your last visit</>}
          onClick={() => onNavigate?.("news")} title="Headlines since your last visit — open the news feed"
        />
        <StatCard
          label="Signals active" value={pulse.loading ? "…" : signalRows.length}
          foot={<>{momentumCount} with momentum setups</>}
          title="Companies with at least one actionable signal from their filings"
        />
      </div>

      <div className="dash-grid">
        <div className="dash-main">
          <Panel
            title="Watchlist" count={companies.length} flush
            sub="Click a row to open the company · click a header to sort"
          >
            <DataTable
              columns={cols} rows={companies} rowKey={(c) => c.cik}
              onRowClick={(c) => onCompany(c.cik)}
              initialSort={{ key: "ticker", dir: "asc" }}
              filterable filterPlaceholder="Filter by ticker, name or industry…"
              empty="No companies." flush dense
            />
          </Panel>

          {volumeData.length > 1 && (
            <Panel title="Filing volume" sub="Filings per month across your watchlist, by form type">
              <StackedBarChart
                data={volumeData}
                keys={formTypes.map((ft) => ({ key: ft, name: ft }))}
                title=""
              />
            </Panel>
          )}
        </div>

        <aside className="dash-side">
          <SignalsPanel entries={pulse.entries} loading={pulse.loading} onCompany={onCompany} isNew={isNew} />
          <MomentumPanel companies={companies} tech={techRows} onCompany={onCompany} />
          <Panel
            title="Latest filings" flush
            actions={<PanelLink onClick={() => onNavigate?.("feed")} title="Open the full filings feed">View all →</PanelLink>}
          >
            {latestFilings.length === 0 ? (
              <div className="panel-empty">No filings yet for your watchlist.</div>
            ) : (
              <div className="mini-list">
                {latestFilings.map((f) => (
                  <button key={f.accession_number} className="mini-row" onClick={() => onCompany(f.cik)} title={`${f.company_name ?? ""} · ${fmtDate(f.filed_at)}`}>
                    <FormBadge form={f.form_type} />
                    <span className="mini-tkr">{f.ticker}</span>
                    <span className="mini-name">{f.company_name}</span>
                    <span className="mini-age">{isNew?.(f.filed_at) && <span className="new-dot">NEW</span>}{elapsed(f.filed_at) || fmtDate(f.filed_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
