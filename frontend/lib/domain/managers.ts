// Pure 13F manager-portfolio logic for the Institutional Investors view: roll each
// tracked manager up to its latest reported quarter (with its buy/sell deltas), and
// aggregate latest-quarter holdings across institutions into the consensus / overlap
// read. No I/O and no JSX here — views/ManagersPage.tsx renders these results. Lives
// in lib/domain/ alongside scorecard.ts / pulse.ts so the cross-institution surfaces
// share one source of truth rather than re-deriving it in the view.
import type { ManagerPortfolio } from "../types";

// Curated label → display name. The backend stores the matcher key (uppercase);
// title-casing alone mangles a few, so spell the common ones out. Falls back to
// Title Case for anything not listed.
const MANAGER_LABEL: Record<string, string> = {
  "VANGUARD GROUP": "Vanguard Group",
  "BLACKROCK": "BlackRock",
  "STATE STREET CORP": "State Street",
  "FMR LLC": "Fidelity (FMR)",
  "JPMORGAN CHASE": "JPMorgan Chase",
  "PRICE T ROWE": "T. Rowe Price",
  "WELLINGTON MANAGEMENT GROUP": "Wellington Management",
  "GEODE CAPITAL MANAGEMENT": "Geode Capital",
  "NORTHERN TRUST CORP": "Northern Trust",
  "MORGAN STANLEY": "Morgan Stanley",
  "GOLDMAN SACHS GROUP": "Goldman Sachs",
  "INVESCO LTD": "Invesco",
  "DIMENSIONAL FUND ADVISORS": "Dimensional (DFA)",
  "BANK OF AMERICA CORP": "Bank of America",
  "BERKSHIRE HATHAWAY": "Berkshire Hathaway",
  "CITADEL ADVISORS": "Citadel Advisors",
  "FRANKLIN RESOURCES": "Franklin Templeton",
  "CHARLES SCHWAB INVESTMENT": "Charles Schwab",
  "ALLIANCEBERNSTEIN": "AllianceBernstein",
  "JANUS HENDERSON": "Janus Henderson",
  "BANK OF NEW YORK MELLON": "BNY Mellon",
  "WELLS FARGO": "Wells Fargo",
  "UBS GROUP": "UBS",
  "AMUNDI": "Amundi",
  "CAPITAL RESEARCH GLOBAL": "Capital Group · Research Global",
  "CAPITAL WORLD INVESTORS": "Capital Group · World Investors",
  "BLACKSTONE": "Blackstone",
  "BRIDGEWATER ASSOCIATES": "Bridgewater Associates",
  "RENAISSANCE TECHNOLOGIES": "Renaissance Technologies",
  "TWO SIGMA INVESTMENTS": "Two Sigma",
  "MILLENNIUM MANAGEMENT": "Millennium",
  "POINT72 ASSET MANAGEMENT": "Point72",
  "D. E. SHAW": "D. E. Shaw",
  "AQR CAPITAL": "AQR Capital",
  "ELLIOTT INVESTMENT": "Elliott Management",
  "PERSHING SQUARE CAPITAL": "Pershing Square",
  "TIGER GLOBAL": "Tiger Global",
  "COATUE": "Coatue",
  "VIKING GLOBAL": "Viking Global",
  "THIRD POINT": "Third Point",
  "ICAHN": "Icahn (Carl Icahn)",
  "SOROS FUND": "Soros Fund Management",
  "MARKEL": "Markel",
  "DODGE & COX": "Dodge & Cox",
  "HARRIS ASSOCIATES": "Harris Associates (Oakmark)",
  "BAILLIE GIFFORD": "Baillie Gifford",
  "FISHER ASSET": "Fisher Investments",
  "NORGES BANK": "Norges Bank (Norway)",
  "CANADA PENSION": "Canada Pension Plan",
  "GATES FOUNDATION": "Gates Foundation",
};

export function managerLabel(key: string): string {
  return MANAGER_LABEL[key]
    ?? key.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Buy/sell action sets — shared by the rollup, the consensus aggregation, and the
// view's buy/sell filters so all three classify a move the same way.
export const BUYS = new Set(["new", "added"]);
export const SELLS = new Set(["trimmed", "exited"]);

// $ magnitude of a sell, for ranking the heaviest reductions/exits.
export function sellSize(h: ManagerPortfolio): number {
  return Math.max(0, (h.prior_value ?? 0) - (h.value ?? 0));
}

// $ magnitude of a position's quarter-over-quarter swing (|now − was|), used to
// rank the comparison so the biggest changes — bought or sold — surface first.
export function swingSize(h: ManagerPortfolio): number {
  return Math.abs((h.value ?? 0) - (h.prior_value ?? 0));
}

// One manager rolled up to its most recent reported quarter.
export type ManagerRollup = {
  managerCik: string;
  name: string;
  period: string;
  priorPeriod: string | null;     // the quarter the latest 13F is compared against
  holdings: ManagerPortfolio[];   // top-N positions, largest first (excl. exits)
  priorHoldings: ManagerPortfolio[]; // the prior quarter's top-N longs (for threshold-crossing)
  exits: ManagerPortfolio[];      // positions sold out of the top book this quarter
  aum: number | null;             // full 13F equity value, recovered from value / pct
  hasMoves: boolean;              // whether buy/sell deltas are available yet
  topBuy: ManagerPortfolio | null;
  topSell: ManagerPortfolio | null;
  accession: string | null;       // source 13F-HR accession (for the EDGAR link)
  filedAt: string | null;         // when the latest quarter's 13F was filed
  priorFiledAt: string | null;    // when the prior quarter's 13F was filed (if on file)
};

export function rollup(rows: ManagerPortfolio[]): ManagerRollup[] {
  const byMgr = new Map<string, ManagerPortfolio[]>();
  for (const r of rows) {
    const arr = byMgr.get(r.manager_cik);
    if (arr) arr.push(r); else byMgr.set(r.manager_cik, [r]);
  }

  const out: ManagerRollup[] = [];
  for (const [managerCik, all] of byMgr) {
    // Keep only the most recent quarter we have for this manager. The prior
    // period (second-most-recent distinct quarter actually on file) is the real
    // basis for the buy/sell deltas the backend baked into the latest rows, so we
    // read it from the data rather than estimating a quarter back. period_of_report
    // is YYYY-MM-DD, so a lexical sort is chronological.
    const periods = [...new Set(all.map((r) => r.period_of_report))].sort().reverse();
    const period = periods[0];
    const priorPeriod = periods[1] ?? null;
    // The prior quarter's rows, scanned once and reused for both the holder set and
    // the filing-date lookup below (mirrors how `quarter` feeds holdings/exits/src).
    const prior = priorPeriod ? all.filter((r) => r.period_of_report === priorPeriod) : [];
    const quarter = all.filter((r) => r.period_of_report === period);
    const holdings = quarter
      .filter((r) => r.action !== "exited")
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const exits = quarter
      .filter((r) => r.action === "exited")
      .sort((a, b) => sellSize(b) - sellSize(a));
    // The prior quarter's actual longs (top-N as filed then), so the emerging lens
    // compares true holder counts quarter-over-quarter instead of inferring "held
    // before" from this quarter's move labels. Excludes that quarter's own exits.
    const priorHoldings = prior.filter((r) => r.action !== "exited" && (r.shares ?? 0) > 0);

    // The stored pct is value / full-portfolio-total, so we can recover the
    // manager's full 13F equity AUM (top-N is only a slice of it).
    const ref = holdings.find((h) => h.value != null && h.pct_of_portfolio);
    const aum = ref ? (ref.value as number) / ((ref.pct_of_portfolio as number) / 100) : null;

    const hasMoves = quarter.some((h) => h.action);
    const topBuy = holdings
      .filter((h) => h.action && BUYS.has(h.action))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0] ?? null;
    const topSell = [...holdings, ...exits]
      .filter((h) => h.action && SELLS.has(h.action))
      .sort((a, b) => sellSize(b) - sellSize(a))[0] ?? null;

    const src = quarter.find((r) => r.accession_number) ?? quarter[0];
    const priorSrc = prior.find((r) => r.filed_at) ?? null;
    out.push({
      managerCik, name: managerLabel(quarter[0].manager_name), period, priorPeriod,
      holdings, priorHoldings, exits, aum, hasMoves, topBuy, topSell,
      accession: src.accession_number, filedAt: src.filed_at,
      priorFiledAt: priorSrc?.filed_at ?? null,
    });
  }
  return out.sort((a, b) => (b.aum ?? 0) - (a.aum ?? 0));
}

// ── Cross-institution overlap ────────────────────────────────────────────────
// One investor's stake in a shared security, for the consensus/overlap table.
export type ConsensusHolder = {
  managerCik: string;
  name: string;
  value: number | null;
  pct: number | null;
  action: ManagerPortfolio["action"];
  filedAt: string | null;        // when this manager's 13F reporting the position was filed
};
// One security rolled up across every institution that holds it (latest quarter).
export type ConsensusRow = {
  cusip: string;
  ticker: string | null;
  issuer: string | null;
  holders: ConsensusHolder[];
  holderCount: number;   // how many tracked institutions hold it (the consensus)
  totalValue: number;    // combined position value across those institutions
  buying: number;        // holders who added/opened this quarter
  selling: number;       // holders who trimmed/exited this quarter
  newHolders: number;    // current holders that did NOT hold it last quarter (fresh buyers)
  exitedHolders: number; // managers that held it last quarter but no longer do (sold out of top book)
  priorHolders: number;  // distinct managers that held it last quarter (true count)
  latestFiledAt: string | null;  // most recent 13F filing date across its holders (freshness)
  latestPeriod: string | null;   // most recent quarter-end reported across its holders
  latestBuyAt: string | null;    // most recent filing date among the fresh BUYERS (newly opened)
};

// Result of the overlap aggregation: the per-security rows plus whether any prior
// quarter exists at all (drives whether the emerging lens can be computed).
export type Consensus = { rows: ConsensusRow[]; hasPrior: boolean };

// Aggregate each manager's latest-quarter top holdings by security (CUSIP), so we
// can see which stocks the institutions hold in common. Built from the rollup, so
// it reuses the same latest-quarter selection the rest of the view uses.
//
// For the emerging lens we also need each security's PRIOR-quarter holder count.
// We take it from the actual prior-quarter holdings (per manager) rather than
// inferring it from this quarter's move labels — that counts managers who have
// since exited too, so "held by N last quarter" is a true count and the
// threshold-crossing test is exact and works no matter how the move labels land.
export function buildConsensus(managers: ManagerRollup[]): Consensus {
  // Prior-quarter holder set per security: which managers held it last quarter.
  const priorByCusip = new Map<string, Set<string>>();
  let hasPrior = false;
  for (const m of managers) {
    if (m.priorHoldings.length) hasPrior = true;
    for (const h of m.priorHoldings) {
      let s = priorByCusip.get(h.cusip);
      if (!s) priorByCusip.set(h.cusip, (s = new Set()));
      s.add(m.managerCik);
    }
  }

  const byCusip = new Map<string, ConsensusRow>();
  for (const m of managers) {
    for (const h of m.holdings) {            // top-N latest-quarter longs (excl. exits)
      let row = byCusip.get(h.cusip);
      if (!row) {
        row = { cusip: h.cusip, ticker: h.ticker, issuer: h.issuer, holders: [],
                holderCount: 0, totalValue: 0, buying: 0, selling: 0,
                newHolders: 0, exitedHolders: 0, priorHolders: 0,
                latestFiledAt: null, latestPeriod: null, latestBuyAt: null };
        byCusip.set(h.cusip, row);
      }
      row.holders.push({
        managerCik: m.managerCik, name: m.name, value: h.value, pct: h.pct_of_portfolio,
        action: h.action, filedAt: h.filed_at,
      });
      row.holderCount += 1;
      row.totalValue += h.value ?? 0;
      if (h.action && BUYS.has(h.action)) row.buying += 1;
      if (h.action && SELLS.has(h.action)) row.selling += 1;
      if (!row.ticker && h.ticker) row.ticker = h.ticker;
      if (!row.issuer && h.issuer) row.issuer = h.issuer;
      // Freshness: the most recent quarter-end / filing date this name appears under,
      // so the emerging lens can rank by how recently it was reported (ISO strings
      // sort lexically, so plain `>` gives the latest).
      if (h.period_of_report && (!row.latestPeriod || h.period_of_report > row.latestPeriod)) row.latestPeriod = h.period_of_report;
      if (h.filed_at && (!row.latestFiledAt || h.filed_at > row.latestFiledAt)) row.latestFiledAt = h.filed_at;
    }
  }

  // Resolve prior/new/exited holder counts + the freshest BUY date from the true
  // prior set. The three reconcile exactly: now = prior − exited + new (prior holders
  // are NOT a subset of current holders — some sold out — so `now − prior` alone is a
  // net figure, not the count of fresh buyers).
  for (const row of byCusip.values()) {
    const priorSet = priorByCusip.get(row.cusip);
    row.priorHolders = priorSet ? priorSet.size : 0;
    // Fresh buyers: current holders that did NOT hold it last quarter.
    const buyers = row.holders.filter((h) => !priorSet || !priorSet.has(h.managerCik));
    row.newHolders = buyers.length;
    // Exited: managers that held it last quarter but aren't among the current holders.
    const currentSet = new Set(row.holders.map((h) => h.managerCik));
    row.exitedHolders = priorSet
      ? [...priorSet].filter((cik) => !currentSet.has(cik)).length
      : 0;
    // When the position was most recently OPENED by a fresh buyer — the truest
    // "latest bought" date for the emerging lens (falls back to overall latest).
    row.latestBuyAt = buyers.reduce<string | null>(
      (mx, h) => (h.filedAt && (!mx || h.filedAt > mx) ? h.filedAt : mx), null,
    ) ?? row.latestFiledAt;
  }
  return { rows: [...byCusip.values()], hasPrior };
}
