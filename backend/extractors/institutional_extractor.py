"""Institutional holdings (13F-HR) → `institutional_holdings`.

Approach: scan a curated list of top institutional managers' most recent
13F-HR filings and keep positions in watchlist companies. This is the
legitimate direction (specific managers, not "who holds stock X"), so it avoids
the reverse-lookup trap in the edgartools sharp-edges guide.

`Filings.filter()` does NOT accept a `company=` name argument — it only filters
by cik/ticker/accession/form/date. So we pull the quarter index as a DataFrame
(`to_pandas()`), match manager names there, then fetch ONLY the matched filings
via `find(accession)`. This touches ~50 filings (one per curated manager), not
all ~9,500.

NOTE on units: edgartools' `holdings.Value` is already in ACTUAL DOLLARS in
current versions (verified: Vanguard's NVDA position reads ~$422B). Do NOT
multiply by 1000.

Module-level cache is populated on the first call and reused across all
per-company calls in one pipeline run.
"""

import logging
import os
from datetime import datetime, timezone
from typing import Any, TypedDict

import pandas as pd
from edgar import get_filings, find

import db
from watchlist import WATCHLIST

logger = logging.getLogger(__name__)

# Curated list of large institutional managers — the universe of "companies that
# invest in other companies" that the Managers view and per-company holders surface
# are built from. Each entry is a SUBSTRING chosen to match EXACTLY ONE EDGAR 13F
# filer (verified against the live 13F-HR index); the match is by literal substring
# (regex=False) and the FIRST match wins, so an ambiguous substring would silently
# grab the wrong filer. When adding a manager, confirm its substring resolves to a
# single filer (e.g. "VANGUARD GROUP" → "VANGUARD GROUP INC", not the "Vanguard
# Personalized Indexing" subsidiary; "BLACKROCK" because the filer "BlackRock, Inc."
# has a comma that breaks "BLACKROCK INC"; "BRIDGEWATER ASSOCIATES" not the
# ambiguous "BRIDGEWATER").
_TOP_MANAGERS = [
    # ── Index / mega asset managers + bank trust desks ──────────────────────────
    "VANGUARD GROUP",
    "BLACKROCK",
    "STATE STREET CORP",
    "FMR LLC",                         # Fidelity
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
    "CITADEL ADVISORS",
    "FRANKLIN RESOURCES",              # Franklin Templeton
    "CHARLES SCHWAB INVESTMENT",
    "ALLIANCEBERNSTEIN",
    "JANUS HENDERSON",
    "BANK OF NEW YORK MELLON",
    "WELLS FARGO",
    "UBS GROUP",
    "AMUNDI",
    "CAPITAL RESEARCH GLOBAL",         # Capital Group divisions (file separately)
    "CAPITAL WORLD INVESTORS",
    "BLACKSTONE",
    # ── Notable hedge funds ─────────────────────────────────────────────────────
    "BERKSHIRE HATHAWAY",
    "BRIDGEWATER ASSOCIATES",
    "RENAISSANCE TECHNOLOGIES",
    "TWO SIGMA INVESTMENTS",
    "MILLENNIUM MANAGEMENT",
    "POINT72 ASSET MANAGEMENT",
    "D. E. SHAW",
    "AQR CAPITAL",
    "ELLIOTT INVESTMENT",
    "PERSHING SQUARE CAPITAL",
    "TIGER GLOBAL",
    "COATUE",
    "VIKING GLOBAL",
    "THIRD POINT",
    "ICAHN",                           # Carl Icahn
    "SOROS FUND",
    # ── Long-term / value investors ─────────────────────────────────────────────
    "MARKEL",
    "DODGE & COX",
    "HARRIS ASSOCIATES",               # Oakmark
    "BAILLIE GIFFORD",
    "FISHER ASSET",                    # Fisher Investments
    # ── Pensions / sovereign / foundations ──────────────────────────────────────
    "NORGES BANK",                     # Norway sovereign wealth fund
    "CANADA PENSION",
    "GATES FOUNDATION",
]

_WATCHLIST_TICKERS: set[str] = {c["ticker"] for c in WATCHLIST}
_CIK_BY_TICKER: dict[str, str] = {c["ticker"]: c["cik"] for c in WATCHLIST}

# How many of each manager's largest positions to persist for the Managers view
# (their real top holdings across ALL stocks, not just the watchlist). Bounded so
# `manager_portfolios` stays small: ~TOP_N x managers x quarter. Env-tunable.
_TOP_N = int(os.environ.get("MANAGER_TOP_N", "50"))


class _CacheEntry(TypedDict):
    wl: pd.DataFrame          # watchlist positions only
    top: list[dict[str, Any]]  # top-N positions across all stocks (Managers view)
    period: str | None
    manager_cik: str | None
    accession: str | None
    filed_at: str | None
    total_value: float        # full-portfolio value (all holdings), for pct


_cache: dict[str, _CacheEntry] = {}
_cache_populated = False


def _top_holdings(holdings: pd.DataFrame, total_value: float, n: int) -> list[dict[str, Any]]:
    """Return a manager's `n` largest equity positions across all stocks.

    Aggregates multiple lots of the same security (by CUSIP) and drops option
    positions (puts/calls) so the list reflects real long stock holdings. Ranked
    by position value, largest first.
    """
    h = holdings
    if "PutCall" in h.columns:                      # keep only common-stock longs
        h = h[h["PutCall"].astype(str).str.strip() == ""]
    if h.empty or "Cusip" not in h.columns or "Value" not in h.columns:
        return []

    agg = (
        h.groupby("Cusip", as_index=False)
        .agg(Issuer=("Issuer", "first"), Ticker=("Ticker", "first"),
             Value=("Value", "sum"), SharesPrnAmount=("SharesPrnAmount", "sum"))
        .sort_values("Value", ascending=False)
        .head(n)
    )

    rows: list[dict[str, Any]] = []
    for rank, (_, r) in enumerate(agg.iterrows(), start=1):
        value = float(r["Value"]) if pd.notna(r["Value"]) else None
        ticker = str(r["Ticker"]).strip() if pd.notna(r["Ticker"]) else ""
        rows.append({
            "rank": rank,
            "cusip": str(r["Cusip"]).strip(),
            "ticker": ticker or None,
            "issuer": str(r["Issuer"]).strip() if pd.notna(r["Issuer"]) else None,
            "shares": float(r["SharesPrnAmount"]) if pd.notna(r["SharesPrnAmount"]) else None,
            "value": value,
            "pct_of_portfolio": (value / total_value * 100) if (value and total_value) else None,
        })
    return rows


def _latest_available_filing_quarter() -> tuple[int, int]:
    """Return (year, quarter) of the EDGAR filing window holding the freshest 13F period.

    A 13F-HR for a calendar quarter-end is filed up to 45 days LATER, so the filings
    that REPORT quarter Q land in the *following* calendar quarter — the "filing
    quarter" — with a deadline on the 15th of that quarter's second month (Feb/May/
    Aug/Nov 15). We must therefore query the filing quarter, not the period quarter:
    e.g. Q1 (Mar-31) holdings appear in the Q2 (Apr-Jun) filing window.

    We return the most recent filing quarter whose deadline has passed (so its period
    is actually on file), and fall back one filing quarter before that deadline — so
    we never query a window that hasn't been filed yet and come back empty.
    """
    now = datetime.now(timezone.utc)
    cq = (now.month - 1) // 3 + 1                 # current calendar quarter, 1-based
    deadline_month = (cq - 1) * 3 + 2             # 2nd month of the quarter (Feb/May/Aug/Nov)
    if (now.month, now.day) >= (deadline_month, 15):
        return now.year, cq                       # this quarter's filings are in
    if cq == 1:
        return now.year - 1, 4                    # before mid-Feb → last year's Q4 window
    return now.year, cq - 1                       # before the deadline → prior filing quarter


def _populate_cache(year: int | None = None, quarter: int | None = None) -> None:
    """Populate the module 13F cache for one filing quarter (default: most recent).

    `year`/`quarter` are a FILING-date quarter; the holdings they contain report
    the prior calendar quarter-end (so the period_of_report stamped on each entry
    comes from the filing itself). Passing an explicit quarter lets the bootstrap
    load an earlier quarter for the buy/sell diff.
    """
    global _cache_populated
    _cache_populated = True

    if year is None or quarter is None:
        year, quarter = _latest_available_filing_quarter()
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

            # If the substring hits multiple distinct filers (e.g. "MORGAN STANLEY"
            # also matches "MORGAN STANLEY INSTITUTIONAL INVESTMENT ADVISORS"), prefer
            # an exact name match — that's the parent's consolidated 13F — so the pick
            # is deterministic rather than depending on index row order.
            exact = matches[upper.loc[matches.index] == mgr]
            row = exact.iloc[0] if not exact.empty else matches.iloc[0]
            accession = str(row.get("accession_number") or "").strip()
            if not accession:
                continue

            filing = find(accession)
            holdings = getattr(filing.obj(), "holdings", None)
            if holdings is None or holdings.empty or "Ticker" not in holdings.columns:
                continue

            total_value = float(holdings["Value"].sum()) if "Value" in holdings.columns else 0.0
            top = _top_holdings(holdings, total_value, _TOP_N)
            wl = holdings[holdings["Ticker"].isin(_WATCHLIST_TICKERS)].copy()

            fd = getattr(filing, "filing_date", None)
            _cache[mgr] = {
                "wl": wl,
                "top": top,
                "period": str(getattr(filing, "period_of_report", "") or "") or None,
                "manager_cik": str(row.get("cik") or "").strip() or None,
                "accession": accession,
                "filed_at": f"{fd}T16:00:00+00:00" if fd else None,
                "total_value": total_value,
            }
            logger.info("  13F cached: %s -> %d watchlist / %d top positions", mgr, len(wl), len(top))
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


def _build_current_rows() -> list[dict[str, Any]]:
    """Flatten the cached top-N holdings into manager_portfolios rows (no deltas)."""
    rows: list[dict[str, Any]] = []
    for mgr, entry in _cache.items():
        if not entry["manager_cik"] or not entry["period"]:
            continue  # can't key a portfolio without a manager CIK + quarter
        for h in entry["top"]:
            rows.append({
                "manager_cik": entry["manager_cik"],
                "manager_name": mgr,
                "period_of_report": entry["period"],
                "accession_number": entry["accession"],
                "filed_at": entry["filed_at"],
                **h,
            })
    return rows


def _classify(cur_shares: float | None, prior_shares: float | None) -> tuple[str, float]:
    """Classify a position's quarter-over-quarter move. Returns (action, share_change).

    A ±2% band absorbs rounding/share-count noise so tiny wiggles read 'unchanged'.
    """
    c, p = (cur_shares or 0.0), (prior_shares or 0.0)
    if p == 0 and c > 0:
        return "new", c
    if c == 0 and p > 0:
        return "exited", -p
    delta = c - p
    if p and delta > 0.02 * p:
        return "added", delta
    if p and delta < -0.02 * p:
        return "trimmed", delta
    return "unchanged", delta


def _prior_lookup() -> dict[str, tuple[str, dict[str, dict[str, Any]]]]:
    """Per manager_cik, the prior quarter already stored in manager_portfolios.

    Returns {manager_cik: (prior_period, {cusip: stored_row})}, where prior_period
    is the latest period strictly before that manager's current cached quarter. The
    diff source is the warehouse itself, so computing buy/sell adds no EDGAR load.
    """
    cur_period = {e["manager_cik"]: e["period"] for e in _cache.values() if e["manager_cik"] and e["period"]}
    try:
        stored = db._select_all(
            "manager_portfolios",
            "manager_cik, period_of_report, cusip, shares, value, ticker, issuer",
        )
    except Exception:
        logger.exception("  manager_portfolios prior read failed")
        return {}

    by_mgr: dict[str, dict[str, dict[str, dict[str, Any]]]] = {}
    for r in stored:
        mc, period = r.get("manager_cik"), r.get("period_of_report")
        if not mc or not period:
            continue
        by_mgr.setdefault(mc, {}).setdefault(period, {})[str(r.get("cusip"))] = r

    out: dict[str, tuple[str, dict[str, dict[str, Any]]]] = {}
    for mc, periods in by_mgr.items():
        cp = cur_period.get(mc)
        candidates = [p for p in periods if cp is None or p < cp]
        if candidates:
            pp = max(candidates)
            out[mc] = (pp, periods[pp])
    return out


def ingest_manager_portfolios() -> int:
    """Global pass: persist each manager's top-N holdings + their quarter move.

    Powers the Managers view ("what does Vanguard / BlackRock invest in, and what
    are they buying/selling"). Reuses the 13F cache the per-company
    `ingest_institutional` already populated this run (no extra EDGAR load) and
    diffs it against the prior quarter already stored here. No-ops cleanly when the
    cache is empty. Runs once per run, like entity_ingest.
    """
    if not _cache_populated or not _cache:
        return 0

    current = _build_current_rows()
    if not current:
        return 0

    priors = _prior_lookup()
    cur_cusips: dict[str, set[str]] = {}
    for r in current:
        cur_cusips.setdefault(r["manager_cik"], set()).add(r["cusip"])

    # Annotate held positions with their move vs the prior quarter.
    for r in current:
        prior_entry = priors.get(r["manager_cik"])
        if prior_entry is None:
            # No prior quarter on file yet → leave the move undetermined rather
            # than mislabelling the whole book 'new'.
            r["prior_shares"] = r["prior_value"] = r["share_change"] = r["action"] = None
            continue
        prow = prior_entry[1].get(r["cusip"])
        prior_shares = prow.get("shares") if prow else None
        action, change = _classify(r.get("shares"), prior_shares)
        r["action"] = action
        r["share_change"] = change
        r["prior_shares"] = prior_shares
        r["prior_value"] = prow.get("value") if prow else None

    # Surface exits/sells: prior top holdings absent from the current top set.
    exits: list[dict[str, Any]] = []
    for mc, (_pp, pmap) in priors.items():
        held = cur_cusips.get(mc, set())
        sample = next((r for r in current if r["manager_cik"] == mc), None)
        if sample is None:
            continue
        for cusip, prow in pmap.items():
            ps = prow.get("shares")
            if cusip in held or not ps:
                continue
            exits.append({
                "manager_cik": mc,
                "manager_name": sample["manager_name"],
                "period_of_report": sample["period_of_report"],
                "accession_number": sample["accession_number"],
                "filed_at": sample["filed_at"],
                "rank": None,
                "cusip": cusip,
                "ticker": prow.get("ticker"),
                "issuer": prow.get("issuer"),
                "shares": 0.0,
                "value": 0.0,
                "pct_of_portfolio": 0.0,
                "prior_shares": ps,
                "prior_value": prow.get("value"),
                "share_change": -float(ps),
                "action": "exited",
            })

    rows = current + exits
    written = db.upsert_many(
        "manager_portfolios", rows,
        on_conflict="manager_cik,period_of_report,cusip",
    )
    logger.info(
        "  manager_portfolios: %d positions (%d exits) across %d managers",
        written, len(exits), len(_cache),
    )
    return written
