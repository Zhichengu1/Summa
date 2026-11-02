"use client";
// Dashboard (the landing view). Top to bottom, in the order a reader wants it:
//   • header — title, "latest filing" freshness, Add-company action
//   • pulse strip — one compact line of watchlist-wide numbers (breadth, filings,
//     new-since-last-visit, signals, momentum), each clickable where it has a home
//   • heatmap — every company as a tile coloured by its 1D / YTD move; the fastest
//     read of "what moved" and a one-click navigator
//   • three panels — Movers (best / worst today) · Signals (from the filings) ·
//     Earnings ahead (estimated from each company's reporting cadence) + Momentum
//   • the full-width watchlist table (sortable, filterable)
//   • filing volume chart + latest filings
// Prices/technicals come from one paginated read of precomputed company_summary
// rows (O(companies) tiny rows), falling back to a client-side raw-price compute
// only until that precompute is populated. See "Scaling" in CLAUDE.md.
import { useEffect, useMemo, useState } from "react";

import { CompanyPeek } from "../components/CompanyPeek";
import { CongressBuysList } from "../components/CongressBuysList";
import { CongressPeek } from "../components/CongressPeek";
import { Icon } from "../components/Icon";
import { DataTable, type Column } from "../components/DataTable";
import { Panel, PanelLink } from "../components/Panel";
import { CompanyMark } from "../components/badges/CompanyMark";
import { FormBadge } from "../components/badges/FormBadge";
import { Sparkline } from "../components/charts/Sparkline";
import { StackedBarChart } from "../components/charts/charts.lazy";
import { SignalsPanel, MomentumPanel, momentumSetups } from "./ScannerSection";
import { fetchRecentPrices, fetchCompanySummaries, fetchCongressTradesLean } from "../lib/data/data";
import { mostBought, type MostBought } from "../lib/domain/congress";
import { useWatchlistPulse } from "../lib/hooks/useWatchlistPulse";
import { usePeek } from "../lib/hooks/usePeek";
import { buildWatchlistSignals } from "../lib/domain/pulse";
import { nextEarningsEstimate } from "../lib/domain/catalysts";
import { profileFor } from "../lib/domain/taxonomy";
import { derivePriceKpis } from "../lib/domain/prices";
import { deriveTechnicals, type Technicals } from "../lib/domain/technicals";
import { fmtUSD, fmtPct, fmtDelta, fmtDate, elapsed } from "../lib/utils/format";
import type { Company, Filing, DailyPrice, MainView, CompanySummary, CompanyTab, CongressTrade } from "../lib/types";

type PriceRow = { last: number | null; chg1d: number | null; ytd: number | null; offHigh: number | null; spark: number[] };
type NavView = Exclude<MainView, "company">;
type HeatMode = "1d" | "ytd";

/** Tile tint: status colour whose opacity grows with the size of the move. */
function heatStyle(v: number | null, mode: HeatMode): React.CSSProperties {
  if (v == null) return { background: "var(--bg-2)" };
  const span = mode === "1d" ? 5 : 40;                 // move that reaches full intensity
  const a = 0.08 + Math.min(Math.abs(v), span) / span * 0.36;   // muted: 0.08 → 0.44
  return { background: `rgba(var(${v >= 0 ? "--pos-rgb" : "--neg-rgb"}), ${a.toFixed(2)})` };
}

function PulseStat({
  value, label, tone, onClick, title,
}: { value: React.ReactNode; label: React.ReactNode; tone?: "accent" | "pos" | "neg"; onClick?: () => void; title?: string }) {
  const cls = `pulse-stat${onClick ? " pulse-link" : ""}`;
  const inner = (
    <>
      <span className={`pulse-value${tone ? ` tone-${tone}` : ""}`}>{value}</span>
      <span className="pulse-label">{label}</span>
    </>
  );
  return onClick
    ? <button className={cls} onClick={onClick} title={title}>{inner}</button>
    : <span className={cls} title={title}>{inner}</span>;
}

export function OverviewPage({
  companies, filings, onCompany, isNew, newFilings = 0, newNews = 0, onNavigate, onTrack,
}: {
  companies: Company[]; filings: Filing[];
  onCompany: (cik: string, tab?: CompanyTab) => void;
  /** Add a market-wide ticker (e.g. a Congress buy) to the watchlist. */
  onTrack?: (ticker: string) => void;
  isNew?: (iso: string | null | undefined) => boolean;
  /** New-since-last-visit counts (shared with the nav badges) for the pulse strip. */
  newFilings?: number; newNews?: number;
  onNavigate?: (view: NavView) => void;
}) {
  // Per-company recent prices for the heatmap, movers and table (one batched fetch).
  // The same series also feeds the per-company technicals → Momentum panel.
  const [priceRows, setPriceRows] = useState<Record<string, PriceRow>>({});
  const [techRows, setTechRows] = useState<Record<string, Technicals>>({});
  // Raw summary rows, kept for the hover peek card (same numbers, richer flags).
  const [summaryMap, setSummaryMap] = useState<Map<string, CompanySummary>>(new Map());
  const [pricesLoading, setPricesLoading] = useState(true);
  const [heatMode, setHeatMode] = useState<HeatMode>("1d");
  const ciks = useMemo(() => companies.map((c) => c.cik), [companies]);
  const cikKey = ciks.join(",");
  useEffect(() => {
    if (!ciks.length) { setPriceRows({}); setTechRows({}); setPricesLoading(false); return; }
    let cancelled = false;
    setPricesLoading(true);
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
          out[cik] = { last: k.last, chg1d, ytd: k.retYTD, offHigh: k.pctOffHigh, spark: closes.slice(-60) };
          techOut[cik] = deriveTechnicals(prc);
        }
        setPriceRows(out);
        setTechRows(techOut);
        setPricesLoading(false);
      });
    };

    // Scalable path: one small paginated read of precomputed summaries (O(companies)
    // tiny rows, not O(companies × price history)). Map them into the existing
    // PriceRow / Technicals shapes so the table + Momentum panel are unchanged.
    fetchCompanySummaries().then((summaries) => {
      if (cancelled) return;
      const scoped = summaries.filter((s) => cikSet.has(s.cik));
      if (scoped.length === 0) { computeFromRawPrices(); return; }  // not populated yet
      setSummaryMap(new Map(scoped.map((s) => [s.cik, s])));
      const pr: Record<string, PriceRow> = {};
      const tr: Record<string, Technicals> = {};
      for (const s of scoped) {
        pr[s.cik] = { last: s.last_close, chg1d: s.chg_1d, ytd: s.ret_ytd, offHigh: s.pct_off_high, spark: s.spark ?? [] };
        tr[s.cik] = {
          sma50: null, sma200: null, cross: s.ma_cross,
          pctFrom50: s.pct_from_50, pctFrom200: s.pct_from_200,
          rsi14: s.rsi14, volSpike: s.vol_spike, atrPct: null, histVol: null,
          new52wHigh: !!s.new_52w_high, new52wLow: !!s.new_52w_low, asOf: s.as_of,
        };
      }
      setPriceRows(pr);
      setTechRows(tr);
      setPricesLoading(false);
    });
    return () => { cancelled = true; };
  }, [cikKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Hover peek: heatmap tiles, movers and table rows all open the same company card.
  const pk = usePeek({ side: "right" });
  const peekCompany = pk.peek ? companies.find((c) => c.cik === pk.peek!.cik) ?? null : null;
  const openFromPeek = (cik: string, tab?: CompanyTab) => { pk.close(); onCompany(cik, tab); };

  // Congress tracker: one lean, cached market-wide read (120d = the 60-day window
  // plus the previous window for momentum). Fail-soft — an empty result hides the panel.
  const [congress, setCongress] = useState<CongressTrade[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchCongressTradesLean(120).then((r) => { if (!cancelled) setCongress(r); }).catch(() => { if (!cancelled) setCongress([]); });
    return () => { cancelled = true; };
  }, []);
  const congressTop = useMemo(() => mostBought(congress ?? [], 60, 8), [congress]);
  const cgPeek = usePeek({ side: "right", width: 372, height: 560 });
  const cgPeekRow: MostBought | null = cgPeek.peek ? congressTop.find((r) => r.ticker === cgPeek.peek!.cik) ?? null : null;
  const watchedByTicker = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companies) if (c.ticker) m.set(c.ticker.toUpperCase(), c.cik);
    return m;
  }, [companies]);

  // Catalyst slices for the whole watchlist (one fetch, shared with the Signals panel).
  const pulse = useWatchlistPulse(companies);
  const signalRows = useMemo(() => buildWatchlistSignals(pulse.entries).filter((r) => r.signals.length > 0), [pulse.entries]);
  const momentumCount = useMemo(
    () => companies.filter((c) => techRows[c.cik] && momentumSetups(techRows[c.cik]).length > 0).length,
    [companies, techRows],
  );

  // Estimated next earnings per company (from its own reporting cadence) — the
  // "what's ahead" panel. Only cadences that look genuinely quarterly qualify.
  const earningsAhead = useMemo(() => {
    const out: { cik: string; ticker: string; name: string; estDate: string; daysAway: number }[] = [];
    for (const e of pulse.entries) {
      const dates = (e.data.earnings ?? []).map((x) => x.reported_date ?? x.filed_at);
      const est = nextEarningsEstimate(dates);
      if (!est || est.daysAway < -10 || est.daysAway > 75) continue;
      out.push({ cik: e.cik, ticker: e.ticker, name: e.name, estDate: est.estDate, daysAway: est.daysAway });
    }
    return out.sort((a, b) => a.daysAway - b.daysAway).slice(0, 8);
  }, [pulse.entries]);

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

  // Header + pulse-strip numbers.
  const glance = useMemo(() => {
    const cutoff7 = Date.now() - 7 * 86_400_000;
    let filings7 = 0;
    let latest: string | null = null;
    for (const f of filings) {
      if (!f.filed_at) continue;
      if (new Date(f.filed_at).getTime() > cutoff7) filings7++;
      if (!latest || f.filed_at > latest) latest = f.filed_at;
    }
    let up = 0, down = 0, sum = 0, n = 0;
    for (const c of companies) {
      const v = priceRows[c.cik]?.chg1d;
      if (v == null) continue;
      if (v >= 0) up++; else down++;
      sum += v; n++;
    }
    return { filings7, latest, up, down, avg1d: n ? sum / n : null };
  }, [filings, companies, priceRows]);

  // Heatmap tiles: every company, sorted by the active move (best first).
  const heatTiles = useMemo(() => {
    const val = (c: Company) => (heatMode === "1d" ? priceRows[c.cik]?.chg1d : priceRows[c.cik]?.ytd) ?? null;
    return companies
      .map((c) => ({ c, v: val(c), last: priceRows[c.cik]?.last ?? null }))
      .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity) || (a.c.ticker ?? "").localeCompare(b.c.ticker ?? ""));
  }, [companies, priceRows, heatMode]);

  // Movers: best and worst 1D moves (only companies with a close).
  const movers = useMemo(() => {
    const rows = companies
      .map((c) => ({ c, v: priceRows[c.cik]?.chg1d ?? null, last: priceRows[c.cik]?.last ?? null }))
      .filter((r): r is { c: Company; v: number; last: number | null } => r.v != null)
      .sort((a, b) => b.v - a.v);
    const up = rows.filter((r) => r.v > 0).slice(0, 5);
    const down = rows.filter((r) => r.v < 0).slice(-5).reverse();
    return { up, down };
  }, [companies, priceRows]);

  // Watchlist filings, newest first, for the bottom panel.
  const latestFilings = useMemo(() => {
    const mine = new Set(ciks);
    return filings.filter((f) => mine.has(f.cik)).slice(0, 8);
  }, [filings, ciks]);

  const cols: Column<Company>[] = [
    {
      key: "ticker", header: "Company", width: "260px",
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
      key: "last", header: "Last", align: "right", width: "84px",
      value: (c) => priceRows[c.cik]?.last ?? -1,
      render: (c) => { const p = priceRows[c.cik]; return p?.last != null ? <span className="dt-num strong">{fmtUSD(p.last)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "chg1d", header: "1D", align: "right", width: "82px",
      value: (c) => priceRows[c.cik]?.chg1d ?? -999,
      render: (c) => { const v = priceRows[c.cik]?.chg1d; return v != null ? <span className={`chg ${v >= 0 ? "pos" : "neg"}`}>{fmtDelta(v)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "ytd", header: "YTD", align: "right", width: "82px",
      value: (c) => priceRows[c.cik]?.ytd ?? -999,
      render: (c) => { const v = priceRows[c.cik]?.ytd; return v != null ? <span className={`dt-num ${v >= 0 ? "pos" : "neg"}`}>{fmtDelta(v)}</span> : <span className="dimmed">—</span>; },
    },
    {
      key: "offhi", header: "vs 52w high", align: "right", width: "104px",
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
      key: "cnt", header: "30d", align: "right", width: "60px",
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
              <button className="btn-primary" onClick={() => onNavigate?.("search")}><Icon name="search" size={14} /> Find a company</button>
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
              <button className="btn-ghost" onClick={() => onNavigate?.("guide")}><Icon name="guide" size={14} /> What the data means</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const newTotal = newFilings + newNews;
  const heatLabel = heatMode === "1d" ? "last session" : "year to date";

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">{companies.length} compan{companies.length === 1 ? "y" : "ies"} · last close and latest SEC filings</div>
        </div>
        <div className="dash-actions">
          {glance.latest && (
            <span className="dash-updated" title={`Latest filing across your watchlist: ${fmtDate(glance.latest)}`}>
              <span className="live-dot" /> Latest filing {elapsed(glance.latest)}
            </span>
          )}
          <button className="btn-ghost" onClick={() => onNavigate?.("search")}><Icon name="plus" size={14} strokeWidth={2.25} /> Add company</button>
        </div>
      </header>

      {/* Pulse strip — the whole watchlist in one line */}
      <div className="pulse-strip" role="list">
        <PulseStat value={companies.length} label="companies" title="Companies on your watchlist" />
        <PulseStat
          value={<><span className="pos">▲ {glance.up}</span> <span className="pulse-sep">·</span> <span className="neg">▼ {glance.down}</span></>}
          label="up · down, last close" title="How many closed up vs down in the last session"
        />
        <PulseStat
          value={glance.avg1d != null ? fmtDelta(glance.avg1d) : "—"}
          tone={glance.avg1d == null ? undefined : glance.avg1d >= 0 ? "pos" : "neg"}
          label="average move" title="Average 1-day change across the watchlist (equal-weighted)"
        />
        <PulseStat
          value={glance.filings7} label="filings · 7d"
          onClick={() => onNavigate?.("feed")} title="Filings in the last 7 days — open the feed"
        />
        <PulseStat
          value={newTotal} tone={newTotal > 0 ? "accent" : undefined}
          label={newTotal > 0 ? `new since last visit (${newFilings} filings · ${newNews} headlines)` : "new since last visit"}
          onClick={() => onNavigate?.(newNews > newFilings ? "news" : "feed")}
          title="Filings and headlines since you were last here"
        />
        <PulseStat
          value={pulse.loading ? "…" : signalRows.length} label="with signals"
          title="Companies with at least one actionable signal from their filings"
        />
        <PulseStat
          value={pricesLoading ? "…" : momentumCount} label="momentum setups"
          title="Companies with a breakout, MA cross, RSI extreme or volume spike"
        />
      </div>

      {/* Heatmap — every company as a tile, coloured by the move */}
      <Panel
        title="Heatmap" count={companies.length}
        sub={`${heatMode === "1d" ? "1-day" : "Year-to-date"} move · last close`}
        actions={
          <div className="seg" role="group" aria-label="Heatmap period">
            <button className={`seg-btn${heatMode === "1d" ? " active" : ""}`} onClick={() => setHeatMode("1d")}>1D</button>
            <button className={`seg-btn${heatMode === "ytd" ? " active" : ""}`} onClick={() => setHeatMode("ytd")}>YTD</button>
          </div>
        }
      >
        {pricesLoading ? (
          <div className="heat-grid">
            {companies.slice(0, 16).map((c) => <div key={c.cik} className="skeleton heat-skel" />)}
          </div>
        ) : (
          <div className="heat-grid">
            {heatTiles.map(({ c, v, last }) => (
              <button
                key={c.cik} className="heat-tile" style={heatStyle(v, heatMode)}
                onClick={() => openFromPeek(c.cik)}
                onMouseEnter={(e) => pk.enter(c.cik, e.currentTarget)} onMouseLeave={pk.leave}
                onFocus={(e) => pk.enter(c.cik, e.currentTarget, true)} onBlur={pk.leave}
                title={`${c.name ?? c.ticker} · ${last != null ? fmtUSD(last) : "no price"} · ${v != null ? `${fmtDelta(v)} ${heatLabel}` : "no move data"}`}
              >
                <span className="heat-tkr">{c.ticker}</span>
                <span className="heat-chg">{v != null ? fmtDelta(v) : "—"}</span>
                <span className="heat-px">{last != null ? fmtUSD(last) : ""}</span>
              </button>
            ))}
          </div>
        )}
      </Panel>

      {/* Movers · Signals · Ahead */}
      <div className="dash-row3">
        <div className="dash-stack">
        <Panel title="Movers" sub="1-day · last close" flush>
          {pricesLoading ? (
            <div className="srow-skel">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)}</div>
          ) : movers.up.length + movers.down.length === 0 ? (
            <div className="panel-empty">No price data yet — prices arrive with the next pipeline run.</div>
          ) : (
            <div className="movers">
              <div className="movers-col">
                <div className="movers-head pos">▲ Gainers</div>
                {movers.up.length === 0 && <div className="movers-none">None up today</div>}
                {movers.up.map(({ c, v, last }) => (
                  <button
                    key={c.cik} className="mover" onClick={() => openFromPeek(c.cik)} title={c.name ?? ""}
                    onMouseEnter={(e) => pk.enter(c.cik, e.currentTarget)} onMouseLeave={pk.leave}
                    onFocus={(e) => pk.enter(c.cik, e.currentTarget, true)} onBlur={pk.leave}
                  >
                    <CompanyMark ticker={c.ticker ?? "?"} size={22} />
                    <span className="mover-tkr">{c.ticker}</span>
                    <span className="mover-px">{last != null ? fmtUSD(last) : ""}</span>
                    <span className="chg pos">{fmtDelta(v)}</span>
                  </button>
                ))}
              </div>
              <div className="movers-col">
                <div className="movers-head neg">▼ Losers</div>
                {movers.down.length === 0 && <div className="movers-none">None down today</div>}
                {movers.down.map(({ c, v, last }) => (
                  <button
                    key={c.cik} className="mover" onClick={() => openFromPeek(c.cik)} title={c.name ?? ""}
                    onMouseEnter={(e) => pk.enter(c.cik, e.currentTarget)} onMouseLeave={pk.leave}
                    onFocus={(e) => pk.enter(c.cik, e.currentTarget, true)} onBlur={pk.leave}
                  >
                    <CompanyMark ticker={c.ticker ?? "?"} size={22} />
                    <span className="mover-tkr">{c.ticker}</span>
                    <span className="mover-px">{last != null ? fmtUSD(last) : ""}</span>
                    <span className="chg neg">{fmtDelta(v)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Congress buys" count={congressTop.length} flush
          sub="Most distinct members buying · 60d"
          actions={<PanelLink onClick={() => onNavigate?.("congress")} title="Open the Congress tracker">View all <Icon name="arrow-right" size={12} /></PanelLink>}
        >
          {congress == null ? (
            <div className="srow-skel">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 30 }} />)}</div>
          ) : congressTop.length === 0 ? (
            <div className="panel-empty">No congressional buys disclosed in the last 60 days.</div>
          ) : (
            <CongressBuysList
              rows={congressTop} watchedCiks={watchedByTicker} compact
              onOpen={(cik) => { cgPeek.close(); onCompany(cik); }} onTrack={onTrack} onDrill={() => { cgPeek.close(); onNavigate?.("congress"); }}
              onRowEnter={(r, el, now) => cgPeek.enter(r.ticker, el, now)} onRowLeave={cgPeek.leave}
            />
          )}
        </Panel>
        </div>

        <SignalsPanel entries={pulse.entries} loading={pulse.loading} onCompany={onCompany} isNew={isNew} limit={6} />

        <div className="dash-stack">
          <Panel
            title="Earnings ahead" count={earningsAhead.length} flush
            sub="Estimated from reporting cadence"
          >
            {pulse.loading ? (
              <div className="srow-skel">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 36 }} />)}</div>
            ) : earningsAhead.length === 0 ? (
              <div className="panel-empty">No report expected in the next ~10 weeks (needs three past reports to estimate).</div>
            ) : (
              <div className="mini-list">
                {earningsAhead.map((e) => (
                  <button key={e.cik} className="mini-row ahead-row" onClick={() => onCompany(e.cik)} title={`${e.name} · estimated ${fmtDate(e.estDate)}`}>
                    <span className={`ahead-days${e.daysAway < 0 ? " overdue" : e.daysAway <= 7 ? " soon" : ""}`}>
                      {e.daysAway < 0 ? "due" : e.daysAway === 0 ? "today" : `${e.daysAway}d`}
                    </span>
                    <span className="mini-tkr">{e.ticker}</span>
                    <span className="mini-name">{e.name}</span>
                    <span className="mini-age">~{fmtDate(e.estDate)}</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
          <MomentumPanel companies={companies} tech={techRows} onCompany={onCompany} limit={5} />
        </div>
      </div>

      {/* The full watchlist */}
      <Panel title="Watchlist" count={companies.length} flush>
        <DataTable
          columns={cols} rows={companies} rowKey={(c) => c.cik}
          onRowClick={(c) => openFromPeek(c.cik)}
          onRowEnter={(c, el, now) => pk.enter(c.cik, el, now)} onRowLeave={pk.leave}
          initialSort={{ key: "ticker", dir: "asc" }}
          filterable filterPlaceholder="Filter by ticker, name or industry…"
          empty="No companies." flush dense
        />
      </Panel>

      <div className="dash-row2">
        {volumeData.length > 1 && (
          <Panel title="Filing volume" sub="Per month, by form type">
            <StackedBarChart
              data={volumeData}
              keys={formTypes.map((ft) => ({ key: ft, name: ft }))}
              title=""
            />
          </Panel>
        )}
        <Panel
          title="Latest filings" flush
          actions={<PanelLink onClick={() => onNavigate?.("feed")} title="Open the full filings feed">View all <Icon name="arrow-right" size={12} /></PanelLink>}
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
      </div>

      {cgPeek.peek && cgPeekRow && (
        <CongressPeek
          row={cgPeekRow} windowDays={60} top={cgPeek.peek.top} left={cgPeek.peek.left}
          onMouseEnter={cgPeek.hold} onMouseLeave={cgPeek.leave}
          onDrill={() => { cgPeek.close(); onNavigate?.("congress"); }}
          onTrack={onTrack ? (t) => { cgPeek.close(); onTrack(t); } : undefined}
          cik={watchedByTicker.get(cgPeekRow.ticker)} onOpen={(cik) => { cgPeek.close(); onCompany(cik); }}
        />
      )}
      {pk.peek && peekCompany && (
        <CompanyPeek
          company={peekCompany} summary={summaryMap.get(peekCompany.cik)}
          filings30={cnt30.get(peekCompany.cik) ?? 0}
          pending={false}
          top={pk.peek.top} left={pk.peek.left}
          onOpen={openFromPeek} onMouseEnter={pk.hold} onMouseLeave={pk.leave}
        />
      )}
    </div>
  );
}
