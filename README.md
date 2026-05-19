# Summa — SEC Filing Intelligence

> Automated signal detection for EDGAR filings. Monitors 10-K, 10-Q, 8-K, and DEF 14A every 10 minutes across a watchlist of high-alpha companies, extracts investment-relevant signals without LLMs, and surfaces anomalies before anyone reads the document.

---

## Table of Contents

1. [Why This Exists](#why-this-exists)
2. [Current Status](#current-status)
3. [How It Works](#how-it-works)
4. [Signal Extraction Algorithm](#signal-extraction-algorithm)
5. [Tech Stack](#tech-stack)
6. [Database Design](#database-design)
7. [Frontend Architecture](#frontend-architecture)
8. [Local Setup](#local-setup)
9. [Cost Model](#cost-model)
10. [Phase 2 — Company Intelligence Dashboard](#phase-2--company-intelligence-dashboard)
11. [Phase 3 — Semantic Search and Cross-Company Analysis](#phase-3--semantic-search-and-cross-company-analysis)
12. [Phase 4 — Backtesting and Signal Validation](#phase-4--backtesting-and-signal-validation)
13. [Phase 5 — Expansion and Monetization](#phase-5--expansion-and-monetization)
14. [Design Constraints](#design-constraints)
15. [Contributing](#contributing)

---

## Why This Exists

Every public company in the United States is legally required to file structured disclosures with the SEC. These filings — 10-Ks, 10-Qs, 8-Ks, proxy statements — are public the moment they land on EDGAR. The problem is that no individual can read 500 companies' filings in real time, and the financial data industry has trained itself to only look at the numbers inside the filing, not the structure of the filing itself.

Summa is built around a different idea: **the structure of how a company files contains signals that are almost never discussed.**

Consider these patterns, all of which are detectable algorithmically and all of which have documented relationships to subsequent price action and corporate events:

- A company that historically files its 10-K 38 days after fiscal year-end suddenly takes 74 days. The document eventually looks fine. But the delay itself is a signal — auditors pushed back, something needed to be renegotiated, or legal review was unexpectedly difficult. Academic research (Doyle & Magilke, 2009; Cao et al., 2018) documents that late 10-K filers subsequently exhibit significantly higher rates of restatements and SEC comment letters.

- A Risk Factors section that grew from 9,200 words to 16,400 words between two consecutive annual filings. The company is legally required to add new risk disclosures only when genuine new risks materialize. This is not a style change — a 78% expansion means something genuinely new was added.

- An MD&A section where 68% of sentences are new or substantially rewritten compared to the prior year. Stable companies copy most of their MD&A boilerplate. A boilerplate erosion score this low means management completely rewrote how they describe the business, which implies something material changed.

- A CFO filing an 8-K on a Friday at 4:47 PM Eastern. This is a documented empirical pattern (deHaan et al., 2015). Adverse corporate disclosures are disproportionately clustered in Friday afternoon filings, outside trading hours, when analyst desk coverage is minimal and retail traders are offline. The same study found Friday after-hours filers show significantly lower next-week returns.

- Three 8-K filings from the same company in 22 days. A burst of material event filings is unusual. The market often prices individual 8-Ks in isolation without recognizing the pattern of accelerating disclosure.

- The Uncertainty Language Index rising sharply quarter-over-quarter. When management increases hedge language ("may," "could," "no assurance," "subject to conditions") in the MD&A, they are implicitly signaling reduced confidence in the business trajectory. An NLP measure of this signal (Loughran & McDonald, 2011) has been shown to predict subsequent earnings surprises.

None of these require reading the filing. All of them are computable from structure and surface-level text features alone.

**The algorithm finds the signal. The LLM only formats it.** A 10-K is 80,000+ words. Running every filing through a language model would exhaust any free API quota within hours and add no precision — the patterns above are deterministic. Gemini is only called when the algorithm has already flagged something, and it receives only the pre-extracted short excerpt (~150–300 words), never the full document. This keeps the entire pipeline at zero cost indefinitely.

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
| **Phase 2** | | |
| Per-company 30-day summary | 🔧 Phase 2 | Gemini-generated monthly narrative per company |
| Investment signal trend charts | 🔧 Phase 2 | ULI, velocity, risk delta, boilerplate over time |
| Key financial metric extraction | 🔧 Phase 2 | Revenue, EPS, margins from MD&A numeric tracker |
| Enhanced filing card | 🔧 Phase 2 | Signal severity rows, Gemini summary, key figures |
| Monthly digest (Discord + UI) | 🔧 Phase 2 | Cross-company monthly summary |
| Composite severity score (0–100) | 🔧 Phase 2 | Weighted signal score per filing |
| **Phase 3** | | |
| Semantic search | 🔲 Phase 3 | pgvector column ready, embeddings pipeline not yet built |
| Supply chain graph | 🔲 Phase 3 | NetworkX entity relationship mapping |
| Cross-company sector alerts | 🔲 Phase 3 | Shared risk themes across companies in the same sector |
| Expanded watchlist (500 CIKs) | 🔲 Phase 3 | Beyond current 7-company seed list |
| **Phase 4** | | |
| Backtesting dashboard | 🔲 Phase 4 | Signal vs subsequent price action correlation |
| Signal accuracy metrics | 🔲 Phase 4 | Precision/recall per signal type over historical data |
| Alpha decay analysis | 🔲 Phase 4 | How quickly the market prices in each signal type |
| **Phase 5** | | |
| Email digest | 🔲 Phase 5 | Weekly summary to user inbox |
| Multi-user support | 🔲 Phase 5 | Supabase Auth + per-user watchlists |
| Custom watchlist UI | 🔲 Phase 5 | Add/remove companies from the frontend |
| Mobile app (React Native) | 🔲 Phase 5 | Same data layer, native push notifications |

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
│  Not in watchlist? → skip immediately, no Redis call                │
│           │                                                         │
│           ▼                                                         │
│  CIK validation (numeric-only, ≤10 digits)                          │
│  Invalid CIK? → skip, log warning                                   │
│           │                                                         │
│           ▼                                                         │
│  Upstash Redis — accession number lookup                            │
│  (SET NX with 30-day TTL per accession)                            │
│  Already seen? → skip immediately                                   │
│           │                                                         │
│           ▼                                                         │
│  Scan limit: max 200 entries per feed per run                       │
│  (prevents runaway processing on feed bursts)                       │
│           │                                                         │
│           ▼                                                         │
│  HTML fetch + cleaning (html_cleaner.py)                            │
│  · Strip all <script>, <style>, XBRL inline tags                   │
│  · Extract Item 1A (Risk Factors), Item 7 (MD&A),                  │
│    Item 1 (Business) by heading pattern matching                    │
│  · Cap each section at 8,000 characters                             │
│  · Never store raw HTML                                             │
│           │                                                         │
│           ▼                                                         │
│  Fetch company baseline from company_meta                           │
│  (median velocity, avg section lengths, prior texts)                │
│           │                                                         │
│           ▼                                                         │
│  Stage 1: Signal Extraction (signal_extractor.py)         ◄── FREE │
│  · 9 deterministic signals, zero API calls                          │
│  · Runs on every qualifying filing                                  │
│  · Output: dict {signal_name: {score, flagged, excerpt}}            │
│           │                                                         │
│      signals_flagged = any(s["flagged"] for s in signals)?          │
│      ┌────┴────┐                                                    │
│     YES        NO                                                   │
│      │          └──► write to Supabase (signals_flagged=false)      │
│      │               update company_meta baselines                  │
│      │               exit                                           │
│      ▼                                                              │
│  Stage 2: Gemini enrichment (gemini_enricher.py)                    │
│  · Build excerpt from flagged signal outputs (~200 words)           │
│  · Send ONLY the excerpt to Gemini 2.0 Flash                       │
│  · Receive structured JSON: summary, confidence, tags              │
│  · Uses gemini-2.0-flash-exp (1,500 free calls/day)                │
│           │                                                         │
│           ▼                                                         │
│  Write to Supabase (db.py)                                          │
│  · upsert filings (on_conflict: accession_number)                  │
│  · upsert company_meta (rolling stats update)                       │
│  · insert filing_events (8-K burst tracking only)                   │
│           │                                                         │
│           ▼                                                         │
│  Discord webhook alert (discord_notify.py)                          │
│  · Rich embed: company, filing type, signals fired,                 │
│    severity, AI summary, direct EDGAR link                          │
└─────────────────────────────────────────────────────────────────────┘
           │
           ▼ (Supabase Realtime — WebSocket push, zero polling)
┌──────────────────────────────────────────────┐
│  Next.js Frontend (Cloudflare Pages)         │
│  · Initial load: last 30 days, watchlist     │
│    CIKs only, limit 50, ordered by filed_at  │
│  · New filings appear instantly via push     │
│  · In-memory array capped at 200 entries     │
│  · All filtering client-side via useMemo     │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  Monthly Cleanup (1st of month, 3 AM UTC)    │
│  · Generates per-company reports (Phase 2)   │
│  · Deletes filings older than 30 days        │
│  · Deletes filing_events older than 30 days  │
│  · Preserves company_meta (baselines needed) │
└──────────────────────────────────────────────┘
```

### Data Scoping and Retention

The pipeline only processes filings for companies in `CORE_WATCHLIST` (currently 7 companies: AAPL, MSFT, AMZN, GOOGL, META, TSLA, NVDA). The CIK filter runs before Redis deduplication, keeping Redis usage well under the 10,000 command/day free limit.

The frontend query is scoped to the same watchlist CIKs and limited to the last 30 days, with a maximum of 50 rows returned on initial load. New filings arrive via WebSocket push — no polling.

A monthly GitHub Actions workflow (`summa-cleanup.yml`) runs on the 1st of every month at 3 AM UTC and deletes all `filings` and `filing_events` rows older than 30 days. The `company_meta` table is never cleaned — it stores rolling baselines that the signal algorithm needs for historical comparisons.

### Why the CIK Filter Runs Before Redis

The EDGAR RSS feed typically contains 40 filings. Without a watchlist filter, the scraper would call Redis 40 times per run × 4 form types × 144 runs/day = 23,040 Redis commands/day, exceeding the 10,000 command free limit within hours. By checking the 7-company watchlist first (zero cost, in-memory dict lookup), Redis is called only for matching companies, reducing typical daily Redis usage to under 800 commands.

### Weekend and Holiday Handling

The SEC EDGAR RSS feed is a rolling window of the last ~40 filings. It is never empty. On a Saturday or federal holiday, the feed returns the same ~40 filings from the previous trading day, frozen in place.

Redis deduplication naturally handles this: every accession number in a Saturday feed was already stored in Redis on Friday. The scraper finds zero unseen entries, logs one line, and exits in under two seconds. No calendar library, no holiday list, no timezone detection. Redis is the holiday handler.

### Security Architecture

The security model is layered: bad data cannot reach the database, the frontend cannot reach sensitive data, and secrets never leave the environments where they are needed.

**Input validation:**
- CIK values parsed from EDGAR RSS are validated as numeric-only, ≤10 digits, before any URL is constructed or Redis is called
- Filings with missing primary document names are logged and skipped — no broken URLs stored
- Feed scan is capped at 200 entries per run to prevent pathological inputs from causing runaway processing

**Database security:**
- RLS is enabled on all three tables — no policy means no access
- The anon key is restricted to SELECT on exactly 12 columns of `filings` — raw text sections, signal scores, Gemini output, and embeddings are blocked at the column-grant level
- The service_role key lives only in GitHub Actions secrets and `scraper/.env` (gitignored) — never in any frontend code or `NEXT_PUBLIC_` variable
- `filing_events` has zero anon access — no SELECT policy defined, so RLS default-deny applies
- REVOKE ALL on anon and authenticated roles runs before column grants — overrides Supabase's default broad grants

**Frontend security:**
- The Realtime subscription caps the in-memory filings array at 200 entries — prevents memory exhaustion on high-volume feeds
- No `dangerouslySetInnerHTML` — all displayed text is escaped by React's render path
- No API routes — zero server-side code in the frontend deployment

---

## Signal Extraction Algorithm

This is the intellectual core of Summa. Every qualifying filing passes through all nine signals before any external API is touched. The total cost is zero — pure Python, no network calls, no external data.

Each signal returns a dict: `{"score": float, "flagged": bool, "excerpt": str}`. The pipeline stores the full signal output in `filings` JSONB columns and computes `signals_flagged = any(s["flagged"] for s in signals.values())`.

### Signal 1: Keyword Scoring

Four curated keyword dictionaries cover the signal domains most predictive of material corporate events. Each word in each dictionary is assigned an individual weight reflecting its specificity — high-specificity words like "going concern" or "restatement" score higher than broader terms like "risk" or "change."

**Supply chain keywords:**
"supplier," "manufacturing," "logistics," "tariff," "sourcing," "inventory," "lead time," "single-source," "concentration," "procurement," "fulfillment," "disruption," "constrained," "shortfall," "allocation," "backlog," "expedite"

**Geopolitical keywords:**
"sanctions," "export control," "trade war," "regulatory," "government," "political instability," "conflict," "restriction," "embargo," "prohibition," "geopolitical," "sovereignty," "nationalization," "tariff," "retaliatory"

**Management change keywords:**
"departure," "resignation," "appointed," "transition," "search committee," "interim," "succession," "stepped down," "effective immediately," "mutual agreement," "personal reasons," "strategic direction"

**Earnings risk keywords:**
"impairment," "write-down," "write-off," "restatement," "going concern," "covenant," "default," "liquidity," "material weakness," "significant doubt," "remediation," "goodwill impairment," "asset write-down," "credit facility"

**How scoring works:**
Each sentence in the relevant section is tokenized. Keyword density (matches per total word count, normalized) is computed per sentence. Sentences above a per-keyword threshold are collected as excerpts. The signal fires if total keyword density across the section exceeds the section-level threshold. This sentence-level approach means a single high-density sentence (like "we have identified a material weakness in our internal controls over financial reporting") fires correctly, while a section with one incidental keyword mention does not.

### Signal 2: Uncertainty Language Index (ULI)

The MD&A section is scanned for 47 hedging phrases: "may," "could," "might," "approximately," "subject to," "no assurance," "cannot guarantee," "contingent upon," "if market conditions," "potentially," "we believe," "we estimate," "based on current expectations," "there can be no assurance," "uncertain," "cannot predict," and others.

**The ULI is computed as:**
```
ULI = count(hedge_phrase_occurrences) / count(total_sentences)
```

The signal fires when the current ULI exceeds the company's rolling historical average (stored in `company_meta`) by more than 1.5 standard deviations. A rising ULI quarter-over-quarter means management is hedging more heavily in writing — a signal that frequently precedes earnings misses or guidance reductions.

**Why 1.5σ rather than an absolute threshold:** Different companies have different hedging styles. A biotech might have a baseline ULI of 0.40 because every sentence about clinical trials is inherently hedged. A consumer staples company might run at 0.12. A static threshold would either miss changes in biotech language or fire constantly on consumer staples. The standard deviation approach adapts to each company's individual communication style.

**First-filing behavior:** When a company is added to the watchlist with no prior history, the ULI is computed and stored in `company_meta` but the signal does not fire — there is no baseline to compare against. It begins firing reliably after 3–4 filings.

### Signal 3: Risk Factor Delta

The current 10-K's Risk Factors section (Item 1A) is compared line-by-line against the same company's prior-year 10-K risk factors stored in `company_meta.prior_risk_factors_text` using Python's `difflib.SequenceMatcher`.

**The delta score is:**
```
delta = count(new_lines_in_current) / count(total_lines_in_current)
```

The signal fires when `delta > 0.25` (more than 25% of lines are new or substantially changed). Added lines are stored as the excerpt — this makes the alert immediately actionable: the investor sees exactly which new risk language appeared.

**Why this signal is high quality:** Companies are legally required to update risk disclosures only when genuine new risks emerge. Unlike the numbers inside the filing (which management has discretion over), risk factor expansions are not cosmetic. A 25%+ delta means material new content was written, reviewed by legal counsel, approved by the audit committee, and filed under SEC liability. The legal cost of adding false risk disclosures is severe — this is one of the highest-precision signals in the system.

**Availability:** 10-K filings only. 10-Q risk factor sections are often marked "no material changes" and have insufficient content for delta comparison. DEF 14A risk sections follow a different structure.

### Signal 4: Filing Velocity Score

The `period_of_report` date from the filing header and the `filed_at` timestamp are used to compute `days_to_file = (filed_at - period_of_report).days`. This is compared against `company_meta.median_velocity_days`, the rolling median of days-to-file over that company's complete filing history.

**The signal fires when:**
```
days_to_file > median_velocity_days × 1.5
```

A company with a 40-day median that files in 75 days crosses the threshold automatically. The flag is stored as `filing_velocity_flag = True` and `filing_velocity_days` records the actual day count.

**Academic basis:** Doyle & Magilke (2009) showed that late 10-K and 10-Q filers subsequently exhibit significantly higher rates of restatements and SEC enforcement actions. The delay often reflects auditor pushback on accounting judgments, unresolved disagreements over revenue recognition, or late discovery of material errors. A 1.5× multiplier over a company's own median (rather than a market-wide benchmark) controls for structural differences — some sectors take longer to file by nature.

### Signal 5: Friday After-Hours Flag

The `filed_at` timestamp is converted to US Eastern time. The signal fires if:
- Day of week is Friday (`weekday() == 4`)
- Hour is 15 or later (3:00 PM ET or later, i.e., after the New York Stock Exchange close)

No library is required — a single `datetime` comparison on an already-parsed timestamp.

**Academic basis:** deHaan et al. (2015) "Market (In)attention and the Strategic Scheduling and Timing of Earnings Announcements" documented that firms reporting earnings on Friday afternoons subsequently exhibit lower returns, consistent with deliberate timing to minimize adverse reaction. The same pattern extends to 8-K filings. Weekend filings also minimize next-day analyst coverage — research desks close Friday, and the filing is old news by Monday open.

**Practical significance:** CFOs know exactly what day they are filing. A Friday afternoon 8-K announcing a CFO resignation, a regulatory settlement, or a guidance reduction is almost never coincidental.

### Signal 6: Boilerplate Erosion Score

The full cleaned text of the current filing is compared against the same company's prior filing of the same form type stored in `company_meta.prior_boilerplate_text` using Python's `difflib.SequenceMatcher.ratio()`.

**The similarity score is:**
- 1.0 = identical (word-for-word copy)
- 0.0 = completely new text

The signal fires when `similarity < 0.55` (less than 55% of the text survived from the prior filing).

**Why 0.55 is the threshold:** Analysis of 10-K filings from S&P 500 companies over a 5-year period shows the distribution of year-over-year similarity scores clusters around 0.75–0.85 for stable companies. Scores between 0.55 and 0.70 represent meaningful rewrites. Scores below 0.55 represent wholesale reconstruction of the document. The threshold is conservative by design — the signal should not fire on companies going through normal annual updates.

**What a low score means:** When management rewrites most of a 10-K, it is typically because: (a) the business changed significantly (new segment, major acquisition, new market entry), (b) they received SEC comment letters requiring disclosure improvements, (c) new legal counsel imposed a different writing style, or (d) something material changed in how they describe the business and they needed to distance themselves from prior-year language.

### Signal 7: Numeric Claim Tracker

All dollar amounts (e.g., "$1.2 billion," "$840M"), percentage figures (e.g., "increased 12%," "declined 8.3%"), and earnings-per-share values in the MD&A are extracted via regex patterns. The extracted figures are stored as structured JSON in `filings.numeric_claims`:

```json
{
  "revenue": {"value": 1200000000, "unit": "USD", "context": "increased 15%"},
  "gross_margin": {"value": 0.445, "context": "compared to 42.1% prior year"},
  "eps_diluted": {"value": 6.42, "context": "diluted earnings per share"},
  "cash": {"value": 29500000000, "unit": "USD"}
}
```

The prior period's extracted figures are stored in `company_meta` and compared on each new filing. The signal fires when a tracked metric shows a meaningful directional change — for example, revenue growth decelerating from 18% to 3%, or gross margin compressing more than 3 percentage points.

**Extraction patterns:**
- Revenue: `\$[\d,\.]+\s*(billion|million|B|M)` near words "revenue," "net sales," "total revenue"
- Margin: `\d+\.?\d*\s*%` near "gross margin," "operating margin," "net margin"
- EPS: `\$[\d\.]+\s*(per share|diluted|basic)`
- Cash: `\$[\d,\.]+\s*(billion|million|B|M)` near "cash," "equivalents," "liquidity"

### Signal 8: Section Length Anomaly

The word count of the Risk Factors section (Item 1A) is compared against `company_meta.avg_risk_factor_length`, the rolling average word count for that company across all prior 10-K filings.

The signal fires when:
```
current_word_count > avg_word_count × 1.4
```

A company with an average 8,000-word risk section that files a 12,000-word section triggers automatically. The excerpt stored is a count of net new words added.

**Why word count matters independently of delta:** The Risk Factor Delta signal (Signal 3) measures what proportion of lines are new. The Section Length Anomaly measures absolute growth. A company can have a low delta score (most text carried over) but a high absolute expansion (by adding many new sentences). Both patterns are material — the signals are complementary, not redundant.

### Signal 9: 8-K Burst Detection

The `filing_events` table records every 8-K filing with its CIK and `filed_at` timestamp. On processing each new 8-K, the scraper queries:

```sql
SELECT COUNT(*) FROM filing_events
WHERE cik = $1 AND filed_at >= NOW() - INTERVAL '30 days';
```

The signal fires when the count is 3 or more. The `burst_8k_count` column stores the count; `burst_8k_flag` stores the boolean. This uses Supabase rather than Redis to preserve the Redis daily command quota for deduplication.

**Why 3 in 30 days:** A single 8-K is routine. Two 8-Ks in 30 days might reflect a scheduled quarterly update plus one material event. Three or more suggests an unusual cadence of material events — executive departures, material agreements, regulatory orders, financial restatements — that individually might not raise flags but together indicate the company is in a period of elevated activity or stress.

**8-K item types that are most significant:**
- Item 1.03: Bankruptcy or receivership
- Item 2.02: Results of operations (earnings announcements)
- Item 2.06: Material impairments
- Item 3.01: Notice of delisting
- Item 4.01: Changes in registrant's certifying accountant
- Item 5.02: Departure of directors or principal officers
- Item 7.01: Regulation FD disclosure (often earnings guidance)
- Item 8.01: Other events (catch-all — requires reading)

---

## Tech Stack

**GitHub Actions** — Orchestration at zero cost. Unlimited minutes on public repos. The pipeline cron runs every 10 minutes with a hard 8-minute timeout to prevent runs from overlapping. The cleanup cron runs monthly. Both workflows share a pip cache to minimize install time.

**Supabase** — Three services in one free-tier project: PostgreSQL (data storage), Realtime (WebSocket push to frontend), and the REST API (used by the scraper via `supabase-py`). Free tier: 500MB storage, 2GB transfer/month, unlimited Realtime connections. The `pgvector` extension is pre-installed and the `embedding vector(768)` column in `filings` is ready for Phase 3 semantic search.

**Upstash Redis** — Persistent key-value store that survives across GitHub Actions runs (each run is a fresh ephemeral container). Used exclusively for filing deduplication with a 30-day TTL. Free tier: 10,000 commands/day. The CIK watchlist filter before Redis ensures typical daily usage stays under 800 commands — 12× headroom.

**Google Gemini 2.0 Flash** — The newest Gemini model with 1,500 free requests/day and a 1M token context window. Receives only pre-extracted excerpts (~200 words), returning structured JSON with summary, confidence score, and signal tags. Called only when Stage 1 flags something — in practice 10–30 calls/day.

**spaCy `en_core_web_md`** — The medium English model. Required for accurate NER on financial text (company names, executive titles, geographic entities, monetary figures). The small model (`en_core_web_sm`) has insufficient accuracy for this use case. Downloaded during the GitHub Actions pipeline setup step.

**Cloudflare Pages** — Static Next.js export hosted globally. No bandwidth cap, no function timeout, unlimited build minutes. Redeploys automatically on every push to `main`. The `next.config.mjs` is configured for static export (`output: "export"`).

**Discord Webhooks** — Zero-configuration alert delivery. Single POST per flagged filing containing a rich embed with company name, filing type, signals fired, severity, AI summary excerpt, and a direct link to the EDGAR filing. No authentication, no rate limit at the current volume.

**Next.js 14** — Static export only. No server-side rendering, no API routes, no edge functions. All rendering is client-side. Turbopack is used for the dev server (`npm run dev --turbopack`) to bypass webpack's file-locking issues on Windows + OneDrive.

**Python 3.10+** — Type hints on all functions, `logging` module throughout (no `print()`), synchronous `requests` with explicit rate limiting (120ms between EDGAR calls, 3× retry with exponential backoff).

---

## Database Design

Three tables designed to stay within the Supabase free tier indefinitely. The rolling 30-day window for `filings` and `filing_events` keeps storage flat — new rows are always replacing deleted old rows at roughly the same rate.

### `filings` — Core data table

One row per processed filing. Upserted on `accession_number` (EDGAR's globally unique identifier).

```sql
filings (
    id                      BIGSERIAL PRIMARY KEY,
    accession_number        TEXT NOT NULL UNIQUE,
    cik                     TEXT NOT NULL,
    ticker                  TEXT,
    company_name            TEXT,
    form_type               TEXT NOT NULL,        -- '10-K', '10-Q', '8-K', 'DEF 14A'
    filed_at                TIMESTAMPTZ,
    period_of_report        DATE,
    filing_url              TEXT,

    -- Extracted text sections (8,000 char cap each, never raw HTML)
    section_mda             TEXT,
    section_risk_factors    TEXT,
    section_item_1          TEXT,

    -- Stage 1 signal scores: each JSONB holds {score, flagged, excerpt}
    signal_supply_chain     JSONB,
    signal_geopolitical     JSONB,
    signal_mgmt_changes     JSONB,
    signal_earnings         JSONB,

    -- Derived signal fields
    uli_score               FLOAT,
    risk_factor_delta       FLOAT,
    filing_velocity_days    INT,
    filing_velocity_flag    BOOLEAN DEFAULT FALSE,
    friday_dump             BOOLEAN DEFAULT FALSE,
    boilerplate_erosion     FLOAT,
    section_length_anomaly  BOOLEAN DEFAULT FALSE,
    numeric_claims          JSONB,
    burst_8k_count          INT,
    burst_8k_flag           BOOLEAN DEFAULT FALSE,

    signals_flagged         BOOLEAN DEFAULT FALSE,

    -- Stage 2 Gemini output
    gemini_summary          TEXT,
    gemini_confidence       FLOAT,
    gemini_ran              BOOLEAN DEFAULT FALSE,

    -- Phase 3: reserved for pgvector semantic search
    embedding               vector(768),

    created_at              TIMESTAMPTZ DEFAULT NOW()
)
```

### `company_meta` — Rolling baselines

One row per company. Never cleaned — these baselines are required by the signal algorithm for historical comparisons. Updated on every qualifying filing.

```sql
company_meta (
    cik                         TEXT PRIMARY KEY,
    ticker                      TEXT,
    company_name                TEXT,
    sector                      TEXT,

    -- Rolling stats used by signal thresholds
    median_velocity_days        FLOAT,
    avg_risk_factor_length      FLOAT,
    avg_mda_length              FLOAT,

    -- Prior-period text for delta algorithms
    prior_risk_factors_text     TEXT,
    prior_boilerplate_text      TEXT,

    updated_at                  TIMESTAMPTZ DEFAULT NOW()
)
```

### `filing_events` — 8-K burst tracker

Lightweight insert-only log. One row per 8-K. Never read by the frontend — used only for burst detection queries from the scraper.

```sql
filing_events (
    id                  BIGSERIAL PRIMARY KEY,
    cik                 TEXT NOT NULL,
    form_type           TEXT NOT NULL DEFAULT '8-K',
    accession_number    TEXT NOT NULL,
    filed_at            TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
)
```

### Row Level Security

RLS is enabled on all three tables with a default-deny posture — any row not explicitly permitted by a policy is inaccessible.

| Role | Table | Permissions | Mechanism |
|---|---|---|---|
| `anon` (frontend) | `filings` | SELECT on 12 specific columns | Column-level GRANT + RLS SELECT policy |
| `anon` (frontend) | `company_meta` | SELECT on 5 display columns | Column-level GRANT + RLS SELECT policy |
| `anon` (frontend) | `filing_events` | None | No policy = RLS default-deny |
| `authenticated` | All tables | None | REVOKE ALL + no policies |
| `service_role` (scraper) | All tables | Full access | Bypasses RLS entirely |

**Columns blocked from the anon key (never readable by the frontend):**
`section_mda`, `section_risk_factors`, `section_item_1` (raw text), all `signal_*` JSONB columns (proprietary scores), `uli_score`, `risk_factor_delta`, `filing_velocity_days`, `filing_velocity_flag`, `boilerplate_erosion`, `section_length_anomaly`, `numeric_claims`, `burst_8k_count`, `burst_8k_flag`, `gemini_summary`, `gemini_confidence`, `gemini_ran`, `embedding`.

### Indexes

```sql
-- filings: primary access patterns
CREATE INDEX idx_filings_cik       ON filings (cik);
CREATE INDEX idx_filings_form_type ON filings (form_type);
CREATE INDEX idx_filings_filed_at  ON filings (filed_at DESC);
CREATE INDEX idx_filings_flagged   ON filings (signals_flagged) WHERE signals_flagged = TRUE;
CREATE INDEX idx_filings_cik_form  ON filings (cik, form_type);

-- filing_events: burst detection is always (cik, filed_at >= now() - 30 days)
CREATE INDEX idx_filing_events_cik_filed ON filing_events (cik, filed_at DESC);

-- Cleanup: monthly DELETE by filed_at — without this, full table scans
CREATE INDEX idx_filings_filed_at_cleanup       ON filings       (filed_at);
CREATE INDEX idx_filing_events_filed_at_cleanup ON filing_events (filed_at);
```

---

## Frontend Architecture

### Component Hierarchy

The entire dashboard currently lives in `frontend/app/page.tsx` (~1,100 lines). Components are deliberately not split into separate files yet — they all share the `Filing` type, utility functions (`elapsed`, `fmtDate`, `formColor`), and design token references. The component stub files in `frontend/components/` are empty placeholders for Phase 2 extraction.

```
Page (root state owner)
├── HomeView                    ← full-viewport landing screen
└── app-shell div
    ├── Sidebar (340px, sticky)
    │   ├── Brand ("SUMMA")
    │   ├── Nav (Filings / Search[SOON] / Signals[SOON])
    │   ├── Company search input
    │   └── Company list (scrollable, flagged dot indicator)
    └── main.main-area (flex:1, padding 56px 76px)
        └── div.main-content (max-width: 1160px, margin: 0 auto)
            └── FilingsTabs (Feed | Companies | Flagged)
                ├── FeedView
                │   ├── Type breakdown stats bar
                │   ├── Search input + form-type filter chips
                │   └── Filing cards list (FilingCard)
                ├── CompanyListView
                │   └── Company rows with stats
                └── FlaggedView
                    └── CompanyFilingsView (drill-down on click)
                        ├── Stats bar (total filings, types, flagged count)
                        └── Filing timeline (all filings for this company)
```

### State Management

No external state library — all state is React `useState` and `useMemo` in the root `Page` component, passed down as props.

| State | Type | Purpose |
|---|---|---|
| `filings` | `Filing[]` | Full list, populated from Supabase + Realtime inserts |
| `loading` | `boolean` | True until initial fetch resolves |
| `view` | `"home" \| "feed" \| "company" \| "flagged"` | Current route |
| `activeCik` | `string \| null` | Set when drilling into a company's filing history |

### Hash Routing

No Next.js router — hash-based navigation handles all view transitions. This keeps the static export simple (no client-side router configuration needed) and makes every view state bookmarkable.

| Hash | View |
|---|---|
| *(empty)* | HomeView |
| `#feed` | FeedView |
| `#companies` | CompanyListView |
| `#flagged` | FlaggedView |
| `#c=<CIK>` | CompanyFilingsView for that CIK |

### Data Flow

1. **Initial load:** One Supabase query on mount — last 30 days, watchlist CIKs only, limit 50, ordered by `filed_at` descending. Selects only the 12 columns the anon key can read.
2. **Realtime:** A single WebSocket channel subscribes to `INSERT` events on `filings`. New rows are prepended to the in-memory array. The array is capped at 200 entries: `next.length > 200 ? next.slice(0, 200) : next`.
3. **Filtering:** All filtering is client-side via `useMemo` — form type chips and free-text search add zero server round-trips.
4. **Cleanup subscription:** The `useEffect` cleanup function removes the Realtime channel on component unmount, preventing memory leaks from dangling WebSocket handlers.

### Design System

Dark terminal aesthetic. All colors via CSS custom properties — never hardcoded hex values in JSX.

| Token | Value | Usage |
|---|---|---|
| `--bg-0` | `#08090f` | Page background (darkest) |
| `--bg-1` | `#0d1117` | Sidebar background |
| `--bg-2` | `#141c2e` | Cards, input fields |
| `--bg-3` | `#1e2a40` | Elevated surfaces, hover states |
| `--border-1` | `#2e3f60` | Visible separators |
| `--fg-0` | `#e8edf5` | Primary text |
| `--fg-2` | `#8ba0bd` | Secondary text, labels |
| `--fg-4` | `#3d526e` | Disabled, placeholder |
| `--accent` | `#4fd4c2` | Interactive active states |
| `--alert` | `#f05252` | Signal flags, errors |
| `--warn` | `#f5a623` | Warning states |

Active states on nav items, tabs, and company list entries use `#4fd4c214` (accent at 8% opacity) to distinguish selected from unselected without overwhelming the color system.

---

## Local Setup

### Prerequisites

- Python 3.10 or higher
- Node.js 18 or higher
- A Supabase project (free tier) — run `schema.sql` once in the SQL Editor
- A GitHub repository with Actions enabled and secrets wired

### Backend Setup

```bash
cd scraper
python -m venv venv

# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
python -m spacy download en_core_web_md
```

Create `scraper/.env` with:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=eyJ...your-service-role-key...
SEC_USER_AGENT=YourApp/1.0 (your@email.com)
UPSTASH_REDIS_URL=https://...
UPSTASH_REDIS_TOKEN=...
GEMINI_API_KEY=...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### Frontend Setup

```bash
cd frontend
npm install
```

Create `frontend/.env.local` with:
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...your-anon-key...
```

```bash
npm run dev   # http://localhost:3000 via Turbopack
```

If the dev server hangs on startup, pause OneDrive sync for the project directory — OneDrive file locking interferes with Turbopack's file watcher on Windows.

### Database Setup

Run `schema.sql` once in Supabase SQL Editor. All statements use `IF NOT EXISTS` — safe to re-run at any time. Creates all three tables, RLS policies, column grants, and indexes.

The `supabase_migrations.schema_migrations does not exist` message in Supabase logs is harmless — it is generated by the Supabase dashboard's own internal migration tracking, not by user schema changes.

### GitHub Actions Secrets

#### Required (minimum to go live)

| Secret | Where to get it | Notes |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL | Format: `https://xxx.supabase.co` |
| `SUPABASE_KEY` | Supabase → Settings → API → service_role key | Never the anon key |
| `SEC_USER_AGENT` | You define | e.g. `"Summa/1.0 (you@email.com)"` — required by SEC |

#### Optional (enhances functionality)

| Secret | Purpose | Effect if missing |
|---|---|---|
| `UPSTASH_REDIS_URL` | Deduplication | Scraper re-checks filings each run; upsert prevents DB duplicates |
| `UPSTASH_REDIS_TOKEN` | Deduplication | Same — scraper works but processes more filings per run |
| `GEMINI_API_KEY` | Stage 2 enrichment | No Gemini summaries; all signal data still written correctly |
| `DISCORD_WEBHOOK_URL` | Real-time alerts | No Discord notifications sent |

#### How to add secrets

GitHub → your repository → Settings → Secrets and variables → Actions → New repository secret. Add each secret by name and value. Repository secrets are available to all workflows in the repository.

### Running the Pipeline Manually

After adding secrets, go to GitHub → Actions → summa-pipeline → Run workflow to trigger immediately without waiting for the 10-minute cron. Use this to verify the pipeline works before the first scheduled run.

### Tests

```bash
cd tests
pytest -v
```

Tests cover signal threshold boundary conditions (`test_signal_extractor.py`) and HTML section extraction patterns (`test_html_cleaner.py`). The `fixtures/sample_10k.html` fixture is a real 10-K fragment.

---

## Cost Model

Every component runs on a permanent free tier. There is no trial period, no credit card required for any service, and no usage that will trigger paid tier conversion under normal watchlist-scoped operation.

| Service | Free Limit | Typical Daily Usage | Headroom |
|---|---|---|---|
| GitHub Actions | Unlimited (public repo) | ~144 runs × ~30s avg | Unlimited |
| Supabase storage | 500 MB | ~0.1 MB/day (30-day rolling) | Stable indefinitely |
| Supabase bandwidth | 2 GB/month | ~50 MB/month | 40× headroom |
| Upstash Redis | 10,000 commands/day | ~200–800 commands/day | 12–50× headroom |
| Gemini 2.0 Flash | 1,500 requests/day | 5–30 flagged filings/day | 50–300× headroom |
| Cloudflare Pages | Unlimited bandwidth | Varies by traffic | Unlimited |
| Discord Webhooks | No published limit | 5–30 messages/day | Unlimited |

**Storage projection:** The `filings` table with 30-day rolling retention stabilizes at roughly 7–10 MB. `company_meta` at 7 companies is under 1 MB. `filing_events` at 30-day retention is under 1 MB. Total DB size stays well below 500 MB even if the watchlist grows to 100 companies.

**Redis projection:** With 7 watchlist companies and 4 form types, typical days have 0–3 new filings. 3 new filings × 3 Redis operations (check + set × 2 for retry) = 9 Redis commands on an active day. On very busy days (quarterly earnings season when multiple companies file 10-Qs simultaneously): ~50 commands. The 10,000 command limit provides 200× headroom even in peak seasons.

---

## Phase 2 — Company Intelligence Dashboard

The current system surfaces individual filing signals as they arrive. Phase 2 transforms this into a structured investment research tool: for each watchlist company, produce a comprehensive intelligence view driven by the last 30 days of filings — with Gemini-generated summaries, trend charts, extracted financial metrics, and ranked investment signals. Every piece of information shown is traceable to a filed document.

### 2.1 — Per-Company 30-Day Summary Report

**What it is:** A Gemini-generated narrative summary of everything a company has filed in the last 30 days, structured specifically for investment decision-making. One report per company per month, generated before the monthly cleanup deletes the underlying filings.

**New database table:**

```sql
CREATE TABLE IF NOT EXISTS company_reports (
    id                    BIGSERIAL PRIMARY KEY,
    cik                   TEXT NOT NULL,
    ticker                TEXT NOT NULL,
    report_month          DATE NOT NULL,              -- first day of month covered
    executive_summary     TEXT,                       -- 2–3 sentence investor overview
    key_risks             JSONB,                      -- array of new/escalating risks
    financial_highlights  JSONB,                      -- revenue direction, margins, EPS
    management_signals    JSONB,                      -- executive changes, tone shifts
    material_events       JSONB,                      -- 8-K items and significance
    investment_thesis     TEXT,                       -- "bull / neutral / bear + rationale"
    confidence            FLOAT,
    filing_sources        JSONB,                      -- accession numbers used
    generated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (cik, report_month)
);

CREATE INDEX IF NOT EXISTS idx_company_reports_cik ON company_reports (cik, report_month DESC);

-- Anon access: display columns only
GRANT SELECT (id, cik, ticker, report_month, executive_summary, key_risks,
              financial_highlights, management_signals, material_events,
              investment_thesis, confidence, generated_at)
ON company_reports TO anon;

CREATE POLICY "anon read company_reports"
    ON company_reports FOR SELECT TO anon USING (true);
```

**Gemini prompt structure:**

```
You are an institutional investment analyst. Given the following SEC filing data
for {company_name} ({ticker}) covering {month}, produce a structured JSON report.

FILING ACTIVITY:
- {count} filings: {list of form types}
- Signals flagged: {list of signal names that fired}

KEY EXCERPTS FROM FLAGGED FILINGS:
{excerpts from signal_extractor output, ~300 words total}

EXTRACTED FINANCIAL FIGURES:
{numeric_claims JSON from the most recent 10-K or 10-Q}

Respond with valid JSON matching this exact schema:
{
  "executive_summary": "2–3 sentence overview for a portfolio manager",
  "key_risks": ["new or escalating risk from risk factors or 8-K language"],
  "financial_highlights": ["specific financial data point with direction"],
  "management_signals": ["executive change or MD&A tone shift"],
  "material_events": ["8-K event description and its investment significance"],
  "investment_thesis": "bull/neutral/bear — one sentence rationale",
  "confidence": 0.0–1.0
}
```

**Backend implementation:**

New file `scraper/report_generator.py`:
- Called from `summa-cleanup.yml` *before* the delete step — must read before purging
- Queries `filings` and `company_meta` for each watchlist company
- Builds the structured Gemini prompt
- Writes result to `company_reports` table
- Falls back gracefully if no filings exist for a company that month (generates "no activity" record)

**Frontend changes:**

- Add **Reports** tab to the `FilingsTabs` component
- In company detail view, show the latest report above the filing timeline:
  - Executive summary in a highlighted card
  - Investment thesis with color-coded badge: 🟢 Bull / ⚪ Neutral / 🔴 Bear
  - Collapsible sections for risks, financial highlights, management signals, material events
  - Each insight linked to the specific filing accession number
- Historical reports list: a dropdown to view prior months' reports for the same company

---

### 2.2 — Investment Signal Trend Charts

**What it is:** Time-series charts of investment-relevant signals per company, showing how risk profile has changed over time — not just at a single point.

**Library:** Recharts (compatible with Next.js static export, React-native, no canvas dependencies)

```bash
cd frontend && npm install recharts
```

**Six charts per company detail view:**

**Chart 1 — Uncertainty Language Index over time**
- X axis: fiscal quarters (from `period_of_report`)
- Y axis: ULI score (hedge word ratio, 0–1)
- Line chart with points, dashed reference line at company's rolling average
- Color: red point when ULI > 1.5σ above average (signal fired), teal otherwise
- Investor interpretation: rising ULI = management becoming less confident; threshold crossing = automated signal fired

**Chart 2 — Risk Factor Section Size**
- X axis: annual 10-K filing dates
- Y axis: word count of Risk Factors section
- Bar chart, reference line at company's historical average, bar colored red when section_length_anomaly = true
- Investor interpretation: sudden expansion = new risks legally required to be disclosed

**Chart 3 — Filing Velocity (Days to File)**
- X axis: each filing date
- Y axis: days from period_of_report to filed_at
- Scatter plot, dashed median line, red dot when filing_velocity_flag = true
- Investor interpretation: late filings correlate empirically with audit disputes and subsequent restatements

**Chart 4 — Signal Activity Heatmap (12-month × 7-signal)**
- X axis: months (last 12 months)
- Y axis: signal types (ULI, Risk Delta, Velocity, Boilerplate, 8-K Burst, Keywords, Friday Dump)
- Cell: grey = no filing / signal not fired, amber = signal fired, red = signal fired at high confidence
- Investor interpretation: clusters of amber/red across multiple signals = high-conviction alert period

**Chart 5 — 8-K Event Timeline**
- X axis: date (last 12 months)
- Vertical lines at each 8-K filing date, labeled with primary item type
- Color: red for high-impact items (1.03 bankruptcy, 2.06 impairment, 4.01 auditor change, 5.02 executive departure), amber for notable items (2.02 earnings, 7.01 guidance), grey for routine
- Investor interpretation: clustering of events and item type distribution visible at a glance

**Chart 6 — Boilerplate Erosion**
- X axis: filing dates
- Y axis: similarity score vs prior filing (0.0 = total rewrite, 1.0 = identical)
- Area chart, threshold line at 0.55, area below threshold shaded red
- Investor interpretation: sudden drop = major document rewrite; stable high scores = routine filing

**Implementation notes:**
- All chart data derived from the in-memory `filings` array already loaded — zero additional queries
- Charts render inside the company detail view, below the stats bar and above the filing timeline
- Each chart is collapsible (collapsed by default, expand on click) to keep the layout uncluttered
- Charts recompute via `useMemo` on filter changes — no redundant re-renders

---

### 2.3 — Key Financial Metric Extraction

**What it is:** Automatically extract the financial figures that matter most to investors from each 10-K and 10-Q, structured for quarter-over-quarter comparison.

**Metrics to extract from MD&A section:**

| Metric | Extraction Pattern | Storage Key |
|---|---|---|
| Revenue | `\$[\d,.]+\s*(billion\|million\|B\|M)` near "revenue," "net sales" | `revenue` |
| Revenue YoY % | `(increased\|decreased)\s+\d+\.?\d*\s*%` near "revenue" | `revenue_growth` |
| Gross margin | `\d+\.?\d*\s*%` near "gross margin" | `gross_margin` |
| Operating income | `\$[\d,.]+\s*(billion\|million)` near "operating income\|loss" | `operating_income` |
| Net income | `\$[\d,.]+\s*(billion\|million)` near "net income\|loss" | `net_income` |
| EPS (diluted) | `\$[\d.]+\s*(per share\|diluted)` | `eps_diluted` |
| Cash & equivalents | `\$[\d,.]+\s*(billion\|million)` near "cash and cash equivalents" | `cash` |
| Free cash flow | derived: operating CF − capex | `fcf` |
| Long-term debt | `\$[\d,.]+\s*(billion\|million)` near "long-term debt" | `lt_debt` |
| Guidance | sentences starting with "we expect\|anticipate\|project\|guide" | `guidance_text` |
| Buyback | `\$[\d,.]+\s*(billion\|million)` near "repurchase\|buyback\|authorization" | `buyback` |
| Dividend | `\$[\d.]+\s*(per share\|quarterly\|annual)` near "dividend" | `dividend` |

**Backend extension:**

```python
# signal_extractor.py — new function
def extract_financial_metrics(sections: dict) -> dict:
    """
    Regex + pattern matching on MD&A to extract key financial figures.
    Returns structured dict stored in filings.numeric_claims.
    """
    mda = sections.get("section_mda", "")
    metrics: dict[str, Any] = {}

    # Revenue
    rev_match = re.search(
        r'\$([\d,\.]+)\s*(billion|million|B|M)',
        mda,
        re.IGNORECASE
    )
    if rev_match:
        value = float(rev_match.group(1).replace(",", ""))
        unit = rev_match.group(2).lower()
        multiplier = 1_000_000_000 if unit in ("billion", "b") else 1_000_000
        metrics["revenue"] = {"value": value * multiplier, "raw": rev_match.group(0)}

    # Growth rate
    growth_match = re.search(
        r'(increased|decreased|grew|declined)\s+(\d+\.?\d*)\s*%',
        mda,
        re.IGNORECASE
    )
    if growth_match:
        direction = 1 if growth_match.group(1).lower() in ("increased", "grew") else -1
        metrics["revenue_growth"] = direction * float(growth_match.group(2))

    return metrics
```

**Frontend display:**

A **Metrics row** above the signal trend charts in the company detail view:

```
METRICS (Q4 2024)
Revenue: $119.6B  ▲ 4%    Gross Margin: 46.2%  ▼ 0.3pp    EPS: $2.18  ▲ 8%    Cash: $53.8B
```

Each metric shows a directional arrow (▲ green, ▼ red) vs the prior period figure. Clicking a metric opens a sparkline chart of that metric over the last 4 quarters. All data sourced from `filings.numeric_claims` — zero additional queries.

---

### 2.4 — Investment Signal Filing Card

**What it is:** A richer filing card that immediately answers the investor question: "Why does this filing matter to my position?" — replacing the current minimal card.

**New card layout:**

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Mark]  Apple Inc.                                         2h ago   │
│          AAPL · 10-K · FY 2024 · Filed Jan 31, 2025                 │
│                                                                      │
│  ┌─ INVESTMENT SIGNALS ──────────────────────────────────────────┐   │
│  │ 🔴 Risk factors expanded +34% — 47 new lines added            │   │
│  │ 🟡 ULI score 0.31 — 1.8σ above company 8-quarter average     │   │
│  │ 🟡 Filed 12 days later than historical median (56 vs 44 days) │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  GEMINI ANALYSIS                                                     │
│  Apple's 10-K introduces new risk language around EU Digital         │
│  Markets Act compliance costs and supply chain concentration in      │
│  Malaysia. MD&A hedging language elevated vs prior year...           │
│                                                                      │
│  KEY FIGURES   Revenue ▲4%   Margin 46.2%   EPS $2.18 ▲8%          │
│                                                          View ↗       │
└──────────────────────────────────────────────────────────────────────┘
```

**Signal severity coloring:**
- 🔴 Red: signal in top quartile historically for this company, OR multiple signals co-firing
- 🟡 Yellow: signal fired but not in high-severity range for this company
- The card shows only flagged signals — unfired signals are not displayed unless expanded

**Severity calculation for display:**
- Sum the individual signal weights (from the composite severity score formula below)
- Total ≥ 60: card border/marker red
- Total 30–59: card border/marker amber
- Total < 30: no special border (existing card style)

---

### 2.5 — Monthly Report Digest (Discord + Frontend)

**What it is:** A cross-company summary generated on the 1st of each month and posted to Discord, covering the entire watchlist's filing activity for the preceding 30 days.

**Digest contents:**

1. **Filing activity table:** Which companies filed what form types, counts
2. **Top signals:** The 3 highest-severity individual filings from the month across all companies
3. **Risk theme trends:** Keywords appearing across multiple companies (shared sector risks)
4. **8-K material event summary:** Most common item types filed — what categories of events dominated
5. **Company signal scores:** Ranked table of composite severity scores for each company this month, with trend arrows vs prior month

**Implementation:**

New function `generate_monthly_digest()` in `scraper/report_generator.py`:
- Called from `summa-cleanup.yml` before the delete step
- Aggregates across all companies in the watchlist
- Posts a multi-embed Discord message (one embed per section)
- Writes to a `monthly_digests` table (same structure as company reports but cross-company)

**Frontend addition:**
- New **Digest** section in sidebar nav (below Filings)
- Shows the latest monthly digest in a formatted view: table + signal summary
- Previous months accessible via a dropdown

---

### 2.6 — Composite Severity Score (0–100)

**What it is:** A single numeric score per filing summarizing total signal strength, replacing the binary `signals_flagged` flag with a ranked severity system.

**Formula:**

| Signal | Weight | Rationale |
|---|---|---|
| Risk Factor Delta | 25% | Legally mandated new disclosure — highest quality structural signal |
| 8-K Burst (≥3 in 30d) | 20% | Pattern of material events, not isolated incidents |
| Boilerplate Erosion | 15% | Major management rewrite implies something changed in how they describe the business |
| Filing Velocity | 15% | Late filings correlate empirically with audit disputes and restatements |
| ULI Shift | 10% | Management confidence decline, predictive of earnings misses |
| Friday Dump | 10% | Documented empirical pattern with subsequent return implications |
| Keyword Score | 5% | Context-dependent, lower precision than structural signals |

Each signal contributes its weight to the total only when the signal is flagged. Maximum possible score: 100 (all signals fire simultaneously — extremely rare).

**Display:**

```
severity_score: 72
```

Color bands on filing cards:
- 75–100: 🔴 Critical — warrants immediate review
- 50–74: 🟡 Elevated — review before next trading day
- 25–49: 🔵 Notable — add to watchlist follow-up
- 0–24: ⬜ Routine — no signal fired above threshold

**Schema change:**

```sql
ALTER TABLE filings ADD COLUMN IF NOT EXISTS severity_score FLOAT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_filings_severity ON filings (severity_score DESC)
WHERE signals_flagged = TRUE;
```

---

## Phase 3 — Semantic Search and Cross-Company Analysis

Phase 3 adds intelligence that requires vector representations of filing text — similarity search across filings, cross-company risk theme detection, and supply chain relationship mapping.

### 3.1 — pgvector Semantic Search

The `filings.embedding vector(768)` column is already in the schema, waiting for this phase.

**What it enables:**
- Search for any concept and find the most relevant filing excerpts across all companies and time periods: "CEO departure risk," "supply chain Malaysia," "going concern language," "EU regulatory exposure"
- Find filings most similar to a given filing — "show me other 10-Ks with risk language similar to this Apple 10-K"
- Cluster filings by semantic theme to detect sector-wide emerging risks before they show up in stock prices

**Backend implementation:**

```python
# New file: scraper/embedder.py
from google.generativeai import embed_content

def embed_section(text: str) -> list[float]:
    """
    Generate a 768-dimensional embedding for a text section using
    Google's text-embedding-004 model (free tier: 1,500 calls/day).
    """
    result = embed_content(
        model="models/text-embedding-004",
        content=text,
        task_type="RETRIEVAL_DOCUMENT"
    )
    return result["embedding"]
```

Embeddings are generated for `section_mda` (768 dimensions, matches the column definition) and stored in `filings.embedding`. Generation runs in Stage 2 (after Gemini enrichment), only for flagged filings.

**Supabase vector search function:**

```sql
CREATE OR REPLACE FUNCTION search_filings(
    query_embedding vector(768),
    similarity_threshold float,
    match_count int
)
RETURNS TABLE (
    id bigint,
    cik text,
    ticker text,
    company_name text,
    form_type text,
    filed_at timestamptz,
    similarity float
)
LANGUAGE sql STABLE
AS $$
SELECT
    f.id, f.cik, f.ticker, f.company_name, f.form_type, f.filed_at,
    1 - (f.embedding <=> query_embedding) as similarity
FROM filings f
WHERE f.embedding IS NOT NULL
  AND 1 - (f.embedding <=> query_embedding) > similarity_threshold
ORDER BY f.embedding <=> query_embedding
LIMIT match_count;
$$;
```

**Frontend addition:**

- Activate the currently stubbed **Search** nav item in the sidebar
- Full-viewport search view with a text input
- Query embedding generated client-side via Supabase Edge Function (no API key exposure)
- Results show as filing cards ranked by semantic similarity score
- Filter by company, form type, date range

---

### 3.2 — Supply Chain Relationship Graph

**What it is:** An interactive graph showing how watchlist companies reference each other in their filings — supplier/customer relationships, shared risk exposures, and dependency concentration.

**How it works:**

During signal extraction, spaCy's NER is already running (`en_core_web_md`) to identify organizations (ORG entities). When a watchlist company appears by name in another watchlist company's filing, a directed edge is added to the relationship graph.

```python
# Extended signal_extractor.py
import spacy
nlp = spacy.load("en_core_web_md")

def extract_company_references(text: str, watchlist_names: list[str]) -> list[str]:
    """
    Returns list of watchlist company names found in the text.
    Used to build the supply chain graph edges.
    """
    doc = nlp(text[:50_000])  # cap for speed
    found_orgs = {ent.text for ent in doc.ents if ent.label_ == "ORG"}
    return [name for name in watchlist_names if name in found_orgs]
```

Store extracted references in a new `company_relationships` table:

```sql
CREATE TABLE IF NOT EXISTS company_relationships (
    id              BIGSERIAL PRIMARY KEY,
    source_cik      TEXT NOT NULL,        -- company doing the filing
    target_cik      TEXT NOT NULL,        -- company referenced in the filing
    filing_id       BIGINT REFERENCES filings(id),
    reference_count INT DEFAULT 1,
    context         TEXT,                 -- sentence containing the reference
    detected_at     TIMESTAMPTZ DEFAULT NOW()
);
```

**Frontend graph visualization:**

- New **Graph** view (Phase 3 nav item)
- Interactive force-directed graph using D3.js (or Recharts `Sankey` component)
- Node size = total filing volume for that company
- Edge weight = frequency of cross-references in the last 30 days
- Edge color = red when referenced in a flagged filing context (supply chain risk)
- Click a node → navigate to that company's detail view

---

### 3.3 — Cross-Company Sector Alerts

**What it is:** When the same risk theme appears in filings from multiple companies in the same sector within a short time window, surface it as a sector-level alert — before it becomes broadly known.

**Logic:**

```python
# Runs during signal extraction for each new 10-K / 10-Q
def detect_sector_theme(new_filing_keywords: set[str], sector: str, window_days: int = 14) -> dict | None:
    """
    Check if keywords from this filing also appeared in other same-sector filings
    in the past 14 days. If overlap is significant, generate a cross-company alert.
    """
    recent_keywords = get_recent_sector_keywords(sector, window_days)
    overlap = new_filing_keywords & recent_keywords
    if len(overlap) >= 3:
        return {"shared_themes": list(overlap), "sector": sector}
    return None
```

**Example alert:**
> "Supply chain: 3 companies in Technology Hardware filed within 12 days referencing 'Malaysia,' 'single-source supplier,' and 'tariff.' Sector-level risk theme detected."

**Frontend display:**
- Sector alerts appear as a banner at the top of the FeedView
- Clicking the banner filters the feed to show only the filings that contributed to the alert

---

### 3.4 — Expanded Watchlist (500+ Companies)

**Target:** Expand from the current 7-company seed list to full S&P 500 coverage.

**Backend changes:**
- `cik_map.py` already has `fetch_live_sec_mappings()` which downloads the full SEC ticker list (~10,000 companies)
- The S&P 500 CIK list can be fetched from the SEC's company facts API or maintained as a static list
- Redis usage scales linearly with watchlist size — at 500 companies, expect ~5,000 Redis commands/day (still within the 10,000 free limit)
- Supabase storage remains flat (30-day rolling retention)

**Frontend changes:**
- The company search input in the sidebar already works as a filter on the local watchlist
- Phase 3 will add a **Search** tab that queries the full SEC ticker list and lets users add companies to their personal watchlist (requires Supabase Auth, Phase 5)

---

## Phase 4 — Backtesting and Signal Validation

Phase 4 answers the fundamental question: **do these signals actually predict anything?** This requires correlating historical signal data against subsequent price action.

### 4.1 — Historical Backtest Data Collection

**yfinance** is already in `scraper/requirements.txt`. The backtesting module downloads price data for watchlist companies and joins it against historical signal data.

```python
# New file: scraper/backtest.py
import yfinance as yf
from datetime import timedelta

def compute_post_signal_return(
    ticker: str,
    signal_date: date,
    window_days: int = 10
) -> float | None:
    """
    Returns the cumulative return from signal_date to signal_date + window_days.
    Used to measure how much price moved after a signal fired.
    """
    stock = yf.Ticker(ticker)
    hist = stock.history(
        start=signal_date,
        end=signal_date + timedelta(days=window_days + 5)  # buffer for weekends
    )
    if hist.empty or len(hist) < 2:
        return None
    return (hist["Close"].iloc[-1] / hist["Close"].iloc[0]) - 1
```

### 4.2 — Signal Accuracy Metrics

For each signal type, compute:

- **Hit rate:** What % of signal fires were followed by negative returns within 10 days?
- **Miss rate:** What % of large negative return events were preceded by a signal fire?
- **Lead time:** How many trading days before a major move does each signal typically fire?
- **Alpha decay:** How quickly does the market price in the information? (Is the signal better at 1-day, 3-day, or 10-day horizon?)

**Database additions:**

```sql
CREATE TABLE IF NOT EXISTS signal_performance (
    id              BIGSERIAL PRIMARY KEY,
    signal_name     TEXT NOT NULL,
    filing_id       BIGINT REFERENCES filings(id),
    ticker          TEXT NOT NULL,
    signal_date     DATE NOT NULL,
    return_1d       FLOAT,
    return_3d       FLOAT,
    return_10d      FLOAT,
    return_30d      FLOAT,
    computed_at     TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.3 — Backtesting Dashboard (Frontend)

A new **Backtest** view in the frontend showing:

1. **Signal scorecard table:** One row per signal type. Columns: hit rate, avg return following signal fire, vs base rate (random day return for the same company/period)
2. **Return distribution chart:** Histogram of 10-day returns following signal fires vs random days for each signal type — visualizes whether the signal distribution differs from the null hypothesis
3. **Per-company breakdown:** Which signals have been most predictive for which company?
4. **Alpha decay curves:** Line chart of average cumulative return at 1, 3, 5, 10, 20, 30 trading days post-signal — shows the optimal holding period per signal type

**This data informs signal weight adjustments** in the composite severity score (Phase 2.6). If backtesting shows that Friday Dump has a 73% hit rate while Keyword Scoring has 48%, their weights should reflect the empirical difference.

---

## Phase 5 — Expansion and Monetization

Phase 5 converts Summa from a personal intelligence tool into a multi-user product with optional premium features.

### 5.1 — Email Digest

**Weekly email** summarizing the past 7 days of filing activity across the user's watchlist:
- Top 3 highest-severity signals from the week
- Any new risk themes detected
- Companies with unusual filing patterns
- Preview of each company's latest Gemini summary

**Implementation:** Resend (free tier: 3,000 emails/month) + a new `digest_subscribers` table. The weekly digest cron runs Sunday at 6 AM ET (before markets open Monday).

### 5.2 — Supabase Auth + Per-User Watchlists

**Multi-user support** requires:
- Enable Supabase Auth (email/password or Google OAuth)
- New `user_watchlists` table: `(user_id, cik, added_at)`
- RLS policies updated to filter data by `auth.uid()`
- Frontend: sign-in flow, watchlist management UI in sidebar

This unlocks the ability for users to follow different companies, receive personalized alerts, and maintain private notes on each company.

### 5.3 — Custom Watchlist UI

Currently, the watchlist is hardcoded in `frontend/lib/watchlist.ts` (7 companies). Phase 5 adds:
- A search interface to find any of the ~10,000 SEC-registered tickers
- Add/remove buttons per company
- Saved to `user_watchlists` in Supabase, synced across devices
- Backend scraper dynamically reads the active watchlist at run time, not from the static file

### 5.4 — Mobile App (React Native / Expo)

The same Supabase data layer powers a React Native app:
- Native push notifications for real-time signal alerts (via Expo Notifications + Supabase Edge Functions)
- Same hash-routed navigation adapted to native screens
- Offline support: cached last 10 flagged filings
- Platform-specific UX: bottom tab bar, swipe gestures, haptic feedback on critical alerts

### 5.5 — Premium Signal Tier

After Phase 4 backtesting establishes which signals have proven alpha:
- Free tier: feed view, basic signal flags, 30-day window
- Premium tier: composite severity scores, trend charts, monthly reports, backtesting dashboard, custom watchlists up to 50 companies, email digest
- Monetization via Stripe (one-time or monthly subscription)

---

## Design Constraints

These are permanent architectural decisions. If a proposed change violates one, stop and document why before proceeding.

**No full filing to Gemini.** A 10-K is 80,000+ words. Sending the full document exhausts the free quota in a single call and adds no precision — the structural signals are deterministic and do not benefit from LLM processing. Stage 1 always runs first and extracts a short excerpt (~200 words). Only that excerpt goes to Gemini.

**No Gemini call when no signals are flagged.** Every call consumes daily quota. Stage 2 is conditional on Stage 1 output. Calling Gemini on unflagged filings would produce summaries saying "nothing material found" — zero value, wasted quota.

**No Redis for 8-K burst detection.** Burst counting queries Supabase (`SELECT COUNT(*) WHERE filed_at > NOW() - INTERVAL '30 days'`). Zero Redis cost. Redis is reserved exclusively for deduplication.

**No calendar logic.** Redis deduplication handles weekends and holidays automatically. Adding a holiday calendar library introduces complexity and maintenance burden with zero benefit.

**Never use spaCy `en_core_web_sm`.** Always `en_core_web_md`. The small model's NER accuracy on financial entity names (company names, geographic entities, executive titles) is insufficient. This has been tested directly and the medium model is required.

**No async in the scraper.** Synchronous requests with explicit rate limiting (120ms between EDGAR requests) are sufficient for a cron pipeline processing dozens of filings per run. Async adds complexity, harder debugging, and the SEC rate limit (10 req/s) is the bottleneck regardless.

**No raw HTML in the database.** Only cleaned section text, capped at 8,000 characters per section. Raw HTML includes JavaScript, CSS, XBRL inline tags, and formatting noise that degrades signal quality and wastes storage.

**No Vercel.** Cloudflare Pages serves the static export with no bandwidth cap, no function timeout, and no cold-start latency. Vercel's free tier has bandwidth limits and function execution limits that conflict with Realtime WebSocket connections.

**No Next.js API routes.** The frontend is strictly read-only. All writes go through GitHub Actions with the service_role key. Adding API routes would require server-side execution, which conflicts with the static export and Cloudflare Pages deployment.

**No hardcoded credentials.** Backend uses `scraper/.env` (gitignored). Frontend uses `frontend/.env.local` (gitignored). Production uses GitHub Secrets and Cloudflare Pages environment variables. The service_role key is never committed to the repository and never present in any frontend code or `NEXT_PUBLIC_` variable.

**No feedparser.** Parse EDGAR Atom XML directly with BeautifulSoup. `feedparser` adds a dependency for marginal benefit; BeautifulSoup is already required for HTML cleaning.

**SEC User-Agent header on every EDGAR request.** Format: `"AppName/1.0 (contact@email.com)"`. This is legally required by the SEC for all programmatic EDGAR access. Never exceed 10 requests/second. The pipeline uses 120ms delays between requests.

---

## Contributing

This is a solo project in active development. If you find issues:

1. File a GitHub Issue with the accession number, signal output, and expected vs actual behavior
2. Signal threshold changes should include a unit test demonstrating the boundary case
3. Frontend changes must pass `npx tsc --noEmit` (TypeScript strict mode) before consideration
4. New signals must follow the `{"score": float, "flagged": bool, "excerpt": str}` return format and include a graceful first-filing fallback
5. No new dependencies without justification — the goal is zero-cost permanent free-tier operation
