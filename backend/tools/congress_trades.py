#!/usr/bin/env python3
"""Congressional trade disclosures → `congress_trades` (summa-congress.yml).

Thin entry point around ingest.congress_trades_ingest: pulls the free keyless
JSON behind Kadoa's open-source Congress Trading Monitor (normalized House PTR +
Senate eFD + executive-branch STOCK-Act disclosures, refreshed daily) and
upserts every tickered transaction. Idempotent — rows are keyed on the source's
stable per-transaction id. Each run posts a Discord digest of the genuinely-NEW
disclosures + the current consensus buys/sells (silent no-op when neither
DISCORD_CONGRESS_WEBHOOK_URL nor DISCORD_WEBHOOK_URL is set, and quiet when
nothing is new). Pass --force (or CONGRESS_FORCE_DIGEST=1) to post the latest
state even without a new delta — for manual runs that should always be visible.
Zero EDGAR load and edgar-free by design (db + stdlib HTTP only), so the
workflow installs just requirements-news.txt.

Run:  python -m tools.congress_trades [--force]
"""

import logging
import os
import sys

from dotenv import load_dotenv

load_dotenv()

from ingest import congress_trades_ingest  # noqa: E402  (needs env loaded first)

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
logger = logging.getLogger("summa.congress")


def main() -> int:
    """Run the global congress-trades pass once."""
    force = "--force" in sys.argv[1:] or os.environ.get("CONGRESS_FORCE_DIGEST") == "1"
    written = congress_trades_ingest.ingest_congress_trades_global(force_digest=force)
    logger.info("congress trades: %d rows upserted%s", written,
                " (digest forced)" if force else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
