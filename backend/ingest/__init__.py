"""Per-company dataset ingestors (fundamentals, filings feed, prices, summary,
reference data, entities). Each exposes ingest_<dataset>(cik, ticker[, name]) and
is wired into the orchestrator in main.py via _run_optional()."""
