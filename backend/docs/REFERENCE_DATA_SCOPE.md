# Backend Task: Reference-Data Pipeline (industry profiles, themes, entity context)

**Status:** Phase A implemented (SIC + seeds + frontend adapters). Phases B & C pending.
**Owner:** backend

> **Deploy step required:** run the updated `schema.sql` in the Supabase SQL Editor to
> create `company_profiles`, `company_themes`, and `entities` (it's idempotent). Until then
> the backend ingest no-ops gracefully and the frontend falls back to its embedded seeds.
**Goal:** Move the hand-written context maps out of the frontend (`frontend/lib/taxonomy.ts`, `frontend/lib/entities.ts`) and make them a maintained, scalable part of the data warehouse — **without increasing Supabase read pressure on the hot path.**

---

## 1. Why

Two context layers are currently curated by hand in the frontend:

| Frontend file | Content | Used by |
|---|---|---|
| `lib/taxonomy.ts` | sector/industry + strategic `thesis` + `themes[]` (Dojo, Optimus, Kuiper…) per ticker | Company header, Overview "Industry" column, **Strategy tab** |
| `lib/entities.ts` | who each institutional manager / activist is (index vs active vs activist vs bank) + one-line note | Ownership tables, cockpit event tape |

These work for the 7-company watchlist but don't scale and don't belong in the UI bundle. This task makes them backend-owned reference data.

## 2. The hard constraint — Supabase free-tier budget

This is the reason the task exists in this shape. The free tier limits we protect:

- **Egress / request volume** — naive designs explode this. A per-holdings-row entity lookup, or a join on every Ownership render, would multiply reads.
- **Row count / storage** — reference tables must stay *small and slowly-changing*.

**Design rule:** reference data is **fetched once per session and matched client-side**, exactly like the current static maps — never joined per row, never re-queried per company page beyond the company's own profile. Two extra small `SELECT`s per session, total.

**Even cheaper variant (recommended for production):** a build-time export step writes the reference tables to a static JSON bundled with the frontend, so the runtime makes **zero** Supabase reads for context. See §7.

## 3. New schema (add to `schema.sql`, idempotent)

```sql
-- Slowly-changing reference data. Small tables, read once, RLS: anon SELECT only.

-- Per-company industry classification + strategic narrative.
CREATE TABLE IF NOT EXISTS company_profiles (
    cik         TEXT PRIMARY KEY REFERENCES companies(cik),
    sector      TEXT,            -- broad bucket (from SEC SIC, normalized)
    industry    TEXT,            -- specific line of business
    thesis      TEXT,            -- high-level strategic picture (1–2 sentences)
    source      TEXT,            -- 'sic' | 'llm:10-K' | 'seed'
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Forward-looking themes / next-trend bets, with plain-language context.
CREATE TABLE IF NOT EXISTS company_themes (
    cik         TEXT REFERENCES companies(cik),
    name        TEXT,            -- e.g. "Dojo"
    note        TEXT,            -- what it is + why it matters
    rank        INT,             -- display order
    source      TEXT,            -- 'llm:10-K' | 'seed'
    PRIMARY KEY (cik, name)
);

-- Investor/manager context registry (NOT keyed to a company — global lookup).
CREATE TABLE IF NOT EXISTS entities (
    match_key   TEXT PRIMARY KEY,  -- lowercase substring that identifies the filer
    kind        TEXT,              -- 'index' | 'active' | 'bank' | 'activist' | 'value'
    note        TEXT,
    source      TEXT,              -- 'seed' | 'llm'
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

RLS: anon `SELECT` only on all three (same pattern as `companies`); writes via service_role.

## 4. Data sources & population strategy

Ranked by data quality and cost. Implement in this order.

### 4a. Industry/sector — from real SEC data (no extra API cost)
`companies.sector`/`industry` are currently **never populated**. edgartools' `Company`
object already exposes `.sic` / `.sic_description` (and is already constructed during
`data_ingest.ingest_fundamentals`). Map SIC → (sector, industry) with a small static
SIC-group table and write to `company_profiles` with `source='sic'`. This alone makes the
"category industry" feature data-driven for *any* company, not just the curated 7.

### 4b. Themes + thesis — keyword extraction from the 10-K, cached
The strategic narrative is qualitative and not in structured XBRL. There is **no LLM in
this project** (the Gemini channel was removed), so themes come from a deterministic
keyword/taxonomy pass:

- Input: the **Item 1 "Business"** section of the latest 10-K (already retrievable via
  edgartools).
- Output: `{ themes: [{name, note, rank}] }` matched against the curated taxonomy.
- **Cost control:** run **only when a new 10-K appears** (annual cadence), and **only if
  the company has no profile for that fiscal year**. Cache in the tables; never recompute
  on every pipeline run.
- Floor: the curated seed (§4d) covers anything the keyword pass misses.

### 4c. Entity context — seed list, extended by hand
- Seed the `entities` table from the current `lib/entities.ts` registry (one-time port to
  a YAML/JSON seed in the repo).
- Manager/filer names seen in `institutional_holdings` / `beneficial_ownership` that match
  no seed entry fall back to the raw name; add the notable ones to the seed as they show
  up. Distinct managers across the watchlist is a few hundred at most.

### 4d. Seeds as the floor
Port the existing curated `taxonomy.ts` / `entities.ts` content into repo seed files
(`backend/seeds/profiles.yaml`, `backend/seeds/entities.yaml`). A `seed_reference.py`
loads them with `source='seed'`. Extracted/SIC results overwrite seeds only when present, so we
never regress below today's hand-curated quality.

## 5. New backend modules & wiring

```
backend/
  reference_ingest.py     # NEW — populates company_profiles + company_themes
  entity_ingest.py        # NEW — seeds the entities registry
  seeds/
    profiles.yaml         # NEW — ported from taxonomy.ts (floor quality)
    entities.yaml         # NEW — ported from entities.ts
  scripts/
    export_reference.py   # NEW — dumps the 3 tables → frontend static JSON (§7)
```

Wire into `main.py.process()` using the existing optional-extractor pattern
(`_run_optional`), so it degrades gracefully and never breaks the live slices:

```python
db.upsert_company({...})                              # existing
data_ingest.ingest_fundamentals(cik, ticker)          # existing
filings_ingest.ingest_filings_feed(cik, ticker, name) # existing
_run_optional(reference_ingest, "ingest_profile", cik, ticker)   # NEW (SIC always; themes only on new 10-K)
...
# Entities run once at end of main(), not per-company:
_run_optional(entity_ingest, "ingest_entities")       # NEW
```

All writes go through `db.upsert_many(..., on_conflict=...)` — reuse the existing dedupe
helper. New `db.py` helpers: `upsert_profile`, `upsert_themes`, `upsert_entities` (thin
wrappers like `upsert_company`).

## 6. Frontend changes (keep reads cheap)

- New `frontend/lib/reference.ts`: `fetchReference()` does **one** `SELECT *` on each of
  `entities` and (only when a company page opens) `company_profiles`/`company_themes` for
  that single CIK. Cache the `entities` table in a module-level promise so it loads **once
  per session**.
- Refactor `taxonomy.ts` / `entities.ts` into **thin adapters**: same exported function
  signatures (`profileFor`, `entityContext`) so **no component changes are required** —
  they read from the loaded reference data, falling back to the embedded seed if the fetch
  is empty/unavailable. The current static maps become the offline fallback.
- `entityContext()` stays a **client-side substring match** over the once-loaded `entities`
  rows — identical behavior to today, just data-sourced.

## 7. Recommended: build-time static export (zero runtime reads)

Because this data is slowly-changing, the cleanest way to honor the Supabase budget is to
**not read it at runtime at all**:

- `scripts/export_reference.py` runs in CI / the GitHub Action after ingest and writes
  `frontend/public/reference.json` (or a generated `lib/reference.generated.ts`).
- The frontend imports that artifact statically — **zero** Supabase requests for context,
  identical to today's cost profile, but now backend-generated and scalable.
- Net effect: curation moves to the backend; the runtime read budget is unchanged.

This is the preferred end state; §6's fetch-once path is the fallback if a build step
isn't wired yet.

## 8. Rate/limit budget

| Operation | Frequency | Supabase cost |
|---|---|---|
| Profile/theme writes | ~7/year (new 10-Ks) + seed backfill once | negligible |
| Entity writes | once (seed) + rare unknown backfill | negligible |
| Frontend reads (§7 export) | **0** at runtime | **none** |
| Frontend reads (§6 fallback) | 1× `entities` per session + 1× profile per company open | tiny, capped |

No table grows unbounded; no per-row joins; no per-render queries.

## 9. Phasing & acceptance

- **Phase A — DONE:** SIC → `company_profiles.sector/industry`; seeds ported to
  `seeds/profiles.yaml` + `seeds/entities.yaml`; `reference_ingest.py` + `entity_ingest.py`
  wired into `main.py`; `db.py` helpers added; schema tables added. Frontend: `data.ts`
  fetchers, `taxonomy.ts`/`entities.ts` refactored to adapters that prefer the warehouse and
  fall back to embedded seeds; reference data fetched **once** in the app's initial load and
  matched client-side. Net new Supabase reads per session: **3** (profiles, themes, entities),
  none per-row or per-page.
- **Phase B:** keyword/taxonomy theme extraction from 10-K, cached & gated on new filings.
- **Phase C:** build-time static export (§7); remove runtime reference reads.

## 10. Risks / notes

- **Invariant:** no LLM/third-party AI service is in this project — theme extraction is a
  local keyword/taxonomy pass over the Business section, and no filing text leaves the
  pipeline.
- **No regression below seeds:** extracted/SIC values overwrite seed rows only when they
  produce a value.
- **SIC is coarse** (e.g. all of Apple/Microsoft land in broad tech SICs); the curated
  `industry` and themes add the nuance SIC lacks. Keep both.
- Frontend keeps the embedded seed as a hard fallback so an empty/unreachable warehouse
  never blanks the UI.
