# Summa — Claude Working Reference

This file is read by Claude Code at the start of every session. It contains the full architectural context, invariants, code conventions, and implementation plan needed to work on this project correctly without re-deriving context from scratch.

---

## Project Summary

Summa is a zero-cost SEC filing intelligence pipeline. GitHub Actions runs a Python scraper every 10 minutes, fetching EDGAR RSS feeds for 10-K, 10-Q, 8-K, and DEF 14A. Qualifying filings pass through a 9-signal rule-based extraction algorithm (Stage 1, zero cost), and if signals are found, a short excerpt is sent to Google Gemini for enrichment (Stage 2). Results are written to Supabase. A Next.js frontend reads from Supabase via a Realtime subscription and displays a live card feed. Everything runs on permanent free tiers.

**Core principle:** The algorithm finds the signal. The LLM only formats it. Never send a full filing to Gemini. Never call Gemini if Stage 1 found nothing.

---

## Repository Layout

```
summa/
├── CLAUDE.md                    ← this file
├── README.md                    ← public-facing documentation
├── schema.sql                   ← run once in Supabase SQL Editor
├── .gitignore
│
├── scraper/                     ← Python pipeline (runs in GitHub Actions)
│   ├── sec_scraper.py           ← entry point; orchestrates the full pipeline
│   ├── cik_map.py               ← dict mapping CIK → ticker for top 500 companies
│   ├── html_cleaner.py          ← strips HTML/JS/CSS/XBRL, extracts Item sections
│   ├── signal_extractor.py      ← Stage 1: all 9 signals, pure Python, no API calls
│   ├── gemini_enricher.py       ← Stage 2: sends excerpt to Gemini, returns JSON
│   ├── discord_notify.py        ← posts rich embed to Discord webhook
│   ├── db.py                    ← Supabase client singleton + upsert helpers
│   ├── demo_supabase.py         ← one-off test script, not part of pipeline
│   ├── test_env.py              ← one-off env verification script
│   └── requirements.txt
│
├── tests/
│   ├── test_signal_extractor.py ← unit tests for scoring constants and thresholds
│   ├── test_html_cleaner.py     ← unit tests for regex extraction
│   └── fixtures/
│       └── sample_10k.html      ← real 10-K fragment for test fixtures
│
├── .github/
│   └── workflows/
│       └── summa-pipeline.yml   ← STUB: cron trigger, needs secrets wired
│
└── frontend/                    ← Next.js 14 static export
    ├── app/
    │   ├── layout.tsx           ← root layout, metadata
    │   ├── page.tsx             ← entire dashboard UI (single file, ~1100 lines)
    │   └── globals.css          ← design tokens, layout classes, animations
    ├── components/              ← STUBS: empty files, components live in page.tsx
    │   ├── FilingCard.tsx
    │   ├── SignalBadge.tsx
    │   ├── SkeletonCard.tsx
    │   └── ULIChart.tsx
    ├── lib/
    │   ├── supabase.ts          ← createClient(url, anonKey)
    │   └── watchlist.ts         ← CORE_WATCHLIST array of {cik, ticker, name}
    ├── next.config.mjs          ← minimal config, no webpack overrides
    ├── package.json             ← dev script uses --turbopack
    └── tsconfig.json            ← strict: true, incremental: true
```

---

## Critical Invariants

These are never-negotiate rules. If a proposed change violates one, stop and flag it.

1. **No full filing to Gemini.** Gemini only receives the pre-extracted excerpt (~150–300 words). Never pass raw HTML or a full filing section.
2. **No Gemini call when Stage 1 finds nothing.** `gemini_enricher.py` is only called when `signals_flagged == True`.
3. **No Redis for 8-K burst detection.** Upstash free tier is 10,000 commands/day. Burst detection uses the `filing_events` Supabase table instead.
4. **No calendar or holiday logic.** Redis deduplication handles weekends. The EDGAR feed is never empty.
5. **Never use spaCy `en_core_web_sm`.** Always `en_core_web_md`. The small model's NER is not accurate enough for financial text.
6. **No async in the scraper.** Synchronous requests with rate limiting only.
7. **No raw HTML stored in Supabase.** Only cleaned extracted text sections, capped at 8,000 characters each.
8. **No Next.js API routes.** Frontend is read-only. Writes go through GitHub Actions only.
9. **No Vercel.** Cloudflare Pages only.
10. **All credentials via environment variables.** Nothing hardcoded. Backend uses `scraper/.env` (gitignored). Frontend uses `frontend/.env.local` (gitignored).
11. **SEC User-Agent header on every EDGAR request.** Format: `"AppName/1.0 (email)"`. Never exceed 10 req/s.
12. **No feedparser.** Parse EDGAR Atom XML directly with BeautifulSoup.

---

## Python Code Conventions

- Python 3.10+ features permitted (union types with `|`, `match` statements)
- Type hints on every function signature (parameters and return type)
- Docstrings on every public function (one-line summary, then detail if needed)
- `logging` module only — never `print()` in pipeline code
- All environment variables via `os.environ["KEY"]` (raises on missing) not `os.getenv("KEY")` (silently returns None)
- `load_dotenv()` called at module level in `db.py` only; other modules import from `db.py`
- Supabase calls always via the singleton from `db.get_client()`
- Rate limiting: 120ms sleep between EDGAR requests (`time.sleep(0.12)`)
- Retry: max 3 attempts, exponential backoff starting at 1s, on any `requests` exception

---

## TypeScript / Frontend Conventions

- Strict mode, no `any` types
- Functional components only, no class components
- All components defined in `frontend/app/page.tsx` — the component stub files in `frontend/components/` are empty placeholders for future refactoring
- Inline styles for component-specific layout; CSS classes (in `globals.css`) for reusable patterns
- Design tokens via CSS custom properties only — no hardcoded hex values in JSX
- No `dangerouslySetInnerHTML`
- `useMemo` for all derived/filtered arrays (filing lists, company groupings)
- No API routes — `lib/supabase.ts` is the only data access layer
- The anon Supabase client is created once in `lib/supabase.ts` and imported everywhere

---

## Database Schema (Key Points)

Run `schema.sql` once in the Supabase SQL Editor. Safe to re-run (idempotent).

**`filings` table** — upserted on `accession_number`. Key columns for the frontend: `cik`, `ticker`, `company_name`, `form_type`, `filed_at`, `period_of_report`, `filing_url`, `signals_flagged`, `friday_dump`. The `embedding vector(768)` column is NULL until Phase 3.

**`company_meta` table** — upserted on `cik`. Stores rolling stats used by Stage 1: `median_days_to_file`, `avg_risk_section_length`, `avg_uli_score`, `risk_factors_prev`, `numeric_claims_prev`, `boilerplate_score_prev`.

**`filing_events` table** — insert-only. One row per 8-K with `cik` and `filed_at`. Used exclusively for burst detection: `SELECT COUNT(*) WHERE cik = ? AND filed_at > NOW() - INTERVAL '30 days'`.

**RLS:** Anon key → SELECT on `filings` and `company_meta`. No anon access to `filing_events`. Service_role key → full access to all tables (bypasses RLS). Frontend uses anon key. Scraper uses service_role key.

---

## Signal Extraction Reference

All 9 signals in `signal_extractor.py`. Each returns a dict with `score`, `flagged` (bool), and `excerpt` (str). The pipeline stores the full dict in `filings.signals` (jsonb).

| Signal | File Logic | Threshold | Notes |
|---|---|---|---|
| Keyword Scoring | Sentence-level keyword density | Per-keyword-dict threshold | 4 dicts: supply_chain, geopolitical, management, earnings |
| ULI | Hedge word ratio vs rolling avg | >1.5 std dev above company avg | Requires company history in `company_meta` |
| Risk Factor Delta | difflib ratio on Risk Factors text | >0.25 new lines | 10-K only |
| Filing Velocity | Days-to-file vs company median | >1.5× median | Requires company history |
| Friday Dump | Filed on Friday ≥ 15:30 ET | Boolean | Pure datetime check |
| Boilerplate Erosion | difflib ratio vs prior filing | <0.55 similarity | Requires prior filing |
| Numeric Tracker | Regex-extracted figures vs prior | Material directional change | Requires prior period data |
| Section Length | Risk Factors word count vs avg | >1.4× company average | Requires company history |
| 8-K Burst | Count 8-Ks in 30-day window | ≥3 in 30 days | Queries `filing_events` table |

Signals that require historical company data (`company_meta`) gracefully skip on first filing from a new company and populate the baseline for future comparisons.

---

## Pipeline Execution Flow

`sec_scraper.py` is the entry point. Execution order:

```python
1. load_dotenv() via db.py import
2. Connect to Upstash Redis (UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN)
3. For each form_type in ["10-K", "10-Q", "8-K", "DEF 14A"]:
   a. Fetch EDGAR RSS feed (BeautifulSoup, Atom XML)
   b. For each entry in feed:
      i.   Check Redis: SETNX accession_number → skip if exists
      ii.  Check CIK against cik_map.py watchlist → skip if not found
      iii. Download filing HTML (with User-Agent header, 120ms rate limit)
      iv.  html_cleaner.clean_filing(html) → {section_1a, section_7, section_1}
      v.   signal_extractor.extract_signals(sections, company_meta) → signals dict
      vi.  If signals["signals_flagged"]:
               gemini_enricher.enrich(excerpt) → {summary, confidence, tags}
               discord_notify.send(filing_data, signals, ai_summary)
      vii. db.upsert_filing(row)
      viii.db.upsert_company_meta(updated_stats)
      ix.  If form_type == "8-K": db.insert_filing_event(cik, accession, filed_at)
4. Log summary: N filings processed, M flagged
```

---

## Frontend Architecture

The entire dashboard is in `frontend/app/page.tsx` (~1100 lines). Components are not yet split into separate files.

**Component hierarchy:**
```
Page (root)
├── HomeView          ← full-viewport landing, rendered without sidebar
└── app-shell div
    ├── Sidebar
    │   ├── Brand
    │   ├── Nav (Filings / Search[SOON] / Signals[SOON])
    │   ├── Company search input
    │   └── Company list (scrollable, flagged dot indicator)
    └── main.main-area
        └── div.main-content (max-width: 860px, margin: 0 auto)
            └── FilingsTabs (Feed | Companies | Flagged)
                ├── FeedView
                │   ├── Type breakdown stats
                │   ├── Search input + form-type filter chips
                │   └── Filing cards list
                ├── CompanyListView
                └── FlaggedView
                    └── CompanyFilingsView (drill-down, replaces tabs)
```

**State in Page component:**
- `filings: Filing[]` — full list, populated from Supabase + Realtime inserts
- `loading: boolean` — true until initial fetch resolves
- `view: "home" | "feed" | "company" | "flagged"` — current route
- `activeCik: string | null` — set when drilling into a company

**Hash routing:** `window.location.hash` drives navigation. `#feed`, `#company`, `#flagged`, `#c=CIK`. No Next.js router used.

**CSS classes to know:**
- `.app-shell` — flex row, full viewport
- `.sidebar` — 288px, sticky, flex column
- `.main-area` — flex: 1, padding 40px 48px, flex column
- `.main-content` — max-width: 860px, margin: 0 auto
- `.filing-card` — hover lift + box shadow transition
- `.filter-chip` / `.filter-chip.active` — form type toggle buttons
- `.search-input` — feed search bar
- `.sidebar-search` — company list filter
- `.label-caps` — 10px uppercase tracking label
- `.anim-fade-up`, `.anim-slide-up` — entrance animations

---

## Implementation Gaps (Work Remaining)

These are known incomplete items as of the current commit:

**GitHub Actions workflow** (`summa-pipeline.yml`) is a stub. It needs:
- `on: schedule: - cron: '*/10 * * * *'`
- Python setup step with `actions/setup-python@v4`
- `pip install -r scraper/requirements.txt`
- `python -m spacy download en_core_web_md`
- `python scraper/sec_scraper.py`
- All 7 backend secrets mapped from `${{ secrets.* }}` to env vars
- A keep-alive mechanism (self-dispatch or weekly commit) to prevent GitHub from suspending the cron

**Frontend component files** (`FilingCard.tsx`, `SignalBadge.tsx`, `ULIChart.tsx`, `SkeletonCard.tsx`) are empty stubs. All components currently live in `page.tsx`. These should be extracted when the file grows unwieldy.

**`.env.example`** does not exist yet. Should be created as a committed template with all variable names but no values, with comments explaining where to find each.

**Cloudflare Pages deployment** is not configured yet. Needs: repository connected, build command `npm run build` in `frontend/`, output directory `out`, two NEXT_PUBLIC env vars set.

**`signal_extractor.py` signal thresholds** — the constants controlling when each signal fires need unit test coverage before going to production. `tests/test_signal_extractor.py` exists but may not cover all threshold edge cases.

---

## Adding New Features

### Adding a new signal to Stage 1

1. Add the signal logic as a private function `_compute_signal_name(sections, meta)` in `signal_extractor.py`
2. Return `{"score": float, "flagged": bool, "excerpt": str}`
3. Add it to the main `extract_signals()` return dict
4. Update `signals_flagged` logic: `any(s["flagged"] for s in signals.values())`
5. Add a unit test in `tests/test_signal_extractor.py` covering the threshold boundary
6. Add a migration to `schema.sql` if new columns are needed (use `ALTER TABLE IF NOT EXISTS`)

### Adding a new frontend view

1. Add a new hash value to the routing `if/elif` block in `Page`
2. Add the view component function in `page.tsx`
3. If it is a sub-view of Filings, add it as a tab in `FilingsTabs`
4. If it is a top-level feature, add a nav item in `Sidebar`'s `navItems` array
5. Add the CSS class to `globals.css` if new styles are needed

### Adding a new database table

1. Write the `CREATE TABLE IF NOT EXISTS` statement in `schema.sql`
2. Add indexes for the query patterns you know you'll need
3. Add RLS policies — default deny, then explicit grants
4. Add a helper function to `db.py` for the primary operations
5. Test with `demo_supabase.py` before wiring into the main pipeline

---

## Environment Setup for Local Development

```bash
# Backend
cd scraper
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m spacy download en_core_web_md
# create scraper/.env from the variable list in README.md

# Frontend
cd frontend
npm install
# create frontend/.env.local with NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev   # http://localhost:3000

# Tests
cd tests
pytest -v
```

The frontend dev server uses Turbopack. If it hangs on startup and the project is inside OneDrive, pause OneDrive sync for the project directory — OneDrive file locking interferes with Turbopack's file watching.

---

## Key Decisions Log

**Why `page.tsx` is one large file:** The component split into separate files was deferred intentionally. All components share the `Filing` type, utility functions (`elapsed`, `fmtDate`, `formColor`), and design token references. Splitting too early creates prop-drilling or context overhead. Split when any single component exceeds ~200 lines or is reused across multiple pages.

**Why `config.cache = false` was removed from `next.config.mjs`:** It was disabling webpack's filesystem cache, causing full recompilation on every dev server start. Combined with OneDrive sync, this caused the dev server to hang indefinitely. Removed — Next.js manages its own cache correctly.

**Why Turbopack is enabled for dev:** `next dev --turbopack` bypasses webpack entirely for development, dramatically reducing startup time and eliminating the file-locking issues that caused the hanging dev server on Windows + OneDrive.

**Why the sidebar nav consolidates Feed/Companies/Flagged into one item:** These three views are sub-views of the same data (filings), not distinct features. Exposing them as top-level nav items misrepresented the information architecture. They are now tabs within the single Filings nav item, matching how users conceptually think about the data.

**Why RLS allows anon INSERT/UPDATE on `filings` and `company_meta`:** This was an early schema decision to allow the scraper to use the anon key. It was subsequently changed to use service_role. The anon write policies currently in `schema.sql` are vestigial and should be dropped in a future migration — anon users should have SELECT only. The service_role key bypasses RLS entirely so no anon write policy is needed for the scraper.
