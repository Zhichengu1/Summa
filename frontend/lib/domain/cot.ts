// COT positioning signals — pure logic over `cot_reports` rows (fetchCotReports).
// Mirrors the backend digest math (ingest/cot_ingest.py _digest_stats): per
// market, the latest large-speculator net, its week-over-week shift scaled by
// open interest, and the COT index — the percentile of today's spec net within
// a trailing lookback. The classic playbook the view surfaces:
//   idx ≥ 90 → specs crowded long (trend mature; contrarian reversal risk)
//   idx ≤ 10 → specs crowded short (bearish crowd stretched; squeeze setup)
//   net crossing zero → regime flip; big weekly shift → fresh money flowing now.
import type { CotReport } from "../types";

export type CotSignalKind =
  | "flip-long" | "flip-short"
  | "crowded-long" | "crowded-short"
  | "surge-long" | "surge-short"
  | "neutral";

export type CotMarket = {
  code: string;
  name: string;
  group: string;
  latestDate: string;          // this market's newest report (Tuesday as-of)
  openInterest: number;
  specNet: number;             // large-spec net (long − short), contracts
  specNetPctOi: number | null; // spec net as % of open interest
  specWow: number;             // WoW change in spec net, contracts
  specWowPctOi: number | null; // that change as % of OI — the "flow" read
  commNet: number;             // commercial (hedger) net — the mirror side
  specLong: number;
  specShort: number;
  commLong: number;
  commShort: number;
  tradersTotal: number | null;
  specIndex: number;           // COT index 0–100 over the lookback
  streak: number;              // +N = specs added N straight weeks, −N = cut N straight
  chg13w: number;              // spec net change over ~13 weeks (one quarter)
  series: number[];            // spec net by week, oldest → newest
  commSeries: number[];        // commercial net by week (the mirror image)
  dates: string[];             // matching report dates
  signal: CotSignalKind;
  read: string;                // one-line human interpretation
};

export const COT_GROUPS: { key: string; label: string }[] = [
  { key: "indices", label: "Indices" },
  { key: "rates", label: "Rates" },
  { key: "fx", label: "FX" },
  { key: "crypto", label: "Crypto" },
  { key: "energy", label: "Energy" },
  { key: "metals", label: "Metals" },
  { key: "ags", label: "Ags" },
];

// A weekly spec-net change of at least this % of OI counts as a surge.
const SURGE_PCT_OI = 2;

// Consecutive weeks the spec net has moved one way: +N adding, −N cutting.
// A zero-change week breaks the streak.
export function specStreak(series: number[]): number {
  let n = 0;
  for (let i = series.length - 1; i > 0; i--) {
    const d = series[i] - series[i - 1];
    if (d === 0) break;
    if (n === 0) n = d > 0 ? 1 : -1;
    else if ((d > 0) === (n > 0)) n += Math.sign(n);
    else break;
  }
  return n;
}

// COT index: midrank percentile of the latest value within the series, so ties
// (and a flat series) land mid-band instead of at an extreme.
export function cotIndex(series: number[], latest: number): number {
  if (series.length < 2) return 50;
  let below = 0, equal = 0;
  for (const v of series) {
    if (v < latest) below += 1;
    else if (v === latest) equal += 1;
  }
  return Math.round(((below + (equal - 1) / 2) * 1000) / (series.length - 1)) / 10;
}

function classify(m: {
  specNet: number; prevNet: number; specIndex: number; specWowPctOi: number | null;
}): { signal: CotSignalKind; read: string } {
  const flipped = (m.specNet > 0 && m.prevNet < 0) || (m.specNet < 0 && m.prevNet > 0);
  if (flipped) {
    const long = m.specNet > 0;
    return {
      signal: long ? "flip-long" : "flip-short",
      read: `Speculators flipped net ${long ? "LONG" : "SHORT"} this week — a positioning regime change worth watching.`,
    };
  }
  if (m.specIndex >= 90) {
    return {
      signal: "crowded-long",
      read: "Specs near their max long of the lookback — the crowd is already in; upside needs new buyers, and a negative surprise can unwind fast.",
    };
  }
  if (m.specIndex <= 10) {
    return {
      signal: "crowded-short",
      read: "Specs near their max short — the bearish trade is crowded; a positive surprise can squeeze this market higher.",
    };
  }
  const wow = m.specWowPctOi ?? 0;
  if (Math.abs(wow) >= SURGE_PCT_OI) {
    const buying = wow > 0;
    return {
      signal: buying ? "surge-long" : "surge-short",
      read: `Heavy spec ${buying ? "buying" : "selling"} this week (${wow > 0 ? "+" : ""}${wow.toFixed(1)}% of OI) — fresh money ${buying ? "flowing in" : "coming out"}.`,
    };
  }
  return { signal: "neutral", read: "Positioning mid-range — no crowd extreme; direction is up for grabs." };
}

// Build the per-market view: group rows by market, sort each series by date,
// take the newest report as "now" and derive index/WoW/signal. `indexWeeks`
// bounds the percentile lookback (the fetched history caps it at ~3y).
export function buildCotMarkets(rows: CotReport[], indexWeeks = 156): CotMarket[] {
  const byCode = new Map<string, CotReport[]>();
  for (const r of rows) {
    const list = byCode.get(r.market_code);
    if (list) list.push(r); else byCode.set(r.market_code, [r]);
  }
  const out: CotMarket[] = [];
  for (const [code, list] of byCode) {
    list.sort((a, b) => a.report_date.localeCompare(b.report_date));
    if (list.length < 2) continue;   // no WoW read yet
    const window = list.slice(-indexWeeks);
    const latest = window[window.length - 1];
    const prev = window[window.length - 2];
    const series = window.map((r) => r.noncomm_net ?? 0);
    const specNet = latest.noncomm_net ?? 0;
    const prevNet = prev.noncomm_net ?? 0;
    const oi = latest.open_interest ?? 0;
    const specWow = specNet - prevNet;
    const specWowPctOi = oi ? Math.round((specWow * 10000) / oi) / 100 : null;
    const specIndex = cotIndex(series, specNet);
    const { signal, read } = classify({ specNet, prevNet, specIndex, specWowPctOi });
    out.push({
      code,
      name: latest.market_name ?? code,
      group: latest.market_group ?? "other",
      latestDate: latest.report_date,
      openInterest: oi,
      specNet,
      specNetPctOi: latest.noncomm_net_pct_oi,
      specWow,
      specWowPctOi,
      commNet: latest.comm_net ?? 0,
      specLong: latest.noncomm_long ?? 0,
      specShort: latest.noncomm_short ?? 0,
      commLong: latest.comm_long ?? 0,
      commShort: latest.comm_short ?? 0,
      tradersTotal: latest.traders_total,
      specIndex,
      streak: specStreak(series),
      chg13w: specNet - series[Math.max(0, series.length - 14)],
      series,
      commSeries: window.map((r) => r.comm_net ?? 0),
      dates: window.map((r) => r.report_date),
      signal,
      read,
    });
  }
  // Most actionable first: extremes/flips, then by |weekly flow|.
  const rank = (s: CotSignalKind) =>
    s.startsWith("flip") ? 0 : s.startsWith("crowded") ? 1 : s.startsWith("surge") ? 2 : 3;
  out.sort((a, b) =>
    rank(a.signal) - rank(b.signal)
    || Math.abs(b.specWowPctOi ?? 0) - Math.abs(a.specWowPctOi ?? 0));
  return out;
}

export type CotTakeaway = { code: string; name: string; text: string };

const fmtK = (v: number): string => {
  const a = Math.abs(v);
  const body = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}M`
    : a >= 10_000 ? `${(a / 1_000).toFixed(0)}K` : a.toLocaleString("en-US");
  return `${v >= 0 ? "+" : "−"}${body}`;
};

// This week's story in plain language — one takeaway per market, best category
// first (flip > crowded extreme > persistent streak > big weekly flow), capped.
// The order mirrors how actionable each pattern is for the week ahead.
export function buildCotTakeaways(markets: CotMarket[], max = 6): CotTakeaway[] {
  const out: CotTakeaway[] = [];
  const used = new Set<string>();
  const add = (m: CotMarket, text: string) => {
    if (!used.has(m.code)) { used.add(m.code); out.push({ code: m.code, name: m.name, text }); }
  };

  for (const m of markets.filter((x) => x.signal.startsWith("flip"))) {
    add(m, `Speculators flipped net ${m.specNet > 0 ? "LONG" : "SHORT"} this week `
      + `(${fmtK(m.specWow)} contracts) — a positioning regime change; early-trend signal.`);
  }
  for (const m of markets.filter((x) => x.signal === "crowded-long")
    .sort((a, b) => b.specIndex - a.specIndex)) {
    add(m, `Specs are at ${m.specIndex.toFixed(0)}/100 of their range — the bullish trade is `
      + `crowded (net ${fmtK(m.specNet)}); a negative catalyst could unwind it fast.`);
  }
  for (const m of markets.filter((x) => x.signal === "crowded-short")
    .sort((a, b) => a.specIndex - b.specIndex)) {
    add(m, `Specs are at ${m.specIndex.toFixed(0)}/100 — max-bearish territory `
      + `(net ${fmtK(m.specNet)}); positive news could squeeze this market higher.`);
  }
  for (const m of markets.filter((x) => Math.abs(x.streak) >= 4)
    .sort((a, b) => Math.abs(b.streak) - Math.abs(a.streak))) {
    const adding = m.streak > 0;
    add(m, `Specs have ${adding ? "added" : "cut"} for ${Math.abs(m.streak)} straight weeks `
      + `(${fmtK(m.chg13w)} over the quarter) — ${adding ? "bullish" : "bearish"} conviction building.`);
  }
  for (const m of markets.filter((x) => x.signal.startsWith("surge"))
    .sort((a, b) => Math.abs(b.specWowPctOi ?? 0) - Math.abs(a.specWowPctOi ?? 0))) {
    add(m, `The week's big flow: specs ${m.specWow > 0 ? "bought" : "sold"} ${fmtK(m.specWow)} `
      + `contracts (${Math.abs(m.specWowPctOi ?? 0).toFixed(1)}% of OI) — fresh money moving now.`);
  }
  return out.slice(0, max);
}
