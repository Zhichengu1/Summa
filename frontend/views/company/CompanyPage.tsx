"use client";
// CompanyPage — the per-company shell: header, queued-state banner, the tab bar,
// and the active tab. Fetches the per-company facts + the shared CompanyAux bundle
// ONCE here and passes them down, so switching tabs never refetches the same rows.
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import { CompanyMark } from "../../components/badges/CompanyMark";
import {
  fetchFinancialFacts, fetchFilingsForCik, fetchEarningsEvents, fetchCorporateEvents,
  fetchInsiderTransactions, fetchInstitutionalHoldings, fetchBeneficialOwnership,
  fetchSecuritiesOfferings, fetchLateFilings, fetchPrices, fetchProposedSales, fetchNewsForCik,
} from "../../lib/data/data";
import { profileFor } from "../../lib/domain/taxonomy";
import type { Company, CompanyTab, FinancialFact } from "../../lib/types";
import { type CompanyAux, EMPTY_AUX } from "./companyAux";

// Overview is the default tab, so it's bundled with this shell (one load when a
// company opens). The other six tabs — several are large and pull in lazy charts —
// are code-split and fetched only when their tab is selected.
import { CompanyOverviewTab } from "./CompanyOverviewTab";
const tabLoading = () => <div style={{ padding: 24, color: "var(--fg-4)" }}>Loading…</div>;
const StrategyTab = dynamic(() => import("./StrategyTab").then((m) => ({ default: m.StrategyTab })), { ssr: false, loading: tabLoading });
const FundamentalsTab = dynamic(() => import("./FundamentalsTab").then((m) => ({ default: m.FundamentalsTab })), { ssr: false, loading: tabLoading });
const PeersTab = dynamic(() => import("./PeersTab").then((m) => ({ default: m.PeersTab })), { ssr: false, loading: tabLoading });
const OwnershipTab = dynamic(() => import("./OwnershipTab").then((m) => ({ default: m.OwnershipTab })), { ssr: false, loading: tabLoading });
const CatalystsTab = dynamic(() => import("./CatalystsTab").then((m) => ({ default: m.CatalystsTab })), { ssr: false, loading: tabLoading });
const FilingsTab = dynamic(() => import("./FilingsTab").then((m) => ({ default: m.FilingsTab })), { ssr: false, loading: tabLoading });
const NewsTab = dynamic(() => import("./NewsTab").then((m) => ({ default: m.NewsTab })), { ssr: false, loading: tabLoading });

export function CompanyPage({
  cik, tab, companies, onTab, pending = false,
}: { cik: string; tab: CompanyTab; companies: Company[]; onTab: (t: CompanyTab) => void; pending?: boolean }) {
  const company = companies.find((c) => c.cik === cik) ?? null;
  const [facts, setFacts] = useState<FinancialFact[]>([]);
  const [loadingFacts, setLoadingFacts] = useState(true);
  const [aux, setAux] = useState<CompanyAux>(EMPTY_AUX);

  useEffect(() => {
    setFacts([]);
    setLoadingFacts(true);
    fetchFinancialFacts(cik).then((d) => { setFacts(d); setLoadingFacts(false); });
  }, [cik]);

  useEffect(() => {
    setAux(EMPTY_AUX);
    Promise.all([
      fetchFilingsForCik(cik, 50), fetchEarningsEvents(cik), fetchCorporateEvents(cik),
      fetchInsiderTransactions(cik), fetchInstitutionalHoldings(cik),
      fetchBeneficialOwnership(cik), fetchSecuritiesOfferings(cik), fetchLateFilings(cik),
      fetchPrices(cik), fetchProposedSales(cik), fetchNewsForCik(cik),
    ]).then(([filings, earnings, events, insider, holdings, beneficial, offers, lateF, prices, proposed, news]) => {
      setAux({ filings, earnings, events, insider, holdings, beneficial, offers, lateF, prices, proposed, news, loading: false });
    });
  }, [cik]);

  const ticker = company?.ticker ?? "?";
  const name = company?.name ?? cik;
  const profile = profileFor(ticker, company?.sector, company?.industry, cik);

  // Sticky-header quote: last close + day change from the bars already fetched
  // into aux (ascending) — no extra query.
  const quote = useMemo(() => {
    const bars = aux.prices.filter((p) => p.close != null);
    if (bars.length === 0) return null;
    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : null;
    const chg = prev?.close ? ((last.close! - prev.close) / prev.close) * 100 : null;
    return { close: last.close!, chg, asOf: last.date };
  }, [aux.prices]);

  const TABS: { key: CompanyTab; label: string }[] = useMemo(() => [
    { key: "overview",      label: "Overview" },
    { key: "strategy",      label: "Strategy & Investments" },
    { key: "fundamentals",  label: "Fundamentals" },
    { key: "peers",         label: "Peers" },
    { key: "ownership",     label: "Ownership" },
    { key: "catalysts",     label: "Catalysts" },
    { key: "filings",       label: "Filings" },
    { key: "news",          label: "News" },
  ], []);

  return (
    <div>
      <div className="company-hero">
        <CompanyMark ticker={ticker} size={40} />
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title" style={{ fontSize: 18 }}>{name}</h1>
          <div className="page-sub" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span>{ticker} · CIK {cik}</span>
            {profile && profile.sector !== "—" && <span className="cat-chip sector">{profile.sector}</span>}
            {profile && profile.industry !== "—" && <span className="cat-chip">{profile.industry}</span>}
          </div>
        </div>
        {quote && (
          <div className="hero-price">
            <div className="hero-last">${quote.close.toFixed(2)}</div>
            {quote.chg != null && (
              <div className={`hero-chg ${quote.chg >= 0 ? "pos" : "neg"}`}>
                {quote.chg >= 0 ? "▲" : "▼"} {quote.chg >= 0 ? "+" : ""}{quote.chg.toFixed(2)}%
              </div>
            )}
            {quote.asOf && <div className="hero-asof">as of {quote.asOf}</div>}
          </div>
        )}
      </div>

      {pending && (
        <div className="pending-banner">
          <strong>⏳ Queued for ingestion.</strong> This company was added to your watchlist and
          will be pulled on the next pipeline run. Its data appears here once the backend ingests it.
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.key} className={`tab${tab === t.key ? " active" : ""}`} onClick={() => onTab(t.key)}>
            {t.label}
          </div>
        ))}
      </div>

      {tab === "overview"     && <CompanyOverviewTab facts={facts} loading={loadingFacts} aux={aux} />}
      {tab === "strategy"     && <StrategyTab cik={cik} ticker={ticker} facts={facts} loading={loadingFacts} />}
      {tab === "fundamentals" && <FundamentalsTab facts={facts} loading={loadingFacts} />}
      {tab === "peers"        && <PeersTab cik={cik} peers={companies} />}
      {tab === "ownership"    && <OwnershipTab aux={aux} />}
      {tab === "catalysts"    && <CatalystsTab aux={aux} />}
      {tab === "filings"      && <FilingsTab aux={aux} />}
      {tab === "news"         && <NewsTab aux={aux} ticker={ticker} />}
    </div>
  );
}
