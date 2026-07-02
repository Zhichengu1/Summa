"""
Discord webhook alerts.

Posts a single rich embed per flagged filing: company, form type, signals
fired, composite severity, AI summary excerpt, and a direct EDGAR link.
A silent no-op when DISCORD_WEBHOOK_URL is unset, so the pipeline still runs
without notifications configured.
"""

import logging
import os
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

    linked = (f"[{_md_escape(title)}]({link})"
              if link and str(link).startswith(("http://", "https://")) else _md_escape(title))
    lines = [linked]
    if summary and summary.lower() != title.lower():
        snip = summary if len(summary) <= 240 else summary[:237] + "…"
        lines.append(f"> {snip}")
    why = _why(title, it.get("summary"))
    if why and why.lower() not in summary.lower():
        lines.append(f"🔎 **Behind it:** {_md_escape(why)}")
    # Signals line: direction · impact score · source (✅ = high-credibility) · time.
    meta = f"{sent_emoji} {sent_label}"
    if impact:
        meta += f"  ·  ⚡ {impact}/10"
    if src:
        meta += f"  ·  {src}{' ✅' if cred >= 3 else ''}"
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

    label = f"{company_name} ({ticker})" if company_name else (ticker or "News")
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
        "title": f"{company_name} ({ticker})",
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
