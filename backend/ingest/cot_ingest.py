"""CFTC Commitments of Traders ingest — populates `cot_reports`.

A GLOBAL pass (market-wide, not watchlist-scoped) run weekly by summa-cot.yml
via `python -m tools.cot`. It pulls the FREE, keyless CFTC Public Reporting API
(Socrata, publicreporting.cftc.gov — legacy futures-only report, dataset
6dca-aqww) for a curated set of the most-watched futures markets: equity index,
rates, FX, crypto, energy, metals and agriculture contracts.

The legacy report splits open interest into non-commercials (large speculators
— funds; the trend-following "crowd"), commercials (hedgers — the "smart
money" on extremes) and non-reportables (small traders). We store one row per
market per weekly report with the raw longs/shorts plus precomputed nets, and
the frontend COT view + the Discord digest derive the classic signals:

  * COT index — where today's spec net sits in its trailing 1y/3y range
    (>= 90 = crowded long / reversal risk, <= 10 = crowded short / squeeze setup)
  * week-over-week net shifts (fresh money flowing in/out, scaled by OI)
  * flips — spec net crossing zero (regime change)

Reports are published Friday ~3:30pm ET with data as of Tuesday. The first run
backfills COT_HISTORY_WEEKS (~3y) so the percentile index works immediately;
later runs fetch only report dates newer than the latest stored row (usually
one week × ~28 markets — a few KB). ~1200-day rolling window
(cleanup.py prune_old_cot_reports).

Each run that lands a NEW report week also alerts Discord (notify_cot_report):
the biggest weekly spec-position shifts plus current crowded-long/short
extremes and flips. Suppressed on the first-ever seed, skipped when no new
week arrived, forced via COT_FORCE_DIGEST/--force. Opt-in and fail-soft like
every other webhook (no-op without DISCORD_COT_WEBHOOK_URL / DISCORD_WEBHOOK_URL).

Same contract as every other non-SEC source (invariant #10): keyless,
zero-cost, fail-soft — a dead feed logs and returns 0, never aborting a run.
Stdlib HTTP + JSON only, so the edgar-free requirements-news.txt path covers it.
"""

import datetime as _dt
import json
import logging
import os
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

# Weeks of history backfilled on first seed AND used for the digest's COT index
# (3y is the conventional lookback for the percentile).
_HISTORY_WEEKS = int(os.environ.get("COT_HISTORY_WEEKS", "156"))
# Max markets shown in the digest's "biggest weekly shifts" list.
_ALERT_N = int(os.environ.get("COT_ALERT_N", "8"))
# A weekly spec-net change of at least this % of open interest counts as a
# notable flow (the digest's shift list is ranked by it).
_SHIFT_PCT_OI = float(os.environ.get("COT_SHIFT_PCT_OI", "2.0"))

_TIMEOUT = 60
_HEADERS = {"User-Agent": "Summa/1.0 (cot)"}

# CFTC Public Reporting API (Socrata) — legacy futures-only report. Keyless;
# $limit=50000 comfortably covers a full 3y × 28-market backfill in one GET.
_API_URL = os.environ.get(
    "COT_API_URL", "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
)

# Curated market universe: CFTC contract market code → (display name, group).
# Codes verified against the live dataset; a code the API stops returning is
# simply absent from the response (logged), never an error.
_MARKETS: dict[str, tuple[str, str]] = {
    # equity indices + volatility
    "13874A": ("E-mini S&P 500", "indices"),
    "209742": ("Nasdaq 100 mini", "indices"),
    "124603": ("Dow mini ($5)", "indices"),
    "239742": ("Russell 2000 mini", "indices"),
    "1170E1": ("VIX futures", "indices"),
    # rates
    "042601": ("2Y T-Note", "rates"),
    "044601": ("5Y T-Note", "rates"),
    "043602": ("10Y T-Note", "rates"),
    "020601": ("US T-Bond", "rates"),
    # FX
    "098662": ("US Dollar Index", "fx"),
    "099741": ("Euro FX", "fx"),
    "097741": ("Japanese Yen", "fx"),
    "096742": ("British Pound", "fx"),
    "090741": ("Canadian Dollar", "fx"),
    "092741": ("Swiss Franc", "fx"),
    # crypto
    "133741": ("Bitcoin (CME)", "crypto"),
    "146021": ("Ether (CME)", "crypto"),
    # energy
    "067651": ("WTI Crude Oil", "energy"),
    "023651": ("Natural Gas", "energy"),
    "111659": ("RBOB Gasoline", "energy"),
    # metals
    "088691": ("Gold", "metals"),
    "084691": ("Silver", "metals"),
    "085692": ("Copper", "metals"),
    # agriculture
    "002602": ("Corn", "ags"),
    "001602": ("Wheat (SRW)", "ags"),
    "005602": ("Soybeans", "ags"),
    "057642": ("Live Cattle", "ags"),
    "054642": ("Lean Hogs", "ags"),
}

# Socrata column names on 6dca-aqww. NOTE: 'postions' in the spread column is
# the dataset's own long-standing typo, not ours.
_FIELDS = [
    "cftc_contract_market_code", "report_date_as_yyyy_mm_dd",
    "open_interest_all", "change_in_open_interest_all",
    "noncomm_positions_long_all", "noncomm_positions_short_all",
    "noncomm_postions_spread_all",
    "comm_positions_long_all", "comm_positions_short_all",
    "nonrept_positions_long_all", "nonrept_positions_short_all",
    "traders_tot_all",
]


def _fetch_reports(since: str) -> list[dict[str, Any]]:
    """Fetch curated-market report rows dated after `since`; [] on failure."""
    codes = ",".join(f"'{c}'" for c in _MARKETS)
    params = urllib.parse.urlencode({
        "$select": ",".join(_FIELDS),
        "$where": (f"cftc_contract_market_code in({codes}) "
                   f"AND report_date_as_yyyy_mm_dd > '{since}T00:00:00.000'"),
        "$order": "report_date_as_yyyy_mm_dd ASC",
        "$limit": "50000",
    })
    url = f"{_API_URL}?{params}"
    try:
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, list) else []
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        logger.exception("COT API fetch failed: %s", _API_URL)
        return []


def _int(v: Any) -> int:
    """Socrata returns every number as a string; None/'' → 0."""
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _normalize(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map one API row onto a `cot_reports` row; None if not storable."""
    code = raw.get("cftc_contract_market_code")
    date = (raw.get("report_date_as_yyyy_mm_dd") or "")[:10]
    meta = _MARKETS.get(code or "")
    if not code or not date or not meta:
        return None
    oi = _int(raw.get("open_interest_all"))
    nc_long = _int(raw.get("noncomm_positions_long_all"))
    nc_short = _int(raw.get("noncomm_positions_short_all"))
    c_long = _int(raw.get("comm_positions_long_all"))
    c_short = _int(raw.get("comm_positions_short_all"))
    nr_long = _int(raw.get("nonrept_positions_long_all"))
    nr_short = _int(raw.get("nonrept_positions_short_all"))
    nc_net = nc_long - nc_short
    return {
        "market_code": code,
        "report_date": date,
        "market_name": meta[0],
        "market_group": meta[1],
        "open_interest": oi,
        "oi_change": _int(raw.get("change_in_open_interest_all")),
        "noncomm_long": nc_long,
        "noncomm_short": nc_short,
        "noncomm_spread": _int(raw.get("noncomm_postions_spread_all")),
        "comm_long": c_long,
        "comm_short": c_short,
        "nonrept_long": nr_long,
        "nonrept_short": nr_short,
        "noncomm_net": nc_net,
        "comm_net": c_long - c_short,
        "nonrept_net": nr_long - nr_short,
        "noncomm_net_pct_oi": round(nc_net * 100.0 / oi, 2) if oi else None,
        "traders_total": _int(raw.get("traders_tot_all")),
    }


def _spec_index(series: list[int], latest: int) -> float:
    """COT index: percentile (0–100) of `latest` within the historical nets."""
    if len(series) < 2:
        return 50.0
    below = sum(1 for v in series if v < latest)
    equal = sum(1 for v in series if v == latest)
    # midrank so ties (and a flat series) land mid-band, not at an extreme
    return round((below + (equal - 1) / 2) * 100.0 / (len(series) - 1), 1)


def _streak(nets: list[int]) -> int:
    """Consecutive weeks the spec net moved one way: +N adding, -N cutting."""
    n = 0
    for i in range(len(nets) - 1, 0, -1):
        d = nets[i] - nets[i - 1]
        if d == 0:
            break
        if n == 0:
            n = 1 if d > 0 else -1
        elif (d > 0) == (n > 0):
            n += 1 if n > 0 else -1
        else:
            break
    return n


def _digest_stats(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per-market digest stats from stored history: latest net, WoW shift, COT index.

    `history` is the trailing `COT_HISTORY_WEEKS` of `cot_reports` rows (any
    order). Markets with fewer than two reports are skipped — no WoW read yet.
    """
    by_code: dict[str, list[dict[str, Any]]] = {}
    for r in history:
        by_code.setdefault(r["market_code"], []).append(r)
    stats: list[dict[str, Any]] = []
    for code, rows in by_code.items():
        rows.sort(key=lambda r: r["report_date"])
        if len(rows) < 2:
            continue
        latest, prev = rows[-1], rows[-2]
        nets = [int(r["noncomm_net"] or 0) for r in rows]
        net, prev_net = nets[-1], nets[-2]
        oi = int(latest.get("open_interest") or 0)
        wow = net - prev_net
        stats.append({
            "market_code": code,
            "market_name": latest.get("market_name") or code,
            "market_group": latest.get("market_group"),
            "report_date": latest["report_date"],
            "open_interest": oi,
            "net": net,
            "prev_net": prev_net,
            "wow": wow,
            "wow_pct_oi": round(wow * 100.0 / oi, 2) if oi else 0.0,
            "net_pct_oi": round(net * 100.0 / oi, 2) if oi else 0.0,
            "spec_index": _spec_index(nets, net),
            "flipped": (net > 0 > prev_net) or (net < 0 < prev_net),
            "streak": _streak(nets),
        })
    return stats


def _notify(history: list[dict[str, Any]], latest_only: bool = False) -> None:
    """Post the Discord COT digest for the latest stored report week."""
    stats = _digest_stats(history)
    if not stats:
        return
    report_date = max(s["report_date"] for s in stats)
    current = [s for s in stats if s["report_date"] == report_date]
    shifts = sorted(current, key=lambda s: -abs(s["wow_pct_oi"]))[:_ALERT_N]
    crowded_long = sorted((s for s in current if s["spec_index"] >= 90),
                          key=lambda s: -s["spec_index"])
    crowded_short = sorted((s for s in current if s["spec_index"] <= 10),
                           key=lambda s: s["spec_index"])
    flips = [s for s in current if s["flipped"]]
    streaks = sorted((s for s in current if abs(s["streak"]) >= 4),
                     key=lambda s: -abs(s["streak"]))[:6]
    logger.info("  cot: week %s — %d crowded long, %d crowded short, %d flips, %d streaks",
                report_date, len(crowded_long), len(crowded_short), len(flips), len(streaks))
    try:
        discord_notify.notify_cot_report(
            report_date, shifts, crowded_long, crowded_short, flips,
            streaks=streaks,
            index_weeks=_HISTORY_WEEKS, shift_pct_oi=_SHIFT_PCT_OI,
            latest_only=latest_only)
    except Exception:
        logger.exception("  cot: Discord notify failed")


def ingest_cot_global(force_digest: bool = False) -> int:
    """Pull new COT report weeks, upsert them, and alert the weekly digest.

    Incremental on the latest stored report date (first run backfills
    COT_HISTORY_WEEKS of history). A Discord digest posts only when a NEW
    report week landed — suppressed on the first-ever seed, forced via
    `force_digest`. Returns the upserted row count.
    """
    latest = db.get_latest_cot_date()
    first_seed = latest is None
    since = (latest if latest is not None
             else (_dt.date.today() - _dt.timedelta(weeks=_HISTORY_WEEKS)).isoformat())

    raw = _fetch_reports(since)
    rows = [r for r in (_normalize(x) for x in raw) if r]
    seen_codes = {r["market_code"] for r in rows}
    missing = [f"{c} ({_MARKETS[c][0]})" for c in _MARKETS if c not in seen_codes]
    if rows and missing and first_seed:
        logger.warning("cot: no data returned for %s", ", ".join(missing))

    written = db.upsert_cot_reports(rows)
    new_weeks = sorted({r["report_date"] for r in rows})
    logger.info("cot: %d rows upserted across %d report week(s)%s",
                written, len(new_weeks),
                f" (backfill since {since})" if first_seed else "")

    if discord_notify is None:
        return written
    if first_seed and not force_digest:
        logger.info("  cot: first seed — digest suppressed")
    elif new_weeks or force_digest:
        history = db.fetch_cot_history(_HISTORY_WEEKS)
        _notify(history, latest_only=not new_weeks)
    return written
