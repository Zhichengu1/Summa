"use client";
// Managers view — a manager-centric read of Form 13F: each tracked institution
// (Vanguard, BlackRock, State Street, …) and the companies it actually invests
// in, ranked by position size. The inverse of the per-company "Institutional
// Holdings" section. The cross-institution aggregation (rollup, consensus) lives in
// lib/domain/managers.ts; this file owns the data fetch, columns, and rendering.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { fetchManagerPortfolios } from "../lib/data/data";
import { fmtUSD, fmtNum, fmtPct, fmtDate } from "../lib/utils/format";
import {
  rollup, buildConsensus, swingSize, sellSize, BUYS,
  type ManagerRollup, type ConsensusRow,
} from "../lib/domain/managers";
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

function quarterLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

// The exact quarter-end date a 13F period covers, e.g. "Mar 31, 2026". Formatted in
// UTC because period_of_report is a bare DATE — local formatting would shift it a day
// back in US timezones (filed_at, a real timestamp at 16:00 UTC, is fine via plain fmtDate).
function periodEndLabel(iso: string | null): string {
  return fmtDate(iso, { utc: true });
}

// The quarter immediately before `iso` (one 13F period back) — the "old" side of
// the latest-vs-prior comparison. Derived by stepping back three months; the moves
// themselves come from the stored prior_shares/prior_value on each row.
function priorQuarterLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  d.setUTCMonth(d.getUTCMonth() - 3);
  return quarterLabel(d.toISOString());
}

// Buy/sell move classification → display label + CSS class.
const ACTION_META: Record<NonNullable<ManagerPortfolio["action"]>, { label: string; cls: string }> = {
  new:       { label: "New buy", cls: "act-new" },
  added:     { label: "Added",   cls: "act-add" },
  trimmed:   { label: "Trimmed", cls: "act-trim" },
  exited:    { label: "Sold out", cls: "act-exit" },
  unchanged: { label: "Hold",    cls: "act-hold" },
};

function ActionBadge({ a }: { a: ManagerPortfolio["action"] }) {
  if (!a) return <span className="muted">—</span>;
  const m = ACTION_META[a];
  return <span className={`mgr-act ${m.cls}`}>{m.label}</span>;
}

export function ManagersPage({
  companies, onCompany,
}: { companies: Company[]; onCompany: (cik: string) => void }) {
  const [rows, setRows] = useState<ManagerPortfolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [moveFilter, setMoveFilter] = useState<"changes" | "buying" | "selling" | "all">("changes");
  const [tab, setTab] = useState<"investors" | "overlap">("investors");
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set());  // managerCiks to intersect
  const [minHolders, setMinHolders] = useState(2);                       // consensus threshold
  const [overlapMode, setOverlapMode] = useState<"all" | "emerging">("all"); // consensus lens

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

  // Cross-institution overlap: every security, with the institutions holding it.
  const consensus = useMemo(() => buildConsensus(managers), [managers]);
  const comparing = compareSet.size >= 2;     // intersection mode vs consensus mode

  // "Held by almost everyone" cutoff: a name in >40% of tracked managers' top books
  // is an index-giant everyone owns (AAPL/MSFT/NVDA) — the well-known names the
  // emerging lens filters OUT. Scales with however many managers are actually on
  // file (so it adapts to any list size), floored above minHolders so it never
  // excludes the very threshold we're looking at, and capped at managers-1 so a
  // single dominant manager can't make the cutoff unreachable.
  const ubiquityCutoff = Math.min(
    Math.max(managers.length - 1, minHolders),
    Math.max(minHolders, Math.ceil(managers.length * 0.4)),
  );
  // The emerging lens needs a prior quarter to compare against; if none is on file
  // yet it can't tell "newly crossed" from "always held," so it stays disabled.
  const emerging = overlapMode === "emerging" && !comparing && consensus.hasPrior;

  const overlapRows = useMemo(() => {
    if (comparing) {
      // Intersection: only securities held by ALL selected investors.
      return consensus.rows.filter((r) => {
        const ciks = new Set(r.holders.map((h) => h.managerCik));
        for (const c of compareSet) if (!ciks.has(c)) return false;
        return true;
      });
    }
    if (emerging) {
      // Emerging consensus: names that NEWLY crossed the threshold this quarter —
      // now held by minHolders+ managers, but fewer than that held it last quarter
      // (so fresh buying pushed it over), AND not already owned by almost everyone.
      return consensus.rows.filter(
        (r) =>
          r.holderCount >= minHolders &&
          r.priorHolders < minHolders &&
          r.newHolders > 0 &&
          r.holderCount <= ubiquityCutoff,
      );
    }
    // Consensus: the crowded names, held by at least `minHolders` institutions.
    return consensus.rows.filter((r) => r.holderCount >= minHolders);
  }, [consensus, comparing, emerging, compareSet, minHolders, ubiquityCutoff]);

  function toggleCompare(cik: string) {
    setCompareSet((s) => {
      const next = new Set(s);
      if (next.has(cik)) next.delete(cik); else next.add(cik);
      return next;
    });
  }

  const overlapCols: Column<ConsensusRow>[] = [
    { key: "ticker", header: "Stock", width: "90px", value: (r) => r.ticker ?? "",
      render: (r) => {
        const cik = r.ticker ? tickerToCik.get(r.ticker.toUpperCase()) : undefined;
        return cik
          ? <strong className="mgr-link" onClick={() => onCompany(cik)} style={{ color: "var(--accent)" }}>{r.ticker}</strong>
          : <strong>{r.ticker ?? "—"}</strong>;
      } },
    { key: "issuer", header: "Company", value: (r) => r.issuer ?? "",
      render: (r) => <span className="muted">{r.issuer ?? "—"}</span> },
    { key: "count", header: "# Investors", align: "right", width: "100px", value: (r) => r.holderCount,
      render: (r) => <span className="dt-num"><strong>{r.holderCount}</strong></span> },
    { key: "holders", header: "Held by", value: (r) => r.holders.map((h) => h.name).join(" "),
      render: (r) => (
        <span className="mgr-toplist">
          {r.holders.slice(0, 5).map((h) => (
            <span key={h.managerCik} className="mgr-tk">{h.name}</span>
          ))}
          {r.holders.length > 5 && <span className="muted">+{r.holders.length - 5} more</span>}
        </span>
      ) },
    { key: "value", header: "Combined Value", align: "right", width: "140px", value: (r) => r.totalValue,
      render: (r) => <span className="dt-num">{fmtUSD(r.totalValue)}</span> },
    { key: "sentiment", header: "This quarter", width: "130px", value: (r) => r.buying - r.selling,
      render: (r) => (
        <span className="mgr-moves">
          {r.buying > 0 && <span className="mgr-move buy">▲ {r.buying} buying</span>}
          {r.selling > 0 && <span className="mgr-move sell">▼ {r.selling} selling</span>}
          {r.buying === 0 && r.selling === 0 && <span className="muted">—</span>}
        </span>
      ) },
  ];

  // Emerging lens: same overlap table, but with a column showing the threshold
  // crossing (how many held it last quarter → now) and ranked by fresh buyers.
  const emergingCols: Column<ConsensusRow>[] = [
    overlapCols[0], // Stock
    overlapCols[1], // Company
    // Freshness: when the most recent fresh buyer disclosed opening the position.
    // Default sort key, so the latest-bought names sit on top.
    { key: "latest", header: "Latest bought", align: "right", width: "150px",
      value: (r) => r.latestBuyAt ?? "",
      render: (r) => (
        <span>
          <strong>{r.latestBuyAt ? fmtDate(r.latestBuyAt) : "—"}</strong>
          <span className="muted" style={{ display: "block", fontSize: "0.82em" }}>
            {quarterLabel(r.latestPeriod)}
          </span>
        </span>
      ) },
    { key: "crossed", header: "Held by (last Q → now)", align: "right", width: "150px",
      value: (r) => r.holderCount,
      render: (r) => (
        <span className="dt-num">
          <span className="muted">{r.priorHolders}</span>
          {" → "}
          <strong>{r.holderCount}</strong>
        </span>
      ) },
    // Gross flows that reconcile the crossing: now = prior − out + new. Shown
    // together so the count change never looks like it fails to add up.
    { key: "new", header: "Investors in / out", align: "right", width: "130px", value: (r) => r.newHolders,
      render: (r) => (
        <span className="mgr-moves">
          <span className="mgr-move buy">▲ {r.newHolders} new</span>
          {r.exitedHolders > 0 && <span className="mgr-move sell">▼ {r.exitedHolders} out</span>}
        </span>
      ) },
    overlapCols[3], // Held by
    overlapCols[4], // Combined Value
  ];

  const leaderCols: Column<ManagerRollup>[] = [
    { key: "name", header: "Investor", value: (m) => m.name,
      render: (m) => <strong style={{ color: "var(--accent)" }}>{m.name}</strong> },
    { key: "quarter", header: "Quarter (period covered)", width: "150px", value: (m) => m.period,
      render: (m) => (
        <span>
          <strong>{quarterLabel(m.period)}</strong>
          <span className="muted" style={{ display: "block", fontSize: "0.82em" }}>
            ended {periodEndLabel(m.period)}
          </span>
        </span>
      ) },
    { key: "filed", header: "Filed", width: "110px", value: (m) => m.filedAt ?? "",
      render: (m) => <span className="muted">{m.filedAt ? fmtDate(m.filedAt) : "—"}</span> },
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
  // When the move was disclosed to the SEC: the filing date of the 13F-HR that
  // reported this buy/sell, with the quarter-end it's "as of" beneath. Both come
  // straight from the filing (filed_at / period_of_report) — a 13F gives no
  // intra-quarter transaction date, so the filing date is the exact SEC-sourced
  // moment the position change became public.
  const disclosedCell: Column<ManagerPortfolio> = {
    key: "disclosed", header: "Disclosed (SEC)", align: "right", width: "140px",
    value: (h) => h.filed_at ?? "",
    render: (h) => (
      <span title="Date this 13F-HR was filed with the SEC (the as-of quarter-end is shown below)">
        <strong>{h.filed_at ? fmtDate(h.filed_at) : "—"}</strong>
        <span className="muted" style={{ display: "block", fontSize: "0.82em" }}>
          as of {periodEndLabel(h.period_of_report)}
        </span>
      </span>
    ),
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

  // Signed $ change in position value vs the prior quarter. value() returns the
  // *magnitude* so sorting surfaces the biggest moves (either direction) first,
  // while render() shows the signed +/− swing.
  const swingCell: Column<ManagerPortfolio> = {
    key: "swing", header: "Δ Value", align: "right", width: "130px",
    value: (h) => swingSize(h),
    render: (h) => {
      if (h.action === "new") return <span className="dt-num buy">+{fmtUSD(h.value)}</span>;
      if (h.action === "exited") return <span className="dt-num sell">−{fmtUSD(h.prior_value)}</span>;
      const d = (h.value ?? 0) - (h.prior_value ?? 0);
      if (!d) return <span className="dt-num muted">—</span>;
      const cls = d > 0 ? "buy" : "sell";
      return <span className={`dt-num ${cls}`}>{d > 0 ? "+" : "−"}{fmtUSD(Math.abs(d))}</span>;
    },
  };

  // Comparison table: the latest 13F against the prior one — what each tracked
  // position became (Move), the share delta, and its old vs new dollar value.
  const cmpCols: Column<ManagerPortfolio>[] = [
    holdingCell,
    { key: "issuer", header: "Company", value: (h) => h.issuer ?? "",
      render: (h) => <span className="muted">{h.issuer ?? "—"}</span> },
    moveCell,
    disclosedCell,
    changeCell,
    { key: "priorval", header: "Was", align: "right", value: (h) => h.prior_value ?? 0,
      render: (h) => <span className="dt-num muted">{fmtUSD(h.prior_value)}</span> },
    { key: "value", header: "Now", align: "right", value: (h) => h.value ?? 0,
      render: (h) => <span className="dt-num">{h.action === "exited" ? "—" : fmtUSD(h.value)}</span> },
    swingCell,
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">Institutional Investors</h1>
        <p className="empty-note">Loading institutional portfolios…</p>
      </div>
    );
  }

  if (managers.length === 0) {
    return (
      <div className="page-head">
        <h1 className="page-title">Institutional Investors</h1>
        <p className="empty-note">
          <strong>No institutional portfolios yet.</strong> Run <code>schema.sql</code> in
          Supabase to create the <code>manager_portfolios</code> table, then let the
          13F ingest populate it (weekly cadence, or <code>python main.py AAPL</code> to force it now).
        </p>
      </div>
    );
  }

  // ── Detail: latest 13F vs the prior one — what the manager changed ──────────
  if (active) {
    const buying = active.holdings
      .filter((h) => h.action && BUYS.has(h.action))
      .sort((a, b) => swingSize(b) - swingSize(a));
    const selling = [...active.holdings.filter((h) => h.action === "trimmed"), ...active.exits]
      .sort((a, b) => sellSize(b) - sellSize(a));
    // Every position that moved (new / added / trimmed / sold out), biggest first.
    const changes = [...buying, ...selling].sort((a, b) => swingSize(b) - swingSize(a));
    const newCount = changes.filter((h) => h.action === "new").length;

    // With only one quarter on file there's nothing to compare, so fall back to
    // the full holdings list; otherwise the comparison is the default.
    const effective = active.hasMoves ? moveFilter : "all";
    const view =
      effective === "buying" ? { rows: buying, cols: cmpCols, sort: "swing", empty: "No new or increased positions vs the prior quarter." }
      : effective === "selling" ? { rows: selling, cols: cmpCols, sort: "swing", empty: "No reduced or exited positions vs the prior quarter." }
      : effective === "all" ? { rows: active.holdings, cols: holdCols, sort: "value", empty: "No holdings." }
      : { rows: changes, cols: cmpCols, sort: "swing", empty: "No position changes vs the prior quarter." };

    return (
      <div>
        <div className="page-head-row">
          <button className="chip" onClick={() => { setSelected(null); setMoveFilter("changes"); }}>← All investors</button>
        </div>
        <div className="page-head">
          <h1 className="page-title">{active.name}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {active.hasMoves ? (
              <>
                Comparing <strong>{quarterLabel(active.period)}</strong> vs{" "}
                <strong>{active.priorPeriod ? quarterLabel(active.priorPeriod) : priorQuarterLabel(active.period)}</strong> ·
                {" "}<span className="buy">{newCount} new</span> · <span className="buy">{buying.length} bought</span> ·
                {" "}<span className="sell">{selling.length} sold</span> · {fmtUSD(active.aum)} total equity AUM
              </>
            ) : (
              <>13F as of {quarterLabel(active.period)} · {active.holdings.length} top positions · {fmtUSD(active.aum)} total equity AUM</>
            )}
          </p>
          <p className="muted" style={{ marginTop: 6, fontSize: "0.9em" }}>
            <strong>{quarterLabel(active.period)}</strong>: quarter ended {periodEndLabel(active.period)}
            {active.filedAt ? <>, filed {fmtDate(active.filedAt)}</> : null}
            {active.priorPeriod && (
              <>
                {"  ·  "}
                <strong>{quarterLabel(active.priorPeriod)}</strong>: quarter ended {periodEndLabel(active.priorPeriod)}
                {active.priorFiledAt ? <>, filed {fmtDate(active.priorFiledAt)}</> : null}
              </>
            )}
          </p>
          <div style={{ marginTop: 8 }}>
            <span className="label-caps" style={{ marginRight: 8 }}>Verify on</span>
            <FilingLink accession={active.accession} filedAt={active.filedAt} />
          </div>
        </div>

        {active.hasMoves ? (
          <div className="page-head-row" style={{ marginBottom: 14 }}>
            <button className={`chip${moveFilter === "changes" ? " active" : ""}`} onClick={() => setMoveFilter("changes")}>Δ All changes ({changes.length})</button>
            <button className={`chip${moveFilter === "buying" ? " active" : ""}`} onClick={() => setMoveFilter("buying")}>▲ Bought ({buying.length})</button>
            <button className={`chip${moveFilter === "selling" ? " active" : ""}`} onClick={() => setMoveFilter("selling")}>▼ Sold ({selling.length})</button>
            <button className={`chip${moveFilter === "all" ? " active" : ""}`} onClick={() => setMoveFilter("all")}>Current holdings</button>
          </div>
        ) : (
          <p className="empty-note" style={{ marginBottom: 14 }}>
            <strong>The latest-vs-prior comparison appears once two quarters are on file.</strong> This is the
            first 13F stored for this investor, so there&apos;s no prior quarter to compare against yet.
          </p>
        )}

        <div className="section-title">
          {effective === "buying" ? "Bought — new & increased positions"
            : effective === "selling" ? "Sold — reduced & exited positions"
            : effective === "all" ? "Current holdings"
            : "What changed vs the prior quarter"}
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
          Comparison is the investor&apos;s latest Form 13F-HR against its prior one (common-stock longs,
          options excluded). <strong>New</strong>/<strong>Sold out</strong> are positions added to or
          dropped from the top book; <strong>Added</strong>/<strong>Trimmed</strong> are size changes
          beyond a ±2% noise band. <strong>Disclosed (SEC)</strong> is the date that 13F-HR was filed
          with the SEC, with the quarter-end it reports beneath — a 13F gives no intra-quarter trade
          date, so the filing date is the exact moment the move became public. Filings lag up to 45
          days after quarter-end. Tickers in <strong>teal</strong> are on your watchlist — click to open them.
        </p>
      </div>
    );
  }

  // ── Leaderboard + Overlap (tabbed) ──────────────────────────────────────────
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Institutional Investors</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          {tab === "investors"
            ? <>The largest institutional investors and what they bought or sold last quarter (Form 13F-HR). Click an investor to compare its latest 13F against the prior one — new buys, added, trimmed, and sold-out positions.</>
            : <>Stocks held in common across the tracked institutions — the consensus / crowded names. Switch to <strong>✦ Emerging / hidden</strong> for the under-the-radar names that just crossed into consensus (not the giants everyone owns), or pick two or more investors below to see only what they <em>all</em> hold.</>}
        </p>
      </div>

      <div className="page-head-row" style={{ marginBottom: 14 }}>
        <button className={`chip${tab === "investors" ? " active" : ""}`} onClick={() => setTab("investors")}>Investors</button>
        <button className={`chip${tab === "overlap" ? " active" : ""}`} onClick={() => setTab("overlap")}>⧉ Overlap / Consensus</button>
      </div>

      {tab === "investors" ? (
        <DataTable
          columns={leaderCols}
          rows={managers}
          rowKey={(m) => m.managerCik}
          onRowClick={(m) => setSelected(m.managerCik)}
          initialSort={{ key: "aum", dir: "desc" }}
          filterable
          filterPlaceholder="Filter investors…"
        />
      ) : (
        <div>
          {/* Investor picker — select 2+ to intersect, else rank by how many hold each stock */}
          <div style={{ marginBottom: 10 }}>
            <div className="label-caps" style={{ marginBottom: 6 }}>
              Compare specific investors {comparing ? `(${compareSet.size} selected — showing their common holdings)` : "(pick 2+)"}
              {compareSet.size > 0 && (
                <button className="chip" style={{ marginLeft: 8 }} onClick={() => setCompareSet(new Set())}>Clear</button>
              )}
            </div>
            <div className="mgr-compare-chips">
              {managers.map((m) => (
                <button
                  key={m.managerCik}
                  className={`chip${compareSet.has(m.managerCik) ? " active" : ""}`}
                  onClick={() => toggleCompare(m.managerCik)}
                >
                  {compareSet.has(m.managerCik) ? "✓ " : ""}{m.name}
                </button>
              ))}
            </div>
          </div>

          {!comparing && (
            <div className="page-head-row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <span className="label-caps" style={{ marginRight: 6 }}>Held by at least</span>
              {[2, 3, 5, 10].map((n) => (
                <button key={n} className={`chip${minHolders === n ? " active" : ""}`} onClick={() => setMinHolders(n)}>{n}+</button>
              ))}
              <span style={{ flex: "0 0 14px" }} />
              <button className={`chip${overlapMode === "all" ? " active" : ""}`} onClick={() => setOverlapMode("all")}>All consensus</button>
              <button className={`chip${overlapMode === "emerging" ? " active" : ""}`} onClick={() => setOverlapMode("emerging")}>✦ Emerging / hidden</button>
            </div>
          )}

          {overlapMode === "emerging" && !comparing && !consensus.hasPrior && (
            <p className="empty-note" style={{ marginBottom: 12 }}>
              <strong>The emerging lens needs two 13F quarters on file</strong> to tell a name that
              <em> just</em> crossed into consensus from one that was always there. Only one quarter is
              stored so far — seed the prior quarter with <code>python -m tools.backfill_manager_quarters</code>,
              or wait for the next 13F deadline. Showing all consensus names meanwhile.
            </p>
          )}

          <div className="section-title">
            {comparing
              ? `Held by all ${compareSet.size} selected investors`
              : emerging
                ? `Newly crossed ${minHolders}+ this quarter (excludes names held by >${ubiquityCutoff} of ${managers.length} institutions)`
                : `Held by ${minHolders}+ tracked institutions`}
          </div>
          <DataTable
            columns={emerging ? emergingCols : overlapCols}
            rows={overlapRows}
            rowKey={(r) => r.cusip}
            initialSort={{ key: emerging ? "latest" : comparing ? "value" : "count", dir: "desc" }}
            filterable
            filterPlaceholder="Filter stocks…"
            empty={
              comparing ? "No stock is held by all of the selected investors."
              : emerging ? "No off-radar name newly crossed that threshold this quarter. Lower the threshold or wait for the next 13F quarter."
              : "No stock is held by that many tracked institutions yet."
            }
          />
          <p className="empty-note" style={{ marginTop: 14 }}>
            {emerging ? (
              <>
                <strong>Emerging consensus</strong> surfaces the under-the-radar names that <em>just</em> crossed
                into consensus: held by {minHolders}+ tracked institutions <em>now</em>, but by fewer than that
                last quarter (fresh buying pushed them over), and <em>not</em> the index giants everyone already
                owns (excluded once held by &gt;{ubiquityCutoff} of {managers.length} institutions).
                Sorted by <strong>Latest bought</strong> — the most recent date a fresh buyer disclosed
                opening it — so the newest crowded names sit on top. The holder count reconciles as
                {" "}<strong>now = last quarter − out + new</strong> (some prior holders sell out, so the
                count change isn&apos;t just new buyers); <strong>▲ new</strong> opened it this quarter and
                {" "}<strong>▼ out</strong> sold out of their top book.
              </>
            ) : (
              <>
                Overlap is computed from each institution&apos;s latest-quarter top holdings (common-stock
                longs). <strong># Investors</strong> is how many of the tracked institutions hold the name;
                <strong> This quarter</strong> shows how many added vs trimmed it.
              </>
            )}
            {" "}Tickers in <strong>teal</strong> are on your watchlist — click to open them.
          </p>
        </div>
      )}
    </div>
  );
}
