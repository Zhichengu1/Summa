"""Market-wide "Top Intelligence" news ingest — populates `market_news`.

A GLOBAL pass (runs once per cron tick, like the IPO / institutional passes), not
per company. It polls a curated set of FREE, keyless RSS feeds — SEC press
releases, the Federal Reserve, the FDA, and PR Newswire — and keeps ONLY the
market-moving items: each headline is scored for trader-importance and dropped
unless it clears a strict threshold. So the table stays small and high-signal by
construction ("too many headlines is bad").

Reuters/Bloomberg deliberately have no entry here — they don't offer free RSS;
their coverage already reaches the per-company Google News feed (news_ingest.py).

Zero-cost + fail-soft, exactly like news_ingest: stdlib XML parsing (no extra
dependency), best-effort per feed (a dead/​slow feed logs and is skipped, never
aborting the run), and only genuinely-new items are written (cheap on egress).
"""

import datetime as _dt
import logging
import os
import re
import time
import urllib.error
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

_TIMEOUT = 15
_MAX_ATTEMPTS = 2
_SUMMARY_CAP = 2000
_PER_FEED_CAP = 40          # parse at most N items per feed per run (newest first)
_HEADERS = {"User-Agent": "Summa/1.0 (market-intelligence; contact@example.com)"}
_TAG_RE = re.compile(r"<[^>]+>")

# Curated free feeds: (source label, url, base weight). Base weight seeds the
# importance score before keyword scoring — regulatory/macro sources start higher
# than a generic press-release wire. Env `MARKET_NEWS_FEEDS` can override with a
# comma-separated list of "label|url|weight" if you want to add/remove sources.
_DEFAULT_FEEDS: list[tuple[str, str, int]] = [
    # ── Federal Reserve (monetary policy — press, speeches, testimony) ──
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", 2),
    ("Fed Speeches",    "https://www.federalreserve.gov/feeds/speeches.xml", 2),
    ("Fed Testimony",   "https://www.federalreserve.gov/feeds/testimony.xml", 2),
    # ── Macro / economic data (GDP, PCE inflation, personal income) ──
    ("BEA",             "https://apps.bea.gov/rss/rss.xml", 2),
    # ── Regulators / enforcement ──
    ("SEC",             "https://www.sec.gov/news/pressreleases.rss", 2),
    ("FDA",             "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml", 2),
    ("FTC",             "https://www.ftc.gov/feeds/press-release.xml", 2),
    ("CFTC",            "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", 1),
    # ── Executive branch (tariffs, sanctions, executive orders) ──
    ("White House",     "https://www.whitehouse.gov/presidential-actions/feed/", 1),
    # ── Corporate press wire ──
    ("PR Newswire",     "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss", 0),
]


def _feeds() -> list[tuple[str, str, int]]:
    """Resolve the feed list (env override or the curated default)."""
    raw = os.environ.get("MARKET_NEWS_FEEDS")
    if not raw:
        return _DEFAULT_FEEDS
    out: list[tuple[str, str, int]] = []
    for part in raw.split(","):
        bits = part.split("|")
        if len(bits) >= 2:
            label, url = bits[0].strip(), bits[1].strip()
            weight = int(bits[2]) if len(bits) > 2 and bits[2].strip().lstrip("-").isdigit() else 0
            if url:
                out.append((label, url, weight))
    return out or _DEFAULT_FEEDS


# Strict market-mover threshold: only headlines scoring >= this are stored.
# Importance scoring itself lives in news_score.py (shared with company news).
_THRESHOLD = int(os.environ.get("MARKET_NEWS_MIN_SCORE", "3"))
_MAX_AGE_DAYS = int(os.environ.get("MARKET_NEWS_MAX_AGE_DAYS", "7"))  # keep it "latest" (some feeds list historical releases)


# ─── RSS fetch / parse ──────────────────────────────────────────────────────────
def _fetch(url: str) -> bytes | None:
    """Fetch raw feed bytes, or None on failure (best-effort, short backoff)."""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310
                return resp.read()
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == _MAX_ATTEMPTS:
                return None
            time.sleep(1)
    return None


def _clean(text: str | None) -> str | None:
    """Strip markup / collapse whitespace from an RSS description snippet."""
    if not text:
        return None
    s = re.sub(r"\s+", " ", _TAG_RE.sub(" ", text)).strip()
    return s[:_SUMMARY_CAP] or None


def _pub_iso(pubdate: str | None) -> str | None:
    """Parse an RFC-822 / ISO pubDate into an ISO-8601 UTC timestamp, or None."""
    if not pubdate:
        return None
    try:
        dt = parsedate_to_datetime(pubdate)
    except (TypeError, ValueError):
        try:
            dt = _dt.datetime.fromisoformat(pubdate.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt.astimezone(_dt.timezone.utc).isoformat()


_ATOM = "{http://www.w3.org/2005/Atom}"


def _parse(source: str, base: int, xml_bytes: bytes) -> list[dict[str, Any]]:
    """Parse one feed (RSS or Atom) into scored, above-threshold market_news rows."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []

    stale_before = (_dt.datetime.now(_dt.timezone.utc)
                    - _dt.timedelta(days=_MAX_AGE_DAYS)).isoformat()
    entries = root.findall(".//item") or root.findall(f".//{_ATOM}entry")
    rows: list[dict[str, Any]] = []
    for el in entries[:_PER_FEED_CAP]:
        title = (el.findtext("title") or el.findtext(f"{_ATOM}title") or "").strip()
        if not title:
            continue
        # link: RSS <link>text, or Atom <link href=...>
        link = (el.findtext("link") or "").strip()
        if not link:
            a = el.find(f"{_ATOM}link")
            link = (a.get("href") if a is not None else "") or ""
        guid = (el.findtext("guid") or el.findtext(f"{_ATOM}id") or link or title).strip()
        summary = _clean(el.findtext("description") or el.findtext(f"{_ATOM}summary")
                         or el.findtext(f"{_ATOM}content"))
        pub = _pub_iso(el.findtext("pubDate") or el.findtext(f"{_ATOM}updated")
                       or el.findtext(f"{_ATOM}published"))
        if pub and pub < stale_before:
            continue  # keep the Top Intelligence feed to recent releases only

        a = news_score.assess(title, summary or "", source=source, base=base)
        if a["impact"] < _THRESHOLD:
            continue  # strict: drop non-market-movers
        rows.append({
            "guid": guid, "source": source, "category": a["category"], "importance": a["impact"],
            "title": title[:500], "link": link or None, "summary": summary,
            "published_at": pub,
        })
    return rows


def ingest_market_news_global() -> int:
    """Poll the curated feeds, keep only market-movers, store + alert the new ones.

    Global/once-per-run. Best-effort per feed. Returns the count of NEW rows written.
    """
    all_rows: list[dict[str, Any]] = []
    for source, url, base in _feeds():
        raw = _fetch(url)
        if not raw:
            logger.warning("  market_news: %s feed unavailable", source)
            continue
        kept = _parse(source, base, raw)
        logger.info("  market_news: %s → %d market-movers", source, len(kept))
        all_rows.extend(kept)

    if not all_rows:
        return 0

    # Dedupe within this run by guid, keeping the highest-importance copy.
    by_guid: dict[str, dict[str, Any]] = {}
    for r in all_rows:
        cur = by_guid.get(r["guid"])
        if cur is None or (r["importance"] or 0) > (cur["importance"] or 0):
            by_guid[r["guid"]] = r
    rows = list(by_guid.values())

    seen = db.get_seen_market_guids([r["guid"] for r in rows])
    new_rows = [r for r in rows if r["guid"] not in seen]
    had_prior = db.market_news_has_rows()

    db.upsert_market_news(new_rows)
    logger.info("  market_news: %d kept, %d new", len(rows), len(new_rows))

    # Alert the highest-importance new items (skip the first-ever seed flood).
    if new_rows and had_prior and discord_notify is not None:
        try:
            top = sorted(new_rows, key=lambda r: r["importance"] or 0, reverse=True)
            discord_notify.notify_market_news(top)
        except Exception:
            logger.exception("  market_news: Discord notify failed")
    return len(new_rows)
