# Summa — Phase 1: Data Foundation **+ Visualization**

[![CI](https://github.com/Zhichengu1/Summa/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhichengu1/Summa/actions/workflows/ci.yml)
[![secret-scan](https://github.com/Zhichengu1/Summa/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/Zhichengu1/Summa/actions/workflows/secret-scan.yml)
[![pipeline](https://github.com/Zhichengu1/Summa/actions/workflows/summa-pipeline.yml/badge.svg)](https://github.com/Zhichengu1/Summa/actions/workflows/summa-pipeline.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Updates the earlier "data only" Phase 1. Phase 1 now ships **two** things: (1) the data warehouse — every price-relevant SEC dataset via edgartools — and (2) the [13f.info](https://13f.info)-style UI to **see and explore** every one of those datasets. By the end of Phase 1 you can open any watchlist company and read its fundamentals, ownership, and catalysts in dense sortable tables and clean charts.

**Phase 1 boundary (revised).** In scope: data ingestion **and** its visualization. Out of scope until Phase 2+: anything *derived* — signal/factor computation, the composite score, cross-company factor screening, backtesting. You can't chart a factor you haven't computed yet; Phase 1 visualizes the raw SEC data, Phase 2+ visualizes the analysis built on it.

---

## Part A — The Data (recap)

The warehouse Phase 1 fills (full schema in **Database Design**). All structured tables retained; only `filings` text rolls off at 30 days.

| Dataset | Table | edgartools source |
|---|---|---|
| Fundamentals (XBRL, incl. segments + shares out.) | `financial_facts` | `get_facts()` / `financials` |
| Insider transactions (Form 4) | `insider_transactions` | `get_filings(form="4")` → `Form4` |
| Institutional holdings (13F-HR) | `institutional_holdings` | `get_filings(form="13F-HR")` → `ThirteenF` |
| Beneficial ownership (13D/13G) | `beneficial_ownership` | `get_filings("SC 13D"/"SC 13G")` |
| Proposed insider sales (Form 144) | `proposed_sales` | `get_filings(form="144")` |
| Earnings & guidance (8-K 2.02 + EX-99.1) | `earnings_events` | `get_filings(form="8-K")` + exhibit |
| Material 8-K events | `corporate_events` | `EightK.items` |
| Late-filing notices (NT 10-K/Q) | `late_filings` | `get_filings("NT 10-K"/"NT 10-Q")` |
| Securities offerings (S-3/424B) | `securities_offerings` | `get_filings("S-3"/"424B*")` |
| Narrative filings + sections | `filings` | typed `TenK`/`TenQ`/`EightK` |

---

## Part B — The Visualization Layer (13f.info-style)

### B.0 — Design principles & UI shell

**The 13f.info DNA, made explicit:**

1. **Tables first.** Every dataset's default view is a **dense, sortable, monospace table** with clickable headers (▲/▼), tight rows, subtle gridlines, hover highlight. Charts are the complement, not the centerpiece.
2. **Minimal chrome.** No cards-with-shadows, no gradients. Thin borders, lots of data per screen, fast.
3. **Client-side everything.** Sort, filter, and chart computation run in-browser over the loaded data — zero server round-trips. Static export on Cloudflare Pages.

**Layout.** Sticky sidebar (brand · search · watchlist with flagged dots) + main content. Two destinations:
- **Watchlist Overview** — the landing dashboard across all companies.
- **Company page** — tabbed: **Overview · Fundamentals · Ownership · Catalysts · Filings**.

**Core component — `DataTable`** (reused everywhere): generic sortable/filterable table; props for columns, formatters, badges, and a row-click. This single component is the workhorse — fundamentals statement, holdings, insider, events all render through it.

**Design tokens (dark terminal).** `--bg-0 #08090f` · `--bg-1 #0d1117` · `--bg-2 #141c2e` (rows) · `--bg-3 #1e2a40` (hover) · `--border-1 #2e3f60` (gridlines) · `--fg-0 #e8edf5` · `--fg-2 #8ba0bd` · `--fg-4 #3d526e` · `--accent #4fd4c2` (chart/interactive) · `--alert #f05252` · `--warn #f5a623` · positive `#3fb950` / negative `#f05252` for deltas. **JetBrains Mono** for all data. Form-type badges: 10-K blue, 10-Q green, 8-K yellow, DEF 14A pink.

**Charts.** Recharts only (dynamic SVG, no canvas, static-export-safe). Dark theme, thin strokes, accent fills, custom tooltips that map each point back to its source filing (date · form · value). Charts derive series in `useMemo` from the in-memory arrays.

**Routing.** Hash-based, bookmarkable: `#overview`, `#c=<CIK>`, `#c=<CIK>/fundamentals`, `#c=<CIK>/ownership`, `#c=<CIK>/catalysts`, `#feed`.

### B.1 — Best visualization per dataset

For each dataset: the **table** (always) and the **best chart** for its data shape.

**Fundamentals → `financial_facts`** (Fundamentals tab)
- **Statement table:** line items as rows, periods as **sortable columns** (recent → left), annual ⇄ quarterly toggle. The 13f.info-grade core table.
- **KPI tiles** (top strip): latest revenue, gross margin, diluted EPS, cash — each with QoQ + YoY ▲/▼.
- **Revenue + growth:** combo chart — bars (absolute) with a YoY-growth **line** overlay. Level and rate in one view.
- **Margins:** multi-line (gross / operating / net) — bounded, comparison-friendly.
- **EPS:** bar chart per period.
- **Cash vs long-term debt:** paired bars — balance-sheet strength at a glance.
- **Free cash flow:** bar/area.
- **Segment & geographic revenue:** **stacked area** over time — shows mix shift, not just totals.

**Insider transactions → `insider_transactions`** (Ownership tab)
- **Transaction table:** date · insider · title · buy/sell badge · shares · price · value · shares-after.
- **Net insider flow:** **diverging bar** chart over time — buys above the axis (green), sells below (red); 10b5-1 excluded. Direction *is* the signal, so a diverging bar reads instantly. Optional cumulative-net line overlay.

**Institutional holdings → `institutional_holdings`** (Ownership tab — the literal 13f.info surface)
- **Holdings table:** fund · shares · value · % of portfolio · QoQ Δ — sortable. This *is* the 13f.info table.
- **QoQ compare:** color-coded **diff table** — Added / Removed / Increased / Decreased between two quarters (green/red). 13f.info's signature compare view.
- **Managers-holding-by-quarter:** **bar** chart of the count of funds holding the name each quarter — the accumulation/distribution trend (13f.info has exactly this).
- **Top holders:** horizontal bar by value.

**Beneficial ownership → `beneficial_ownership`** (Ownership tab)
- **Stake table:** filer · schedule (13D/13G) · activist flag · % of class · shares · Item 4 purpose excerpt.
- **Activist timeline:** dated markers when a 13D/13G is filed, sized/labeled by % of class — a 5% activist crossing is a catalyst, so it gets its own timeline.

**Proposed sales → `proposed_sales`** (Ownership tab)
- **Pending-sales table:** seller · relationship · shares · approx value · approx date.
- **Forward markers** on the insider net-flow chart (pending sells as a leading indicator next to realized Form-4 sells).

**Earnings & guidance → `earnings_events`** (Catalysts tab)
- **Guidance trajectory:** a **line + range band** over time — guidance low–high as a shaded band, midpoint as the line, with raised/lowered/withdrawn **markers**. The single clearest read on management confidence.
- **Earnings table:** period · reported date · revenue · diluted EPS · net income · guidance action.
- **Revenue/EPS vs prior:** bars with a prior-period reference line.

**Corporate events → `corporate_events`** (Catalysts tab)
- **Catalyst timeline:** vertical event **markers** on a date axis, **color-coded by class** (M&A, dilution, restatement, cyber, capital return, exec change). Discrete dated events → a timeline is the right shape, not a chart.
- **Event table:** date · item code · class badge · summary.
- **Event-frequency strip:** small monthly histogram by class — shows clustering.

**Late filings → `late_filings`** (Catalysts tab)
- **Red flags** on the catalyst timeline (highest-attention markers).
- **Table:** NT form · subject form · period · reason excerpt.

**Securities offerings → `securities_offerings`** (Catalysts tab)
- **Dilution markers** on the timeline.
- **Cumulative dilution overlay:** offerings plotted against the shares-outstanding series from `financial_facts` — see issuance bend the share count.
- **Table:** form · offering type · amount · shares.

**Narrative filings → `filings`** (Filings tab + Overview)
- **Realtime feed table:** ticker · company · form badge · filed date · EDGAR link — the live feed, capped at 200 in memory, new rows prepended via WebSocket.
- **Filing-volume chart:** **stacked bar** by form type over time (composition + volume) — the watchlist-level pulse.

### B.2 — Page composition

**Watchlist Overview** (`#overview`): KPI strip across the watchlist · filing-volume stacked bar · a "recent catalysts" timeline strip merged across companies · a sortable watchlist table (company · last filing · 30-day filing count · last catalyst).

**Company page** (`#c=<CIK>`):
- **Overview tab:** identity header + KPI tiles + a compact catalyst timeline + recent filings.
- **Fundamentals tab:** statement table + the fundamentals charts (B.1).
- **Ownership tab:** insider + institutional + activist + Form-144 panels (B.1).
- **Catalysts tab:** the unified earnings/events/late/offerings timeline + tables (B.1).
- **Filings tab:** the company's filing feed table.

### B.3 — Chart-type cheat sheet (the "best graph for all these data")

| Data shape | Best visualization | Why |
|---|---|---|
| One metric over time + its growth | **Combo:** bars + growth line | level and rate in one view |
| Several bounded % series | **Multi-line** | compare trends on a shared 0–100% axis |
| Composition that shifts over time | **Stacked area / stacked bar** | shows mix, not just total (segments, filing volume) |
| Discrete per-period values | **Bar** | EPS, FCF, managers-by-quarter |
| Two opposing balance-sheet series | **Paired bars / dual line** | cash vs debt at a glance |
| Signed events over time (buy/sell) | **Diverging bars (+ cumulative line)** | direction is the signal |
| Ranked snapshot | **Sortable table (+ horizontal bar for top-N)** | 13f.info core; ranking beats plotting |
| Difference between two snapshots | **Color-coded diff table** | added / removed / increased / decreased |
| A range + a central estimate over time | **Line + shaded band + markers** | guidance trajectory and revisions |
| Discrete dated events of different kinds | **Timeline with color-coded markers** | catalysts, offerings, late filings |
| Magnitude-at-a-date crossings | **Timeline + table** | 13D activist stakes |

> Rule of thumb, straight from 13f.info: **if it can be a sortable table, make it a table first;** add a chart only when the *shape over time* or *composition* is the point.

---

## Part C — Phase 1 build checklist (data **+ UI**)

```
DATA (backend/) — recap
  [~] financial_facts        data_ingest.py (backfill + incremental)
  [~] insider_transactions   insider_extractor.py
  [~] institutional_holdings institutional_extractor.py
  [ ] beneficial_ownership   ownership_extractor.py  (13D/13G)
  [ ] proposed_sales         ownership_extractor.py  (Form 144)
  [ ] earnings_events        event_extractor.py      (8-K 2.02 + EX-99.1)
  [ ] corporate_events       event_extractor.py      (8-K items)
  [ ] late_filings           event_extractor.py      (NT)
  [ ] securities_offerings   event_extractor.py      (S-3/424B)
  [x] filings + dedup + retention split

UI (frontend/)
  [x] App shell + sidebar + realtime feed table (live today)
  [ ] DataTable          reusable sortable/filterable table primitive
  [ ] Design tokens + JetBrains Mono + form-type badges wired
  [ ] charts/            Recharts wrappers: Combo, MultiLine, StackedArea,
                         DivergingBar, Timeline, DiffTable, GuidanceBand
  [ ] OverviewPage       KPI strip · filing-volume · catalyst strip · watchlist table
  [ ] CompanyPage        tab shell (Overview/Fundamentals/Ownership/Catalysts/Filings)
  [ ]   FundamentalsTab  statement table + KPI tiles + 6 charts
  [ ]   OwnershipTab     insider net-flow + tables + 13F holdings + QoQ compare + activist
  [ ]   CatalystsTab     unified timeline + earnings/guidance + event tables
  [ ]   FilingsTab       per-company feed table
  [ ] hash routing       #overview, #c=<CIK>/<tab>, #feed
  [ ] anon RLS verified  SELECT only on public columns of every dataset

DONE WHEN: every watchlist company renders all five tabs from live Supabase data,
sort/filter/charts are client-side, and the build passes `npm run build` (static export).
```

---

## Phase boundary (updated) & what moves where

- **Phase 1 = data + its visualization.** Ingest every dataset *and* ship the 13f.info-style tables/charts to read each one, per company and across the watchlist.
- **Phase 2 = derived analysis UI.** What's left for Phase 2 is the work that needs computation first: the **factor-based screener** (rank the watchlist by computed factors), **semantic search**, the **cross-company relationship graph**, and the per-company Gemini report. (The raw per-dataset visualization that was tentatively Phase 2 now lives in Phase 1.)
- **Phase 3 = factor engine**, **Phase 4 = factor validation/backtesting**, **Phase 5 = productization** — unchanged from the Phases 2–5 spec.
- **Discord** is unchanged and remains a Phase 2 output channel.

These are the same Recharts components and the same `DataTable` you build in Phase 1 — Phase 2+ just feeds them *derived* series (factor z-scores, IC curves) instead of raw SEC values, so the visualization investment compounds.