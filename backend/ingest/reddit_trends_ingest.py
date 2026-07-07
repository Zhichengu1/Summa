"""Reddit trending-stocks ingest — populates `reddit_trends` + Discord alerts.

A GLOBAL pass (market-wide, not watchlist-scoped) run several times a day by
summa-reddit.yml via `python -m tools.reddit_trends`: the pre-open run posts the
full daily digest — including an "under the radar" section of low-chatter tickers
whose 24h mention growth is exploding (see _find_rising) — and the weekday
intraday runs refresh today's snapshot with the latest counts and alert ONLY on
tickers newly surging into the top ranks.
It pulls the most-mentioned stock tickers across the big investing subreddits
(r/wallstreetbets, r/stocks, r/investing, …) from two FREE, keyless aggregator
APIs, keyed one ranked snapshot per (day, ticker) — intraday re-runs upsert the
freshest numbers onto the same rows:

  1. ApeWisdom  (https://apewisdom.io/api/) — mention counts, upvotes, and
     24h rank movement aggregated across stock subreddits. Primary source.
  2. Tradestie  (https://tradestie.com/api/v1/apps/reddit) — r/wallstreetbets
     comment counts + a bullish/bearish sentiment read. Merged in for sentiment;
     also the full fallback ranking if ApeWisdom is down.

Alerted tickers also get a live last-price + day-% from Yahoo's keyless chart
endpoint (display-only trader context, never stored — daily_prices remains the
price warehouse).

Reddit itself is deliberately NOT scraped: reddit.com blocks unauthenticated
requests from cloud/datacenter IPs (GitHub Actions would 403), and the official
API requires OAuth registration. The aggregators keep the channel keyless,
zero-cost, and fail-soft — same contract as every other non-SEC source
(invariant #10): a dead API logs and is skipped, never aborting the run.

Stdlib HTTP + JSON only (no extra dependency), so the edgar-free
requirements-news.txt path covers it.
"""

import datetime as _dt
import html
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import db

try:
    from enrichment import discord_notify
except Exception:  # pragma: no cover — notifications are optional
    discord_notify = None

logger = logging.getLogger(__name__)

_TIMEOUT = 15
_MAX_ATTEMPTS = 2
_HEADERS = {"User-Agent": "Summa/1.0 (reddit-trends; contact@example.com)"}

_APEWISDOM_URL = "https://apewisdom.io/api/v1.0/filter/{filter}/page/1"
# Documented at tradestie.com/apps/reddit/api (the old tradestie.com/api/v1 path
# now 404s). Best-effort: sentiment is a bonus, never required for the digest.
_TRADESTIE_URL = "https://api.tradestie.com/v1/apps/reddit"

# How many ranked tickers to store per day / to show in the Discord digest.
_STORE_N = int(os.environ.get("REDDIT_TRENDS_MAX", "50"))
_ALERT_N = int(os.environ.get("REDDIT_TRENDS_ALERT_N", "20"))
# Intraday surge alert: a ticker now in the top-N that the day's earlier snapshot
# had ranked past this floor (or not at all) is "surging" and worth a ping.
_SURGE_N = int(os.environ.get("REDDIT_TRENDS_SURGE_N", "5"))
_SURGE_PRIOR_FLOOR = 20
# "Under the radar" risers (daily digest only): names OUTSIDE the main top-N whose
# chatter is small in absolute terms but exploding relative to 24h ago — the
# high-potential picks you want to see BEFORE they hit the front page. Alert-only
# context (like prices): never stored, so no schema impact.
_RISING_N = int(os.environ.get("REDDIT_TRENDS_RISING_N", "5"))
_RISING_MIN_MENTIONS = int(os.environ.get("REDDIT_TRENDS_RISING_MIN", "25"))
_RISING_GROWTH = 2.0    # qualify: mentions at least doubled in 24h…
_RISING_RANK_JUMP = 15  # …or climbed ≥ this many leaderboard spots
# Attach a live last-price + day-% to digest tickers (Yahoo chart endpoint,
# keyless — the same free source price_ingest uses). "0" disables.
_WITH_PRICES = os.environ.get("REDDIT_TRENDS_PRICES", "1") != "0"
_YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=3mo&interval=1d"
# ApeWisdom filter: which subreddit universe to rank ("all-stocks" spans
# wallstreetbets + stocks + investing + …; can be a single subreddit name).
_APE_FILTER = os.environ.get("REDDIT_TRENDS_FILTER", "all-stocks")

# Plausible US ticker only — the aggregators occasionally leak words like "DD".
_TICKER_RE = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")


def _get_json(url: str, attempts: int = _MAX_ATTEMPTS, timeout: int = _TIMEOUT) -> Any | None:
    """Fetch and decode a JSON endpoint, or None on failure (best-effort, short backoff)."""
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == attempts:
                return None
            time.sleep(1)
    return None


def _num(x: Any) -> int | None:
    """Coerce an API count field (int or numeric string) to int, or None."""
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def _fetch_apewisdom() -> list[dict[str, Any]]:
    """ApeWisdom ranked mentions → partial rows (no sentiment). [] on failure."""
    data = _get_json(_APEWISDOM_URL.format(filter=_APE_FILTER))
    results = (data or {}).get("results") if isinstance(data, dict) else None
    if not results:
        return []
    rows: list[dict[str, Any]] = []
    for it in results:
        ticker = str(it.get("ticker") or "").strip().upper()
        if not _TICKER_RE.match(ticker):
            continue
        rank, rank_prev = _num(it.get("rank")), _num(it.get("rank_24h_ago"))
        mentions, mentions_prev = _num(it.get("mentions")), _num(it.get("mentions_24h_ago"))
        rows.append({
            "ticker": ticker,
            "name": (html.unescape(str(it.get("name") or "")).strip() or None),
            "rank": rank,
            "mentions": mentions,
            "upvotes": _num(it.get("upvotes")),
            # Positive = climbing the leaderboard (was ranked lower yesterday).
            "rank_change": (rank_prev - rank) if rank is not None and rank_prev is not None else None,
            "mentions_change": (mentions - mentions_prev)
                               if mentions is not None and mentions_prev is not None else None,
            "source": f"apewisdom:{_APE_FILTER}",
        })
    rows.sort(key=lambda r: r["rank"] if r["rank"] is not None else 10_000)
    return rows


def _fetch_tradestie() -> dict[str, dict[str, Any]]:
    """Tradestie r/wallstreetbets sentiment, keyed by ticker. {} on failure.

    Single short attempt: sentiment is a bonus on top of the ApeWisdom ranking,
    so a dead/slow endpoint should cost seconds, not the run's time budget.
    """
    data = _get_json(_TRADESTIE_URL, attempts=1, timeout=8)
    if not isinstance(data, list):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for it in data:
        if not isinstance(it, dict):
            continue
        ticker = str(it.get("ticker") or "").strip().upper()
        if not _TICKER_RE.match(ticker):
            continue
        out[ticker] = {
            "comments": _num(it.get("no_of_comments")),
            "sentiment": (str(it.get("sentiment") or "").strip() or None),
            "sentiment_score": it.get("sentiment_score"),
        }
    return out


def _price_context(tickers: list[str]) -> dict[str, dict[str, Any]]:
    """Live trader stats for `tickers` via Yahoo's keyless chart endpoint (3mo daily).

    One small GET per ticker yields everything a trader glances at before touching
    a Reddit-trending name: last price + day %, 5-session momentum, today's volume
    vs its 30-day average (is the buzz backed by real trading?), distance off the
    52-week high, and an ETF flag (so index chatter reads as such). Single attempt,
    fail-soft per ticker — a miss just drops the stats from that line, never the
    line itself. Display-only: never stored (daily_prices remains the priced
    warehouse).
    """
    out: dict[str, dict[str, Any]] = {}
    deadline = time.monotonic() + 25  # wall-clock budget for the whole pass
    for t in tickers:
        if time.monotonic() > deadline:
            logger.warning("  reddit_trends: price-context budget hit at %s — "
                           "remaining tickers post without prices", t)
            break
        data = _get_json(_YAHOO_CHART.format(t=urllib.parse.quote(t)), attempts=1, timeout=8)
        try:
            result = data["chart"]["result"][0]
            meta = result["meta"]
            last = float(meta["regularMarketPrice"])
            ctx: dict[str, Any] = {"last_price": last}
            quote = result["indicators"]["quote"][0]
            closes = [c for c in (quote.get("close") or []) if c]
            vols = [v for v in (quote.get("volume") or []) if v]
            # Day % vs the PRIOR session's close from the daily series. (meta's
            # chartPreviousClose is the close before the whole 3mo range — using
            # it here once produced a "+160%" day move.) closes[-1] is today's
            # live/final bar, closes[-2] the previous session.
            if len(closes) >= 2 and closes[-2] > 0:
                ctx["day_pct"] = (last / closes[-2] - 1.0) * 100.0
            if str(meta.get("instrumentType") or "").upper() == "ETF":
                ctx["is_etf"] = True
            hi52 = meta.get("fiftyTwoWeekHigh")
            if hi52 and float(hi52) > 0:
                ctx["off_high_pct"] = (last / float(hi52) - 1.0) * 100.0
            if len(closes) >= 6 and closes[-6] > 0:
                ctx["ret_5d"] = (last / closes[-6] - 1.0) * 100.0
            if len(vols) >= 11:  # today vs the average of the prior sessions
                base = vols[-31:-1] if len(vols) >= 31 else vols[:-1]
                avg = sum(base) / len(base)
                if avg > 0:
                    ctx["vol_spike"] = vols[-1] / avg
            out[t] = ctx
        except (TypeError, KeyError, IndexError, ValueError, ZeroDivisionError):
            continue
    return out


def _find_rising(ranking: list[dict[str, Any]], exclude: set[str]) -> list[dict[str, Any]]:
    """Under-the-radar risers: low-chatter tickers whose 24h mentions are exploding.

    Scans the FULL fetched ranking (not just the stored/alerted top) for names
    outside `exclude` that qualify by velocity — mentions at least doubled in 24h
    (a ticker new to the board counts as an infinite-base surge), or a jump of
    ≥ _RISING_RANK_JUMP leaderboard spots — with a small mention floor so
    single-digit noise never qualifies. Attaches `mentions_growth` (display-only)
    and returns the top _RISING_N sorted by growth, biggest movers first.
    """
    out: list[dict[str, Any]] = []
    for r in ranking:
        if r["ticker"] in exclude:
            continue
        m, dm, rc = r.get("mentions"), r.get("mentions_change"), r.get("rank_change")
        if m is None or m < _RISING_MIN_MENTIONS:
            continue
        prior = (m - dm) if dm is not None else None
        if prior is not None and prior <= 0:
            # New to the board — the strongest signal; flag it for display and
            # rank it as m× growth (a base of 0 has no honest multiple).
            growth: float | None = float(m)
            r["board_new"] = True
        elif prior is not None:
            growth = m / prior
        else:
            growth = None
        if (growth is not None and growth >= _RISING_GROWTH) or (rc is not None and rc >= _RISING_RANK_JUMP):
            r["mentions_growth"] = growth
            out.append(r)
    out.sort(key=lambda r: (r.get("mentions_growth") or 1.0,
                            r.get("rank_change") or 0), reverse=True)
    return out[:_RISING_N]


def _watchlist_tickers() -> set[str]:
    """Tickers on the active Summa watchlist (starred in the digest). Fail-soft."""
    try:
        from watchlist import get_active_watchlist
        return {c["ticker"].upper() for c in get_active_watchlist() if c.get("ticker")}
    except Exception:
        logger.exception("  reddit_trends: watchlist lookup failed")
        return set()


def ingest_reddit_trends_global() -> int:
    """Pull the latest Reddit trending-stock ranking, refresh today's snapshot, alert.

    Global; run several times a day (summa-reddit.yml). Every run re-pulls the
    aggregators and upserts the freshest numbers onto today's (trend_date, ticker)
    rows, so the table always holds the LATEST counts, not the morning's. Discord:
    the day's FIRST run posts the full digest; later runs stay quiet unless a
    ticker surged into the top few from (near) nowhere — that delta is the
    intraday signal a trader actually wants pinged about. Best-effort per source:
    ApeWisdom ranks + Tradestie sentiment when both respond; either alone still
    produces a snapshot. Returns the number of rows written (0 if every source
    was unavailable).
    """
    ape = _fetch_apewisdom()
    wsb = _fetch_tradestie()
    logger.info("  reddit_trends: apewisdom=%d tickers, tradestie=%d tickers", len(ape), len(wsb))

    if ape:
        rows = ape
        for r in rows:  # merge WSB sentiment onto the ApeWisdom ranking
            s = wsb.get(r["ticker"])
            if s:
                r["sentiment"] = s["sentiment"]
                r["sentiment_score"] = s["sentiment_score"]
    elif wsb:
        # Fallback ranking: Tradestie alone, ordered by WSB comment volume.
        ranked = sorted(wsb.items(), key=lambda kv: kv[1]["comments"] or 0, reverse=True)
        rows = [{
            "ticker": t, "name": None, "rank": i + 1, "mentions": s["comments"],
            "upvotes": None, "rank_change": None, "mentions_change": None,
            "sentiment": s["sentiment"], "sentiment_score": s["sentiment_score"],
            "source": "tradestie:wallstreetbets",
        } for i, (t, s) in enumerate(ranked)]
    else:
        logger.warning("  reddit_trends: all sources unavailable — skipped")
        return 0

    trend_date = _dt.datetime.now(_dt.timezone.utc).date().isoformat()
    full_ranking = rows  # whole fetched board — the rising scan looks past the stored top
    rows = rows[:_STORE_N]
    for r in rows:
        r["trend_date"] = trend_date

    # What today's snapshot looked like BEFORE this refresh — decides whether we
    # post the full digest (first run of the day) or only surge deltas.
    prior_ranks: dict[str, int | None] = {
        r["ticker"]: r.get("rank") for r in db.fetch_reddit_trends_day(trend_date)
    }

    written = db.upsert_reddit_trends(rows)
    logger.info("  reddit_trends: stored %d tickers for %s (%s)", written, trend_date,
                "first snapshot" if not prior_ranks else "refresh")

    if discord_notify is None:
        return written

    rising: list[dict[str, Any]] = []
    if not prior_ranks:
        alert = rows[:_ALERT_N]
        # Daily digest only: under-the-radar risers from the whole board (the
        # intraday runs stay surge-only — the 24h deltas barely move intraday,
        # so re-alerting the same risers would be spam).
        rising = _find_rising(full_ranking, {r["ticker"] for r in alert})
        if rising:
            logger.info("  reddit_trends: under-the-radar risers: %s",
                        ", ".join(r["ticker"] for r in rising))
    else:
        # Surge = now top-_SURGE_N but earlier today unranked or buried past the
        # floor. Ordinary churn inside the leaderboard stays silent (no spam).
        alert = [r for r in rows[:_SURGE_N]
                 if prior_ranks.get(r["ticker"], 10_000) is None
                 or (prior_ranks.get(r["ticker"]) or 10_000) > _SURGE_PRIOR_FLOOR]
        if alert:
            logger.info("  reddit_trends: intraday surge: %s",
                        ", ".join(r["ticker"] for r in alert))

    if not alert:
        return written

    if _WITH_PRICES:  # live trader context on just the alerted + rising tickers
        shown = alert + rising
        prices = _price_context([r["ticker"] for r in shown])
        for r in shown:
            r.update(prices.get(r["ticker"], {}))
    try:
        discord_notify.notify_reddit_trends(
            alert, watchlist_tickers=_watchlist_tickers(),
            surge=bool(prior_ranks), rising=rising)
    except Exception:
        logger.exception("  reddit_trends: Discord notify failed")
    return written
