"""Company news ingest — populates `company_news` from Google News RSS.

The SECOND non-SEC data source (alongside daily_prices). Google News exposes a
keyless, free RSS *search* feed; we query it per company (by name + ticker) and
store the recent headlines. No API key, no auth, no paid tier — parsing is done
with the stdlib `xml.etree` (no extra pip dependency), so the whole channel stays
zero-cost.

Best-effort by contract, exactly like price_ingest: any failure (Google down,
throttling, malformed XML) logs and returns 0 without raising, so a news hiccup
never breaks the SEC ingest. The frontend renders the News UI only when rows
exist.
"""

import datetime as _dt
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from typing import Any

import db
import news_score

try:
    from enrichment import discord_notify
except Exception:  # pragma: no cover — notifications are optional
    discord_notify = None

logger = logging.getLogger(__name__)

# A per-company headline is "important" (worth alerting) at or above this score.
# Lower than the market feed's threshold — company items have no source base weight,
# so a single real category hit (analyst/product = 2, earnings/M&A/legal = 3+) counts,
# Composite catalyst score (news_score.assess) drives what we keep vs alert:
#   • STORE — all recent, real news is kept (impact > 0); only pure noise/spam
#     (fund-13F churn, law-firm/class-action spam, "to report" notices) is dropped.
#     So the full latest feed is available; the UI defaults to important, one toggle
#     from all.
#   • _ALERT_SCORE — WEBHOOK threshold: only genuinely useful catalysts (Notable+)
#     are pushed to Discord — "not only the latest, but useful".
#   • _MIN_SCORE — the "important" reference floor (matches the UI's importance filter).
_MIN_SCORE = int(os.environ.get("NEWS_MIN_SCORE", "3"))
_ALERT_SCORE = int(os.environ.get("NEWS_ALERT_SCORE", "6"))
# Discord alerts must be actionable — a headline older than this many hours is no
# longer "know before the move" material, even if we only just discovered it
# (e.g. Google surfacing an older article for the first time). Unknown pubDates pass.
_ALERT_MAX_AGE_H = int(os.environ.get("NEWS_ALERT_MAX_AGE_H", "24"))

# Google News RSS search endpoint — keyless and free. `hl`/`gl`/`ceid` pin the
# feed to US English. The query is company-scoped (see _query).
_RSS_URL = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
_TIMEOUT = 15
_MAX_ATTEMPTS = 3
_MAX_ITEMS = int(os.environ.get("NEWS_MAX_ITEMS", "100"))  # keep up to N per company (Google's feed tops out ~100)
_MAX_AGE_DAYS = int(os.environ.get("NEWS_MAX_AGE_DAYS", "3"))  # LATEST only — stale headlines are not actionable
_SUMMARY_CAP = 2000      # never store more than this many chars of description
# A browser-like UA avoids Google returning an empty/blocked body.
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; Summa/1.0)"}

_TAG_RE = re.compile(r"<[^>]+>")


def _query(ticker: str, name: str | None) -> str:
    """Build the Google News search query for one company (name + ticker, stock-scoped).

    Quoting the company name keeps results on-topic; adding the ticker and the
    word "stock" biases toward market-relevant coverage over generic mentions.
    """
    parts: list[str] = []
    if name:
        parts.append(f'"{name}"')
    if ticker:
        parts.append(ticker)
    base = " OR ".join(parts) if parts else (name or ticker or "")
    # `when:Nd` asks Google News for only the last N days — so we fetch a smaller,
    # already-recent feed ("latest only") instead of pulling+discarding old items.
    return urllib.parse.quote_plus(f"({base}) stock when:{_MAX_AGE_DAYS}d")


def _fetch_rss(ticker: str, name: str | None) -> bytes | None:
    """Fetch the raw RSS XML for one company, or None on failure."""
    url = _RSS_URL.format(q=_query(ticker, name))
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310 (fixed https host)
                return resp.read()
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == _MAX_ATTEMPTS:
                logger.exception("  news: fetch failed for %s after %d attempts", ticker, attempt)
                return None
            time.sleep(2 ** (attempt - 1))  # 1s, 2s backoff
    return None


def _alert_fresh(pub_iso: str | None) -> bool:
    """True if a headline is fresh enough to alert on (unknown pubDates pass)."""
    if not pub_iso:
        return True
    cutoff = (_dt.datetime.now(_dt.timezone.utc)
              - _dt.timedelta(hours=_ALERT_MAX_AGE_H)).isoformat()
    return pub_iso >= cutoff


def _pub_iso(pubdate: str | None) -> str | None:
    """Parse an RFC-822 RSS pubDate into an ISO-8601 UTC timestamp, or None."""
    if not pubdate:
        return None
    try:
        dt = parsedate_to_datetime(pubdate)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return dt.astimezone(_dt.timezone.utc).isoformat()
    except (TypeError, ValueError):
        return None


def _clean(text: str | None) -> str | None:
    """Strip HTML markup / collapse whitespace from an RSS description snippet."""
    if not text:
        return None
    stripped = _TAG_RE.sub(" ", text)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    return stripped[:_SUMMARY_CAP] or None


def _rows_from_rss(cik: str, ticker: str, name: str | None, xml_bytes: bytes) -> list[dict[str, Any]]:
    """Parse a Google News RSS doc into IMPORTANT company_news rows, newest first.

    Two gates keep the stored set lean and high-signal: recency (skip anything older
    than the window) and importance (drop score < _MIN_SCORE — routine PR, fund-holding
    chatter, "to report" notices). So every row persisted is trader-important.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        logger.warning("  %s news: malformed RSS", ticker)
        return []

    stale_before = (_dt.datetime.now(_dt.timezone.utc)
                    - _dt.timedelta(days=_MAX_AGE_DAYS)).isoformat()
    rows: list[dict[str, Any]] = []
    for item in root.iterfind(".//item"):
        link = (item.findtext("link") or "").strip() or None
        guid = (item.findtext("guid") or "").strip() or link
        if not guid:
            continue  # nothing stable to dedupe on
        pub = _pub_iso(item.findtext("pubDate"))
        if pub and pub < stale_before:
            continue  # too old — this is a "latest news" feed, not an archive
        title = (item.findtext("title") or "").strip() or None
        summary = _clean(item.findtext("description"))
        source = (item.findtext("source") or "").strip() or None
        a = news_score.assess(title or "", summary, source=source, ticker=ticker, name=name)
        if a["impact"] <= 0:
            continue  # drop only pure noise/spam (fund-13F churn, law-firm spam, "to report")
        # Keep ALL other recent news (scored). Consumers filter by importance: the
        # webhook alerts on catalysts (>= _ALERT_SCORE) and the UI defaults to the
        # important view, but the full latest feed is retained + one toggle away.
        rows.append({
            "cik": cik,
            "ticker": ticker,
            "company_name": name,
            "guid": guid,
            "title": title,
            "link": link,
            "source": source,
            "summary": summary,
            "published_at": pub,
            "importance": a["impact"],
            "category": a["category"],
        })
    # Newest first, capped — Google's ordering isn't guaranteed, so sort explicitly.
    rows.sort(key=lambda r: r.get("published_at") or "", reverse=True)
    return rows[:_MAX_ITEMS]


def ingest_news(cik: str, ticker: str, name: str | None = None) -> int:
    """Pull recent Google News headlines for one company into `company_news`.

    Best-effort; never raises. Returns the number of rows upserted.
    """
    if not ticker and not name:
        return 0
    xml_bytes = _fetch_rss(ticker, name)
    if not xml_bytes:
        return 0
    rows = _rows_from_rss(cik, ticker, name, xml_bytes)  # all recent real news (noise/spam dropped)
    if not rows:
        logger.info("  %s news: no headlines", ticker)
        return 0

    # Which of these are genuinely new (vs re-pulls we already store)?
    guids = [r["guid"] for r in rows]
    new_rows = [r for r in rows if r["guid"] not in db.get_seen_news_guids(cik, guids)]

    # Only compute alerts if the pipeline can push them, and only pay the
    # `company_has_news` query when there's actually an alert-worthy item (skips a
    # Supabase round-trip on the common poll where nothing important is new).
    alerts = ([r for r in new_rows
               if (r.get("importance") or 0) >= _ALERT_SCORE and _alert_fresh(r.get("published_at"))]
              if discord_notify is not None else [])
    had_prior = db.company_has_news(cik) if alerts else False  # gate the first-seed flood; checked BEFORE upsert

    # Write only the new rows (existing ones are static — re-writing all every poll
    # would multiply egress for no gain).
    db.upsert_news(new_rows)
    logger.info("  %s news: %d latest, %d new", ticker, len(rows), len(new_rows))

    # Webhook = only genuinely useful catalysts, ranked most-impactful first, and
    # never on the very first seed.
    if alerts and had_prior:
        try:
            alerts.sort(key=lambda r: r.get("importance") or 0, reverse=True)
            market = db.get_company_summary(cik)  # live price context for the alert
            discord_notify.notify_news(ticker, name, alerts, market=market)
        except Exception:
            logger.exception("  %s news: Discord notify failed", ticker)
    return len(new_rows)
