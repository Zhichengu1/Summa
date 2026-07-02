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

import datetime as _dt
import logging
import statistics
import sys
from typing import Any

from dotenv import load_dotenv

load_dotenv()

import db  # noqa: E402  (needs env loaded first)
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


# Radar window: companies estimated to report within this many days (a few days
# overdue still shows as "any day now" — estimates drift a little run to run).
_RADAR_AHEAD_DAYS = 10
_RADAR_OVERDUE_DAYS = 5


def _next_earnings_estimate(dates: list[str]) -> tuple[str, int] | None:
    """(est ISO date, days away) from past report dates, or None.

    Python port of frontend lib/domain/catalysts.ts nextEarningsEstimate: needs
    >= 3 dates and a quarterly-ish median gap (45–200 days) so we never fabricate
    a date from sparse or noisy history. Always an estimate, never a promise.
    """
    ds = sorted({_dt.date.fromisoformat(d[:10]) for d in dates if d})
    if len(ds) < 3:
        return None
    gaps = [(b - a).days for a, b in zip(ds, ds[1:])]
    med = statistics.median_low(gaps)
    if not 45 <= med <= 200:
        return None  # not a clean quarterly cadence
    est = ds[-1] + _dt.timedelta(days=med)
    return est.isoformat(), (est - _dt.date.today()).days


def _earnings_radar() -> list[dict[str, Any]]:
    """Watchlist companies estimated to report within the radar window."""
    by_cik: dict[str, dict[str, Any]] = {}
    for r in db.fetch_earnings_dates():
        e = by_cik.setdefault(r["cik"], {"ticker": r.get("ticker"), "dates": []})
        if r.get("reported_date"):
            e["dates"].append(r["reported_date"])
        if r.get("ticker"):
            e["ticker"] = r["ticker"]
    radar: list[dict[str, Any]] = []
    for cik, e in by_cik.items():
        est = _next_earnings_estimate(e["dates"])
        if est and -_RADAR_OVERDUE_DAYS <= est[1] <= _RADAR_AHEAD_DAYS:
            radar.append({"ticker": e["ticker"] or cik, "est_date": est[0], "days_away": est[1]})
    return radar


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
