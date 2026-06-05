// Forward catalyst timing. SEC/EOD data has no forward calendar, so the next
// earnings date is *estimated* from the historical reporting cadence (the median
// gap between past reports). Always surfaced as an estimate, never a promise.

export type NextCatalyst = {
  estDate: string;   // ISO date (YYYY-MM-DD) of the estimated next report
  daysAway: number;  // calendar days from today (negative = overdue / window passed)
  medianGapDays: number;
};

const DAY = 86_400_000;

/**
 * Estimate the next earnings date from past report dates. Returns null unless the
 * cadence looks genuinely periodic (median gap 45–200 days, i.e. quarterly-ish),
 * so we never fabricate a date from noisy or sparse history.
 */
export function nextEarningsEstimate(
  reportedDates: (string | null | undefined)[],
): NextCatalyst | null {
  const ts = reportedDates
    .filter((x): x is string => !!x)
    .map((s) => new Date(s.slice(0, 10)).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (ts.length < 3) return null;

  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  gaps.sort((a, b) => a - b);
  const medGap = gaps[Math.floor(gaps.length / 2)];
  if (medGap < 45 * DAY || medGap > 200 * DAY) return null;  // not a clean quarterly cadence

  const est = ts[ts.length - 1] + medGap;
  return {
    estDate: new Date(est).toISOString().slice(0, 10),
    daysAway: Math.round((est - Date.now()) / DAY),
    medianGapDays: Math.round(medGap / DAY),
  };
}
