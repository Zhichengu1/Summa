// Options decision logic — pure functions over `options_snapshots` rows
// (fetchOptionsSnapshots), optionally enriched with the price technicals in
// `company_summary` and an estimated earnings date.
//
// The question this answers is "calls or puts, and in what structure" — which is
// really two independent questions that retail traders routinely collapse into one:
//
//   1. DIRECTION — where is money actually going? Options flow (put/call by
//      dollars of premium, not contract counts) plus the price trend. That gives
//      a bias score in [-100, +100].
//   2. PRICING — are options cheap or expensive right now? IV rank (percentile of
//      today's implied vol in its own trailing year) with IV-vs-realized-vol as
//      the fallback until the table has accumulated enough history. Direction
//      says calls vs puts; pricing says BUY premium vs SELL/SPREAD it.
//
// Being right on direction and wrong on pricing still loses money — buying calls
// into elevated implied vol before earnings is the classic version — so the
// structure recommendation is a function of both, and the warnings call out the
// specific ways a correct directional call can still lose.
//
// Nothing here is advice; it is a summary of what the chain is pricing.
import type { CompanySummary, OptionCandidateRow, OptionsSnapshot, UnusualContract } from "../types";

export type VolRegime = "cheap" | "fair" | "rich";
export type VolBasis = "iv-rank" | "iv-vs-rv" | "none";
export type BiasKind = "bullish" | "lean-bullish" | "neutral" | "lean-bearish" | "bearish";
export type StructureKey =
  | "long-calls" | "call-spread" | "long-puts" | "put-spread"
  | "sell-premium" | "straddle" | "stand-aside";

export type OptionsIdea = {
  cik: string;
  ticker: string;
  date: string;                  // snapshot date (ISO)
  spot: number | null;
  changePct: number | null;

  // Direction
  flowScore: number | null;      // −100 (put-heavy) … +100 (call-heavy)
  trendScore: number | null;     // −100 (downtrend) … +100 (uptrend)
  biasScore: number;             // blended
  bias: BiasKind;

  // Pricing
  volRegime: VolRegime;
  volBasis: VolBasis;            // which input decided the regime (null-honest)
  ivRank: number | null;
  ivRankObs: number | null;
  iv30: number | null;
  rv30: number | null;
  ivRvRatio: number | null;
  ivDelta: number | null;        // day-over-day change in IV30 (vol points)

  // Flow detail
  pcPremium: number | null;
  pcVolume: number | null;
  pcOi: number | null;
  callPremium: number | null;
  putPremium: number | null;
  callShare: number | null;      // calls as % of premium traded
  totalVolume: number | null;

  // What's priced in
  skew25d: number | null;
  frontDte: number | null;
  expectedMovePct: number | null;
  nearDte: number | null;
  nearMovePct: number | null;
  nearExpiry: string | null;
  maxPainPct: number | null;
  vix: number | null;
  vixChange: number | null;

  daysToEarnings: number | null;
  unusual: UnusualContract[];
  unusualCallPremium: number;
  unusualPutPremium: number;
  candidates: OptionCandidateRow[];   // tradeable ladder — priced by buildTradeCandidates

  structure: { key: StructureKey; label: string; detail: string };
  warnings: string[];
  read: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Equity index options carry a persistent put bid (hedging demand), so a raw
// put/call ratio of 1.0 is NOT neutral — the long-run equity norm sits nearer
// 0.7. Scores are measured as doublings away from that, not from 1.
const NEUTRAL_PCR = 0.7;

// A put/call ratio → directional score. One doubling below the neutral ratio
// (more call premium) is +50; one doubling above is −50.
function pcrScore(ratio: number | null | undefined): number | null {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return null;
  return clamp(-(Math.log(ratio / NEUTRAL_PCR) / Math.LN2) * 50, -100, 100);
}

function unusualSplit(rows: UnusualContract[]): { call: number; put: number } {
  let call = 0, put = 0;
  for (const r of rows) {
    if (r.right === "C") call += r.premium || 0;
    else put += r.premium || 0;
  }
  return { call, put };
}

// Direction from money, not contract counts: premium ($) dominates, contract
// volume is a lighter confirmation, and today's unusual (volume ≫ open interest)
// prints tilt it — those are positions opened today rather than passed between
// existing holders.
function flowScore(s: OptionsSnapshot, unusual: UnusualContract[]): number | null {
  const traded = (s.call_volume ?? 0) + (s.put_volume ?? 0);
  if (traded <= 0) return null;   // no session yet (holiday/pre-open) — say nothing

  const prem = pcrScore(s.pc_premium_ratio);
  const vol = pcrScore(s.pc_volume_ratio);
  let score: number;
  if (prem != null && vol != null) score = prem * 0.65 + vol * 0.35;
  else if (prem != null) score = prem;
  else if (vol != null) score = vol;
  else return null;

  const { call, put } = unusualSplit(unusual);
  if (call + put > 0) score += ((call - put) / (call + put)) * 25;
  return clamp(score, -100, 100);
}

// Price trend from the precomputed technicals. Options flow is a crowd opinion;
// the trend is what the stock is actually doing — disagreement between them is
// itself information, so they stay separate scores and are only blended at the end.
function trendScore(sum: CompanySummary | undefined): number | null {
  if (!sum) return null;
  let score = 0, inputs = 0;
  if (sum.pct_from_50 != null) { score += clamp(sum.pct_from_50 * 4, -35, 35); inputs++; }
  if (sum.pct_from_200 != null) { score += clamp(sum.pct_from_200 * 1.5, -35, 35); inputs++; }
  if (sum.ma_cross) { score += sum.ma_cross === "golden" ? 20 : -20; inputs++; }
  if (sum.rsi14 != null) { score += clamp((sum.rsi14 - 50) * 0.6, -15, 15); inputs++; }
  return inputs ? clamp(score, -100, 100) : null;
}

function biasOf(score: number): BiasKind {
  if (score >= 35) return "bullish";
  if (score >= 12) return "lean-bullish";
  if (score <= -35) return "bearish";
  if (score <= -12) return "lean-bearish";
  return "neutral";
}

// Cheap/rich premium. IV rank (where today's IV sits in its own trailing year) is
// the right measure but needs history, so until the table has accumulated enough
// snapshots we fall back to IV vs 30-day realized vol — available from day one off
// daily_prices. `volBasis` reports which one actually decided, so the UI never
// implies a rank it doesn't have.
function volRegimeOf(s: OptionsSnapshot): { regime: VolRegime; basis: VolBasis } {
  if (s.iv_rank != null) {
    return { regime: s.iv_rank >= 70 ? "rich" : s.iv_rank <= 30 ? "cheap" : "fair", basis: "iv-rank" };
  }
  if (s.iv_rv_ratio != null) {
    return { regime: s.iv_rv_ratio >= 1.25 ? "rich" : s.iv_rv_ratio <= 0.9 ? "cheap" : "fair", basis: "iv-vs-rv" };
  }
  return { regime: "fair", basis: "none" };
}

const UP = new Set<BiasKind>(["bullish", "lean-bullish"]);
const DOWN = new Set<BiasKind>(["bearish", "lean-bearish"]);

// The structure matrix. Direction picks the side; pricing picks whether you BUY
// premium (long options — needs cheap-to-fair vol) or DEFINE risk with a spread
// (rich vol, where an outright long pays for volatility that is likely to deflate).
function structureOf(
  bias: BiasKind, regime: VolRegime, daysToEarnings: number | null,
): { key: StructureKey; label: string; detail: string } {
  const earningsSoon = daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 7;

  if (UP.has(bias)) {
    if (regime === "rich" || earningsSoon) {
      return {
        key: "call-spread", label: "Call debit spread",
        detail: earningsSoon && regime !== "rich"
          ? "Bullish, but earnings are days away — buy the spread so the post-event IV drop is partly offset by the short leg."
          : "Bullish, but premium is expensive — a spread sells the rich vol back rather than paying up for it outright.",
      };
    }
    return {
      key: "long-calls", label: "Long calls",
      detail: regime === "cheap"
        ? "Bullish with cheap premium — the setup where simply owning calls is the efficient expression."
        : "Bullish with fairly-priced premium — long calls are reasonable; a spread lowers cost if you want defined risk.",
    };
  }

  if (DOWN.has(bias)) {
    if (regime === "rich" || earningsSoon) {
      return {
        key: "put-spread", label: "Put debit spread",
        detail: earningsSoon && regime !== "rich"
          ? "Bearish, but earnings are days away — spread the trade so an IV collapse doesn't eat a correct call."
          : "Bearish, but downside premium is expensive — spread it instead of buying rich puts outright.",
      };
    }
    return {
      key: "long-puts", label: "Long puts",
      detail: regime === "cheap"
        ? "Bearish with cheap premium — long puts are the clean expression, and they hedge the rest of the book."
        : "Bearish with fairly-priced premium — long puts work; a spread cuts the cost of being early.",
    };
  }

  if (regime === "rich") {
    return {
      key: "sell-premium", label: "Sell premium",
      detail: "No directional edge but premium is expensive — the payoff is in time and vol decay (credit spreads / condors), not direction.",
    };
  }
  if (regime === "cheap" && daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 21) {
    return {
      key: "straddle", label: "Long straddle",
      detail: "No directional edge, cheap premium, and a catalyst inside the window — the case for owning the move rather than a side.",
    };
  }
  return {
    key: "stand-aside", label: "No trade",
    detail: "Flow and trend disagree or are flat, and premium is not mispriced enough to trade volatility instead. Nothing to do.",
  };
}

function warningsFor(
  s: OptionsSnapshot, structure: StructureKey, daysToEarnings: number | null,
): string[] {
  const w: string[] = [];
  const buysPremium = structure === "long-calls" || structure === "long-puts" || structure === "straddle";

  if (daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 10) {
    w.push(
      `Earnings in ~${daysToEarnings}d (estimated). Implied vol usually collapses the morning after — ` +
      `long premium can lose money even when the direction is right.`,
    );
  }
  if (buysPremium && s.iv_rank != null && s.iv_rank >= 70) {
    w.push(`IV rank ${s.iv_rank.toFixed(0)} — you would be buying volatility near the top of its own range.`);
  }
  if (s.front_dte != null && s.front_dte <= 2) {
    w.push(`Front expiry is ${s.front_dte}d out — decay and gamma are extreme there; the ~${s.near_dte ?? 30}d expiry is the swing horizon.`);
  }
  if (s.near_move_pct != null && s.near_move_pct >= 10) {
    w.push(`A ±${s.near_move_pct.toFixed(1)}% move by ${s.near_expiry ?? "expiry"} is already priced in — a directional buy only pays beyond that.`);
  }
  if (s.skew_25d != null && s.skew_25d >= 8) {
    w.push(`25Δ skew ${s.skew_25d.toFixed(1)} vol pts — downside protection is unusually expensive; favour put spreads over outright puts.`);
  }
  if (s.skew_25d != null && s.skew_25d <= 0) {
    w.push(`Calls bid over puts (skew ${s.skew_25d.toFixed(1)}) — upside speculation or squeeze positioning, and unusual for equities.`);
  }
  if (s.iv_rank == null) {
    w.push(`IV rank still building (${s.iv_rank_obs ?? 0}/20 daily snapshots) — the cheap/rich read is IV-vs-realized-vol for now.`);
  }
  if (s.vix != null && s.vix >= 25) {
    w.push(`VIX ${s.vix.toFixed(1)} — market-wide volatility is elevated; position size matters more than the call/put choice.`);
  }
  const traded = (s.call_volume ?? 0) + (s.put_volume ?? 0);
  if (traded > 0 && traded < 2000) {
    w.push(`Thin chain — only ${traded.toLocaleString("en-US")} contracts traded; expect wide spreads and poor fills.`);
  }
  if (s.max_pain_pct != null && Math.abs(s.max_pain_pct) <= 1.5 && (s.front_dte ?? 99) <= 5) {
    w.push(`Spot is within ${Math.abs(s.max_pain_pct).toFixed(1)}% of max pain into a ${s.front_dte}d expiry — pin risk pulls against a small move.`);
  }
  return w;
}

function readFor(idea: Omit<OptionsIdea, "read">): string {
  const flow = idea.callShare == null ? "Flow is flat"
    : idea.callShare >= 65 ? `Calls are taking ${idea.callShare.toFixed(0)}% of premium`
    : idea.callShare <= 40 ? `Puts are taking ${(100 - idea.callShare).toFixed(0)}% of premium`
    : "Premium is split roughly evenly";
  const trend = idea.trendScore == null ? ""
    : idea.trendScore >= 20 ? ", and price is trending up"
    : idea.trendScore <= -20 ? ", and price is trending down"
    : ", with price going sideways";
  const price = idea.volBasis === "iv-rank"
    ? `IV rank ${idea.ivRank?.toFixed(0)} makes premium ${idea.volRegime}`
    : idea.volBasis === "iv-vs-rv"
      ? `IV ${idea.iv30?.toFixed(0)}% vs ${idea.rv30?.toFixed(0)}% realized makes premium ${idea.volRegime}`
      : "premium pricing is unknown";
  return `${flow}${trend}. ${price[0].toUpperCase()}${price.slice(1)}.`;
}

/**
 * Build one decision row per company from recent options snapshots.
 *
 * `snaps` is the recent multi-day window (fetchOptionsSnapshots): the newest row
 * per company becomes the idea and the prior one supplies day-over-day deltas.
 * `summaries` and `earningsDays` are optional enrichment — the bias falls back to
 * pure flow when a company has no technicals or no estimated earnings date.
 */
export function buildOptionsRadar(
  snaps: OptionsSnapshot[],
  summaries: Map<string, CompanySummary> = new Map(),
  earningsDays: Map<string, number> = new Map(),
): OptionsIdea[] {
  const byCik = new Map<string, OptionsSnapshot[]>();
  for (const s of snaps) {
    const list = byCik.get(s.cik);
    if (list) list.push(s);
    else byCik.set(s.cik, [s]);
  }

  const ideas: OptionsIdea[] = [];
  for (const [cik, rows] of byCik) {
    // Newest first — fetchOptionsSnapshots already orders desc, but sort so the
    // function is correct for any input ordering.
    rows.sort((a, b) => (a.snapshot_date < b.snapshot_date ? 1 : -1));
    const s = rows[0];
    const prev = rows[1];
    if (!s) continue;

    const unusual = Array.isArray(s.unusual) ? s.unusual : [];
    const flow = flowScore(s, unusual);
    const trend = trendScore(summaries.get(cik));
    const biasScore =
      flow != null && trend != null ? flow * 0.6 + trend * 0.4 : (flow ?? trend ?? 0);
    const bias = biasOf(biasScore);
    const { regime, basis } = volRegimeOf(s);
    const daysToEarnings = earningsDays.get(cik) ?? null;
    const structure = structureOf(bias, regime, daysToEarnings);
    const { call: uCall, put: uPut } = unusualSplit(unusual);

    const callPrem = s.call_premium ?? null;
    const putPrem = s.put_premium ?? null;
    const totalPrem = (callPrem ?? 0) + (putPrem ?? 0);

    const base: Omit<OptionsIdea, "read"> = {
      cik, ticker: s.ticker ?? "", date: s.snapshot_date,
      spot: s.spot, changePct: s.price_change_pct,
      flowScore: flow, trendScore: trend, biasScore: Math.round(biasScore), bias,
      volRegime: regime, volBasis: basis,
      ivRank: s.iv_rank, ivRankObs: s.iv_rank_obs, iv30: s.iv30, rv30: s.rv30,
      ivRvRatio: s.iv_rv_ratio,
      ivDelta: s.iv30 != null && prev?.iv30 != null ? s.iv30 - prev.iv30 : null,
      pcPremium: s.pc_premium_ratio, pcVolume: s.pc_volume_ratio, pcOi: s.pc_oi_ratio,
      callPremium: callPrem, putPremium: putPrem,
      callShare: totalPrem > 0 && callPrem != null ? (callPrem / totalPrem) * 100 : null,
      totalVolume: (s.call_volume ?? 0) + (s.put_volume ?? 0) || null,
      skew25d: s.skew_25d, frontDte: s.front_dte, expectedMovePct: s.expected_move_pct,
      nearDte: s.near_dte, nearMovePct: s.near_move_pct, nearExpiry: s.near_expiry,
      maxPainPct: s.max_pain_pct, vix: s.vix, vixChange: s.vix_change_pct,
      daysToEarnings, unusual, unusualCallPremium: uCall, unusualPutPremium: uPut,
      candidates: Array.isArray(s.candidates) ? s.candidates : [],
      structure, warnings: warningsFor(s, structure.key, daysToEarnings),
    };
    ideas.push({ ...base, read: readFor(base) });
  }

  // Strongest conviction first, either direction — the radar's job is to surface
  // where the chain is actually saying something.
  ideas.sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));
  return ideas;
}

// ─── Contract-level economics: which strike, at what cost, and is it a good deal ──
//
// The bias/structure above says "long calls". This says WHICH call and whether it is
// worth its price. The anchor is `emCoverage` — the move a contract needs to break
// even, divided by the move the chain itself prices (the ATM straddle). Below 1 the
// option pays off inside what the market already expects; above 1 you are paying for
// a move the market does not expect, which is the single most common way a correct
// directional view still loses. Cost, decay, bid/ask friction and skew are the other
// real costs, all expressed as a % of the premium so they compare across tickers.

export type TradeVerdict = "good-value" | "fair" | "expensive";

export type TradeCandidate = {
  leg: OptionCandidateRow;
  label: string;              // e.g. "Sep 11 310C"
  cost: number;               // $ for one contract (mid × 100)
  breakeven: number;          // underlying price at expiry that returns the premium
  beMovePct: number;          // move required from spot, % (unsigned magnitude)
  emCoverage: number | null;  // beMovePct ÷ expected move — <1 = inside what's priced
  costPerDelta: number;       // $ per point of delta — cheapest directional exposure
  spreadPct: number | null;   // bid/ask width as % of mid — round-trip friction
  thetaPctPerDay: number | null;
  ivVsSurface: number | null; // contract IV − chain IV30, vol points (skew you pay)
  score: number;              // ranking only — the verdict is set on interpretable rules
  verdict: TradeVerdict;
  notes: string[];
};

export type SpreadIdea = {
  long: OptionCandidateRow;
  short: OptionCandidateRow;
  label: string;
  debit: number;              // $ paid per spread
  width: number;              // $ distance between strikes
  maxProfit: number;
  riskReward: number;         // maxProfit ÷ debit
  breakeven: number;
  beMovePct: number;
  emCoverage: number | null;
};

function legLabel(c: OptionCandidateRow): string {
  const [, m, d] = c.expiry.split("-");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MON[Number(m) - 1]} ${Number(d)} ${c.strike}${c.right}`;
}

// Breakeven for a long option: calls need spot above strike+premium, puts below
// strike−premium. Returned as an unsigned % so calls and puts compare directly.
function breakevenOf(c: OptionCandidateRow, spot: number): { be: number; movePct: number } {
  const be = c.right === "C" ? c.strike + c.mid : c.strike - c.mid;
  return { be, movePct: Math.abs((be - spot) / spot) * 100 };
}

function verdictOf(emCoverage: number | null, spreadPct: number | null): TradeVerdict {
  // Deliberately rule-based rather than a threshold on the composite score: the
  // label a user acts on should be traceable to something they can check.
  if (emCoverage == null) return "fair";
  if (emCoverage <= 0.85 && (spreadPct == null || spreadPct <= 12)) return "good-value";
  if (emCoverage <= 1.15) return "fair";
  return "expensive";
}

function priceCandidate(
  leg: OptionCandidateRow, spot: number, expectedMovePct: number | null, iv30: number | null,
): TradeCandidate {
  const { be, movePct } = breakevenOf(leg, spot);
  const emCoverage = expectedMovePct && expectedMovePct > 0 ? movePct / expectedMovePct : null;
  const spreadPct = leg.bid != null && leg.ask != null && leg.mid > 0
    ? ((leg.ask - leg.bid) / leg.mid) * 100 : null;
  const thetaPctPerDay = leg.theta != null && leg.mid > 0
    ? (Math.abs(leg.theta) / leg.mid) * 100 : null;
  const ivVsSurface = leg.iv != null && iv30 != null ? leg.iv - iv30 : null;
  const absDelta = Math.abs(leg.delta);

  let score = 0;
  if (emCoverage != null) score += clamp((1.3 - emCoverage) * 60, -70, 70);
  if (spreadPct != null) score -= Math.min(spreadPct, 40) * 0.8;
  if (thetaPctPerDay != null) score -= Math.min(thetaPctPerDay, 8) * 4;
  if (ivVsSurface != null && ivVsSurface > 0) score -= Math.min(ivVsSurface, 15) * 1.5;
  if (leg.oi >= 1000) score += 5;
  else if (leg.oi >= 250) score += 2;
  if (absDelta < 0.25) score -= 8;   // low-delta lottery tickets rarely pay

  const notes: string[] = [];
  if (emCoverage != null && emCoverage > 1.3) {
    notes.push(`Needs a ${movePct.toFixed(1)}% move to break even — more than the ±${expectedMovePct?.toFixed(1)}% the chain itself prices.`);
  }
  if (spreadPct != null && spreadPct > 15) {
    notes.push(`Wide market — the bid/ask alone costs ~${spreadPct.toFixed(0)}% of the premium round trip.`);
  }
  if (thetaPctPerDay != null && thetaPctPerDay > 2) {
    notes.push(`Decays ~${thetaPctPerDay.toFixed(1)}%/day — this needs to work quickly.`);
  }
  if (ivVsSurface != null && ivVsSurface > 4) {
    notes.push(`This strike carries ${ivVsSurface.toFixed(1)} vol pts over the chain's 30-day IV — you're paying skew for it.`);
  }
  if (leg.oi < 250) notes.push(`Thin open interest (${leg.oi}) — expect slippage getting out.`);

  return {
    leg, label: legLabel(leg), cost: leg.mid * 100, breakeven: be, beMovePct: movePct,
    emCoverage, costPerDelta: absDelta > 0 ? (leg.mid * 100) / absDelta : Infinity,
    spreadPct, thetaPctPerDay, ivVsSurface,
    score, verdict: verdictOf(emCoverage, spreadPct), notes,
  };
}

/**
 * Price every stored contract on one side of the chain, best value first.
 *
 * `side` filters to calls or puts; pass null to price both (used when there is no
 * directional edge and the question is purely which premium is mispriced).
 */
export function buildTradeCandidates(idea: OptionsIdea, side: "C" | "P" | null): TradeCandidate[] {
  if (!idea.candidates?.length || !idea.spot) return [];
  const legs = side ? idea.candidates.filter((c) => c.right === side) : idea.candidates;
  return legs
    .map((leg) => priceCandidate(leg, idea.spot as number, idea.nearMovePct, idea.iv30))
    .sort((a, b) => b.score - a.score);
}

/**
 * Best vertical debit spread on one side — the structure recommended when premium
 * is rich or earnings are close, since the short leg sells back some of the
 * volatility the long leg pays for.
 *
 * Long leg ≈ 0.55 delta (enough directional exposure to matter), short leg ≈ 0.30
 * delta further out-of-the-money in the SAME expiry.
 */
export function buildSpread(idea: OptionsIdea, side: "C" | "P"): SpreadIdea | null {
  if (!idea.candidates?.length || !idea.spot) return null;
  const spot = idea.spot;

  let best: SpreadIdea | null = null;
  const expiries = Array.from(new Set(idea.candidates.filter((c) => c.right === side).map((c) => c.expiry)));

  for (const expiry of expiries) {
    const legs = idea.candidates.filter((c) => c.right === side && c.expiry === expiry);
    if (legs.length < 2) continue;
    const nearest = (target: number) =>
      legs.reduce((a, b) => (Math.abs(Math.abs(b.delta) - target) < Math.abs(Math.abs(a.delta) - target) ? b : a));
    const long = nearest(0.55);
    const short = nearest(0.30);
    // The short leg must be further out-of-the-money than the long leg, or it isn't
    // a debit spread at all.
    const ordered = side === "C" ? short.strike > long.strike : short.strike < long.strike;
    if (!ordered) continue;

    const debitPerShare = long.mid - short.mid;
    if (debitPerShare <= 0) continue;
    const width = Math.abs(short.strike - long.strike);
    const debit = debitPerShare * 100;
    const maxProfit = width * 100 - debit;
    if (maxProfit <= 0) continue;
    const be = side === "C" ? long.strike + debitPerShare : long.strike - debitPerShare;
    const beMovePct = Math.abs((be - spot) / spot) * 100;

    const cand: SpreadIdea = {
      long, short, label: `${legLabel(long)} / ${legLabel(short)}`,
      debit, width: width * 100, maxProfit, riskReward: maxProfit / debit,
      breakeven: be, beMovePct,
      emCoverage: idea.nearMovePct && idea.nearMovePct > 0 ? beMovePct / idea.nearMovePct : null,
    };
    // Prefer the spread that breaks even soonest relative to the priced move; the
    // risk/reward breaks ties.
    if (!best || (cand.emCoverage ?? 9) < (best.emCoverage ?? 9)
      || ((cand.emCoverage ?? 9) === (best.emCoverage ?? 9) && cand.riskReward > best.riskReward)) {
      best = cand;
    }
  }
  return best;
}

/** The side a structure trades, or null when it isn't directional. */
export function sideOf(key: StructureKey): "C" | "P" | null {
  if (key === "long-calls" || key === "call-spread") return "C";
  if (key === "long-puts" || key === "put-spread") return "P";
  return null;
}

/**
 * The cheapest contract that still breaks even inside the priced move — the direct
 * answer to "what's the least expensive way to express this that isn't a lottery
 * ticket". Falls back to null when every candidate needs more than the market prices.
 */
export function cheapestViable(candidates: TradeCandidate[]): TradeCandidate | null {
  const viable = candidates.filter((c) => c.emCoverage != null && c.emCoverage <= 1);
  if (!viable.length) return null;
  return viable.reduce((a, b) => (b.cost < a.cost ? b : a));
}

export type OptionsTape = {
  asOf: string | null;
  vix: number | null;
  vixChange: number | null;
  bullish: number;
  bearish: number;
  neutral: number;
  rich: number;
  cheap: number;
  callShare: number | null;   // watchlist-wide calls as % of premium traded
};

/** Watchlist-wide regime line above the radar (VIX, bias split, aggregate flow). */
export function buildOptionsTape(ideas: OptionsIdea[]): OptionsTape {
  let callPrem = 0, putPrem = 0;
  let bullish = 0, bearish = 0, neutral = 0, rich = 0, cheap = 0;
  let vix: number | null = null, vixChange: number | null = null, asOf: string | null = null;

  for (const i of ideas) {
    callPrem += i.callPremium ?? 0;
    putPrem += i.putPremium ?? 0;
    if (UP.has(i.bias)) bullish++;
    else if (DOWN.has(i.bias)) bearish++;
    else neutral++;
    if (i.volRegime === "rich") rich++;
    if (i.volRegime === "cheap") cheap++;
    if (vix == null && i.vix != null) { vix = i.vix; vixChange = i.vixChange; }
    if (asOf == null || i.date > asOf) asOf = i.date;
  }
  const total = callPrem + putPrem;
  return {
    asOf, vix, vixChange, bullish, bearish, neutral, rich, cheap,
    callShare: total > 0 ? (callPrem / total) * 100 : null,
  };
}
