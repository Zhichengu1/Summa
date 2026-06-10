#!/usr/bin/env python3
"""One-shot backfill of recent 13F quarters for the Institutional Investors view.

The live pipeline (main.py) rolls the latest-vs-prior comparison forward on its
own: after each 13F deadline (Feb/May/Aug/Nov 15) it ingests the newly-filed
quarter and diffs it against the prior one — the new quarter becomes "current",
the previous one "prior". But that comparison needs TWO quarters on file, so on a
fresh warehouse — or right after new managers are added to the curated list — there
is only one quarter and every investor shows "first 13F on file". This tool seeds
the prior quarter(s) so the comparison works immediately, with no behavioural fork:
it reuses the same fetch + buy/sell classification as the live pass, just over
historical filing quarters.

Run from backend/ as a module (so `import db` resolves):
    python -m tools.backfill_manager_quarters              # last 2 filing quarters
    python -m tools.backfill_manager_quarters --quarters 4 # deeper history
"""

import argparse
import logging
import os
import sys

from dotenv import load_dotenv
from edgar import set_identity

from extractors import institutional_extractor

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
logger = logging.getLogger("summa.backfill")

# SEC fair-access requires a descriptive User-Agent; mirror main.py's default.
set_identity(os.environ.get("EDGAR_IDENTITY", "Summa/1.0 (contact@example.com)"))


def main() -> int:
    """Backfill recent 13F filing quarters into manager_portfolios with diffs."""
    ap = argparse.ArgumentParser(
        description="Backfill recent 13F quarters for the Institutional Investors comparison.",
    )
    ap.add_argument(
        "--quarters", type=int, default=2,
        help="how many recent filing quarters to load, newest back (default 2)",
    )
    args = ap.parse_args()

    logger.info("Backfilling the last %d 13F filing quarter(s)…", args.quarters)
    written = institutional_extractor.backfill_quarters(args.quarters)
    logger.info("Backfill complete: %d manager_portfolios rows written", written)
    return 0 if written else 1


if __name__ == "__main__":
    raise SystemExit(main())
