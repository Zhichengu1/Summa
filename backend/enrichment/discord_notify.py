"""
Discord webhook alerts.

Posts a single rich embed per flagged filing: company, form type, signals
fired, composite severity, AI summary excerpt, and a direct EDGAR link.
A silent no-op when DISCORD_WEBHOOK_URL is unset, so the pipeline still runs
without notifications configured.
"""

import logging
import os
import re
from typing import Any

try:
    import news_score  # composite catalyst scoring (impact tier, source credibility)
except Exception:  # pragma: no cover
    news_score = None

logger = logging.getLogger(__name__)

_TIMEOUT = 10  # seconds

# Severity → embed color (decimal RGB) and label, mirrors the frontend bands.
_SEVERITY_BANDS: list[tuple[int, int, str]] = [
    (75, 0xF0_52_52, "Critical"),   # red
    (50, 0xF5_A6_23, "Elevated"),   # amber
    (25, 0x4F_8D_D4, "Notable"),    # blue
    (0,  0x4F_D4_C2, "Routine"),    # teal
]

_SIGNAL_LABELS: dict[str, str] = {
    "signal_supply_chain":    "Supply chain",
    "signal_geopolitical":    "Geopolitical",
    "signal_mgmt_changes":    "Management change",
    "signal_earnings":        "Earnings risk",
    "uli_flagged":            "Uncertainty language ↑",
    "r_delta_flagged":        "Risk factors rewritten",
    "filing_velocity_flag":   "Late filing",
    "friday_dump":            "Friday dump",
    "section_length_anomaly": "Risk section expanded",
    "burst_8k_flag":          "8-K burst",
}


_NEWS_COLOR = 0x4F_D4_C2  # accent teal (neutral), matches the frontend News surface
_POS_COLOR  = 0x3F_B9_50  # green  — net-bullish batch
_NEG_COLOR  = 0xF0_52_52  # red    — net-bearish batch

# Lightweight headline classifier: first matching category wins, so ordering is by
# specificity (earnings/analyst/deal before the generic "market move"). Each entry
# is (label, emoji, keywords). Matched against the lowercased title + summary.
_NEWS_CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    ("Earnings",    "📊", ("earnings", "quarter", "q1 ", "q2 ", "q3 ", "q4 ", "revenue",
                           "profit", " eps", "guidance", "results", "beats", "missed",
                           "forecast", "outlook")),
    ("Analyst",     "⭐", ("upgrade", "downgrade", "price target", "rating", "overweight",
                           "underweight", "outperform", "reiterat", "initiated", "analyst",
                           "buy rating", "sell rating", "hold rating")),
    # Who the company is teaming up with — surfaced separately from M&A.
    ("Partnership", "🤝", ("partner", "partners with", "partnership", "joint venture",
                           "alliance", "teams up", "teaming", "collaborat", "signs deal",
                           "signs agreement", "agreement with", "deal with", "supply deal",
                           "to supply", "tie-up")),
    # What the company is putting money/resources into (growth bets, not its own
    # capital structure — that's "Capital" below).
    ("Investment",  "💡", ("invest", "investment", "investing", "invests $", "capex",
                           "capital expenditure", "r&d", "research and development",
                           "to spend", "spending", "pours", "commits", "funding", "funds",
                           "backs", "builds", "building", "factory", "plant", "expand",
                           "expansion", "expanding into", "stake in", "takes stake",
                           "buys stake", "acquires stake", "bets on")),
    # M&A / control transactions.
    ("Deal",        "💼", ("acquisition", "acquires", "acquire", "merger", "merges",
                           "buyout", "takeover", "to buy", "purchase of", "divest",
                           "spinoff", "spin-off", "sells unit", "sells stake")),
    ("Legal",       "⚖️", ("lawsuit", "sues", "sued", "court", "regulat", "antitrust",
                           "probe", "investigat", "settlement", "fine", "fraud", "sec charges")),
    ("Management",  "👔", ("ceo", "cfo", "coo", "executive", "resign", "steps down",
                           "appoint", "named ", "board of directors", "successor")),
    ("Capital",     "💰", ("dividend", "buyback", "repurchase", "stock split", "offering",
                           "raises $", "debt", "bond sale", "capital raise")),
    ("Product",     "🚀", ("launch", "unveil", "announce", "introduc", "rollout", "release",
                           "new product", "reveal")),
    ("Market",      "📈", ("surge", "plunge", "soar", "tumble", "rally", "jumps", "slumps",
                           "sinks", "spikes", "rises", "falls", "drops", "gains", "record high",
                           "52-week", "all-time high", "sell-off", "selloff")),
]


def _classify(title: str, summary: str | None) -> tuple[str, str]:
    """Return (label, emoji) for a headline from its title + summary keywords."""
    hay = f"{title} {summary or ''}".lower()
    for label, emoji, keywords in _NEWS_CATEGORIES:
        if any(k in hay for k in keywords):
            return label, emoji
    return "News", "📰"


# Directional keywords → a rough bullish/bearish read a trader can scan at a glance.
_BULLISH = (
    "surge", "soar", "jump", "rally", "beat", "beats", "tops", "upgrade", "raised",
    "raises", "record high", "all-time high", "outperform", "buy rating", "gains",
    "gain", "rises", "rise", "wins", "approval", "approved", "strong", "boost",
    "spike", "rebound", "higher", "buyback", "hikes dividend", "up ",
)
_BEARISH = (
    "plunge", "plummet", "tumble", "slump", "sink", "miss", "misses", "downgrade",
    "cut", "cuts", "lowered", "lowers", "lawsuit", "sues", "sued", "probe",
    "investigat", "fraud", "recall", "warning", "falls", "fall", "drops", "drop",
    "decline", "weak", "loss", "losses", "bankrupt", "halt", "sell-off", "selloff",
    "slashes", "layoff", "layoffs", "underperform", "down ", "slides", "slide",
)


def _sentiment(title: str, summary: str | None) -> tuple[str, str, int]:
    """Rough directional read of a headline → (label, emoji, score in {-1,0,1})."""
    hay = f"{title} {summary or ''}".lower()
    bull = sum(1 for k in _BULLISH if k in hay)
    bear = sum(1 for k in _BEARISH if k in hay)
    if bull > bear:
        return "Bullish", "🟢", 1
    if bear > bull:
        return "Bearish", "🔴", -1
    return "Neutral", "⚪", 0


# Clause markers that introduce the REASON / driver behind a move ("what is behind").
# Ordered longest/most-specific first so the extracted phrase starts at the right spot.
_WHY_MARKERS: tuple[str, ...] = (
    " driven by ", " boosted by ", " helped by ", " hurt by ", " thanks to ",
    " due to ", " because of ", " because ", " citing ", " on concerns", " on hopes",
    " on strong ", " on weak ", " on news ", " on report", " following ", " amid ",
    " after ", " as it ", " as the ", " over ",
)


def _why(title: str, summary: str | None) -> str | None:
    """Extract the 'what's behind it' driver clause from a headline/summary, or None.

    Heuristic: find the earliest reason-marker ('driven by', 'after', 'citing', …)
    and return the clause it introduces, trimmed to one sentence. Prefers the fuller
    summary text, falling back to the title.
    """
    for text in (summary, title):
        if not text:
            continue
        low = text.lower()
        hit = min(((low.find(m), m) for m in _WHY_MARKERS if m in low),
                  default=None, key=lambda x: x[0])
        if not hit:
            continue
        i, _ = hit
        phrase = text[i:].strip()
        for sep in (". ", "; ", " — ", " – "):  # cut at the first sentence boundary
            j = phrase.find(sep)
            if j != -1:
                phrase = phrase[:j]
        phrase = phrase.strip().rstrip(".").strip()
        if len(phrase) < 6:
            continue
        return phrase[:157] + "…" if len(phrase) > 160 else phrase
    return None


def _fmt_pct(x: Any) -> str | None:
    """Format a percent value (already in %) as a signed arrow string, or None."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    arrow = "▲" if v >= 0 else "▼"
    return f"{arrow} {v:+.2f}%"


def _fmt_usd_compact(x: Any) -> str | None:
    """Format a signed USD amount compactly (+$1.2M / -$430K), or None."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    a, sign = abs(v), "+" if v >= 0 else "-"
    if a >= 1e9:
        s = f"{a / 1e9:.1f}B"
    elif a >= 1e6:
        s = f"{a / 1e6:.1f}M"
    elif a >= 1e3:
        s = f"{a / 1e3:.0f}K"
    else:
        s = f"{a:.0f}"
    return f"{sign}${s}"


def _market_line(market: dict[str, Any] | None) -> str | None:
    """Build the price-snapshot line for the embed (last, day, YTD, off 52w high)."""
    if not market:
        return None
    parts: list[str] = []
    last = market.get("last_close")
    if last is not None:
        try:
            asof = market.get("as_of")
            tag = f" ({asof})" if asof else ""
            parts.append(f"**${float(last):,.2f}**{tag}")
        except (TypeError, ValueError):
            pass
    day = _fmt_pct(market.get("chg_1d"))
    if day:
        parts.append(f"Day {day}")
    ytd = _fmt_pct(market.get("ret_ytd"))
    if ytd:
        parts.append(f"YTD {ytd}")
    off_high = market.get("pct_off_high")
    off = _fmt_pct(off_high)
    if off is not None and off_high is not None:
        parts.append(f"{off} off 52w high")
    return "  ·  ".join(parts) if parts else None


def _signals_line(market: dict[str, Any] | None) -> str | None:
    """Build the technicals + insider-flow line (RSI, MAs, volume, 52w flags, insider)."""
    if not market:
        return None
    parts: list[str] = []
    rsi = market.get("rsi14")
    if rsi is not None:
        try:
            r = float(rsi)
            tag = " overbought" if r >= 70 else " oversold" if r <= 30 else ""
            parts.append(f"RSI {r:.0f}{tag}")
        except (TypeError, ValueError):
            pass
    p50 = _fmt_pct(market.get("pct_from_50"))
    if p50:
        parts.append(f"50D {p50}")
    p200 = _fmt_pct(market.get("pct_from_200"))
    if p200:
        parts.append(f"200D {p200}")
    cross = market.get("ma_cross")
    if cross == "golden":
        parts.append("⚡ Golden cross")
    elif cross == "death":
        parts.append("☠️ Death cross")
    vs = market.get("vol_spike")
    try:
        if vs is not None and float(vs) >= 1.5:
            parts.append(f"Vol {float(vs):.1f}×")
    except (TypeError, ValueError):
        pass
    if market.get("new_52w_high"):
        parts.append("🚀 New 52W high")
    if market.get("new_52w_low"):
        parts.append("⚠️ New 52W low")
    insider = _fmt_usd_compact(market.get("net_insider_90d"))
    if insider and market.get("net_insider_90d"):
        parts.append(f"Insider 90d {insider}")
    if market.get("cluster_buy"):
        parts.append("👥 Cluster buy")
    return "  ·  ".join(parts) if parts else None


def _epoch(iso: str | None) -> int | None:
    """Parse an ISO-8601 timestamp into a Unix epoch (for Discord <t:…> markdown)."""
    if not iso:
        return None
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except (TypeError, ValueError):
        return None


def _md_escape(text: str) -> str:
    """Neutralize markdown link syntax in a headline so it can't break the embed."""
    return text.replace("[", "(").replace("]", ")")


# Markdown-significant / mention characters stripped from company labels. Tickers
# and names reach the embeds from the anon-INSERTable `watchlist` table (no DB
# constraint), so treat them as untrusted: without this, a queued "company" named
# `[claim airdrop](https://evil.example)` would render as a live link in Discord.
_LABEL_STRIP = re.compile(r"[\[\]()*_~`|\\<>@]")  # newlines handled by the \s+ collapse


def _label(text: Any, cap: int = 60) -> str:
    """Sanitize an untrusted company ticker/name for safe embed markdown."""
    if text is None:
        return "?"
    clean = _LABEL_STRIP.sub("", str(text))
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:cap] or "?"


def _safe_link(url: Any) -> str | None:
    """Return an http(s) URL safe to place inside `[text](url)` markdown, or None.

    Percent-encodes parens so a crafted URL can't close the link early and smuggle
    trailing markdown into the embed.
    """
    if not url or not str(url).startswith(("http://", "https://")):
        return None
    return str(url).replace("(", "%28").replace(")", "%29")


# Category → emoji (mirrors news_score.CATEGORY_EMOJI); used for the field headers.
_CAT_EMOJI: dict[str, str] = {
    "Fed": "🏦", "Macro": "🏛️", "M&A": "💼", "Investment": "💡", "FDA": "💊",
    "Legal": "⚖️", "Earnings": "📊", "Distress": "🚨", "Capital": "💰",
    "Exec": "👔", "Analyst": "⭐", "Product": "🚀", "Move": "📉", "News": "📰",
}


def _clean_title(title: str, source: str | None = None) -> str:
    """Drop the trailing ' - Publisher' suffix Google News appends, for a clean headline."""
    if " - " in title:
        head, _, tail = title.rpartition(" - ")
        t = tail.strip()
        if head and ((source and t.lower() == source.strip().lower())
                     or (0 < len(t) <= 40 and "?" not in t and "!" not in t)):
            return head.strip()
    return title


def _headline_field(it: dict[str, Any]) -> tuple[str, str, int]:
    """Build one richly-described Discord embed field (name, value, sentiment_score).

    name  = "emoji Category · 🔴 catalyst-tier" (Discord renders it bold).
    value = linked title → summary → the 'behind it' driver → a signals line
            (direction · ⚡impact/10 · source ✅credibility · relative time).
    """
    title = _clean_title((it.get("title") or "(untitled)").strip(), it.get("source"))
    if len(title) > 200:
        title = title[:199] + "…"
    link = it.get("link")
    src = it.get("source") or ""
    summary = (it.get("summary") or "").strip()
    cat = it.get("category") or _classify(title, it.get("summary"))[0]
    emoji = _CAT_EMOJI.get(cat, "📰")
    sent_label, sent_emoji, score = _sentiment(title, it.get("summary"))
    epoch = _epoch(it.get("published_at"))
    impact = int(it.get("importance") or 0)

    # Catalyst tier + source credibility from the shared scorer (fallback: plain).
    if news_score is not None:
        tier, tier_emoji = news_score.catalyst_tier(impact)
        cred = news_score.source_weight(src)
    else:
        tier, tier_emoji, cred = "", "", 0

    name = f"{emoji}  {cat}"
    if tier_emoji and tier:
        name += f"  ·  {tier_emoji} {tier}"
    name = name[:256]

    safe_url = _safe_link(link)
    linked = f"[{_md_escape(title)}]({safe_url})" if safe_url else _md_escape(title)
    lines = [linked]
    if summary and summary.lower() != title.lower():
        snip = summary if len(summary) <= 240 else summary[:237] + "…"
        lines.append(f"> {_md_escape(snip)}")
    why = _why(title, it.get("summary"))
    if why and why.lower() not in summary.lower():
        lines.append(f"🔎 **Behind it:** {_md_escape(why)}")
    # Signals line: direction · impact score · source (✅ = high-credibility) · time.
    meta = f"{sent_emoji} {sent_label}"
    if impact:
        meta += f"  ·  ⚡ {impact}/10"
    if src:
        meta += f"  ·  {_label(src, 40)}{' ✅' if cred >= 3 else ''}"
    if epoch is not None:
        meta += f"  ·  <t:{epoch}:R>"
    lines.append(meta)
    return name, "\n".join(lines)[:1024], score


def _digest(items: list[dict[str, Any]]) -> str:
    """A compact category tally, e.g. '💼 M&A ×2  ·  📉 Move  ·  ⭐ Analyst'."""
    counts: dict[str, int] = {}
    for it in items:
        c = it.get("category") or _classify(it.get("title") or "", it.get("summary"))[0]
        counts[c] = counts.get(c, 0) + 1
    parts = []
    for c, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        em = _CAT_EMOJI.get(c, "📰")
        parts.append(f"{em} {c} ×{n}" if n > 1 else f"{em} {c}")
    return "  ·  ".join(parts)


def notify_news(
    ticker: str,
    company_name: str | None,
    items: list[dict[str, Any]],
    market: dict[str, Any] | None = None,
    max_items: int = 6,
) -> None:
    """Post one trader-oriented Discord embed for a company's NEW headlines.

    Each headline shows the WHAT (category), the DIRECTION (bullish/bearish/neutral),
    the WHEN (absolute date + relative time), a one-line summary, and the source.
    A price snapshot (last close, day %, YTD %, distance off the 52-week high) is
    prepended when `market` (a company_summary row) is supplied. No-op without a
    webhook or new items; fail-soft (a webhook error never propagates).
    """
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook or not items:
        return

    try:
        import requests
    except ImportError:
        logger.warning("requests not installed — skipping Discord news notification")
        return

    shown = items[:max_items]
    net = 0  # aggregate sentiment → drives the embed color
    fields: list[dict[str, Any]] = []
    for it in shown:
        name, value, score = _headline_field(it)
        net += score
        fields.append({"name": name, "value": value, "inline": False})
    extra = len(items) - len(shown)
    if extra > 0:
        fields.append({"name": "⋯", "value": f"_+{extra} more headline{'s' if extra != 1 else ''}_", "inline": False})

    label = (f"{_label(company_name)} ({_label(ticker, 12)})" if company_name
             else _label(ticker, 12) if ticker else "News")
    n = len(items)
    color = _POS_COLOR if net > 0 else _NEG_COLOR if net < 0 else _NEWS_COLOR
    embed: dict[str, Any] = {
        "title": f"📰  {label}",
        "color": color,
        "fields": fields,
        "footer": {"text": f"Summa · {n} new · Google News"},
    }
    # Description = price snapshot (price + technicals/insider lines) + a category digest.
    snapshot = [ln for ln in (_market_line(market), _signals_line(market)) if ln]
    snapshot.append(f"🗂️ {_digest(shown)}")
    embed["description"] = "\n".join(snapshot)[:4000]
    # Stamp the embed with the newest headline's time (shown by Discord in the footer).
    newest_iso = next((it.get("published_at") for it in shown if it.get("published_at")), None)
    if newest_iso:
        embed["timestamp"] = newest_iso

    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
        if resp.status_code >= 400:
            logger.warning("Discord news webhook returned %s: %s", resp.status_code, resp.text[:200])
    except requests.RequestException:
        logger.exception("Discord news webhook post failed for %s", ticker)


def notify_market_news(items: list[dict[str, Any]], max_items: int = 6) -> None:
    """Post one embed for new market-wide 'Top Intelligence' items (already curated).

    `items` are market_news row dicts (title/link/source/category/summary/published_at),
    ideally pre-sorted most-important first. No-op without a webhook or items.
    """
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook or not items:
        return
    try:
        import requests
    except ImportError:
        logger.warning("requests not installed — skipping Discord market-news notification")
        return

    shown = items[:max_items]
    net = 0
    fields: list[dict[str, Any]] = []
    for it in shown:
        name, value, score = _headline_field(it)
        net += score
        fields.append({"name": name, "value": value, "inline": False})
    extra = len(items) - len(shown)
    if extra > 0:
        fields.append({"name": "⋯", "value": f"_+{extra} more alert{'s' if extra != 1 else ''}_", "inline": False})

    n = len(items)
    color = _POS_COLOR if net > 0 else _NEG_COLOR if net < 0 else _NEWS_COLOR
    embed: dict[str, Any] = {
        "title": "🔥  Top Market Intelligence",
        "color": color,
        "description": f"🗂️ {_digest(shown)}",
        "fields": fields,
        "footer": {"text": f"Summa · {n} new · Market Intelligence"},
    }
    newest_iso = next((it.get("published_at") for it in shown if it.get("published_at")), None)
    if newest_iso:
        embed["timestamp"] = newest_iso

    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
        if resp.status_code >= 400:
            logger.warning("Discord market-news webhook returned %s: %s", resp.status_code, resp.text[:200])
    except requests.RequestException:
        logger.exception("Discord market-news webhook post failed")


_REDDIT_COLOR = 0xFF_45_00  # Reddit orange
_MEDALS = ("🥇", "🥈", "🥉")

_SENTIMENT_EMOJI = {"bullish": "🟢", "bearish": "🔴"}


def _fmt_count(x: Any) -> str | None:
    """Format a mention/upvote count compactly (12,431 → '12.4K'), or None."""
    try:
        v = int(x)
    except (TypeError, ValueError):
        return None
    return f"{v / 1000:.1f}K" if v >= 10_000 else f"{v:,}"


_TICKER_LINK_RE = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")


def _reddit_line(i: int, r: dict[str, Any], watched: set[str]) -> str:
    """One two-line digest entry: name/link header + a trader stats line.

    Header:  '🥇 **[MU](apewisdom…)** ⭐ — Micron Technology'
    Stats:   '$984.75 ▲ +0.9% · 5d ▲ +12.3% · vol 2.1× · 💬 540 (▲ +391) · rank ▲3 · ⬆ 2.3K · 🟢 Bullish'
    """
    medal = _MEDALS[i] if i < len(_MEDALS) else f"`{i + 1:>2}.`"
    tk = _label(r.get("ticker"), 12)
    # Click-through to the ticker's ApeWisdom page (the actual Reddit chatter).
    # Only linkify strictly-shaped tickers; anything odd renders as plain text.
    shown = (f"[**{tk}**](https://apewisdom.io/stocks/{tk}/)"
             if _TICKER_LINK_RE.match(tk) else f"**{tk}**")
    header = f"{medal} {shown}" + (" ⭐" if tk in watched else "")
    if r.get("is_etf"):
        header += "  —  🏦 ETF"
        name = _label(r.get("name"), 40) if r.get("name") else ""
        if name and name != "?":
            header += f" · {name}"
    else:
        name = _label(r.get("name"), 40) if r.get("name") else ""
        if name and name != "?":
            header += f"  —  {name}"

    parts: list[str] = []
    # Live trader context (attached by reddit_trends_ingest, display-only).
    try:
        px = f"${float(r['last_price']):,.2f}"
        day = _fmt_pct(r.get("day_pct"))
        parts.append(f"{px} {day}" if day else px)
    except (KeyError, TypeError, ValueError):
        pass
    ret5 = _fmt_pct(r.get("ret_5d"))
    if ret5:
        parts.append(f"5d {ret5}")
    try:
        vs = float(r["vol_spike"])
        if vs >= 1.5:  # only flag genuinely-elevated trading volume
            parts.append(f"vol {vs:.1f}×")
    except (KeyError, TypeError, ValueError):
        pass
    try:
        off = float(r["off_high_pct"])
        if off >= -2.0:
            parts.append("🚀 near 52w high")
        elif off <= -15.0:
            parts.append(f"{abs(off):.0f}% off 52w high")
    except (KeyError, TypeError, ValueError):
        pass
    mentions = _fmt_count(r.get("mentions"))
    if mentions:
        m = f"💬 {mentions}"
        try:
            delta = int(r["mentions_change"])
            m += f" ({'▲' if delta >= 0 else '▼'} {delta:+,})"
        except (KeyError, TypeError, ValueError):
            pass
        parts.append(m)
    try:
        rc = int(r["rank_change"])
        if rc:
            parts.append(f"rank {'▲' if rc > 0 else '▼'}{abs(rc)}")
        else:
            parts.append("rank ●")
    except (KeyError, TypeError, ValueError):
        pass
    upvotes = _fmt_count(r.get("upvotes"))
    if upvotes:
        parts.append(f"⬆ {upvotes}")
    sent = (r.get("sentiment") or "").strip()
    if sent:
        emoji = _SENTIMENT_EMOJI.get(sent.lower(), "⚪")
        parts.append(f"{emoji} {_label(sent, 12)}")
    return header + ("\n" + "  ·  ".join(parts) if parts else "")


def notify_reddit_trends(rows: list[dict[str, Any]],
                         watchlist_tickers: set[str] | None = None,
                         surge: bool = False) -> None:
    """Post ONE embed digest of today's most-discussed stocks on Reddit.

    `surge=True` renders the compact intraday variant — an amber "surging right
    now" alert for tickers that just broke into the top ranks — instead of the
    full morning leaderboard.

    `rows` are reddit_trends row dicts (ticker/name/rank/mentions/upvotes/
    rank_change/mentions_change/sentiment/source), already ranked and capped by
    the caller (reddit_trends_ingest). Watchlist tickers get a ⭐. Posts to the
    dedicated DISCORD_REDDIT_WEBHOOK_URL when set (its own channel), otherwise
    falls back to the shared DISCORD_WEBHOOK_URL. No-op without either webhook
    or rows; fail-soft (a webhook error never propagates).
    """
    webhook = (os.environ.get("DISCORD_REDDIT_WEBHOOK_URL")
               or os.environ.get("DISCORD_WEBHOOK_URL"))
    if not webhook or not rows:
        return
    try:
        import requests
    except ImportError:
        logger.warning("requests not installed — skipping Discord reddit-trends notification")
        return

    watched = {t.upper() for t in (watchlist_tickers or set())}
    # Header: aggregate vote/mention volume across the digest, at a glance.
    total_mentions = sum(int(r["mentions"]) for r in rows
                         if str(r.get("mentions") or "").lstrip("-").isdigit())
    total_upvotes = sum(int(r["upvotes"]) for r in rows
                        if str(r.get("upvotes") or "").lstrip("-").isdigit())
    header_bits = [f"{len(rows)} newly surging" if surge else f"top {len(rows)}"]
    if total_mentions:
        header_bits.append(f"💬 {_fmt_count(total_mentions)} mentions")
    if total_upvotes:
        header_bits.append(f"🗳️ {_fmt_count(total_upvotes)} upvotes")
    lines = ["  ·  ".join(header_bits), ""]
    lines += [_reddit_line(i, r, watched) for i, r in enumerate(rows)]
    hits = [_label(r.get("ticker"), 12) for r in rows
            if _label(r.get("ticker"), 12) in watched]
    if hits:
        lines.append("")
        lines.append(f"⭐ on your watchlist: {'  ·  '.join(f'**{t}**' for t in hits)}")

    source = str(rows[0].get("source") or "")
    scope = ("r/wallstreetbets" if source.startswith("tradestie")
             else "Reddit stock subreddits")
    title = ("⚡  Reddit surge — climbing the board right now" if surge
             else "🚀  Reddit Trending Stocks — today's most discussed")
    embed: dict[str, Any] = {
        "title": title,
        "color": 0xF5_A6_23 if surge else _REDDIT_COLOR,  # amber = act-now signal
        "description": "\n".join(lines)[:4000],
        "footer": {"text": f"Summa · {'intraday surge' if surge else f'top {len(rows)} by mentions'}"
                           f" · {scope} (ApeWisdom/Tradestie) · not investment advice"},
    }
    trend_date = rows[0].get("trend_date")
    if trend_date:
        embed["timestamp"] = f"{trend_date}T00:00:00Z"

    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
        if resp.status_code >= 400:
            logger.warning("Discord reddit-trends webhook returned %s: %s",
                           resp.status_code, resp.text[:200])
    except requests.RequestException:
        logger.exception("Discord reddit-trends webhook post failed")


# Feed form → (emoji, trader-facing label, embed color). 8-K is the market-moving
# one (material events) so it gets the amber "pay attention" color.
_FILING_FORM_META: dict[str, tuple[str, str, int]] = {
    "8-K":     ("⚡", "Material event report", 0xF5_A6_23),
    "10-Q":    ("📊", "Quarterly report",      0x4F_8D_D4),
    "10-K":    ("📚", "Annual report",         0x4F_8D_D4),
    "DEF 14A": ("🗳️", "Proxy statement",       0x4F_D4_C2),
}


def notify_filings(ticker: str, name: str | None, filings: list[dict[str, Any]],
                   max_items: int = 6) -> None:
    """Post one embed for a company's genuinely-NEW SEC feed filings.

    `filings` are `filings` row dicts (form_type/filed_at/filing_url/accession_number),
    already filtered to the new+recent delta by the caller (filings_ingest). No-op
    without a webhook or items; fail-soft (a webhook error never propagates).
    """
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook or not filings:
        return
    try:
        import requests
    except ImportError:
        logger.warning("requests not installed — skipping Discord filing notification")
        return

    shown = filings[:max_items]
    fields: list[dict[str, Any]] = []
    color = _NEWS_COLOR
    for f in shown:
        form = f.get("form_type") or "?"
        emoji, label, form_color = _FILING_FORM_META.get(form, ("📄", "SEC filing", _NEWS_COLOR))
        if form == "8-K":
            color = form_color          # any 8-K in the batch wins the amber color
        elif color == _NEWS_COLOR:
            color = form_color
        value_lines = []
        url = _safe_link(f.get("filing_url"))
        if url:
            value_lines.append(f"[Open filing on EDGAR]({url})")
        epoch = _epoch(f.get("filed_at"))
        if epoch is not None:
            value_lines.append(f"Filed <t:{epoch}:R>")
        period = f.get("period_of_report")
        if period:
            value_lines.append(f"Period {period}")
        fields.append({"name": f"{emoji} {form}  ·  {label}",
                       "value": "\n".join(value_lines) or "​", "inline": False})
    extra = len(filings) - len(shown)
    if extra > 0:
        fields.append({"name": "⋯", "value": f"_+{extra} more filing{'s' if extra != 1 else ''}_",
                       "inline": False})

    label = (f"{_label(name)} ({_label(ticker, 12)})" if name
             else _label(ticker, 12) if ticker else "Filing")
    embed: dict[str, Any] = {
        "title": f"📄  {label} — new SEC filing{'s' if len(filings) != 1 else ''}",
        "color": color,
        "fields": fields,
        "footer": {"text": f"Summa · {len(filings)} new · EDGAR"},
    }
    newest_iso = next((f.get("filed_at") for f in shown if f.get("filed_at")), None)
    if newest_iso:
        embed["timestamp"] = newest_iso

    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
        if resp.status_code >= 400:
            logger.warning("Discord filing webhook returned %s: %s", resp.status_code, resp.text[:200])
    except requests.RequestException:
        logger.exception("Discord filing webhook post failed for %s", ticker)


def _tk(r: dict[str, Any]) -> str:
    """Sanitized ticker (fallback cik) label for brief lines — untrusted upstream."""
    return _label(r.get("ticker") or r.get("cik"), 12)


def _brief_mover_line(r: dict[str, Any]) -> str:
    """One mover line for the daily brief: '**AAPL**  ▲ +2.31%  ·  $212.44'."""
    parts = [f"**{_tk(r)}**"]
    day = _fmt_pct(r.get("chg_1d"))
    if day:
        parts.append(day)
    try:
        parts.append(f"${float(r['last_close']):,.2f}")
    except (KeyError, TypeError, ValueError):
        pass
    return "  ·  ".join(parts)


def _brief_fields(rows: list[dict[str, Any]], top_n: int = 3) -> list[dict[str, Any]]:
    """Build the daily-brief embed fields from company_summary rows (skip empties)."""
    def num(r: dict[str, Any], key: str) -> float | None:
        try:
            return float(r[key])
        except (KeyError, TypeError, ValueError):
            return None

    fields: list[dict[str, Any]] = []
    moved = sorted((r for r in rows if num(r, "chg_1d") is not None),
                   key=lambda r: float(r["chg_1d"]), reverse=True)
    gainers = [r for r in moved if float(r["chg_1d"]) > 0][:top_n]
    losers = [r for r in reversed(moved) if float(r["chg_1d"]) < 0][:top_n]
    if gainers:
        fields.append({"name": "📈 Top gainers", "inline": True,
                       "value": "\n".join(_brief_mover_line(r) for r in gainers)})
    if losers:
        fields.append({"name": "📉 Top decliners", "inline": True,
                       "value": "\n".join(_brief_mover_line(r) for r in losers)})

    highs = [r for r in rows if r.get("new_52w_high")]
    lows = [r for r in rows if r.get("new_52w_low")]
    if highs:
        fields.append({"name": "🚀 New 52-week highs", "inline": False,
                       "value": "  ·  ".join(f"**{_tk(r)}**" for r in highs)})
    if lows:
        fields.append({"name": "⚠️ New 52-week lows", "inline": False,
                       "value": "  ·  ".join(f"**{_tk(r)}**" for r in lows)})

    crosses = [f"⚡ **{_tk(r)}** golden cross" for r in rows if r.get("ma_cross") == "golden"]
    crosses += [f"☠️ **{_tk(r)}** death cross" for r in rows if r.get("ma_cross") == "death"]
    if crosses:
        fields.append({"name": "Trend crosses", "value": "\n".join(crosses), "inline": False})

    spikes = sorted((r for r in rows if (num(r, "vol_spike") or 0) >= 2.0),
                    key=lambda r: float(r["vol_spike"]), reverse=True)[:top_n]
    if spikes:
        fields.append({"name": "📊 Volume spikes", "inline": False,
                       "value": "\n".join(f"**{_tk(r)}**  ·  "
                                          f"{float(r['vol_spike']):.1f}× avg volume" for r in spikes)})

    flows = sorted((r for r in rows if num(r, "net_insider_90d")),
                   key=lambda r: abs(float(r["net_insider_90d"])), reverse=True)[:top_n]
    insider_lines = []
    for r in flows:
        amt = _fmt_usd_compact(r.get("net_insider_90d"))
        if amt:
            tag = "  👥 cluster buy" if r.get("cluster_buy") else ""
            insider_lines.append(f"**{_tk(r)}**  ·  90d {amt}{tag}")
    if insider_lines:
        fields.append({"name": "🧑‍💼 Insider flow", "value": "\n".join(insider_lines), "inline": False})

    hot = sorted((r for r in rows if (num(r, "rsi14") or 50) >= 70),
                 key=lambda r: float(r["rsi14"]), reverse=True)[:top_n]
    cold = sorted((r for r in rows if (num(r, "rsi14") or 50) <= 30),
                  key=lambda r: float(r["rsi14"]))[:top_n]
    rsi_lines = [f"🔥 **{_tk(r)}**  ·  RSI {float(r['rsi14']):.0f} overbought" for r in hot]
    rsi_lines += [f"🧊 **{_tk(r)}**  ·  RSI {float(r['rsi14']):.0f} oversold" for r in cold]
    if rsi_lines:
        fields.append({"name": "🌡️ RSI extremes", "value": "\n".join(rsi_lines), "inline": False})
    return fields[:25]  # Discord's embed field cap


def notify_daily_brief(
    rows: list[dict[str, Any]],
    upcoming_earnings: list[dict[str, Any]] | None = None,
) -> bool:
    """Post the daily watchlist market brief (one embed) from company_summary rows.

    `upcoming_earnings` items are {ticker, est_date, days_away} estimates (from
    tools/daily_brief.py); rendered as an "Earnings radar" field, always marked
    as estimates. Returns True if an embed was posted. No-op (False) without a
    webhook, rows, or anything brief-worthy; fail-soft like every other webhook path.
    """
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook or not rows:
        return False
    try:
        import requests
    except ImportError:
        logger.warning("requests not installed — skipping Discord daily brief")
        return False

    fields = _brief_fields(rows)
    if upcoming_earnings:
        lines = []
        for e in sorted(upcoming_earnings, key=lambda x: x.get("days_away", 0))[:8]:
            days = e.get("days_away")
            when = "any day now" if days is not None and days <= 0 else \
                   "tomorrow" if days == 1 else f"in ~{days}d"
            lines.append(f"**{_label(e.get('ticker'), 12)}**  ·  ~{e.get('est_date')}  ·  {when}")
        fields.append({"name": "📅 Earnings radar (estimated from filing cadence)",
                       "value": "\n".join(lines), "inline": False})
    if not fields:
        return False

    changes = []
    for r in rows:
        try:
            changes.append(float(r["chg_1d"]))
        except (KeyError, TypeError, ValueError):
            pass
    up = sum(1 for c in changes if c > 0)
    down = sum(1 for c in changes if c < 0)
    median = sorted(changes)[len(changes) // 2] if changes else 0.0
    breadth = (f"{len(rows)} tracked  ·  {up} up / {down} down"
               + (f"  ·  median day {_fmt_pct(median)}" if changes else ""))
    asof = max((r.get("as_of") or "" for r in rows), default="") or None

    embed: dict[str, Any] = {
        "title": "📋  Daily Watchlist Brief" + (f" — {asof}" if asof else ""),
        "color": _POS_COLOR if median > 0 else _NEG_COLOR if median < 0 else _NEWS_COLOR,
        "description": breadth,
        "fields": fields,
        "footer": {"text": "Summa · company_summary snapshot"},
    }
    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
        if resp.status_code >= 400:
            logger.warning("Discord daily-brief webhook returned %s: %s",
                           resp.status_code, resp.text[:200])
            return False
        return True
    except requests.RequestException:
        logger.exception("Discord daily-brief webhook post failed")
        return False


def _band(severity: float) -> tuple[int, str]:
    for floor, color, label in _SEVERITY_BANDS:
        if severity >= floor:
            return color, label
    return _SEVERITY_BANDS[-1][1], _SEVERITY_BANDS[-1][2]


def _fired_labels(signals: dict[str, Any]) -> list[str]:
    fired: list[str] = []
    for key in ("signal_supply_chain", "signal_geopolitical",
                "signal_mgmt_changes", "signal_earnings"):
        sig = signals.get(key)
        if isinstance(sig, dict) and sig.get("flagged"):
            fired.append(_SIGNAL_LABELS[key])
    if signals.get("risk_factor_delta", 0) > 0.25:
        fired.append(_SIGNAL_LABELS["r_delta_flagged"])
    for key in ("filing_velocity_flag", "friday_dump",
                "section_length_anomaly", "burst_8k_flag"):
        if signals.get(key):
            fired.append(_SIGNAL_LABELS[key])
    return fired


def send(
    company_name: str,
    ticker: str,
    form_type: str,
    filing_url: str | None,
    signals: dict[str, Any],
    enrichment: dict[str, Any] | None = None,
) -> None:
    """Post a rich embed for a flagged filing. No-op if no webhook configured."""
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook:
        return

    try:
        import requests
    except ImportError:
        logger.warning("requests not installed — skipping Discord notification")
        return

    severity = float(signals.get("severity_score") or 0)
    color, band_label = _band(severity)
    fired = _fired_labels(signals) or ["(structural signal)"]

    fields: list[dict[str, Any]] = [
        {"name": "Form",     "value": form_type, "inline": True},
        {"name": "Severity", "value": f"{int(severity)} · {band_label}", "inline": True},
        {"name": "Signals",  "value": ", ".join(fired), "inline": False},
    ]

    if enrichment and enrichment.get("summary"):
        summary = enrichment["summary"][:1_000]
        conf = enrichment.get("confidence")
        if conf is not None:
            summary += f"\n\n_confidence {float(conf):.0%}_"
        fields.append({"name": "AI summary", "value": summary, "inline": False})

    embed: dict[str, Any] = {
        "title": f"{_label(company_name)} ({_label(ticker, 12)})",
        "color": color,
        "fields": fields,
    }
    if filing_url and filing_url.startswith(("http://", "https://")):
        embed["url"] = filing_url

    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
        if resp.status_code >= 400:
            logger.warning("Discord webhook returned %s: %s", resp.status_code, resp.text[:200])
    except requests.RequestException:
        logger.exception("Discord webhook post failed for %s %s", ticker, form_type)
