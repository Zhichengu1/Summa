"""Tech dip watch — daily price-drop detector for popular tech names → Discord.

A GLOBAL, alert-only pass (nothing is stored) run once per weekday after the US
close by summa-dips.yml via `python -m tools.dip_watch`. It answers one question:
"did any tech name people actually care about just drop hard enough to look at?"

The universe is the union of two lists:

  1. CORE — a curated list of the large-cap US tech companies on the Fortune 500
     (Apple, Microsoft, Nvidia, …). Fortune publishes no free/keyless feed, so the
     list is maintained here by hand; override it with DIP_WATCH_CORE
     ("AAPL,MSFT,…") without a code change.
  2. REDDIT — tickers that appeared near the top of the stored `reddit_trends`
     snapshots in the last few days, kept only when labelled as tech (sector
     "Technology", or a tech industry keyword) and not an ETF. This is the
     "what the crowd is talking about right now" half; it moves with the board.

Each ticker gets one keyless Yahoo chart GET (3 months of daily bars — the same
free source price_ingest and reddit_trends_ingest use). A name is flagged when
TODAY's session closed down hard:

  - day drop    — close ≤ -DIP_DAY_PCT % vs the prior close (default 4 %), or
  - slide       — 5-session return ≤ -DIP_5D_PCT % (default 10 %) AND today is red.

The "today is red" requirement on the slide rule is what keeps a multi-day
selloff from re-alerting on its bounce days. Each flagged line carries context:
5-day return, distance off the 20-session and 52-week highs, volume vs its
30-day average, and the move relative to QQQ — so a broad tech selloff reads as
such instead of as twenty separate stock stories.

If the latest Yahoo bar isn't today's date (holiday, or a run that started too
early) the pass skips without alerting, so yesterday's drop is never re-posted.
Fail-soft throughout (invariant #10): a dead ticker drops out, a dead Yahoo or
Supabase read just shrinks the universe, and nothing ever raises.

A dip is a prompt to research, not a buy signal — the embed says so.
"""

import datetime as _dt
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import db
from ingest.price_ingest import _yahoo_symbol

try:
    from enrichment import discord_notify
except Exception:  # pragma: no cover — notifications are optional
    discord_notify = None

logger = logging.getLogger(__name__)

_TIMEOUT = 8
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; Summa/1.0)"}
_YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=3mo&interval=1d"

# Large-cap US tech on the Fortune 500 (hardware, semis, software, internet
# platforms, IT distribution/services) plus TSLA, which trades and is discussed
# as a tech name. Hand-maintained — see module docstring.
_DEFAULT_CORE = (
    "AAPL,MSFT,NVDA,GOOGL,AMZN,META,TSLA,AVGO,ORCL,CRM,ADBE,AMD,INTC,QCOM,CSCO,"
    "IBM,TXN,MU,AMAT,LRCX,KLAC,ADI,DELL,HPQ,HPE,INTU,NOW,PANW,NFLX,UBER,"
    "WDC,CDW,JBL,SNX,ARW,ANET,PLTR,ADP,ACN,SMCI"
)
_CORE = [t.strip().upper() for t in os.environ.get("DIP_WATCH_CORE", _DEFAULT_CORE).split(",")
         if t.strip()]

# Reddit half of the universe: tickers ranked ≤ RANK_MAX on any snapshot in the
# last LOOKBACK_DAYS days.
_REDDIT_LOOKBACK_DAYS = int(os.environ.get("DIP_WATCH_REDDIT_DAYS", "3"))
_REDDIT_RANK_MAX = int(os.environ.get("DIP_WATCH_REDDIT_RANK", "40"))
# Tech labels come from reddit_trends' (sector, industry) — SIC-derived or the
# curated profiles — so match the sector plus industry keywords that SIC files
# outside "Technology" (e.g. internet platforms under services).
_TECH_SECTORS = {"technology"}
_TECH_INDUSTRY_WORDS = ("semiconductor", "software", "computer", "electronic",
                        "internet", "data processing", "communications equipment")

# Dip thresholds (percent, positive numbers).
_DAY_PCT = float(os.environ.get("DIP_DAY_PCT", "4"))
_5D_PCT = float(os.environ.get("DIP_5D_PCT", "10"))
_BENCHMARK = "QQQ"
_BUDGET_S = 90  # wall-clock cap for pricing the whole universe


def _get_chart(ticker: str) -> dict[str, Any] | None:
    """One Yahoo chart result (3mo daily) for `ticker`, or None. Single attempt."""
    url = _YAHOO_CHART.format(t=urllib.parse.quote(_yahoo_symbol(ticker)))
    try:
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310 (fixed https host)
            payload = json.loads(resp.read().decode("utf-8", "replace"))
        results = ((payload or {}).get("chart") or {}).get("result") or []
        return results[0] if results else None
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


def _stats(result: dict[str, Any]) -> dict[str, Any] | None:
    """Session stats from a chart result: last bar date, day %, 5d %, off-highs, volume ×."""
    try:
        meta = result.get("meta") or {}
        quote = ((result.get("indicators") or {}).get("quote") or [{}])[0] or {}
        bars = [(ts, c, v) for ts, c, v in zip(result.get("timestamp") or [],
                                               quote.get("close") or [],
                                               quote.get("volume") or [])
                if isinstance(c, (int, float)) and c > 0]
        if len(bars) < 2:
            return None
        closes = [c for _, c, _ in bars]
        last, prev = closes[-1], closes[-2]
        out: dict[str, Any] = {
            # Bars are stamped at the US open (13:30/14:30 UTC), so the UTC date
            # is the session date.
            "bar_date": _dt.datetime.fromtimestamp(bars[-1][0], tz=_dt.timezone.utc).date(),
            "last_price": round(last, 2),
            "day_pct": (last / prev - 1.0) * 100.0,
            "name": meta.get("shortName") or meta.get("longName"),
            "is_etf": str(meta.get("instrumentType") or "").upper() == "ETF",
        }
        if len(closes) >= 6:
            out["ret_5d"] = (last / closes[-6] - 1.0) * 100.0
        hi20 = max(closes[-20:])
        out["off_20d_high"] = (last / hi20 - 1.0) * 100.0
        hi52 = meta.get("fiftyTwoWeekHigh")
        if hi52 and float(hi52) > 0:
            out["off_52w_high"] = (last / float(hi52) - 1.0) * 100.0
        vols = [v for _, _, v in bars if isinstance(v, (int, float)) and v > 0]
        if len(vols) >= 11:
            base = vols[-31:-1] if len(vols) >= 31 else vols[:-1]
            avg = sum(base) / len(base)
            if avg > 0:
                out["vol_x"] = vols[-1] / avg
        return out
    except (TypeError, ValueError, KeyError, IndexError, ZeroDivisionError, OSError):
        return None


def _is_tech(sector: Any, industry: Any) -> bool:
    """True when a stored (sector, industry) label reads as a tech company."""
    if str(sector or "").strip().lower() in _TECH_SECTORS:
        return True
    ind = str(industry or "").lower()
    return any(w in ind for w in _TECH_INDUSTRY_WORDS)


def _reddit_tech_tickers() -> dict[str, dict[str, Any]]:
    """Recently-trending tech tickers from reddit_trends → {ticker: best rank/mentions}."""
    since = (_dt.datetime.now(_dt.timezone.utc).date()
             - _dt.timedelta(days=_REDDIT_LOOKBACK_DAYS)).isoformat()
    out: dict[str, dict[str, Any]] = {}
    for r in db.fetch_recent_reddit_trends(since, _REDDIT_RANK_MAX):
        if r.get("is_etf") or not _is_tech(r.get("sector"), r.get("industry")):
            continue
        t = str(r.get("ticker") or "").upper()
        best = out.get(t)
        if best is None or (r.get("rank") or 999) < (best.get("rank") or 999):
            out[t] = {"rank": r.get("rank"), "mentions": r.get("mentions"),
                      "name": r.get("name")}
    return out


def _flag(s: dict[str, Any]) -> str | None:
    """Which dip rule (if any) a ticker's session stats trip: 'day', 'slide', or None."""
    day = s.get("day_pct")
    if day is None:
        return None
    if day <= -_DAY_PCT:
        return "day"
    r5 = s.get("ret_5d")
    if r5 is not None and r5 <= -_5D_PCT and day < 0:
        return "slide"
    return None


def scan_dips(dry_run: bool = False) -> int:
    """Price the tech universe, flag today's dips, post one Discord embed. Returns #dips.

    `dry_run=True` logs the dips without posting. Never raises.
    """
    reddit = _reddit_tech_tickers()
    universe = list(dict.fromkeys(_CORE + sorted(reddit)))  # core first, de-duped
    logger.info("  dip_watch: universe %d tickers (%d core, %d reddit-tech, %d overlap)",
                len(universe), len(_CORE), len(reddit), len(set(_CORE) & set(reddit)))

    bench_res = _get_chart(_BENCHMARK)
    bench = _stats(bench_res) if bench_res else None
    today = _dt.datetime.now(_dt.timezone.utc).date()
    if bench and bench["bar_date"] != today:
        logger.info("  dip_watch: latest %s bar is %s, not %s — market closed today, skipped",
                    _BENCHMARK, bench["bar_date"], today)
        return 0

    dips: list[dict[str, Any]] = []
    deadline = time.monotonic() + _BUDGET_S
    priced = 0
    for t in universe:
        if time.monotonic() > deadline:
            logger.warning("  dip_watch: price budget hit at %s — rest skipped this run", t)
            break
        res = _get_chart(t)
        time.sleep(0.1)  # polite spacing to Yahoo
        s = _stats(res) if res else None
        if not s:
            continue
        priced += 1
        if s["bar_date"] != today:
            continue  # stale/halted symbol — never re-alert an old session
        rule = _flag(s)
        if not rule:
            continue
        s.update(ticker=t, rule=rule, core=t in _CORE)
        if t in reddit:
            s["reddit_rank"] = reddit[t].get("rank")
            s["reddit_mentions"] = reddit[t].get("mentions")
            s["name"] = s.get("name") or reddit[t].get("name")
        if bench and bench.get("day_pct") is not None:
            s["vs_bench"] = s["day_pct"] - bench["day_pct"]
        dips.append(s)

    dips.sort(key=lambda d: d["day_pct"])  # biggest drop first
    logger.info("  dip_watch: priced %d/%d, %d dip(s)%s", priced, len(universe), len(dips),
                (": " + ", ".join(f"{d['ticker']} {d['day_pct']:+.1f}%" for d in dips)) if dips else "")
    if not dips or dry_run or discord_notify is None:
        return len(dips)
    try:
        from watchlist import get_active_watchlist
        watched = {c["ticker"].upper() for c in get_active_watchlist() if c.get("ticker")}
    except Exception:
        watched = set()  # the star is cosmetic — never block the alert on it
    try:
        discord_notify.notify_price_dips(
            dips, benchmark=(_BENCHMARK, bench.get("day_pct") if bench else None),
            day_pct=_DAY_PCT, slide_pct=_5D_PCT, scanned=priced, watchlist_tickers=watched)
    except Exception:
        logger.exception("  dip_watch: Discord notify failed")
    return len(dips)
