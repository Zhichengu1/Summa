"""Insider transactions (Form 4) → `insider_transactions`.

Uses edgartools' TransactionSummary API:
  summary = filing.obj().get_ownership_summary()
  summary.insider_name / .position / .remaining_shares
  for tx in summary.transactions: tx.code / .shares_numeric / .price_numeric / .value_numeric
"""

import logging
from typing import Any

import db
from edgar_cache import get_company

logger = logging.getLogger(__name__)

# Share acquisition codes
_ACQUIRE = {"P", "A", "M", "G", "C", "W"}
# Share disposition codes
_DISPOSE = {"S", "F", "X", "D", "Z"}


def _safe_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _safe_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _ad(code: str) -> str | None:
    c = code.upper()
    if c in _ACQUIRE:
        return "A"
    if c in _DISPOSE:
        return "D"
    return None


def _iso(date_val: Any) -> str | None:
    d = getattr(date_val, "filing_date", date_val) if hasattr(date_val, "filing_date") else date_val
    if d is None:
        return None
    return f"{d}T16:00:00+00:00"


def ingest_insider(cik: str, ticker: str, *, lookback: int = 50) -> int:
    """Ingest Form 4 insider transactions for one company."""
    company = get_company(cik)
    try:
        filings = company.get_filings(form="4").head(lookback)
    except Exception:
        logger.exception("  get_filings(4) failed for %s", ticker)
        return 0

    rows: list[dict[str, Any]] = []
    for f in filings:
        try:
            form4 = f.obj()
            summary = form4.get_ownership_summary()

            accession_no = _safe_str(getattr(f, "accession_no", None))
            if not accession_no:
                continue

            filing_date = getattr(f, "filing_date", None)
            filed_at = f"{filing_date}T16:00:00+00:00" if filing_date else None
            filing_url = getattr(f, "filing_url", None) or getattr(f, "url", None)
            filer_name = _safe_str(getattr(summary, "insider_name", None))
            filer_title = _safe_str(getattr(summary, "position", None))
            shares_after = _safe_float(getattr(summary, "remaining_shares", None))

            transactions = getattr(summary, "transactions", None) or []

            if not transactions:
                net = _safe_float(getattr(summary, "net_change", None))
                rows.append({
                    "cik": cik, "ticker": ticker,
                    "accession_number": accession_no,
                    "filer_name": filer_name, "filer_title": filer_title,
                    "transaction_date": _safe_str(filing_date),
                    "transaction_code": None,
                    "acquired_disposed": "A" if (net or 0) >= 0 else "D",
                    "shares": abs(net) if net is not None else None,
                    "price": None,
                    "value": _safe_float(getattr(summary, "net_value", None)),
                    "shares_after": shares_after,
                    "is_10b5_1": False,
                    "filing_url": filing_url,
                    "filed_at": filed_at,
                })
                continue

            for tx in transactions:
                code = (_safe_str(getattr(tx, "code", None)) or "").upper()
                tx_date = _safe_str(
                    getattr(tx, "transaction_date", None) or filing_date
                )
                shares = _safe_float(getattr(tx, "shares_numeric", None))
                price = _safe_float(getattr(tx, "price_numeric", None))
                value = _safe_float(getattr(tx, "value_numeric", None))
                if value is None and shares is not None and price is not None:
                    value = shares * price

                rows.append({
                    "cik": cik, "ticker": ticker,
                    "accession_number": accession_no,
                    "filer_name": filer_name, "filer_title": filer_title,
                    "transaction_date": tx_date,
                    "transaction_code": code or None,
                    "acquired_disposed": _ad(code) if code else None,
                    "shares": shares,
                    "price": price,
                    "value": value,
                    "shares_after": shares_after,
                    "is_10b5_1": False,
                    "filing_url": filing_url,
                    "filed_at": filed_at,
                })
        except Exception:
            logger.exception("  Form 4 parse error for %s accession %s",
                             ticker, getattr(f, "accession_no", "?"))

    written = db.upsert_many(
        "insider_transactions", rows,
        on_conflict="accession_number,filer_name,transaction_date,transaction_code,shares",
    )
    logger.info("  %s insider: %d transactions", ticker, written)
    return written
