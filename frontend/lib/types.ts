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

export type StatementKind = "income" | "balance" | "cashflow";
export type PeriodType = "annual" | "quarterly";

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
