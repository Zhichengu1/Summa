// Health Scorecard — turns the raw per-company data into a plain-English read a
// non-analyst can act on: a grade per dimension a shareholder cares about, an
// overall verdict, and a sentence or two of summary. Derived entirely from data
// the cockpit already fetched — no extra Supabase load. (The Scorecard component
// in components/Scorecard.tsx renders the result of buildScorecard.)

import { seriesFor, METRICS } from "./fundamentals";
import { analyzeInsider } from "./insider";
import { fmtUSD, fmtPct, fmtDelta } from "../utils/format";
import type {
  FinancialFact, InsiderTransaction, SecuritiesOffering, LateFiling, CorporateEvent,
} from "../types";

export type Grade = "strong" | "good" | "mixed" | "weak" | "na";
export type ScoreDim = { label: string; grade: Grade; detail: string; term?: string };
export type ScorecardResult = { dims: ScoreDim[]; overall: Grade; summary: string };

export const GRADE_RANK:  Record<Grade, number> = { strong: 2, good: 1, na: 0, mixed: -1, weak: -2 };
export const GRADE_LABEL: Record<Grade, string> = { strong: "Strong", good: "Good", mixed: "Mixed", weak: "Weak", na: "—" };

/** Grade a company across six shareholder dimensions and produce an overall verdict. */
export function buildScorecard(d: {
  facts: FinancialFact[]; insider: InsiderTransaction[];
  offers: SecuritiesOffering[]; lateF: LateFiling[]; events: CorporateEvent[];
}): ScorecardResult {
  const Q = "quarterly" as const;
  const rev   = seriesFor(d.facts, "income",   Q, METRICS.revenue);
  const ni    = seriesFor(d.facts, "income",   Q, METRICS.netIncome);
  const cash  = seriesFor(d.facts, "balance",  Q, METRICS.cash);
  const debt  = seriesFor(d.facts, "balance",  Q, METRICS.longTermDebt);
  const ocf   = seriesFor(d.facts, "cashflow", Q, METRICS.operatingCF);
  const capex = seriesFor(d.facts, "cashflow", Q, METRICS.capex);
  const last = (p: { value: number }[]) => (p.length ? p[p.length - 1].value : null);
  const back = (p: { value: number }[], n: number) => (p.length > n ? p[p.length - 1 - n].value : null);

  const dims: ScoreDim[] = [];

  // Revenue growth (YoY)
  {
    const cur = last(rev), yago = back(rev, 4);
    if (cur != null && yago) {
      const g = ((cur - yago) / Math.abs(yago)) * 100;
      dims.push({
        label: "Revenue Growth", term: "YoY",
        grade: g >= 15 ? "strong" : g >= 5 ? "good" : g >= 0 ? "mixed" : "weak",
        detail: `${fmtDelta(g)} year-over-year`,
      });
    } else dims.push({ label: "Revenue Growth", grade: "na", detail: "Not enough history", term: "YoY" });
  }

  // Profitability (net margin)
  {
    const r = last(rev), n = last(ni);
    if (r && n != null) {
      const m = (n / r) * 100;
      dims.push({
        label: "Profitability", term: "Net Margin",
        grade: m >= 15 ? "strong" : m >= 5 ? "good" : m > 0 ? "mixed" : "weak",
        detail: `${fmtPct(m)} net margin`,
      });
    } else dims.push({ label: "Profitability", grade: "na", detail: "No earnings data", term: "Net Margin" });
  }

  // Balance sheet (cash vs long-term debt)
  {
    const c = last(cash);
    if (c != null) {
      const dbt = last(debt) ?? 0;
      const ratio = dbt > 0 ? c / dbt : Infinity;
      dims.push({
        label: "Balance Sheet", term: "Long-Term Debt",
        grade: ratio >= 1.5 ? "strong" : ratio >= 0.8 ? "good" : ratio >= 0.4 ? "mixed" : "weak",
        detail: dbt > 0 ? `${fmtUSD(c)} cash vs ${fmtUSD(dbt)} debt` : `${fmtUSD(c)} cash, minimal debt`,
      });
    } else dims.push({ label: "Balance Sheet", grade: "na", detail: "No balance-sheet data" });
  }

  // Cash generation (free cash flow)
  {
    const o = last(ocf);
    if (o != null) {
      const fcf = o - (last(capex) ?? 0);
      const prevO = back(ocf, 4), prevFcf = prevO != null ? prevO - (back(capex, 4) ?? 0) : null;
      const grade: Grade = fcf <= 0 ? "weak" : (prevFcf != null && fcf > prevFcf ? "strong" : "good");
      dims.push({ label: "Cash Generation", term: "Free Cash Flow", grade, detail: `${fmtUSD(fcf)} free cash flow` });
    } else dims.push({ label: "Cash Generation", grade: "na", detail: "No cash-flow data", term: "Free Cash Flow" });
  }

  // Insider sentiment (trailing 90 days) — open-market conviction only. Cluster
  // buying is the strongest tell; routine grants/options/tax sales don't count.
  {
    const ins = analyzeInsider(d.insider, 90);
    if (ins.clusterBuy) {
      dims.push({ label: "Insider Sentiment", term: "Cluster buying", grade: "strong",
        detail: `Cluster buy — ${ins.distinctBuyers} insiders bought ${fmtUSD(ins.buyValue)} open-market` });
    } else if (ins.anyOpenMarket) {
      const net = ins.netOpenMarket;
      dims.push({ label: "Insider Sentiment", term: "Open-market buy",
        grade: net > 0 ? "good" : net < 0 ? "weak" : "mixed",
        detail: net >= 0 ? `Net open-market buying (${fmtUSD(net, { sign: true })})` : `Net open-market selling (${fmtUSD(net, { sign: true })})` });
    } else if (ins.routineValue > 0) {
      dims.push({ label: "Insider Sentiment", term: "Insider", grade: "mixed",
        detail: "Routine grants / options only — no open-market trades" });
    } else {
      dims.push({ label: "Insider Sentiment", grade: "na", detail: "No recent insider trades", term: "Insider" });
    }
  }

  // Risk flags (late filings, restatements, dilution)
  {
    const restate = d.events.some((e) => e.event_class === "restatement");
    const yr = Date.now() - 365 * 86_400_000;
    const recentOffers = d.offers.filter((o) => o.filed_at && new Date(o.filed_at).getTime() > yr);
    const grade: Grade = (d.lateF.length || restate) ? "weak" : recentOffers.length ? "mixed" : "strong";
    const detail = d.lateF.length ? "Late-filing notice on record"
      : restate ? "Financial restatement on record"
      : recentOffers.length ? `${recentOffers.length} securities offering${recentOffers.length > 1 ? "s" : ""} (dilution)`
      : "No red flags detected";
    dims.push({ label: "Risk Flags", grade, detail, term: "NT 10-K" });
  }

  // Overall = average of graded dimensions.
  const graded = dims.filter((x) => x.grade !== "na");
  const avg = graded.length ? graded.reduce((s, x) => s + GRADE_RANK[x.grade], 0) / graded.length : 0;
  const overall: Grade = !graded.length ? "na" : avg >= 1.1 ? "strong" : avg >= 0.3 ? "good" : avg >= -0.6 ? "mixed" : "weak";

  // Plain-English summary.
  const wins = dims.filter((x) => x.grade === "strong" || x.grade === "good").map((x) => x.label.toLowerCase());
  const worries = dims.filter((x) => x.grade === "weak" || x.grade === "mixed");
  const verdict = { strong: "looks financially healthy", good: "is in reasonable shape", mixed: "is a mixed picture", weak: "shows signs of strain", na: "can't be assessed yet" }[overall];
  let summary = `On the numbers it has reported, this company ${verdict}.`;
  if (wins.length) summary += ` Strengths: ${wins.slice(0, 3).join(", ")}.`;
  if (worries.length) summary += ` Watch: ${worries.map((w) => `${w.label.toLowerCase()} (${w.detail.toLowerCase()})`).slice(0, 2).join("; ")}.`;
  summary += " Not investment advice — a read of the filings, not the share price.";

  return { dims, overall, summary };
}
