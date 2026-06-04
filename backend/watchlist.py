"""Watchlist of companies the Summa pipeline ingests, keyed by zero-padded CIK.

SEED is the always-present baseline. The full active watchlist is the union of
SEED and the dynamic `watchlist` table (companies queued from the frontend), so
new companies are ingested without any code change. See get_active_watchlist().
"""

import logging
from typing import TypedDict


class WatchedCompany(TypedDict):
    cik: str
    ticker: str
    name: str


logger = logging.getLogger(__name__)

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
    for row in db.fetch_watchlist():
        cik = str(row.get("cik") or "").strip()
        if not cik:
            continue
        merged.setdefault(cik, {
            "cik": cik,
            "ticker": str(row.get("ticker") or "").upper(),
            "name": str(row.get("name") or cik),
        })
    return list(merged.values())
