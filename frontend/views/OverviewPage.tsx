"use client";
// Watchlist Overview — the landing surface. Three stacked sections:
//   • ScannerSection (what's actionable right now across the watchlist)
//   • MomentumScanner (price-action setups across the watchlist)
//   • the watchlist table (price/technicals/last-filing per company) + filing-volume chart
// Prices/technicals come from one paginated read of precomputed company_summary
// rows (O(companies) tiny rows), falling back to a client-side raw-price compute
// only until that precompute is populated. See "Scaling" in CLAUDE.md.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { CompanyMark } from "../components/badges/CompanyMark";
import { FormBadge } from "../components/badges/FormBadge";
import { Sparkline } from "../components/charts/Sparkline";
import { StackedBarChart } from "../components/charts/charts.lazy";
import { ScannerSection, MomentumScanner } from "./ScannerSection";
import { fetchRecentPrices, fetchCompanySummaries } from "../lib/data/data";
import { profileFor } from "../lib/domain/taxonomy";
import { derivePriceKpis } from "../lib/domain/prices";
import { deriveTechnicals, type Technicals } from "../lib/domain/technicals";
import { fmtUSD, fmtPct, fmtDelta, fmtDate, elapsed } from "../lib/utils/format";
import type { Company, Filing, DailyPrice } from "../lib/types";

type PriceRow = { last: number | null; chg1d: number | null; offHigh: number | null; spark: number[] };


export function OverviewPage({
  companies, filings, onCompany, isNew,
}: { companies: Company[]; filings: Filing[]; onCompany: (cik: string) => void; isNew?: (iso: string | null | undefined) => boolean }) {
  // Per-company recent prices for the sparkline + price columns (one batched fetch).
  // The same ~1yr series also feeds the per-company technicals → Momentum Scanner.
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
    // PriceRow / Technicals shapes so the table + Momentum Scanner are unchanged.
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

      {/* Price-action setups (breakouts, crosses, RSI extremes, volume) across the watchlist. */}
      <MomentumScanner companies={companies} tech={techRows} onCompany={onCompany} />

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
