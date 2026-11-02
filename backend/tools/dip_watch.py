#!/usr/bin/env python3
"""Dip watch → Discord + reddit_trends (summa-dips.yml).

Thin entry point around ingest.dip_watch: prices every ticker on the recent
Reddit trending board (any sector) plus the curated Fortune-500 tech list,
flags anything that closed down hard, reads how Reddit is reacting to each and
connects them (industry clusters, sector moves), posts one Discord embed, and
writes the closing prices + a dip flag back onto that day's reddit_trends rows.
Edgar-free (db + stdlib HTTP only), so the workflow installs just
requirements-news.txt. Posts to DISCORD_DIPS_WEBHOOK_URL, falling back to
DISCORD_WEBHOOK_URL; a silent no-op on the Discord side when neither is set.
--dry-run logs the dips and connections without posting or writing.

Run:  python -m tools.dip_watch [--dry-run]
"""

import logging
import sys

from dotenv import load_dotenv

load_dotenv()

from ingest import dip_watch  # noqa: E402  (needs env loaded first)

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
logger = logging.getLogger("summa.dips")


def main() -> int:
    """Run the dip scan once."""
    dry = "--dry-run" in sys.argv[1:]
    n = dip_watch.scan_dips(dry_run=dry)
    logger.info("dip watch: %d dip(s)%s", n, " (dry run — not posted)" if dry else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
