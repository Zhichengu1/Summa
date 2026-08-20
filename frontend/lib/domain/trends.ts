// Trend Intelligence — pure logic over `theme_trends` rows (fetchThemeTrends).
//
// The backend already did the scoring; this module's job is to turn the flat
// (theme × quarter) rows into what the view actually renders: one entry per
// theme pinned to the latest published quarter, carrying its own history, plus
// the market-wide rollups (capital by sector, the single "next trend" pick).
//
// The read the view is built around:
//   BREADTH  — how many tracked companies cite a theme. Cheap to say.
//   CAPITAL  — attributed R&D + capex behind it. Expensive, so it's commitment.
// Breadth rising with no capital is a narrative; both rising is a buildout. The
// two are always shown side by side rather than blended into one number, and
// `momentum_score` is offered as a ranking, not a verdict.
//
// Coverage honesty: the watchlist is not the market. `coverage` is the number
// of companies that reported ANY theme that quarter, and every share is stated
// against it — "12 of 18 tracked companies", never "67% of the market".
import type { ThemeDriver, ThemeStage, ThemeTrend } from "../types";

export type TrendRow = {
  key: string;
  label: string;
  category: string;
  categoryLabel: string;
  period: string;
  quarter: string;              // 'Q2 2026'
  companyCount: number;
  coverage: number;
  adoption: number;             // companyCount / coverage, 0..1
  breadthDelta: number;
  breadthGrowth: number;        // %
  capitalFlow: number;          // USD
  capitalGrowth: number | null; // %
  momentum: number;             // 0-100
  stage: ThemeStage;
  sector: string | null;
  sectorFlow: Record<string, number>;
  drivers: ThemeDriver[];
  thin: boolean;
  summary: string;
  breadthSeries: number[];      // companyCount by quarter, oldest → newest
  capitalSeries: number[];      // capitalFlow by quarter, oldest → newest
  periods: string[];            // matching quarter ends
  isNew: boolean;               // absent from the prior quarter entirely
};

export const TREND_CATEGORIES: { key: string; label: string }[] = [
  { key: "ai", label: "AI & Compute" },
  { key: "cloud", label: "Cloud & Software" },
  { key: "hardware", label: "Silicon & Hardware" },
  { key: "energy", label: "Energy & Climate" },
  { key: "health", label: "Health & Bio" },
  { key: "industrial", label: "Industrial & Supply" },
  { key: "consumer", label: "Consumer & Commerce" },
  { key: "finance", label: "Finance & Capital" },
];

const CATEGORY_LABEL = new Map(TREND_CATEGORIES.map((c) => [c.key, c.label]));

export const STAGE_ORDER: ThemeStage[] = ["emerging", "accelerating", "mainstream", "cooling"];

/** 'Q2 2026' from a calendar quarter-end ISO date. */
export function quarterLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return `Q${Math.ceil(m / 3)} ${y}`;
}

/** The newest quarter present in the rows ('' when there are none). */
export function latestPeriod(rows: ThemeTrend[]): string {
  return rows.reduce((max, r) => (r.period > max ? r.period : max), "");
}

/**
 * Collapse the flat rows into one entry per theme, pinned to `period` (default:
 * the latest quarter), each carrying its full history. Themes with no row in
 * that quarter are dropped — they had nothing to say, which is itself the
 * signal, and a stale carry-forward would misrepresent it.
 */
export function buildTrends(rows: ThemeTrend[], period?: string): TrendRow[] {
  const target = period || latestPeriod(rows);
  if (!target) return [];

  const byTheme = new Map<string, ThemeTrend[]>();
  for (const r of rows) {
    const arr = byTheme.get(r.theme_key) ?? [];
    arr.push(r);
    byTheme.set(r.theme_key, arr);
  }

  const out: TrendRow[] = [];
  for (const [key, all] of byTheme) {
    const history = [...all].sort((a, b) => a.period.localeCompare(b.period));
    const upTo = history.filter((r) => r.period <= target);
    const current = upTo[upTo.length - 1];
    if (!current || current.period !== target) continue;

    const coverage = current.coverage ?? 0;
    const companyCount = current.company_count ?? 0;
    const category = current.category ?? "other";
    out.push({
      key,
      label: current.label ?? key,
      category,
      categoryLabel: CATEGORY_LABEL.get(category) ?? "Other",
      period: current.period,
      quarter: quarterLabel(current.period),
      companyCount,
      coverage,
      adoption: coverage > 0 ? companyCount / coverage : 0,
      breadthDelta: current.breadth_delta ?? 0,
      breadthGrowth: current.breadth_growth ?? 0,
      capitalFlow: current.capital_flow ?? 0,
      capitalGrowth: current.capital_growth,
      momentum: current.momentum_score ?? 0,
      stage: current.stage ?? "emerging",
      sector: current.sector,
      sectorFlow: current.sector_flow ?? {},
      drivers: current.drivers ?? [],
      thin: current.thin ?? false,
      summary: current.summary ?? "",
      breadthSeries: upTo.map((r) => r.company_count ?? 0),
      capitalSeries: upTo.map((r) => r.capital_flow ?? 0),
      periods: upTo.map((r) => r.period),
      // breadth_delta equal to the whole company count means nobody cited the
      // theme last quarter — it appeared, rather than merely grew. The backend
      // computes the delta against an unpublished baseline quarter, so this
      // holds for the first published quarter too.
      isNew: companyCount > 0 && (current.breadth_delta ?? 0) === companyCount,
    });
  }
  return out.sort((a, b) => b.momentum - a.momentum);
}

/**
 * The "next trend" pick: highest momentum among themes that are still early
 * (not yet mainstream) AND have real dollars behind them. Requiring capital is
 * what separates a trend from a talking point — without it the pick would just
 * be whichever niche phrase two companies happened to repeat.
 */
export function nextTrend(trends: TrendRow[]): TrendRow | null {
  const candidates = trends.filter(
    (t) => (t.stage === "emerging" || t.stage === "accelerating") &&
           t.capitalFlow > 0 && t.companyCount >= 2 && !t.thin,
  );
  return candidates.length ? candidates[0] : null;
}

/** Attributed capital by sector across the shown themes, largest first. */
export function capitalBySector(trends: TrendRow[]): { sector: string; capital: number }[] {
  const totals = new Map<string, number>();
  for (const t of trends) {
    for (const [sector, capital] of Object.entries(t.sectorFlow)) {
      totals.set(sector, (totals.get(sector) ?? 0) + capital);
    }
  }
  return [...totals.entries()]
    .map(([sector, capital]) => ({ sector, capital }))
    .sort((a, b) => b.capital - a.capital);
}

/** Every published quarter, oldest → newest (drives the period selector). */
export function availablePeriods(rows: ThemeTrend[]): string[] {
  return [...new Set(rows.map((r) => r.period))].sort();
}

/**
 * How much of the tracked universe is behind these numbers, for the coverage
 * caveat in the header. Coverage is uniform across a quarter's rows, so any
 * row's value is the quarter's.
 */
export function coverageFor(trends: TrendRow[]): number {
  return trends.reduce((max, t) => Math.max(max, t.coverage), 0);
}
