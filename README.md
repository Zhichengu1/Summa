# Summa — Zero-Cost Market Intelligence Platform

[![CI](https://github.com/Zhichengu1/Summa/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhichengu1/Summa/actions/workflows/ci.yml)
[![secret-scan](https://github.com/Zhichengu1/Summa/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/Zhichengu1/Summa/actions/workflows/secret-scan.yml)
[![pipeline](https://github.com/Zhichengu1/Summa/actions/workflows/summa-pipeline.yml/badge.svg)](https://github.com/Zhichengu1/Summa/actions/workflows/summa-pipeline.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A SEC-filing **data warehouse** + a [13f.info](https://13f.info)-style research dashboard that
> runs entirely on free tiers: GitHub Actions ingests every price-relevant SEC dataset via
> [edgartools](https://github.com/dgunning/edgartools) into Supabase (Postgres), and a Next.js 14
> static frontend renders it as dense, sortable, per-company research pages with a live filings
> feed — plus news, Reddit-sentiment, IPO, and 13F-manager intelligence channels and Discord
> alerting on top.
>
> **Core principle: ingest once, cheaply, and spread the work across runs.** Every cron tick
> visits a bounded batch of companies; each dataset refreshes only when its own cadence has
> elapsed. Coverage scales by spreading work across runs, never by doing more per run — so the
> whole thing stays inside the free tier forever, at any watchlist size.

---

## What's live today

### 1. The SEC data warehouse (Phase 1 — ✅ shipped)

A GitHub Actions cron runs `backend/main.py` every 10 minutes. For each due company it pulls:

| Dataset | Table | Source |
|---|---|---|
| Fundamentals (XBRL income / balance / cash-flow) | `financial_facts` | edgartools `get_facts()` |
| Narrative filings feed + extracted sections | `filings` | typed `TenK`/`TenQ`/`EightK` |
| Insider transactions (Form 4) | `insider_transactions` | `Form4` |
| Institutional holdings (13F-HR, per company) | `institutional_holdings` | `ThirteenF` |
| **13F manager portfolios** (top-N holdings + QoQ buy/sell moves across *all* stocks, per tracked manager) | `manager_portfolios` | global quarterly pass |
| Beneficial ownership (SC 13D/13G ≥5% stakes) | `beneficial_ownership` | `get_filings` |
| Proposed insider sales (Form 144) | `proposed_sales` | `get_filings` |
| Earnings & guidance (8-K Item 2.02 + EX-99.1) | `earnings_events` | `EightK` |
| Classified material 8-K events | `corporate_events` | `EightK.items` |
| Late-filing notices (NT 10-K/Q) | `late_filings` | `get_filings` |
| Securities offerings (S-1/S-3/424B) | `securities_offerings` | `get_filings` |
| **Market-wide IPO pipeline** (S-1/F-1 → 424B pricings → RW withdrawals) | `ipos` | real-time current-filings feed |
| End-of-day prices (~2y rolling) | `daily_prices` | Yahoo Finance (keyless) |
| Precomputed per-company summary (price + technicals + activity) | `company_summary` | `summary_ingest` |
| SIC industry / curated themes / entity registry | `company_profiles` · `company_themes` · `entities` | SEC + seeds |

The watchlist is **SEED ∪ a Supabase `watchlist` table** — queue any company from the UI's
universal ticker search (bundled SEC company index) and the pipeline picks it up with zero code
changes.

### 2. Intelligence channels (non-SEC, all keyless & fail-soft)

- **Company news** — Google News RSS per company, scored by a composite catalyst model
  (event × source × fundamentals × directness × price move), stored only above an importance
  floor. A dedicated `summa-news` workflow polls every 5 minutes, so effective latency is ~5 min.
- **Market movers** — a curated global feed (Fed press/speeches/testimony · BEA · SEC · FDA ·
  FTC · CFTC · White House executive actions · PR Newswire), importance-filtered into
  `market_news` and surfaced as the dashboard's "Top Intelligence" feed.
- **Reddit trends** — daily most-discussed tickers from ApeWisdom + Tradestie WSB sentiment
  (never scraping reddit.com) into `reddit_trends`, posted as a sectioned Discord digest: medal
  top-3 detailed, ranks 4–20 as one-liners, a **🌱 "Under the radar"** section that detects
  low-chatter tickers whose mentions doubled in 24h / jumped ≥15 rank spots / just appeared on
  the board, and intraday surge-only alerts on weekdays.
- **Discord alerting** — opt-in, fail-soft webhooks for just-filed 8-K/10-K/10-Q/DEF 14A,
  high-score news, market movers, the Reddit digest, and a weekday-morning watchlist brief
  (price/technicals recap + earnings radar).

### 3. The dashboard (Next.js 14 static export)

Read-only over Supabase (anon key, RLS-enforced), hash-routed, client-side sort/filter/charts:

- **Overview** — watchlist table driven by the `company_summary` precompute, momentum scanner,
  and a cross-watchlist **Live Signals** scanner (insider clusters, earnings, events, activist
  stakes, offerings, late filings) sharing one signal engine with the company pages.
- **Company pages** — tabbed research cockpit: Overview · Strategy · Fundamentals · Peers ·
  Ownership · Catalysts · Filings · News, with a scorecard grade, valuation, technicals, and
  filing-reaction stats.
- **Managers** — 13f.info-style institutional-investor view: each tracked manager's latest
  portfolio vs. prior quarter (adds / exits / increases / decreases).
- **IPOs** — the active IPO pipeline grouped by issuer, ranked by capital raised, SPAC/micro
  filtered.
- **Feed / News / Calendar / Search** — live filings feed (Supabase Realtime), the two news
  surfaces, an earnings/catalyst calendar, and universal SEC ticker search.

### 4. Operations

Eleven scheduled workflows, all free-tier: the 10-min ingest, 5-min news refresh, weekday
morning brief, weekday-evening prose recap, daily+intraday Reddit digest, twice-daily
congressional trades, weekly CFTC COT, monthly retention cleanup, weekly SEC-index rebuild,
a post-deadline quarterly 13F roll-forward, and a weekly keepalive heartbeat — plus CI (typecheck + compile) and
gitleaks secret scanning on every push. Retention keeps storage bounded: filing text 30d, feed
rows 90d, prices ~2y, manager portfolios 4 quarters, news/Reddit 30d, IPOs 120d.

---

## AI Scope

**There is no LLM in the pipeline today.** Every signal Summa surfaces is computed by
deterministic, explainable code over the warehouse — nothing generated, nothing hallucinated,
no third-party AI service in the data path. The rule for any future addition stays: **the
algorithm finds the signal; an LLM would only name and explain it**, gated behind a free
Stage-1 computation.

### Today (shipped)

- **Composite catalyst scoring** (`news_score.py`) — a hand-built, explainable model that
  scores every headline for trader-importance before storage or alerting. No LLM in the loop;
  this is the pattern all Stage-1 gates follow.
- **Rule-based signal, scoring, and options logic** — `pulse.ts`, `scorecard.ts`,
  `options.ts`, `technicals.ts` and friends are pure functions over stored rows.
- **Templated prose recap** (`recap.py`) — the daily watchlist wrap-up is written in plain
  English from `company_summary` numbers by deterministic templates, posted to Discord each
  weekday evening. Reproducible sentence-for-sentence, and impossible to hallucinate.

### Phase 2 — Trend Intelligence (designed, next up)

Move from *per-company* facts to a *cross-company* read: **what are most companies converging
on, and what's the next industry trend?**

1. **Stage 1 (free, always runs):** normalize per-company themes + a keyword pass over filing
   business/MD&A sections onto a canonical taxonomy → count **breadth** (distinct companies
   adopting a theme per quarter) and **depth** (R&D/CapEx growth, M&A, offering proceeds tagged
   to the theme) → a momentum score → stage-classify each theme (emerging / accelerating /
   mainstream / cooling) into `theme_trends`.
2. **Naming (optional, not implemented):** clustering synonymous phrases and writing the
   "why this is the next trend" blurb would be the only place an LLM could earn its place —
   over the small aggregated phrase set, never over filings. No provider is wired in.
3. **Frontend:** a Trends leaderboard ranked by momentum, with breadth, capital flow, stage
   badges, and drill-down to the companies driving each theme.

### Phase 2C+ — the deeper AI roadmap (ideas only — no LLM provider is wired in)

- **Semantic layer (pgvector):** embeddings on theme mentions and filing sections for
  similarity clustering beyond the keyword taxonomy — "companies talking like NVDA did in
  2022," true semantic search over the warehouse.
- **AI analyst briefs:** per-company one-pagers synthesized from the warehouse (fundamentals
  trajectory + ownership shifts + catalysts + news), regenerated only when the underlying rows
  change — cache-first, excerpt-only.
- **Event interpretation:** LLM-classified 8-K severity and guidance-language deltas
  ("cautiously optimistic" → "confident") as structured columns, extracted at ingest while the
  text is in-window.
- **Cross-signal narratives:** when Stage-1 signals cluster (insider buys + activist stake +
  guidance raise inside a window), an LLM writes the connecting thesis — the algorithm decides
  *that* it matters, the LLM explains *why*.
- **Natural-language screening:** translate "profitable small caps with insider buying and
  rising institutional ownership" into filters over the factor engine (Phase 3) — the LLM
  compiles the query; deterministic code executes it.

---

## Roadmap — the lifelong economy & trading platform

The long-term goal: one place a person can use **for decades** to understand the economy,
research any company, follow smart money, and manage their own trading decisions — free forever,
data-first, no black boxes. Phase 1 built the warehouse; each phase below layers a durable
capability on top. The discipline never changes: free/keyless sources, bounded per-run cost,
precompute-or-paginate reads, and algorithms-gate-LLMs.

### Phase 3 — Factor & analytics engine

Turn raw warehouse rows into *computed, comparable* signals:

- **Factor library:** value (earnings/FCF yield), quality (margins, accruals, ROIC), growth
  (revenue/EPS velocity), momentum (price + estimate), dilution, insider-conviction, and
  institutional-accumulation factors — each a pure function over existing tables, recomputed on
  the same staged cadence into small per-company factor rows.
- **Cross-sectional ranking:** z-scores within sector and market, powering a real screener
  ("rank the watchlist by quality + insider buying") instead of single-metric sorts.
- **Composite scorecard v2:** today's frontend scorecard grades move into the backend as a
  versioned, historized composite — so you can later ask "what was this stock's score the day I
  bought it?"

### Phase 4 — Validation & backtesting

Make every signal earn its place:

- **Point-in-time discipline:** signals are already stamped at ingest; backtests replay them
  against `daily_prices` with realistic lags (a 13F is known 45 days late, a Form 4 two days
  late).
- **Event studies:** average forward returns after each signal class (insider cluster buys,
  guidance raises, activist stakes, under-the-radar Reddit spikes) — measured on your own
  warehouse, not vendor claims.
- **Factor IC curves:** rank-information-coefficient tracking per factor per regime, shown in
  the dashboard so decaying signals are visibly demoted.
- **Honest coverage labels:** every stat carries its sample size and window — a thin watchlist
  gives a thin signal, and the UI says so.

### Phase 5 — The economy layer (macro)

Widen from stocks to the economy they live in, using the same free-source contract:

- **FRED / BLS / BEA / Treasury FiscalData / EIA** ingestors → a `macro_series` table: rates,
  curve, CPI/PCE, payrolls, claims, retail sales, GDP nowcasts, deficits, energy. All free
  APIs; FRED needs only a free key.
- **Macro dashboard:** a regime page (growth × inflation quadrant, curve shape, financial
  conditions) with the same dense-table + sparse-chart language as the rest of the app.
- **Macro-aware context:** company pages annotate fundamentals with the macro backdrop (rate
  sensitivity for financials, energy input costs for industrials); the calendar merges FOMC /
  CPI / payrolls dates with earnings; Fed/BEA headlines in `market_news` link to the series
  they move.
- **Regime-conditioned analytics:** Phase-4 event studies and factor ICs split by regime —
  "insider buys work best in easing cycles" is the kind of durable, personal knowledge the
  platform accumulates.

### Phase 6 — Portfolio & lifelong memory

The "lifelong" part — the platform remembers *your* journey:

- **Positions & lots:** a manually-entered (or CSV-imported) portfolio table — no broker keys
  required, keeping the zero-cost/zero-secret posture; cost basis, lots, realized/unrealized
  P&L against the existing price warehouse.
- **Decision journal:** every buy/sell can attach the *evidence at the time* — a snapshot of
  the scorecard, active signals, and macro regime on that date. Years later you can audit which
  reasoning actually worked.
- **Personal analytics:** hit-rate by signal type you acted on, holding-period returns vs. the
  watchlist baseline, drawdown history — your own Phase-4 event study, run on yourself.
- **Watch-me alerts:** per-position Discord alerts (new 8-K, insider sale cluster, guidance
  cut, 13F distribution) so holdings are monitored the way the watchlist already is.
- **Long-horizon archives:** selective aging instead of deletion — monthly price rollups past
  2y, annual fundamental snapshots — so a 20-year-old position still has its full story.

### Phase 7 — The AI copilot (productization)

Everything above becomes conversational:

- **Ask the warehouse:** natural-language questions ("who's accumulating semis?", "how did my
  energy trades do in hiking cycles?") compiled into deterministic queries over the factor
  engine, portfolio, and macro layer — answers cite the underlying rows.
- **Proactive briefs:** the morning Discord brief grows into a personalized daily letter:
  your positions, your signals, the macro calendar, and one Phase-2 trend worth reading about.
- **Teaching mode:** every metric already links to a glossary; the copilot extends that into
  guided explanations grounded in the user's own holdings — a platform you can start using at
  18 with no finance background and still be learning from at 60.

### What this is *not*

No order execution, no paid data vendors, no signals sold as advice. Summa is a research and
decision-support platform: it makes the primary sources (SEC, Fed, BLS, the market itself)
legible and keeps you honest about what worked. The moat is the discipline — zero cost,
point-in-time data, explainable signals — compounding for a lifetime.

---

## Architecture

```
GitHub Actions (cron, free)                Supabase (Postgres, free)         Cloudflare Pages (free)
┌──────────────────────────────┐          ┌─────────────────────────┐       ┌──────────────────────┐
│ summa-pipeline   */10 min    │  service │  20+ warehouse tables   │ anon  │  Next.js 14 static   │
│ summa-news       */5  min    │  role    │  (RLS: anon SELECT;     │ key   │  export dashboard    │
│ summa-brief      weekday am  ├─────────▶│  watchlist SELECT+INSERT│──────▶│  + Supabase Realtime │
│ summa-reddit     daily+intra │  writes  │  from the UI only)      │ reads │  live filings feed   │
│ summa-cleanup    monthly     │          └─────────────────────────┘       └──────────────────────┘
│ summa-secindex   weekly      │                     ▲
│ summa-13f-quarter quarterly  │          SEC EDGAR · Yahoo · Google News RSS
└──────────────┬───────────────┘          Fed/BEA/SEC/FDA/FTC/CFTC/WH/PRN RSS
               └─▶ Discord webhooks       ApeWisdom · Tradestie   (all keyless)
```

Key invariants (see `CLAUDE.md` for the full working reference):

- **Staged cadence** is the scaling mechanism — per-run cost is fixed by
  `INGEST_MAX_PER_RUN` + a wall-clock budget, independent of watchlist size.
- **All writes via `db.py` helpers**; scraper uses the service-role key, frontend the anon key.
- **Extractors fail soft** — a dead feed or a broken parser never aborts a run.
- **Every data source is free and keyless**; all credentials via environment variables.
- **Frontend is read-only** — the only UI write is queueing a company into `watchlist`.

---

## Local development

```bash
# Backend
cd backend
python -m venv venv && venv\Scripts\activate   # Windows
pip install -r requirements.txt
# create backend/.env (see .env.example): SUPABASE_URL, SUPABASE_KEY, EDGAR_IDENTITY
python main.py AAPL          # force-ingest one company, every dataset
python main.py               # staged cadence (what the cron runs)

# Frontend
cd frontend
npm install
# create frontend/.env.local: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev                  # http://localhost:3000
npx tsc --noEmit             # typecheck
```

Apply `schema.sql` once in the Supabase SQL Editor (idempotent, safe to re-run) before the
first backend run.

---

## License

MIT — see [LICENSE](LICENSE).
