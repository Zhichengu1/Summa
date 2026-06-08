#!/usr/bin/env python3
"""Monthly maintenance — rolls narrative filing text off at 30 days.

Per the Phase 1 retention split: every structured warehouse table is retained
permanently; only the bulky narrative sections on `filings` roll off. The
filing metadata row (form, date, url) is kept. Runs on the 1st via
summa-cleanup.yml. (Gemini reports / digests are Phase 2.)
"""

import logging
import sys

from dotenv import load_dotenv

import db

load_dotenv()

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

FEED_RETENTION_DAYS = 90    # feed rows are deleted past 3 months
PRICE_RETENTION_DAYS = 760  # daily_prices kept ~2y (matches the price_ingest pull)

# Note: the current ingest stores only filing metadata in `filings` (no narrative
# section text), and feed rows are deleted wholesale at FEED_RETENTION_DAYS, so
# the old 30-day section roll-off is obsolete. db.clear_old_filing_sections()
# remains available if section storage is reintroduced in a later phase.


def run_cleanup() -> None:
    """Prune the two time-growing tables: the filings feed and daily_prices.

    Everything else (fundamentals, holdings, events, summaries) is small or
    bounded per company and retained. `daily_prices` is the only structured table
    that grows unbounded with time, so it gets its own retention window.
    """
    deleted = db.delete_old_filings(FEED_RETENTION_DAYS)
    logger.info("Deleted %d feed filings older than %d days (3-month window)",
                deleted, FEED_RETENTION_DAYS)

    pruned = db.prune_old_prices(PRICE_RETENTION_DAYS)
    logger.info("Pruned %d daily_prices bars older than %d days (~2-year window)",
                pruned, PRICE_RETENTION_DAYS)


if __name__ == "__main__":
    run_cleanup()
