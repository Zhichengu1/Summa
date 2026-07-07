#!/usr/bin/env python3
"""Reddit trending-stocks snapshot → `reddit_trends` + Discord (summa-reddit.yml).

Thin entry point around ingest.reddit_trends_ingest: pulls the latest most-
discussed stock tickers from the free ApeWisdom + Tradestie aggregator APIs and
refreshes today's ranked snapshot. The day's first run posts the full Discord
digest (watchlist tickers starred, live prices attached); intraday re-runs stay
quiet unless a ticker newly surges into the top ranks. Pass --force (or set
REDDIT_TRENDS_FORCE_DIGEST=1) to post the full digest even when today's snapshot
already exists — for manual runs that should always be visible. Zero EDGAR load
and edgar-free by design (db + stdlib HTTP only), so the workflow installs just
requirements-news.txt. A silent no-op on the Discord side when neither
DISCORD_REDDIT_WEBHOOK_URL nor DISCORD_WEBHOOK_URL is set.

Run:  python -m tools.reddit_trends [--force]
"""

import logging
import os
import sys

from dotenv import load_dotenv

load_dotenv()

from ingest import reddit_trends_ingest  # noqa: E402  (needs env loaded first)

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
logger = logging.getLogger("summa.reddit")


def main() -> int:
    """Run the global Reddit-trends pass once."""
    force = "--force" in sys.argv[1:] or os.environ.get("REDDIT_TRENDS_FORCE_DIGEST") == "1"
    written = reddit_trends_ingest.ingest_reddit_trends_global(force_digest=force)
    logger.info("reddit trends: %d tickers stored%s", written,
                " (digest forced)" if force else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
