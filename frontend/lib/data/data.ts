// Data access layer — the only place that talks to Supabase.
import { supabase } from "./supabase";
import { CORE_WATCHLIST } from "./watchlist";
import type {
  Company, FinancialFact, Filing,
  InsiderTransaction, InstitutionalHolding, ManagerPortfolio,
  CorporateEvent, EarningsEvent, LateFiling, SecuritiesOffering,
  BeneficialOwnership, ProposedSale, DailyPrice,
  CompanyProfileRow, CompanyThemeRow, EntityRow, CompanySummary,
} from "../types";

// Whole-table read, paged in 1000-row chunks. Any "fetch every row" query must use
// this — a bare .select() caps at PostgREST's default row limit and silently drops
// rows as the watchlist grows (companies > ~1000, themes > ~250). Returns [] on error.
async function selectAllPaged<T>(
  table: string, columns: string, order?: { col: string; asc?: boolean },
  gte?: { col: string; value: string },
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    let q = supabase.from(table).select(columns).range(start, start + PAGE - 1);
    if (gte) q = q.gte(gte.col, gte.value);
    if (order) q = q.order(order.col, { ascending: order.asc ?? true });
    const { data, error } = await q;
    if (error || !data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

// One small precomputed row per company (company_summary), paged so the read scales
// to any watchlist size. Replaces fetching every company's full price history
// client-side (which capped out ~80 companies). Returns [] so callers fall back.
export async function fetchCompanySummaries(): Promise<CompanySummary[]> {
  return selectAllPaged<CompanySummary>(
    "company_summary",
    "cik, ticker, last_close, as_of, chg_1d, ret_ytd, pct_off_high, rsi14, pct_from_50, pct_from_200, ma_cross, vol_spike, new_52w_high, new_52w_low, spark, filings_30d, last_filing_form, last_filing_at, net_insider_90d, cluster_buy",
  );
}

export async function fetchCompanies(): Promise<Company[]> {
  const data = await selectAllPaged<Company>(
    "companies", "cik, ticker, name, sector, industry", { col: "ticker" },
  );
  if (data.length === 0) {
    return CORE_WATCHLIST.map((c) => ({
      cik: c.cik, ticker: c.ticker, name: c.name, sector: null, industry: null,
    }));
  }
  return data;
}

export async function fetchFilings(limit = 200): Promise<Filing[]> {
  const { data, error } = await supabase
    .from("filings")
    .select("accession_number, cik, ticker, company_name, form_type, filed_at, period_of_report, filing_url")
    .order("filed_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as Filing[];
}

export async function fetchFilingsForCik(cik: string, limit = 50): Promise<Filing[]> {
  const { data, error } = await supabase
    .from("filings")
    .select("accession_number, cik, ticker, company_name, form_type, filed_at, period_of_report, filing_url")
    .eq("cik", cik)
    .order("filed_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as Filing[];
}

export async function fetchFinancialFacts(cik: string): Promise<FinancialFact[]> {
  const { data, error } = await supabase
    .from("financial_facts")
    .select("cik, ticker, statement, label, concept, standard_concept, period_end, period_type, fiscal_year, value, display_order")
    .eq("cik", cik);
  if (error || !data) return [];
  return data as FinancialFact[];
}

export async function fetchInsiderTransactions(cik: string): Promise<InsiderTransaction[]> {
  const { data, error } = await supabase
    .from("insider_transactions")
    .select("cik, ticker, accession_number, filer_name, filer_title, transaction_date, transaction_code, acquired_disposed, shares, price, value, shares_after, is_10b5_1, filing_url, filed_at")
    .eq("cik", cik)
    .order("transaction_date", { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return data as InsiderTransaction[];
}

// Who holds THIS company (institutional_holdings), scoped to the single latest
// reported quarter. We bound the read to the recent ~2-quarter window, then keep
// only rows from the most-recent period present — so the view shows the current
// holder snapshot, not the table's full accumulated history.
export async function fetchInstitutionalHoldings(cik: string): Promise<InstitutionalHolding[]> {
  const { data, error } = await supabase
    .from("institutional_holdings")
    .select("cik, ticker, period_of_report, manager_name, manager_cik, accession_number, shares, value, pct_of_portfolio, filed_at")
    .eq("cik", cik)
    .gte("period_of_report", managerSince())
    .order("period_of_report", { ascending: false });
  if (error || !data || data.length === 0) return [];
  const latest = (data as InstitutionalHolding[])[0].period_of_report;
  return (data as InstitutionalHolding[]).filter((h) => h.period_of_report === latest);
}

// 13F is a quarterly filing, filed up to 45 days after quarter-end, so the only
// meaningful "latest" window is the most recent quarter-end(s) — not a 30-day window
// (which would be empty for most of the quarter). Each current-quarter row already
// carries its move vs the prior quarter (action / share_change / prior_* are
// precomputed at ingest), so the view does NOT need the prior quarter's rows — only
// each manager's latest. Even a late filer's latest period is ≤ ~226 days old right
// before the next deadline, so 280 days robustly captures every active manager's
// newest quarter (and usually the one before it, for an exact comparison label)
// while fetching ~1–2 quarters instead of 4 — fewer paged round trips, lower latency.
const MANAGER_LOOKBACK_DAYS = 280;
function managerSince(): string {
  return new Date(Date.now() - MANAGER_LOOKBACK_DAYS * 86400_000)
    .toISOString().slice(0, 10);
}

// The Managers view's emerging-consensus lens compares each manager's LATEST 13F
// against its PRIOR one, so its fetch must ALWAYS include at least the two most
// recent quarters — not "usually," forever as quarters roll. The 280-day window
// above can miss the prior quarter in the worst timing case: a late filer whose
// latest period is ~226 days old has a prior quarter ~318 days back, beyond 280.
// 400 days (~4–5 quarters) clears that margin in every case, so the comparison
// never silently loses the prior quarter over time. Still small + paged + cached.
const MANAGER_PORTFOLIO_LOOKBACK_DAYS = 400;
function managerPortfolioSince(): string {
  return new Date(Date.now() - MANAGER_PORTFOLIO_LOOKBACK_DAYS * 86400_000)
    .toISOString().slice(0, 10);
}

// Every tracked manager's top holdings across ALL stocks (manager_portfolios).
// Small, slowly-changing (~top-N x managers x quarter), so it's read once and
// grouped client-side — same read-budget discipline as the reference tables.
// Powers the Managers view ("what does Vanguard / BlackRock actually invest in").
//
// The leaderboard shows each manager's LATEST quarter (deltas pre-baked), while the
// emerging-consensus lens additionally diffs it against the manager's PRIOR quarter.
// So we fetch the most recent two-or-more quarter-ends (MANAGER_PORTFOLIO_LOOKBACK_DAYS,
// sized to always include the prior quarter), not the table's full history; rollup()
// then keeps each manager's newest as "now" and the one before it as "prior."
//
// manager_portfolios is slowly-changing (refreshed once per quarter), so the read is
// memoized for the session: the first Institutional Investors visit pays the paged
// fetch, repeat visits resolve the cached promise instantly. A full reload re-fetches.
let _managerPortfoliosCache: Promise<ManagerPortfolio[]> | null = null;
export function fetchManagerPortfolios(): Promise<ManagerPortfolio[]> {
  if (!_managerPortfoliosCache) {
    _managerPortfoliosCache = selectAllPaged<ManagerPortfolio>(
      "manager_portfolios",
      "manager_cik, manager_name, period_of_report, accession_number, rank, cusip, ticker, issuer, shares, value, pct_of_portfolio, prior_shares, prior_value, share_change, action, filed_at",
      { col: "value", asc: false },
      { col: "period_of_report", value: managerPortfolioSince() },
    ).catch((e) => { _managerPortfoliosCache = null; throw e; });  // don't cache failures
  }
  return _managerPortfoliosCache;
}

// Holdings where THIS company is the filing manager — i.e. the equity stakes it
// owns in other companies (only populated if the company files Form 13F itself).
// The consumer (company "Disclosed equity portfolio") renders only the latest
// reported quarter, so we fetch just the recent window, not all history.
export async function fetchManagerHoldings(managerCik: string): Promise<InstitutionalHolding[]> {
  const { data, error } = await supabase
    .from("institutional_holdings")
    .select("cik, ticker, period_of_report, manager_name, manager_cik, accession_number, shares, value, pct_of_portfolio, filed_at")
    .eq("manager_cik", managerCik)
    .gte("period_of_report", managerSince())
    .order("period_of_report", { ascending: false });
  if (error || !data) return [];
  return data as InstitutionalHolding[];
}

export async function fetchCorporateEvents(cik: string): Promise<CorporateEvent[]> {
  const { data, error } = await supabase
    .from("corporate_events")
    .select("cik, ticker, accession_number, event_date, item_code, event_class, summary, filed_at")
    .eq("cik", cik)
    .order("event_date", { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return data as CorporateEvent[];
}

export async function fetchEarningsEvents(cik: string): Promise<EarningsEvent[]> {
  const { data, error } = await supabase
    .from("earnings_events")
    .select("cik, ticker, accession_number, period, reported_date, revenue, diluted_eps, net_income, guidance_action, guidance_low, guidance_high, filed_at")
    .eq("cik", cik)
    .order("reported_date", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data as EarningsEvent[];
}

export async function fetchLateFilings(cik: string): Promise<LateFiling[]> {
  const { data, error } = await supabase
    .from("late_filings")
    .select("cik, ticker, accession_number, nt_form, subject_form, period, reason_excerpt, filed_at")
    .eq("cik", cik)
    .order("filed_at", { ascending: false });
  if (error || !data) return [];
  return data as LateFiling[];
}

export async function fetchSecuritiesOfferings(cik: string): Promise<SecuritiesOffering[]> {
  const { data, error } = await supabase
    .from("securities_offerings")
    .select("cik, ticker, accession_number, form, offering_type, amount, shares, filed_at")
    .eq("cik", cik)
    .order("filed_at", { ascending: false });
  if (error || !data) return [];
  return data as SecuritiesOffering[];
}

export async function fetchBeneficialOwnership(cik: string): Promise<BeneficialOwnership[]> {
  const { data, error } = await supabase
    .from("beneficial_ownership")
    .select("cik, ticker, accession_number, filer_name, schedule, is_activist, pct_of_class, shares, purpose_excerpt, filed_at")
    .eq("cik", cik)
    .order("filed_at", { ascending: false });
  if (error || !data) return [];
  return data as BeneficialOwnership[];
}

export async function fetchProposedSales(cik: string): Promise<ProposedSale[]> {
  const { data, error } = await supabase
    .from("proposed_sales")
    .select("cik, ticker, accession_number, seller_name, relationship, shares, approx_value, approx_date, filed_at")
    .eq("cik", cik)
    .order("filed_at", { ascending: false });
  if (error || !data) return [];
  return data as ProposedSale[];
}

// End-of-day prices for one company. We want the most RECENT `limit` sessions,
// so order desc + limit (newest), then reverse to ascending (derivePriceKpis /
// deriveTechnicals expect ascending). Ordering ascending + limit would instead
// return the OLDEST rows once a company exceeds `limit`, silently going stale as
// daily_prices accumulates — this avoids that.
export async function fetchPrices(cik: string, limit = 400): Promise<DailyPrice[]> {
  const { data, error } = await supabase
    .from("daily_prices")
    .select("cik, ticker, date, open, high, low, close, volume")
    .eq("cik", cik)
    .order("date", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as DailyPrice[]).reverse();
}

// Run a CIK-scoped query over bounded chunks so the `.in("cik", […])` list never
// overflows the request URL — PostgREST serializes it into the query string, which
// 414s past ~500–1000 CIKs. Small lists (the common case) stay a single request;
// larger ones are split and the results concatenated. Shared by every multi-CIK
// fetcher so the chunking discipline lives in one place.
async function inChunked<T>(ciks: string[], run: (subset: string[]) => Promise<T[]>): Promise<T[]> {
  if (ciks.length <= IN_CHUNK) return run(ciks);
  const out: T[] = [];
  for (let i = 0; i < ciks.length; i += IN_CHUNK) out.push(...(await run(ciks.slice(i, i + IN_CHUNK))));
  return out;
}

// Income-statement facts across several companies — powers the peer comparison.
// Income statement only (keeps the payload small) so revenue/net-income/EPS series
// can be derived client-side via fundamentals.ts for each peer. Chunked by CIK so it
// scales to any watchlist size without overrunning the request URL.
export async function fetchIncomeFactsForCiks(ciks: string[]): Promise<FinancialFact[]> {
  if (!ciks.length) return [];
  return inChunked<FinancialFact>(ciks, async (subset) => {
    const { data, error } = await supabase
      .from("financial_facts")
      .select("cik, ticker, statement, label, concept, standard_concept, period_end, period_type, fiscal_year, value, display_order")
      .in("cik", subset)
      .eq("statement", "income")
      .limit(20000);  // generous per-chunk cap: ~income line-items × periods × chunk size
    return error || !data ? [] : (data as FinancialFact[]);
  });
}

// Recent closes for many companies at once — powers the Overview sparklines +
// price columns. Scoped to `ciks`, limited to the trailing `sinceDays`, chunked by
// CIK so the request URL never 414s as the watchlist grows.
export async function fetchRecentPrices(ciks: string[], sinceDays = 90): Promise<DailyPrice[]> {
  if (!ciks.length) return [];
  const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  return inChunked<DailyPrice>(ciks, async (subset) => {
    const { data, error } = await supabase
      .from("daily_prices")
      .select("cik, ticker, date, open, high, low, close, volume")
      .in("cik", subset)
      .gte("date", cutoff)
      .order("date", { ascending: true })
      .limit(20000);  // ~trading days × chunk size — avoids the default row cap truncating companies
    return error || !data ? [] : (data as DailyPrice[]);
  });
}

// ─── Cross-company (watchlist-wide) fetchers ────────────────────────────────────
// Powering the Signal Scanner and Catalyst Calendar: the same recent slices the
// per-cik fetchers above return, but spanning every watchlist company in one
// round-trip. Pass `ciks` to scope to the personal watchlist (recommended);
// omit it to span the whole warehouse. Ordered most-recent-first, scoped by a
// per-table recency window (not a fixed global row cap) so coverage doesn't thin.
//
// Coverage at scale is bounded by RECENCY WINDOW, not a fixed global row cap.
// A single most-recent-N query (e.g. 400 insider rows watchlist-wide) silently
// drops quiet companies once busier names fill the cap — so a stock with one
// older-but-relevant filing shows no signal. Instead each fetcher scopes to a
// per-table time window sized to that signal's real lookback (see callers), so
// every company keeps all its in-window rows regardless of how active its peers
// are. `cap` is only a safety valve against pathological volume, set well above
// any realistic personal-watchlist window. `buildSignals` (pulse.ts) stays the
// single source of truth — this only changes what rows it sees, not the logic.
//
// PostgREST also serializes `.in("cik", [...])` into the request URL, which
// overruns the URL length limit (~414) past ~500–1000 CIKs. So the CIK list is
// split into bounded chunks, each run as its own request and merged. Small
// watchlists (the common case) stay a single request.
const IN_CHUNK = 150;

async function fetchRecentScoped<T extends { cik: string }>(
  table: string, columns: string, sortCol: keyof T & string,
  ciks: string[] | undefined, sinceDays: number, cap: number,
): Promise<T[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const run = async (subset?: string[]): Promise<T[]> => {
    let q = supabase.from(table).select(columns);
    if (subset?.length) q = q.in("cik", subset);
    const { data, error } = await q.gte(sortCol, since)
      .order(sortCol, { ascending: false }).limit(cap);
    return error || !data ? [] : (data as unknown as T[]);
  };

  if (!ciks?.length) return run();                 // whole warehouse, single request
  if (ciks.length <= IN_CHUNK) return run(ciks);   // common case, single request

  const merged: T[] = [];
  for (let i = 0; i < ciks.length; i += IN_CHUNK) {
    merged.push(...await run(ciks.slice(i, i + IN_CHUNK)));
  }
  // Re-rank the union of per-chunk windows into one date-desc stream (safety cap).
  const key = (r: T) => String(r[sortCol] ?? "");
  return merged.sort((a, b) => key(b).localeCompare(key(a))).slice(0, cap);
}

// Windows below match each signal's lookback in pulse.ts buildSignals:
//   insider cluster/flow = 90d · guidance = latest print · 8-K tape = recent ·
//   activist stake = standing (long) · dilution = trailing 12mo · late = on-record.
export function fetchRecentInsider(ciks?: string[], sinceDays = 120): Promise<InsiderTransaction[]> {
  return fetchRecentScoped<InsiderTransaction>(
    "insider_transactions",
    "cik, ticker, accession_number, filer_name, filer_title, transaction_date, transaction_code, acquired_disposed, shares, price, value, shares_after, is_10b5_1, filing_url, filed_at",
    "transaction_date", ciks, sinceDays, 5000,
  );
}

export function fetchRecentEarnings(ciks?: string[], sinceDays = 220): Promise<EarningsEvent[]> {
  return fetchRecentScoped<EarningsEvent>(
    "earnings_events",
    "cik, ticker, accession_number, period, reported_date, revenue, diluted_eps, net_income, guidance_action, guidance_low, guidance_high, filed_at",
    "reported_date", ciks, sinceDays, 3000,
  );
}

export function fetchRecentEvents(ciks?: string[], sinceDays = 150): Promise<CorporateEvent[]> {
  return fetchRecentScoped<CorporateEvent>(
    "corporate_events",
    "cik, ticker, accession_number, event_date, item_code, event_class, summary, filed_at",
    "event_date", ciks, sinceDays, 5000,
  );
}

export function fetchRecentBeneficial(ciks?: string[], sinceDays = 600): Promise<BeneficialOwnership[]> {
  return fetchRecentScoped<BeneficialOwnership>(
    "beneficial_ownership",
    "cik, ticker, accession_number, filer_name, schedule, is_activist, pct_of_class, shares, purpose_excerpt, filed_at",
    "filed_at", ciks, sinceDays, 3000,
  );
}

export function fetchRecentOfferings(ciks?: string[], sinceDays = 400): Promise<SecuritiesOffering[]> {
  return fetchRecentScoped<SecuritiesOffering>(
    "securities_offerings",
    "cik, ticker, accession_number, form, offering_type, amount, shares, filed_at",
    "filed_at", ciks, sinceDays, 3000,
  );
}

export function fetchRecentLateFilings(ciks?: string[], sinceDays = 600): Promise<LateFiling[]> {
  return fetchRecentScoped<LateFiling>(
    "late_filings",
    "cik, ticker, accession_number, nt_form, subject_form, period, reason_excerpt, filed_at",
    "filed_at", ciks, sinceDays, 3000,
  );
}

// ─── Reference data ─────────────────────────────────────────────────────────
// Small, slowly-changing context tables. Fetched once per session (see
// taxonomy.ts / entities.ts caches) and matched client-side — never per row.
// All three return [] on error so the embedded seeds remain the fallback.

export async function fetchCompanyProfiles(): Promise<CompanyProfileRow[]> {
  return selectAllPaged<CompanyProfileRow>("company_profiles", "cik, sector, industry, thesis");
}

export async function fetchCompanyThemes(): Promise<CompanyThemeRow[]> {
  return selectAllPaged<CompanyThemeRow>("company_themes", "cik, name, note, rank", { col: "rank" });
}

export async function fetchEntities(): Promise<EntityRow[]> {
  return selectAllPaged<EntityRow>("entities", "match_key, kind, note");
}

// Queue a company for backend ingestion (the one anon-writable table). Inserts a
// 'queued' row; the next pipeline run picks it up. Duplicate inserts are benign.
export async function queueWatchlist(c: { cik: string; ticker: string; name: string }): Promise<boolean> {
  const { error } = await supabase
    .from("watchlist")
    .insert({ cik: c.cik, ticker: c.ticker, name: c.name, status: "queued" });
  if (error && error.code !== "23505") {   // 23505 = already queued; treat as success
    return false;
  }
  return true;
}

// Realtime: prepend newly-inserted filings to the live feed.
export function subscribeFilings(onInsert: (f: Filing) => void): () => void {
  const channel = supabase
    .channel("filings-feed")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "filings" },
      (payload) => onInsert(payload.new as Filing),
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}
