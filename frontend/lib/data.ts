// Data access layer — the only place that talks to Supabase.
import { supabase } from "./supabase";
import { CORE_WATCHLIST } from "./watchlist";
import type {
  Company, FinancialFact, Filing,
  InsiderTransaction, InstitutionalHolding,
  CorporateEvent, EarningsEvent, LateFiling, SecuritiesOffering,
  BeneficialOwnership, ProposedSale, DailyPrice,
  CompanyProfileRow, CompanyThemeRow, EntityRow, CompanySummary,
} from "./types";

// Whole-table read, paged in 1000-row chunks. Any "fetch every row" query must use
// this — a bare .select() caps at PostgREST's default row limit and silently drops
// rows as the watchlist grows (companies > ~1000, themes > ~250). Returns [] on error.
async function selectAllPaged<T>(
  table: string, columns: string, order?: { col: string; asc?: boolean },
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    let q = supabase.from(table).select(columns).range(start, start + PAGE - 1);
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

export async function fetchInstitutionalHoldings(cik: string): Promise<InstitutionalHolding[]> {
  const { data, error } = await supabase
    .from("institutional_holdings")
    .select("cik, ticker, period_of_report, manager_name, manager_cik, accession_number, shares, value, pct_of_portfolio, filed_at")
    .eq("cik", cik)
    .order("period_of_report", { ascending: false });
  if (error || !data) return [];
  return data as InstitutionalHolding[];
}

// Holdings where THIS company is the filing manager — i.e. the equity stakes it
// owns in other companies (only populated if the company files Form 13F itself).
export async function fetchManagerHoldings(managerCik: string): Promise<InstitutionalHolding[]> {
  const { data, error } = await supabase
    .from("institutional_holdings")
    .select("cik, ticker, period_of_report, manager_name, manager_cik, accession_number, shares, value, pct_of_portfolio, filed_at")
    .eq("manager_cik", managerCik)
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

// End-of-day prices for one company (ascending by date — derivePriceKpis expects that).
export async function fetchPrices(cik: string, limit = 400): Promise<DailyPrice[]> {
  const { data, error } = await supabase
    .from("daily_prices")
    .select("cik, ticker, date, open, high, low, close, volume")
    .eq("cik", cik)
    .order("date", { ascending: true })
    .limit(limit);
  if (error || !data) return [];
  return data as DailyPrice[];
}

// Income-statement facts across several companies — powers the peer comparison.
// Income statement only (keeps the payload small) so revenue/net-income/EPS series
// can be derived client-side via fundamentals.ts for each peer.
export async function fetchIncomeFactsForCiks(ciks: string[]): Promise<FinancialFact[]> {
  if (!ciks.length) return [];
  const { data, error } = await supabase
    .from("financial_facts")
    .select("cik, ticker, statement, label, concept, standard_concept, period_end, period_type, fiscal_year, value, display_order")
    .in("cik", ciks)
    .eq("statement", "income")
    .limit(20000);  // generous: ~income line-items × periods × watchlist size — avoids the default row cap
  if (error || !data) return [];
  return data as FinancialFact[];
}

// Recent closes for many companies at once — powers the Overview sparklines +
// price columns. Scoped to `ciks`, limited to the trailing `sinceDays`.
export async function fetchRecentPrices(ciks: string[], sinceDays = 90): Promise<DailyPrice[]> {
  if (!ciks.length) return [];
  const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("daily_prices")
    .select("cik, ticker, date, open, high, low, close, volume")
    .in("cik", ciks)
    .gte("date", cutoff)
    .order("date", { ascending: true })
    .limit(20000);  // ~trading days × watchlist size — avoids the default row cap truncating companies
  if (error || !data) return [];
  return data as DailyPrice[];
}

// ─── Cross-company (watchlist-wide) fetchers ────────────────────────────────────
// Powering the Signal Scanner and Catalyst Calendar: the same recent slices the
// per-cik fetchers above return, but spanning every watchlist company in one
// round-trip. Pass `ciks` to scope to the personal watchlist (recommended);
// omit it to span the whole warehouse. Ordered most-recent-first, modest limits.
// `.in("cik", …)` is applied on the filter builder BEFORE order/limit so the
// chain stays type-correct.

export async function fetchRecentInsider(ciks?: string[], limit = 400): Promise<InsiderTransaction[]> {
  let q = supabase
    .from("insider_transactions")
    .select("cik, ticker, accession_number, filer_name, filer_title, transaction_date, transaction_code, acquired_disposed, shares, price, value, shares_after, is_10b5_1, filing_url, filed_at");
  if (ciks?.length) q = q.in("cik", ciks);
  const { data, error } = await q.order("transaction_date", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return data as InsiderTransaction[];
}

export async function fetchRecentEarnings(ciks?: string[], limit = 200): Promise<EarningsEvent[]> {
  let q = supabase
    .from("earnings_events")
    .select("cik, ticker, accession_number, period, reported_date, revenue, diluted_eps, net_income, guidance_action, guidance_low, guidance_high, filed_at");
  if (ciks?.length) q = q.in("cik", ciks);
  const { data, error } = await q.order("reported_date", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return data as EarningsEvent[];
}

export async function fetchRecentEvents(ciks?: string[], limit = 300): Promise<CorporateEvent[]> {
  let q = supabase
    .from("corporate_events")
    .select("cik, ticker, accession_number, event_date, item_code, event_class, summary, filed_at");
  if (ciks?.length) q = q.in("cik", ciks);
  const { data, error } = await q.order("event_date", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return data as CorporateEvent[];
}

export async function fetchRecentBeneficial(ciks?: string[], limit = 200): Promise<BeneficialOwnership[]> {
  let q = supabase
    .from("beneficial_ownership")
    .select("cik, ticker, accession_number, filer_name, schedule, is_activist, pct_of_class, shares, purpose_excerpt, filed_at");
  if (ciks?.length) q = q.in("cik", ciks);
  const { data, error } = await q.order("filed_at", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return data as BeneficialOwnership[];
}

export async function fetchRecentOfferings(ciks?: string[], limit = 200): Promise<SecuritiesOffering[]> {
  let q = supabase
    .from("securities_offerings")
    .select("cik, ticker, accession_number, form, offering_type, amount, shares, filed_at");
  if (ciks?.length) q = q.in("cik", ciks);
  const { data, error } = await q.order("filed_at", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return data as SecuritiesOffering[];
}

export async function fetchRecentLateFilings(ciks?: string[], limit = 200): Promise<LateFiling[]> {
  let q = supabase
    .from("late_filings")
    .select("cik, ticker, accession_number, nt_form, subject_form, period, reason_excerpt, filed_at");
  if (ciks?.length) q = q.in("cik", ciks);
  const { data, error } = await q.order("filed_at", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return data as LateFiling[];
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
