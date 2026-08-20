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

// One row per (day, ticker) in the daily Reddit most-discussed snapshot (backend
// ingest/reddit_trends_ingest.py → reddit_trends). GLOBAL market buzz, not
// watchlist-scoped; ~30-day rolling window. Powers the Reddit Buzz view.
export type RedditTrend = {
  trend_date: string;           // ISO date (UTC snapshot day)
  ticker: string;
  name: string | null;
  rank: number | null;          // 1 = most discussed that day
  mentions: number | null;
  upvotes: number | null;
  rank_change: number | null;   // vs 24h ago; positive = climbing
  mentions_change: number | null;
  sentiment: string | null;     // 'Bullish' | 'Bearish' (Tradestie WSB)
  sentiment_score: number | null;
  source: string | null;
  // Price context persisted by the ingest (Yahoo; null until schema.sql is
  // re-applied or when the ticker's quote was unavailable that run).
  last_price: number | null;
  day_pct: number | null;       // % vs prior session
  off_high_pct: number | null;  // % below 52-week high (negative)
  off_low_pct: number | null;   // % above 52-week low (small = at the low)
  is_etf: boolean | null;
  // Industry labels resolved at ingest (curated profiles → SEC SIC).
  sector: string | null;
  industry: string | null;
};

// One disclosed congressional (or executive-branch) stock transaction (backend
// ingest/congress_trades_ingest.py → congress_trades, from the normalized
// House PTR + Senate eFD feeds). GLOBAL, not watchlist-scoped; only tickered
// trades are stored. Powers the Congress view's consensus buys/sells.
export type CongressTrade = {
  id: string;
  branch: string | null;            // 'congress' | 'executive'
  chamber: string | null;           // 'senate' | 'house'
  party: string | null;             // 'D' | 'R' | 'I'
  state: string | null;
  office: string | null;            // e.g. 'U.S. Senator · RI'
  filer_id: string | null;          // stable per-politician key
  filer_name: string | null;
  ticker: string;
  asset_name: string | null;
  side: "buy" | "sell" | "exchange";
  transaction_type: string | null;  // raw label, e.g. 'Sale (Partial)'
  transaction_date: string;         // ISO date
  filing_date: string | null;
  is_late: boolean | null;
  owner: string | null;             // 'Self' | 'Spouse' | 'Joint' | …
  amount_low: number | null;        // disclosed range bounds
  amount_high: number | null;
  amount_label: string | null;      // '$15,001 - $50,000'
  doc_url: string | null;           // official disclosure document
  ret_since: number | null;         // stock return since the trade (percent)
  excess_since: number | null;      // vs the market since the trade (percent)
};

// One weekly CFTC Commitments of Traders report row for one futures market
// (backend ingest/cot_ingest.py → cot_reports, from the free CFTC Public
// Reporting API's legacy futures-only report). GLOBAL, not watchlist-scoped;
// ~28 curated major markets. Powers the COT view's positioning index
// (lib/domain/cot.ts derives crowded longs/shorts, flips, weekly shifts).
export type CotReport = {
  market_code: string;              // CFTC contract market code, e.g. '088691'
  report_date: string;              // ISO date — the Tuesday the data is as of
  market_name: string | null;       // display name, e.g. 'Gold'
  market_group: string | null;      // indices|rates|fx|crypto|energy|metals|ags
  open_interest: number | null;
  oi_change: number | null;         // WoW change in open interest
  noncomm_long: number | null;      // large speculators (funds)
  noncomm_short: number | null;
  comm_long: number | null;         // commercials (hedgers)
  comm_short: number | null;
  nonrept_long: number | null;      // small traders
  nonrept_short: number | null;
  noncomm_net: number | null;       // long - short (the headline series)
  comm_net: number | null;
  nonrept_net: number | null;
  noncomm_net_pct_oi: number | null; // spec net as % of open interest
  traders_total: number | null;
};

// One daily options-chain snapshot for one company (backend
// ingest/options_ingest.py → options_snapshots, from CBOE's free delayed-quotes
// JSON). The call-vs-put decision inputs: flow (who's buying which side), how
// premium is priced (IV vs realized vol, IV rank), skew, what move is already
// priced in, and the day's biggest volume-over-OI contracts. The directional
// bias and suggested structure are DERIVED from these in lib/domain/options.ts,
// not stored — so the read can be retuned without a re-ingest.
export type OptionsSnapshot = {
  cik: string;
  snapshot_date: string;             // ISO date the snapshot was taken (UTC)
  ticker: string | null;
  spot: number | null;
  price_change_pct: number | null;
  iv30: number | null;               // 30-day implied vol, PERCENT (e.g. 28.4)
  iv30_change_pct: number | null;
  rv30: number | null;               // 30-session realized vol, annualized %
  iv_rv_ratio: number | null;        // iv30/rv30 — >1 = options priced above recent reality
  iv_rank: number | null;            // percentile of iv30 in trailing 1y (null until enough history)
  iv_rank_obs: number | null;        // observations behind iv_rank
  call_volume: number | null;
  put_volume: number | null;
  call_oi: number | null;
  put_oi: number | null;
  call_premium: number | null;       // $ premium traded today on calls
  put_premium: number | null;
  pc_volume_ratio: number | null;    // put/call by contracts
  pc_oi_ratio: number | null;        // put/call by open interest
  pc_premium_ratio: number | null;   // put/call by dollars — the truest flow read
  contracts_count: number | null;
  skew_25d: number | null;           // 25-delta put IV − call IV, vol points
  skew_expiry: string | null;
  front_expiry: string | null;
  front_dte: number | null;
  atm_straddle: number | null;
  expected_move_pct: number | null;  // front-expiry straddle as % of spot
  max_pain: number | null;
  max_pain_pct: number | null;       // max-pain distance from spot, %
  near_expiry: string | null;        // ~30-day expiry — the swing-trade horizon
  near_dte: number | null;
  near_move_pct: number | null;
  vix: number | null;
  vix_change_pct: number | null;
  unusual: UnusualContract[] | null;
  candidates: OptionCandidateRow[] | null;
};

// One actually-tradeable contract from the stored delta ladder (~5 strikes per side
// across a ~30d and ~60d expiry, filtered for a live two-sided quote and real open
// interest). Raw economics only — breakeven, cost per delta, friction and the value
// ranking are derived in lib/domain/options.ts so they stay retunable.
export type OptionCandidateRow = {
  right: "C" | "P";
  strike: number;
  expiry: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  mid: number;
  iv: number | null;                 // contract IV, percent
  delta: number;
  theta: number | null;              // $/share/day
  vega: number | null;
  oi: number;
  volume: number;
};

// One notable contract inside OptionsSnapshot.unusual — volume far above the
// resting open interest, i.e. positions opened TODAY rather than traded between
// existing holders. Deep-ITM (stock-replacement) contracts are filtered out at
// ingest, so these are speculative bets.
export type UnusualContract = {
  right: "C" | "P";
  strike: number;
  expiry: string;
  dte: number;
  volume: number;
  oi: number;
  vol_oi: number | null;
  iv: number | null;                 // contract IV, percent
  delta: number | null;
  premium: number;                   // $ traded (volume × mid × 100)
  otm_pct: number | null;            // strike distance from spot, %
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

// ─── Phase 2: Trend Intelligence ────────────────────────────────────────────────
// Cross-company theme aggregates (backend trend_aggregator.py → theme_trends),
// recomputed wholesale each cycle from the per-company `theme_mentions` rows the
// ingest distils out of 10-K/10-Q narrative. Two signals that deliberately
// disagree: BREADTH (company_count — what companies SAY, cheap) and CAPITAL
// (capital_flow — attributed R&D + capex, expensive). Breadth alone is a
// narrative; breadth plus capital is a buildout.

// One company behind a theme in a quarter, ranked by attributed capital.
export type ThemeDriver = {
  cik: string;
  ticker: string;
  mentions: number;
  capital: number;                  // attributed R&D + capex, USD
};

export type ThemeTrend = {
  theme_key: string;
  period: string;                   // calendar quarter end, ISO date
  label: string | null;
  category: string | null;
  company_count: number | null;     // distinct companies citing it — BREADTH
  coverage: number | null;          // companies reporting at all: the honest denominator
  mention_total: number | null;
  breadth_delta: number | null;     // company_count vs the prior quarter
  breadth_growth: number | null;    // that change, %
  capital_flow: number | null;      // attributed R&D + capex, USD — DEPTH
  capital_growth: number | null;    // % vs the prior quarter (null when no base)
  momentum_score: number | null;    // 0–100 composite
  stage: ThemeStage | null;
  sector: string | null;            // leading sector by attributed capital
  sector_flow: Record<string, number> | null;
  drivers: ThemeDriver[] | null;
  thin: boolean | null;             // coverage too small for the numbers to mean much
  summary: string | null;           // templated sentence built from this row's numbers
  updated_at: string | null;
};

export type ThemeStage = "emerging" | "accelerating" | "mainstream" | "cooling";

export type StatementKind = "income" | "balance" | "cashflow";
export type PeriodType = "annual" | "quarterly";

// ─── View routing ───────────────────────────────────────────────────────────────
// The top-level dashboard view and the per-company tab. Shared by the root Page,
// the Sidebar, and CompanyPage so the hash router and the components agree.
export type MainView = "overview" | "search" | "feed" | "news" | "calendar" | "managers" | "ipos" | "reddit" | "congress" | "cot" | "options" | "trends" | "guide" | "company";
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
