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
frontend (static export) reads from Supabase through `lib/data.ts` (anon key) and
renders an interactive per-company research UI with a live filings feed.

**Core principle:** ingest once, cheaply, and spread the work across runs. Each
cron tick visits a bounded batch of companies, and within a visit each dataset
only refreshes if its own cadence has elapsed. Coverage scales by spreading work
across runs, not by doing more per run.

> Optional Phase-2 enrichment channels (`gemini_enricher.py`, `discord_notify.py`)
> exist but are **not** part of the Phase-1 ingest path.

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
│   ├── data_ingest.py            ← fundamentals (XBRL) → financial_facts
│   ├── filings_ingest.py         ← narrative filings feed → filings
│   ├── event_extractor.py        ← earnings/corporate events/late filings/offerings
│   ├── insider_extractor.py      ← Form 4 → insider_transactions
│   ├── institutional_extractor.py← 13F-HR → institutional_holdings
│   ├── ownership_extractor.py    ← SC 13D/13G + Form 144 → beneficial_ownership / proposed_sales
│   ├── price_ingest.py           ← Yahoo EOD bars → daily_prices (only non-SEC source)
│   ├── summary_ingest.py         ← precomputes company_summary (price+technicals+activity)
│   ├── reference_ingest.py       ← SIC industry/theme → company_profiles / company_themes
│   ├── entity_ingest.py          ← seeds/entities.yaml → entities registry (global, runs once)
│   ├── build_sec_index.py        ← rebuilds frontend/public/sec-companies.json (stdlib only)
│   ├── cleanup.py                ← monthly retention maintenance
│   ├── gemini_enricher.py        ← OPTIONAL Phase-2 enrichment (not in ingest path)
│   ├── discord_notify.py         ← OPTIONAL Phase-2 alerts (not in ingest path)
│   ├── seeds/                    ← entities.yaml, profiles.yaml (curated reference data)
│   ├── docs/                     ← backend design docs (REFERENCE_DATA_SCOPE.md)
│   ├── requirements.txt
│   └── .env.example
│
├── .github/workflows/
│   ├── summa-pipeline.yml         ← */10 min ingest (main.py)
│   ├── summa-cleanup.yml          ← monthly retention (cleanup.py)
│   ├── summa-secindex.yml         ← weekly SEC index rebuild (build_sec_index.py)
│   └── keepalive.yml              ← weekly heartbeat commit (keeps crons alive)
│
└── frontend/                      ← Next.js 14 static export
    ├── app/
    │   ├── page.tsx               ← main dashboard (large; being split — see below)
    │   ├── layout.tsx, globals.css, error.tsx, not-found.tsx
    ├── components/                ← DataTable, InfoTip, Sparkline, charts, Skeletons
    ├── views/                     ← top-level page views extracted from page.tsx (GuidePage)
    ├── lib/                       ← data access + domain logic (see below)
    └── public/sec-companies.json  ← bundled SEC company index (universal search)
```

### Frontend `lib/` modules

`supabase.ts` (anon client) · `data.ts` (all fetch* + `subscribeFilings` Realtime) ·
`types.ts` (row types) · `fundamentals.ts` · `pulse.ts` (tape/signals) · `format.ts` ·
`taxonomy.ts` · `entities.ts` · `insider.ts` · `prices.ts` (incl. `reactionStats`) ·
`valuation.ts` · `technicals.ts` · `catalysts.ts` (next-earnings estimate) ·
`secIndex.ts` · `glossary.ts` · `watchlist.ts` / `useWatchlist.ts` / `useLastSeen.ts`.

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
10. **Yahoo Finance is the only non-SEC data source** (`price_ingest.py`). Everything
    else originates from EDGAR.
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

---

## TypeScript / Frontend Conventions

- Strict mode, no `any`. Functional components only.
- `lib/supabase.ts` is the only place the anon client is created; `lib/data.ts` is the
  only data-access layer (no API routes).
- `useMemo` for derived/filtered arrays.
- Design tokens via CSS custom properties in `globals.css`; component-specific layout
  via inline styles. No hardcoded hex in JSX where a token exists.
- No `dangerouslySetInnerHTML`. URL props pass through a `safeHref`-style guard.

### Splitting `page.tsx` (in progress)

`app/page.tsx` is the large single-file dashboard. It is being incrementally split.
Two reference patterns are already in place — follow them:

- **Leaf/atom components → `components/`** (e.g. `Skeletons.tsx`): pure presentational,
  CSS-classes-only, no data deps. Extract these first; views depend on them.
- **Self-contained views → `views/`** (e.g. `GuidePage.tsx`): a top-level page view that
  owns its data/types and depends only on CSS. Move the view + its private data/types
  together, export the view, import it into `page.tsx`.

When extracting, run `npx tsc --noEmit` in `frontend/` to confirm a clean move. Good
next candidates: the remaining badge atoms (`FormBadge`, `CompanyMark`, `NameContext`,
`DirMark`, `EventClassBadge`, `GuidanceBadge`) and the larger views (`FeedPage`,
`CalendarView`, `SearchPage`, the company tabs).

---

## Database Schema

Run `schema.sql` once in the Supabase SQL Editor (idempotent). Tables:

| Table | Conflict key | Purpose |
|---|---|---|
| `companies` | `cik` | Watchlist company metadata + `last_ingested_at`, `dataset_state` (jsonb) driving the scheduler |
| `financial_facts` | (cik, statement, period, …) | XBRL fundamentals (income/balance/cash-flow) |
| `filings` | `accession_number` | Narrative filings feed (10-K/10-Q/8-K/DEF 14A) + section text |
| `insider_transactions` | accession/txn | Form 4 open-market buys/sells |
| `institutional_holdings` | cik+period | 13F-HR positions |
| `beneficial_ownership` | accession | SC 13D/13G ≥5% stakes |
| `proposed_sales` | accession | Form 144 proposed insider sales |
| `earnings_events` | cik+date | 8-K Item 2.02 results/guidance |
| `corporate_events` | accession | Classified material 8-K events |
| `late_filings` | accession | NT 10-K / NT 10-Q notices |
| `securities_offerings` | accession | S-1/S-3/424B issuance |
| `daily_prices` | cik+date | Yahoo EOD bars |
| `company_profiles` | `cik` | SIC industry/sector |
| `company_themes` | cik+name | Recomputed theme tags (delete+insert per cik) |
| `entities` | `match_key` | Global entity-context registry (seeded) |
| `watchlist` | `cik` | Dynamic ingest queue (anon SELECT+INSERT from the UI) |
| `company_summary` | `cik` | One precomputed row/company (price + technicals + activity) for the watchlist-wide surfaces — see Scaling below |

**RLS:** anon → SELECT on warehouse tables, SELECT+INSERT on `watchlist`. Scraper uses
service_role (bypasses RLS).

**Retention** (`cleanup.py` / `db.py`): narrative `filings` section text is nulled at
**30 days**; `filings` feed rows are deleted at **90 days**. Structured warehouse tables
(fundamentals, holdings, events, prices) are retained.

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
        (events, insider, ownership, institutional, prices, reference) via
        _run_optional(); stamp only datasets that ran; one final
        db.update_company_state() write.
      Non-seed companies get flipped to 'ingested' in the watchlist table.
6. entity_ingest.ingest_entities() — global, runs once per run (not per company).
```

**Cadence defaults** (`DATASET_INTERVALS_H`, all env-overridable via `INTERVAL_*`):
filings 0 (every visit) · events 12h · insider 24h · ownership 48h · fundamentals 168h ·
institutional 168h · prices 24h · reference 720h.

---

## Environment Variables

Backend (`backend/.env`, mapped from `${{ secrets.* }}` in the workflows):
`SUPABASE_URL`, `SUPABASE_KEY` (service_role), `EDGAR_IDENTITY` (SEC User-Agent, e.g.
`"Summa/1.0 (you@example.com)"`), and — Phase-2 only — `GEMINI_API_KEY`,
`DISCORD_WEBHOOK_URL`. Tuning: `INGEST_MAX_PER_RUN` (default 12), `INGEST_TIME_BUDGET_S`
(default 360), `INTERVAL_<DATASET>` overrides.

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

**New dataset/extractor:** add `ingest_<dataset>(cik, ticker)` in a `backend/*.py`
module; import it in `main.py` (in the optional `try/except` block); add it to
`DATASET_INTERVALS_H` with a sensible cadence; wire it into `process()` via
`_run_optional()` so it fails soft and stamps only on success. Add the table +
indexes + RLS SELECT policy to `schema.sql` (`CREATE TABLE IF NOT EXISTS`), and a
`db.upsert_*` helper. Add a `fetch*` in `frontend/lib/data.ts` and a row type in
`lib/types.ts` to surface it.

**New frontend view:** add it under `views/` (self-contained) or extract from
`page.tsx`; wire it into the view routing in `Page`; add CSS to `globals.css`.

---

## Known Gaps / TODO

- **`page.tsx` is still large** (~2.6k lines). Continue the incremental split using the
  `components/` (leaf) and `views/` (view) patterns above.
- **No ESLint config** committed — `npm run lint` (`next lint`) prompts interactively and
  can't gate CI yet. Add `.eslintrc.json` (extends `next/core-web-vitals`) when ready.
- **`schema.sql` must stay populated.** It is the single source of truth for the
  warehouse and must be applied in Supabase before the backend can write. Do not commit
  it empty.

---

## Scaling & Free-Tier Limits

The watchlist is meant to grow. These rules keep every tier within budget as N
(companies) increases. **If you add a feature that reads across the watchlist, it must
follow the precompute-or-paginate rule below — do not fetch N×history in one query.**

**Ingest (EDGAR / Gemini / Actions) — already bounded, scales by spreading work.**
Per-run cost is fixed by `INGEST_MAX_PER_RUN` (companies/run) + `INGEST_TIME_BUDGET_S`
+ the 8-min Actions cap — *independent of N*. Growing the watchlist only increases
*coverage latency* (time for a full sweep), never per-run rate. The knob to rebalance as
N grows is **raising `INGEST_MAX_PER_RUN`**, not changing the design. EDGAR's 10 req/s and
Gemini's free tier are never approached because work-per-run is capped.

**Whole-table reads must page.** PostgREST caps a bare `.select()` at ~1000 rows, so any
"read every row" query silently truncates as tables grow. Use the paged helpers:
- Backend: `db._select_all(table, cols)` — used by `fetch_ingest_state` / `fetch_watchlist`
  (without it the scheduler goes blind past ~1000 companies and stops ingesting them).
- Frontend: `selectAllPaged<T>()` in `lib/data.ts` — used by `fetchCompanies`,
  `fetchCompanyProfiles`, `fetchCompanyThemes`, `fetchEntities`, `fetchCompanySummaries`.

**Watchlist-wide surfaces read the precompute, not raw history.** The Overview table and
Momentum Scanner read **`company_summary`** (one tiny row/company, written by
`summary_ingest.py`) via `fetchCompanySummaries()` — O(companies) small rows, paginated.
This replaced fetching every company's ~1yr of `daily_prices` in one 20k-row query, which
silently truncated at **~80 companies**. `OverviewPage` falls back to the old client-side
raw-price path only when `company_summary` is empty (i.e. before the migration is applied).

**Known remaining N-limits (address before the watchlist gets large):**
- **Live Signals scanner** (`useWatchlistPulse`) still fetches recent rows with fixed caps
  (insider 400, events 300, …) and `.in("cik", ciks)`. Coverage *thins* past a few hundred
  companies, and the `.in()` URL can 414 past ~500–1000. Fix: migrate it to read from
  `company_summary` (already carries `net_insider_90d` / `cluster_buy`) + a small
  recent-events precompute, same pattern as the Overview.
- **`fetchFilings(200)`** powers the global feed — fine as a feed, but it's a recent-200
  window, not per-company coverage.
- **Supabase storage (500 MB free).** Structured tables (`daily_prices`, `financial_facts`,
  holdings) grow with N×time and are *not* pruned (only the `filings` feed is). At large N
  add retention/rollup for `daily_prices` (e.g. keep ~1yr of daily + monthly beyond).

---

## Phase 2 — Trend Intelligence (planned)

**Goal.** Move from *per-company* facts (Phase 1) to a *cross-company* read: detect
**what companies are collectively investing in** and **what the next industry trend is**,
by aggregating forward-looking signals across the whole tracked universe over time.

**Core principle (unchanged).** The algorithm finds the trend; the LLM only names and
explains it. Stage 1 aggregates the warehouse for free; Stage 2 (Gemini) runs only on
small aggregated excerpts to label clusters and write the "why." Never re-derive trends
from full filings; never call Gemini when Stage 1 surfaced nothing.

**Relationship to existing roadmaps.** Phase 2 *consumes* the per-company themes produced
by the reference-data pipeline's Phase B (`backend/docs/REFERENCE_DATA_SCOPE.md` — LLM
theme/thesis extraction from 10-Ks). That pipeline answers "what is *this* company's
thesis"; Phase 2 answers "what are *most* companies converging on." Phase B is the
richest input but not a hard dependency — Stage 1 also works off a keyword pass when
themes are sparse.

### Inputs (all already in the Phase-1 warehouse)

- `company_themes` — per-company forward themes (reference-data Phase B output).
- `filings.section_business` / `section_mda` — the narrative "what we'll invest in"
  language. **Note:** these roll off at 30 days (retention), so theme signals must be
  extracted *at ingest time* and persisted, not recomputed from old filing text later.
- `financial_facts` — R&D and CapEx trajectories: where money *actually* flows (depth),
  not just what's said (breadth).
- `corporate_events` (M&A, capital_return), `securities_offerings` (what raises fund),
  `earnings_events` guidance — corroborating capital-allocation signals.
- `company_profiles.sector/industry` — to roll trends up by sector.

### Pipeline

**Stage 1 (free, always runs):**
1. **Theme normalization** — map raw per-company theme phrases + a keyword pass over
   `section_business`/`section_mda` onto canonical theme keys (a curated taxonomy;
   optional embedding similarity in 2C).
2. **Breadth series** — per theme per quarter, count the *distinct companies* mentioning
   / investing in it (adoption).
3. **Capital signal (depth)** — aggregate R&D/CapEx growth + M&A / offering activity
   tagged to each theme/sector (real dollars behind the talk).
4. **Momentum score** — combine breadth velocity (companies adopting) + capital velocity
   (dollars flowing) + recency. Emerging = low base, high velocity.
5. **Stage classification** — emerging / accelerating / mainstream / cooling.

**Stage 2 (Gemini, optional, formats only — gated on `GEMINI_API_KEY`, throttled):**
cluster synonymous raw phrases into one canonical theme, name nascent clusters, and write
a one-paragraph "why this is the next trend." Runs on the small aggregated phrase set,
never on filings.

### New schema (idempotent — add to `schema.sql`, RLS anon SELECT only)

- `theme_mentions` — `cik, theme_key, period, mention_count, capital_signal,
  source_accession`. The raw per-company-per-period material, written at ingest time.
- `theme_trends` — recomputed aggregate: `theme_key, label, period, company_count,
  breadth_delta, capital_flow, momentum_score, stage, sector, summary`. Small,
  slowly-changing, fully recomputed each cycle.
- *(2C, optional)* `embedding vector(768)` on `theme_mentions` via pgvector for semantic
  clustering — defer; the keyword taxonomy is the free floor.

### Backend

- **New `trend_aggregator.py`** — a *global* extractor (runs once per run, like
  `entity_ingest`, **not** per company). Reads the warehouse, computes `theme_mentions` +
  `theme_trends`. Wire at the end of `main()` via
  `_run_optional(trend_aggregator, "ingest_trends")` on a slow cadence
  (`INTERVAL_TRENDS`, default ~weekly — trends move slowly). Stage 1 always; the Stage 2
  naming pass gated + throttled.
- A lightweight keyword extraction over `section_business`/`section_mda` should run inside
  the per-company `filings`/reference ingest (while the text is still in-window) and write
  `theme_mentions`; `trend_aggregator` only *aggregates* stored mentions.
- New `db.py` helpers: `upsert_theme_mentions`, `upsert_theme_trends`.
- **Cost stays flat:** aggregation is over already-stored rows — no new EDGAR load, and
  only a throttled Gemini naming pass. Tables are bounded (one row per theme×period).

### Frontend

- **New "Trends" top-level view** (`views/`): a ranked emerging-themes leaderboard by
  `momentum_score`, each row showing breadth (N companies), capital flow, a stage badge,
  and the companies driving it (drill into the company page). Plus a capital-allocation-
  by-sector chart (R&D/CapEx flow) and a "Next Trend" highlight.
- **`fetchThemeTrends()`** in `lib/data.ts`: one `SELECT`, cached per session (slowly-
  changing, matched client-side) — same read-budget discipline as reference data.
- Reuses existing patterns: lazy chart wrappers (`charts.lazy`), `DataTable`, `SignalCard`.

### Phasing

- **2A (free, no LLM):** keyword/taxonomy normalization + breadth/capital momentum from
  the existing warehouse → `theme_trends` + the Trends view. Fully works without Gemini.
- **2B (LLM naming):** Gemini clusters/names emerging themes and writes the "why,"
  throttled and gated.
- **2C (semantic):** pgvector embeddings for theme clustering beyond the keyword taxonomy.

### Risks / notes

- **Coverage honesty:** the watchlist isn't the whole market — label trends "across
  tracked companies," and surface a coverage/confidence indicator. Trend confidence scales
  with universe size, so a thin watchlist gives a thin signal.
- **Retention timing** (above): persist theme mentions at ingest; never rely on
  `section_*` text surviving past 30 days.
- **No regression of invariants:** excerpts-only to Gemini, Stage-1-gates-Stage-2,
  warehouse-first, bounded/recomputed aggregate tables, reads fetched-once + client-matched.

---

## Key Decisions Log

**Why `page.tsx` started as one large file:** shared `Filing`/row types, formatters,
and design-token references made an early split create prop-drilling/context overhead.
Now being split deliberately, leaves-first, with `tsc` verifying each move.

**Why Turbopack for dev:** `next dev --turbopack` bypasses webpack, cutting startup time
and avoiding the file-locking hangs seen on Windows + OneDrive.

**Why the watchlist is SEED ∪ a Supabase table:** companies can be queued from the
frontend (`queueWatchlist` → `watchlist` table) and ingested with no code change;
`get_active_watchlist()` falls back to SEED alone if the table is unreachable.

**Why the scheduler stamps per-dataset timestamps in one write:** `process()` advances
`dataset_state` and `last_ingested_at` in a single `update_company_state()` call, so a
run interrupted between companies leaves resumable, consistent state.
