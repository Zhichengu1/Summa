"""Dip watch — daily price-drop detector for Reddit-trending names + big tech → Discord.

A GLOBAL pass run once per weekday after the US close by summa-dips.yml via
`python -m tools.dip_watch`. It answers "did anything the crowd is talking about
(or a big tech name) just drop hard — and what is Reddit saying about it?"

The universe is the union of two lists:

  1. REDDIT — every ticker ranked ≤ DIP_WATCH_REDDIT_RANK on any stored
     `reddit_trends` snapshot in the last DIP_WATCH_REDDIT_DAYS days, any sector.
     ETFs are priced (so the list's closing numbers refresh) but never alerted.
  2. CORE — a curated list of the large-cap US tech companies on the Fortune 500
     (Apple, Microsoft, Nvidia, …), so big tech is covered even on days Reddit
     isn't talking about it. Fortune publishes no free/keyless feed, so the list
     is maintained here by hand; override it with DIP_WATCH_CORE ("AAPL,MSFT,…").

Each ticker gets one keyless Yahoo chart GET (3 months of daily bars — the same
free source price_ingest and reddit_trends_ingest use). A name is flagged when
TODAY's session closed down hard:

  - day drop    — close ≤ -DIP_DAY_PCT % vs the prior close (default 4 %), or
  - slide       — 5-session return ≤ -DIP_5D_PCT % (default 10 %) AND today is red.

The "today is red" requirement on the slide rule is what keeps a multi-day
selloff from re-alerting on its bounce days.

**Reddit connection.** Each dip is joined to its latest Reddit snapshot row and
given a deterministic read of how the crowd is reacting (`_crowd_read`): buzz
spiking into the drop (look for the news), WSB still bullish (dip-buying talk),
WSB bearish (the crowd agrees), chatter fading, or not on the board at all. The
embed then draws the connections across dips — names in the same industry
falling together (a sector move, not a stock story) and a tally of how the
Reddit names are being read. Every move is also shown against its benchmark
(QQQ for tech, SPY otherwise) so a market-wide selloff reads as one.

**List update.** The Reddit ingest prices its snapshot intraday (its last run is
before the close), so this pass writes the CLOSING last_price / day_pct /
52-week distances / 5-day return plus a `dip_rule` flag back onto today's
`reddit_trends` rows. The Reddit Buzz view then shows the close and marks the
dips; rows that did not dip get `dip_rule` cleared.

Freshness is keyed to the latest SESSION, not the run's clock: GitHub's cron
routinely starts scheduled jobs hours late (the 13:15 UTC Reddit run has been
starting at 18:00–21:00), so a 21:30 UTC dip run can land after midnight UTC.
The session is the benchmark's latest bar; if it closed more than
_MAX_SESSION_AGE_H ago (a holiday — no new bar) the pass skips without alerting
or writing, so a drop is never re-posted the next day. Fail-soft throughout (invariant #10): a dead ticker drops out, a dead
Yahoo or Supabase read just shrinks the universe, and nothing ever raises.

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
from ingest.reddit_trends_ingest import _DB_COLS as _REDDIT_COLS, _industry_labels

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
# last LOOKBACK_DAYS days (the stored top-N is 50).
_REDDIT_LOOKBACK_DAYS = int(os.environ.get("DIP_WATCH_REDDIT_DAYS", "3"))
_REDDIT_RANK_MAX = int(os.environ.get("DIP_WATCH_REDDIT_RANK", "50"))

# Dip thresholds (percent, positive numbers).
_DAY_PCT = float(os.environ.get("DIP_DAY_PCT", "4"))
_5D_PCT = float(os.environ.get("DIP_5D_PCT", "10"))

# Crowd-read thresholds on the 24h mention change.
_BUZZ_SPIKE = 0.5    # mentions up ≥ 50 % vs 24h ago (or new to the board)
_BUZZ_FADE = -0.3    # mentions down ≥ 30 %
_BUZZ_MIN_MENTIONS = 25  # below this a % change is noise (3 mentions "+200 %")

# Benchmarks: tech moves are read against QQQ, everything else against SPY.
_TECH_BENCH, _BROAD_BENCH = "QQQ", "SPY"
_TECH_SECTORS = {"technology"}
_TECH_INDUSTRY_WORDS = ("semiconductor", "software", "computer", "electronic",
                        "internet", "data processing", "communications equipment")

_BUDGET_S = 150  # wall-clock cap for pricing the whole universe
# A session's close (16:00 ET ≈ 21:00 UTC, ignoring DST) must be at most this old.
# 18h tolerates a badly delayed cron; a holiday's stale bar is ≥ 24h old.
_MAX_SESSION_AGE_H = 18
# Columns this pass adds onto reddit_trends (schema.sql); the legacy fallback
# writes the closing prices without them if schema.sql hasn't been re-applied.
_DIP_COLS = ("ret_5d", "dip_rule")


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
    """Session stats from a chart result: bar date, day %, 5d %, 20d/52w distances, volume ×."""
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
            "last_price": round(last, 4),
            "day_pct": (last / prev - 1.0) * 100.0,
            "name": meta.get("shortName") or meta.get("longName"),
            "is_etf": str(meta.get("instrumentType") or "").upper() == "ETF",
        }
        if len(closes) >= 6:
            out["ret_5d"] = (last / closes[-6] - 1.0) * 100.0
        out["off_20d_high"] = (last / max(closes[-20:]) - 1.0) * 100.0
        hi52, lo52 = meta.get("fiftyTwoWeekHigh"), meta.get("fiftyTwoWeekLow")
        if hi52 and float(hi52) > 0:
            out["off_52w_high"] = (last / float(hi52) - 1.0) * 100.0
        if lo52 and float(lo52) > 0:
            out["off_52w_low"] = (last / float(lo52) - 1.0) * 100.0
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
    """True when a (sector, industry) label reads as a tech company."""
    if str(sector or "").strip().lower() in _TECH_SECTORS:
        return True
    ind = str(industry or "").lower()
    return any(w in ind for w in _TECH_INDUSTRY_WORDS)


def _reddit_context() -> dict[str, dict[str, Any]]:
    """Latest Reddit snapshot row per recently-trending ticker, plus days-on-board."""
    since = (_dt.datetime.now(_dt.timezone.utc).date()
             - _dt.timedelta(days=_REDDIT_LOOKBACK_DAYS)).isoformat()
    out: dict[str, dict[str, Any]] = {}
    for r in db.fetch_recent_reddit_trends(since, _REDDIT_RANK_MAX):  # newest day first
        t = str(r.get("ticker") or "").upper()
        if not t:
            continue
        if t in out:
            out[t]["days_on_board"] += 1
            continue
        out[t] = {**r, "days_on_board": 1}
    return out


def _crowd_read(ctx: dict[str, Any] | None) -> tuple[str, str]:
    """(key, label) for how Reddit is reacting to a dip — deterministic, from one snapshot row."""
    if not ctx:
        return "off_board", "Not on the Reddit board"
    m, dm = ctx.get("mentions"), ctx.get("mentions_change")
    growth: float | None = None
    if m is not None and dm is not None and m >= _BUZZ_MIN_MENTIONS:
        prior = m - dm
        growth = 9.99 if prior <= 0 else dm / prior   # new to the board = a spike
    mood = str(ctx.get("sentiment") or "").lower()
    spiking = growth is not None and growth >= _BUZZ_SPIKE
    if spiking and "bull" in mood:
        return "spike_bull", "Buzz spiking and WSB bullish: the crowd is buying the dip"
    if spiking and "bear" in mood:
        return "spike_bear", "Buzz spiking and WSB bearish: capitulation chatter"
    if spiking:
        return "spike", "Buzz spiking into the drop: look for the news"
    if "bull" in mood:
        return "bull", "WSB still bullish: dip-buying talk"
    if "bear" in mood:
        return "bear", "WSB bearish: the crowd agrees with the drop"
    if growth is not None and growth <= _BUZZ_FADE:
        return "fading", "Chatter fading as it falls"
    if m is not None and m < _BUZZ_MIN_MENTIONS:
        return "light", "Light chatter"
    return "steady", "Steady chatter"


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


def _connections(dips: list[dict[str, Any]]) -> list[str]:
    """Cross-dip connections: same-industry clusters, and how the Reddit names are read."""
    lines: list[str] = []
    # Broad read first: one sector carrying most of the dips is a sector move.
    by_sector: dict[str, int] = {}
    for d in dips:
        if d.get("sector"):
            by_sector[d["sector"]] = by_sector.get(d["sector"], 0) + 1
    if by_sector:
        top, n = max(by_sector.items(), key=lambda kv: kv[1])
        if n >= 3 and n * 2 >= len(dips):
            lines.append(f"Sector move: {n} of {len(dips)} dips are {top}")
    by_group: dict[str, list[dict[str, Any]]] = {}
    for d in dips:
        g = d.get("industry") or d.get("sector")
        if g:
            by_group.setdefault(g, []).append(d)
    for g, ds in sorted(by_group.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        if len(ds) < 2:
            continue
        avg = sum(d["day_pct"] for d in ds) / len(ds)
        lines.append(f"{g} ({len(ds)}, avg {avg:+.1f}%): "
                     + ", ".join(d["ticker"] for d in ds))
    reads: dict[str, int] = {}
    for d in dips:
        if d["crowd"] != "off_board":
            reads[d["crowd"]] = reads.get(d["crowd"], 0) + 1
    on_board = sum(reads.values())
    if on_board:
        parts = []
        spiking = sum(v for k, v in reads.items() if k.startswith("spike"))
        bull = reads.get("bull", 0) + reads.get("spike_bull", 0)
        bear = reads.get("bear", 0) + reads.get("spike_bear", 0)
        if spiking:
            parts.append(f"{spiking} with buzz spiking")
        if bull:
            parts.append(f"{bull} read bullish")
        if bear:
            parts.append(f"{bear} read bearish")
        if reads.get("fading"):
            parts.append(f"{reads['fading']} fading")
        lines.append(f"Reddit: {on_board} of {len(dips)} dips are on the board"
                     + (" · " + ", ".join(parts) if parts else ""))
    return lines


def _update_reddit_list(trend_date: str, priced: dict[str, dict[str, Any]]) -> int:
    """Write closing prices + the dip flag back onto today's reddit_trends rows."""
    rows = db.fetch_reddit_trends_day_full(trend_date)
    out: list[dict[str, Any]] = []
    for r in rows:
        s = priced.get(str(r.get("ticker") or "").upper())
        if not s:
            continue
        row = {k: r.get(k) for k in _REDDIT_COLS if k in r}
        row.update(
            last_price=s["last_price"],
            day_pct=round(s["day_pct"], 2),
            off_high_pct=round(s["off_52w_high"], 2) if s.get("off_52w_high") is not None else r.get("off_high_pct"),
            off_low_pct=round(s["off_52w_low"], 2) if s.get("off_52w_low") is not None else r.get("off_low_pct"),
            ret_5d=round(s["ret_5d"], 2) if s.get("ret_5d") is not None else None,
            dip_rule=None if s.get("is_etf") else _flag(s),
        )
        out.append(row)
    if not out:
        return 0
    try:
        return db.upsert_reddit_trends(out)
    except Exception:
        logger.warning("  dip_watch: reddit_trends dip columns missing — re-run schema.sql; "
                       "writing closing prices only")
        try:
            return db.upsert_reddit_trends(
                [{k: v for k, v in r.items() if k not in _DIP_COLS} for r in out])
        except Exception:
            logger.exception("  dip_watch: reddit_trends update failed")
            return 0


def scan_dips(dry_run: bool = False) -> int:
    """Price the universe, flag today's dips, update the Reddit list, post one embed.

    `dry_run=True` logs the dips without posting or writing. Returns #dips; never raises.
    """
    reddit = _reddit_context()
    universe = list(dict.fromkeys(sorted(reddit) + _CORE))
    logger.info("  dip_watch: universe %d tickers (%d reddit, %d core, %d overlap)",
                len(universe), len(reddit), len(_CORE), len(set(_CORE) & set(reddit)))

    bench: dict[str, float | None] = {}
    session: _dt.date | None = None
    for b in (_TECH_BENCH, _BROAD_BENCH):
        res = _get_chart(b)
        s = _stats(res) if res else None
        bench[b] = s["day_pct"] if s else None
        if s and session is None:
            session = s["bar_date"]
    if session is None:
        logger.warning("  dip_watch: benchmarks unavailable — can't date the session, skipped")
        return 0
    close_utc = _dt.datetime.combine(session, _dt.time(21, 0), tzinfo=_dt.timezone.utc)
    age_h = (_dt.datetime.now(_dt.timezone.utc) - close_utc).total_seconds() / 3600
    if age_h > _MAX_SESSION_AGE_H:
        logger.info("  dip_watch: latest session is %s (%.0fh old) — market closed today, skipped",
                    session, age_h)
        return 0
    logger.info("  dip_watch: session %s", session)

    priced: dict[str, dict[str, Any]] = {}
    deadline = time.monotonic() + _BUDGET_S
    for t in universe:
        if time.monotonic() > deadline:
            logger.warning("  dip_watch: price budget hit at %s — rest skipped this run", t)
            break
        res = _get_chart(t)
        time.sleep(0.1)  # polite spacing to Yahoo
        s = _stats(res) if res else None
        if s and s["bar_date"] == session:  # stale/halted symbol — never re-alert an old session
            priced[t] = s

    dips: list[dict[str, Any]] = []
    for t, s in priced.items():
        rule = _flag(s)
        if not rule or s.get("is_etf"):
            continue
        ctx = reddit.get(t)
        d = {**s, "ticker": t, "rule": rule, "core": t in _CORE}
        if ctx:
            d.update(reddit_rank=ctx.get("rank"), mentions=ctx.get("mentions"),
                     mentions_change=ctx.get("mentions_change"), sentiment=ctx.get("sentiment"),
                     days_on_board=ctx.get("days_on_board"),
                     sector=ctx.get("sector"), industry=ctx.get("industry"))
            d["name"] = d.get("name") or ctx.get("name")
        d["crowd"], d["crowd_label"] = _crowd_read(ctx)
        dips.append(d)

    # Label the dips Reddit hasn't labelled (core names off the board): stored
    # labels → curated profiles → SEC SIC, the same cheap chain the Reddit ingest uses.
    unlabelled = [d["ticker"] for d in dips if not (d.get("industry") or d.get("sector"))]
    if unlabelled:
        try:
            labels = _industry_labels(unlabelled)
            for d in dips:
                sector, industry = labels.get(d["ticker"], (None, None))
                d["sector"] = d.get("sector") or sector
                d["industry"] = d.get("industry") or industry
        except Exception:
            logger.exception("  dip_watch: industry labelling failed")
    for d in dips:
        b = _TECH_BENCH if (d["core"] or _is_tech(d.get("sector"), d.get("industry"))) else _BROAD_BENCH
        if bench.get(b) is not None:
            d["bench"], d["vs_bench"] = b, d["day_pct"] - bench[b]

    dips.sort(key=lambda d: d["day_pct"])  # biggest drop first
    logger.info("  dip_watch: priced %d/%d, %d dip(s)%s", len(priced), len(universe), len(dips),
                (": " + ", ".join(f"{d['ticker']} {d['day_pct']:+.1f}% [{d['crowd']}]"
                                  for d in dips)) if dips else "")
    connections = _connections(dips)
    for line in connections:
        logger.info("  dip_watch: connection — %s", line)
    if dry_run:
        return len(dips)

    # The Reddit snapshot is keyed by UTC day, which equals the session date.
    written = _update_reddit_list(session.isoformat(), priced)
    logger.info("  dip_watch: updated %d reddit_trends rows for %s with closing prices%s",
                written, session, "" if written else
                " (no snapshot for that day yet — the Reddit job hasn't run)")

    if not dips or discord_notify is None:
        return len(dips)
    try:
        from watchlist import get_active_watchlist
        watched = {c["ticker"].upper() for c in get_active_watchlist() if c.get("ticker")}
    except Exception:
        watched = set()  # the star is cosmetic — never block the alert on it
    try:
        discord_notify.notify_price_dips(
            dips, benchmarks=bench, connections=connections,
            day_pct=_DAY_PCT, slide_pct=_5D_PCT, scanned=len(priced), watchlist_tickers=watched)
    except Exception:
        logger.exception("  dip_watch: Discord notify failed")
    return len(dips)
