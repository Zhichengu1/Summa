// Pure transforms over the tidy financial_facts rows: pivot into a statement
// matrix, and derive named time series for the charts. No I/O here.
import type { FinancialFact, StatementKind, PeriodType } from "./types";

export type StatementMatrix = {
  periods: string[]; // period_end ISO, most-recent first
  rows: { label: string; concept: string; std: string | null; values: (number | null)[] }[];
};

/** Pivot facts of one statement + period type into line-items × periods. */
export function pivotStatement(
  facts: FinancialFact[],
  statement: StatementKind,
  periodType: PeriodType,
): StatementMatrix {
  const subset = facts.filter((f) => f.statement === statement && f.period_type === periodType);
  const periods = Array.from(new Set(subset.map((f) => f.period_end)))
    .sort((a, b) => b.localeCompare(a));

  const seen = new Map<string, { label: string; std: string | null; order: number }>();
  for (const f of subset) {
    if (!seen.has(f.concept)) {
      seen.set(f.concept, { label: f.label, std: f.standard_concept, order: f.display_order ?? 9999 });
    }
  }
  const lookup = new Map<string, number>();
  for (const f of subset) {
    if (f.value != null) lookup.set(`${f.concept}|${f.period_end}`, f.value);
  }

  const rows = Array.from(seen.entries())
    .sort((a, b) => a[1].order - b[1].order)
    .map(([concept, meta]) => ({
      label: meta.label,
      concept,
      std: meta.std,
      values: periods.map((p) => lookup.get(`${concept}|${p}`) ?? null),
    }));

  return { periods, rows };
}

export type Point = { period: string; value: number };

// ─── Metric matchers ──────────────────────────────────────────────────────────
//
// edgartools' MultiFinancials populates two relevant columns:
//   • concept          — raw GAAP, always `us-gaap_<Name>` (reliable, exact)
//   • standard_concept — edgartools' OWN normalized taxonomy (e.g. "Revenue",
//                        "CashAndMarketableSecurities", "AllEquityBalance",
//                        "CapitalExpenses"). NOT the GAAP name.
//
// A matcher succeeds if standard_concept is one of the verified edgartools
// names OR the raw concept matches an ANCHORED `^us-gaap_X$` pattern. Anchoring
// is essential: an un-anchored /StockholdersEquity/ also matches
// `us-gaap_LiabilitiesAndStockholdersEquity` (the grand total), and
// /LongTermDebt/ matches both the noncurrent and current portions.

export function isMetric(
  stds: string | string[],
  conceptPattern: RegExp,
): (f: FinancialFact) => boolean {
  const set = new Set(Array.isArray(stds) ? stds : [stds]);
  return (f) =>
    (f.standard_concept != null && set.has(f.standard_concept)) ||
    conceptPattern.test(f.concept);
}

export const isStd = (s: string) => (f: FinancialFact) => f.standard_concept === s;

export const METRICS = {
  // Income statement
  revenue:          isMetric(["Revenue"],            /^us-gaap_(Revenues|RevenueFromContractWithCustomer\w*|SalesRevenueNet|SalesRevenueGoodsNet|RevenueNet|TotalRevenues|RevenuesNetOfInterestExpense)$/),
  costOfRevenue:    isMetric(["CostOfRevenue"],      /^us-gaap_CostOf(GoodsAndServicesSold|GoodsSold|Revenue|Sales)$/),
  grossProfit:      isMetric(["GrossProfit"],        /^us-gaap_GrossProfit$/),
  rAndD:            isMetric(["ResearchAndDevelopmentExpenses"], /^us-gaap_ResearchAndDevelopmentExpense(ExcludingAcquiredInProcessCost)?$/),
  sgAndA:           isMetric(["SellingGeneralAndAdminExpenses", "GeneralAndAdminExpenses"], /^us-gaap_(SellingGeneralAndAdministrativeExpense|GeneralAndAdministrativeExpense|SellingAndMarketingExpense)$/),
  operatingIncome:  isMetric(["OperatingIncome"],    /^us-gaap_OperatingIncomeLoss$/),
  netIncome:        isMetric(["NetIncome"],          /^us-gaap_(NetIncomeLoss|ProfitLoss)$/),
  epsDiluted:       isMetric(["EarningsPerShareDiluted"], /^us-gaap_(EarningsPerShareDiluted|IncomeLossFromContinuingOperationsPerDilutedShare)$/),
  epsBasic:         isMetric(["EarningsPerShareBasic"],   /^us-gaap_EarningsPerShareBasic$/),
  sharesOutstanding:isMetric(["SharesFullyDilutedAverage"], /^us-gaap_WeightedAverageNumberOfDilutedSharesOutstanding$/),

  // Balance sheet
  cash:               isMetric(["CashAndMarketableSecurities", "CashAndEquivalents"], /^us-gaap_CashAndCashEquivalentsAtCarryingValue$/),
  // Prefix-agnostic: some issuers (e.g. TSLA) file extension concepts like
  // `tsla_LongTermDebtAndFinanceLeasesNoncurrent`. Anchor on `…Noncurrent$` to
  // exclude the current portion.
  longTermDebt:       isMetric(["LongTermDebt"],          /_LongTermDebt\w*Noncurrent$/),
  totalAssets:        isMetric(["Assets"],                /^us-gaap_Assets$/),
  totalLiabilities:   isMetric(["Liabilities"],           /^us-gaap_Liabilities$/),
  equity:             isMetric(["AllEquityBalance", "StockholdersEquity"], /^us-gaap_StockholdersEquity$/),
  currentAssets:      isMetric(["CurrentAssetsTotal"],    /^us-gaap_AssetsCurrent$/),
  currentLiabilities: isMetric(["CurrentLiabilitiesTotal"], /^us-gaap_LiabilitiesCurrent$/),

  // Cash flow
  operatingCF:      isMetric(["NetCashFromOperatingActivities"], /^us-gaap_NetCashProvidedByUsedInOperatingActivities(ContinuingOperations)?$/),
  investingCF:      isMetric(["NetCashFromInvestingActivities"], /^us-gaap_NetCashProvidedByUsedInInvestingActivities(ContinuingOperations)?$/),
  financingCF:      isMetric(["NetCashFromFinancingActivities"], /^us-gaap_NetCashProvidedByUsedInFinancingActivities(ContinuingOperations)?$/),
  capex:            isMetric(["CapitalExpenses"],         /^us-gaap_PaymentsToAcquirePropertyPlantAndEquipment$/),
  depreciation:     isMetric(["DepreciationExpense"],     /^us-gaap_DepreciationDepletionAndAmortization$/),
} as const;

/** Time series (ascending) for the first concept matching `match`. */
export function seriesFor(
  facts: FinancialFact[],
  statement: StatementKind,
  periodType: PeriodType,
  match: (f: FinancialFact) => boolean,
): Point[] {
  const subset = facts.filter(
    (f) => f.statement === statement && f.period_type === periodType && f.value != null && match(f),
  );
  const byConcept = new Map<string, Point[]>();
  for (const f of subset) {
    const arr = byConcept.get(f.concept) ?? [];
    arr.push({ period: f.period_end, value: f.value as number });
    byConcept.set(f.concept, arr);
  }
  let best: Point[] = [];
  for (const arr of byConcept.values()) if (arr.length > best.length) best = arr;
  return best.sort((a, b) => a.period.localeCompare(b.period));
}

export type Point2 = { period: string; value: number; concept: string };

/** Like seriesFor but returns the top-2 concepts (for comparing close variants). */
export function topSeriesFor(
  facts: FinancialFact[],
  statement: StatementKind,
  periodType: PeriodType,
  match: (f: FinancialFact) => boolean,
  topN = 1,
): Point[][] {
  const subset = facts.filter(
    (f) => f.statement === statement && f.period_type === periodType && f.value != null && match(f),
  );
  const byConcept = new Map<string, Point[]>();
  for (const f of subset) {
    const arr = byConcept.get(f.concept) ?? [];
    arr.push({ period: f.period_end, value: f.value as number });
    byConcept.set(f.concept, arr);
  }
  return Array.from(byConcept.values())
    .sort((a, b) => b.length - a.length)
    .slice(0, topN)
    .map((arr) => arr.sort((a, b) => a.period.localeCompare(b.period)));
}

export type Period = { period: string; value: number };

/** Year-over-year growth series aligned to a value series. */
export function yoyGrowth(points: Point[], lag = 1): (number | null)[] {
  return points.map((p, i) => {
    const prev = points[i - lag];
    if (!prev || prev.value === 0) return null;
    return ((p.value - prev.value) / Math.abs(prev.value)) * 100;
  });
}

/** Quarter-over-quarter growth. */
export function qoqGrowth(points: Point[]): (number | null)[] {
  return points.map((p, i) => {
    const prev = points[i - 1];
    if (!prev || prev.value === 0) return null;
    return ((p.value - prev.value) / Math.abs(prev.value)) * 100;
  });
}

export type Kpi = { label: string; value: number | null; fmt: "usd" | "pct" | "num"; qoq: number | null; yoy: number | null };

function pctChange(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

/** Headline KPI tiles for the Fundamentals top strip. */
export function deriveKpis(facts: FinancialFact[], periodType: PeriodType): Kpi[] {
  const lag = periodType === "quarterly" ? 4 : 1;

  const rev  = seriesFor(facts, "income",  periodType, METRICS.revenue);
  const gp   = seriesFor(facts, "income",  periodType, METRICS.grossProfit);
  const oi   = seriesFor(facts, "income",  periodType, METRICS.operatingIncome);
  const ni   = seriesFor(facts, "income",  periodType, METRICS.netIncome);
  const eps  = seriesFor(facts, "income",  periodType, METRICS.epsDiluted);
  const cash = seriesFor(facts, "balance", periodType, METRICS.cash);

  const last = (p: Point[]) => (p.length ? p[p.length - 1].value : null);
  const back = (p: Point[], n: number) => (p.length > n ? p[p.length - 1 - n].value : null);

  const grossMargin = (() => {
    const r = last(rev), g = last(gp);
    return r && g != null ? (g / r) * 100 : null;
  })();
  const grossMarginPrev = (() => {
    const r = back(rev, 1), g = back(gp, 1);
    return r && g != null ? (g / r) * 100 : null;
  })();
  const opMargin = (() => {
    const r = last(rev), o = last(oi);
    return r && o != null ? (o / r) * 100 : null;
  })();
  const opMarginPrev = (() => {
    const r = back(rev, 1), o = back(oi, 1);
    return r && o != null ? (o / r) * 100 : null;
  })();
  const netMargin = (() => {
    const r = last(rev), n = last(ni);
    return r && n != null ? (n / r) * 100 : null;
  })();
  const netMarginPrev = (() => {
    const r = back(rev, 1), n = back(ni, 1);
    return r && n != null ? (n / r) * 100 : null;
  })();

  const kpis: Kpi[] = [];

  if (last(rev) != null) kpis.push({
    label: "Revenue", value: last(rev), fmt: "usd",
    qoq: pctChange(last(rev), back(rev, 1)),
    yoy: pctChange(last(rev), back(rev, lag)),
  });

  if (grossMargin != null) kpis.push({
    label: "Gross Margin", value: grossMargin, fmt: "pct",
    qoq: grossMargin != null && grossMarginPrev != null ? grossMargin - grossMarginPrev : null,
    yoy: null,
  });

  if (opMargin != null) kpis.push({
    label: "Op. Margin", value: opMargin, fmt: "pct",
    qoq: opMargin != null && opMarginPrev != null ? opMargin - opMarginPrev : null,
    yoy: null,
  });

  if (netMargin != null) kpis.push({
    label: "Net Margin", value: netMargin, fmt: "pct",
    qoq: netMargin != null && netMarginPrev != null ? netMargin - netMarginPrev : null,
    yoy: null,
  });

  if (last(eps) != null) kpis.push({
    label: "Diluted EPS", value: last(eps), fmt: "num",
    qoq: pctChange(last(eps), back(eps, 1)),
    yoy: pctChange(last(eps), back(eps, lag)),
  });

  if (last(cash) != null) kpis.push({
    label: "Cash", value: last(cash), fmt: "usd",
    qoq: pctChange(last(cash), back(cash, 1)),
    yoy: pctChange(last(cash), back(cash, lag)),
  });

  return kpis;
}
