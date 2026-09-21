"use client";
// Root dashboard shell — owns the path router (History API, clean URLs), the one-time initial data load
// (companies, recent filings, reference data, SEC index), the Realtime filings
// subscription, and the personal-watchlist state. Everything visual lives in
// views/ (top-level views + the company tabs) and components/ (shared atoms);
// this file only wires data + routing into them. See CLAUDE.md "Splitting page.tsx".
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";

// NavBar + WatchlistDock + Overview are the first paint, so they load eagerly. Every
// other view is code-split: only the one the user routes to is fetched, keeping the
// initial bundle small (the heavy views — Managers/charts, the company tabs — never
// ship on first load). ssr:false matches the static-export + Realtime client model.
import { NavBar } from "../views/NavBar";
import { WatchlistDock } from "../views/WatchlistDock";
import { OverviewPage } from "../views/OverviewPage";
import { companyPath, parseLegacyHash, parsePath, routePath, viewPath, type Route } from "../lib/router";
import { ViewSkeleton } from "../components/Skeletons";
import { Toasts } from "../components/Toast";
const viewLoading = () => <ViewSkeleton />;
const SearchPage = dynamic(() => import("../views/SearchPage").then((m) => ({ default: m.SearchPage })), { ssr: false, loading: viewLoading });
const FeedPage = dynamic(() => import("../views/FeedPage").then((m) => ({ default: m.FeedPage })), { ssr: false, loading: viewLoading });
const NewsPage = dynamic(() => import("../views/NewsPage").then((m) => ({ default: m.NewsPage })), { ssr: false, loading: viewLoading });
const CalendarView = dynamic(() => import("../views/CalendarView").then((m) => ({ default: m.CalendarView })), { ssr: false, loading: viewLoading });
const ManagersPage = dynamic(() => import("../views/ManagersPage").then((m) => ({ default: m.ManagersPage })), { ssr: false, loading: viewLoading });
const IposPage = dynamic(() => import("../views/IposPage").then((m) => ({ default: m.IposPage })), { ssr: false, loading: viewLoading });
const RedditPage = dynamic(() => import("../views/RedditPage").then((m) => ({ default: m.RedditPage })), { ssr: false, loading: viewLoading });
const CongressPage = dynamic(() => import("../views/CongressPage").then((m) => ({ default: m.CongressPage })), { ssr: false, loading: viewLoading });
const CotPage = dynamic(() => import("../views/CotPage").then((m) => ({ default: m.CotPage })), { ssr: false, loading: viewLoading });
const OptionsPage = dynamic(() => import("../views/OptionsPage").then((m) => ({ default: m.OptionsPage })), { ssr: false, loading: viewLoading });
const TrendsPage = dynamic(() => import("../views/TrendsPage").then((m) => ({ default: m.TrendsPage })), { ssr: false, loading: viewLoading });
const GuidePage = dynamic(() => import("../views/GuidePage").then((m) => ({ default: m.GuidePage })), { ssr: false, loading: viewLoading });
const CompanyPage = dynamic(() => import("../views/company/CompanyPage").then((m) => ({ default: m.CompanyPage })), { ssr: false, loading: viewLoading });

// Hover-intent preloading: the sidebar calls this when the pointer reaches a nav
// item or a watchlist row, so the code-split chunk is already cached by the click.
// Imports are cached by the bundler, so repeat calls are free.
const PRELOAD: Partial<Record<MainView, () => Promise<unknown>>> = {
  search: () => import("../views/SearchPage"),
  feed: () => import("../views/FeedPage"),
  news: () => import("../views/NewsPage"),
  calendar: () => import("../views/CalendarView"),
  managers: () => import("../views/ManagersPage"),
  ipos: () => import("../views/IposPage"),
  reddit: () => import("../views/RedditPage"),
  congress: () => import("../views/CongressPage"),
  cot: () => import("../views/CotPage"),
  options: () => import("../views/OptionsPage"),
  trends: () => import("../views/TrendsPage"),
  guide: () => import("../views/GuidePage"),
  company: () => import("../views/company/CompanyPage"),
};
const preloadView = (v: MainView) => { void PRELOAD[v]?.(); };
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
import { useToasts } from "../lib/hooks/useToasts";
import { loadSecIndex, type SecCompany } from "../lib/domain/secIndex";
import type { Company, Filing, NewsItem, MainView, CompanyTab, CompanySummary } from "../lib/types";

type NavView = Exclude<MainView, "company">;

// Watchlist dock visibility is remembered (wide viewports); on narrow viewports the
// same flag drives the off-canvas drawer and is reset on every route change.
const DOCK_KEY = "summa.dock.v1";
const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 1100px)").matches;

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt]     = useState(0);       // bumps to retry the initial load
  const [dockOpen, setDockOpen]   = useState(true);    // watchlist dock (panel / drawer)
  const watch = useWatchlist();
  const seen = useLastSeen();
  const toasts = useToasts();

  // Dock: open by default on wide viewports (remembered), closed on narrow ones.
  useEffect(() => {
    if (isNarrow()) { setDockOpen(false); return; }
    try { setDockOpen(localStorage.getItem(DOCK_KEY) !== "0"); } catch { /* ignore */ }
  }, []);
  const toggleDock = useCallback(() => {
    setDockOpen((v) => {
      const next = !v;
      if (!isNarrow()) { try { localStorage.setItem(DOCK_KEY, next ? "1" : "0"); } catch { /* ignore */ } }
      return next;
    });
  }, []);

  // Path routing (History API). On load: a legacy `#…` link is translated to its
  // clean path; an unknown path falls back to the dashboard (URL corrected in place).
  useEffect(() => {
    function apply(r: Route) {
      if (r.kind === "view") { setView(r.view); setActiveCik(null); }
      else { setView("company"); setActiveCik(r.cik); setActiveTab(r.tab); }
    }
    function read() {
      const legacy = parseLegacyHash(window.location.hash);
      if (legacy) { window.history.replaceState(null, "", routePath(legacy)); apply(legacy); return; }
      const r = parsePath(window.location.pathname);
      if (r) { apply(r); return; }
      window.history.replaceState(null, "", "/");
      apply({ kind: "view", view: "overview" });
    }
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  // Same-origin links (e.g. the Data Guide's page list) navigate in-app instead of
  // reloading the static export. Modified clicks and external targets are left alone.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      if (!parsePath(href)) return;
      e.preventDefault();
      if (href !== window.location.pathname) { window.history.pushState(null, "", href); window.dispatchEvent(new PopStateEvent("popstate")); }
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // One key per route. Nav views remember their scroll position (so Back from a
  // company lands where you left the table); company routes always start at the top.
  const routeKey = view === "company" && activeCik ? companyPath(activeCik, activeTab) : viewPath(view as NavView);
  const routeRef = useRef(routeKey);
  routeRef.current = routeKey;
  const scrollMemo = useRef(new Map<string, number>());

  useEffect(() => {
    if (loading) return;
    const el = document.querySelector<HTMLElement>(".page-scroll");
    if (!el) return;
    const onScroll = () => scrollMemo.current.set(routeRef.current, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [loading]);

  // Any route change closes the narrow-viewport drawer and repositions the page.
  useEffect(() => {
    if (isNarrow()) setDockOpen(false);
    const el = document.querySelector<HTMLElement>(".page-scroll");
    if (!el) return;
    const saved = routeKey.startsWith("/company/") ? 0 : (scrollMemo.current.get(routeKey) ?? 0);
    const raf = requestAnimationFrame(() => el.scrollTo({ top: saved }));
    return () => cancelAnimationFrame(raf);
  }, [routeKey]);

  // Initial load. Reference data (profiles/themes/entities) is fetched once here
  // and matched client-side thereafter — no per-row or per-page reads.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    Promise.all([
      fetchCompanies(), fetchFilings(200),
      fetchCompanyProfiles(), fetchCompanyThemes(), fetchEntities(),
    ]).then(([cos, fils, profiles, themes, entities]) => {
      if (cancelled) return;
      loadProfiles(profiles, themes);
      loadEntities(entities);
      setCompanies(cos);
      setFilings(fils);
      setLoading(false);
    }).catch((e: unknown) => {
      // Without this the splash spins forever on a network / Supabase outage.
      if (cancelled) return;
      setLoadError(e instanceof Error && e.message ? e.message : "Could not reach the data warehouse.");
    });
    // Precomputed price summaries (one tiny row/company) power the watchlist
    // last-close + day-change shown in the sidebar. Loaded separately so the
    // first paint isn't blocked on it.
    fetchCompanySummaries().then(setSummaries);
    // News is loaded here (not just inside the News view) so the nav badge can
    // count new headlines app-wide, and Realtime keeps it live in every view.
    fetchNews(500).then(setNews);
    return () => { cancelled = true; };
  }, [attempt]);

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

  // pushState + a synthetic popstate so the single `read()` above stays the one
  // place that turns a URL into state.
  const navigate = useCallback((path: string) => {
    if (path === window.location.pathname) return;
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const goView = useCallback((v: NavView) => navigate(viewPath(v)), [navigate]);
  const openCompany = useCallback((cik: string, tab: CompanyTab = "overview") => {
    navigate(companyPath(cik, tab));
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

  const handleAdd = useCallback((c: SecCompany, open = true) => {
    const item: WatchItem = { cik: c.cik, ticker: c.ticker, name: c.name };
    const already = watch.items.some((i) => i.cik === c.cik);
    watch.add(item);
    if (!already) {
      const ingested = ingestedCiks.has(c.cik);
      if (!ingested) void queueWatchlist(item);  // queue for backend ingest
      toasts.push(
        ingested
          ? `${c.ticker} added to your watchlist`
          : `${c.ticker} added — its data arrives after the next pipeline run (≈10 min)`,
        { tone: "success", action: open ? undefined : { label: "Open", onClick: () => openCompany(c.cik) } },
      );
    }
    if (open) openCompany(c.cik);
  }, [watch, ingestedCiks, openCompany, toasts]);

  // "Track" from a market-wide surface (Congress buys): resolve the ticker in the
  // SEC index and add it to the watchlist in place — no navigation.
  const handleTrack = useCallback((ticker: string) => {
    const t = ticker.toUpperCase();
    loadSecIndex().then((idx) => {
      const hit = idx.find((c) => c.ticker.toUpperCase() === t);
      if (hit) handleAdd(hit, false);
      else toasts.push(`${t} isn't in the SEC company index — it may be a fund, ETF or foreign listing`, { tone: "warn" });
    });
  }, [handleAdd, toasts]);

  const handleRemove = useCallback((cik: string) => {
    const item = watch.items.find((i) => i.cik === cik);
    watch.remove(cik);
    if (activeCik === cik) navigate("/");
    if (item) {
      toasts.push(`${item.ticker} removed from your watchlist`, {
        action: { label: "Undo", onClick: () => watch.add(item) },
      });
    }
  }, [watch, activeCik, navigate, toasts]);

  // CIKs already on the personal watchlist — drives the Search page's add/open state.
  const watchedCiks = useMemo(() => new Set(watchCompanies.map((c) => c.cik)), [watchCompanies]);

  // Terminal-style keys, active anywhere outside a text field:
  //   [ / ]  — previous / next watchlist company (from a nav view: last / first)
  //   Esc    — back to the overview from a company page
  useEffect(() => {
    function inField(e: KeyboardEvent): boolean {
      const el = e.target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || inField(e)) return;
      if (e.key === "[" || e.key === "]") {
        if (watchCompanies.length === 0) return;
        e.preventDefault();
        const i = activeCik ? watchCompanies.findIndex((c) => c.cik === activeCik) : -1;
        const n = watchCompanies.length;
        const next = e.key === "]" ? (i + 1) % n : (i - 1 + n) % n;
        openCompany(watchCompanies[next].cik, activeCik ? activeTab : "overview");
      } else if (e.key === "Escape" && view === "company") {
        navigate("/");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [watchCompanies, activeCik, activeTab, view, openCompany, navigate]);

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
      <div className="app-splash" role="status" aria-live="polite">
        <div className="app-splash-brand">Summa<span className="dot">.</span></div>
        {loadError ? (
          <>
            <div className="app-splash-error">Couldn’t load the warehouse — {loadError}</div>
            <button className="btn-primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </>
        ) : (
          <>
            <div className="app-splash-bar"><span /></div>
            <div className="app-splash-note">Loading your watchlist and the latest filings…</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <NavBar
        view={view} watched={watchedCiks} onSelect={handleAdd}
        onNavigate={goView} onPreload={preloadView}
        onCompany={openCompany} filings={filings} news={news} isNew={seen.isNew}
        newFilings={newFilings} newNews={newNews}
        watchCount={watchCompanies.length}
        dockOpen={dockOpen} onToggleDock={toggleDock}
      />
      <div className={`app-body${dockOpen ? " with-dock" : ""}`}>
      <main className="main-area">
        <div className="page-scroll">
          {/* Keyed by view + company only: switching a company tab must not remount
              CompanyPage (which would refetch every dataset and flash skeletons). */}
          <div key={view + (activeCik ?? "")} className="page-content">
            {view === "overview" && (
              <OverviewPage
                companies={watchCompanies} filings={filings} onCompany={openCompany} isNew={seen.isNew}
                newFilings={newFilings} newNews={newNews} onNavigate={goView} onTrack={handleTrack}
              />
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
              <CongressPage companies={watchCompanies} onCompany={openCompany} onTrack={handleTrack} />
            )}
            {view === "cot" && <CotPage />}
            {view === "options" && <OptionsPage onCompany={openCompany} />}
            {view === "trends" && <TrendsPage onCompany={openCompany} />}
            {view === "guide" && <GuidePage />}
            {view === "company" && activeCik && (
              <CompanyPage
                cik={activeCik} tab={activeTab} companies={lookupCompanies}
                pending={!ingestedCiks.has(activeCik)}
                onTab={(tab) => openCompany(activeCik, tab)}
                onBack={() => navigate("/")}
              />
            )}
          </div>
        </div>
      </main>
      <WatchlistDock
        companies={watchCompanies} filings={filings}
        activeCik={activeCik} view={view}
        ingestedCiks={ingestedCiks} prices={priceMap}
        onCompany={(cik, tab) => openCompany(cik, tab)}
        onNavigate={goView}
        onRemove={handleRemove}
        onPreload={preloadView}
        newFilings={newFilings}
        newNews={newNews}
        open={dockOpen}
        onClose={toggleDock}
      />
      </div>
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}
