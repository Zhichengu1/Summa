"""Congressional stock-trade disclosures ingest — populates `congress_trades`.

A GLOBAL pass (market-wide, not watchlist-scoped) run a couple of times a day by
summa-congress.yml via `python -m tools.congress_trades`. It pulls the FREE,
keyless static JSON behind Kadoa's open-source Congress Trading Monitor
(https://www.kadoa.com/congress/trades — github.com/kadoa-org/congress-trading-
monitor), which normalizes the official STOCK-Act disclosure feeds (House Clerk
PTRs + Senate eFD, plus executive-branch OGE filings) into one rolling window of
the ~5,000 most recent transactions, refreshed daily.

Only rows with a resolvable ticker are stored — they're the tradeable signal the
Congress view aggregates ("which stocks did 3+ members buy / sell in the last N
days"); bonds, munis and unresolved assets are skipped. Rows are keyed on the
source's stable per-transaction `id` and upserted whole each run, so re-runs are
idempotent and the slowly-updating return columns (`ret_since`, `excess_since`)
stay fresh. ~400-day rolling window (cleanup.py prune_old_congress_trades).

Each run also alerts Discord (notify_congress_trades) with the genuinely-NEW
disclosures since the last check plus the current consensus buys/sells — tickers
with CONGRESS_CONSENSUS_MIN+ distinct members on the same side inside
CONGRESS_CONSENSUS_DAYS. Alerts are suppressed on the first-ever seed (no flood
of ~8 weeks of backfill) and skipped when nothing is new, unless force_digest
posts the latest state on demand. Opt-in and fail-soft like every other webhook
(no-op without DISCORD_CONGRESS_WEBHOOK_URL / DISCORD_WEBHOOK_URL).

Same contract as every other non-SEC source (invariant #10): keyless, zero-cost,
fail-soft — a dead feed logs and returns 0, never aborting a run. Stdlib HTTP +
JSON only, so the edgar-free requirements-news.txt path covers it.
"""

import datetime as _dt
import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

import db

try:
    from enrichment import discord_notify
except Exception:  # pragma: no cover — notifications are optional
    discord_notify = None

logger = logging.getLogger(__name__)

# Max newly-disclosed trades shown in the Discord digest (largest ranges first).
_ALERT_N = int(os.environ.get("CONGRESS_ALERT_N", "10"))
# Consensus screen: window + how many distinct members must share a side.
_CONSENSUS_DAYS = int(os.environ.get("CONGRESS_CONSENSUS_DAYS", "30"))
_CONSENSUS_MIN = int(os.environ.get("CONGRESS_CONSENSUS_MIN", "3"))
# Max consensus tickers per side in the digest fields.
_CONSENSUS_ALERT_N = 8

_TIMEOUT = 60  # the feed is one ~4 MB static JSON file
_HEADERS = {"User-Agent": "Summa/1.0 (congress-trades)"}

_FEED_URL = os.environ.get(
    "CONGRESS_TRADES_URL", "https://www.kadoa.com/congress/data/trades.json"
)


def _fetch_feed(url: str) -> list[dict[str, Any]]:
    """Download the trades feed; [] on any network/parse failure (fail-soft)."""
    try:
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, list) else []
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        logger.exception("congress trades feed fetch failed: %s", url)
        return []


def _side(transaction_type: str | None) -> str | None:
    """Collapse the source's transaction labels into buy / sell / exchange."""
    t = (transaction_type or "").lower()
    if "purchase" in t:
        return "buy"
    if "sale" in t:
        return "sell"
    if "exchange" in t:
        return "exchange"
    return None


def _normalize(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map one feed row onto a `congress_trades` row; None if not storable."""
    ticker = (raw.get("ticker") or "").strip().upper()
    trade_id = raw.get("id")
    side = _side(raw.get("transaction_type"))
    if not ticker or not trade_id or not side or not raw.get("transaction_date"):
        return None
    return {
        "id": trade_id,
        "source_id": raw.get("source_id"),
        "branch": raw.get("branch"),
        "chamber": raw.get("chamber"),
        "party": raw.get("party"),
        "state": raw.get("state"),
        "office": raw.get("office"),
        "filer_id": raw.get("filer_id"),
        "filer_name": raw.get("filer_name"),
        "ticker": ticker,
        "asset_name": raw.get("asset_name"),
        "asset_type": raw.get("asset_type"),
        "side": side,
        "transaction_type": raw.get("transaction_type"),
        "transaction_date": raw.get("transaction_date"),
        "filing_date": raw.get("filing_date"),
        "days_to_file": raw.get("days_to_file"),
        "is_late": bool(raw.get("is_late")),
        "owner": raw.get("owner"),
        "amount_low": raw.get("amount_range_low"),
        "amount_high": raw.get("amount_range_high"),
        "amount_label": raw.get("amount_range_label"),
        "doc_url": raw.get("doc_url"),
        "filing_type": raw.get("filing_type"),
        "ret_since": raw.get("ret_since"),
        "excess_since": raw.get("excess_since"),
    }


def _est_amount(t: dict[str, Any]) -> float:
    """Midpoint of the disclosed amount range — the honest single-number estimate."""
    low, high = t.get("amount_low"), t.get("amount_high")
    if low is not None and high is not None:
        return (float(low) + float(high)) / 2
    return float(low or 0)


def _consensus(rows: list[dict[str, Any]], days: int, min_filers: int,
               ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(consensus buys, consensus sells) over the last `days` of trade dates.

    A consensus entry is a ticker where `min_filers`+ DISTINCT members traded the
    same side inside the window: {ticker, count, members, trades, est_total,
    last_date, opposed} — ranked most members first, then most-recent last trade,
    then est. dollars, so the freshest crowded names lead. Computed from the
    freshly-fetched feed rows (the feed spans ~8 weeks, comfortably covering the
    window) — no extra DB read.
    """
    cutoff = (_dt.date.today() - _dt.timedelta(days=days)).isoformat()
    agg: dict[str, dict[str, Any]] = {}
    for t in rows:
        if t["transaction_date"] < cutoff or t["side"] not in ("buy", "sell"):
            continue
        a = agg.setdefault(t["ticker"], {
            "ticker": t["ticker"], "last_date": t["transaction_date"],
            "buy": {}, "sell": {}, "buy_est": 0.0, "sell_est": 0.0,
            "buy_n": 0, "sell_n": 0,
        })
        a["last_date"] = max(a["last_date"], t["transaction_date"])
        a[t["side"]][t.get("filer_id") or t.get("filer_name")] = t.get("filer_name") or "Unknown"
        a[f"{t['side']}_est"] += _est_amount(t)
        a[f"{t['side']}_n"] += 1

    def build(side: str) -> list[dict[str, Any]]:
        other = "sell" if side == "buy" else "buy"
        out = [
            {"ticker": a["ticker"], "count": len(a[side]),
             "members": sorted(a[side].values()), "trades": a[f"{side}_n"],
             "est_total": a[f"{side}_est"], "last_date": a["last_date"],
             "opposed": len(a[other])}
            for a in agg.values() if len(a[side]) >= min_filers
        ]
        # Stable multi-pass sort: est $ → latest trade date → member count, so
        # the final order is count desc, freshest first within a count, then $.
        out.sort(key=lambda c: -c["est_total"])
        out.sort(key=lambda c: c["last_date"], reverse=True)
        out.sort(key=lambda c: -c["count"])
        return out[:_CONSENSUS_ALERT_N]

    return build("buy"), build("sell")


def _totals(rows: list[dict[str, Any]], days: int) -> dict[str, dict[str, Any]]:
    """Window-wide activity totals per side: trade count, distinct members, est $.

    The digest's "total recent buys vs sells" headline — every tickered trade in
    the window counts, not just the consensus names.
    """
    cutoff = (_dt.date.today() - _dt.timedelta(days=days)).isoformat()
    tot: dict[str, dict[str, Any]] = {
        s: {"trades": 0, "members": set(), "est": 0.0} for s in ("buy", "sell")}
    for t in rows:
        if t["transaction_date"] < cutoff or t["side"] not in ("buy", "sell"):
            continue
        s = tot[t["side"]]
        s["trades"] += 1
        s["members"].add(t.get("filer_id") or t.get("filer_name"))
        s["est"] += _est_amount(t)
    return {side: {"trades": s["trades"], "members": len(s["members"]), "est": s["est"]}
            for side, s in tot.items()}


def _watchlist_tickers() -> set[str]:
    """Tickers on the active Summa watchlist (starred in the digest). Fail-soft."""
    try:
        from watchlist import get_active_watchlist
        return {c["ticker"].upper() for c in get_active_watchlist() if c.get("ticker")}
    except Exception:
        logger.exception("  congress_trades: watchlist lookup failed")
        return set()


def _notify(rows: list[dict[str, Any]], new_rows: list[dict[str, Any]]) -> None:
    """Post the Discord digest for a run's delta (or the latest state if forced)."""
    latest_only = not new_rows
    if latest_only:
        # Forced with no delta: show the most recently FILED disclosures instead.
        shown = sorted(rows, key=lambda t: t.get("filing_date") or "", reverse=True)
    else:
        shown = sorted(new_rows, key=_est_amount, reverse=True)
    buys, sells = _consensus(rows, _CONSENSUS_DAYS, _CONSENSUS_MIN)
    totals = _totals(rows, _CONSENSUS_DAYS)
    logger.info("  congress_trades: consensus buys %s | sells %s | totals %dd 🟢%d/🔴%d trades",
                [c["ticker"] for c in buys] or "—", [c["ticker"] for c in sells] or "—",
                _CONSENSUS_DAYS, totals["buy"]["trades"], totals["sell"]["trades"])
    try:
        discord_notify.notify_congress_trades(
            shown[:_ALERT_N], buys, sells,
            watchlist_tickers=_watchlist_tickers(),
            total_new=len(new_rows),
            window_days=_CONSENSUS_DAYS, min_filers=_CONSENSUS_MIN,
            latest_only=latest_only, totals=totals)
    except Exception:
        logger.exception("  congress_trades: Discord notify failed")


def ingest_congress_trades_global(force_digest: bool = False) -> int:
    """Pull the disclosure feed, upsert every tickered trade, alert the delta.

    Upserts ALL tickered feed rows each run (idempotent on the source id; keeps
    the return columns fresh), then posts a Discord digest of the genuinely-new
    disclosures + the current consensus buys/sells. The first-ever seed stays
    quiet (backfill, not news); `force_digest` posts the latest state even with
    no new delta. Returns the upserted row count.
    """
    feed = _fetch_feed(_FEED_URL)
    if not feed:
        logger.warning("congress trades: feed empty or unreachable, skipping")
        return 0
    rows = [r for r in (_normalize(raw) for raw in feed) if r]

    first_seed = not db.congress_trades_has_rows()
    new_rows: list[dict[str, Any]] = []
    if not first_seed:
        seen = db.get_seen_congress_ids([r["id"] for r in rows])
        new_rows = [r for r in rows if r["id"] not in seen]

    written = db.upsert_congress_trades(rows)
    logger.info("congress trades: %d/%d feed rows tickered and stored (%d new)",
                written, len(feed), len(new_rows))

    if discord_notify is None:
        return written
    if first_seed and not force_digest:
        logger.info("  congress_trades: first seed — alert suppressed")
    elif new_rows or force_digest:
        _notify(rows, new_rows)
    return written
