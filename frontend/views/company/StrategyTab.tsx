"use client";
// Strategy & Investments tab — answers "what is this company investing in, and
// where is it heading?" from three angles: its industry category + forward themes
// (curated taxonomy), its own capital allocation (R&D and CapEx — money committed
// to the future), and its outbound investments in other companies (acquisitions +
// any disclosed 13F portfolio).
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../../components/DataTable";
import { ComboChart, SimpleBarChart } from "../../components/charts/charts.lazy";
import { SkeletonChart } from "../../components/Skeletons";
import { seriesFor, METRICS } from "../../lib/domain/fundamentals";
import { fetchCorporateEvents, fetchManagerHoldings } from "../../lib/data/data";
import { profileFor } from "../../lib/domain/taxonomy";
import { fmtUSD, fmtNum, fmtPct, fmtDate, fmtPeriodLabel } from "../../lib/utils/format";
import type {
  FinancialFact, CorporateEvent, InstitutionalHolding, StatementKind, PeriodType,
} from "../../lib/types";

/** Prefer annual series for a clean multi-year story; fall back to quarterly. */
function annualOrQuarterly(facts: FinancialFact[], statement: StatementKind, match: (f: FinancialFact) => boolean) {
  const a = seriesFor(facts, statement, "annual", match);
  if (a.length > 1) return { points: a, period: "annual" as PeriodType };
  return { points: seriesFor(facts, statement, "quarterly", match), period: "quarterly" as PeriodType };
}

export function StrategyTab({
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
