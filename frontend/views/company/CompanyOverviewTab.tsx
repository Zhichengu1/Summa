"use client";
// Company cockpit ("Overview" tab) — a terminal-style dashboard that answers three
// questions at a glance, every element ranked by how directly it moves the price:
//   00 HEALTH    — a plain-English verdict (Scorecard)
//   01 NOW       — where the company stands (headline fundamentals + price/technicals)
//   02 HAPPENED  — a merged tape of recent price-moving disclosures
//   03 GOING     — synthesized forward-looking signals
// The deep dives (Fundamentals / Ownership / Catalysts / Filings) stay as tabs.
import { useMemo } from "react";

import { DataTable, type Column } from "../../components/DataTable";
import { InfoTip } from "../../components/InfoTip";
import { FormBadge } from "../../components/badges/FormBadge";
import { KpiTile } from "../../components/strips/KpiTile";
import { PriceStrip } from "../../components/strips/PriceStrip";
import { TechStrip } from "../../components/strips/TechStrip";
import { SignalCard } from "../../components/SignalCard";
import { TapeRow } from "../../components/TapeRow";
import { Scorecard } from "../../components/Scorecard";
import { ComboChart, PriceChart } from "../../components/charts/charts.lazy";
import { seriesFor, deriveKpis, yoyGrowth, METRICS } from "../../lib/domain/fundamentals";
import { buildTape, buildSignals, EVENT_CLASS_DIR } from "../../lib/domain/pulse";
import { buildScorecard } from "../../lib/domain/scorecard";
import { derivePriceKpis, reactionStats } from "../../lib/domain/prices";
import { deriveValuation } from "../../lib/domain/valuation";
import { smaSeries, deriveTechnicals } from "../../lib/domain/technicals";
import { nextEarningsEstimate } from "../../lib/domain/catalysts";
import { safeHref } from "../../lib/utils/url";
import { fmtUSD, fmtNum, fmtDate, fmtPeriodLabel, elapsed } from "../../lib/utils/format";
import type { FinancialFact, Filing } from "../../lib/types";
import type { CompanyAux } from "./companyAux";

export function CompanyOverviewTab({
  facts, loading, aux,
}: { facts: FinancialFact[]; loading: boolean; aux: CompanyAux }) {
  const { earnings, events, insider, holdings, beneficial, offers, lateF, prices } = aux;
  const recentFilings = useMemo(() => aux.filings.slice(0, 10), [aux.filings]);
  const loadingAux = aux.loading;

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
  const tech      = useMemo(() => deriveTechnicals(prices), [prices]);

  // Trader timing: how the stock has historically moved on earnings, and an
  // estimate of when the next report lands (from the historical cadence).
  const earnDates = useMemo(() => earnings.map((e) => e.reported_date ?? e.filed_at), [earnings]);
  const earnReaction = useMemo(() => reactionStats(prices, earnDates), [prices, earnDates]);
  const nextEarn = useMemo(() => nextEarningsEstimate(earnDates), [earnDates]);

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
            <TechStrip t={tech} />
            {(earnReaction.avgAbs1d != null || nextEarn) && (
              <div className="kpi-strip dense">
                {earnReaction.avgAbs1d != null && (
                  <div className="kpi">
                    <div className="k-label">Expected Move<InfoTip term="Expected Move" /></div>
                    <div className="k-value">±{earnReaction.avgAbs1d.toFixed(1)}%</div>
                    <div className="k-delta"><span className="muted">1d on earnings · {earnReaction.pctUp1d?.toFixed(0)}% up · n={earnReaction.n}</span></div>
                  </div>
                )}
                {nextEarn && (
                  <div className="kpi">
                    <div className="k-label">Next Earnings (est.)<InfoTip term="Next Earnings (est.)" /></div>
                    <div className={`k-value ${nextEarn.daysAway < 0 ? "neg" : ""}`}>{nextEarn.daysAway >= 0 ? `~${nextEarn.daysAway}d` : "overdue"}</div>
                    <div className="k-delta"><span className="muted">{fmtDate(nextEarn.estDate)}</span></div>
                  </div>
                )}
              </div>
            )}
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
