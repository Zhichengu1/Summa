"""SEC-form extractors (8-K events, Form 4 insider, 13F-HR institutional,
SC 13D/13G + Form 144 ownership). Each exposes ingest_<dataset>(cik, ticker) and
is run best-effort from main.py via _run_optional()."""
