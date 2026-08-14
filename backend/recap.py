"""Deterministic daily watchlist recap — narrative prose, no LLM.

Turns the precomputed `company_summary` rows (plus optional sector labels and an
earnings radar) into a short plain-English wrap of the session: breadth, the
names that led and lagged, sector leadership, technical milestones, unusual
volume, filing activity, insider flow, and what is coming up.

Pure and I/O-free by design — every sentence is assembled from stored numbers by
the templates below, so the same rows always produce the same text, nothing is
inferred, and no external service is involved. `tools/daily_recap.py` supplies
the data; `enrichment/discord_notify.notify_daily_recap` renders it.

Freshness caveat: `company_summary` is recomputed when the pipeline visits a
company, so the recap describes the latest precompute, not necessarily the
current instant. Every paragraph is anchored to the snapshot's `as_of` session
date rather than "today" so the text can never overstate how fresh it is.
"""

import datetime as _dt
import logging
import re
import statistics
from typing import Any, TypedDict

logger = logging.getLogger(__name__)

# Thresholds — deliberately the same ones the Discord brief and the frontend use,
# so a name called "overbought"/"spiking" here matches every other surface.
_TOP_N = 3
_VOL_SPIKE_MIN = 2.0
_RSI_HOT = 70.0
_RSI_COLD = 30.0
_FILING_WINDOW_H = 24
_MAX_CHARS = 3_900  # Discord embed descriptions cap at 4096

# Earnings radar window (mirrors tools/daily_brief.py): a few days overdue still
# reads as "any day now" because the estimate drifts run to run.
_RADAR_AHEAD_DAYS = 10
_RADAR_OVERDUE_DAYS = 5

# Markdown/mention characters stripped from DB-sourced labels before they land in
# a Discord message (same guard as discord_notify._label).
_STRIP = re.compile(r"[\[\]()*_~`|\\<>@]")

_NUMBER_WORDS = {
    1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five",
    6: "Six", 7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten",
}


class Recap(TypedDict):
    """One rendered recap: a title, prose paragraphs, and the tone/scale stats."""

    as_of: str | None
    title: str
    paragraphs: list[str]
    median_chg: float | None
    companies: int


# ─── Formatting helpers ─────────────────────────────────────────────────────────

def _num(row: dict[str, Any], key: str) -> float | None:
    """Best-effort float for a summary column; None when absent or unparseable."""
    try:
        value = row[key]
    except KeyError:
        return None
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _tkr(row: dict[str, Any]) -> str:
    """Sanitized ticker label (falls back to CIK) — upstream text is untrusted."""
    raw = str(row.get("ticker") or row.get("cik") or "?")
    return _STRIP.sub("", raw).strip()[:12] or "?"


def _pct(value: float | None, places: int = 1) -> str:
    """Signed percentage, e.g. '+2.3%'. Empty string when there is no value."""
    if value is None:
        return ""
    return f"{value:+.{places}f}%"


def _price(value: float | None) -> str:
    """Plain dollar price, e.g. '$178.42'. Empty string when there is no value."""
    if value is None:
        return ""
    return f"${value:,.2f}"


def _money(value: float | None) -> str:
    """Compact signed dollar amount, e.g. '-$8.1M'. Empty when there is no value."""
    if value is None:
        return ""
    sign = "-" if value < 0 else ""
    amount = abs(value)
    for cutoff, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if amount >= cutoff:
            return f"{sign}${amount / cutoff:,.1f}{suffix}"
    return f"{sign}${amount:,.0f}"


def _oxford(items: list[str], conj: str = "and") -> str:
    """Join a list into readable prose: 'A', 'A and B', 'A, B and C'."""
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} {conj} {items[1]}"
    return f"{', '.join(items[:-1])} {conj} {items[-1]}"


def _count(n: int, singular: str, plural: str | None = None) -> str:
    """'1 company' / '4 companies' — digits, for mid-sentence use."""
    return f"{n} {singular if n == 1 else (plural or singular + 's')}"


def _lead_count(n: int, singular: str, plural: str | None = None) -> str:
    """Same as _count but spelled out, so a sentence never opens with a digit."""
    word = _NUMBER_WORDS.get(n)
    noun = singular if n == 1 else (plural or singular + "s")
    return f"{word} {noun}" if word else f"{n} {noun}"


def _named(row: dict[str, Any], value: float | None, places: int = 1) -> str:
    """'NVDA (+4.2%)' — a ticker with its move in parentheses."""
    move = _pct(value, places)
    return f"{_tkr(row)} ({move})" if move else _tkr(row)


# ─── Earnings estimate (shared with tools/daily_brief.py) ───────────────────────

def next_earnings_estimate(dates: list[str]) -> tuple[str, int] | None:
    """(est ISO date, days away) from past report dates, or None.

    Python port of the frontend's lib/domain/catalysts.ts nextEarningsEstimate:
    needs >= 3 dates and a quarterly-ish median gap (45-200 days) so we never
    fabricate a date from sparse or noisy history. Always an estimate, never a
    promise.
    """
    parsed: set[_dt.date] = set()
    for value in dates:
        if not value:
            continue
        try:
            parsed.add(_dt.date.fromisoformat(value[:10]))
        except (TypeError, ValueError):
            continue
    ordered = sorted(parsed)
    if len(ordered) < 3:
        return None
    gaps = [(b - a).days for a, b in zip(ordered, ordered[1:])]
    median_gap = statistics.median_low(gaps)
    if not 45 <= median_gap <= 200:
        return None  # not a clean quarterly cadence
    estimate = ordered[-1] + _dt.timedelta(days=median_gap)
    return estimate.isoformat(), (estimate - _dt.date.today()).days


def earnings_radar(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Watchlist companies estimated to report inside the radar window.

    `rows` are (cik, ticker, reported_date) earnings_events records; companies
    without a clean quarterly cadence are simply omitted.
    """
    by_cik: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = by_cik.setdefault(row["cik"], {"ticker": row.get("ticker"), "dates": []})
        if row.get("reported_date"):
            entry["dates"].append(row["reported_date"])
        if row.get("ticker"):
            entry["ticker"] = row["ticker"]

    radar: list[dict[str, Any]] = []
    for cik, entry in by_cik.items():
        estimate = next_earnings_estimate(entry["dates"])
        if estimate and -_RADAR_OVERDUE_DAYS <= estimate[1] <= _RADAR_AHEAD_DAYS:
            radar.append({
                "ticker": entry["ticker"] or cik,
                "est_date": estimate[0],
                "days_away": estimate[1],
            })
    return sorted(radar, key=lambda r: r["days_away"])


# ─── Paragraph builders (each returns None when it has nothing to say) ──────────

def _breadth(rows: list[dict[str, Any]], median: float | None) -> str:
    """Opening paragraph: how many names moved which way, and the median move."""
    priced = [(r, c) for r, c in ((r, _num(r, "chg_1d")) for r in rows) if c is not None]
    total = len(rows)
    if not priced:
        return (f"{_lead_count(total, 'company', 'companies')} tracked, with no "
                "price change recorded in the latest snapshot.")

    # How much of the watchlist this recap actually speaks for.
    opening = (f"{_lead_count(total, 'company', 'companies')} tracked."
               if len(priced) == total else
               f"{_lead_count(len(priced), 'name')} priced out of "
               f"{_count(total, 'company', 'companies')} tracked.")
    if len(priced) == 1:
        row, change = priced[0]
        return f"{opening} {_tkr(row)} moved {_pct(change, 2)}."

    changes = [c for _, c in priced]
    up = sum(1 for c in changes if c > 0)
    down = sum(1 for c in changes if c < 0)
    flat = len(changes) - up - down

    if up or down:
        tone = ("Advancers led decliners" if up > down else
                "Decliners led advancers" if down > up else
                "Advancers and decliners finished even")
        detail = f" {tone}, {up} to {down}"
        detail += f", with {_count(flat, 'name')} unchanged" if flat else ""
    else:
        detail = " Every priced name finished unchanged"
    if median is not None:
        detail += f", and the median name moved {_pct(median, 2)}"
    return opening + detail + "."


def _movers(rows: list[dict[str, Any]]) -> str | None:
    """Who led and who lagged, with the leader's closing price for scale."""
    moved = sorted(
        (r for r in rows if _num(r, "chg_1d") is not None),
        key=lambda r: _num(r, "chg_1d") or 0.0,
        reverse=True,
    )
    if not moved:
        return None

    gainers = [r for r in moved if (_num(r, "chg_1d") or 0) > 0][:_TOP_N]
    losers = [r for r in reversed(moved) if (_num(r, "chg_1d") or 0) < 0][:_TOP_N]
    if not gainers and not losers:
        return "No name in the watchlist finished the session with a price change."

    sentences: list[str] = []
    if gainers:
        lead, rest = gainers[0], gainers[1:]
        close = _price(_num(lead, "last_close"))
        opening = f"{_tkr(lead)} led at {_pct(_num(lead, 'chg_1d'), 2)}"
        opening += f", closing at {close}" if close else ""
        if rest:
            opening += f", followed by {_oxford([_named(r, _num(r, 'chg_1d'), 2) for r in rest])}"
        sentences.append(opening + ".")
    if losers:
        worst, rest = losers[0], losers[1:]
        opening = f"{_tkr(worst)} lagged at {_pct(_num(worst, 'chg_1d'), 2)}"
        if rest:
            opening += f", alongside {_oxford([_named(r, _num(r, 'chg_1d'), 2) for r in rest])}"
        sentences.append(opening + ".")
    return " ".join(sentences)


def _sectors(rows: list[dict[str, Any]],
             sectors: dict[str, tuple[str | None, str | None]]) -> str | None:
    """Strongest vs weakest sector, only when at least two groups have >= 2 names."""
    if not sectors:
        return None

    grouped: dict[str, list[float]] = {}
    for row in rows:
        change = _num(row, "chg_1d")
        label = (sectors.get(_tkr(row).upper()) or (None, None))[0]
        if change is None or not label:
            continue
        grouped.setdefault(_STRIP.sub("", str(label)).strip()[:40], []).append(change)

    ranked = sorted(
        ((name, statistics.fmean(vals), len(vals))
         for name, vals in grouped.items() if len(vals) >= 2),
        key=lambda x: x[1], reverse=True,
    )
    if len(ranked) < 2:
        return None

    best, worst = ranked[0], ranked[-1]
    return (f"By sector, {best[0]} was the strongest group at {_pct(best[1], 2)} "
            f"average across {_count(best[2], 'name')}, and {worst[0]} the weakest at "
            f"{_pct(worst[1], 2)} across {_count(worst[2], 'name')}.")


def _milestones(rows: list[dict[str, Any]]) -> str | None:
    """52-week highs/lows and moving-average crosses."""
    parts: list[str] = []
    highs = [_tkr(r) for r in rows if r.get("new_52w_high")]
    lows = [_tkr(r) for r in rows if r.get("new_52w_low")]
    golden = [_tkr(r) for r in rows if r.get("ma_cross") == "golden"]
    death = [_tkr(r) for r in rows if r.get("ma_cross") == "death"]

    if highs:
        parts.append(f"{_oxford(highs)} closed at "
                     f"{'new 52-week highs' if len(highs) > 1 else 'a new 52-week high'}.")
    if lows:
        parts.append(f"{_oxford(lows)} closed at "
                     f"{'new 52-week lows' if len(lows) > 1 else 'a new 52-week low'}.")
    if golden:
        parts.append(f"{_oxford(golden)} completed a golden cross "
                     f"({'50-day averages' if len(golden) > 1 else 'the 50-day average'} "
                     "crossing above the 200-day).")
    if death:
        parts.append(f"{_oxford(death)} completed a death cross "
                     f"({'50-day averages' if len(death) > 1 else 'the 50-day average'} "
                     "crossing below the 200-day).")
    return " ".join(parts) if parts else None


def _unusual(rows: list[dict[str, Any]]) -> str | None:
    """Volume spikes and RSI extremes — where the session was not routine."""
    parts: list[str] = []

    spikes = sorted(
        (r for r in rows if (_num(r, "vol_spike") or 0) >= _VOL_SPIKE_MIN),
        key=lambda r: _num(r, "vol_spike") or 0.0, reverse=True,
    )[:_TOP_N]
    if spikes:
        described = [f"{_tkr(r)} ({_num(r, 'vol_spike'):.1f}x)" for r in spikes]
        parts.append(f"Volume ran well above the 30-day average at {_oxford(described)}.")

    hot = sorted((r for r in rows if (_num(r, "rsi14") or 50) >= _RSI_HOT),
                 key=lambda r: _num(r, "rsi14") or 0.0, reverse=True)[:_TOP_N]
    cold = sorted((r for r in rows if (_num(r, "rsi14") or 50) <= _RSI_COLD),
                  key=lambda r: _num(r, "rsi14") or 0.0)[:_TOP_N]
    if hot:
        described = [f"{_tkr(r)} (RSI {_num(r, 'rsi14'):.0f})" for r in hot]
        parts.append(f"{_oxford(described)} {'are' if len(hot) > 1 else 'is'} overbought.")
    if cold:
        described = [f"{_tkr(r)} (RSI {_num(r, 'rsi14'):.0f})" for r in cold]
        parts.append(f"{_oxford(described)} {'are' if len(cold) > 1 else 'is'} oversold.")
    return " ".join(parts) if parts else None


def _filings(rows: list[dict[str, Any]], now: _dt.datetime) -> str | None:
    """Companies that filed inside the last day, else the 30-day filing load."""
    cutoff = now - _dt.timedelta(hours=_FILING_WINDOW_H)
    recent: list[str] = []
    for row in rows:
        stamp = _parse_dt(row.get("last_filing_at"))
        if stamp and stamp >= cutoff:
            form = _STRIP.sub("", str(row.get("last_filing_form") or "")).strip()[:16]
            recent.append(f"{_tkr(row)} ({form})" if form else _tkr(row))

    if recent:
        shown = recent[:6]
        text = (f"{_lead_count(len(recent), 'company', 'companies')} filed with the SEC in "
                f"the last {_FILING_WINDOW_H} hours: {_oxford(shown)}")
        text += f", plus {_count(len(recent) - len(shown), 'other')}." if len(recent) > len(shown) else "."
        return text

    total = int(sum(_num(r, "filings_30d") or 0 for r in rows))
    if not total:
        return None
    busiest = max(rows, key=lambda r: _num(r, "filings_30d") or 0.0)
    busiest_n = int(_num(busiest, "filings_30d") or 0)
    text = (f"No new filings landed in the last {_FILING_WINDOW_H} hours; "
            f"{_count(total, 'filing')} across the watchlist over the past 30 days")
    text += f", led by {_tkr(busiest)} ({busiest_n})." if busiest_n > 1 else "."
    return text


def _insiders(rows: list[dict[str, Any]]) -> str | None:
    """Net 90-day insider dollars: the extremes on each side, plus cluster buys."""
    flows = [(r, _num(r, "net_insider_90d")) for r in rows]
    flows = [(r, v) for r, v in flows if v]
    parts: list[str] = []

    if flows:
        biggest = max(flows, key=lambda x: abs(x[1]))
        row, value = biggest
        side = "buying" if value > 0 else "selling"
        parts.append(f"The largest 90-day insider flow is {_tkr(row)} at "
                     f"{_money(value)} net {side}")
        net_total = sum(v for _, v in flows)
        parts[-1] += (f", against {_money(net_total)} net across the watchlist."
                      if len(flows) > 1 else ".")

    clusters = [_tkr(r) for r in rows if r.get("cluster_buy")]
    if clusters:
        parts.append(f"{_oxford(clusters)} recorded a cluster buy "
                     "(three or more distinct insiders buying on the open market).")
    return " ".join(parts) if parts else None


def _ahead(radar: list[dict[str, Any]]) -> str | None:
    """Upcoming estimated earnings dates — always labelled as estimates."""
    if not radar:
        return None
    described: list[str] = []
    for item in radar[:6]:
        days = item.get("days_away")
        when = ("any day now" if days is not None and days <= 0 else
                "tomorrow" if days == 1 else f"in ~{days}d")
        ticker = _STRIP.sub("", str(item.get("ticker") or "?")).strip()[:12] or "?"
        described.append(f"{ticker} ({when})")

    # State the horizon the listed names actually span, never the constant — a
    # caller-supplied radar could reach past _RADAR_AHEAD_DAYS and contradict it.
    spans = [d for d in (i.get("days_away") for i in radar) if isinstance(d, (int, float))]
    horizon = max(int(max(spans, default=_RADAR_AHEAD_DAYS)), 1)
    return (f"Looking ahead, {_count(len(radar), 'company', 'companies')} "
            f"{'is' if len(radar) == 1 else 'are'} estimated to report earnings within "
            f"{horizon} days: {_oxford(described)}. Dates are estimated from "
            "each company's past filing cadence, not announced.")


def _parse_dt(value: Any) -> _dt.datetime | None:
    """Parse an ISO timestamp to an aware UTC datetime; None when unparseable."""
    if not value:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)


# ─── Entry point ────────────────────────────────────────────────────────────────

def build_recap(
    rows: list[dict[str, Any]],
    sectors: dict[str, tuple[str | None, str | None]] | None = None,
    radar: list[dict[str, Any]] | None = None,
    now: _dt.datetime | None = None,
) -> Recap | None:
    """Assemble the daily recap from company_summary rows. None when there is nothing to say.

    `sectors` maps TICKER -> (sector, industry) (db.fetch_profiles_by_ticker) and
    `radar` is the output of earnings_radar(); both are optional — their
    paragraphs are simply omitted when absent.
    """
    if not rows:
        return None

    now = now or _dt.datetime.now(_dt.timezone.utc)
    changes = [c for c in (_num(r, "chg_1d") for r in rows) if c is not None]
    median = statistics.median(changes) if changes else None
    as_of = max((str(r.get("as_of") or "") for r in rows), default="") or None

    paragraphs = [
        _breadth(rows, median),
        _movers(rows),
        _sectors(rows, sectors or {}),
        _milestones(rows),
        _unusual(rows),
        _filings(rows, now),
        _insiders(rows),
        _ahead(radar or []),
    ]
    kept = [p.strip() for p in paragraphs if p and p.strip()]
    if not kept:
        return None

    # Trim to the renderer's budget rather than letting Discord reject the post.
    budget, trimmed = _MAX_CHARS, []
    for paragraph in kept:
        if budget - len(paragraph) < 0:
            break
        trimmed.append(paragraph)
        budget -= len(paragraph) + 2
    if not trimmed:
        trimmed = [kept[0][:_MAX_CHARS]]

    return Recap(
        as_of=as_of,
        title="Watchlist Recap" + (f" — {as_of}" if as_of else ""),
        paragraphs=trimmed,
        median_chg=median,
        companies=len(rows),
    )


def render_text(recap: Recap) -> str:
    """Flatten a recap to plain text (used for --dry-run and log output)."""
    return "\n\n".join([recap["title"], *recap["paragraphs"]])
