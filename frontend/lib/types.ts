// Shared row types mirroring the Supabase warehouse tables (schema.sql).

export type Company = {
  cik: string;
  ticker: string | null;
  name: string | null;
  sector: string | null;
  industry: string | null;
};

export type FinancialFact = {
  cik: string;
  ticker: string | null;
  statement: "income" | "balance" | "cashflow";
  label: string;
  concept: string;
  standard_concept: string | null;
  period_end: string; // ISO date
  period_type: "annual" | "quarterly";
  fiscal_year: number | null;
  value: number | null;
  display_order: number | null;
};

export type Filing = {
  accession_number: string;
  cik: string;
  ticker: string | null;
  company_name: string | null;
  form_type: string;
  filed_at: string | null;
  period_of_report: string | null;
  filing_url: string | null;
};

export type InsiderTransaction = {
  cik: string;
  ticker: string | null;
  accession_number: string;
  filer_name: string | null;
  filer_title: string | null;
  transaction_date: string | null;
  transaction_code: string | null;
  acquired_disposed: "A" | "D" | null;
  shares: number | null;
  price: number | null;
  value: number | null;
  shares_after: number | null;
  is_10b5_1: boolean;
  filing_url: string | null;
  filed_at: string | null;
};

export type InstitutionalHolding = {
  cik: string;
  ticker: string | null;
  period_of_report: string;
  manager_name: string;
  manager_cik: string | null;
  accession_number: string | null;
  shares: number | null;
  value: number | null;
  pct_of_portfolio: number | null;
  filed_at: string | null;
};

// One tracked 13F manager's top positions across ALL stocks (backend
// institutional_extractor.ingest_manager_portfolios → manager_portfolios).
// Powers the Managers view: "what does Vanguard / BlackRock actually invest in."
export type ManagerPortfolio = {
  manager_cik: string;
  manager_name: string;
  period_of_report: string;
  accession_number: string | null;
  rank: number | null;
  cusip: string;
  ticker: string | null;
  issuer: string | null;
  shares: number | null;
  value: number | null;
  pct_of_portfolio: number | null;
  // Quarter-over-quarter move vs the manager's prior 13F (what they bought/sold).
  prior_shares: number | null;
  prior_value: number | null;
  share_change: number | null;
  action: "new" | "added" | "trimmed" | "unchanged" | "exited" | null;
  filed_at: string | null;
};

export type BeneficialOwnership = {
  cik: string;
  ticker: string | null;
  accession_number: string;
  filer_name: string | null;
  schedule: string | null;
  is_activist: boolean;
  pct_of_class: number | null;
  shares: number | null;
  purpose_excerpt: string | null;
  filed_at: string | null;
};

export type ProposedSale = {
  cik: string;
  ticker: string | null;
  accession_number: string;
  seller_name: string | null;
  relationship: string | null;
  shares: number | null;
  approx_value: number | null;
  approx_date: string | null;
  filed_at: string | null;
};

export type EarningsEvent = {
  cik: string;
  ticker: string | null;
  accession_number: string;
  period: string | null;
  reported_date: string | null;
  revenue: number | null;
  diluted_eps: number | null;
  net_income: number | null;
  guidance_action: "raised" | "lowered" | "maintained" | "withdrawn" | null;
  guidance_low: number | null;
  guidance_high: number | null;
  filed_at: string | null;
};

export type CorporateEvent = {
  cik: string;
  ticker: string | null;
  accession_number: string;
  event_date: string | null;
  item_code: string | null;
  event_class: string | null;
  summary: string | null;
  filed_at: string | null;
};

export type LateFiling = {
  cik: string;
  ticker: string | null;
  accession_number: string;
  nt_form: string | null;
  subject_form: string | null;
  period: string | null;
  reason_excerpt: string | null;
  filed_at: string | null;
};

export type SecuritiesOffering = {
  cik: string;
  ticker: string | null;
  accession_number: string;
  form: string | null;
  offering_type: string | null;
  amount: number | null;
  shares: number | null;
  filed_at: string | null;
};

// One row per IPO-lifecycle filing (backend ipo_extractor → ipos). The IPOs view
// groups these by issuer (cik) into one card per IPO with its most-advanced status.
export type Ipo = {
  cik: string;
  accession_number: string;
  company_name: string | null;
  ticker: string | null;
  form: string | null;
  status: "filed" | "updated" | "priced" | "withdrawn" | null;
  is_spac: boolean | null;
  price: number | null;       // offering price per share (priced only)
  shares: number | null;      // shares offered
  proceeds: number | null;    // gross proceeds, USD
  offering_type: string | null;
  filing_url: string | null;
  filed_at: string | null;
};

// One row per Google News article per company (backend news_ingest.py →
// company_news). The News view lists these watchlist-wide; the company page can
// show a per-company headline strip.
export type NewsItem = {
  cik: string;
  ticker: string | null;
  company_name: string | null;
  guid: string;
  title: string | null;
  link: string | null;
  source: string | null;
  summary: string | null;
  published_at: string | null;
  importance: number | null;   // trader-importance score (news_score.py); >= 2 ⇒ important
  category: string | null;     // 'Earnings' | 'M&A' | 'FDA' | 'Analyst' | ...
};

// One row per curated market-wide "Top Intelligence" item (backend
// market_news_ingest.py → market_news). Market-mover headlines from free macro/
// regulatory RSS (SEC, Fed, FDA, PR Newswire), already importance-filtered.
export type MarketNews = {
  guid: string;
  source: string | null;
  category: string | null;
  importance: number | null;
  title: string | null;
  link: string | null;
  summary: string | null;
  published_at: string | null;
};

export type DailyPrice = {
  cik: string;
  ticker: string | null;
  date: string; // ISO date
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
};

// One precomputed row per company (backend summary_ingest.py → company_summary).
// Lets the watchlist-wide surfaces read one small paginated query instead of every
// company's full price history, so they scale to any watchlist size.
export type CompanySummary = {
  cik: string;
  ticker: string | null;
  last_close: number | null;
  as_of: string | null;
  chg_1d: number | null;
  ret_ytd: number | null;
  pct_off_high: number | null;
  rsi14: number | null;
  pct_from_50: number | null;
  pct_from_200: number | null;
  ma_cross: "golden" | "death" | null;
  vol_spike: number | null;
  new_52w_high: boolean | null;
  new_52w_low: boolean | null;
  spark: number[] | null;
  filings_30d: number | null;
  last_filing_form: string | null;
  last_filing_at: string | null;
  net_insider_90d: number | null;
  cluster_buy: boolean | null;
};

export type StatementKind = "income" | "balance" | "cashflow";
export type PeriodType = "annual" | "quarterly";

// ─── View routing ───────────────────────────────────────────────────────────────
// The top-level dashboard view and the per-company tab. Shared by the root Page,
// the Sidebar, and CompanyPage so the hash router and the components agree.
export type MainView = "overview" | "search" | "feed" | "news" | "calendar" | "managers" | "ipos" | "guide" | "company";
export type CompanyTab = "overview" | "strategy" | "fundamentals" | "peers" | "ownership" | "catalysts" | "filings" | "news";

// ─── Reference data (backend-populated; read once per session) ──────────────────
export type CompanyProfileRow = {
  cik: string;
  sector: string | null;
  industry: string | null;
  thesis: string | null;
};

export type CompanyThemeRow = {
  cik: string;
  name: string;
  note: string | null;
  rank: number | null;
};

export type EntityRow = {
  match_key: string;
  kind: string | null;
  note: string | null;
};
