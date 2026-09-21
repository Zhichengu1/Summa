"use client";
// CongressBuysList — the "most bought by Congress" leaderboard rows: ticker,
// company, a bar of distinct buyers (with the previous window as a ghost bar),
// party split, est. dollars, last buy, and a Track / Open action. Pure
// presentational; the aggregation is lib/domain/congress.ts.
import { Icon } from "./Icon";
import type { MostBought } from "../lib/domain/congress";
import { fmtUSD, fmtDate, elapsed } from "../lib/utils/format";

export function CongressBuysList({
  rows, watchedCiks, onOpen, onTrack, onDrill, primary = "open", onRowEnter, onRowLeave, compact = false,
}: {
  rows: MostBought[];
  /** ticker → cik for names already on the watchlist. */
  watchedCiks: Map<string, string>;
  onOpen: (cik: string) => void;
  /** Add the ticker to the watchlist (resolved to a CIK by the caller). */
  onTrack?: (ticker: string) => void;
  /** Drill into the ticker's trades (Congress page). */
  onDrill?: (ticker: string) => void;
  /** Row click: "open" = watched names open their page, others drill; "drill" = always drill. */
  primary?: "open" | "drill";
  /** Hover / focus intent — the caller opens a CongressPeek beside the row. */
  onRowEnter?: (row: MostBought, el: HTMLElement, immediate: boolean, at?: { x: number; y: number }) => void;
  onRowLeave?: () => void;
  compact?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.buyers, r.prevBuyers)));
  return (
    <div className={`cg-list${compact ? " compact" : ""}`} role="list">
      {rows.map((r, i) => {
        const cik = watchedCiks.get(r.ticker);
        const delta = r.buyers - r.prevBuyers;
        const act = () => {
          if (primary === "drill" && onDrill) return onDrill(r.ticker);
          if (cik) return onOpen(cik);
          if (onDrill) return onDrill(r.ticker);
        };
        return (
          <div
            key={r.ticker} role="listitem" className="cg-row" tabIndex={0}
            onClick={act}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } }}
            onMouseEnter={onRowEnter ? (e) => onRowEnter(r, e.currentTarget, false, compact ? undefined : { x: e.clientX, y: e.clientY }) : undefined}
            onMouseLeave={onRowLeave}
            onFocus={onRowEnter ? (e) => { if (e.target === e.currentTarget) onRowEnter(r, e.currentTarget, true); } : undefined}
            onBlur={onRowLeave ? (e) => { if (e.target === e.currentTarget) onRowLeave(); } : undefined}
          >
            <span className="cg-rank">{i + 1}</span>
            <span className="cg-id">
              <span className="cg-tkr">
                {r.ticker}
                {cik && <span className="row-flag flag-watch" title="On your watchlist"><Icon name="star" size={10} /></span>}
              </span>
              {!compact && <span className="cg-name">{r.name ?? ""}</span>}
            </span>
            <span className="cg-bar" aria-hidden>
              <span className="cg-bar-prev" style={{ width: `${(r.prevBuyers / max) * 100}%` }} />
              <span className="cg-bar-now" style={{ width: `${(r.buyers / max) * 100}%` }} />
            </span>
            <span className="cg-buyers" title={`${r.buyers} distinct member${r.buyers === 1 ? "" : "s"} bought · ${r.trades} trade${r.trades === 1 ? "" : "s"}${r.prevBuyers ? ` · ${r.prevBuyers} in the previous window` : ""}`}>
              <strong>{r.buyers}</strong>
              {delta !== 0 && <span className={`cg-delta ${delta > 0 ? "pos" : "neg"}`}>{delta > 0 ? "+" : ""}{delta}</span>}
              {r.sellers > 0 && <span className="cg-contested" title={`${r.sellers} member${r.sellers === 1 ? "" : "s"} sold in the same window`}><Icon name="congress" size={11} /></span>}
            </span>
            {!compact && (
              <span className="cg-party" title={`${r.dem} Democrat · ${r.rep} Republican buyers`}>
                <span className="cg-d">{r.dem}D</span> <span className="cg-r">{r.rep}R</span>
              </span>
            )}
            <span className="cg-est" title="Sum of disclosed-range midpoints — an estimate">~{fmtUSD(r.estTotal)}</span>
            <span className="cg-last" title={fmtDate(r.lastDate, { utc: true })}>{elapsed(r.lastDate) || fmtDate(r.lastDate, { utc: true })}</span>
            {onTrack && (
              cik
                ? <button className={`cg-act is-tracked${compact ? " icon-only" : ""}`} onClick={(e) => { e.stopPropagation(); onOpen(cik); }} title="On your watchlist — open" aria-label={`Open ${r.ticker}`}>
                    {compact ? <Icon name="arrow-up-right" size={12} /> : "Open"}
                  </button>
                : <button className={`cg-act${compact ? " icon-only" : ""}`} onClick={(e) => { e.stopPropagation(); onTrack(r.ticker); }} title="Track — add to your watchlist" aria-label={`Track ${r.ticker}`}>
                    <Icon name="plus" size={11} strokeWidth={2.25} />{!compact && " Track"}
                  </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
