"""Beneficial ownership (SC 13D/13G) and proposed sales (Form 144).

→ `beneficial_ownership` and `proposed_sales` tables.

SC 13D/13G: filed by large holders (≥5%) of the subject company.
            13D = activist intent; 13G = passive large holder.
Form 144:   proposed insider sales filed before the trade.
"""

import logging
from typing import Any

from edgar import Company

import db

logger = logging.getLogger(__name__)

_BENEFICIAL_FORMS = ["SC 13D", "SC 13G", "SC 13D/A", "SC 13G/A"]


def _iso(f: Any) -> str | None:
    d = getattr(f, "filing_date", None)
    return f"{d}T16:00:00+00:00" if d else None


def _safe_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def ingest_ownership(cik: str, ticker: str) -> int:
    """Ingest SC 13D/13G and Form 144 filings for one company."""
    company = Company(cik)
    total = 0
    total += _ingest_beneficial(company, cik, ticker)
    total += _ingest_proposed_sales(company, cik, ticker)
    return total


def _ingest_beneficial(company: Any, cik: str, ticker: str) -> int:
    rows: list[dict[str, Any]] = []
    for form in _BENEFICIAL_FORMS:
        try:
            filings = company.get_filings(form=form).head(20)
        except Exception:
            continue
        for f in filings:
            accession_no = _safe_str(getattr(f, "accession_no", None))
            if not accession_no:
                continue
            is_activist = "13D" in form.upper()
            # 'company' on the filing object is the filer (the large holder)
            filer_name = _safe_str(
                getattr(f, "company", None)
                or getattr(f, "filer_name", None)
                or getattr(f, "entity_name", None)
            )
            schedule = form.replace("/A", "").strip()
            rows.append({
                "cik": cik, "ticker": ticker,
                "accession_number": accession_no,
                "filer_name": filer_name,
                "schedule": schedule,
                "is_activist": is_activist,
                "pct_of_class": None,   # Phase 2: parse from document
                "shares": None,
                "purpose_excerpt": None,
                "filed_at": _iso(f),
            })

    if not rows:
        return 0
    written = db.upsert_many(
        "beneficial_ownership", rows, on_conflict="accession_number"
    )
    logger.info("  %s 13D/13G: %d filings", ticker, written)
    return written


def _ingest_proposed_sales(company: Any, cik: str, ticker: str) -> int:
    rows: list[dict[str, Any]] = []
    try:
        filings = company.get_filings(form="144").head(20)
    except Exception:
        logger.exception("  get_filings(144) failed for %s", ticker)
        return 0

    for f in filings:
        accession_no = _safe_str(getattr(f, "accession_no", None))
        if not accession_no:
            continue
        seller_name = _safe_str(
            getattr(f, "company", None)
            or getattr(f, "filer_name", None)
            or getattr(f, "entity_name", None)
        )
        rows.append({
            "cik": cik, "ticker": ticker,
            "accession_number": accession_no,
            "seller_name": seller_name,
            "relationship": None,   # Phase 2: parse from document
            "shares": None,
            "approx_value": None,
            "approx_date": None,
            "filed_at": _iso(f),
        })

    if not rows:
        return 0
    written = db.upsert_many(
        "proposed_sales", rows, on_conflict="accession_number"
    )
    logger.info("  %s Form 144: %d proposed sales", ticker, written)
    return written
