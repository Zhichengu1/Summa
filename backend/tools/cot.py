#!/usr/bin/env python3
"""CFTC Commitments of Traders → `cot_reports` (summa-cot.yml).

Thin entry point around ingest.cot_ingest: pulls the free keyless CFTC Public
Reporting API (legacy futures-only report) for a curated set of the most-watched
futures markets and upserts one row per market per weekly report. Idempotent —
rows are keyed on (market_code, report_date); the first run backfills ~3y of
history so the COT positioning index works immediately, later runs fetch only
the new week. Each run that lands a new report week posts a Discord digest of
the biggest weekly spec-position shifts + crowded-long/short extremes (silent
no-op when neither DISCORD_COT_WEBHOOK_URL nor DISCORD_WEBHOOK_URL is set, and
quiet when no new week arrived). Pass --force (or COT_FORCE_DIGEST=1) to post
the latest state even without a new week — for manual runs that should always
be visible. Zero EDGAR load and edgar-free by design (db + stdlib HTTP only),
so the workflow installs just requirements-news.txt.

Run:  python -m tools.cot [--force]
"""

import logging
import os
import sys

from dotenv import load_dotenv

load_dotenv()

from ingest import cot_ingest  # noqa: E402  (needs env loaded first)

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
logger = logging.getLogger("summa.cot")


def main() -> int:
    """Run the global COT pass once."""
    force = "--force" in sys.argv[1:] or os.environ.get("COT_FORCE_DIGEST") == "1"
    written = cot_ingest.ingest_cot_global(force_digest=force)
    logger.info("cot: %d rows upserted%s", written, " (digest forced)" if force else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
