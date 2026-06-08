"use client";
// Catalysts tab — the dated, price-moving disclosures: late-filing notices (red
// flag, shown first), classified corporate events (8-K) with per-event price
// reaction + frequency charts, earnings announcements (8-K 2.02), and securities
// offerings (S-3/424B).
import { useMemo } from "react";

import { DataTable, type Column } from "../../components/DataTable";
import { EventClassBadge } from "../../components/badges/EventClassBadge";
import { GuidanceBadge } from "../../components/badges/GuidanceBadge";
import { SimpleBarChart, StackedBarChart, HorizontalBarChart } from "../../components/charts/charts.lazy";
import { LoadingCatalysts } from "../../components/Skeletons";
import { reactionAround } from "../../lib/domain/prices";
import { fmtUSD, fmtNum, fmtDelta, fmtDate } from "../../lib/utils/format";
import type {
  CorporateEvent, EarningsEvent, LateFiling, SecuritiesOffering,
} from "../../lib/types";
import type { CompanyAux } from "./companyAux";

export function CatalystsTab({ aux }: { aux: CompanyAux }) {
  const { events, earnings, lateF, offers, prices, loading } = aux;

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
