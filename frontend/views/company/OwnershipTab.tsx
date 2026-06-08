"use client";
// Ownership tab — who owns and trades the stock: insider activity (Form 4) with an
// open-market conviction read + flow charts, institutional holdings (13F) with a
// QoQ change table, large beneficial stakes (SC 13D/13G), and proposed insider
// sales (Form 144). All driven off the shared CompanyAux bundle.
import { useMemo } from "react";

import { DataTable, type Column } from "../../components/DataTable";
import { Term } from "../../components/InfoTip";
import { NameContext } from "../../components/NameContext";
import {
  SimpleBarChart, PairedBarChart, DivergingBarChart, HorizontalBarChart, CumulativeLineChart,
} from "../../components/charts/charts.lazy";
import { LoadingOwnership } from "../../components/Skeletons";
import { analyzeInsider, TX_CODE_INFO } from "../../lib/domain/insider";
import { fmtUSD, fmtNum, fmtPct, fmtDate } from "../../lib/utils/format";
import type {
  InsiderTransaction, InstitutionalHolding, BeneficialOwnership, ProposedSale,
} from "../../lib/types";
import type { CompanyAux } from "./companyAux";

export function OwnershipTab({ aux }: { aux: CompanyAux }) {
  const { insider, holdings, beneficial, proposed, loading } = aux;

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
