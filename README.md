# ▚ Summa — SEC Filing Intelligence

> Automated signal detection for EDGAR filings. Monitors 10-K, 10-Q, 8-K, and DEF 14A every 10 minutes across a top-500 company watchlist, extracts alpha signals without LLMs, and surfaces anomalies before anyone reads the document.

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
| SEC EDGAR scraper | ✅ Complete | Fetches 10-K, 10-Q, 8-K, DEF 14A via RSS |
| Redis deduplication | ✅ Complete | Accession number deduplication via Upstash |
| HTML cleaning | ✅ Complete | Strips JS/CSS/XBRL, extracts Item sections |
| Signal extraction (Stage 1) | ✅ Complete | All 9 signals implemented |
| Gemini enrichment (Stage 2) | ✅ Complete | Conditional on Stage 1 flagging |
| Discord notifications | ✅ Complete | Rich embeds with signal breakdown |
| Database schema | ✅ Complete | All three tables + indexes + RLS |
| Supabase persistence | ✅ Complete | Upsert with conflict resolution |
| Frontend feed | ✅ Complete | Realtime subscription, filter bar, search |
| GitHub Actions pipeline | 🔧 Stub | Workflow file exists, needs secrets wired |
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
│  Upstash Redis — accession number lookup                            │
│  (SET NX with 30-day TTL per accession)                            │
│  Already seen? → skip immediately                                   │
│           │                                                         │
│           ▼                                                         │
│  CIK watchlist filter                                               │
│  (top 500 S&P 500 companies by CIK)                                │
│  Not in list? → skip                                                │
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
           ▼ (Supabase Realtime)
┌──────────────────────────────────┐
│  Next.js Frontend                │
│  · Realtime subscription         │
│  · New filings appear instantly  │
│  · No polling, no refresh needed │
└──────────────────────────────────┘
```

### Weekend and Holiday Handling

The SEC EDGAR RSS feed is a rolling window of the last ~40 filings. It is never empty. On a Saturday or federal holiday, the feed returns the same ~40 filings from the previous trading day, frozen in place.

Redis deduplication naturally handles this: every accession number in a Saturday feed was already stored in Redis on Friday. The scraper finds zero unseen entries, logs one line, and exits in under two seconds. No calendar library, no holiday list, no timezone detection. Redis is the holiday handler.

### Rate Limiting and SEC Compliance

Every HTTP request to any `sec.gov` domain includes a `User-Agent` header in the format `AppName/Version (contact@email.com)`. This is a hard SEC requirement for programmatic access. Requests that omit this header are blocked.

The scraper never exceeds 10 requests per second to EDGAR. All SEC requests are made synchronously with a 120ms delay between each request, staying well under the limit. Retries use exponential backoff with a maximum of three attempts before giving up on a filing.

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

The current 10-K's Risk Factors section is compared line-by-line against the same company's prior-year 10-K stored in `company_meta.risk_factors_prev` using Python's `difflib.SequenceMatcher`. The delta score is the ratio of added lines to total lines.

Companies are legally required to add new risk disclosures only when genuine new risks emerge. A delta score above 0.25 (more than 25% new lines) is treated as material. New lines are stored as the signal excerpt. This signal is only available for 10-K filings.

### Signal 4: Filing Velocity Score

The `period_of_report` date from the filing header and the `filed_at` timestamp are used to compute days-to-file. This is compared against `company_meta.median_days_to_file`, the rolling median over that company's history.

The signal fires when the current filing is more than 1.5× the historical median. A company with a 40-day median that files in 75 days is investigated automatically. Late filings are correlated with audit disputes, restatements, and major negative events.

### Signal 5: Friday After-Hours Flag

The `filed_at` timestamp is converted to US Eastern time. The signal fires if the day of week is Friday (weekday == 4) and the hour is 15 or later (3:00 PM ET or after). No library is required — a single datetime comparison.

This pattern is empirically documented in academic finance literature. A disproportionate share of adverse corporate announcements — earnings warnings, executive departures, regulatory actions — are filed on Friday afternoons when analyst coverage is at its weekly minimum.

### Signal 6: Boilerplate Erosion Score

The full cleaned text of the current filing is compared against the same company's prior filing of the same type using `difflib.SequenceMatcher.ratio()`. The output is a similarity score from 0.0 to 1.0.

Most stable companies score above 0.82 — large parts of the filing are copied from the prior year. A score below 0.55 means less than 55% of the text survived intact, indicating substantial rewrites. This is stored in `company_meta` and compared against the company's rolling average. A sudden drop is the signal, not the absolute value.

### Signal 7: Numeric Claim Tracker

All dollar amounts (e.g., "$1.2 billion," "$840M"), percentages (e.g., "increased 12%," "declined 8.3%"), and earnings-per-share figures in the MD&A are extracted via regex. These are stored as structured data in `company_meta.numeric_claims_prev`.

On each new filing, extracted numbers are compared against the prior period. Percentage-point changes in key metrics — revenue growth deceleration, margin compression, EPS decline — are computed automatically. The signal fires when a tracked metric shows a meaningful directional change, surfacing financial deterioration without any manual reading.

### Signal 8: Section Length Anomaly

The word count of the Risk Factors section is compared against `company_meta.avg_risk_section_length`, the rolling average for that company. The signal fires when the current section is more than 40% longer than the historical average.

Companies periodically expand their Risk Factors sections as a result of regulatory feedback, auditor pressure, or genuine new risk identification. An expansion this large without a corresponding acquisition or major corporate event is unusual and worth investigating.

### Signal 9: 8-K Burst Detection

The `filing_events` table records every 8-K filing with its CIK and timestamp. A query counts how many 8-K entries exist for the company within the past 30 days. The signal fires at three or more.

8-K filings report material events: executive changes, earnings pre-announcements, regulatory actions, credit events, mergers. A single 8-K is routine. Three in 30 days from the same company is a pattern. This uses Supabase rather than Redis to preserve the Redis daily command quota for deduplication.

---

## Tech Stack

### Why Each Tool Was Chosen

**GitHub Actions** — Orchestration needs to run every 10 minutes indefinitely at zero cost. GitHub Actions is the only credible free option: unlimited minutes on public repos with no timeout restrictions. Vercel serverless functions have a 10-second execution limit. AWS Lambda free tier expires. Google Cloud Run requires a credit card. GitHub Actions is the only tool that runs 10-minute jobs, unlimited, forever, for free.

**Supabase** — Three requirements drove this choice: SQL (needed for relational queries, not a key-value store), pgvector (needed for Phase 3 semantic search without adding a separate service), and Realtime (needed for the live frontend without polling). Supabase free tier provides all three: 500MB storage, 2GB transfer, unlimited Realtime connections. No other service offers all three free.

**Upstash Redis** — Deduplication requires a persistent key-value store that survives between GitHub Actions runs (each run is a fresh container). Supabase could theoretically do this, but a Redis SET-NX-with-TTL is a single command and adds zero database load. Upstash provides 10,000 commands/day free with no expiry. A typical day uses under 2,000 commands (40 filings × 4 feeds × ~10 commands each, maximum).

**Google Gemini 2.0 Flash** — 1,500 free requests per day with no credit card required. No other LLM provider offers a viable free tier at this scale. The pipeline only calls Gemini when Stage 1 has flagged something — in practice, perhaps 10–30 calls per day — so the quota is never approached. `gemini-2.0-flash-exp` is used specifically (not 1.5 Flash) for better instruction-following on structured JSON output.

**spaCy `en_core_web_md`** — The medium model (43MB) provides meaningfully stronger named entity recognition than the small model (12MB). Company name extraction, executive title detection, and country name identification — all needed for Phase 3 supply chain graphs — require the medium model's accuracy. The difference is not marginal; the small model routinely misidentifies company names in financial text.

**Cloudflare Pages** — The frontend is a Next.js static export. Cloudflare Pages serves static files with no bandwidth cap, no build timeout, and no function cold start latency. Vercel's free tier limits bandwidth to 100GB/month and has a 10-second serverless function timeout. Neither limit applies to Cloudflare.

**Discord Webhooks** — No authentication, no bot token, no API key. A single POST request sends a rich embed to any Discord channel. No rate limit for a pipeline running 10-minute cycles. The alternative (email) requires an SMTP service; Slack requires OAuth configuration. Discord is the fastest possible alert integration.

---

## Database Design

### Schema Overview

Three tables, designed to stay within the Supabase free tier indefinitely. The total storage footprint for 10,000 processed filings is approximately 50MB.

```sql
filings           -- one row per processed filing
company_meta      -- one row per tracked company (rolling stats)
filing_events     -- lightweight 8-K event log for burst detection
```

### `filings` Table

The primary data store. One row per processed filing, upserted on `accession_number` to ensure idempotency. Key columns:

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `accession_number` | text | SEC-assigned unique identifier (e.g. 0000320193-24-000123) |
| `cik` | text | Company CIK (central index key) |
| `ticker` | text | Stock ticker symbol |
| `company_name` | text | Full company name from EDGAR |
| `form_type` | text | 10-K, 10-Q, 8-K, or DEF 14A |
| `filed_at` | timestamptz | When the filing was submitted to SEC |
| `period_of_report` | date | Fiscal period covered by the filing |
| `filing_url` | text | Direct link to the document on EDGAR |
| `section_*` | text | Extracted text of each Item section |
| `signals` | jsonb | Full signal output: scores, excerpts, thresholds |
| `signals_flagged` | boolean | True if any signal exceeded its threshold |
| `friday_dump` | boolean | True if filed Friday after 3:30 PM ET |
| `ai_summary` | text | Gemini-generated structured summary |
| `ai_confidence` | numeric | Gemini confidence score (0.0–1.0) |
| `embedding` | vector(768) | Reserved for Phase 3 semantic search |

### `company_meta` Table

Rolling historical statistics for each tracked company. Updated on every new filing from that company. Used by the signal extraction algorithm to compute deltas against baseline.

| Column | Type | Description |
|---|---|---|
| `cik` | text | Primary key |
| `ticker` | text | Current ticker |
| `median_days_to_file` | numeric | Rolling median filing velocity |
| `avg_risk_section_length` | numeric | Rolling average Risk Factors word count |
| `avg_uli_score` | numeric | Rolling average ULI score |
| `risk_factors_prev` | text | Prior year Risk Factors text for delta computation |
| `numeric_claims_prev` | jsonb | Prior period extracted financial figures |
| `boilerplate_score_prev` | numeric | Prior filing's similarity score |

### `filing_events` Table

Lightweight event log. One row per 8-K filing, containing only the data needed for burst detection queries. Kept separate from `filings` to avoid polluting the main table with high-frequency low-content records.

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `cik` | text | Company CIK |
| `form_type` | text | Always "8-K" |
| `accession_number` | text | EDGAR accession number |
| `filed_at` | timestamptz | Filing timestamp |

### Row Level Security

RLS is enabled on all three tables. Access is split cleanly between the frontend and backend:

- **Frontend (anon key):** SELECT only on `filings` and `company_meta`. No access to `filing_events` — this table is internal to the pipeline.
- **Backend (service_role key):** Full access, bypasses RLS. Used exclusively by the scraper running in GitHub Actions. This key is never in any frontend code or environment variable.

---

## Frontend

### Design Language

The UI uses a dark terminal aesthetic: near-black backgrounds (`#181c22`), cyan-teal accents (`#67d5c8`), monospace font throughout, and muted color scales for all supporting text. The design avoids generic card shadows, purple gradients, and icon libraries. Every visual element is either a Unicode symbol or a CSS-drawn shape.

The color system uses named CSS custom properties (`--bg-0` through `--bg-3`, `--fg-0` through `--fg-4`, `--accent`, `--alert`, `--warn`) so the full palette can be changed in one place. All colors are plain hex values — no `oklch()` or `hsl()` in runtime CSS, avoiding PostCSS processing complications on Cloudflare Pages.

### Layout

The dashboard uses a fixed sidebar (288px) with sticky positioning and a flexible main content area. Content is centered within the available space using a `max-width: 860px; margin: 0 auto` wrapper — so the feed is visually centered regardless of screen width.

The home page (landing) is a full-viewport centered layout with a one-shot scan-line animation, staggered card entrance animations, and a count-up stats bar. It renders without the sidebar.

### Data Flow

The frontend establishes a single Supabase Realtime channel on mount and subscribes to `INSERT` events on the `filings` table. New filings appear in the feed the moment the scraper writes them to the database — no polling, no page refresh. The initial load fetches the 200 most recent filings ordered by `filed_at` descending.

The feed supports client-side filtering (no server round-trip): form type chips (`10-K`, `10-Q`, `8-K`, `DEF 14A`) and a free-text search that matches company name and ticker. All filtering is done via `useMemo` over the in-memory array.

### Navigation Structure

```
Home (landing page)
└── Filings (sidebar nav item)
    ├── Feed tab    ← default, chronological filing list
    ├── Companies tab  ← grouped by company, sorted by latest filing
    └── Flagged tab    ← filtered to signals_flagged=true or friday_dump=true
        └── Company detail view (drill-down, no tabs shown)
```

The sidebar also shows a live company list filtered by the in-memory filings array. Companies with at least one flagged filing show a small red dot next to their ticker. A search input filters the company list by ticker or name.

---

## Local Setup

### Prerequisites

- Python 3.10 or higher
- Node.js 18 or higher
- A Supabase project (free tier)
- An Upstash Redis instance (free tier)
- A Google AI Studio API key (free, no credit card)
- A Discord server with a webhook URL

### Backend Setup

```bash
# Clone and enter the scraper directory
cd scraper

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Download the spaCy medium NLP model (~43MB)
python -m spacy download en_core_web_md

# Set up environment variables
# Create scraper/.env with the variables listed below
```

Run the scraper once manually to verify the setup:
```bash
python sec_scraper.py
```

On a successful first run you should see log lines for each RSS feed fetched, each accession number checked against Redis, and any new filings processed. If the watchlist filter catches nothing (likely on first run), you will see `0 new filings processed` — that is correct behavior.

### Database Setup

Open the Supabase SQL Editor and run the full contents of `schema.sql` once. This creates:
- All three tables with correct column types
- Indexes on `cik`, `form_type`, and `filed_at`
- The `vector(768)` column (requires pgvector extension, enabled by default on Supabase)
- RLS policies for anon and service_role access

This only needs to be run once per project. Re-running it is safe — all statements use `IF NOT EXISTS` and `DROP POLICY IF EXISTS`.

### Frontend Setup

```bash
cd frontend
npm install

# Create frontend/.env.local with:
# NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

npm run dev     # starts on http://localhost:3000 via Turbopack
```

The dev server uses Turbopack (`next dev --turbopack`) for fast startup. If you see the server starting but never becoming ready, check that OneDrive or another sync service is not locking files in the `node_modules` directory.

### GitHub Actions Setup

Add the following secrets to your GitHub repository (Settings → Secrets → Actions):

```
SUPABASE_URL
SUPABASE_KEY          ← service_role key, not anon
DISCORD_WEBHOOK_URL
GEMINI_API_KEY
UPSTASH_REDIS_URL
UPSTASH_REDIS_TOKEN
SEC_USER_AGENT
```

The workflow file at `.github/workflows/summa-pipeline.yml` runs on a `schedule: cron: '*/10 * * * *'` trigger. GitHub Actions requires a `push` or recent activity on a public repo to keep scheduled workflows running — a weekly keep-alive commit or a self-ping step in the workflow prevents the cron from being suspended.

### Deployment

**Backend:** Runs entirely in GitHub Actions. No server to deploy. Push to `main` and the cron runs automatically.

**Frontend:** Connect the repository to Cloudflare Pages. Set the build command to `npm run build` in the `frontend` directory and the output directory to `out`. Add the two `NEXT_PUBLIC_*` environment variables in the Cloudflare Pages dashboard. Every push to `main` triggers a redeploy automatically.

---

## Environment Variables

### Backend — `scraper/.env` locally, GitHub Secrets in CI

| Variable | Where to Get It | Notes |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API | Project URL, same for both backend and frontend |
| `SUPABASE_KEY` | Supabase → Settings → API | **service_role key** — full access, never expose to frontend |
| `DISCORD_WEBHOOK_URL` | Discord channel → Integrations → Webhooks | No expiry, no rotation needed |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) | Free, no credit card, 1,500 requests/day |
| `UPSTASH_REDIS_URL` | Upstash dashboard → REST API | REST URL format: `https://...upstash.io` |
| `UPSTASH_REDIS_TOKEN` | Upstash dashboard → REST API | Bearer token for REST API |
| `SEC_USER_AGENT` | You define this | Format: `"AppName/1.0 (email@domain.com)"` — SEC requirement |

### Frontend — `frontend/.env.local` locally, Cloudflare Pages env vars in production

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Same project URL as backend |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key only — restricted by RLS, safe for browser |

The `NEXT_PUBLIC_` prefix is intentional — these values are embedded in the browser bundle. The Gemini key, Discord webhook, and Redis credentials must never appear anywhere in the frontend codebase or environment.

---

## Cost Model

Summa is designed to run at zero cost indefinitely. This is not a "free trial" claim — every service used has a permanent free tier with limits that the system's design keeps well below.

| Service | Free Limit | Typical Daily Usage | Headroom |
|---|---|---|---|
| GitHub Actions | Unlimited (public repo) | ~144 runs/day | Unlimited |
| Supabase | 500MB storage, 2GB transfer | ~0.1MB storage/day, ~50KB transfer/run | Years |
| Upstash Redis | 10,000 commands/day | ~800–2,000 commands/day | 5–12× |
| Gemini 2.0 Flash | 1,500 requests/day | 5–30 flagged filings/day | 50–300× |
| Cloudflare Pages | Unlimited bandwidth | Varies by traffic | Unlimited |
| Discord Webhooks | No published limit | 5–30 messages/day | Unlimited |

If any single limit is ever approached, the response is always a code change — increasing deduplication window, reducing signal sensitivity, batching Gemini calls — never a paid upgrade.

---

## Roadmap

### Phase 3 — Deeper Intelligence

**Alert Severity Score**
Combine all nine signals into a single composite score from 0 to 100 per filing. Proposed weights: Risk Factor Delta 25%, 8-K Burst 20%, Boilerplate Erosion 15%, Filing Velocity 15%, ULI Shift 10%, Friday Dump 10%, Keyword Score 5%. The composite score replaces binary flags with a ranked severity system, enabling the frontend to sort by urgency and Discord alerts to include "🔴 HIGH / 🟡 MEDIUM / 🟢 LOW" severity tiers.

**Semantic Search via pgvector**
Embed extracted sections using Google's `text-embedding-004` model (free, produces 768-dimensional vectors, matches the column already defined in the schema). Store embeddings on every processed filing. Add a search interface to the frontend that accepts natural-language queries — "companies citing Vietnam supply chain exposure in the last 90 days" — and returns semantically similar filings using cosine similarity. No third-party search service needed. The entire implementation lives within the existing Supabase free tier.

**Cross-Company Supply Chain Graph**
spaCy's medium model already has strong named entity recognition for company names and locations. When Company A's Risk Factors section mentions Company B, store a directed edge `(A → B, weight, quarter)` in a new `supply_edges` table. After several quarters of data, this builds a directed graph across the S&P 500 using NetworkX. Cluster detection identifies when multiple companies in the same sector suddenly start citing the same supplier, country, or risk factor — a systemic signal that individual filing analysis would miss. The frontend would render a simplified graph view for any selected company.

**Signal Decay Tracking**
Extend `company_meta` with a `signal_streak` column per signal type, tracking how many consecutive filings a signal has been active. A supply chain risk that flags in three consecutive 10-Qs is fundamentally different from one that fired once and disappeared. Display streak counts on filing cards and factor them into the severity score — persistent signals carry more weight than one-off detections.

**Passive Voice Density**
spaCy's dependency parser can identify passive voice constructions (`nsubjpass` dependency arcs) without any API. "Revenue was impacted by" is passive; "we grew revenue by" is active. Track the passive-to-active ratio in the MD&A section quarter-over-quarter per company. A rising ratio is a documented signal of management distancing from results — companies in trouble often shift to passive voice before disclosing the specific problem.

**Sector-Level Signal Aggregation**
Add a `gics_sector` column to `company_meta`. When three or more companies in the same GICS sector flag the same signal type within any 7-day window, generate a sector-level alert: "3 semiconductor companies flagged supply chain risk in 7 days." This surfaces systemic industry trends before they become media headlines and gives context to individual company signals. The aggregation runs as an additional step at the end of each pipeline execution.

**Insider Transaction Correlation**
SEC Form 4 filings (insider buy/sell transactions) are freely available on EDGAR using the same RSS-based approach. Add Form 4 as a fifth feed type. Store insider transaction records in a new `insider_events` table. When a company has both a flagged filing signal and a cluster of insider selling in the same 30-day window, generate a combined alert. Two independent signals pointing the same direction significantly increases confidence.

**MCP Server Refactor**
Wrap the scraper's core functions in the official `mcp` Python SDK to expose them as MCP tools. At minimum: `query_filings(ticker, form_type, limit)`, `get_signals(ticker, quarters)`, `search_filings(query, top_k)`. This makes Summa queryable by any MCP-compatible AI agent or IDE (including Claude Code) without running the full pipeline. The scraper functions are already written as clean isolated functions — the MCP layer is wrapper code only.

### Phase 4 — User-Facing Expansion

**Backtesting Dashboard**
`yfinance` is already in `requirements.txt`. For each signal alert in the database, fetch the stock price at filing time and at T+5, T+10, and T+30 trading days using `yfinance`. Plot the distribution of post-signal price movements to answer: do Summa's signals actually precede price movements? The dashboard would show individual signal performance and the composite score's predictive accuracy. This also provides data to tune signal threshold weights — if Friday dump signals have a 62% hit rate but Risk Factor Delta has a 41% rate, weights should reflect that.

**Earnings Call Transcript Comparison**
8-K filings frequently include exhibit attachments (item 9.01) containing earnings call transcripts, available freely on EDGAR. Add extraction logic to identify and download these exhibits. Extract forward-looking statements using a curated pattern list ("we expect," "we anticipate," "guidance," "we plan to"). Compare these statements against disclosures in the next quarterly 10-Q from the same company. Divergence between what management said on the earnings call and what they formally disclosed three months later is a meaningful signal that existing tools do not surface.

**Custom Signal Portfolios**
Add a `signal_portfolios` table to Supabase: user-defined keyword dictionaries stored as jsonb arrays. Stage 1 runs user portfolios alongside the built-in keyword lists. Each matched signal is tagged with the portfolio name. Users can create theme-specific monitors: "lithium battery supply chain," "data privacy regulatory risk," "executive succession." The frontend shows portfolio-tagged signals separately from built-in signals.

**Webhook Relay**
Add a `webhook_subscriptions` table: `(ticker, webhook_url, secret)`. After each pipeline run, for any filing that triggered signals, post the structured signal payload to all registered webhook URLs for that ticker using a simple HMAC signature for verification. No user interface required for Phase 4 — subscriptions are managed by direct database inserts. This allows external systems (trading platforms, internal tools, other applications) to consume Summa signals programmatically.

---

## Design Constraints

These are permanent architectural decisions. They reflect deliberate tradeoffs made to keep the system maintainable, free, and correct. They are not limitations to revisit later.

**No calendar logic.** The EDGAR RSS feed is never empty. On weekends and federal holidays it returns the same ~40 filings from the previous trading day. Redis deduplication handles this automatically. Adding calendar detection would require a holiday list (which changes), timezone handling (which has edge cases), and logic that would need updating annually. It solves a problem that does not exist.

**Never send a full filing to Gemini.** A 10-K is 80,000+ words. Sending the full document uses approximately 150,000 tokens — exhausting the entire day's free quota on a single document. The pipeline is designed so the signal extraction algorithm always runs first and extracts a short excerpt (~150–300 words). Only that excerpt goes to Gemini.

**Never call Gemini when no signals are flagged.** Every Gemini call consumes daily quota. If Stage 1 finds no signals, there is nothing for Gemini to enrich. Stage 2 is conditional, not default.

**Never use Redis for 8-K burst detection.** The Upstash free tier provides 10,000 commands per day. Each deduplication check consumes two commands (GET + SET). At 40 filings per feed × 4 feeds × 10 runs per hour × 16 active trading hours = a theoretical maximum of ~25,600 commands per day, already near the limit under worst-case assumptions. Adding burst detection queries to Redis would push the system over the free limit. Supabase handles burst counting instead at zero marginal cost.

**Never use the small spaCy model.** `en_core_web_sm` has weak named entity recognition for financial text — it frequently misidentifies company names, fails to recognize executive titles, and has poor location detection. The supply chain graph feature (Phase 3) depends on accurate NER across hundreds of thousands of filing sentences. `en_core_web_md` is a hard requirement, not a preference.

**No async in the scraper.** Synchronous requests with rate limiting are simpler to debug, produce clean sequential log output, and are entirely sufficient for a cron-based pipeline that processes at most a few dozen filings per run. Async would add complexity (connection pool management, error propagation, cancellation) with no throughput benefit at this scale.

**No raw HTML in the database.** An unprocessed 10-K HTML file is 2–5MB. Storing raw HTML for 10,000 filings would consume 20–50GB — far beyond the 500MB Supabase free tier. Only the cleaned, section-extracted plain text is stored. Each section is capped at 8,000 characters.

**No Vercel.** The Next.js static export has no API routes. Everything Vercel offers beyond static file serving — serverless functions, edge middleware, preview deployments — adds cost and complexity without benefit. Cloudflare Pages serves static files with no bandwidth cap and no timeout limits.

**No Next.js API routes.** The frontend is strictly read-only. It reads from Supabase via the anon key with RLS enforcement. All database writes happen exclusively through the scraper running in GitHub Actions with the service_role key. Adding API routes would create a write path from the browser, require authentication, and introduce an attack surface that does not currently exist.
