#!/usr/bin/env python3
"""Summa Phase 1 ingest orchestrator.

For each watchlist company: refresh metadata, then ingest each dataset. The
fundamentals + filings-feed slices are live; the remaining extractors are
wired in and run best-effort (they no-op until implemented).

Run:  python main.py            # full watchlist
      python main.py AAPL MSFT  # subset by ticker
"""

import logging
import os
import sys

from dotenv import load_dotenv
from edgar import set_identity

import db
import data_ingest
import filings_ingest
from watchlist import WATCHLIST, WatchedCompany

try:
    import insider_extractor
except Exception:  # pragma: no cover
    insider_extractor = None
try:
    import institutional_extractor
except Exception:  # pragma: no cover
    institutional_extractor = None
try:
    import event_extractor
except Exception:  # pragma: no cover
    event_extractor = None
try:
    import ownership_extractor
except Exception:  # pragma: no cover
    ownership_extractor = None

load_dotenv()

# Windows consoles default to cp1252, which can't encode the em-dash / ▶ used
# in log output. Force UTF-8 so local runs don't crash with UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("summa")

set_identity(os.environ.get("EDGAR_IDENTITY", "Summa/1.0 (contact@example.com)"))


def _preflight() -> bool:
    """Verify the warehouse schema is applied before ingesting.

    The new Phase 1 schema (companies, financial_facts, …) must be created by
    running schema.sql in the Supabase SQL Editor. If the `companies` table is
    missing, fail fast with actionable guidance instead of a raw stack trace.
    """
    try:
        db.get_client().table("companies").select("cik").limit(1).execute()
        return True
    except Exception as exc:
        if "companies" in str(exc) or "PGRST205" in str(exc):
            logger.error(
                "Schema not applied: the 'companies' table is missing.\n"
                "  → Open the Supabase SQL Editor and run schema.sql (in the repo root),\n"
                "    then re-run this command. schema.sql is idempotent (safe to re-run)."
            )
            return False
        logger.exception("Preflight check failed")
        return False


def _select(tickers: list[str]) -> list[WatchedCompany]:
    if not tickers:
        return WATCHLIST
    wanted = {t.upper() for t in tickers}
    return [c for c in WATCHLIST if c["ticker"].upper() in wanted]


def _run_optional(module: object, fn: str, *args: object) -> None:
    if module is None or not hasattr(module, fn):
        return
    try:
        getattr(module, fn)(*args)
    except NotImplementedError:
        logger.info("  %s.%s not implemented yet - skipping", getattr(module, "__name__", "?"), fn)
    except Exception:
        logger.exception("  %s.%s failed", getattr(module, "__name__", "?"), fn)


def process(company: WatchedCompany) -> None:
    cik, ticker, name = company["cik"], company["ticker"], company["name"]
    logger.info("> %s (%s)", ticker, cik)

    db.upsert_company({"cik": cik, "ticker": ticker, "name": name})

    # Live slices
    data_ingest.ingest_fundamentals(cik, ticker)
    filings_ingest.ingest_filings_feed(cik, ticker, name)

    # Fully implemented extractors
    _run_optional(insider_extractor,        "ingest_insider",       cik, ticker)
    _run_optional(event_extractor,          "ingest_events",        cik, ticker)
    _run_optional(ownership_extractor,      "ingest_ownership",     cik, ticker)
    # Institutional uses a module-level cache; populated on first company call.
    _run_optional(institutional_extractor,  "ingest_institutional", cik, ticker)


def main() -> int:
    if not _preflight():
        return 2
    companies = _select(sys.argv[1:])
    logger.info("Summa ingest | %d compan%s",
                len(companies), "y" if len(companies) == 1 else "ies")
    ok = 0
    for c in companies:
        try:
            process(c)
            ok += 1
        except Exception:
            logger.exception("Failed for %s", c["ticker"])
    logger.info("Done | %d/%d companies processed", ok, len(companies))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
