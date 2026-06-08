"""Catalyst extractors → earnings_events / corporate_events / late_filings /
securities_offerings.

8-K events:   eightk.items → classify by item code → corporate_events
              Item 2.02 presence → earnings_events marker row
NT filings:   NT 10-K / NT 10-Q → late_filings
Offerings:    S-3 / 424B* → securities_offerings (deal object from edgartools)
"""

import logging
import re
from typing import Any

import db
from edgar_cache import get_company

logger = logging.getLogger(__name__)

# Earnings press-release (EX-99.1) parsing. Conservative by design: we only fill
# revenue and diluted EPS from high-confidence headline phrases that large-cap
# releases use consistently, and leave everything else NULL. Free-text guidance
# and net-income units vary too much to trust, so we don't guess them.
_UNIT_MULT = {"trillion": 1e12, "billion": 1e9, "million": 1e6}
# Require a connector verb + a unit word so we only match a real headline figure.
_RE_REVENUE = re.compile(
    r"\brevenues?\s+(?:of|was|were|totaled|totalled|reached|grew to|increased to)\s+"
    r"\$([\d,]+(?:\.\d+)?)\s*(trillion|billion|million)\b",
    re.I,
)
# EPS must carry a decimal (kills no-decimal false positives like "$583") and sit
# in a sane per-share range.
_RE_EPS = re.compile(
    r"diluted (?:earnings per share|EPS)\s+(?:of|was|were)\s+\$(\d{1,3}\.\d{2})"
    r"|\$(\d{1,3}\.\d{2})\s+per diluted share",
    re.I,
)


def _parse_earnings_press_release(filing: Any) -> dict[str, float | None]:
    """Best-effort revenue + diluted EPS from the EX-99.1 press release.

    Returns {"revenue": float|None, "diluted_eps": float|None}. Never raises:
    any failure (no exhibit, network, parse) yields Nones so the caller still
    writes the earnings marker row.
    """
    out: dict[str, float | None] = {"revenue": None, "diluted_eps": None}
    try:
        ex = next(
            (a for a in filing.attachments
             if str(getattr(a, "document_type", "")).upper() == "EX-99.1"),
            None,
        )
        if ex is None:
            return out
        text = ex.text
        text = text() if callable(text) else text
        norm = re.sub(r"\s+", " ", str(text or ""))
        if not norm:
            return out

        m = _RE_REVENUE.search(norm)
        if m:
            rev = float(m.group(1).replace(",", "")) * _UNIT_MULT[m.group(2).lower()]
            if rev >= 1e8:  # sanity floor: ignore sub-$100M stray matches
                out["revenue"] = rev

        e = _RE_EPS.search(norm)
        if e:
            eps = float(e.group(1) or e.group(2))
            if 0 < eps <= 100:
                out["diluted_eps"] = eps
    except Exception:
        logger.debug("  EX-99.1 parse failed for %s", getattr(filing, "accession_no", "?"))
    return out

# 8-K item code → event class (README catalyst taxonomy)
_ITEM_CLASS: dict[str, str] = {
    "1.01": "M&A",         "1.02": "M&A",         "1.03": "other",
    "2.01": "M&A",         "2.02": "earnings",     "2.03": "other",
    "2.04": "other",       "2.05": "other",        "2.06": "other",
    "3.01": "other",       "3.02": "dilution",     "3.03": "dilution",
    "4.01": "other",       "4.02": "restatement",
    "5.01": "other",       "5.02": "exec_change",  "5.03": "other",
    "5.04": "other",       "5.07": "other",        "5.08": "other",
    "6.01": "other",       "6.02": "other",        "6.03": "other",
    "7.01": "other",       "8.01": "other",        "9.01": "other",
}
_EARNINGS_CODE = "2.02"

_NT_FORMS = ["NT 10-K", "NT 10-Q"]
_OFFERING_FORMS = ["S-3", "424B5", "424B4", "424B3", "424B2"]


def _iso(f: Any) -> str | None:
    d = getattr(f, "filing_date", None)
    return f"{d}T16:00:00+00:00" if d else None


def _safe_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _safe_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def ingest_events(cik: str, ticker: str) -> int:
    """Ingest 8-K / NT / offering catalysts for one company."""
    company = get_company(cik)
    total = 0
    total += _ingest_8k(company, cik, ticker)
    total += _ingest_nt(company, cik, ticker)
    total += _ingest_offerings(company, cik, ticker)
    return total


# ─── 8-K ─────────────────────────────────────────────────────────────────────

def _ingest_8k(company: Any, cik: str, ticker: str) -> int:
    try:
        filings = company.get_filings(form="8-K").head(30)
    except Exception:
        logger.exception("  get_filings(8-K) failed for %s", ticker)
        return 0

    corp_rows: list[dict[str, Any]] = []
    earn_rows: list[dict[str, Any]] = []

    for f in filings:
        try:
            eightk = f.obj()
            items: list[str] = getattr(eightk, "items", None) or []
            if not items:
                continue

            accession_no = str(getattr(f, "accession_no", "") or "")
            filed_at = _iso(f)
            event_date = _safe_str(
                getattr(f, "period_of_report", None) or getattr(f, "filing_date", None)
            )

            has_earnings = any(
                item.replace("Item ", "").strip() == _EARNINGS_CODE for item in items
            )

            for item in items:
                code = item.replace("Item ", "").strip()
                event_class = _ITEM_CLASS.get(code, "other")

                summary_text = None
                try:
                    item_obj = eightk[item]
                    if item_obj and hasattr(item_obj, "text"):
                        txt = str(item_obj.text or "").strip()
                        summary_text = txt[:500] if txt else None
                except Exception:
                    pass

                corp_rows.append({
                    "cik": cik, "ticker": ticker,
                    "accession_number": accession_no,
                    "event_date": event_date,
                    "item_code": code,
                    "event_class": event_class,
                    "summary": summary_text,
                    "filed_at": filed_at,
                })

            if has_earnings:
                parsed = _parse_earnings_press_release(f)
                earn_rows.append({
                    "cik": cik, "ticker": ticker,
                    "accession_number": accession_no,
                    "period": _safe_str(getattr(f, "period_of_report", None)),
                    "reported_date": event_date,
                    "revenue": parsed["revenue"], "diluted_eps": parsed["diluted_eps"],
                    "net_income": None,
                    "guidance_action": None,
                    "guidance_low": None, "guidance_high": None,
                    "filed_at": filed_at,
                })
        except Exception:
            logger.exception("  8-K parse error for %s accession %s",
                             ticker, getattr(f, "accession_no", "?"))

    written = 0
    if corp_rows:
        written += db.upsert_many(
            "corporate_events", corp_rows, on_conflict="accession_number,item_code"
        )
    if earn_rows:
        written += db.upsert_many(
            "earnings_events", earn_rows, on_conflict="accession_number"
        )
    logger.info("  %s 8-K: %d events, %d earnings markers", ticker, len(corp_rows), len(earn_rows))
    return written


# ─── Late filings (NT) ───────────────────────────────────────────────────────

def _ingest_nt(company: Any, cik: str, ticker: str) -> int:
    rows: list[dict[str, Any]] = []
    for nt_form in _NT_FORMS:
        subject = nt_form.replace("NT ", "")
        try:
            filings = company.get_filings(form=nt_form).head(10)
        except Exception:
            continue
        for f in filings:
            accession_no = str(getattr(f, "accession_no", "") or "")
            if not accession_no:
                continue
            rows.append({
                "cik": cik, "ticker": ticker,
                "accession_number": accession_no,
                "nt_form": nt_form,
                "subject_form": subject,
                "period": _safe_str(getattr(f, "period_of_report", None)),
                "reason_excerpt": None,
                "filed_at": _iso(f),
            })

    if not rows:
        return 0
    written = db.upsert_many("late_filings", rows, on_conflict="accession_number")
    logger.info("  %s NT: %d late filings", ticker, written)
    return written


# ─── Securities offerings ─────────────────────────────────────────────────────

def _ingest_offerings(company: Any, cik: str, ticker: str) -> int:
    rows: list[dict[str, Any]] = []
    for form in _OFFERING_FORMS:
        try:
            filings = company.get_filings(form=form).head(10)
        except Exception:
            continue
        for f in filings:
            accession_no = str(getattr(f, "accession_no", "") or "")
            if not accession_no:
                continue

            offering_type = None
            amount = None
            shares = None
            try:
                obj = f.obj()
                deal = getattr(obj, "deal", None)
                if deal:
                    offering_type = _safe_str(getattr(deal, "offering_type", None))
                    amount = _safe_float(getattr(deal, "gross_proceeds", None))
                    shares = _safe_float(getattr(deal, "shares", None))
            except Exception:
                pass

            rows.append({
                "cik": cik, "ticker": ticker,
                "accession_number": accession_no,
                "form": form,
                "offering_type": offering_type,
                "amount": amount,
                "shares": shares,
                "filed_at": _iso(f),
            })

    if not rows:
        return 0
    written = db.upsert_many("securities_offerings", rows, on_conflict="accession_number")
    logger.info("  %s offerings: %d", ticker, written)
    return written
