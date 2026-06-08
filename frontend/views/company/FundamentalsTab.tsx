"use client";
// Fundamentals tab — the full XBRL statement explorer: a pivoted statement table
// (income / balance / cash-flow, quarterly or annual) plus a grid of derived
// charts (revenue & YoY, margins, EPS, opex, cash vs debt, FCF, working capital…).
import { useMemo, useState } from "react";

import { InfoTip } from "../../components/InfoTip";
import { KpiTile } from "../../components/strips/KpiTile";
import {
  ComboChart, MultiLineChart, SimpleBarChart, PairedBarChart, StackedBarChart,
} from "../../components/charts/charts.lazy";
import { LoadingFundamentals } from "../../components/Skeletons";
import { pivotStatement, seriesFor, deriveKpis, yoyGrowth, METRICS } from "../../lib/domain/fundamentals";
import { fmtUSD, fmtPeriodLabel } from "../../lib/utils/format";
import type { FinancialFact, StatementKind, PeriodType } from "../../lib/types";

function fmtStatValue(v: number): string {
  return Math.abs(v) < 1000 ? v.toFixed(2) : fmtUSD(v);
}

export function FundamentalsTab({ facts, loading }: { facts: FinancialFact[]; loading: boolean }) {
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
