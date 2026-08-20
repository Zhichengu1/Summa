# Summa — Claude Working Reference

This file is read by Claude Code at the start of every session. It captures the
architecture, invariants, conventions, and known gaps needed to work on this
project without re-deriving context. Keep it in sync with the code — if you
change the structure, update this file in the same change.

---

## Project Summary

Summa is a zero-cost SEC filing **data warehouse** plus a 13f.info-style
research dashboard. GitHub Actions runs a Python ingest (`backend/main.py`) every
10 minutes. For each company on the watchlist it pulls multiple SEC datasets via
[edgartools](https://github.com/dgunning/edgartools) — fundamentals (XBRL), the
filings feed, insider transactions, institutional holdings, beneficial ownership,
proposed sales, earnings, corporate events, late filings, securities offerings —
plus end-of-day prices, and writes everything to Supabase (Postgres). A Next.js 14
frontend (static export) reads from Supabase through `lib/data/data.ts` (anon key) and
renders an interactive per-company research UI with a live filings feed. On top of those
per-company facts sits **Phase 2, Trend Intelligence** — a cross-company layer that
distils canonical themes from 10-K/10-Q language at ingest and aggregates them into a
ranked "what is the whole universe investing in" board (see the Phase 2 section).

**Core principle:** ingest once, cheaply, and spread the work across runs. Each
cron tick visits a bounded batch of companies, and within a visit each dataset
only refreshes if its own cadence has elapsed. Coverage scales by spreading work
across runs, not by doing more per run.

> **No LLM/AI service is part of this project.** Every signal is computed by
> deterministic code over the warehouse; nothing is generated or summarized by a model.
> (The former Gemini enrichment channel was removed on 2026-08-13 — do not reintroduce a
> provider without an explicit decision.) Narrative *is* produced, but by template:
> `recap.py` assembles the daily prose recap from stored numbers, so the same rows always
> yield the same sentences. Written summaries belong there, not in a model.
>
> The one optional out-of-band channel is `enrichment/discord_notify.py`, which is
> **not** part of the Phase-1 ingest path — with two exceptions:
> `news_ingest.py` calls `discord_notify.notify_news()` for genuinely-new headlines,
> and `filings_ingest.py` calls `discord_notify.notify_filings()` for just-filed
> feed documents (8-K/10-K/10-Q/DEF 14A within `FILING_ALERT_RECENCY_DAYS`). Both
> are opt-in (no-op unless `DISCORD_WEBHOOK_URL` is set), fail-soft (a webhook error
> never breaks ingest), and suppressed on a company's first-ever seed so they only
> ever alert on the incremental delta.

---

## Repository Layout

```
Summa/
├── CLAUDE.md                     ← this file
├── README.md                     ← public-facing documentation
├── schema.sql                    ← run once in the Supabase SQL Editor (idempotent)
│
├── backend/                      ← Python pipeline (runs in GitHub Actions)
│   ├── main.py                   ← entry point; staged-cadence orchestrator
│   ├── db.py                     ← Supabase service-role client + upsert helpers
│   ├── watchlist.py              ← SEED list + get_active_watchlist() (SEED ∪ watchlist table)
│   ├── edgar_cache.py            ← get_company(cik): per-run shared edgartools Company cache
│   ├── news_score.py             ← composite catalyst scorer: event×source×fundamentals×directness×move (company + market news)
│   ├── recap.py                  ← PURE prose builder: company_summary rows → the daily narrative recap (deterministic templates, no LLM) + the shared next-earnings estimator
│   ├── trend_aggregator.py       ← PHASE 2 (global): theme_mentions → theme_trends — breadth × capital momentum, stage, templated summary
│   ├── ingest/                   ← per-company dataset ingestors (from ingest import …)
│   │   ├── data_ingest.py        ← fundamentals (XBRL) → financial_facts
│   │   ├── filings_ingest.py     ← narrative filings feed → filings
│   │   ├── price_ingest.py       ← Yahoo EOD bars → daily_prices (non-SEC source)
│   │   ├── options_ingest.py     ← CBOE delayed options chain → options_snapshots (non-SEC source)
│   │   ├── news_ingest.py        ← Google News RSS → company_news (per-company, non-SEC source)
│   │   ├── market_news_ingest.py ← GLOBAL curated market-mover RSS (SEC/Fed/FDA/PRN) → market_news
│   │   ├── reddit_trends_ingest.py ← GLOBAL daily Reddit most-discussed tickers (ApeWisdom/Tradestie) → reddit_trends + Discord digest
│   │   ├── congress_trades_ingest.py ← GLOBAL congressional STOCK-Act trades (Kadoa monitor JSON) → congress_trades + Discord new-disclosure/consensus digest
│   │   ├── cot_ingest.py         ← GLOBAL weekly CFTC Commitments of Traders (public reporting API) → cot_reports + Discord positioning digest
│   │   ├── summary_ingest.py     ← precomputes company_summary (price+technicals+activity)
│   │   ├── theme_taxonomy.py     ← PHASE 2: the curated canonical theme vocabulary + keyword matcher (stdlib only)
│   │   ├── theme_ingest.py       ← PHASE 2: keyword pass over new 10-K/10-Q Business + MD&A → theme_mentions
│   │   ├── reference_ingest.py   ← SIC industry/theme → company_profiles / company_themes
│   │   └── entity_ingest.py      ← seeds/entities.yaml → entities registry (global, runs once)
│   ├── extractors/               ← SEC-form extractors (from extractors import …)
│   │   ├── event_extractor.py    ← earnings/corporate events/late filings/offerings
│   │   ├── insider_extractor.py  ← Form 4 → insider_transactions
│   │   ├── institutional_extractor.py ← 13F-HR → institutional_holdings / manager_portfolios
│   │   ├── ownership_extractor.py ← SC 13D/13G + Form 144 → beneficial_ownership / proposed_sales
│   │   └── ipo_extractor.py       ← GLOBAL: recent S-1/F-1/424B/RW across the market → ipos
│   ├── enrichment/               ← OPTIONAL notification channel (not in the ingest path)
│   │   └── discord_notify.py     ← Discord alerts (filing embeds + notify_news for new headlines)
│   ├── tools/                    ← standalone maintenance scripts (python -m tools.<name>)
│   │   ├── build_sec_index.py    ← rebuilds frontend/public/sec-companies.json (stdlib only)
│   │   ├── refresh_news.py       ← lightweight news-only entry point (edgar-free; summa-news */5)
│   │   ├── daily_brief.py        ← daily watchlist brief → Discord (edgar-free; company_summary + earnings radar)
│   │   ├── daily_recap.py        ← weekday-evening prose recap → Discord (edgar-free; thin wrapper over recap.py; --dry-run prints without posting)
│   │   ├── reddit_trends.py      ← daily Reddit trending-stocks digest → Discord (edgar-free; thin wrapper over ingest/reddit_trends_ingest)
│   │   ├── congress_trades.py    ← congressional-trades refresh (edgar-free; thin wrapper over ingest/congress_trades_ingest)
│   │   ├── cot.py                ← weekly CFTC COT refresh (edgar-free; thin wrapper over ingest/cot_ingest)
│   │   ├── cleanup.py            ← monthly retention maintenance
│   │   └── backfill_manager_quarters.py ← seeds prior 13F quarters so the Institutional Investors latest-vs-prior comparison works immediately (idempotent)
│   ├── seeds/                    ← entities.yaml, profiles.yaml (curated reference data)
│   ├── docs/                     ← backend design docs (REFERENCE_DATA_SCOPE.md)
│   ├── requirements.txt
│   └── .env.example
│
├── .github/workflows/
│   ├── summa-pipeline.yml         ← */10 min ingest (main.py)
│   ├── summa-news.yml             ← */5 min fast news refresh: market feeds + per-company Google News via --company (tools.refresh_news; requirements-news.txt, edgar-free)
│   ├── summa-brief.yml            ← weekday-morning Discord watchlist brief (python -m tools.daily_brief; requirements-news.txt)
│   ├── summa-recap.yml            ← weekday-evening (22:30 UTC) Discord prose recap of the session (python -m tools.daily_recap; requirements-news.txt; workflow_dispatch `dry_run` input)
│   ├── summa-reddit.yml           ← Reddit trending-stocks: 13:15 UTC daily full digest + weekday 16:15/20:15 UTC intraday refresh with surge-only alerts (python -m tools.reddit_trends; requirements-news.txt)
│   ├── summa-congress.yml         ← congressional trades 2×/day (11:25/22:25 UTC; python -m tools.congress_trades; requirements-news.txt) + Discord digest when new disclosures land
│   ├── summa-cot.yml              ← weekly CFTC COT (Fri 21:05 UTC after the ~3:30pm ET release + Mon 22:05 UTC holiday catch-up; python -m tools.cot; requirements-news.txt) + Discord digest when a new report week lands
│   ├── summa-cleanup.yml          ← monthly retention (python -m tools.cleanup)
│   ├── summa-secindex.yml         ← weekly SEC index rebuild (python -m tools.build_sec_index)
│   ├── summa-13f-quarter.yml      ← post-deadline (16th of Feb/May/Aug/Nov) 13F quarter roll-forward (python -m tools.backfill_manager_quarters)
│   ├── keepalive.yml              ← weekly heartbeat commit (keeps crons alive)
│   ├── ci.yml                     ← push/PR quality gate: frontend tsc --noEmit + backend compileall
│   └── secret-scan.yml            ← push/PR gitleaks credential scan (.gitleaks.toml)
│
└── frontend/                      ← Next.js 14 static export
    ├── app/
    │   ├── page.tsx               ← thin root shell: hash router + initial data load + layout (~190 lines)
    │   ├── layout.tsx, globals.css, error.tsx, not-found.tsx
    ├── components/                ← shared presentational atoms (CSS-classes only, no data deps),
    │   │                            grouped by kind. Core atoms sit at the root; clustered
    │   │                            families live in subfolders:
    │   │                            (root)   DataTable, InfoTip, Skeletons, NameContext,
    │   │                                     SignalCard, TapeRow, Scorecard
    │   ├── charts/                    charts, charts.lazy, Sparkline (viz primitives)
    │   ├── badges/                    FormBadge, EventClassBadge, GuidanceBadge, DirMark, CompanyMark
    │   └── strips/                    PriceStrip, TechStrip, KpiTile (metric strips)
    ├── views/                     ← top-level page views (own their data/effects):
    │   │                            Sidebar, TopBar (command bar: SEC-index ticker search + market
    │   │                            session status/ET clock), OverviewPage, ScannerSection (+ MomentumScanner),
    │   │                            SearchPage, FeedPage, NewsPage, CalendarView, ManagersPage, IposPage,
    │   │                            RedditPage (Reddit Buzz leaderboard over reddit_trends),
    │   │                            CongressPage (consensus buys/sells over congress_trades),
    │   │                            CotPage (COT futures positioning index over cot_reports),
    │   │                            OptionsPage (Options Radar: calls-vs-puts bias + structure over
    │   │                            options_snapshots), TrendsPage (PHASE 2 Trend Intelligence:
    │   │                            cross-company theme leaderboard over theme_trends), GuidePage
    │   └── company/               ← the per-company page + its tabs:
    │                                CompanyPage, CompanyOverviewTab, StrategyTab, FundamentalsTab,
    │                                PeersTab, OwnershipTab, CatalystsTab, FilingsTab, NewsTab, companyAux.ts (shared CompanyAux)
    ├── lib/                       ← data access + domain logic, grouped by role (see below)
    │   ├── data/                    supabase.ts, data.ts, watchlist.ts
    │   ├── hooks/                   useWatchlist.ts, useLastSeen.ts, useWatchlistPulse.ts
    │   ├── domain/                  fundamentals, pulse, scorecard, technicals, valuation,
    │   │                            insider, catalysts, prices, options, trends, taxonomy, entities, glossary, secIndex
    │   ├── utils/                   format.ts, url.ts
    │   └── types.ts                 row + view-routing types (stays at lib root, imported everywhere)
    └── public/sec-companies.json  ← bundled SEC company index (universal search)
```

### Frontend `lib/` modules

`lib/` is grouped by role — **`data/`**: `supabase.ts` (anon client), `data.ts` (all fetch* +
`subscribeFilings` / `subscribeNews` Realtime), `watchlist.ts` (`CORE_WATCHLIST` seed). **`hooks/`**:
`useWatchlist.ts` / `useLastSeen.ts` / `useWatchlistPulse.ts` (watchlist-wide catalyst fetch
shared by Scanner + Calendar). **`domain/`** (pure logic): `fundamentals.ts` · `pulse.ts`
(tape/signals) · `taxonomy.ts` · `entities.ts` · `insider.ts` · `prices.ts` (incl.
`reactionStats`) · `valuation.ts` · `technicals.ts` · `catalysts.ts` (next-earnings estimate) ·
`scorecard.ts` (`buildScorecard` + Grade types) · `options.ts` (`buildOptionsRadar` — options flow/pricing →
directional bias + suggested structure) · `trends.ts` (`buildTrends` / `nextTrend` / `capitalBySector` —
theme_trends rows → the ranked cross-company theme board) · `secIndex.ts` · `glossary.ts`. **`utils/`**:
`format.ts` · `url.ts` (`safeHref` guard). **`lib/types.ts`** (row + `MainView`/`CompanyTab`
types) stays at the `lib/` root because it is imported everywhere.

---

## Critical Invariants

Never-negotiate rules. If a proposed change violates one, stop and flag it.

1. **All Supabase writes go through `db.py` helpers** (`upsert` / `upsert_many` /
   the typed `upsert_*`), which centralize on-conflict handling, batch dedupe, and
   error logging. Never call `get_client().table(...).upsert(...)` ad hoc in an
   extractor.
2. **The scraper uses the service_role key (`SUPABASE_KEY`); the frontend uses the
   anon key.** Service role bypasses RLS. Anon has SELECT on warehouse tables and
   SELECT+INSERT on `watchlist` only.
3. **Schema is applied by running `schema.sql` in the Supabase SQL Editor** — it is
   idempotent (safe to re-run). `main.py._preflight()` fails fast if the `companies`
   table is missing.
4. **Staged cadence is the scaling mechanism.** Company-level cap (`INGEST_MAX_PER_RUN`)
   + per-dataset intervals (`DATASET_INTERVALS_H`). Do not replace it with "process
   everything every run."
5. **Optional extractors fail soft.** They run via `_run_optional()` and must no-op
   (or raise `NotImplementedError`) cleanly; a failing extractor must never abort the
   run or block other datasets. A dataset's timestamp is only advanced when it
   actually ran.
6. **No async in the scraper.** edgartools + synchronous calls only. SEC fair-access
   identity is set once via `set_identity(EDGAR_IDENTITY)`.
7. **No raw HTML stored.** Only extracted narrative sections on `filings`, and those
   roll off at 30 days (see Retention).
8. **Frontend is read-only.** No Next.js API routes. The only write path from the UI
   is queueing a company into the `watchlist` table (`queueWatchlist`). All other
   data flows in through GitHub Actions.
9. **All credentials via environment variables.** Nothing hardcoded. Backend reads
   `backend/.env` (gitignored); frontend reads `frontend/.env.local` (gitignored).
10. **Non-SEC data sources are all free/keyless and fail-soft:** Yahoo Finance EOD
    prices (`price_ingest.py`), Google News RSS per-company headlines
    (`news_ingest.py`), and the curated market-mover RSS feeds in
    `market_news_ingest.py` (Federal Reserve press/speeches/testimony · BEA macro data ·
    SEC · FDA · FTC · CFTC · White House executive actions · PR Newswire → the global
    `market_news` "Top Intelligence" feed), and the Reddit trending-stocks aggregators
    in `reddit_trends_ingest.py` (ApeWisdom mention ranks + Tradestie WSB sentiment →
    `reddit_trends` + a daily Discord digest; reddit.com itself is never scraped —
    datacenter IPs get 403'd and the official API needs OAuth), and the congressional
    STOCK-Act trade feed in `congress_trades_ingest.py` (the keyless static JSON behind
    Kadoa's open-source Congress Trading Monitor — normalized House PTR + Senate eFD
    disclosures → `congress_trades`; scraping the official sites directly would need
    session handling / PDF parsing), and the weekly CFTC Commitments of Traders report
    in `cot_ingest.py` (the keyless CFTC Public Reporting API / Socrata, legacy
    futures-only dataset 6dca-aqww → `cot_reports` for ~28 curated major futures
    markets), and the options chain in `options_ingest.py` (CBOE's free keyless
    delayed-quotes JSON, `cdn.cboe.com/api/global/delayed_quotes/…` — the WHOLE chain for
    an underlying in one request with IV + greeks, plus `_VIX.json` for the volatility
    regime → `options_snapshots`; ~15-min delayed, which is fine for a once-or-twice-daily
    positioning snapshot, and it is the exchange's own data rather than a scrape).
    SEC EDGAR remains the
    source for all structured filings data. Any new source must keep the same contract: keyless,
    zero-cost, and fail-soft (a dead feed logs and is skipped, never aborting a run).
    (Reuters/Bloomberg are intentionally NOT added — no free RSS; their coverage
    already reaches `company_news` via Google News.)
11. **GitHub Actions Node runtime:** every workflow sets
    `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"` (Node 20 → 24 migration). Keep new
    workflows consistent.

---

## Python Code Conventions

- Python 3.10+ features permitted (union types with `|`, `match` statements).
- Type hints on every function signature; one-line docstring on every public function.
- `logging` module only — never `print()` in pipeline code.
- `load_dotenv()` is called in `db.py` (and `main.py`); other modules import `db`.
- Supabase access always via the singleton from `db.get_client()`, and writes via the
  `db.py` upsert helpers.
- Extractors expose `ingest_<dataset>(cik, ticker[, name])` and are invoked through
  `main._run_optional()`.
- **edgartools `Company` always via `edgar_cache.get_company(cik)`, never `Company(cik)`
  directly.** Constructing it per dataset reloads the company's full filings index from
  EDGAR each time; `get_company` shares one `Company` per CIK across all ingestors for the
  run, so a company due for N datasets loads its index once (1 EDGAR request, not N) and the
  rest filter it in-memory. The cache is per-process, so it resets each Actions run.
- **Package layout & imports.** Scripts are grouped by role under `backend/`:
  `ingest/` (per-company ingestors), `extractors/` (SEC-form parsers), `enrichment/`
  (optional Discord alerts), `tools/` (standalone maintenance). `main.py`, `db.py`,
  `watchlist.py` stay at the `backend/` root. Because the root is always on `sys.path`
  (the entry point `main.py` runs from `backend/`), modules in the subpackages still
  import the core flat — `import db`, `from watchlist import …`. `main.py` imports the
  rest via the subpackage, e.g. `from ingest import data_ingest`,
  `from extractors import insider_extractor`. The `tools/` scripts are run as modules
  from `backend/`: `python -m tools.cleanup`, `python -m tools.build_sec_index` (NOT
  `python tools/cleanup.py`, which puts `tools/` on the path instead of `backend/` and
  breaks `import db`). A `tools/`-relative `__file__` path is two parents up from the
  repo root; an `ingest/`- or `extractors/`-relative one is one parent up from `backend/`.

---

## TypeScript / Frontend Conventions

- Strict mode, no `any`. Functional components only.
- `lib/data/supabase.ts` is the only place the anon client is created; `lib/data/data.ts`
  is the only data-access layer (no API routes).
- `useMemo` for derived/filtered arrays.
- Design tokens via CSS custom properties in `globals.css`; component-specific layout
  via inline styles. No hardcoded hex in JSX where a token exists.
- **Design language (2026-07):** modern trading platform — deep-navy surfaces
  (`--bg-0 #0a0e17` → panels `#111726`), electric-blue accent (`--accent #3b82f6`),
  Inter (`--font-sans`) for UI with JetBrains Mono reserved for numerals/prices,
  soft radius-10/12 panels with `--shadow-1`, glass (blur) top bar + sticky company
  hero, segmented-control tabs. Chart series palette in `components/charts/charts.tsx`
  is fixed-order and CVD-validated against the `#111726` panel
  (blue `#3b82f6` → amber `#d97706` → teal `#0d9488` → violet `#8b5cf6` → pink `#db2777`);
  `--pos #22c55e` / `--neg #ef4444` are status colors, never reused as series. The
  scroll container is `.page-scroll` (inside `.main-area`, below the fixed `.topbar`) —
  sticky elements (`.company-hero`, `.news-day`) stick to it, not the window.
- No `dangerouslySetInnerHTML`. URL props pass through a `safeHref`-style guard.

### Component / view structure

`app/page.tsx` is now a thin root shell (~190 lines): hash router, the one-time
initial data load, the Realtime filings subscription, the personal-watchlist state,
and the top-level layout that routes a `MainView` to a view. Everything visual lives
in `components/` and `views/`. Three layers, imported strictly downward
(`app → views → components → lib`):

- **Atoms → `components/`**: pure presentational, CSS-classes-only, no data fetching
  (e.g. `CompanyMark`, `FormBadge`, `SignalCard`, `Scorecard`). Grouped by kind — core
  atoms at the root, families in `components/charts/`, `components/badges/`,
  `components/strips/`. May take primitive/row props; render logic only. Shared freely by views.
- **Views → `views/`**: a top-level dashboard view that owns its own data/effects/derived
  state (e.g. `OverviewPage`, `FeedPage`, `CalendarView`). The per-company page and its
  tabs live under `views/company/`; the tabs share the `CompanyAux` bundle fetched once in
  `CompanyPage` (`views/company/companyAux.ts`) — never refetch per tab.
- **Pure logic → `lib/`**: anything non-visual, grouped by role —
  `lib/data/` (Supabase + fetchers), `lib/hooks/` (React hooks), `lib/domain/` (pure
  logic, e.g. `buildScorecard` in `domain/scorecard.ts`), `lib/utils/` (e.g. `safeHref`
  in `utils/url.ts`). Components/views import it.

Conventions: imports are relative (matching the existing files), not the `@/` alias.
Each view/atom that uses hooks or browser APIs carries `"use client"`. View-routing
types (`MainView`, `CompanyTab`) live in `lib/types.ts` (kept at the `lib/` root). **Run `npx tsc --noEmit` in
`frontend/` after any move** to confirm a clean extraction; a leaf-first order keeps the
graph acyclic.

---

## Database Schema

Run `schema.sql` once in the Supabase SQL Editor (idempotent). Tables:

| Table | Conflict key | Purpose |
|---|---|---|
| `companies` | `cik` | Watchlist company metadata + `last_ingested_at`, `dataset_state` (jsonb) driving the scheduler |
| `financial_facts` | (cik, statement, period, …) | XBRL fundamentals (income/balance/cash-flow) |
| `filings` | `accession_number` | Narrative filings feed (10-K/10-Q/8-K/DEF 14A) + section text |
| `insider_transactions` | accession/txn | Form 4 open-market buys/sells |
| `institutional_holdings` | cik+period | 13F-HR positions in watchlist companies (per-company holders view) |
| `manager_portfolios` | manager_cik+period+cusip | Each tracked 13F manager's top-N holdings across **all** stocks + their quarter-over-quarter buy/sell move per position (the Managers view) |
| `beneficial_ownership` | accession | SC 13D/13G ≥5% stakes |
| `proposed_sales` | accession | Form 144 proposed insider sales |
| `earnings_events` | cik+date | 8-K Item 2.02 results/guidance |
| `corporate_events` | accession | Classified material 8-K events |
| `late_filings` | accession | NT 10-K / NT 10-Q notices |
| `securities_offerings` | accession | S-1/S-3/424B issuance (watchlist companies) |
| `ipos` | accession | GLOBAL active-IPO pipeline: market-wide S-1/F-1/424B/RW lifecycle filings (the IPOs view groups by issuer, ranks by capital raised / gross proceeds, and hides SPAC + sub-$10M micro-offerings by default) |
| `daily_prices` | cik+date | Yahoo EOD bars |
| `company_news` | (cik, guid) | Trader-important Google News headlines per company (recency + importance gated at ingest; 30-day rolling window) |
| `market_news` | `guid` | GLOBAL curated market-mover feed (SEC/Fed/FDA/PRN), importance-filtered (30-day window) |
| `reddit_trends` | trend_date+ticker | GLOBAL daily top-N most-discussed tickers on the investing subreddits (ApeWisdom ranks + optional Tradestie WSB sentiment + persisted Yahoo price context `last_price`/`day_pct`/`off_high_pct`/`off_low_pct`/`is_etf`; 30-day window; surfaced by the Reddit Buzz view via `fetchRedditTrends`) |
| `congress_trades` | `id` (source txn id) | GLOBAL congressional (+ executive-branch) STOCK-Act stock trades from the Kadoa monitor feed (tickered rows only; ~400-day window; surfaced by the Congress view's consensus buys/sells via `fetchCongressTrades`) |
| `cot_reports` | market_code+report_date | GLOBAL weekly CFTC Commitments of Traders positioning for ~28 curated futures markets (legacy futures-only report: spec/commercial/small-trader longs+shorts + precomputed nets; ~1200-day window; surfaced by the COT view's positioning index via `fetchCotReports`, signals derived in `lib/domain/cot.ts`) |
| `options_snapshots` | cik+snapshot_date | One daily options-chain snapshot per watchlist company (CBOE): call/put flow by volume, open interest and PREMIUM ($), IV30 vs 30d realized vol + an IV rank built from this table's own history, 25Δ skew, front/~30d expected move, max pain, VIX, the day's biggest volume-over-OI contracts (`unusual` jsonb), and a tradeable delta ladder (`candidates` jsonb — ~5 strikes/side across a ~30d and ~60d expiry, filtered for a live two-sided quote and ≥25 OI, with quote+greeks+liquidity per contract). The calls-vs-puts decision inputs — the bias score, the suggested structure, and every per-contract economic (breakeven, breakeven-vs-priced-move, cost per delta, decay and bid/ask friction, vertical-spread construction) are DERIVED client-side in `lib/domain/options.ts`, never stored, so the read can be retuned without a re-ingest |
| `theme_mentions` | cik+theme_key+period | PHASE 2 raw material: per-company canonical-theme hits per CALENDAR quarter, distilled at ingest from 10-K/10-Q Business + MD&A (`theme_ingest.py`), with the period's R&D + capex attributed across themes by share of forward-looking language. Written at ingest because the `filings` feed stores no prose and its rows are deleted at 90 days. ~5-year window |
| `theme_trends` | theme_key+period | PHASE 2 aggregate, recomputed WHOLESALE each cycle by `trend_aggregator.py`: per theme per quarter, BREADTH (`company_count` — how many companies cite it, out of the honest `coverage` denominator) against CAPITAL (`capital_flow` — attributed R&D + capex), plus `momentum_score`, `stage`, the leading sector + `sector_flow` split, the `drivers` companies, and a TEMPLATED `summary` sentence built from the row's own numbers. Surfaced by the Trends view via `fetchThemeTrends` |
| `company_profiles` | `cik` | SIC industry/sector |
| `company_themes` | cik+name | Recomputed theme tags (delete+insert per cik) |
| `entities` | `match_key` | Global entity-context registry (seeded) |
| `watchlist` | `cik` | Dynamic ingest queue (anon SELECT+INSERT from the UI) |
| `company_summary` | `cik` | One precomputed row/company (price + technicals + activity) for the watchlist-wide surfaces — see Scaling below |

**RLS:** anon → SELECT on warehouse tables, SELECT+INSERT on `watchlist`. Scraper uses
service_role (bypasses RLS).

**Retention** (`tools/cleanup.py` / `db.py`, monthly): narrative `filings` section text
is nulled at **30 days**; `filings` feed rows are deleted at **90 days**; `daily_prices`
bars are pruned beyond **~760 days (~2y)** (price_ingest re-pulls a rolling 2y window and
upserts but never deletes, so older bars accumulate forever); `manager_portfolios` is
bounded to the **latest 4 13F filing quarters** (`prune_manager_portfolios`) — it gains a
quarter (~managers × top-N + exits) every cycle, and the Investors view only reads each
manager's latest two quarters, so older quarters are dead weight that widened both the
frontend fetch and the backend `_prior_lookup` scan; `ipos` rows are pruned past **120 days**
(`prune_old_ipos`) since the IPO pipeline is a rolling recent-activity surface;
`company_news` headlines are pruned past **30 days** (`prune_old_news`) — a rolling
recent-headlines surface, not an archive; `market_news` is likewise pruned past **30
days** (`prune_old_market_news`); `reddit_trends` daily snapshots are pruned past **30
days** (`prune_old_reddit_trends`) — one tiny top-N snapshot per day, kept just long
enough for week-over-week comparisons; `congress_trades` rows are pruned past **400
days** (`prune_old_congress_trades`) — the Congress view aggregates 30–90-day consensus
windows, so ~13 months of history is plenty; `options_snapshots` rows are pruned past **400 days**
(`prune_old_options_snapshots`) — sized to the trailing-1-year IV-rank lookback plus a
month of margin;
`theme_mentions` rows are pruned past **1900 days**
(`prune_old_theme_mentions`) — ~5 years of quarters, comfortably more than the Trends
view's published window plus its year-over-year comparison, and the aggregate is
recomputed from whatever survives so the trend history shrinks in step;
`cot_reports` rows are pruned past **1200
days** (`prune_old_cot_reports`) — the COT positioning index is a percentile over a
trailing 3-year range, so ~3.3y keeps the full 156-week lookback with margin. All other structured warehouse tables
(fundamentals, holdings, events) are small/bounded per company and retained.

> The price reads (`fetchPrices`, `summary_ingest`) fetch the most-recent N sessions via
> `order(date desc).limit(N)` then reverse to ascending. Do **not** revert these to
> `order(date asc).limit(N)` — ascending+limit returns the *oldest* rows once a company
> exceeds N bars, so the latest price/technicals would silently go stale.

---

## Pipeline Execution Flow (`main.py`)

```
1. _preflight() — verify the `companies` table exists (schema applied) or fail fast.
2. get_active_watchlist() — SEED ∪ dynamic `watchlist` table, deduped by CIK.
3. fetch_ingest_state() — {cik: {last, datasets:{dataset: ISO}}} from companies.
4. _select(argv) — resolve the run's batch:
      args:  AAPL MSFT → that subset, force every dataset
             --all      → entire active watchlist, force
             --queued   → only never-ingested companies
      default: _schedule() → never-ingested first, then due companies by
               longest-since-visited, capped at INGEST_MAX_PER_RUN.
5. For each company (until INGEST_TIME_BUDGET_S wall-clock budget):
      process(): for each dataset whose cadence is due —
        filings_ingest, data_ingest (fundamentals), then optional extractors
        (events, insider, ownership, prices, reference, themes) via _run_optional(); stamp
        only datasets that ran; one final db.update_company_state() write.
        13F institutional is NOT cadence-driven per company — `ingest_institutional`
        runs only ONCE per company (first ingest / --force) to seed its first holder
        coverage; ongoing refresh is the global pass (#7).
      Non-seed companies get flipped to 'ingested' in the watchlist table.
6. entity_ingest.ingest_entities() — global, runs once per run (not per company).
7. institutional_extractor.ingest_institutional_global() — global, once per run.
   Incrementally pulls any manager 13Fs MISSING for the current filing quarter
   (`_populate_cache(only_missing=True)` skips managers already on file via one small
   `_managers_done` query), then writes per-company `institutional_holdings` for the
   WHOLE active watchlist + the `manager_portfolios` snapshot/diff in one pass. Once a
   quarter is captured it no-ops with a single query and zero EDGAR — so the heavy 13F
   fetch happens once per QUARTER, independent of run frequency and watchlist size.
   (The manager 13Fs are global/quarterly data; pulling them once and fanning out to
   all companies is what makes institutional scale with the watchlist.)
8. ipo_extractor.ingest_ipos_global() — global, once per run. Pulls IPO-lifecycle
   forms (S-1/F-1 registrations, S-1/A amendments, 424B pricings, RW withdrawals)
   from TWO sources and upserts one `ipos` row per filing: (1a) the real-time
   current-filings feed (`get_current_filings`) for TODAY's filings — so a same-day
   pricing shows immediately, not a day late; (1b) a shallow historical quarterly
   index scan (`get_filings`, yesterday back ~10 days) as a downtime safety net behind
   the feed. Incremental:
   already-stored accessions are skipped via
   `db.get_seen_accessions`, and the expensive prospectus parse (`.obj()` → Deal
   price/shares/proceeds) runs ONLY for new 424B pricings, so most runs are cheap
   metadata-only index reads. Market-wide — independent of the watchlist. Window is
   `IPO_WINDOW_DAYS` (default 10); rows are pruned past 120d by cleanup.py.
9. trend_aggregator.ingest_trends() — global, once per run, SELF-GATED to
   INTERVAL_TRENDS (default weekly): if `theme_trends` was written within the window
   it returns after one tiny freshness query. Otherwise it pages the whole (small)
   `theme_mentions` table, aggregates it per theme per quarter — breadth, attributed
   capital, momentum, stage, drivers, templated summary — and REPLACES `theme_trends`
   wholesale, so a theme that drops out of a quarter leaves no stale row. Pure
   arithmetic over rows already in the warehouse: no EDGAR, no external API, no model.
10. market_news_ingest.ingest_market_news_global() — global, once per run. Polls the
   curated free federal/gov + macro RSS feeds (Fed press/speeches/testimony · BEA ·
   SEC · FDA · FTC · CFTC · White House · PR Newswire), scores each
   headline for trader-importance, and stores ONLY market-movers above
   `MARKET_NEWS_MIN_SCORE` (strict) into `market_news`. Fail-soft per feed, writes only
   new items (`db.get_seen_market_guids`), and alerts the top new items to Discord
   (`notify_market_news`). Powers the frontend "Top Intelligence" feed.
```

**Cadence defaults** (`DATASET_INTERVALS_H`, all env-overridable via `INTERVAL_*`):
filings 0 (every visit) · events 12h · insider 24h · ownership 48h · fundamentals 168h ·
prices 24h · options 12h (the row is keyed by DATE, so the
second visit just refreshes the same day's row with later/post-close flow; it runs AFTER
prices because its realized-vol yardstick reads `daily_prices`) · news 6h (the main pipeline's per-company cadence; the summa-news */5 job also
polls every company's Google News each tick via `--company`, so effective news latency is
~5 min — dedupe by guid makes the overlap harmless. The pipeline pass therefore owns no
latency budget and is a pure backstop, so it is deliberately slow; `INTERVAL_NEWS` tunes
the pipeline side) · summary 6h · themes 168h (Phase 2: a POLL for a new 10-K/10-Q, not a
re-parse — already-extracted accessions are skipped *before* any document is fetched, so a
due visit with nothing new costs one small query and zero EDGAR text; new reports only land
quarterly) · reference 720h. (13F institutional is global/quarterly — see step 7
— not a per-company `DATASET_INTERVALS_H` entry.)

> **Cadence is the Supabase egress budget, not just a freshness knob.** The reads scale
> `companies × runs/day`, and the free tier allows 5 GB/month. `summary` is the largest
> reader in the project (~47 KB/company/run: 400 `daily_prices` bars + 200 insider rows),
> so its old "every visit" default cost ~5 GB/month by itself at 25 companies × 144
> runs/day — the whole allowance, spent re-reading identical rows. Before setting any
> `INTERVAL_*` to 0, check what the dataset *reads*, and never set one finer than the
> cadence of the data it consumes.

---

## Environment Variables

Backend (`backend/.env`, mapped from `${{ secrets.* }}` in the workflows):
`SUPABASE_URL`, `SUPABASE_KEY` (service_role), `EDGAR_IDENTITY` (SEC User-Agent, e.g.
`"Summa/1.0 (you@example.com)"`), and — optional alerts only — `DISCORD_WEBHOOK_URL`. Tuning: `INGEST_MAX_PER_RUN` (default 12), `INGEST_TIME_BUDGET_S`
(default 360), `INTERVAL_<DATASET>` overrides (incl. `INTERVAL_OPTIONS`,
hours, default 12 — the CBOE chain payload is ~1.5 MB per company, so this knob is about
bandwidth and run time, not an API quota: the source is keyless and unmetered), `IPO_WINDOW_DAYS` (default 10; raise for
a one-off IPO backfill on an empty table). Phase 2 tuning — themes:
`INTERVAL_THEMES` (hours, default 168), `THEME_LOOKBACK_QUARTERS` (filings considered per
company, default 8), `THEME_MAX_DOCS_PER_RUN` (documents actually downloaded per company
per visit, default 3 — a first-ever company backfills this many and defers the rest to
later visits, the same spread-the-work rule the company scheduler uses),
`THEME_MIN_HITS` (times a theme must appear in ONE filing to be recorded at all,
default 2 — the single knob that keeps breadth from measuring boilerplate); trends:
`INTERVAL_TRENDS` (hours between global recomputes, default 168), `TREND_QUARTERS`
(quarters published, default 8), `TREND_MIN_COVERAGE` (companies a quarter needs before
its breadth is treated as meaningful, default 3 — below it the row is flagged `thin` and
the UI says so). News tuning: `INTERVAL_NEWS` (hours, default 1),
`NEWS_MAX_ITEMS` (per-company Google feed cap, default 100), `NEWS_MAX_AGE_DAYS` (recency
window, default 3 — the news channel is "latest only": headlines older than this are never
ingested; summa-news.yml pins the same value), `NEWS_MIN_SCORE` (catalyst KEEP threshold,
default 3; `news_score.py`), `NEWS_ALERT_SCORE` (catalyst WEBHOOK threshold; code default 6 =
Notable+ only, but both workflows set it to `"3"` so Discord alerts at the UI's "important"
floor), `NEWS_ALERT_MAX_AGE_H` (Discord company-news freshness gate, default 24 — a
just-discovered but older headline is stored, never alerted),
`MARKET_NEWS_MIN_SCORE` (strict market threshold, default 3), `MARKET_NEWS_MAX_AGE_DAYS`
(market-feed recency window, default 7), Reddit-trends tuning: `REDDIT_TRENDS_MAX`
(tickers stored per daily snapshot, default 50), `REDDIT_TRENDS_ALERT_N` (tickers in the
Discord digest, default 20 — sectioned embed: medal top-3 detailed in the description,
ranks 4–10 / 11–20 as one-liner fields; the title carries the trend date),
`REDDIT_TRENDS_RISING_N` / `REDDIT_TRENDS_RISING_MIN` (the daily digest's
"🌱 Under the radar" field: up to N low-chatter tickers from the FULL fetched board —
outside the top-20 — whose mentions ≥ MIN (default 25) and at least doubled in 24h,
jumped ≥15 rank spots, or are new to the board; alert-only, never stored),
`REDDIT_TRENDS_VALUE_OFF_HIGH` / `REDDIT_TRENDS_VALUE_NEAR_LOW` / `REDDIT_TRENDS_VALUE_N`
(the daily "💎 High buzz, low price" companion embed: up to N trending non-ETF, non-bearish
tickers with ≥25 mentions whose latest price sits at the bottom of the 52-week range —
at least OFF_HIGH % (default 50) below the high or within NEAR_LOW % (default 10) of the
low — nearest-the-low first; the same screen the Reddit Buzz view's 💎 highlight/filter
mirrors client-side from the stored `last_price`/`off_high_pct`/`off_low_pct`/`is_etf`
columns. Each stored ticker is also labelled with `sector`/`industry` at ingest — prior
stored labels → curated `company_profiles` → SEC submissions SIC via the bundled
`sec-companies.json` ticker→CIK index — shown in the view and the embed), `REDDIT_TRENDS_FILTER` (ApeWisdom subreddit universe,
default `all-stocks`), `REDDIT_TRENDS_SURGE_N` (intraday runs alert only tickers newly in
the top N that earlier ranked past 20 or not at all, default 5),
`REDDIT_TRENDS_FORCE_DIGEST` (`"1"` — or `--force` on `tools.reddit_trends` — posts the
full daily digest even when today's snapshot already exists; the summa-reddit
workflow_dispatch `force_digest` input sets it, so a manual run is always visible instead
of a silent surge-only refresh), `REDDIT_TRENDS_PRICES`
(attach live Yahoo last-price/day-% to alerted tickers, default on; `"0"` disables),
`DISCORD_REDDIT_WEBHOOK_URL` (optional dedicated Discord channel
for the Reddit digest; falls back to `DISCORD_WEBHOOK_URL`), `MARKET_NEWS_FEEDS` (override the curated source list as
`label|url|weight` comma-separated), `FILING_ALERT_RECENCY_DAYS` (Discord filing-alert
freshness window, default 2 — only just-filed feed documents alert, never backfills),
Congress-trades tuning: `CONGRESS_TRADES_URL` (override the feed URL; default the Kadoa
monitor's static trades.json), `CONGRESS_ALERT_N` (new-disclosure lines in the Discord
digest, default 10 — largest amount ranges first), `CONGRESS_CONSENSUS_DAYS` /
`CONGRESS_CONSENSUS_MIN` (the digest + log consensus screen: tickers where MIN+ distinct
members — default 3 — traded the same side within DAYS — default 30; the digest header
also carries the window's total buy-vs-sell activity — trades, distinct members, est. $ —
and each consensus line its trade count + ⚖️ opposed-members marker; the frontend
Congress view recomputes the same screen client-side with its own toggles),
`CONGRESS_FORCE_DIGEST` (`"1"` — or `--force` on `tools.congress_trades` — posts the
latest-state digest even when nothing is new; the summa-congress workflow_dispatch
`force_digest` input sets it), `DISCORD_CONGRESS_WEBHOOK_URL` (optional dedicated Discord
channel for the congress digest; falls back to `DISCORD_WEBHOOK_URL`. New-disclosure
alerts are suppressed on the table's first-ever seed and skipped when a run finds no new
ids). COT tuning: `COT_HISTORY_WEEKS` (first-seed backfill + the digest's COT-index
lookback, default 156 ≈ 3y), `COT_ALERT_N` (markets in the digest's biggest-weekly-shifts
list, default 8), `COT_SHIFT_PCT_OI` (a weekly spec-net change ≥ this % of open interest
counts as a notable flow, default 2.0), `COT_API_URL` (override the CFTC Socrata endpoint),
`COT_FORCE_DIGEST` (`"1"` — or `--force` on `tools.cot` — posts the latest-state digest
even when no new report week landed; the summa-cot workflow_dispatch `force_digest` input
sets it), `DISCORD_COT_WEBHOOK_URL` (optional dedicated Discord channel for the COT
digest; falls back to `DISCORD_WEBHOOK_URL`. The digest is suppressed on the table's
first-ever seed and skipped when no new report week arrived). Recap: `DISCORD_RECAP_WEBHOOK_URL`
(optional dedicated Discord channel for the weekday-evening prose recap; falls back to
`DISCORD_WEBHOOK_URL`. The recap has no thresholds to tune — it describes whatever
`company_summary` holds, and each paragraph is simply omitted when it has nothing to say).
`EDGAR_RATE_LIMIT_PER_SEC` (default 9 in
edgartools; SEC's ceiling is ~10/s) — read by edgartools **at import time**, so it must be
set in the environment (workflow `env:` / `backend/.env`) before `main.py` imports `edgar`,
not assigned in Python. Set to `"9"` in the EDGAR workflows (pipeline, 13F-quarter).
edgartools is pinned `>=5.36.0,<6` in `requirements.txt`; the 5.x line is what enforces this
default throttle.

Frontend (`frontend/.env.local`): `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`.

---

## Local Development

```bash
# Backend
cd backend
python -m venv venv && venv\Scripts\activate   # Windows
pip install -r requirements.txt
# create backend/.env (see .env.example)
python main.py AAPL          # force-ingest one company, every dataset
python main.py               # staged cadence (what the cron runs)

# Frontend
cd frontend
npm install
# create frontend/.env.local
npm run dev                  # http://localhost:3000 (Turbopack)
npx tsc --noEmit             # typecheck (run after any page.tsx extraction)
```

If the dev server hangs and the project is inside OneDrive, pause OneDrive sync for the
project directory — OneDrive file locking interferes with Turbopack's file watching.

---

## Adding Features

**New dataset/extractor:** add `ingest_<dataset>(cik, ticker)` in a module under
`backend/ingest/` (precompute/feed ingestors) or `backend/extractors/` (SEC-form
parsers); import it in `main.py` (in the optional `try/except` block) as
`from ingest import …` / `from extractors import …`; add it to
`DATASET_INTERVALS_H` with a sensible cadence; wire it into `process()` via
`_run_optional()` so it fails soft and stamps only on success. Add the table +
indexes + RLS SELECT policy to `schema.sql` (`CREATE TABLE IF NOT EXISTS`), and a
`db.upsert_*` helper. Add a `fetch*` in `frontend/lib/data/data.ts` and a row type in
`lib/types.ts` to surface it.

**New frontend view:** add it under `views/` (self-contained) or extract from
`page.tsx`; wire it into the view routing in `Page`; add CSS to `globals.css`.

---

## Known Gaps / TODO

- **`page.tsx` split is done** — the dashboard is now a thin root shell (~190 lines) over
  `components/` (atoms) + `views/` (views, incl. `views/company/` tabs). Keep new UI in
  that structure; see "Component / view structure" above.
- **CI gate is typecheck-only** — `ci.yml` runs `tsc --noEmit` (frontend) + `compileall`
  (backend) on push/PR, but there is still **no ESLint config** committed (`next lint`
  prompts interactively and can't gate CI). Add `.eslintrc.json` (extends
  `next/core-web-vitals`) and an `npm run lint` step in `ci.yml` when ready.
- **`schema.sql` must stay populated.** It is the single source of truth for the
  warehouse and must be applied in Supabase before the backend can write. Do not commit
  it empty.
- **Supabase Branching is intentionally NOT used.** Schema is applied by hand via the SQL
  Editor (invariant #3); there is no `supabase/` dir, `config.toml`, or `migrations/`. If a
  red **"Supabase Preview"** check appears on commits (`context deadline exceeded` reading
  `api.supabase.com/.../config/...`), it's the Supabase Branching integration timing out on
  the management API — not a repo/code problem and not fixable in-repo. Disable it: remove
  the repo from the Supabase GitHub App (github.com → Settings → Applications → Supabase →
  Configure) **or** dashboard → branch dropdown → Manage branches → Disable branching. Do
  not add a `supabase/` project to "fix" it — that would adopt migration-based schema
  management and conflict with the hand-applied `schema.sql` workflow.

---

## Scaling & Free-Tier Limits

The watchlist is meant to grow. These rules keep every tier within budget as N
(companies) increases. **If you add a feature that reads across the watchlist, it must
follow the precompute-or-paginate rule below — do not fetch N×history in one query.**

**Ingest (EDGAR / Actions) — already bounded, scales by spreading work.**
Per-run cost is fixed by `INGEST_MAX_PER_RUN` (companies/run) + `INGEST_TIME_BUDGET_S`
+ the 8-min Actions cap — *independent of N*. Growing the watchlist only increases
*coverage latency* (time for a full sweep), never per-run rate. The knob to rebalance as
N grows is **raising `INGEST_MAX_PER_RUN`**, not changing the design. EDGAR's 10 req/s is
never approached because work-per-run is capped.

**Whole-table reads must page.** PostgREST caps a bare `.select()` at ~1000 rows, so any
"read every row" query silently truncates as tables grow. Use the paged helpers:
- Backend: `db._select_all(table, cols)` — used by `fetch_ingest_state` / `fetch_watchlist`
  (without it the scheduler goes blind past ~1000 companies and stops ingesting them).
- Frontend: `selectAllPaged<T>()` in `lib/data/data.ts` — used by `fetchCompanies`,
  `fetchCompanyProfiles`, `fetchCompanyThemes`, `fetchEntities`, `fetchCompanySummaries`.

**Watchlist-wide surfaces read the precompute, not raw history.** The Overview table and
Momentum Scanner read **`company_summary`** (one tiny row/company, written by
`summary_ingest.py`) via `fetchCompanySummaries()` — O(companies) small rows, paginated.
This replaced fetching every company's ~1yr of `daily_prices` in one 20k-row query, which
silently truncated at **~80 companies**. `OverviewPage` falls back to the old client-side
raw-price path only when `company_summary` is empty (i.e. before the migration is applied).

**Live Signals scanner** (`useWatchlistPulse` → `fetchRecent*`) — *addressed.* The six
cross-watchlist fetchers go through `fetchRecentScoped`, which (1) **chunks** `.in("cik", …)`
into batches of 150 so the request URL never 414s at any watchlist size, and (2) scopes by a
**per-table recency window** (sized to each signal's lookback in `pulse.ts buildSignals` —
insider 120d, earnings 220d, events 150d, beneficial 600d, offerings 400d, late 600d) instead
of a fixed global row cap, so per-company coverage no longer thins as busier names fill a cap.
`buildSignals` remains the single source of truth (the scanner and per-company cockpit share
it); the window only changes which rows it sees. Bounded by recency × personal-watchlist size,
which is inherently small. A `cap` per fetch is only a safety valve. (A full backend precompute
would scale to unlimited size but forks the signal logic — deferred unless a huge shared/global
scanner is needed.)

**Known remaining N-limits (address before the watchlist gets large):**
- **`fetchFilings(200)`** powers the global feed — fine as a feed, but it's a recent-200
  window, not per-company coverage.
- **Supabase storage (500 MB free).** Two structured tables grew unbounded with time and are
  now pruned monthly (`tools/cleanup.py`): `daily_prices` to ~2y (`prune_old_prices`) and
  `manager_portfolios` to the latest 4 13F filing quarters (`prune_manager_portfolios`, which
  also caps the Investors view's `fetchManagerPortfolios` read — it only uses each manager's
  latest two quarters). `financial_facts` / holdings grow with N×time but are small per company
  and retained; add rollup only if they become a problem.

---

## Phase 2 — Trend Intelligence (shipped 2026-08-20)

**What it answers.** Phase 1 gives per-company facts. Phase 2 gives the
*cross-company* read: **what tracked companies are collectively investing in**,
and **which theme is next** — by aggregating forward-looking language and
capital allocation across the whole tracked universe over time.

**Core principle.** The algorithm finds the trend end to end — there is **no LLM
stage** (the Gemini channel was removed 2026-08-13). Themes come from a curated
keyword taxonomy over stored filing text; labels are taxonomy labels; the
`theme_trends.summary` sentence is a template filled with the row's own computed
numbers, so the same rows always produce the same prose. Never re-derive trends
from full filings at read time.

### The one distinction the whole feature rests on

- **BREADTH** (`company_count`) — how many distinct companies cite a theme in a
  quarter. Language is free, so breadth on its own measures *narrative*.
- **CAPITAL** (`capital_flow`) — the R&D + capex attributed to the theme.
  Dollars are expensive, so capital measures *commitment*.

They are stored, charted and ranked separately, never blended into one number,
because their disagreement is the signal: breadth climbing with capital behind
it is a real buildout; breadth climbing without it is a story to fade. Keep it
that way — collapsing them into a single "score" column would destroy the read.

### Pipeline (two stages, both deterministic)

**1. Extraction — per company, at ingest time** (`ingest/theme_ingest.py`,
dataset `themes`, cadence `INTERVAL_THEMES` ≈ weekly).
Runs the `ingest/theme_taxonomy.py` keyword matcher over the **Business + MD&A**
sections of each new 10-K / 10-Q and writes `theme_mentions`.
- *Why at ingest:* the `filings` feed stores no narrative text and its rows are
  deleted at 90 days — the prose cannot be re-read later. Themes must be
  distilled while the document is in reach and then persisted as small rows.
- *Why Risk Factors is excluded:* it names every technology a company could
  conceivably be affected by, which would turn breadth into a measure of legal
  boilerplate rather than of investment.
- *Why it is cheap:* the filing index comes from the shared `edgar_cache`
  Company, and accessions already in `theme_mentions` are skipped **before** any
  document is fetched (`db.get_theme_accessions`). Steady state is one small
  query and zero downloads; new reports only land quarterly.
- *Periods are CALENDAR quarters*, never the filer's fiscal period — otherwise
  two companies with different year-ends never land in the same bucket and
  cross-company breadth is meaningless.
- *Capital is ATTRIBUTED, not disclosed:* companies never break R&D or capex out
  by theme, so the period's spend is allocated in proportion to how much of the
  filing's forward-looking language each theme accounts for, and normalized to a
  quarterly figure (an annual 10-K number is divided by four — summing it raw
  would quadruple every fourth point of the series). The UI says "attributed"
  everywhere it appears. Do not restate it as a disclosed number.

**2. Aggregation — global, once per run** (`trend_aggregator.py`, self-gated to
`INTERVAL_TRENDS` ≈ weekly). Pages `theme_mentions`, and per theme per quarter
computes breadth, attributed capital, both velocities, `momentum_score` (0–100:
0.45 breadth velocity + 0.35 capital velocity + 0.20 adoption), `stage`
(emerging / accelerating / mainstream / cooling), the leading sector +
`sector_flow` split, the `drivers` companies, and the templated `summary`. Then
**replaces `theme_trends` wholesale** — a full recompute is the only way a theme
that dropped out of a quarter stops looking current.

`build_trends()` is kept pure (no I/O) so the scoring can be exercised without a
database; `ingest_trends()` does the reading and writing around it.

### Coverage honesty (non-negotiable)

The watchlist is **not the market**. Every quarter's rows carry `coverage` — the
number of companies that reported *any* theme that quarter — and every share is
quoted against it ("12 of 18 tracked companies", never "67% of the market"). A
quarter below `TREND_MIN_COVERAGE` is flagged `thin` and the view says so. Trend
confidence scales with universe size: a thin watchlist gives a thin signal.

### Frontend

`views/TrendsPage.tsx` (nav: **◭ Trends**, hash `#trends`) over
`lib/domain/trends.ts` (`buildTrends` / `nextTrend` / `capitalBySector`) and
`fetchThemeTrends()` in `lib/data/data.ts` — one paged read of the whole small
aggregate, sliced client-side into the ranked board plus each theme's history.
The view shows breadth and capital as adjacent columns, a stage badge, a
per-theme detail panel (talk-vs-money indexed chart + driver companies +
capital by sector), a "next trend" pick (highest momentum that is *still early*
**and** has real dollars behind it), and a capital-allocation-by-sector chart
that follows the active filters.

### Cost

Flat. Extraction adds text downloads only when a new annual/quarterly report
appears; aggregation is arithmetic over already-stored rows with no EDGAR and no
external API. Both tables are small and bounded — `theme_mentions` by
companies × themes × quarters (pruned to ~5 years), `theme_trends` by
themes × published quarters (a few hundred rows, fully replaced each cycle).

### Extending it

Add a theme by appending a `Theme` to `THEMES` in `ingest/theme_taxonomy.py`
(and its category to `TREND_CATEGORIES` in `lib/domain/trends.ts` if new). Two
rules: **theme keys are permanent** — renaming one orphans its stored history —
and **never widen an existing theme's patterns to swallow a new one**, which
silently rewrites the past. Pattern-writing rules (multi-word phrases for
anything ambiguous, boundary-anchored acronyms) are documented in the taxonomy
module; a sloppy pattern inflates breadth directly.

### Optional later: 2C (semantic)

pgvector embeddings on `theme_mentions` for clustering beyond the keyword
taxonomy — a **local** embedding model only. Adding a hosted LLM is out of scope
and would violate the no-model-provider decision below.

---

## Key Decisions Log

**Why there is no LLM (2026-08-13):** the optional Gemini channel
(`enrichment/gemini_client.py`, `enrichment/gemini_enricher.py`, the `google-genai`
dependency, `GEMINI_API_KEY`, and the Discord embed's "AI summary" field) was removed. It
was never wired into `main.py` — nothing imported it outside itself — so it was a dormant
API-key surface and an extra dependency for zero shipped behaviour. Summa's output is now
100% deterministic code over the warehouse. Do not reintroduce a model provider without an
explicit decision; the roadmap's theme/trend work is specified keyword/taxonomy-only.

**Why Phase 2 measures breadth and capital separately (2026-08-20):** the obvious design
was one "trend score" per theme. It was rejected because the two inputs are only
interesting when they *disagree*. Filing language is free, so breadth alone tracks the
quarter's vocabulary — every company said "AI" whether or not they spent on it. R&D and
capex are expensive, so capital is the commitment test. Blending them into one number
hides exactly the case the feature exists to catch (loud theme, no money). They are
stored, charted and ranked as two columns; `momentum_score` is offered as a *ranking* of
the pair, never as a verdict. The related honesty constraint: capital is **attributed**
(allocated by share of a filing's forward-looking language), because companies never break
spend out by theme — so it may be described as a direction and a rough scale, never as a
disclosed figure.

**Why theme extraction runs at ingest, not in the aggregator (2026-08-20):** the natural
place to parse filings is the global aggregator, where everything else is recomputed. It
cannot go there: `filings` stores no narrative text and its rows are deleted at 90 days, so
the prose is gone by the next recompute. `theme_ingest` distils themes while the document
is still reachable and persists small structured rows; `trend_aggregator` only ever
aggregates those. This is also what keeps the cost flat — the aggregator touches no EDGAR
at all.

**Why `page.tsx` started as one large file:** shared `Filing`/row types, formatters,
and design-token references made an early split create prop-drilling/context overhead.
It was split deliberately, leaves-first, with `tsc` verifying each move — now a thin
root shell over `components/` (atoms) + `views/` (views + `views/company/` tabs), with
pure logic pushed down to `lib/` (`domain/scorecard.ts`, `utils/url.ts`, `hooks/useWatchlistPulse.ts`).
The shared types/formatters that once justified one file now live in `lib/` and are
imported, so the prop-drilling concern no longer applies.

**Why Turbopack for dev:** `next dev --turbopack` bypasses webpack, cutting startup time
and avoiding the file-locking hangs seen on Windows + OneDrive.

**Why the watchlist is SEED ∪ a Supabase table:** companies can be queued from the
frontend (`queueWatchlist` → `watchlist` table) and ingested with no code change;
`get_active_watchlist()` falls back to SEED alone if the table is unreachable.

**Why the scheduler stamps per-dataset timestamps in one write:** `process()` advances
`dataset_state` and `last_ingested_at` in a single `update_company_state()` call, so a
run interrupted between companies leaves resumable, consistent state.
