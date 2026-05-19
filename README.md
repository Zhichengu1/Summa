# Summa — SEC Filing Intelligence

> Automated signal detection for EDGAR filings. Monitors 10-K, 10-Q, 8-K, and DEF 14A every 10 minutes across a watchlist of high-alpha companies, extracts investment-relevant signals without LLMs, and surfaces anomalies before anyone reads the document.

---

## Why This Exists

Every public company in the United States is legally required to file structured disclosures with the SEC. These filings — 10-Ks, 10-Qs, 8-Ks, proxy statements — are public the moment they land on EDGAR. The problem is that no individual can read 500 companies' filings in real time, and the financial data industry has trained itself to only look at the numbers inside the filing, not the structure of the filing itself.

Summa is built around a different idea: **the structure of how a company files contains signals that are almost never discussed.**

Consider these patterns, all of which are detectable algorithmically and all of which have documented relationships to subsequent price action and corporate events:

- A company that historically files its 10-K 38 days after fiscal year-end suddenly takes 74 days. The document eventually looks fine. But the delay itself is a signal — auditors pushed back, something needed to be renegotiated, or legal review was unexpectedly difficult.
- A Risk Factors section that grew from 9,200 words to 16,400 words between two consecutive annual filings. The company is legally required to add new risk language only when genuine new risks materialize. A 78% expansion is not a style change.
- An MD&A section where 68% of sentences are new or substantially rewritten compared to the prior year. Stable companies copy most of their MD&A boilerplate. A boilerplate erosion score this low means management rewrote the section, which implies something material changed in how they describe the business.
- A CFO filing an 8-K on a Friday at 4:47 PM Eastern. This is a documented empirical pattern. Adverse corporate disclosures are disproportionately clustered in Friday afternoon filings, outside trading hours, when analyst desk coverage is minimal.
- Three 8-K filings from the same company in 22 days. A burst of material event filings is unusual. The market often prices individual 8-Ks in isolation without recognizing the pattern.

None of these require reading the filing. All of them are computable from structure alone.

**The algorithm finds the signal. The LLM only formats it.** A 10-K is 80,000+ words. Running every filing through a language model would exhaust any free API quota within hours and add no precision — the patterns above are deterministic. Gemini is only called when the algorithm has already flagged something, and it receives only the pre-extracted short excerpt, never the full document. This keeps the entire pipeline at zero cost indefinitely.

---

## Current Status

| Component | Status | Notes |
|---|---|---|
| SEC EDGAR scraper | ✅ Live | Fetches 10-K, 10-Q, 8-K, DEF 14A via RSS every 10 min |
| GitHub Actions pipeline | ✅ Live | Wired with secrets, running on cron schedule |
| Monthly data cleanup | ✅ Live | Deletes rows older than 30 days on the 1st of each month |
| Redis deduplication | ✅ Complete | 30-day TTL per accession number via Upstash |
| HTML cleaning | ✅ Complete | Strips JS/CSS/XBRL, extracts Item sections |
| Signal extraction (Stage 1) | ✅ Complete | All 9 signals implemented, pure Python |
| Gemini enrichment (Stage 2) | ✅ Complete | Conditional on Stage 1 flagging |
| Discord notifications | ✅ Complete | Rich embeds with signal breakdown |
| Database schema | ✅ Complete | Three tables + RLS + column grants + indexes |
| Supabase persistence | ✅ Complete | Upsert with conflict resolution, watchlist-scoped |
| Security hardening | ✅ Complete | CIK validation, URL guards, retry logic, memory caps |
| Frontend feed | ✅ Live | Realtime subscription, filter bar, search, 30-day window |
| Frontend UI | ✅ Complete | Full redesign — larger type, better contrast, active state tints |
| Company intelligence dashboard | 🔧 Phase 2 | Per-company summary + investment signal charts — **next focus** |
| 30-day filing summary report | 🔧 Phase 2 | Gemini-generated monthly digest per company |
| Signal trend charts | 🔧 Phase 2 | ULI, velocity, risk delta, boilerplate over time |
| Key metric extraction | 🔧 Phase 2 | Revenue, EPS, margins from numeric tracker |
| Semantic search | 🔲 Phase 3 | pgvector column ready, embeddings not yet |
| Alert severity score | 🔲 Phase 3 | Composite 0–100 scoring not yet built |
| Supply chain graph | 🔲 Phase 3 | NetworkX integration not yet built |
| Backtesting dashboard | 🔲 Phase 4 | yfinance in requirements, UI not yet built |

---

## How It Works

### Pipeline Overview

GitHub Actions runs the scraper every 10 minutes around the clock. Each run fetches four RSS feeds from SEC EDGAR — one for each filing type — and processes any filings that have not been seen before. A complete run on a quiet day (no new filings) takes under two seconds. A run that processes five new flagged filings might take 30–45 seconds including Gemini calls.

```
┌─────────────────────────────────────────────────────────────────────┐
│  GitHub Actions (cron: every 10 minutes)                            │
│                                                                     │
│  EDGAR RSS Feeds                                                    │
│  ├── /cgi-bin/browse-edgar?action=getcurrent&type=10-K             │
│  ├── /cgi-bin/browse-edgar?action=getcurrent&type=10-Q             │
│  ├── /cgi-bin/browse-edgar?action=getcurrent&type=8-K              │
│  └── /cgi-bin/browse-edgar?action=getcurrent&type=DEF+14A          │
│           │                                                         │
│           ▼                                                         │
│  CIK watchlist filter (checked first to protect Redis quota)        │
│  Not in watchlist? → skip immediately                               │
│           │                                                         │
│           ▼                                                         │
│  Upstash Redis — accession number lookup                            │
│  (SET NX with 30-day TTL per accession)                            │
│  Already seen? → skip immediately                                   │
│           │                                                         │
│           ▼                                                         │
│  HTML fetch + cleaning (html_cleaner.py)                            │
│  · Strip all <script>, <style>, XBRL inline tags                   │
│  · Extract Item 1A (Risk Factors), Item 7 (MD&A),                  │
│    Item 1 (Business) by heading pattern matching                    │
│  · Cap each section at 8,000 characters                             │
│           │                                                         │
│           ▼                                                         │
│  Stage 1: Signal Extraction (signal_extractor.py)         ◄── FREE │
│  · 9 deterministic signals, no API calls                            │
│  · Runs on every qualifying filing                                  │
│  · Output: signals dict with scores + excerpts                      │
│           │                                                         │
│      signals_flagged?                                               │
│      ┌────┴────┐                                                    │
│     YES        NO                                                   │
│      │          └──► write to Supabase (signals_flagged=false)      │
│      ▼                exit                                          │
│  Stage 2: Gemini enrichment (gemini_enricher.py)                    │
│  · Send ONLY the pre-extracted excerpt (~200 words)                 │
│  · Receive structured JSON: summary, confidence, tags              │
│  · Uses gemini-2.0-flash-exp (1,500 free calls/day)                │
│           │                                                         │
│           ▼                                                         │
│  Write to Supabase (db.py)                                          │
│  · upsert filings (on_conflict: accession_number)                  │
│  · upsert company_meta (rolling stats update)                       │
│  · insert filing_events (8-K burst tracking)                        │
│           │                                                         │
│           ▼                                                         │
│  Discord webhook alert (discord_notify.py)                          │
│  · Rich embed: company, signals, AI summary                         │
└─────────────────────────────────────────────────────────────────────┘
           │
           ▼ (Supabase Realtime — WebSocket push, no polling)
┌──────────────────────────────────┐
│  Next.js Frontend                │
│  · Shows last 30 days of filings │
│  · Watchlist companies only      │
│  · New filings appear instantly  │
│  · Memory-capped at 200 entries  │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│  Monthly Cleanup (1st of month)  │
│  · Deletes filings > 30 days     │
│  · Deletes filing_events > 30d   │
│  · Preserves company_meta        │
└──────────────────────────────────┘
```

### Data Scoping and Retention

The pipeline only processes filings for companies in `CORE_WATCHLIST` (currently 7 companies: AAPL, MSFT, AMZN, GOOGL, META, TSLA, NVDA). The CIK filter runs before Redis deduplication, keeping Redis usage well under the 10,000 command/day free limit.

The frontend query is scoped to the same watchlist CIKs and limited to the last 30 days, with a maximum of 50 rows returned on initial load. New filings arrive via WebSocket push — no polling.

A monthly GitHub Actions workflow (`summa-cleanup.yml`) runs on the 1st of every month at 3 AM UTC and deletes all `filings` and `filing_events` rows older than 30 days. The `company_meta` table is never cleaned — it stores rolling baselines that the signal algorithm needs for historical comparisons.

### Weekend and Holiday Handling

The SEC EDGAR RSS feed is a rolling window of the last ~40 filings. It is never empty. On a Saturday or federal holiday, the feed returns the same ~40 filings from the previous trading day, frozen in place.

Redis deduplication naturally handles this: every accession number in a Saturday feed was already stored in Redis on Friday. The scraper finds zero unseen entries, logs one line, and exits in under two seconds. No calendar library, no holiday list, no timezone detection. Redis is the holiday handler.

### Security Architecture

- CIK values parsed from EDGAR RSS are validated as numeric-only before use
- Filings with missing primary document names are skipped rather than storing broken URLs
- The Supabase anon key is restricted to SELECT on 12 specific columns of `filings` — raw extracted text, signal scores, and Gemini output are never readable by the frontend
- The service_role key lives only in GitHub Actions secrets and the local `scraper/.env` (gitignored)
- The Realtime subscription caps the in-memory filings array at 200 entries to prevent memory bloat

---

## Signal Extraction Algorithm

This is the intellectual core of Summa. Every qualifying filing passes through all nine signals before any external API is touched. The total cost is zero — pure Python, no network calls.

### Signal 1: Keyword Scoring

Four curated keyword dictionaries cover the signal domains most predictive of material events:

- **Supply chain:** "supplier," "manufacturing," "logistics," "tariff," "sourcing," "inventory," "lead time," "single-source," "concentration"
- **Geopolitical:** "sanctions," "export control," "trade war," "regulatory," "government," "political instability," "conflict," "restriction"
- **Management changes:** "departure," "resignation," "appointed," "transition," "search committee," "interim," "succession"
- **Earnings risk:** "impairment," "write-down," "restatement," "going concern," "covenant," "default," "liquidity," "material weakness"

Each sentence in the relevant filing section is tokenized and scored by keyword density (matches per word, normalized). Sentences above a configurable threshold are stored as excerpts. The signal is flagged if total keyword density across the section exceeds the section-level threshold.

### Signal 2: Uncertainty Language Index (ULI)

The MD&A section is scanned for 47 hedging phrases: "may," "could," "might," "approximately," "subject to," "no assurance," "cannot guarantee," "contingent upon," "if market conditions," and others. The ULI is the ratio of hedge-word occurrences to total sentence count.

The signal fires when the current ULI is more than 1.5 standard deviations above that company's rolling 8-quarter ULI average, stored in `company_meta`. A rising ULI quarter-over-quarter means management is hedging more heavily — a signal that often precedes earnings misses or guidance reductions.

### Signal 3: Risk Factor Delta

The current 10-K's Risk Factors section is compared line-by-line against the same company's prior-year 10-K stored in `company_meta.prior_risk_factors_text` using Python's `difflib.SequenceMatcher`. The delta score is the ratio of added lines to total lines.

Companies are legally required to add new risk disclosures only when genuine new risks emerge. A delta score above 0.25 (more than 25% new lines) is treated as material. New lines are stored as the signal excerpt. This signal is only available for 10-K filings.

### Signal 4: Filing Velocity Score

The `period_of_report` date from the filing header and the `filed_at` timestamp are used to compute days-to-file. This is compared against `company_meta.median_velocity_days`, the rolling median over that company's history.

The signal fires when the current filing is more than 1.5× the historical median. A company with a 40-day median that files in 75 days is investigated automatically. Late filings are correlated with audit disputes, restatements, and major negative events.

### Signal 5: Friday After-Hours Flag

The `filed_at` timestamp is converted to US Eastern time. The signal fires if the day of week is Friday (weekday == 4) and the hour is 15 or later (3:00 PM ET or after). No library is required — a single datetime comparison.

This pattern is empirically documented in academic finance literature. A disproportionate share of adverse corporate announcements — earnings warnings, executive departures, regulatory actions — are filed on Friday afternoons when analyst desk coverage is at its weekly minimum.

### Signal 6: Boilerplate Erosion Score

The full cleaned text of the current filing is compared against the same company's prior filing of the same type using `difflib.SequenceMatcher.ratio()`. The output is a similarity score from 0.0 to 1.0.

Most stable companies score above 0.82 — large parts of the filing are copied from the prior year. A score below 0.55 means less than 55% of the text survived intact, indicating substantial rewrites. A sudden drop is the signal, not the absolute value.

### Signal 7: Numeric Claim Tracker

All dollar amounts (e.g., "$1.2 billion," "$840M"), percentages (e.g., "increased 12%," "declined 8.3%"), and earnings-per-share figures in the MD&A are extracted via regex. These are stored as structured data in `company_meta` and compared against the prior period.

Percentage-point changes in key metrics — revenue growth deceleration, margin compression, EPS decline — are computed automatically. The signal fires when a tracked metric shows a meaningful directional change.

### Signal 8: Section Length Anomaly

The word count of the Risk Factors section is compared against `company_meta.avg_risk_factor_length`, the rolling average for that company. The signal fires when the current section is more than 40% longer than the historical average.

### Signal 9: 8-K Burst Detection

The `filing_events` table records every 8-K filing with its CIK and timestamp. A query counts how many 8-K entries exist for the company within the past 30 days. The signal fires at three or more. This uses Supabase rather than Redis to preserve the Redis daily command quota.

---

## Tech Stack

**GitHub Actions** — Orchestration at zero cost. Unlimited minutes on public repos. Runs every 10 minutes with a hard 8-minute timeout to prevent overlap.

**Supabase** — SQL, pgvector (for Phase 3 semantic search), and Realtime (WebSocket push to frontend) in a single free-tier service. 500MB storage, 2GB transfer/month.

**Upstash Redis** — Persistent deduplication across GitHub Actions runs (each run is a fresh container). 10,000 commands/day free. Typical daily usage is under 2,000 commands because the CIK watchlist filter runs before any Redis check.

**Google Gemini 2.0 Flash** — 1,500 free requests/day, no credit card. Called only when Stage 1 flags something — in practice 10–30 calls/day.

**spaCy `en_core_web_md`** — Medium model required. The small model's NER is insufficient for financial company names, executive titles, and geographic entity detection needed for Phase 3.

**Cloudflare Pages** — Static Next.js export, no bandwidth cap, no function timeout. Redeploys automatically on every push to main.

**Discord Webhooks** — Zero configuration alert delivery. Single POST per flagged filing, no authentication required.

---

## Database Design

Three tables designed to stay within the Supabase free tier indefinitely.

```sql
filings           -- one row per processed filing (30-day rolling window)
company_meta      -- one row per tracked company (rolling stats, kept forever)
filing_events     -- lightweight 8-K event log for burst detection
```

### Row Level Security

RLS is enabled on all three tables:

- **Frontend (anon key):** SELECT on 12 specific columns of `filings` only. Raw text sections, all signal scores, Gemini output, and embeddings are blocked from the anon role entirely via column-level grants.
- **Backend (service_role key):** Bypasses RLS — full access. Used exclusively by the scraper in GitHub Actions. Never in any frontend code.
- **`filing_events`:** Zero anon access. No SELECT policy defined — RLS default-deny applies.

---

## Frontend

### Design

Dark terminal aesthetic throughout. The color system uses CSS custom properties (`--bg-0` through `--bg-3`, `--fg-0` through `--fg-4`, `--accent`, `--alert`, `--warn`) with strongly differentiated background layers and clearly visible 2:1 contrast borders. Active states on nav items, tabs, and sidebar entries use an accent-tinted background (`#4fd4c214`) to clearly distinguish selected from unselected.

Type scale is sized for comfortable reading at 100% browser zoom — base font 16px, company names 18px, section headers 28px, home brand 70px. Sidebar is 340px wide, main content capped at 1160px.

### Data Flow

1. On mount: one Supabase query for filings from the last 30 days, watchlist CIKs only, limit 50, ordered by `filed_at` descending.
2. Realtime: a single WebSocket channel subscribes to `INSERT` events on `filings`. New rows are prepended to the in-memory array (capped at 200 to prevent memory bloat). No polling at any point.
3. Filtering: all client-side via `useMemo` — form type chips and free-text search add zero server round-trips.

### Navigation

```
Home (landing page)
└── Filings (sidebar nav)
    ├── Feed tab       ← chronological, last 30 days, watchlist only
    ├── Companies tab  ← grouped by company, click to drill down
    └── Flagged tab    ← signals_flagged=true or friday_dump=true
        └── Company detail view (filing timeline + stats bar)
```

---

## Local Setup

### Prerequisites

- Python 3.10 or higher
- Node.js 18 or higher
- A Supabase project (free tier) — run `schema.sql` once in the SQL Editor
- GitHub repository with 3 secrets wired (see below)

### Required Secrets — Minimum to Go Live

Only three secrets are required for the pipeline to fetch filings and write to Supabase:

| Secret | Where | Notes |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API | Project URL |
| `SUPABASE_KEY` | Supabase → Settings → API | **service_role key only** — never the anon key |
| `SEC_USER_AGENT` | You define | e.g. `"Summa/1.0 (you@email.com)"` — required by SEC |

### Optional Secrets

| Secret | Purpose | Effect if missing |
|---|---|---|
| `UPSTASH_REDIS_URL` | Deduplication | Pipeline re-checks filings each run; no DB duplicates (upsert handles it) |
| `UPSTASH_REDIS_TOKEN` | Deduplication | Same as above |
| `GEMINI_API_KEY` | Stage 2 enrichment | Gemini summaries not generated; signal data still written |
| `DISCORD_WEBHOOK_URL` | Alert notifications | No Discord alerts sent |

### Database Setup

Run `schema.sql` once in Supabase SQL Editor. All statements use `IF NOT EXISTS` — safe to re-run. Creates all three tables, RLS policies, column grants, and indexes. The `supabase_migrations.schema_migrations does not exist` message in Supabase logs is harmless — it is generated by the dashboard itself, not by the schema.

### Frontend Setup

```bash
cd frontend
npm install

# Create frontend/.env.local:
# NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

npm run dev     # http://localhost:3000 via Turbopack
```

If the dev server hangs on startup, pause OneDrive sync — OneDrive file locking interferes with Turbopack's file watcher on Windows.

### Triggering the Pipeline

After adding secrets and pushing to main, go to GitHub → Actions → summa-pipeline → Run workflow to trigger immediately without waiting for the 10-minute cron.

---

## Cost Model

| Service | Free Limit | Typical Daily Usage | Headroom |
|---|---|---|---|
| GitHub Actions | Unlimited (public repo) | ~144 runs × ~1 min | Unlimited |
| Supabase | 500MB storage, 2GB transfer | ~0.1MB storage/day | Years |
| Upstash Redis | 10,000 commands/day | ~200–800 commands/day | 12–50× |
| Gemini 2.0 Flash | 1,500 requests/day | 5–30 flagged filings/day | 50–300× |
| Cloudflare Pages | Unlimited bandwidth | Varies by traffic | Unlimited |
| Discord Webhooks | No published limit | 5–30 messages/day | Unlimited |

---

## Next Steps — Phase 2: Company Intelligence Dashboard

The current system surfaces individual filing signals as they arrive. Phase 2 transforms this into a structured investment research tool: for each watchlist company, produce a comprehensive intelligence view driven by the last 30 days of filings — with Gemini-generated summaries, trend charts, extracted financial metrics, and ranked investment signals. Every piece of information shown is traceable directly to a filed document.

### 2.1 — Per-Company 30-Day Summary Report

**What it is:** A Gemini-generated narrative summary of everything a company has filed in the last 30 days, structured specifically for investment decision-making.

**Backend changes:**
- Add `scraper/report_generator.py` — runs monthly (triggered by `summa-cleanup.yml` before cleanup, so it has access to the full 30 days of data before deletion)
- Queries `filings` for all rows matching the company CIK in the last 30 days
- Builds a structured prompt for Gemini containing: form types filed, signal flags triggered, key excerpts from MD&A and Risk Factors, extracted numeric figures
- Gemini returns a JSON object with these fields:
  ```json
  {
    "executive_summary": "2–3 sentence overview for an investor",
    "key_risks": ["list of new or escalating risk factors mentioned"],
    "financial_highlights": ["revenue direction", "margin signals", "EPS changes"],
    "management_signals": ["executive changes", "tone shifts in MD&A"],
    "material_events": ["8-K items filed and their significance"],
    "investment_thesis_impact": "bull / neutral / bear and one-sentence rationale",
    "confidence": 0.0–1.0,
    "filing_sources": ["accession numbers used"]
  }
  ```
- Store the result in a new `company_reports` table: one row per company per month

**Database changes — add to `schema.sql`:**
```sql
CREATE TABLE IF NOT EXISTS company_reports (
    id              BIGSERIAL PRIMARY KEY,
    cik             TEXT NOT NULL,
    ticker          TEXT NOT NULL,
    report_month    DATE NOT NULL,           -- first day of the month covered
    executive_summary     TEXT,
    key_risks             JSONB,            -- array of strings
    financial_highlights  JSONB,            -- array of strings
    management_signals    JSONB,            -- array of strings
    material_events       JSONB,            -- array of strings
    investment_thesis     TEXT,             -- "bull / neutral / bear + rationale"
    confidence            FLOAT,
    filing_sources        JSONB,            -- array of accession numbers
    generated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (cik, report_month)
);

CREATE INDEX IF NOT EXISTS idx_company_reports_cik ON company_reports (cik, report_month DESC);
```

**Frontend changes:**
- Add a **Reports** tab to the company detail view (alongside the filing timeline)
- Show the latest monthly report at the top: executive summary in a highlighted card, then collapsible sections for risks, financials, management signals, material events
- Show the `investment_thesis` prominently with a color-coded badge: green (bull), yellow (neutral), red (bear)
- Link each insight back to the specific filing it came from

---

### 2.2 — Investment Signal Trend Charts

**What it is:** For each company, time-series charts of the signals that matter most to investors — visualizing how a company's risk profile has changed over time, not just at a single point.

**Charts to build (one per company detail view):**

**Chart 1 — Uncertainty Language Index (ULI) over time**
- X axis: quarters (from `period_of_report`)
- Y axis: ULI score (hedge word ratio)
- Series: company ULI, dashed horizontal line at company's rolling average
- Investment interpretation: rising ULI = management becoming less confident; threshold crossing = signal fired
- Data source: `filings.uli_score` per quarter, grouped by CIK

**Chart 2 — Risk Factor Size trend**
- X axis: annual 10-K filing dates
- Y axis: word count of Risk Factors section
- Bar chart with a reference line at the company's historical average
- Investment interpretation: sudden expansion = new risks disclosed
- Data source: `filings.section_risk_factors` word count by year

**Chart 3 — Filing Velocity**
- X axis: each filing date
- Y axis: days from `period_of_report` to `filed_at`
- Scatter plot with a dashed line at the company's median
- Color: red dot when `filing_velocity_flag = true`
- Investment interpretation: late filings correlate with audit disputes and restatements

**Chart 4 — Signal Activity Heatmap**
- X axis: months (last 12 months)
- Y axis: signal types (ULI, Risk Delta, Velocity, Boilerplate, 8-K Burst, Keywords, Friday Dump)
- Cell color: grey (no signal), yellow (flagged), red (flagged + high confidence)
- Investment interpretation: clusters of red across multiple signals = high-conviction alert

**Chart 5 — 8-K Event Timeline**
- X axis: date
- Vertical lines for each 8-K filed, labeled with item type (earnings, executive change, material agreement, etc.)
- Color-coded by impact: red for high-impact items (2.02 earnings, 5.02 executive change, 1.03 bankruptcy), grey for routine
- Investment interpretation: burst patterns and item types visible at a glance

**Chart 6 — Boilerplate Erosion over time**
- X axis: filing dates
- Y axis: similarity score (0.0 = total rewrite, 1.0 = identical)
- Area chart, shaded below the 0.55 threshold line
- Investment interpretation: sudden drops mean management rewrote major sections

**Frontend implementation:**
- Use **Recharts** (already compatible with Next.js static export, React-native, no canvas dependencies)
- Add to `package.json`: `"recharts": "^2.x"`
- Charts render inside the company detail view, below the stats bar and above the filing timeline
- Each chart is expandable/collapsible — collapsed by default to keep the layout clean
- No server-side data processing — all chart data is derived from the in-memory `filings` array already loaded

---

### 2.3 — Key Financial Metric Extraction

**What it is:** Automatically pull the financial figures that matter most to investors out of each 10-K and 10-Q, structured and comparable across quarters.

**Metrics to extract (from MD&A section, regex + spaCy):**
- Revenue (total, YoY change %)
- Gross margin (%)
- Operating income / loss
- Net income / EPS
- Cash and equivalents
- Free cash flow (operating cash flow − capex)
- Debt levels (long-term debt, net debt)
- Guidance language (forward-looking statements and quantitative targets)
- Share buyback authorizations
- Dividend changes

**Backend — extend `signal_extractor.py`:**
```python
def extract_financial_metrics(sections: dict) -> dict:
    """
    Regex + pattern matching on MD&A to extract key financial figures.
    Returns structured dict suitable for storage in filings.numeric_claims.
    """
```

Patterns to match:
- Revenue: `\$[\d,.]+\s*(billion|million|B|M)` near words "revenue," "net sales," "total revenue"
- Margin: `\d+\.?\d*\s*%` near "gross margin," "operating margin"
- EPS: `\$[\d.]+\s*(per share|diluted|basic)`
- Guidance: sentences starting with "we expect," "we anticipate," "guidance," "we project"

Store structured output in `filings.numeric_claims` (already a JSONB column in schema).

**Frontend:**
- In the company detail view, show a **Metrics** row above the charts: last reported revenue, margin, EPS, cash — each with a colored delta arrow (▲ green, ▼ red) versus the prior filing
- Clicking a metric opens a sparkline chart of that metric over the last 4 quarters

---

### 2.4 — Investment Signal Card (per filing)

**What it is:** Replace the current minimal filing card with a richer card that immediately answers the investor's question: "Why does this filing matter to my position?"

**New filing card layout:**
```
┌────────────────────────────────────────────────────────────────┐
│ [Mark]  Apple Inc.                                   2h ago    │
│         AAPL · 10-K · Period: Dec 2024                         │
│                                                                │
│ ┌─ INVESTMENT SIGNALS ──────────────────────────────────────┐  │
│ │ 🔴 Risk factors expanded +34% — 47 new lines added        │  │
│ │ 🟡 ULI score 0.31 — 1.8σ above company average           │  │
│ │ 🟡 Filed 12 days later than historical median             │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                │
│ GEMINI SUMMARY                                                 │
│ Apple's 10-K introduces new risk language around EU Digital    │
│ Markets Act compliance and supply chain concentration in       │
│ Malaysia. MD&A hedging language elevated vs prior year...      │
│                                                                │
│ KEY FIGURES   Revenue ▲12%  Margin 44.5%  EPS $6.42 ▲8%      │
│                                                          View ↗│
└────────────────────────────────────────────────────────────────┘
```

**Signal severity coloring:**
- 🔴 Red: signal score in top quartile for this company historically, or multiple signals co-firing
- 🟡 Yellow: signal fired but below high-severity threshold
- ⬜ Grey: signal present but below threshold (shown only in expanded view)

---

### 2.5 — Monthly Report Digest (Discord + Frontend)

**What it is:** On the 1st of each month (before cleanup runs), generate a digest report for the entire watchlist and post it to Discord. Store it in the frontend for reference.

**Report contents:**
1. Which companies filed what (table of filing activity by type)
2. Top 3 highest-severity signals across all companies this month
3. Companies with improving vs deteriorating signal profiles
4. New risk themes that appeared across multiple companies (keyword co-occurrence)
5. 8-K material events summary — what categories of events dominated

**Implementation:**
- Add `generate_monthly_report()` to `scraper/report_generator.py`
- Called from `summa-cleanup.yml` before the delete step — data must be read before it is purged
- Posts a formatted Discord message (multiple embeds) and writes to a `monthly_digests` table
- Frontend shows the latest digest in a new **Digest** section accessible from the sidebar

---

### 2.6 — Composite Severity Score

**What it is:** A single 0–100 score per filing that ranks how material the filing is from an investment perspective. Replaces binary `signals_flagged` with a prioritized severity system.

**Scoring formula (proposed weights):**

| Signal | Weight | Rationale |
|---|---|---|
| Risk Factor Delta | 25% | Legally required new risk disclosure — highest quality signal |
| 8-K Burst (≥3 in 30d) | 20% | Pattern of material events, not isolated incidents |
| Boilerplate Erosion | 15% | Major management rewrite implies something changed |
| Filing Velocity | 15% | Late filing correlates with audit/restatement risk |
| ULI Shift | 10% | Management confidence decline |
| Friday Dump | 10% | Documented empirical pattern |
| Keyword Score | 5% | Context-dependent, lower precision than structural signals |

**Output:** `filings.severity_score` (0–100). Displayed on filing cards with color bands:
- 75–100: 🔴 Critical — warrants immediate review
- 50–74: 🟡 Elevated — review before next trading day
- 25–49: 🔵 Notable — add to watchlist for follow-up
- 0–24: ⬜ Routine — no signal above threshold

---

## Design Constraints

These are permanent architectural decisions, not limitations to revisit.

**No full filing to Gemini.** A 10-K is 80,000+ words. Sending the full document exhausts the free quota in a single call. Stage 1 always runs first and extracts a short excerpt. Only that excerpt goes to Gemini.

**No Gemini call when no signals are flagged.** Every call consumes daily quota. Stage 2 is conditional on Stage 1 output, not default.

**No Redis for 8-K burst detection.** Burst counting queries Supabase — zero Redis cost. Redis is reserved for deduplication only.

**No calendar logic.** Redis deduplication handles weekends and holidays automatically.

**Never use spaCy `en_core_web_sm`.** Always `en_core_web_md`. The small model's NER is insufficient for financial entity recognition.

**No async in the scraper.** Synchronous requests with rate limiting are sufficient for a cron pipeline processing dozens of filings per run.

**No raw HTML in the database.** Only cleaned section text, capped at 8,000 characters per section.

**No Vercel.** Cloudflare Pages serves the static export with no bandwidth cap or function timeout.

**No Next.js API routes.** The frontend is strictly read-only. All writes go through GitHub Actions with the service_role key.

**No hardcoded credentials.** Backend uses `scraper/.env` (gitignored). Frontend uses `frontend/.env.local` (gitignored). Production uses GitHub Secrets and Cloudflare Pages environment variables.
