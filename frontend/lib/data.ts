// Data access layer — the only place that talks to Supabase.
import { supabase } from "./supabase";
import { CORE_WATCHLIST } from "./watchlist";
import type {
  Company, FinancialFact, Filing,
  InsiderTransaction, InstitutionalHolding,
  CorporateEvent, EarningsEvent, LateFiling, SecuritiesOffering,
  BeneficialOwnership, ProposedSale,
} from "./types";

export async function fetchCompanies(): Promise<Company[]> {
  const { data, error } = await supabase
    .from("companies")
    .select("cik, ticker, name, sector, industry")
    .order("ticker", { ascending: true });
  if (error || !data || data.length === 0) {
    return CORE_WATCHLIST.map((c) => ({
      cik: c.cik, ticker: c.ticker, name: c.name, sector: null, industry: null,
    }));
  }
  return data as Company[];
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
