// Pure transforms over daily_prices rows: headline return KPIs + a chart series.
// Prices are end-of-day. Input is expected ascending by date (as data.ts returns).
import type { DailyPrice } from "../types";

export type PriceKpis = {
  last: number | null;          // latest close
  asOf: string | null;          // date of latest close
  ret1M: number | null;         // % return vs ~1 month ago
  ret3M: number | null;         // % return vs ~3 months ago
  retYTD: number | null;        // % return vs first close of the year
  high52: number | null;        // trailing 52-week high close
  low52: number | null;         // trailing 52-week low close
  pctOffHigh: number | null;    // % below the 52-week high (≤0; 0 = at the high)
};

export type PricePoint = { x: string; Close: number };

const DAY = 86_400_000;

/** Close on or before `target` ms, scanning back from the end. Null if none. */
function closeAsOf(prices: DailyPrice[], target: number): number | null {
  for (let i = prices.length - 1; i >= 0; i--) {
    const c = prices[i].close;
    if (c == null) continue;
    if (new Date(prices[i].date).getTime() <= target) return c;
  }
  return null;
}

function pctChange(now: number | null, then: number | null): number | null {
  if (now == null || then == null || then === 0) return null;
  return ((now - then) / Math.abs(then)) * 100;
}

/** Headline price KPIs from a daily series (ascending by date). */
export function derivePriceKpis(prices: DailyPrice[]): PriceKpis {
  const withClose = prices.filter((p) => p.close != null);
  if (withClose.length === 0) {
    return { last: null, asOf: null, ret1M: null, ret3M: null, retYTD: null, high52: null, low52: null, pctOffHigh: null };
  }
  const lastRow = withClose[withClose.length - 1];
  const last = lastRow.close as number;
  const now = new Date(lastRow.date).getTime();

  // Trailing 52 weeks for the high/low band.
  const yearAgo = now - 365 * DAY;
  let high52 = -Infinity, low52 = Infinity;
  for (const p of withClose) {
    if (new Date(p.date).getTime() < yearAgo) continue;
    const c = p.close as number;
    if (c > high52) high52 = c;
    if (c < low52) low52 = c;
  }
  if (!Number.isFinite(high52)) high52 = last;
  if (!Number.isFinite(low52)) low52 = last;

  // Year-to-date baseline = first close of the latest row's calendar year.
  const yearStart = new Date(Date.UTC(new Date(lastRow.date).getUTCFullYear(), 0, 1)).getTime();
  const ytdBase = withClose.find((p) => new Date(p.date).getTime() >= yearStart)?.close ?? null;

  return {
    last,
    asOf: lastRow.date,
    ret1M: pctChange(last, closeAsOf(withClose, now - 30 * DAY)),
    ret3M: pctChange(last, closeAsOf(withClose, now - 91 * DAY)),
    retYTD: pctChange(last, ytdBase),
    high52,
    low52,
    pctOffHigh: high52 > 0 ? ((last - high52) / high52) * 100 : null,
  };
}

/** Chart-ready close series (ascending). */
export function priceSeries(prices: DailyPrice[]): PricePoint[] {
  return prices
    .filter((p) => p.close != null)
    .map((p) => ({ x: p.date, Close: p.close as number }));
}

export type Reaction = { d1: number | null; d5: number | null };

/**
 * How the stock reacted around an event date: % return from the close on/before
 * the event to the close +1 and +5 trading days later. Null when the series
 * doesn't span the window. `prices` must be ascending by date.
 */
export function reactionAround(prices: DailyPrice[], isoDate: string | null | undefined): Reaction {
  const none: Reaction = { d1: null, d5: null };
  if (!isoDate) return none;
  const rows = prices.filter((p) => p.close != null);
  if (rows.length < 2) return none;
  const t = new Date(isoDate.slice(0, 10)).getTime();
  if (Number.isNaN(t)) return none;

  // Base = last bar on or before the event date.
  let base = -1;
  for (let i = 0; i < rows.length; i++) {
    if (new Date(rows[i].date).getTime() <= t) base = i; else break;
  }
  if (base < 0) return none;
  const b = rows[base].close as number;
  const ret = (idx: number): number | null => {
    if (idx >= rows.length || b === 0) return null;
    return (((rows[idx].close as number) - b) / b) * 100;
  };
  return { d1: ret(base + 1), d5: ret(base + 5) };
}

export type ReactionStats = {
  n: number;                 // events with a measurable 1-day reaction
  avgAbs1d: number | null;   // average ABSOLUTE 1-day move — the "expected move" size
  avg1d: number | null;      // average SIGNED 1-day move — directional drift
  pctUp1d: number | null;    // share of events that closed up the next day
  avgAbs5d: number | null;   // average absolute 5-day move
};

/**
 * Aggregate how a stock has historically reacted to a set of event dates — the
 * expected-move read a trader wants before a catalyst. `avgAbs1d` is the typical
 * 1-day swing magnitude (up OR down); `pctUp1d` shows the directional skew.
 * `prices` must be ascending by date.
 */
export function reactionStats(
  prices: DailyPrice[], dates: (string | null | undefined)[],
): ReactionStats {
  const r1: number[] = [], r5: number[] = [];
  for (const d of dates) {
    const r = reactionAround(prices, d);
    if (r.d1 != null) r1.push(r.d1);
    if (r.d5 != null) r5.push(r.d5);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const avgAbs = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length : null);
  return {
    n: r1.length,
    avgAbs1d: avgAbs(r1),
    avg1d: avg(r1),
    pctUp1d: r1.length ? (r1.filter((v) => v > 0).length / r1.length) * 100 : null,
    avgAbs5d: avgAbs(r5),
  };
}
