// Per-company datasets shared across the company tabs. Fetched ONCE in CompanyPage
// and passed down, so switching tabs (Overview → Ownership → Catalysts → Filings)
// never refetches the same rows. Overview already needs nearly all of these for
// its scorecard/tape, so lifting them here costs ~one extra small query (proposed
// sales) up front and saves the per-tab refetch bursts.
import type {
  Filing, EarningsEvent, CorporateEvent, InsiderTransaction, InstitutionalHolding,
  BeneficialOwnership, SecuritiesOffering, LateFiling, DailyPrice, ProposedSale,
} from "../../lib/types";

export type CompanyAux = {
  filings: Filing[]; earnings: EarningsEvent[]; events: CorporateEvent[];
  insider: InsiderTransaction[]; holdings: InstitutionalHolding[];
  beneficial: BeneficialOwnership[]; offers: SecuritiesOffering[];
  lateF: LateFiling[]; prices: DailyPrice[]; proposed: ProposedSale[];
  loading: boolean;
};

export const EMPTY_AUX: CompanyAux = {
  filings: [], earnings: [], events: [], insider: [], holdings: [],
  beneficial: [], offers: [], lateF: [], prices: [], proposed: [], loading: true,
};
