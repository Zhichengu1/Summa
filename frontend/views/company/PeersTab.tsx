"use client";
// Peers tab — compares the active company against the rest of the watchlist on a
// few headline metrics (revenue YoY, net margin, P/E, P/S, market cap) plus the
// watchlist median for each. Valuation uses a diluted-share proxy.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../../components/DataTable";
import { seriesFor, METRICS } from "../../lib/domain/fundamentals";
import { fetchIncomeFactsForCiks, fetchRecentPrices } from "../../lib/data/data";
import { deriveValuation } from "../../lib/domain/valuation";
import { fmtUSD, fmtNum, fmtPct, fmtDelta } from "../../lib/utils/format";
import type { Company, FinancialFact, DailyPrice } from "../../lib/types";

type PeerRow = {
  cik: string; ticker: string; name: string;
  revG: number | null; netMargin: number | null; pe: number | null; ps: number | null; mcap: number | null;
};

export function PeersTab({ cik, peers }: { cik: string; peers: Company[] }) {
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
