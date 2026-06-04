// Valuation metrics — turns raw fundamentals + price into the "is it cheap/expensive"
// lens. Pure compute over financial_facts (via fundamentals.ts) and daily_prices.
//
// Caveat: `sharesOut` uses weighted-average DILUTED shares (the only share count
// reliably in the XBRL income statement), a close proxy for shares outstanding —
// good enough for an order-of-magnitude market cap / P/E, not a precise float.
import { seriesFor, METRICS } from "./fundamentals";
import { derivePriceKpis } from "./prices";
import type { FinancialFact, DailyPrice } from "./types";

export type Valuation = {
  lastClose: number | null;
  sharesOut: number | null;
  epsTTM: number | null;       // trailing-twelve-month diluted EPS
  revenueTTM: number | null;
  marketCap: number | null;
  peTTM: number | null;        // price / TTM EPS (null when EPS ≤ 0)
  psTTM: number | null;        // market cap / TTM revenue
};

const EMPTY: Valuation = {
  lastClose: null, sharesOut: null, epsTTM: null, revenueTTM: null,
  marketCap: null, peTTM: null, psTTM: null,
};

/** Sum the trailing `n` quarterly values of a metric (most-recent last). */
function ttm(facts: FinancialFact[], match: (f: FinancialFact) => boolean, n = 4): number | null {
  const s = seriesFor(facts, "income", "quarterly", match);
  if (s.length < n) return null;
  return s.slice(-n).reduce((sum, p) => sum + p.value, 0);
}

/** Latest value of a metric in either period type (most-recent wins). */
function latest(facts: FinancialFact[], match: (f: FinancialFact) => boolean): number | null {
  const q = seriesFor(facts, "income", "quarterly", match);
  const a = seriesFor(facts, "income", "annual", match);
  const pick = q.length ? q : a;
  return pick.length ? pick[pick.length - 1].value : null;
}

/** Derive valuation from fundamentals + the EOD price series. */
export function deriveValuation(facts: FinancialFact[], prices: DailyPrice[]): Valuation {
  if (!facts.length) return EMPTY;
  const lastClose = derivePriceKpis(prices).last;
  const sharesOut = latest(facts, METRICS.sharesOutstanding);
  const epsTTM = ttm(facts, METRICS.epsDiluted);
  const revenueTTM = ttm(facts, METRICS.revenue);

  const marketCap = lastClose != null && sharesOut != null ? lastClose * sharesOut : null;
  const peTTM = lastClose != null && epsTTM != null && epsTTM > 0 ? lastClose / epsTTM : null;
  const psTTM = marketCap != null && revenueTTM != null && revenueTTM > 0 ? marketCap / revenueTTM : null;

  return { lastClose, sharesOut, epsTTM, revenueTTM, marketCap, peTTM, psTTM };
}
