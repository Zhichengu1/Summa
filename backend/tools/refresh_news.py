#!/usr/bin/env python3
"""Lightweight news-only refresh — the fast path for the summa-news */5 cron.

Runs the RSS news passes WITHOUT importing the heavy SEC stack (edgartools/pandas):
it only needs db + the news ingestors, so the workflow installs just
`requirements-news.txt` (supabase + requests + dotenv) and each run finishes in
seconds. `market_news` (global federal/gov + macro feed) always refreshes; pass
`--company` to also poll per-company Google News.

Run:  python -m tools.refresh_news            # market-wide only (default)
      python -m tools.refresh_news --company  # + per-company Google News
"""

import argparse
import logging
import sys

from dotenv import load_dotenv

from watchlist import get_active_watchlist
from ingest import market_news_ingest, news_ingest

load_dotenv()

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
logger = logging.getLogger("summa.news")


def main() -> int:
    """Refresh market news (always) and, with --company, per-company news."""
    ap = argparse.ArgumentParser(description="Lightweight news refresh")
    ap.add_argument("--company", action="store_true",
                    help="also refresh per-company Google News (heavier: one fetch per watchlist company)")
    args = ap.parse_args()

    if args.company:
        for c in get_active_watchlist():
            try:
                news_ingest.ingest_news(c["cik"], c["ticker"], c["name"])
            except Exception:
                logger.exception("company news failed for %s", c.get("ticker"))

    try:
        market_news_ingest.ingest_market_news_global()
    except Exception:
        logger.exception("market news failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
