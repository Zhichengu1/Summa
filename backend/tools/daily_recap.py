#!/usr/bin/env python3
"""Daily watchlist recap → Discord (summa-recap.yml, weekday evenings).

Reads the precomputed `company_summary` table (plus sector labels and the
earnings radar) and posts ONE Discord embed containing a plain-English wrap of
the session: breadth, leaders and laggards, sector leadership, 52-week and
moving-average milestones, unusual volume, filing activity, insider flow, and
upcoming estimated earnings.

The prose is assembled deterministically by `recap.py` from stored numbers —
there is no LLM anywhere in this path, so the same rows always produce the same
text and the job costs one paged Supabase read plus one webhook post.

Edgar-free by design (db + recap + discord_notify only), so the workflow
installs just requirements-news.txt. A silent no-op when the webhook is unset.

Run:  python -m tools.daily_recap
      python -m tools.daily_recap --dry-run    # print the recap, post nothing
"""

import logging
import sys

from dotenv import load_dotenv

load_dotenv()

import db  # noqa: E402  (needs env loaded first)
import recap as recap_builder  # noqa: E402
from enrichment import discord_notify  # noqa: E402

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
logger = logging.getLogger("summa.recap")

# db.fetch_profiles_by_ticker issues one `.in_(ticker, ...)` query, so chunk the
# watchlist the same way the other cross-watchlist reads do — a single request
# with thousands of tickers would blow past the URL length limit.
_TICKER_CHUNK = 150


def _sector_map(rows: list[dict]) -> dict[str, tuple[str | None, str | None]]:
    """TICKER -> (sector, industry) for the watchlist, fetched in bounded chunks."""
    tickers = sorted({str(r["ticker"]).upper() for r in rows if r.get("ticker")})
    labels: dict[str, tuple[str | None, str | None]] = {}
    for i in range(0, len(tickers), _TICKER_CHUNK):
        labels.update(db.fetch_profiles_by_ticker(tickers[i : i + _TICKER_CHUNK]))
    return labels


def main(argv: list[str] | None = None) -> int:
    """Build the recap from company_summary and post it to Discord."""
    args = argv if argv is not None else sys.argv[1:]
    dry_run = "--dry-run" in args

    rows = db.fetch_company_summaries()
    if not rows:
        logger.warning("no company_summary rows — recap skipped (precompute not populated yet)")
        return 0

    radar = recap_builder.earnings_radar(db.fetch_earnings_dates())
    story = recap_builder.build_recap(rows, sectors=_sector_map(rows), radar=radar)
    if not story:
        logger.info("recap: %d companies, nothing recap-worthy in the snapshot", len(rows))
        return 0

    logger.info("recap built (%d companies, as_of %s):\n%s",
                story["companies"], story["as_of"] or "unknown",
                recap_builder.render_text(story))
    if dry_run:
        logger.info("--dry-run: not posting to Discord")
        return 0

    posted = discord_notify.notify_daily_recap(story)
    logger.info("recap: %s", "posted to Discord" if posted else "not posted (no webhook configured)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
