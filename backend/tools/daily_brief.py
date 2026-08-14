#!/usr/bin/env python3
"""Daily watchlist market brief → Discord (summa-brief.yml, weekday mornings).

Reads the precomputed `company_summary` table (one tiny row per company — the
same precompute powering the Overview table and Momentum Scanner) and posts ONE
Discord embed: top gainers/decliners, new 52-week highs/lows, golden/death
crosses, volume spikes, and the largest insider flows. Zero EDGAR/Google load,
one paged Supabase read — free at any watchlist size.

Edgar-free by design (db + discord_notify only), so the workflow installs just
requirements-news.txt. A silent no-op when DISCORD_WEBHOOK_URL is unset.

Run:  python -m tools.daily_brief
"""

import logging
import sys
from typing import Any

from dotenv import load_dotenv

load_dotenv()

import db  # noqa: E402  (needs env loaded first)
import recap  # noqa: E402  (shared earnings-estimate helpers)
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
logger = logging.getLogger("summa.brief")


def _earnings_radar() -> list[dict[str, Any]]:
    """Watchlist companies estimated to report within the radar window.

    The estimate itself lives in `recap.py` so the brief and the evening recap
    can never drift apart on which companies are "about to report".
    """
    return recap.earnings_radar(db.fetch_earnings_dates())


def main() -> int:
    """Build and post the daily watchlist brief from company_summary."""
    rows = db.fetch_company_summaries()
    if not rows:
        logger.warning("no company_summary rows — brief skipped (precompute not populated yet)")
        return 0
    radar = _earnings_radar()
    if radar:
        logger.info("earnings radar: %s", ", ".join(f"{r['ticker']}~{r['est_date']}" for r in radar))
    posted = discord_notify.notify_daily_brief(rows, upcoming_earnings=radar)
    logger.info("daily brief: %d companies, %s", len(rows),
                "posted to Discord" if posted else "not posted (no webhook or nothing brief-worthy)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
