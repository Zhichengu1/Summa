// Pulse — the pure "what's happening" layer shared by the per-company cockpit
// AND the watchlist-wide Scanner / Calendar.
//
//   • buildTape    → one company's events as a chronological, impact-tagged stream
//   • buildSignals → one company's directional, forward-looking signals
//   • buildWatchlistTape / buildWatchlistSignals → the same, merged + ranked across
//     every watchlist company, each item tagged with its ticker/cik
//
// These moved out of page.tsx so the cross-company surfaces reuse the exact same
// logic rather than re-deriving it. No I/O and no JSX here — page.tsx owns the
// presentational atoms (DirMark, SignalCard, TapeRow).
import { seriesFor, METRICS } from "./fundamentals";
import { fmtUSD, fmtPct, fmtDelta } from "./format";
import { entityContext } from "./entities";
import { analyzeInsider, describeInsiderTx, txCodeLabel, type InsiderRead } from "./insider";
import { derivePriceKpis } from "./prices";
import { deriveTechnicals } from "./technicals";
import type {
  FinancialFact, EarningsEvent, InsiderTransaction, InstitutionalHolding,
  BeneficialOwnership, SecuritiesOffering, LateFiling, CorporateEvent, DailyPrice,
} from "./types";

export type Direction = "bull" | "bear" | "neutral" | "flag";
export type TapeItem = {
  date: string; kind: string; dir: Direction; headline: string; note?: string;
  ticker?: string; cik?: string;
};
export type Signal = { label: string; status: string; dir: Direction; detail: string; date?: string };

export const EVENT_CLASS_DIR: Record<string, Direction> = {
  "M&A": "neutral", dilution: "bear", restatement: "flag", exec_change: "neutral",
  earnings: "neutral", capital_return: "bull", cyber: "flag", other: "neutral",
};

// Everything a company's pulse is derived from. All slices optional so callers
// can pass only what they fetched.
export type CompanyData = {
  facts?: FinancialFact[];
  earnings?: EarningsEvent[];
  insider?: InsiderTransaction[];
  holdings?: InstitutionalHolding[];
  beneficial?: BeneficialOwnership[];
  offers?: SecuritiesOffering[];
  lateF?: LateFiling[];
  events?: CorporateEvent[];
  prices?: DailyPrice[];
};

/** Merge every event domain into one chronological, impact-tagged stream. */
export function buildTape(d: CompanyData): TapeItem[] {
  const items: TapeItem[] = [];

  for (const e of d.earnings ?? []) {
    const date = e.reported_date ?? e.filed_at;
    if (!date) continue;
    const parts: string[] = [];
    if (e.revenue != null) parts.push(`Rev ${fmtUSD(e.revenue)}`);
    if (e.diluted_eps != null) parts.push(`EPS ${e.diluted_eps.toFixed(2)}`);
    const g = e.guidance_action;
    const dir: Direction = g === "raised" ? "bull" : g === "lowered" || g === "withdrawn" ? "bear" : "neutral";
    items.push({
      date, kind: "Earnings", dir,
      headline: `${parts.join(" · ") || "Results"}${g ? ` · guidance ${g}` : ""}`,
    });
  }

  for (const ev of d.events ?? []) {
    const date = ev.event_date ?? ev.filed_at;
    if (!date) continue;
    items.push({
      date, kind: "8-K", dir: EVENT_CLASS_DIR[ev.event_class ?? "other"] ?? "neutral",
      headline: ev.summary?.trim() || ev.event_class || "Corporate event",
    });
  }

  for (const t of d.insider ?? []) {
    const date = t.transaction_date ?? t.filed_at;
    if (!date || !t.value) continue;
    const code = (t.transaction_code ?? "").toUpperCase();
    const buy = t.acquired_disposed === "A";
    // Open-market trades (P/S) carry real conviction; everything else is mechanical.
    const dir: Direction = code === "P" ? "bull" : code === "S" ? "bear" : "neutral";
    const who = t.filer_name ?? "Insider";
    const role = (t.filer_title ?? "").trim();
    const verb = code === "P" ? "bought" : code === "S" ? "sold" : buy ? "acquired" : "disposed";
    const codeLabel = code ? ` (${txCodeLabel(code)})` : "";
    items.push({
      date, kind: "Insider", dir,
      // "Tim Cook · Chief Executive Officer — bought $2.0M (open-market buy)"
      headline: `${who}${role ? ` · ${role}` : ""} — ${verb} ${fmtUSD(Math.abs(t.value))}${codeLabel}${t.is_10b5_1 ? " · 10b5-1" : ""}`,
      note: describeInsiderTx(t),
    });
  }

  for (const b of d.beneficial ?? []) {
    if (!b.filed_at) continue;
    const ctx = entityContext(b.filer_name);
    items.push({
      date: b.filed_at, kind: b.is_activist ? "Activist" : "Stake",
      dir: b.is_activist ? "flag" : "neutral",
      headline: `${b.filer_name ?? "Investor"} ${b.pct_of_class != null ? `${fmtPct(b.pct_of_class)} ` : ""}stake (${b.schedule ?? "13D/G"})`,
      note: ctx ? `${ctx.label}. ${ctx.note}` : undefined,
    });
  }

  for (const o of d.offers ?? []) {
    if (!o.filed_at) continue;
    items.push({
      date: o.filed_at, kind: "Offering", dir: "bear",
      headline: `${o.offering_type ?? o.form ?? "Securities"} offering${o.amount ? ` ${fmtUSD(o.amount)}` : ""}`,
    });
  }

  for (const l of d.lateF ?? []) {
    if (!l.filed_at) continue;
    items.push({
      date: l.filed_at, kind: "Late Filing", dir: "flag",
      headline: `Late ${l.nt_form ?? "NT"}${l.subject_form ? ` (${l.subject_form})` : ""}`,
    });
  }

  return items.sort((a, b) => b.date.localeCompare(a.date));
}

/** Distill the data domains into directional, forward-looking signals. */
export function buildSignals(d: CompanyData): Signal[] {
  const out: Signal[] = [];
  const facts = d.facts ?? [];

  // Guidance direction — the most forward-looking single field we have.
  const guided = (d.earnings ?? []).find((e) => e.guidance_action);
  if (guided?.guidance_action) {
    const g = guided.guidance_action;
    out.push({
      label: "Guidance", status: g[0].toUpperCase() + g.slice(1),
      dir: g === "raised" ? "bull" : g === "lowered" || g === "withdrawn" ? "bear" : "neutral",
      detail: "Management's latest forward guidance action",
      date: guided.reported_date ?? guided.filed_at ?? undefined,
    });
  }

  // Revenue momentum — latest quarter vs. the year-ago quarter.
  const rev = seriesFor(facts, "income", "quarterly", METRICS.revenue);
  if (rev.length > 4) {
    const last = rev[rev.length - 1].value, yago = rev[rev.length - 5].value;
    if (yago) {
      const g = ((last - yago) / Math.abs(yago)) * 100;
      out.push({
        label: "Revenue Momentum", status: `${fmtDelta(g)} YoY`,
        dir: g >= 0 ? "bull" : "bear", detail: "Latest quarter revenue vs. a year ago",
        date: rev[rev.length - 1].period,
      });
    }
  }

  // Net-margin trend — latest reported quarter vs. the prior quarter.
  const ni = seriesFor(facts, "income", "quarterly", METRICS.netIncome);
  if (rev.length > 1 && ni.length > 1) {
    const m = (r?: number, n?: number) => (r && n != null ? (n / r) * 100 : null);
    const cur  = m(rev.at(-1)?.value, ni.at(-1)?.value);
    const prev = m(rev.at(-2)?.value, ni.at(-2)?.value);
    if (cur != null && prev != null) {
      const dlt = cur - prev;
      out.push({
        label: "Net Margin", status: `${fmtPct(cur)} (${dlt >= 0 ? "+" : ""}${dlt.toFixed(1)}pt)`,
        dir: dlt >= 0 ? "bull" : "bear", detail: "Profitability QoQ",
        date: rev.at(-1)?.period,
      });
    }
  }

  // Insider conviction — open-market buys/sells only (grants, option exercises,
  // and tax-withholding sales are excluded as non-discretionary). Cluster buying
  // (≥3 distinct insiders buying) is the strongest single insider tell.
  const ins = analyzeInsider(d.insider ?? []);
  const insDate = (d.insider ?? [])
    .map((t) => t.transaction_date ?? t.filed_at)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  if (ins.clusterBuy) {
    out.push({
      label: "Insider Cluster Buy", status: `${ins.distinctBuyers} insiders buying`,
      dir: "bull",
      detail: `${ins.distinctBuyers} distinct insiders bought ${fmtUSD(ins.buyValue)} on the open market (90d)`,
      date: insDate,
    });
  } else if (ins.anyOpenMarket) {
    const buying = ins.netOpenMarket >= 0;
    out.push({
      label: "Insider Flow · 90d", status: buying ? "Net buying" : "Net selling",
      dir: buying ? "bull" : "bear",
      detail: `${fmtUSD(ins.netOpenMarket, { sign: true })} net open-market · ${ins.distinctBuyers} buyer${ins.distinctBuyers === 1 ? "" : "s"} / ${ins.distinctSellers} seller${ins.distinctSellers === 1 ? "" : "s"}`,
      date: insDate,
    });
  } else if (ins.routineValue > 0) {
    out.push({
      label: "Insider Flow · 90d", status: "Routine only",
      dir: "neutral",
      detail: "Only grants / option exercises / tax sales — no open-market conviction trades",
      date: insDate,
    });
  }

  // Institutional flow — total reported value, latest quarter vs. prior.
  const byQ = new Map<string, number>();
  for (const h of d.holdings ?? []) if (h.value != null) byQ.set(h.period_of_report, (byQ.get(h.period_of_report) ?? 0) + h.value);
  const quarters = Array.from(byQ.keys()).sort((a, b) => b.localeCompare(a));
  if (quarters.length > 1) {
    const cur = byQ.get(quarters[0]) ?? 0, prev = byQ.get(quarters[1]) ?? 0;
    if (prev > 0) {
      const g = ((cur - prev) / prev) * 100;
      out.push({
        label: "Institutional Flow", status: g >= 0 ? "Accumulating" : "Distributing",
        dir: g >= 0 ? "bull" : "bear", detail: `${fmtDelta(g)} reported value QoQ (13F, lagged)`,
        date: quarters[0],
      });
    }
  }

  // Activist watch — a 13D activist on the register is a standing catalyst.
  const activists = (d.beneficial ?? []).filter((b) => b.is_activist);
  if (activists.length) out.push({
    label: "Activist Watch", status: "Active", dir: "flag",
    detail: "An activist holds a disclosed 5%+ stake",
    date: activists.map((b) => b.filed_at).filter((x): x is string => !!x).sort().at(-1),
  });

  // Dilution risk — securities offerings in the trailing 12 months.
  const cutoff1y = Date.now() - 365 * 86_400_000;
  const recentOffers = (d.offers ?? []).filter((o) => o.filed_at && new Date(o.filed_at).getTime() > cutoff1y);
  if (recentOffers.length) {
    const amt = recentOffers.reduce((s, o) => s + (o.amount ?? 0), 0);
    out.push({
      label: "Dilution Risk", status: "Elevated", dir: "bear",
      detail: `${recentOffers.length} offering${recentOffers.length > 1 ? "s" : ""}${amt ? ` · ${fmtUSD(amt)}` : ""} in 12mo`,
      date: recentOffers.map((o) => o.filed_at).filter((x): x is string => !!x).sort().at(-1),
    });
  }

  // Filing integrity — late notices are a classic distress tell.
  const lateF = d.lateF ?? [];
  if (lateF.length) out.push({
    label: "Filing Integrity", status: "Late filing", dir: "flag",
    detail: `${lateF.length} late-filing notice${lateF.length > 1 ? "s" : ""} on record`,
    date: lateF.map((l) => l.filed_at).filter((x): x is string => !!x).sort().at(-1),
  });

  // Price context — where the stock sits vs. its trailing 52-week high (EOD).
  if ((d.prices ?? []).length > 1) {
    const k = derivePriceKpis(d.prices ?? []);
    if (k.pctOffHigh != null && k.last != null) {
      const near = k.pctOffHigh > -3;          // within 3% of the high
      const deep = k.pctOffHigh < -25;         // >25% off the high
      out.push({
        label: "Price vs 52-wk High",
        status: near ? "At/near high" : deep ? "Deep pullback" : `${k.pctOffHigh.toFixed(0)}% off high`,
        dir: near ? "bull" : deep ? "bear" : "neutral",
        detail: `Last ${fmtUSD(k.last)} · ${k.pctOffHigh.toFixed(1)}% from 52-wk high${k.retYTD != null ? ` · ${fmtDelta(k.retYTD)} YTD` : ""}`,
        date: k.asOf ?? undefined,
      });
    }

    // Technical price action — moving-average trend, momentum, and volume.
    const tech = deriveTechnicals(d.prices ?? []);
    if (tech.cross) out.push({
      label: tech.cross === "golden" ? "Golden Cross" : "Death Cross",
      status: tech.cross === "golden" ? "50d above 200d" : "50d below 200d",
      dir: tech.cross === "golden" ? "bull" : "bear",
      detail: tech.cross === "golden"
        ? "The 50-day average just crossed above the 200-day — a classic uptrend signal."
        : "The 50-day average just crossed below the 200-day — a classic downtrend signal.",
      date: tech.asOf ?? undefined,
    });
    if (tech.new52wHigh) out.push({
      label: "52-wk Breakout", status: "New 52-wk high", dir: "bull",
      detail: "Closed at a fresh 52-week high — price momentum at the top of its range.",
      date: tech.asOf ?? undefined,
    });
    else if (tech.new52wLow) out.push({
      label: "52-wk Low", status: "New 52-wk low", dir: "bear",
      detail: "Closed at a fresh 52-week low — price momentum at the bottom of its range.",
      date: tech.asOf ?? undefined,
    });
    if (tech.rsi14 != null && (tech.rsi14 >= 70 || tech.rsi14 <= 30)) out.push({
      label: "RSI", status: tech.rsi14 >= 70 ? `Overbought (${tech.rsi14.toFixed(0)})` : `Oversold (${tech.rsi14.toFixed(0)})`,
      dir: tech.rsi14 >= 70 ? "bear" : "bull",
      detail: tech.rsi14 >= 70
        ? "14-day RSI above 70 — the stock may be overextended to the upside."
        : "14-day RSI below 30 — the stock may be oversold.",
      date: tech.asOf ?? undefined,
    });
    if (tech.volSpike != null && tech.volSpike >= 2) out.push({
      label: "Volume Spike", status: `${tech.volSpike.toFixed(1)}× avg`, dir: "flag",
      detail: `Latest session traded ${tech.volSpike.toFixed(1)}× the 30-day average volume — unusual activity worth a look.`,
      date: tech.asOf ?? undefined,
    });
  }

  return out;
}

// ─── Watchlist-wide aggregation ─────────────────────────────────────────────────

export type WatchEntry = { cik: string; ticker: string; name: string; data: CompanyData };

/** One company's signals plus a ranking score, for the Scanner. */
export type ScannerRow = {
  cik: string; ticker: string; name: string;
  signals: Signal[]; insider: InsiderRead; score: number;
  dominant: Direction;     // the row's overall lean — drives the color stripe
  latest?: string;         // most recent dated signal — drives "Xd ago" + recency sort
};

const DIR_WEIGHT: Record<Direction, number> = { flag: 3, bear: 2, bull: 2, neutral: 0.5 };

/** Pick the row's overall lean: flags win, else the heavier of bull/bear, else neutral. */
function dominantDir(signals: Signal[]): Direction {
  let bull = 0, bear = 0, flag = 0;
  for (const s of signals) {
    if (s.dir === "flag") flag++;
    else if (s.dir === "bull") bull++;
    else if (s.dir === "bear") bear++;
  }
  if (flag > 0) return "flag";
  if (bull === 0 && bear === 0) return "neutral";
  return bull >= bear ? "bull" : "bear";
}

/**
 * Per-company signals across the watchlist, ranked most-actionable first.
 * Signals within a row are sorted by importance (flag → bull/bear → neutral) so the
 * lead signal is the one a trader should see first; rows are ranked by score, then
 * by most-recent catalyst so fresh activity floats up.
 */
export function buildWatchlistSignals(entries: WatchEntry[]): ScannerRow[] {
  const rows: ScannerRow[] = entries.map((e) => {
    const signals = buildSignals(e.data)
      .sort((a, b) => DIR_WEIGHT[b.dir] - DIR_WEIGHT[a.dir]);
    const insider = analyzeInsider(e.data.insider ?? []);
    const score = signals.reduce((s, sig) => s + DIR_WEIGHT[sig.dir], 0)
      + (insider.clusterBuy ? 2 : 0);
    const latest = signals.map((s) => s.date).filter((x): x is string => !!x).sort().at(-1);
    return { cik: e.cik, ticker: e.ticker, name: e.name, signals, insider, score, dominant: dominantDir(signals), latest };
  });
  return rows.sort((a, b) => (b.score - a.score) || (b.latest ?? "").localeCompare(a.latest ?? ""));
}

/** Merged, date-sorted event tape across the watchlist, each item ticker-tagged. */
export function buildWatchlistTape(entries: WatchEntry[]): TapeItem[] {
  const all: TapeItem[] = [];
  for (const e of entries) {
    for (const it of buildTape(e.data)) {
      all.push({ ...it, ticker: e.ticker, cik: e.cik });
    }
  }
  return all.sort((a, b) => b.date.localeCompare(a.date));
}
