"""Institutional holdings (13F-HR) → `institutional_holdings`.

Approach: scan a curated list of top institutional managers' most recent
13F-HR filings and keep positions in watchlist companies. This is the
legitimate direction (specific managers, not "who holds stock X"), so it avoids
the reverse-lookup trap in the edgartools sharp-edges guide.

`Filings.filter()` does NOT accept a `company=` name argument — it only filters
by cik/ticker/accession/form/date. So we pull the quarter index as a DataFrame
(`to_pandas()`), match manager names there, then fetch ONLY the matched filings
via `find(accession)`. This touches ~20 filings, not all ~9,500.

NOTE on units: edgartools' `holdings.Value` is already in ACTUAL DOLLARS in
current versions (verified: Vanguard's NVDA position reads ~$422B). Do NOT
multiply by 1000.

Module-level cache is populated on the first call and reused across all
per-company calls in one pipeline run.
"""

import logging
from datetime import datetime, timezone
from typing import Any, TypedDict

import pandas as pd
from edgar import get_filings, find

import db
from watchlist import WATCHLIST

logger = logging.getLogger(__name__)

# Curated top institutional managers. Substrings are chosen to match exactly
# one EDGAR filer (e.g. "VANGUARD GROUP" → "VANGUARD GROUP INC", not the
# "Vanguard Personalized Indexing" subsidiary).
_TOP_MANAGERS = [
    "VANGUARD GROUP",
    "BLACKROCK INC",
    "STATE STREET CORP",
    "FMR LLC",
    "JPMORGAN CHASE",
    "PRICE T ROWE",
    "WELLINGTON MANAGEMENT GROUP",
    "GEODE CAPITAL MANAGEMENT",
    "NORTHERN TRUST CORP",
    "MORGAN STANLEY",
    "GOLDMAN SACHS GROUP",
    "INVESCO LTD",
    "DIMENSIONAL FUND ADVISORS",
    "BANK OF AMERICA CORP",
    "BERKSHIRE HATHAWAY",
    "CITADEL ADVISORS",
]

_WATCHLIST_TICKERS: set[str] = {c["ticker"] for c in WATCHLIST}
_CIK_BY_TICKER: dict[str, str] = {c["ticker"]: c["cik"] for c in WATCHLIST}


class _CacheEntry(TypedDict):
    wl: pd.DataFrame          # watchlist positions only
    period: str | None
    manager_cik: str | None
    accession: str | None
    filed_at: str | None
    total_value: float        # full-portfolio value (all holdings), for pct


_cache: dict[str, _CacheEntry] = {}
_cache_populated = False


def _previous_complete_quarter() -> tuple[int, int]:
    """Return (year, quarter) of the most recently completed 13F period."""
    now = datetime.now(timezone.utc)
    q = (now.month - 1) // 3  # 0-based current quarter
    if q == 0:
        return now.year - 1, 4
    return now.year, q


def _populate_cache() -> None:
    global _cache_populated
    _cache_populated = True

    year, quarter = _previous_complete_quarter()
    logger.info("  13F: fetching %d Q%d index", year, quarter)
    try:
        index_df = get_filings(form="13F-HR", year=year, quarter=quarter).to_pandas()
    except Exception:
        logger.exception("  get_filings(13F-HR).to_pandas() failed for %d Q%d", year, quarter)
        return

    if index_df.empty or "company" not in index_df.columns:
        logger.warning("  13F index empty or missing 'company' column")
        return

    upper = index_df["company"].astype(str).str.upper()

    for mgr in _TOP_MANAGERS:
        try:
            matches = index_df[upper.str.contains(mgr, na=False, regex=False)]
            if matches.empty:
                logger.info("  13F: no filer matched '%s'", mgr)
                continue

            row = matches.iloc[0]
            accession = str(row.get("accession_number") or "").strip()
            if not accession:
                continue

            filing = find(accession)
            holdings = getattr(filing.obj(), "holdings", None)
            if holdings is None or holdings.empty or "Ticker" not in holdings.columns:
                continue

            total_value = float(holdings["Value"].sum()) if "Value" in holdings.columns else 0.0
            wl = holdings[holdings["Ticker"].isin(_WATCHLIST_TICKERS)].copy()
            if wl.empty:
                continue

            fd = getattr(filing, "filing_date", None)
            _cache[mgr] = {
                "wl": wl,
                "period": str(getattr(filing, "period_of_report", "") or "") or None,
                "manager_cik": str(row.get("cik") or "").strip() or None,
                "accession": accession,
                "filed_at": f"{fd}T16:00:00+00:00" if fd else None,
                "total_value": total_value,
            }
            logger.info("  13F cached: %s -> %d watchlist positions", mgr, len(wl))
        except Exception:
            logger.exception("  13F cache error for '%s'", mgr)

    logger.info("  13F: cached %d managers", len(_cache))


def ingest_institutional(cik: str, ticker: str) -> int:
    """Ingest 13F-HR positions in one watchlist company."""
    if not _cache_populated:
        _populate_cache()

    subject_cik = _CIK_BY_TICKER.get(ticker, cik)
    rows: list[dict[str, Any]] = []

    for mgr, entry in _cache.items():
        ticker_rows = entry["wl"][entry["wl"]["Ticker"] == ticker]
        if ticker_rows.empty:
            continue

        total = entry["total_value"]
        for _, hr in ticker_rows.iterrows():
            shares_raw = hr.get("SharesPrnAmount")
            value_raw = hr.get("Value")
            value = float(value_raw) if value_raw is not None else None  # already USD
            pct = (value / total * 100) if (value is not None and total) else None

            rows.append({
                "cik": subject_cik,
                "ticker": ticker,
                "period_of_report": entry["period"],
                "manager_name": mgr,
                "manager_cik": entry["manager_cik"],
                "accession_number": entry["accession"],
                "shares": float(shares_raw) if shares_raw is not None else None,
                "value": value,
                "pct_of_portfolio": pct,
                "filed_at": entry["filed_at"],
            })

    if not rows:
        logger.info("  %s institutional: 0 holders in cache", ticker)
        return 0

    written = db.upsert_many(
        "institutional_holdings", rows,
        on_conflict="cik,period_of_report,manager_name",
    )
    logger.info("  %s institutional: %d holders", ticker, written)
    return written
