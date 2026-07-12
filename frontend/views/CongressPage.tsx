"use client";
// Congress Trades — STOCK-Act disclosure tracker over `congress_trades`
// (normalized House PTR + Senate eFD filings, refreshed ~daily by
// summa-congress.yml). The headline read is CONSENSUS: stocks that three or
// more distinct members bought — or sold — inside the selected window (default
// the latest 30 days), ranked by how many filers piled in, freshest first
// within a count. A totals strip above the panels sums the window's whole
// buy-vs-sell activity. Disclosures lag the trade by up to 45 days and amounts
// are ranges, so this is sentiment, not a real-time signal. A full trade tape
// sits below the consensus panels — clicking a consensus stock drills the tape
// down to that ticker's individual trades; watchlist tickers on tape rows click
// through to their company page.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { fetchCongressTrades } from "../lib/data/data";
import { fmtUSD, fmtDate, fmtDelta } from "../lib/utils/format";
import { safeHref } from "../lib/utils/url";
import type { Company, CongressTrade } from "../lib/types";

const WINDOWS = [30, 60, 90] as const;

function partyColor(party: string | null): string {
  if (party === "D") return "#3b82f6";
  if (party === "R") return "#ef4444";
  return "var(--fg-3)";
}

// Midpoint of the disclosed amount range — the honest single-number estimate.
function estAmount(t: CongressTrade): number {
  if (t.amount_low != null && t.amount_high != null) return (t.amount_low + t.amount_high) / 2;
  return t.amount_low ?? 0;
}

function SideBadge({ side }: { side: CongressTrade["side"] }) {
  const buy = side === "buy";
  const sell = side === "sell";
  return (
    <span style={{
      background: buy ? "rgba(34,197,94,0.16)" : sell ? "rgba(239,68,68,0.15)" : "rgba(148,163,184,0.15)",
      color: buy ? "var(--pos)" : sell ? "var(--neg)" : "var(--fg-3)",
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700,
      letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>
      {buy ? "BUY" : sell ? "SELL" : "EXCH"}
    </span>
  );
}

type Member = { name: string; party: string | null };

// One consensus row: a ticker with `count` distinct filers on the same side
// inside the window. `trades` = individual transactions on that side;
// `otherSide` = distinct filers on the opposite side.
type Consensus = {
  ticker: string;
  name: string | null;
  count: number;
  members: Member[];
  trades: number;
  estTotal: number;
  lastDate: string;
  otherSide: number;
};

function MembersCell({ members }: { members: Member[] }) {
  const shown = members.slice(0, 3);
  const full = members.map((m) => `${m.name}${m.party ? ` (${m.party})` : ""}`).join(", ");
  return (
    <span title={full} style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block", maxWidth: 260 }}>
      {shown.map((m, i) => (
        <span key={m.name}>
          {i > 0 && <span className="muted">, </span>}
          <span style={{ color: partyColor(m.party) }}>{m.name}</span>
        </span>
      ))}
      {members.length > shown.length && <span className="muted"> +{members.length - shown.length}</span>}
    </span>
  );
}

export function CongressPage({ companies, onCompany }: {
  companies: Company[];
  onCompany: (cik: string) => void;
}) {
  const [rows, setRows] = useState<CongressTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [minFilers, setMinFilers] = useState<number>(3);
  // Drill-down: a consensus row click narrows the tape to that ticker.
  const [detailTicker, setDetailTicker] = useState<string | null>(null);

  useEffect(() => {
    fetchCongressTrades().then((r) => { setRows(r); setLoading(false); });
  }, []);

  // Watchlist ticker → cik, for stars + click-through to the company page.
  const watchByTicker = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companies) if (c.ticker) m.set(c.ticker.toUpperCase(), c.cik);
    return m;
  }, [companies]);

  const inWindow = useMemo(() => {
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
    return rows.filter((r) => r.transaction_date >= cutoff);
  }, [rows, windowDays]);

  // Per-ticker consensus: distinct filers per side, trade counts, est. dollar
  // totals, recency — ranked most members first, then freshest last trade.
  const { buys, sells } = useMemo(() => {
    type Agg = {
      ticker: string; name: string | null; lastDate: string;
      buyers: Map<string, Member>; sellers: Map<string, Member>;
      buyEst: number; sellEst: number; buyN: number; sellN: number;
    };
    const byTicker = new Map<string, Agg>();
    for (const t of inWindow) {
      if (t.side === "exchange") continue;
      let a = byTicker.get(t.ticker);
      if (!a) {
        a = { ticker: t.ticker, name: null, lastDate: t.transaction_date, buyers: new Map(), sellers: new Map(), buyEst: 0, sellEst: 0, buyN: 0, sellN: 0 };
        byTicker.set(t.ticker, a);
      }
      if (t.asset_name && !a.name) a.name = t.asset_name.replace(/ - Common Stock$/i, "");
      if (t.transaction_date > a.lastDate) a.lastDate = t.transaction_date;
      const key = t.filer_id ?? t.filer_name ?? "?";
      const member: Member = { name: t.filer_name ?? "Unknown", party: t.party };
      if (t.side === "buy") { a.buyers.set(key, member); a.buyEst += estAmount(t); a.buyN += 1; }
      else { a.sellers.set(key, member); a.sellEst += estAmount(t); a.sellN += 1; }
    }
    const build = (side: "buy" | "sell"): Consensus[] =>
      Array.from(byTicker.values())
        .map((a) => ({
          ticker: a.ticker,
          name: a.name,
          count: side === "buy" ? a.buyers.size : a.sellers.size,
          members: Array.from((side === "buy" ? a.buyers : a.sellers).values()),
          trades: side === "buy" ? a.buyN : a.sellN,
          estTotal: side === "buy" ? a.buyEst : a.sellEst,
          lastDate: a.lastDate,
          otherSide: side === "buy" ? a.sellers.size : a.buyers.size,
        }))
        .filter((c) => c.count >= minFilers)
        .sort((x, y) => y.count - x.count || y.lastDate.localeCompare(x.lastDate) || y.estTotal - x.estTotal);
    return { buys: build("buy"), sells: build("sell") };
  }, [inWindow, minFilers]);

  // Window-wide totals per side — the "total recent buys vs sells" headline.
  const totals = useMemo(() => {
    const make = () => ({ trades: 0, members: new Set<string>(), est: 0 });
    const t = { buy: make(), sell: make() };
    for (const r of inWindow) {
      if (r.side !== "buy" && r.side !== "sell") continue;
      const s = t[r.side];
      s.trades += 1;
      s.members.add(r.filer_id ?? r.filer_name ?? "?");
      s.est += estAmount(r);
    }
    return t;
  }, [inWindow]);

  const tapeRows = useMemo(
    () => (detailTicker ? inWindow.filter((r) => r.ticker === detailTicker) : inWindow),
    [inWindow, detailTicker],
  );

  const consensusCols = (side: "buy" | "sell"): Column<Consensus>[] => [
    { key: "ticker", header: "Ticker", width: "110px", value: (r) => r.ticker,
      render: (r) => (
        <span style={{ color: "var(--accent)", fontWeight: 700, whiteSpace: "nowrap" }}>
          {r.ticker}
          {watchByTicker.has(r.ticker) && <span title="On your watchlist" style={{ marginLeft: 4 }}>⭐</span>}
          {r.otherSide > 0 && (
            <span title={`Contested: ${r.otherSide} member${r.otherSide > 1 ? "s" : ""} on the other side in the same window`}
              style={{ marginLeft: 4 }}>⚖️</span>
          )}
        </span>
      ) },
    { key: "name", header: "Company", value: (r) => r.name ?? "",
      render: (r) => (
        <span className={r.name ? undefined : "muted"}
          style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block", maxWidth: 200 }}>
          {r.name ?? "—"}
        </span>
      ) },
    { key: "count", header: side === "buy" ? "Buyers" : "Sellers", width: "78px", align: "right",
      value: (r) => r.count,
      render: (r) => (
        <span style={{ fontWeight: 700, color: side === "buy" ? "var(--pos)" : "var(--neg)" }}>{r.count}</span>
      ) },
    { key: "trades", header: "Trades", width: "70px", align: "right", value: (r) => r.trades,
      render: (r) => (
        <span className="muted" title={`${r.trades} individual ${side} transaction${r.trades !== 1 ? "s" : ""} in the window`}>
          {r.trades}
        </span>
      ) },
    { key: "members", header: "Members", value: () => null,
      render: (r) => <MembersCell members={r.members} /> },
    { key: "est", header: "Est. total", width: "96px", align: "right", value: (r) => r.estTotal,
      render: (r) => <span title="Sum of disclosed-range midpoints — disclosures give ranges, not exact amounts">~{fmtUSD(r.estTotal)}</span> },
    { key: "last", header: "Last trade", width: "104px", align: "right", value: (r) => r.lastDate,
      render: (r) => <span className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDate(r.lastDate, { utc: true })}</span> },
  ];

  const tapeCols: Column<CongressTrade>[] = [
    { key: "date", header: "Traded", width: "100px", value: (r) => r.transaction_date,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{fmtDate(r.transaction_date, { utc: true })}</span> },
    { key: "member", header: "Member", width: "220px", value: (r) => r.filer_name ?? "",
      render: (r) => (
        <span title={r.office ?? undefined} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block", maxWidth: 210 }}>
          <span style={{ fontWeight: 600 }}>{r.filer_name ?? "—"}</span>
          {(r.party || r.state) && (
            <span style={{ marginLeft: 6, fontSize: 11, color: partyColor(r.party) }}>
              {[r.party, r.state].filter(Boolean).join("·")}
            </span>
          )}
        </span>
      ) },
    { key: "ticker", header: "Ticker", width: "90px", value: (r) => r.ticker,
      render: (r) => (
        <span style={{ color: "var(--accent)", fontWeight: 700 }}>
          {r.ticker}{watchByTicker.has(r.ticker) && <span title="On your watchlist" style={{ marginLeft: 4 }}>⭐</span>}
        </span>
      ) },
    { key: "side", header: "Side", width: "72px", value: (r) => r.side,
      render: (r) => <SideBadge side={r.side} /> },
    { key: "amount", header: "Amount", width: "150px", align: "right", value: (r) => estAmount(r),
      render: (r) => <span className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{r.amount_label ?? "—"}</span> },
    { key: "owner", header: "Owner", width: "84px", value: (r) => r.owner ?? "",
      render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.owner ?? "—"}</span> },
    { key: "ret", header: "Since trade", width: "96px", align: "right", value: (r) => r.ret_since,
      render: (r) => r.ret_since == null ? <span className="muted">—</span> : (
        <span title={r.excess_since != null ? `${fmtDelta(r.excess_since)} vs the market` : undefined}
          style={{ fontWeight: 600, color: r.ret_since >= 0 ? "var(--pos)" : "var(--neg)" }}>
          {fmtDelta(r.ret_since)}
        </span>
      ) },
    { key: "filed", header: "Filed", width: "112px", align: "right", value: (r) => r.filing_date,
      render: (r) => (
        <span className="muted" style={{ whiteSpace: "nowrap" }}>
          {fmtDate(r.filing_date, { utc: true })}
          {r.is_late && <span title="Filed past the 45-day STOCK-Act deadline" style={{ marginLeft: 4 }}>⚠️</span>}
        </span>
      ) },
    { key: "doc", header: "Doc", width: "56px", value: () => null,
      render: (r) => {
        const href = safeHref(r.doc_url);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
            style={{ color: "var(--accent)" }}>↗</a>
        ) : <span className="muted">—</span>;
      } },
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">Congress Trades</h1>
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  const emptyNote = rows.length === 0
    ? "No congressional trades yet — the summa-congress workflow writes the first batch on its next run (apply the updated schema.sql first)."
    : `No ticker has ${minFilers}+ distinct members on this side in the last ${windowDays} days — widen the window or lower the bar.`;

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Congress Trades</h1>
        <div className="page-sub">
          STOCK-Act disclosures (House PTR + Senate eFD) · consensus = {minFilers}+ distinct members on the
          same side of one stock within the latest {windowDays} days · click a consensus stock to see its
          individual trades below · disclosures can lag trades by up to 45 days
        </div>
      </div>

      <div className="toggle-row">
        {WINDOWS.map((d) => (
          <button key={d} className={`chip${windowDays === d ? " active" : ""}`} onClick={() => setWindowDays(d)}>
            {d}d
          </button>
        ))}
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 4px" }} />
        {[2, 3, 4].map((n) => (
          <button key={n} className={`chip${minFilers === n ? " active" : ""}`}
            title={`Require at least ${n} distinct members on the same side`}
            onClick={() => setMinFilers(n)}>
            {n}+ members
          </button>
        ))}
      </div>

      <div className="kpi-strip dense" style={{ marginBottom: 16 }}>
        {(["buy", "sell"] as const).map((side) => {
          const t = totals[side];
          const buySide = side === "buy";
          return (
            <div key={side} className="kpi">
              <div className="k-label" style={{ color: buySide ? "var(--pos)" : "var(--neg)" }}>
                {buySide ? "▲ Total buys" : "▼ Total sells"} · last {windowDays}d
              </div>
              <div className="k-value" style={{ color: buySide ? "var(--pos)" : "var(--neg)" }}>
                {t.trades.toLocaleString()} <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-3)" }}>trades</span>
              </div>
              <div className="k-delta">
                <span>{t.members.size} member{t.members.size !== 1 ? "s" : ""}</span>
                <span title="Sum of disclosed-range midpoints — disclosures give ranges, not exact amounts">~{fmtUSD(t.est)} est.</span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(430px, 1fr))", gap: 16, marginBottom: 24 }}>
        <div>
          <div style={{ fontWeight: 700, margin: "4px 0 8px", color: "var(--pos)" }}>
            ▲ Consensus buys · {buys.length}
          </div>
          <DataTable
            columns={consensusCols("buy")} rows={buys} rowKey={(r) => r.ticker}
            initialSort={{ key: "count", dir: "desc" }}
            empty={emptyNote} maxHeight="340px"
            onRowClick={(r) => setDetailTicker(r.ticker)}
          />
        </div>
        <div>
          <div style={{ fontWeight: 700, margin: "4px 0 8px", color: "var(--neg)" }}>
            ▼ Consensus sells · {sells.length}
          </div>
          <DataTable
            columns={consensusCols("sell")} rows={sells} rowKey={(r) => r.ticker}
            initialSort={{ key: "count", dir: "desc" }}
            empty={emptyNote} maxHeight="340px"
            onRowClick={(r) => setDetailTicker(r.ticker)}
          />
        </div>
      </div>

      <div style={{ fontWeight: 700, margin: "4px 0 8px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {detailTicker
          ? `${detailTicker} — every disclosed trade · last ${windowDays} days · ${tapeRows.length}`
          : `All disclosed trades · last ${windowDays} days · ${inWindow.length}`}
        {detailTicker && (
          <button className="chip active" onClick={() => setDetailTicker(null)}
            title="Clear the ticker drill-down and show every trade in the window">
            ✕ show all
          </button>
        )}
      </div>
      <DataTable
        columns={tapeCols} rows={tapeRows} rowKey={(r) => r.id}
        filterable filterPlaceholder="Filter by member, ticker, state…"
        initialSort={{ key: "date", dir: "desc" }}
        empty={rows.length === 0 ? emptyNote : "No trades in this window."}
        maxHeight="calc(100vh - 320px)"
        onRowClick={(r) => { const cik = watchByTicker.get(r.ticker); if (cik) onCompany(cik); }}
      />
    </div>
  );
}
