"use client";
// CongressPeek — the hover card for a Congress-tracker row: who bought the stock
// (name, party, chamber, state), how much (the disclosed range of their latest
// trade, plus their est. total when they traded more than once), when, and who
// sold the same name in the window. Rendered into document.body (portal);
// positioned by the caller. Pure presentational.
import { createPortal } from "react-dom";

import { Icon } from "./Icon";
import type { CongressMember, MostBought } from "../lib/domain/congress";
import { fmtUSD, fmtDate, elapsed } from "../lib/utils/format";

const PARTY_LABEL: Record<string, string> = { D: "Dem", R: "Rep", I: "Ind" };
const chamberLabel = (c: string | null) => (c === "senate" ? "Senate" : c === "house" ? "House" : null);

function MemberRow({ m }: { m: CongressMember }) {
  const meta = [PARTY_LABEL[m.party ?? ""] ?? null, chamberLabel(m.chamber), m.state].filter(Boolean).join(" · ");
  return (
    <div className="cgp-member">
      <span className={`cgp-party p-${m.party ?? "x"}`} aria-hidden />
      <span className="cgp-who">
        <span className="cgp-name">{m.name}</span>
        <span className="cgp-meta">{meta}{m.owner && m.owner !== "Self" ? ` · ${m.owner}` : ""}</span>
      </span>
      <span className="cgp-amt" title={m.trades > 1 ? `${m.trades} trades · ~${fmtUSD(m.est)} est. total` : "Disclosed range of the trade"}>
        {m.lastAmount ?? (m.est ? `~${fmtUSD(m.est)}` : "—")}
        {m.trades > 1 && <span className="cgp-n">×{m.trades}</span>}
      </span>
      <span className="cgp-when" title={fmtDate(m.lastDate, { utc: true })}>{elapsed(m.lastDate) || fmtDate(m.lastDate, { utc: true })}</span>
    </div>
  );
}

export function CongressPeek({
  row, windowDays, side = "buy", top, left, onMouseEnter, onMouseLeave, onDrill, onTrack, onOpen, cik,
}: {
  row: MostBought;
  windowDays: number;
  /** Which side to lead with (the sells consensus table leads with sellers). */
  side?: "buy" | "sell";
  top: number; left: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onDrill?: (ticker: string) => void;
  onTrack?: (ticker: string) => void;
  onOpen?: (cik: string) => void;
  /** Set when the ticker is on the watchlist. */
  cik?: string;
}) {
  if (typeof document === "undefined") return null;
  const delta = row.buyers - row.prevBuyers;
  const MAX = 5;
  const buyers = row.members.slice(0, MAX);
  const sellers = row.sellerMembers.slice(0, MAX);
  const section = (label: string, tone: "pos" | "neg", people: CongressMember[], total: number) => (
    <div className="cgp-section">
      <div className={`cgp-head ${tone}`}>
        {tone === "pos" ? "▲" : "▼"} {label} <span className="cgp-count">{total}</span>
      </div>
      {people.map((m) => <MemberRow key={m.key} m={m} />)}
      {total > people.length && <div className="cgp-more">+{total - people.length} more</div>}
    </div>
  );

  return createPortal(
    <div className="peek cgp" style={{ top, left }} role="dialog" aria-label={`${row.ticker} — who is buying`}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="cgp-title">
        <span className="cgp-tkr">{row.ticker}</span>
        <span className="cgp-company">{row.name ?? ""}</span>
      </div>
      <div className="cgp-stats">
        <span><strong>{row.buyers}</strong> buyer{row.buyers === 1 ? "" : "s"} · {windowDays}d</span>
        {row.prevBuyers > 0 || delta !== 0 ? (
          <span className={delta > 0 ? "pos" : delta < 0 ? "neg" : "muted"} title={`${row.prevBuyers} in the previous ${windowDays} days`}>
            {delta > 0 ? "+" : ""}{delta} vs prior
          </span>
        ) : null}
        <span className="muted" title="Sum of disclosed-range midpoints — an estimate">~{fmtUSD(row.estTotal)} est.</span>
        <span className="cgp-split"><span className="cg-d">{row.dem}D</span> <span className="cg-r">{row.rep}R</span></span>
      </div>

      {side === "sell" && row.sellers > 0 && section("Selling", "neg", sellers, row.sellers)}
      {section("Buying", "pos", buyers, row.buyers)}
      {side === "buy" && row.sellers > 0 && section("Also selling", "neg", sellers, row.sellers)}

      {(onDrill || onTrack || (cik && onOpen)) && (
        <div className="peek-links">
          {onDrill && <button className="peek-link" onClick={() => onDrill(row.ticker)}><Icon name="filings" size={12} /> All trades</button>}
          {cik && onOpen
            ? <button className="peek-link" onClick={() => onOpen(cik)}><Icon name="arrow-up-right" size={12} /> Open company</button>
            : onTrack && <button className="peek-link" onClick={() => onTrack(row.ticker)}><Icon name="plus" size={12} strokeWidth={2.25} /> Track</button>}
        </div>
      )}
      <div className="peek-hint">Disclosures lag trades by up to 45 days · amounts are disclosed ranges</div>
    </div>,
    document.body,
  );
}
