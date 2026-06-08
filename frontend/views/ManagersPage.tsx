"use client";
// Managers view — a manager-centric read of Form 13F: each tracked institution
// (Vanguard, BlackRock, State Street, …) and the companies it actually invests
// in, ranked by position size. The inverse of the per-company "Institutional
// Holdings" section. Self-contained (own data + types, CSS classes only), so it
// follows the views/ extraction pattern (see GuidePage).
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { fetchManagerPortfolios } from "../lib/data/data";
import { fmtUSD, fmtNum, fmtPct, fmtDate } from "../lib/utils/format";
import type { Company, ManagerPortfolio } from "../lib/types";

// Build the 13f.info URL for a 13F so the holdings can be cross-checked on a
// human-readable reference site. 13f.info routes purely by the dash-stripped
// accession number — a bare accession 301-redirects to its canonical slug page
// (e.g. .../000201238326001841-blackrock-inc-q1-2026), so the accession alone is
// all we need.
function info13fUrl(accession: string | null): string | undefined {
  if (!accession) return undefined;
  const accNoDash = accession.replace(/-/g, "");
  if (!/^\d+$/.test(accNoDash)) return undefined;
  return `https://13f.info/13f/${accNoDash}`;
}

// Clickable source-filing chip: the file name (accession) opens the 13F on 13f.info.
function FilingLink({ accession, filedAt }: { accession: string | null; filedAt?: string | null }) {
  const href = info13fUrl(accession);
  if (!href || !accession) return <span className="muted">—</span>;
  return (
    <a className="mgr-file" href={href} target="_blank" rel="noopener noreferrer"
       onClick={(e) => e.stopPropagation()} title="Cross-check this 13F on 13f.info">
      📄 {accession}{filedAt ? ` · filed ${fmtDate(filedAt)}` : ""} · 13f.info ↗
    </a>
  );
}

// Curated label → display name. The backend stores the matcher key (uppercase);
// title-casing alone mangles a few, so spell the common ones out. Falls back to
// Title Case for anything not listed.
const MANAGER_LABEL: Record<string, string> = {
  "VANGUARD GROUP": "Vanguard Group",
  "BLACKROCK": "BlackRock",
  "STATE STREET CORP": "State Street",
  "FMR LLC": "Fidelity (FMR)",
  "JPMORGAN CHASE": "JPMorgan Chase",
  "PRICE T ROWE": "T. Rowe Price",
  "WELLINGTON MANAGEMENT GROUP": "Wellington Management",
  "GEODE CAPITAL MANAGEMENT": "Geode Capital",
  "NORTHERN TRUST CORP": "Northern Trust",
  "MORGAN STANLEY": "Morgan Stanley",
  "GOLDMAN SACHS GROUP": "Goldman Sachs",
  "INVESCO LTD": "Invesco",
  "DIMENSIONAL FUND ADVISORS": "Dimensional (DFA)",
  "BANK OF AMERICA CORP": "Bank of America",
  "BERKSHIRE HATHAWAY": "Berkshire Hathaway",
  "CITADEL ADVISORS": "Citadel Advisors",
  "FRANKLIN RESOURCES": "Franklin Templeton",
  "CHARLES SCHWAB INVESTMENT": "Charles Schwab",
  "ALLIANCEBERNSTEIN": "AllianceBernstein",
  "JANUS HENDERSON": "Janus Henderson",
  "BANK OF NEW YORK MELLON": "BNY Mellon",
  "WELLS FARGO": "Wells Fargo",
  "UBS GROUP": "UBS",
  "AMUNDI": "Amundi",
  "CAPITAL RESEARCH GLOBAL": "Capital Group · Research Global",
  "CAPITAL WORLD INVESTORS": "Capital Group · World Investors",
  "BLACKSTONE": "Blackstone",
  "BRIDGEWATER ASSOCIATES": "Bridgewater Associates",
  "RENAISSANCE TECHNOLOGIES": "Renaissance Technologies",
  "TWO SIGMA INVESTMENTS": "Two Sigma",
  "MILLENNIUM MANAGEMENT": "Millennium",
  "POINT72 ASSET MANAGEMENT": "Point72",
  "D. E. SHAW": "D. E. Shaw",
  "AQR CAPITAL": "AQR Capital",
  "ELLIOTT INVESTMENT": "Elliott Management",
  "PERSHING SQUARE CAPITAL": "Pershing Square",
  "TIGER GLOBAL": "Tiger Global",
  "COATUE": "Coatue",
  "VIKING GLOBAL": "Viking Global",
  "THIRD POINT": "Third Point",
  "ICAHN": "Icahn (Carl Icahn)",
  "SOROS FUND": "Soros Fund Management",
  "MARKEL": "Markel",
  "DODGE & COX": "Dodge & Cox",
  "HARRIS ASSOCIATES": "Harris Associates (Oakmark)",
  "BAILLIE GIFFORD": "Baillie Gifford",
  "FISHER ASSET": "Fisher Investments",
  "NORGES BANK": "Norges Bank (Norway)",
  "CANADA PENSION": "Canada Pension Plan",
  "GATES FOUNDATION": "Gates Foundation",
};

function managerLabel(key: string): string {
  return MANAGER_LABEL[key]
    ?? key.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function quarterLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

// Buy/sell move classification → display label + CSS class.
const ACTION_META: Record<NonNullable<ManagerPortfolio["action"]>, { label: string; cls: string }> = {
  new:       { label: "New buy", cls: "act-new" },
  added:     { label: "Added",   cls: "act-add" },
  trimmed:   { label: "Trimmed", cls: "act-trim" },
  exited:    { label: "Sold out", cls: "act-exit" },
  unchanged: { label: "Hold",    cls: "act-hold" },
};
const BUYS = new Set(["new", "added"]);
const SELLS = new Set(["trimmed", "exited"]);

function ActionBadge({ a }: { a: ManagerPortfolio["action"] }) {
  if (!a) return <span className="muted">—</span>;
  const m = ACTION_META[a];
  return <span className={`mgr-act ${m.cls}`}>{m.label}</span>;
}

// $ magnitude of a sell, for ranking the heaviest reductions/exits.
function sellSize(h: ManagerPortfolio): number {
  return Math.max(0, (h.prior_value ?? 0) - (h.value ?? 0));
}

// One manager rolled up to its most recent reported quarter.
type ManagerRollup = {
  managerCik: string;
  name: string;
  period: string;
  holdings: ManagerPortfolio[];   // top-N positions, largest first (excl. exits)
  exits: ManagerPortfolio[];      // positions sold out of the top book this quarter
  aum: number | null;             // full 13F equity value, recovered from value / pct
  hasMoves: boolean;              // whether buy/sell deltas are available yet
  topBuy: ManagerPortfolio | null;
  topSell: ManagerPortfolio | null;
  accession: string | null;       // source 13F-HR accession (for the EDGAR link)
  filedAt: string | null;
};

function rollup(rows: ManagerPortfolio[]): ManagerRollup[] {
  const byMgr = new Map<string, ManagerPortfolio[]>();
  for (const r of rows) {
    const arr = byMgr.get(r.manager_cik);
    if (arr) arr.push(r); else byMgr.set(r.manager_cik, [r]);
  }

  const out: ManagerRollup[] = [];
  for (const [managerCik, all] of byMgr) {
    // Keep only the most recent quarter we have for this manager.
    const period = all.reduce((m, r) => (r.period_of_report > m ? r.period_of_report : m), all[0].period_of_report);
    const quarter = all.filter((r) => r.period_of_report === period);
    const holdings = quarter
      .filter((r) => r.action !== "exited")
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const exits = quarter
      .filter((r) => r.action === "exited")
      .sort((a, b) => sellSize(b) - sellSize(a));

    // The stored pct is value / full-portfolio-total, so we can recover the
    // manager's full 13F equity AUM (top-N is only a slice of it).
    const ref = holdings.find((h) => h.value != null && h.pct_of_portfolio);
    const aum = ref ? (ref.value as number) / ((ref.pct_of_portfolio as number) / 100) : null;

    const hasMoves = quarter.some((h) => h.action);
    const topBuy = holdings
      .filter((h) => h.action && BUYS.has(h.action))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0] ?? null;
    const topSell = [...holdings, ...exits]
      .filter((h) => h.action && SELLS.has(h.action))
      .sort((a, b) => sellSize(b) - sellSize(a))[0] ?? null;

    const src = quarter.find((r) => r.accession_number) ?? quarter[0];
    out.push({
      managerCik, name: managerLabel(quarter[0].manager_name), period,
      holdings, exits, aum, hasMoves, topBuy, topSell,
      accession: src.accession_number, filedAt: src.filed_at,
    });
  }
  return out.sort((a, b) => (b.aum ?? 0) - (a.aum ?? 0));
}

export function ManagersPage({
  companies, onCompany,
}: { companies: Company[]; onCompany: (cik: string) => void }) {
  const [rows, setRows] = useState<ManagerPortfolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [moveFilter, setMoveFilter] = useState<"all" | "buying" | "selling">("all");

  useEffect(() => {
    fetchManagerPortfolios().then((r) => { setRows(r); setLoading(false); });
  }, []);

  // Ticker → CIK for the tracked watchlist, so a holding in a company we cover
  // deep-links to its page; everything else is shown but not navigable.
  const tickerToCik = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companies) if (c.ticker) m.set(c.ticker.toUpperCase(), c.cik);
    return m;
  }, [companies]);

  const managers = useMemo(() => rollup(rows), [rows]);
  const active = useMemo(
    () => managers.find((m) => m.managerCik === selected) ?? null,
    [managers, selected],
  );

  const leaderCols: Column<ManagerRollup>[] = [
    { key: "name", header: "Manager", value: (m) => m.name,
      render: (m) => <strong style={{ color: "var(--accent)" }}>{m.name}</strong> },
    { key: "quarter", header: "Quarter", width: "100px", value: (m) => m.period,
      render: (m) => <span className="muted">{quarterLabel(m.period)}</span> },
    { key: "aum", header: "13F Equity AUM", align: "right", value: (m) => m.aum ?? 0,
      render: (m) => <span className="dt-num">{fmtUSD(m.aum)}</span> },
    { key: "positions", header: "Positions", align: "right", width: "90px",
      value: (m) => m.holdings.length,
      render: (m) => <span className="dt-num muted">{m.holdings.length}</span> },
    { key: "moves", header: "Latest buy / sell", width: "210px",
      value: (m) => `${m.topBuy?.ticker ?? ""} ${m.topSell?.ticker ?? ""}`,
      render: (m) => (
        m.hasMoves ? (
          <span className="mgr-moves">
            {m.topBuy && <span className="mgr-move buy">▲ {m.topBuy.ticker ?? m.topBuy.issuer}</span>}
            {m.topSell && <span className="mgr-move sell">▼ {m.topSell.ticker ?? m.topSell.issuer}</span>}
            {!m.topBuy && !m.topSell && <span className="muted">no major moves</span>}
          </span>
        ) : <span className="muted">—</span>
      ) },
    { key: "top", header: "Largest holdings", value: (m) => m.holdings.map((h) => h.ticker).join(" "),
      render: (m) => (
        <span className="mgr-toplist">
          {m.holdings.slice(0, 5).map((h) => (
            <span key={h.cusip} className="mgr-tk">{h.ticker ?? h.issuer ?? "—"}</span>
          ))}
        </span>
      ) },
    { key: "source", header: "Verify", width: "110px", value: (m) => m.accession ?? "",
      render: (m) => {
        const href = info13fUrl(m.accession);
        return href
          ? <a className="mgr-file" href={href} target="_blank" rel="noopener noreferrer"
               onClick={(e) => e.stopPropagation()} title={`Cross-check ${m.accession} on 13f.info`}>13f.info ↗</a>
          : <span className="muted">—</span>;
      } },
  ];

  const holdingCell: Column<ManagerPortfolio> = {
    key: "ticker", header: "Holding", width: "90px", value: (h) => h.ticker ?? "",
    render: (h) => {
      const cik = h.ticker ? tickerToCik.get(h.ticker.toUpperCase()) : undefined;
      return cik
        ? <strong className="mgr-link" onClick={(e) => { e.stopPropagation(); onCompany(cik); }} style={{ color: "var(--accent)" }}>{h.ticker}</strong>
        : <strong>{h.ticker ?? "—"}</strong>;
    },
  };
  const moveCell: Column<ManagerPortfolio> = {
    key: "action", header: "Move", width: "92px", value: (h) => h.action ?? "",
    render: (h) => <ActionBadge a={h.action} />,
  };
  const changeCell: Column<ManagerPortfolio> = {
    key: "change", header: "Δ Shares", align: "right", width: "120px",
    value: (h) => h.share_change ?? 0,
    render: (h) => {
      if (h.action === "new") return <span className="dt-num buy">new</span>;
      if (h.action === "exited") return <span className="dt-num sell">exited</span>;
      const d = h.share_change;
      if (d == null || d === 0) return <span className="dt-num muted">—</span>;
      const cls = d > 0 ? "buy" : "sell";
      return <span className={`dt-num ${cls}`}>{d > 0 ? "+" : "−"}{fmtNum(Math.abs(d), 0)}</span>;
    },
  };

  const holdCols: Column<ManagerPortfolio>[] = [
    { key: "rank", header: "#", width: "44px", align: "right", value: (h) => h.rank ?? 0,
      render: (h) => <span className="dt-num muted">{h.rank ?? "—"}</span> },
    holdingCell,
    { key: "issuer", header: "Company", value: (h) => h.issuer ?? "",
      render: (h) => <span className="muted">{h.issuer ?? "—"}</span> },
    moveCell,
    changeCell,
    { key: "value", header: "Position Value", align: "right", value: (h) => h.value ?? 0,
      render: (h) => <span className="dt-num">{fmtUSD(h.value)}</span> },
    { key: "pct", header: "% of Portfolio", align: "right", value: (h) => h.pct_of_portfolio ?? 0,
      render: (h) => <span className="dt-num">{h.pct_of_portfolio != null ? fmtPct(h.pct_of_portfolio) : "—"}</span> },
  ];

  // Selling table: ranked by $ reduced/exited, showing what they were worth before.
  const sellCols: Column<ManagerPortfolio>[] = [
    holdingCell,
    { key: "issuer", header: "Company", value: (h) => h.issuer ?? "",
      render: (h) => <span className="muted">{h.issuer ?? "—"}</span> },
    moveCell,
    changeCell,
    { key: "priorval", header: "Was", align: "right", value: (h) => h.prior_value ?? 0,
      render: (h) => <span className="dt-num muted">{fmtUSD(h.prior_value)}</span> },
    { key: "value", header: "Now", align: "right", value: (h) => h.value ?? 0,
      render: (h) => <span className="dt-num">{h.action === "exited" ? "—" : fmtUSD(h.value)}</span> },
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">Managers</h1>
        <p className="empty-note">Loading institutional portfolios…</p>
      </div>
    );
  }

  if (managers.length === 0) {
    return (
      <div className="page-head">
        <h1 className="page-title">Managers</h1>
        <p className="empty-note">
          <strong>No manager portfolios yet.</strong> Run <code>schema.sql</code> in
          Supabase to create the <code>manager_portfolios</code> table, then let the
          13F ingest populate it (weekly cadence, or <code>python main.py AAPL</code> to force it now).
        </p>
      </div>
    );
  }

  // ── Detail: one manager's portfolio + what they're buying / selling ─────────
  if (active) {
    const buying = active.holdings
      .filter((h) => h.action && BUYS.has(h.action))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const selling = [...active.holdings.filter((h) => h.action === "trimmed"), ...active.exits]
      .sort((a, b) => sellSize(b) - sellSize(a));

    const view =
      moveFilter === "buying" ? { rows: buying, cols: holdCols, sort: "value", empty: "No new or added positions this quarter." }
      : moveFilter === "selling" ? { rows: selling, cols: sellCols, sort: "priorval", empty: "No trimmed or exited positions this quarter." }
      : { rows: active.holdings, cols: holdCols, sort: "value", empty: "No holdings." };

    return (
      <div>
        <div className="page-head-row">
          <button className="chip" onClick={() => { setSelected(null); setMoveFilter("all"); }}>← All managers</button>
        </div>
        <div className="page-head">
          <h1 className="page-title">{active.name}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            13F as of {quarterLabel(active.period)} · {active.holdings.length} top positions ·
            {" "}{fmtUSD(active.aum)} total equity AUM
            {active.hasMoves && <> · <span className="buy">{buying.length} buys</span> · <span className="sell">{selling.length} sells</span> vs prior quarter</>}
          </p>
          <div style={{ marginTop: 8 }}>
            <span className="label-caps" style={{ marginRight: 8 }}>Verify on</span>
            <FilingLink accession={active.accession} filedAt={active.filedAt} />
          </div>
        </div>

        {active.hasMoves ? (
          <div className="page-head-row" style={{ marginBottom: 14 }}>
            <button className={`chip${moveFilter === "all" ? " active" : ""}`} onClick={() => setMoveFilter("all")}>All holdings</button>
            <button className={`chip${moveFilter === "buying" ? " active" : ""}`} onClick={() => setMoveFilter("buying")}>▲ Buying ({buying.length})</button>
            <button className={`chip${moveFilter === "selling" ? " active" : ""}`} onClick={() => setMoveFilter("selling")}>▼ Selling ({selling.length})</button>
          </div>
        ) : (
          <p className="empty-note" style={{ marginBottom: 14 }}>
            <strong>Buy/sell moves appear once two quarters are on file.</strong> This is the
            first 13F stored for this manager, so there&apos;s no prior quarter to compare against yet.
          </p>
        )}

        <div className="section-title">
          {moveFilter === "buying" ? "What they're buying" : moveFilter === "selling" ? "What they're selling" : "What they invest in"}
        </div>
        <DataTable
          columns={view.cols}
          rows={view.rows}
          rowKey={(h) => h.cusip}
          initialSort={{ key: view.sort, dir: "desc" }}
          filterable
          filterPlaceholder="Filter holdings…"
          empty={view.empty}
        />
        <p className="empty-note" style={{ marginTop: 14 }}>
          Positions are common-stock longs from Form 13F-HR (options excluded); moves are vs the
          manager&apos;s prior 13F. Filings lag up to 45 days after quarter-end, and &ldquo;new/sold&rdquo;
          are relative to the manager&apos;s largest holdings. Tickers in <strong>teal</strong> are on
          your watchlist — click to open them.
        </p>
      </div>
    );
  }

  // ── Leaderboard: all tracked managers ───────────────────────────────────────
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Managers</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          The largest institutional managers, the companies they invest in, and what they
          bought or sold last quarter (Form 13F-HR). Click a manager for its full portfolio
          and buy/sell moves.
        </p>
      </div>
      <DataTable
        columns={leaderCols}
        rows={managers}
        rowKey={(m) => m.managerCik}
        onRowClick={(m) => setSelected(m.managerCik)}
        initialSort={{ key: "aum", dir: "desc" }}
        filterable
        filterPlaceholder="Filter managers…"
      />
    </div>
  );
}
