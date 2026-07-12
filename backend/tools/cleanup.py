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
MANAGER_KEEP_QUARTERS = 4   # manager_portfolios kept to the latest 4 13F filing quarters
IPO_RETENTION_DAYS = 120    # ipos pipeline rows pruned past ~4 months of inactivity
NEWS_RETENTION_DAYS = 30    # company_news headlines pruned past a rolling 30-day window
MARKET_NEWS_RETENTION_DAYS = 30  # market_news (Top Intelligence) pruned past a rolling 30-day window
REDDIT_RETENTION_DAYS = 30  # reddit_trends daily snapshots pruned past a rolling 30-day window
CONGRESS_RETENTION_DAYS = 400  # congress_trades kept ~13 months of consensus history
COT_RETENTION_DAYS = 1200   # cot_reports kept ~3.3y (full 156-week COT-index lookback + margin)

# Note: the current ingest stores only filing metadata in `filings` (no narrative
# section text), and feed rows are deleted wholesale at FEED_RETENTION_DAYS, so
# the old 30-day section roll-off is obsolete. db.clear_old_filing_sections()
# remains available if section storage is reintroduced in a later phase.


def run_cleanup() -> None:
    """Prune the time-growing tables: the filings feed, daily_prices, and
    manager_portfolios.

    Everything else (fundamentals, holdings, events, summaries) is small or
    bounded per company and retained. `daily_prices` grows unbounded with time, so
    it gets a rolling ~2-year window; `manager_portfolios` grows one 13F quarter per
    cycle, so it is bounded to the latest few filing quarters the Investors view reads.
    """
    deleted = db.delete_old_filings(FEED_RETENTION_DAYS)
    logger.info("Deleted %d feed filings older than %d days (3-month window)",
                deleted, FEED_RETENTION_DAYS)

    pruned = db.prune_old_prices(PRICE_RETENTION_DAYS)
    logger.info("Pruned %d daily_prices bars older than %d days (~2-year window)",
                pruned, PRICE_RETENTION_DAYS)

    mgr_pruned = db.prune_manager_portfolios(MANAGER_KEEP_QUARTERS)
    logger.info("Pruned %d manager_portfolios rows beyond the latest %d filing quarters",
                mgr_pruned, MANAGER_KEEP_QUARTERS)

    ipo_pruned = db.prune_old_ipos(IPO_RETENTION_DAYS)
    logger.info("Pruned %d ipos rows older than %d days", ipo_pruned, IPO_RETENTION_DAYS)

    news_pruned = db.prune_old_news(NEWS_RETENTION_DAYS)
    logger.info("Pruned %d company_news rows older than %d days", news_pruned, NEWS_RETENTION_DAYS)

    mkt_pruned = db.prune_old_market_news(MARKET_NEWS_RETENTION_DAYS)
    logger.info("Pruned %d market_news rows older than %d days", mkt_pruned, MARKET_NEWS_RETENTION_DAYS)

    reddit_pruned = db.prune_old_reddit_trends(REDDIT_RETENTION_DAYS)
    logger.info("Pruned %d reddit_trends rows older than %d days", reddit_pruned, REDDIT_RETENTION_DAYS)

    congress_pruned = db.prune_old_congress_trades(CONGRESS_RETENTION_DAYS)
    logger.info("Pruned %d congress_trades rows older than %d days", congress_pruned, CONGRESS_RETENTION_DAYS)

    cot_pruned = db.prune_old_cot_reports(COT_RETENTION_DAYS)
    logger.info("Pruned %d cot_reports rows older than %d days", cot_pruned, COT_RETENTION_DAYS)


if __name__ == "__main__":
    run_cleanup()
