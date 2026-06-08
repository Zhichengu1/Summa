// Technical indicators over the EOD price series — the price-action layer traders
// watch alongside the fundamentals. Pure compute over daily_prices (ascending).
import type { DailyPrice } from "../types";

export type Technicals = {
  sma50: number | null;
  sma200: number | null;
  cross: "golden" | "death" | null;  // 50d crossing 200d in the last few sessions
  pctFrom50: number | null;          // % of last close above/below the 50d SMA
  pctFrom200: number | null;
  rsi14: number | null;              // 14-day Wilder RSI
  volSpike: number | null;          // latest volume ÷ 30-day avg volume (×)
  new52wHigh: boolean;               // latest close is the trailing-52w high
  new52wLow: boolean;
  asOf: string | null;
};

const EMPTY: Technicals = {
  sma50: null, sma200: null, cross: null, pctFrom50: null, pctFrom200: null,
  rsi14: null, volSpike: null, new52wHigh: false, new52wLow: false, asOf: null,
};

const sma = (xs: number[], n: number): number | null =>
  xs.length < n ? null : xs.slice(-n).reduce((s, v) => s + v, 0) / n;

/** SMA of the window ending at index `end` (inclusive). */
const smaAt = (xs: number[], n: number, end: number): number | null =>
  end + 1 < n ? null : xs.slice(end + 1 - n, end + 1).reduce((s, v) => s + v, 0) / n;

/** 14-day Wilder RSI on closes. */
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  const avgGain = gain / period, avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Detect a 50/200 SMA crossover within the last `lookback` sessions. */
function detectCross(closes: number[], lookback = 5): "golden" | "death" | null {
  const n = closes.length;
  if (n < 200 + 1) return null;
  for (let k = 0; k < lookback; k++) {
    const cur = n - 1 - k, prev = cur - 1;
    const f1 = smaAt(closes, 50, cur), s1 = smaAt(closes, 200, cur);
    const f0 = smaAt(closes, 50, prev), s0 = smaAt(closes, 200, prev);
    if (f1 == null || s1 == null || f0 == null || s0 == null) continue;
    if (f0 <= s0 && f1 > s1) return "golden";
    if (f0 >= s0 && f1 < s1) return "death";
  }
  return null;
}

export type PriceSmaPoint = { x: string; Close: number; SMA50: number | null; SMA200: number | null };

/** Chart series of close + trailing 50/200-day SMAs (ascending). */
export function smaSeries(prices: DailyPrice[]): PriceSmaPoint[] {
  const rows = prices.filter((p) => p.close != null);
  const closes = rows.map((p) => p.close as number);
  return rows.map((p, i) => ({
    x: p.date,
    Close: p.close as number,
    SMA50: smaAt(closes, 50, i),
    SMA200: smaAt(closes, 200, i),
  }));
}

/** Compute the technical snapshot from a daily series (ascending by date). */
export function deriveTechnicals(prices: DailyPrice[]): Technicals {
  const rows = prices.filter((p) => p.close != null);
  if (rows.length < 2) return EMPTY;
  const closes = rows.map((p) => p.close as number);
  const vols = rows.map((p) => p.volume ?? 0);
  const last = closes[closes.length - 1];
  const asOf = rows[rows.length - 1].date;

  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);

  // 52-week extremes from the trailing 252 sessions.
  const yr = closes.slice(-252);
  const hi = Math.max(...yr), lo = Math.min(...yr);

  const avgVol30 = vols.length >= 30 ? vols.slice(-30).reduce((s, v) => s + v, 0) / 30 : null;
  const lastVol = vols[vols.length - 1];

  return {
    sma50: s50,
    sma200: s200,
    cross: detectCross(closes),
    pctFrom50: s50 ? ((last - s50) / s50) * 100 : null,
    pctFrom200: s200 ? ((last - s200) / s200) * 100 : null,
    rsi14: rsi(closes),
    volSpike: avgVol30 && avgVol30 > 0 ? lastVol / avgVol30 : null,
    new52wHigh: last >= hi,
    new52wLow: last <= lo,
    asOf,
  };
}
