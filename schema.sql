-- Summa — Phase 1 Data Warehouse Schema
-- Run once in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- Architecture (README Part A): one structured table per price-relevant SEC
-- dataset, sourced via edgartools. Only `filings` narrative text rolls off at
-- 30 days; every structured table is retained permanently.
--
-- Security model: the scraper writes with the service_role key (bypasses RLS).
-- The browser reads with the anon key, which gets SELECT-only on every table.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- companies — watchlist metadata. Drives the sidebar list + identity headers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
    cik          TEXT PRIMARY KEY,          -- zero-padded 10-digit CIK
    ticker       TEXT,
    name         TEXT,
    sector       TEXT,
    industry     TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- financial_facts — tidy (long) XBRL fundamentals. One row per line item per
-- period. The frontend pivots line-item × period into the statement table.
-- Source: edgartools XBRLS stitched statements (to_dataframe → melt).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_facts (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    statement         TEXT        NOT NULL,   -- 'income' | 'balance' | 'cashflow'
    label             TEXT        NOT NULL,   -- human label, e.g. 'Net sales'
    concept           TEXT        NOT NULL,   -- e.g. 'us-gaap_RevenueFrom...'
    standard_concept  TEXT,                   -- normalized, e.g. 'Revenue'
    period_end        DATE        NOT NULL,
    period_type       TEXT        NOT NULL,   -- 'annual' | 'quarterly'
    fiscal_year       INT,
    value             DOUBLE PRECISION,
    unit              TEXT        DEFAULT 'USD',
    display_order     INT,                    -- row order within the statement
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (cik, statement, concept, period_end, period_type)
);
CREATE INDEX IF NOT EXISTS idx_ff_cik              ON financial_facts (cik);
CREATE INDEX IF NOT EXISTS idx_ff_cik_stmt_ptype   ON financial_facts (cik, statement, period_type);
CREATE INDEX IF NOT EXISTS idx_ff_period           ON financial_facts (period_end DESC);

-- ---------------------------------------------------------------------------
-- insider_transactions — Form 4 reported trades. Ownership tab net-flow chart.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insider_transactions (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,   -- subject company CIK
    ticker            TEXT,
    accession_number  TEXT        NOT NULL,
    filer_name        TEXT,
    filer_title       TEXT,
    transaction_date  DATE,
    transaction_code  TEXT,                   -- P, S, A, M, F, G ...
    acquired_disposed TEXT,                   -- 'A' | 'D'
    shares            DOUBLE PRECISION,
    price             DOUBLE PRECISION,
    value             DOUBLE PRECISION,       -- shares * price
    shares_after      DOUBLE PRECISION,
    is_10b5_1         BOOLEAN     DEFAULT FALSE,
    filing_url        TEXT,
    filed_at          TIMESTAMPTZ,
    UNIQUE (accession_number, filer_name, transaction_date, transaction_code, shares)
);
CREATE INDEX IF NOT EXISTS idx_insider_cik         ON insider_transactions (cik, transaction_date DESC);

-- ---------------------------------------------------------------------------
-- institutional_holdings — 13F-HR positions. The literal 13f.info surface.
-- One row per (subject company, manager, quarter).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institutional_holdings (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,   -- subject company CIK
    ticker            TEXT,
    period_of_report  DATE        NOT NULL,   -- 13F quarter end
    manager_name      TEXT        NOT NULL,
    manager_cik       TEXT,
    accession_number  TEXT,
    shares            DOUBLE PRECISION,
    value             DOUBLE PRECISION,       -- USD position value
    pct_of_portfolio  DOUBLE PRECISION,       -- this name as % of manager's 13F
    filed_at          TIMESTAMPTZ,
    UNIQUE (cik, period_of_report, manager_name)
);
CREATE INDEX IF NOT EXISTS idx_inst_cik_period     ON institutional_holdings (cik, period_of_report DESC);

-- ---------------------------------------------------------------------------
-- beneficial_ownership — SC 13D / 13G stakes ≥5%. Activist timeline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beneficial_ownership (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    accession_number  TEXT        NOT NULL UNIQUE,
    filer_name        TEXT,
    schedule          TEXT,                   -- 'SC 13D' | 'SC 13G'
    is_activist       BOOLEAN     DEFAULT FALSE,  -- 13D ⇒ activist intent
    pct_of_class      DOUBLE PRECISION,
    shares            DOUBLE PRECISION,
    purpose_excerpt   TEXT,                   -- Item 4 purpose excerpt (≤2000 chars)
    filed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_beneficial_cik      ON beneficial_ownership (cik, filed_at DESC);

-- ---------------------------------------------------------------------------
-- proposed_sales — Form 144 proposed insider sales. Forward markers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proposed_sales (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    accession_number  TEXT        NOT NULL UNIQUE,
    seller_name       TEXT,
    relationship      TEXT,
    shares            DOUBLE PRECISION,
    approx_value      DOUBLE PRECISION,
    approx_date       DATE,
    filed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_proposed_cik        ON proposed_sales (cik, filed_at DESC);

-- ---------------------------------------------------------------------------
-- earnings_events — 8-K Item 2.02 + EX-99.1. Guidance trajectory.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS earnings_events (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    accession_number  TEXT        NOT NULL UNIQUE,
    period            DATE,                   -- fiscal period reported
    reported_date     DATE,
    revenue           DOUBLE PRECISION,
    diluted_eps       DOUBLE PRECISION,
    net_income        DOUBLE PRECISION,
    guidance_action   TEXT,                   -- 'raised'|'lowered'|'maintained'|'withdrawn'|null
    guidance_low      DOUBLE PRECISION,
    guidance_high     DOUBLE PRECISION,
    filed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_earnings_cik        ON earnings_events (cik, reported_date DESC);

-- ---------------------------------------------------------------------------
-- corporate_events — material 8-K items. Catalyst timeline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corporate_events (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    accession_number  TEXT        NOT NULL,
    event_date        DATE,
    item_code         TEXT,                   -- '1.01', '5.02', '2.02' ...
    event_class       TEXT,                   -- 'M&A'|'dilution'|'restatement'|'cyber'|'capital_return'|'exec_change'|'other'
    summary           TEXT,
    filed_at          TIMESTAMPTZ,
    UNIQUE (accession_number, item_code)
);
CREATE INDEX IF NOT EXISTS idx_corp_events_cik     ON corporate_events (cik, event_date DESC);

-- ---------------------------------------------------------------------------
-- late_filings — NT 10-K / NT 10-Q notifications. Red flags.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS late_filings (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    accession_number  TEXT        NOT NULL UNIQUE,
    nt_form           TEXT,                   -- 'NT 10-K' | 'NT 10-Q'
    subject_form      TEXT,                   -- '10-K' | '10-Q'
    period            DATE,
    reason_excerpt    TEXT,
    filed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_late_cik            ON late_filings (cik, filed_at DESC);

-- ---------------------------------------------------------------------------
-- securities_offerings — S-3 / 424B dilution events.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS securities_offerings (
    id                BIGSERIAL PRIMARY KEY,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    accession_number  TEXT        NOT NULL UNIQUE,
    form              TEXT,                   -- 'S-3' | '424B5' ...
    offering_type     TEXT,                   -- 'shelf'|'secondary'|'ATM'|'convertible'|'other'
    amount            DOUBLE PRECISION,       -- USD
    shares            DOUBLE PRECISION,
    filed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_offerings_cik       ON securities_offerings (cik, filed_at DESC);

-- ---------------------------------------------------------------------------
-- filings — narrative filings feed. Text sections roll off at 30 days
-- (cleanup.py); the metadata row is retained. Realtime feed reads this.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filings (
    id                BIGSERIAL PRIMARY KEY,
    accession_number  TEXT        NOT NULL UNIQUE,
    cik               TEXT        NOT NULL,
    ticker            TEXT,
    company_name      TEXT,
    form_type         TEXT        NOT NULL,
    filed_at          TIMESTAMPTZ,
    period_of_report  DATE,
    filing_url        TEXT,
    -- Cleaned narrative sections (≤8000 chars each; raw HTML never stored).
    -- Rolled off at 30 days by cleanup.py.
    section_business        TEXT,
    section_risk_factors    TEXT,
    section_mda             TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_filings_cik         ON filings (cik);
CREATE INDEX IF NOT EXISTS idx_filings_form        ON filings (form_type);
CREATE INDEX IF NOT EXISTS idx_filings_filed_at    ON filings (filed_at DESC);

-- ===========================================================================
-- Row Level Security — anon gets SELECT-only on every table; service_role
-- (scraper) bypasses RLS entirely. Idempotent.
-- ===========================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'companies','financial_facts','insider_transactions','institutional_holdings',
        'beneficial_ownership','proposed_sales','earnings_events','corporate_events',
        'late_filings','securities_offerings','filings'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
        EXECUTE format('GRANT SELECT ON %I TO anon', t);
        EXECUTE format('DROP POLICY IF EXISTS "anon read %1$s" ON %1$I', t);
        EXECUTE format('CREATE POLICY "anon read %1$s" ON %1$I FOR SELECT TO anon USING (true)', t);
    END LOOP;
END $$;
