"""Watchlist of companies the Summa pipeline ingests, keyed by zero-padded CIK.

SEED is the always-present baseline. The full active watchlist is the union of
SEED and the dynamic `watchlist` table (companies queued from the frontend), so
new companies are ingested without any code change. See get_active_watchlist().
"""

import logging
import os
import re
from typing import TypedDict


class WatchedCompany(TypedDict):
    cik: str
    ticker: str
    name: str


logger = logging.getLogger(__name__)

# Guard rails on the anon-writable queue. The frontend can INSERT into `watchlist`
# without auth (that is the point: no code change to follow a new company), so the
# backend must never trust it blindly: rows are validated (a real zero-padded CIK,
# sane ticker/name lengths) and the number of *dynamic* companies merged into a
# run is capped, oldest-first, so a burst of junk inserts can inflate neither the
# ingest work nor the warehouse. Raise WATCHLIST_DYNAMIC_MAX deliberately as the
# real watchlist grows.
WATCHLIST_DYNAMIC_MAX = int(os.environ.get("WATCHLIST_DYNAMIC_MAX", "300"))
_CIK_RE = re.compile(r"^\d{10}$")
_TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,12}$")

# Baseline watchlist — always ingested even if the dynamic table is empty.
WATCHLIST: list[WatchedCompany] = [
    {"cik": "0000320193", "ticker": "AAPL",  "name": "Apple Inc."},
    {"cik": "0000789019", "ticker": "MSFT",  "name": "Microsoft Corporation"},
    {"cik": "0001018724", "ticker": "AMZN",  "name": "Amazon.com Inc."},
    {"cik": "0001652044", "ticker": "GOOGL", "name": "Alphabet Inc."},
    {"cik": "0001326801", "ticker": "META",  "name": "Meta Platforms Inc."},
    {"cik": "0001318605", "ticker": "TSLA",  "name": "Tesla Inc."},
    {"cik": "0001045810", "ticker": "NVDA",  "name": "NVIDIA Corporation"},
    {"cik": "0002012383", "ticker": "BLK",   "name": "BlackRock, Inc."},
]


def get_active_watchlist() -> list[WatchedCompany]:
    """SEED unioned with the dynamic `watchlist` table, deduped by CIK.

    Falls back to SEED alone if the table is missing/unreachable, so the pipeline
    keeps running before the schema migration is applied.
    """
    import db  # local import avoids a hard dependency at module load

    merged: dict[str, WatchedCompany] = {c["cik"]: c for c in WATCHLIST}
    accepted = 0
    skipped = 0
    for row in db.fetch_watchlist():
        cik = str(row.get("cik") or "").strip()
        ticker = str(row.get("ticker") or "").strip().upper()
        name = str(row.get("name") or cik).strip()[:120]
        if not _CIK_RE.match(cik) or (ticker and not _TICKER_RE.match(ticker)):
            skipped += 1
            continue
        if cik in merged:
            continue
        if accepted >= WATCHLIST_DYNAMIC_MAX:
            skipped += 1
            continue
        merged[cik] = {"cik": cik, "ticker": ticker, "name": name or cik}
        accepted += 1
    if skipped:
        logger.warning("watchlist: skipped %d dynamic row(s) (invalid or over WATCHLIST_DYNAMIC_MAX=%d)", skipped, WATCHLIST_DYNAMIC_MAX)
    return list(merged.values())
