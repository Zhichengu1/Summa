"use client";
// Root dashboard shell — owns the hash router, the one-time initial data load
// (companies, recent filings, reference data, SEC index), the Realtime filings
// subscription, and the personal-watchlist state. Everything visual lives in
// views/ (top-level views + the company tabs) and components/ (shared atoms);
// this file only wires data + routing into them. See CLAUDE.md "Splitting page.tsx".
import { useEffect, useState, useMemo, useCallback } from "react";
import dynamic from "next/dynamic";

// Sidebar + Overview are the first paint, so they load eagerly. Every other view
// is code-split: only the one the user routes to is fetched, keeping the initial
// bundle small (the heavy views — Managers/charts, the company tabs — never ship
// on first load). ssr:false matches the static-export + Realtime client model.
import { Sidebar } from "../views/Sidebar";
import { TopBar } from "../views/TopBar";
import { OverviewPage } from "../views/OverviewPage";
const viewLoading = () => <div style={{ padding: 24, color: "var(--fg-4)" }}>Loading…</div>;
const SearchPage = dynamic(() => import("../views/SearchPage").then((m) => ({ default: m.SearchPage })), { ssr: false, loading: viewLoading });
const FeedPage = dynamic(() => import("../views/FeedPage").then((m) => ({ default: m.FeedPage })), { ssr: false, loading: viewLoading });
const NewsPage = dynamic(() => import("../views/NewsPage").then((m) => ({ default: m.NewsPage })), { ssr: false, loading: viewLoading });
const CalendarView = dynamic(() => import("../views/CalendarView").then((m) => ({ default: m.CalendarView })), { ssr: false, loading: viewLoading });
const ManagersPage = dynamic(() => import("../views/ManagersPage").then((m) => ({ default: m.ManagersPage })), { ssr: false, loading: viewLoading });
const IposPage = dynamic(() => import("../views/IposPage").then((m) => ({ default: m.IposPage })), { ssr: false, loading: viewLoading });
const RedditPage = dynamic(() => import("../views/RedditPage").then((m) => ({ default: m.RedditPage })), { ssr: false, loading: viewLoading });
const CongressPage = dynamic(() => import("../views/CongressPage").then((m) => ({ default: m.CongressPage })), { ssr: false, loading: viewLoading });
const CotPage = dynamic(() => import("../views/CotPage").then((m) => ({ default: m.CotPage })), { ssr: false, loading: viewLoading });
const GuidePage = dynamic(() => import("../views/GuidePage").then((m) => ({ default: m.GuidePage })), { ssr: false, loading: viewLoading });
const CompanyPage = dynamic(() => import("../views/company/CompanyPage").then((m) => ({ default: m.CompanyPage })), { ssr: false, loading: viewLoading });
import {
  fetchCompanies, fetchFilings, subscribeFilings,
  fetchNews, subscribeNews,
  fetchCompanyProfiles, fetchCompanyThemes, fetchEntities, queueWatchlist,
  fetchCompanySummaries,
} from "../lib/data/data";
import { loadProfiles } from "../lib/domain/taxonomy";
import { loadEntities } from "../lib/domain/entities";
import { useWatchlist, type WatchItem } from "../lib/hooks/useWatchlist";
import { useLastSeen } from "../lib/hooks/useLastSeen";
import { loadSecIndex, searchSec, type SecCompany } from "../lib/domain/secIndex";
import type { Company, Filing, NewsItem, MainView, CompanyTab, CompanySummary } from "../lib/types";

export default function Page() {
  const [view, setView]           = useState<MainView>("overview");
  const [activeCik, setActiveCik] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CompanyTab>("overview");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [filings, setFilings]     = useState<Filing[]>([]);
  const [news, setNews]           = useState<NewsItem[]>([]);
  const [secIndex, setSecIndex]   = useState<SecCompany[]>([]);
  const [summaries, setSummaries] = useState<CompanySummary[]>([]);
  const [loading, setLoading]     = useState(true);
  const watch = useWatchlist();
  const seen = useLastSeen();

  // Hash routing
  useEffect(() => {
    function parse() {
      const h = window.location.hash.replace(/^#/, "");
      if (h === "search") { setView("search"); setActiveCik(null); return; }
      if (h === "feed") { setView("feed"); setActiveCik(null); return; }
      if (h === "news") { setView("news"); setActiveCik(null); return; }
      if (h === "calendar") { setView("calendar"); setActiveCik(null); return; }
      if (h === "managers") { setView("managers"); setActiveCik(null); return; }
      if (h === "ipos") { setView("ipos"); setActiveCik(null); return; }
      if (h === "reddit") { setView("reddit"); setActiveCik(null); return; }
      if (h === "congress") { setView("congress"); setActiveCik(null); return; }
      if (h === "cot") { setView("cot"); setActiveCik(null); return; }
      if (h === "guide") { setView("guide"); setActiveCik(null); return; }
      const m = h.match(/^c=([^/]+)(?:\/(.*))?$/);
      if (m) {
        setView("company");
        setActiveCik(m[1]);
        setActiveTab((m[2] ?? "overview") as CompanyTab);
        return;
      }
      setView("overview"); setActiveCik(null);
    }
    parse();
    window.addEventListener("hashchange", parse);
    return () => window.removeEventListener("hashchange", parse);
  }, []);

  // Initial load. Reference data (profiles/themes/entities) is fetched once here
  // and matched client-side thereafter — no per-row or per-page reads.
  useEffect(() => {
    Promise.all([
      fetchCompanies(), fetchFilings(200),
      fetchCompanyProfiles(), fetchCompanyThemes(), fetchEntities(),
    ]).then(([cos, fils, profiles, themes, entities]) => {
      loadProfiles(profiles, themes);
      loadEntities(entities);
      setCompanies(cos);
      setFilings(fils);
      setLoading(false);
    });
    // Precomputed price summaries (one tiny row/company) power the watchlist
    // last-close + day-change shown in the sidebar. Loaded separately so the
    // first paint isn't blocked on it.
    fetchCompanySummaries().then(setSummaries);
    // News is loaded here (not just inside the News view) so the nav badge can
    // count new headlines app-wide, and Realtime keeps it live in every view.
    fetchNews(500).then(setNews);
  }, []);

  // Realtime subscriptions — new filings + headlines stream in live.
  useEffect(() => subscribeFilings((f) => setFilings((p) => [f, ...p].slice(0, 200))), []);
  useEffect(() => subscribeNews((n) => setNews((p) => {
    const k = (x: NewsItem) => `${x.cik}:${x.guid}`;
    if (p.some((x) => k(x) === k(n))) return p;
    return [n, ...p]
      .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
      .slice(0, 500);
  })), []);

  // Bundled SEC index (~707 KB) for universal company search. Deferred until the
  // Search view is first opened — most sessions never search, so this keeps it off
  // the initial load. loadSecIndex caches internally, so re-opens are instant.
  useEffect(() => { if (view === "search") loadSecIndex().then(setSecIndex); }, [view]);

  // First-ever visit: seed the personal watchlist from the ingested companies.
  useEffect(() => {
    if (loading) return;
    watch.seedIfEmpty(companies.map((c) => ({ cik: c.cik, ticker: c.ticker ?? "?", name: c.name ?? c.cik })));
  }, [loading, companies, watch.seedIfEmpty]);  // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = useCallback((hash: string) => { window.location.hash = hash; }, []);
  const openCompany = useCallback((cik: string, tab: CompanyTab = "overview") => {
    navigate(`c=${cik}${tab !== "overview" ? `/${tab}` : ""}`);
  }, [navigate]);

  // Per-company latest close + day change, keyed by cik (for the sidebar prices).
  const priceMap = useMemo(() => new Map(summaries.map((s) => [s.cik, s])), [summaries]);

  // Ingested = data already in the warehouse; the rest of the watchlist is pending.
  const ingestedCiks = useMemo(() => new Set(companies.map((c) => c.cik)), [companies]);
  const ingestedMap  = useMemo(() => new Map(companies.map((c) => [c.cik, c])), [companies]);

  // The personal watchlist rendered as Company rows (enriched where ingested).
  const watchCompanies = useMemo<Company[]>(() =>
    watch.items.map((it) =>
      ingestedMap.get(it.cik) ?? { cik: it.cik, ticker: it.ticker, name: it.name, sector: null, industry: null },
    ), [watch.items, ingestedMap]);

  // Union used for name/ticker lookups on the company page (covers pending too).
  const lookupCompanies = useMemo<Company[]>(() => {
    const m = new Map<string, Company>(companies.map((c) => [c.cik, c]));
    for (const c of watchCompanies) if (!m.has(c.cik)) m.set(c.cik, c);
    return Array.from(m.values());
  }, [companies, watchCompanies]);

  const handleAdd = useCallback((c: SecCompany) => {
    const item: WatchItem = { cik: c.cik, ticker: c.ticker, name: c.name };
    watch.add(item);
    if (!ingestedCiks.has(c.cik)) void queueWatchlist(item);  // queue for backend ingest
    openCompany(c.cik);
  }, [watch, ingestedCiks, openCompany]);

  const handleRemove = useCallback((cik: string) => {
    watch.remove(cik);
    if (activeCik === cik) navigate("overview");
  }, [watch, activeCik, navigate]);

  // CIKs already on the personal watchlist — drives the Search page's add/open state.
  const watchedCiks = useMemo(() => new Set(watchCompanies.map((c) => c.cik)), [watchCompanies]);

  // New filings since the user's previous visit (drives the Feed nav badge).
  const newFilings = useMemo(
    () => filings.filter((f) => seen.isNew(f.filed_at)).length,
    [filings, seen],
  );

  // New headlines since the user's previous visit (drives the News nav badge).
  const newNews = useMemo(
    () => news.filter((n) => seen.isNew(n.published_at)).length,
    [news, seen],
  );

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: "var(--fg-4)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        companies={watchCompanies} filings={filings}
        activeCik={activeCik} view={view}
        ingestedCiks={ingestedCiks} prices={priceMap}
        onCompany={(cik) => openCompany(cik)}
        onOverview={() => navigate("overview")}
        onSearch={() => navigate("search")}
        onFeed={() => navigate("feed")}
        onNews={() => navigate("news")}
        onCalendar={() => navigate("calendar")}
        onManagers={() => navigate("managers")}
        onIpos={() => navigate("ipos")}
        onReddit={() => navigate("reddit")}
        onCongress={() => navigate("congress")}
        onCot={() => navigate("cot")}
        onGuide={() => navigate("guide")}
        onRemove={handleRemove}
        newFilings={newFilings}
        newNews={newNews}
      />
      <main className="main-area">
        <TopBar watched={watchedCiks} onSelect={handleAdd} />
        <div className="page-scroll">
          <div key={view + activeCik + activeTab} className="page-content">
            {view === "overview" && (
              <OverviewPage companies={watchCompanies} filings={filings} onCompany={openCompany} isNew={seen.isNew} />
            )}
            {view === "search" && (
              <SearchPage
                secIndex={secIndex} watched={watchedCiks} ingestedCiks={ingestedCiks}
                onAdd={handleAdd} onCompany={openCompany}
              />
            )}
            {view === "feed" && (
              <FeedPage filings={filings} onCompany={openCompany} />
            )}
            {view === "news" && (
              <NewsPage news={news} onCompany={openCompany} />
            )}
            {view === "calendar" && (
              <CalendarView companies={watchCompanies} onCompany={openCompany} />
            )}
            {view === "managers" && (
              <ManagersPage companies={watchCompanies} onCompany={openCompany} />
            )}
            {view === "ipos" && <IposPage />}
            {view === "reddit" && (
              <RedditPage companies={watchCompanies} onCompany={openCompany} />
            )}
            {view === "congress" && (
              <CongressPage companies={watchCompanies} onCompany={openCompany} />
            )}
            {view === "cot" && <CotPage />}
            {view === "guide" && <GuidePage />}
            {view === "company" && activeCik && (
              <CompanyPage
                cik={activeCik} tab={activeTab} companies={lookupCompanies}
                pending={!ingestedCiks.has(activeCik)}
                onTab={(tab) => openCompany(activeCik, tab)}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
