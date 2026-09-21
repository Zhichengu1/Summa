// Congress tracker — pure aggregation over `congress_trades` rows.
//
//   mostBought(trades, windowDays, top) → the stocks the most distinct members of
//   Congress bought inside the window, ranked by buyer count (then dollars, then
//   recency), each with the same measure over the *previous* equal window so a
//   name that is newly crowded reads differently from one that has been popular
//   for months. Every row carries its buyers and sellers as people (party, chamber,
//   state, their trades, est. dollars, latest trade) so a hover card can answer
//   "who exactly?". Amounts are disclosed as ranges, so dollars are range midpoints
//   and always labelled as estimates. Shared by the dashboard panel and the
//   Congress page so both agree.
import type { CongressTrade } from "../types";

export type CongressMember = {
  key: string;
  name: string;
  party: string | null;
  chamber: string | null;     // 'house' | 'senate'
  state: string | null;
  trades: number;             // this member's transactions on this side in the window
  est: number;                // sum of range midpoints
  lastDate: string;           // latest transaction (ISO date)
  lastAmount: string | null;  // disclosed range label of the latest transaction
  owner: string | null;       // Self / Spouse / Joint … of the latest transaction
};

export type MostBought = {
  ticker: string;
  name: string | null;
  buyers: number;          // distinct members who bought in the window
  trades: number;          // individual buy transactions
  estTotal: number;        // sum of range midpoints (estimate)
  lastDate: string;        // most recent buy (ISO date)
  prevBuyers: number;      // distinct buyers in the previous equal window
  sellers: number;         // distinct members selling in the same window (contested?)
  members: CongressMember[];        // buyers, most recent first
  sellerMembers: CongressMember[];  // sellers, most recent first
  dem: number; rep: number;   // buyer party split
};

/** Midpoint of the disclosed amount range — the honest single-number estimate. */
export function estAmount(t: CongressTrade): number {
  if (t.amount_low != null && t.amount_high != null) return (t.amount_low + t.amount_high) / 2;
  return t.amount_low ?? 0;
}

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function addMember(map: Map<string, CongressMember>, t: CongressTrade): void {
  const key = t.filer_id ?? t.filer_name ?? "?";
  let m = map.get(key);
  if (!m) {
    m = { key, name: t.filer_name ?? "Unknown", party: t.party, chamber: t.chamber, state: t.state, trades: 0, est: 0, lastDate: "", lastAmount: null, owner: null };
    map.set(key, m);
  }
  m.trades += 1;
  m.est += estAmount(t);
  if (t.transaction_date >= m.lastDate) { m.lastDate = t.transaction_date; m.lastAmount = t.amount_label; m.owner = t.owner; }
}

const byRecency = (a: CongressMember, b: CongressMember) => b.lastDate.localeCompare(a.lastDate) || b.est - a.est;

export function mostBought(trades: CongressTrade[], windowDays = 90, top = 10): MostBought[] {
  const cutoff = isoDaysAgo(windowDays);
  const prevCutoff = isoDaysAgo(windowDays * 2);

  type Agg = {
    ticker: string; name: string | null; lastDate: string;
    buyers: Map<string, CongressMember>; sellers: Map<string, CongressMember>; prev: Set<string>;
    trades: number; est: number;
  };
  const by = new Map<string, Agg>();
  const slot = (t: CongressTrade): Agg => {
    let a = by.get(t.ticker);
    if (!a) {
      a = { ticker: t.ticker, name: null, lastDate: "", buyers: new Map(), sellers: new Map(), prev: new Set(), trades: 0, est: 0 };
      by.set(t.ticker, a);
    }
    if (t.asset_name && !a.name) a.name = t.asset_name.replace(/ - Common Stock$/i, "");
    return a;
  };

  for (const t of trades) {
    if (t.side === "exchange") continue;
    if (t.transaction_date >= cutoff) {
      const a = slot(t);
      if (t.side === "buy") {
        addMember(a.buyers, t);
        a.trades += 1;
        a.est += estAmount(t);
        if (t.transaction_date > a.lastDate) a.lastDate = t.transaction_date;
      } else {
        addMember(a.sellers, t);
      }
    } else if (t.transaction_date >= prevCutoff && t.side === "buy") {
      slot(t).prev.add(t.filer_id ?? t.filer_name ?? "?");
    }
  }

  return Array.from(by.values())
    .filter((a) => a.buyers.size > 0)
    .map((a) => {
      const members = Array.from(a.buyers.values()).sort(byRecency);
      return {
        ticker: a.ticker, name: a.name,
        buyers: a.buyers.size, trades: a.trades, estTotal: a.est, lastDate: a.lastDate,
        prevBuyers: a.prev.size, sellers: a.sellers.size,
        members, sellerMembers: Array.from(a.sellers.values()).sort(byRecency),
        dem: members.filter((m) => m.party === "D").length,
        rep: members.filter((m) => m.party === "R").length,
      };
    })
    .sort((x, y) => y.buyers - x.buyers || y.estTotal - x.estTotal || y.lastDate.localeCompare(x.lastDate))
    .slice(0, top);
}
