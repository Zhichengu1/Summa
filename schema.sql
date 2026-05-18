-- Summa Database Schema
-- Run once in the Supabase SQL Editor to initialize the project.
-- pgvector is required for the embedding column; it is pre-installed on Supabase.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- filings
-- One row per processed SEC filing. This is the primary data store.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filings (
    id                      BIGSERIAL PRIMARY KEY,
    accession_number        TEXT        NOT NULL UNIQUE,  -- EDGAR unique ID, used for deduplication
    cik                     TEXT        NOT NULL,
    ticker                  TEXT,
    company_name            TEXT,
    form_type               TEXT        NOT NULL,         -- '10-K', '10-Q', '8-K', 'DEF 14A'
    filed_at                TIMESTAMPTZ,                  -- timestamp from EDGAR feed
    period_of_report        DATE,                         -- fiscal period end date
    filing_url              TEXT,

    -- Cleaned extracted text sections (each capped at 8,000 characters; raw HTML never stored)
    section_mda             TEXT,
    section_risk_factors    TEXT,
    section_item_1          TEXT,

    -- Stage 1 signal scores — each JSONB holds {score: float, excerpt: str}
    signal_supply_chain     JSONB,
    signal_geopolitical     JSONB,
    signal_mgmt_changes     JSONB,
    signal_earnings         JSONB,

    -- Derived signals
    uli_score               FLOAT,       -- Uncertainty Language Index (ratio of hedge words in MD&A)
    risk_factor_delta       FLOAT,       -- difflib similarity delta vs prior 10-K risk factors
    filing_velocity_days    INT,         -- calendar days between period_of_report and filed_at
    filing_velocity_flag    BOOLEAN DEFAULT FALSE,  -- true when significantly later than historical median
    friday_dump             BOOLEAN DEFAULT FALSE,  -- true when filed Friday after 15:30 ET
    boilerplate_erosion     FLOAT,       -- sequence similarity vs prior filing; low = major rewrite
    section_length_anomaly  BOOLEAN DEFAULT FALSE,  -- true when risk factors section expanded anomalously
    numeric_claims          JSONB,       -- structured dollar amounts, percentages, EPS from MD&A
    burst_8k_count          INT,         -- 8-K filings from this company in the past 30 days
    burst_8k_flag           BOOLEAN DEFAULT FALSE,

    -- Gate: true if Stage 1 flagged at least one signal; controls whether Gemini runs
    signals_flagged         BOOLEAN DEFAULT FALSE,

    -- Stage 2 — Gemini enrichment (populated only when signals_flagged = true)
    gemini_summary          TEXT,
    gemini_confidence       FLOAT,
    gemini_ran              BOOLEAN DEFAULT FALSE,

    -- Reserved for Phase 3 semantic search — null until pgvector embedding phase is implemented
    embedding               vector(768),

    created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- company_meta
-- One row per company. Rolling historical statistics updated on each new filing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_meta (
    cik                         TEXT PRIMARY KEY,
    ticker                      TEXT,
    company_name                TEXT,
    sector                      TEXT,            -- GICS sector; reserved for Phase 3 sector alerts

    -- Historical baselines updated on each qualifying filing
    median_velocity_days        FLOAT,           -- median days from period end to filing date
    avg_risk_factor_length      FLOAT,           -- average character length of risk factors section
    avg_mda_length              FLOAT,           -- average character length of MD&A section

    -- Prior-period text used by Stage 1 delta algorithms
    prior_risk_factors_text     TEXT,            -- most recent 10-K risk factors for delta comparison
    prior_boilerplate_text      TEXT,            -- most recent filing text for erosion comparison

    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- filing_events
-- One row per 8-K. Used exclusively for burst detection queries.
-- Kept separate to avoid consuming Upstash Redis quota for count operations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filing_events (
    id                  BIGSERIAL PRIMARY KEY,
    cik                 TEXT        NOT NULL,
    form_type           TEXT        NOT NULL DEFAULT '8-K',
    accession_number    TEXT        NOT NULL,
    filed_at            TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Security — Row Level Security + Column-level grants
--
-- Three roles, three distinct privilege levels:
--
--   anon          Browser / frontend. Driven by NEXT_PUBLIC_SUPABASE_ANON_KEY
--                 (intentionally public — safe because it has no write access and
--                 column grants restrict what it can read).
--                 Access: SELECT on specific columns of filings + company_meta only.
--
--   authenticated Supabase Auth users. Not used in this project.
--                 Access: none (RLS default-deny + REVOKE below covers this).
--
--   service_role  Scraper / GitHub Actions. Driven by SUPABASE_KEY (secret, never
--                 in frontend code). Bypasses RLS entirely — full access to all tables.
--
-- Defense-in-depth layers:
--   1. RLS ENABLED on all tables (default-deny when no matching policy exists)
--   2. Supabase auto-grants REVOKED from anon + authenticated
--   3. Column-level GRANTs limit what the anon key can actually read
--   4. Only SELECT permitted for anon — zero INSERT / UPDATE / DELETE policies
-- ---------------------------------------------------------------------------

ALTER TABLE filings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_meta  ENABLE ROW LEVEL SECURITY;
ALTER TABLE filing_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Layer 2: Revoke the broad grants Supabase applies at project creation.
--
-- At setup Supabase runs:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
--     TO anon, authenticated;
-- Those grants must be explicitly revoked before column-level grants take effect.
-- This block is idempotent — revoking a privilege that doesn't exist is a no-op.
-- ---------------------------------------------------------------------------
REVOKE ALL ON filings       FROM anon, authenticated;
REVOKE ALL ON company_meta  FROM anon, authenticated;
REVOKE ALL ON filing_events FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Layer 3 + 4: filings — anon gets column-restricted SELECT only.
--
-- Exposed to anon (the 12 columns the frontend dashboard reads):
--   id, accession_number, cik, ticker, company_name, form_type,
--   filed_at, period_of_report, filing_url, friday_dump, signals_flagged, created_at
--
-- Blocked from anon (sensitive / internal columns):
--   section_mda, section_risk_factors, section_item_1   — raw extracted text
--   signal_supply_chain, signal_geopolitical,            — proprietary signal scores
--   signal_mgmt_changes, signal_earnings
--   uli_score, risk_factor_delta, filing_velocity_days,  — derived signal values
--   filing_velocity_flag, boilerplate_erosion,
--   section_length_anomaly, numeric_claims,
--   burst_8k_count, burst_8k_flag
--   gemini_summary, gemini_confidence, gemini_ran        — AI enrichment output
--   embedding                                            — vector(768), Phase 3
-- ---------------------------------------------------------------------------
GRANT SELECT (
    id, accession_number, cik, ticker, company_name,
    form_type, filed_at, period_of_report, filing_url,
    friday_dump, signals_flagged, created_at
) ON filings TO anon;

-- Clean up any old policy names before creating the canonical one.
DROP POLICY IF EXISTS "anon read filings"        ON filings;
DROP POLICY IF EXISTS "anon can read filings"    ON filings;
DROP POLICY IF EXISTS "anon can insert filings"  ON filings;
DROP POLICY IF EXISTS "anon can update filings"  ON filings;
DROP POLICY IF EXISTS "anon can delete filings"  ON filings;

CREATE POLICY "anon read filings"
    ON filings FOR SELECT TO anon USING (true);

-- ---------------------------------------------------------------------------
-- company_meta — anon gets column-restricted SELECT only.
--
-- Exposed to anon (display columns for the frontend company list):
--   cik, ticker, company_name, sector, updated_at
--
-- Blocked from anon (internal baseline data used only by the scraper):
--   median_velocity_days, avg_risk_factor_length, avg_mda_length
--   prior_risk_factors_text, prior_boilerplate_text
-- ---------------------------------------------------------------------------
GRANT SELECT (
    cik, ticker, company_name, sector, updated_at
) ON company_meta TO anon;

DROP POLICY IF EXISTS "anon read company_meta"        ON company_meta;
DROP POLICY IF EXISTS "anon can read company_meta"    ON company_meta;
DROP POLICY IF EXISTS "anon can insert company_meta"  ON company_meta;
DROP POLICY IF EXISTS "anon can update company_meta"  ON company_meta;
DROP POLICY IF EXISTS "anon can delete company_meta"  ON company_meta;

CREATE POLICY "anon read company_meta"
    ON company_meta FOR SELECT TO anon USING (true);

-- ---------------------------------------------------------------------------
-- filing_events — no anon or authenticated access, ever.
--
-- No policies defined = RLS default-deny.
-- Scraper accesses via service_role which bypasses RLS entirely.
-- Drop any old policies that may exist from previous schema versions.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "anon can insert filing_events" ON filing_events;
DROP POLICY IF EXISTS "anon can read filing_events"   ON filing_events;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- filings: primary access patterns
CREATE INDEX IF NOT EXISTS idx_filings_cik          ON filings (cik);
CREATE INDEX IF NOT EXISTS idx_filings_form_type    ON filings (form_type);
CREATE INDEX IF NOT EXISTS idx_filings_filed_at     ON filings (filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_filings_flagged      ON filings (signals_flagged) WHERE signals_flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_filings_cik_form     ON filings (cik, form_type);

-- filing_events: burst detection query is always (cik, filed_at >= now() - interval '30 days')
CREATE INDEX IF NOT EXISTS idx_filing_events_cik_filed ON filing_events (cik, filed_at DESC);
