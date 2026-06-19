"""Active IPO pipeline (S-1 / F-1 registrations + 424B pricings) → `ipos`.

GLOBAL extractor — runs ONCE per pipeline run (like
`institutional_extractor.ingest_institutional_global`), NOT per watchlist
company. IPOs are market-wide events that originate from companies which are, by
definition, not yet on the watchlist, so this scans the WHOLE EDGAR filing index
for the IPO-lifecycle forms over a recent window rather than walking a company's
own filings.

Lifecycle → `status`:
  S-1,  F-1        → 'filed'      initial registration (intends to go public)
  S-1/A, F-1/A     → 'updated'    amendment (often sets / raises the price range)
  424B4, 424B1     → 'priced'     final prospectus at pricing (launching now)
  RW               → 'withdrawn'  registration withdrawn (IPO pulled)

The table is keyed on `accession_number` (one row per filing, same as every other
SEC-form table); the frontend groups the rows by issuer to show one card per IPO
with its most-advanced status + latest known terms.

Cost: the index queries are metadata-only (cheap, one request per form). The
expensive prospectus parse (`.obj()` → Deal price/shares/proceeds) runs ONLY for
*new* pricing filings — accessions already stored are skipped via
`db.get_seen_accessions` — so a typical run parses a handful of prospectuses and
most runs parse none. Independent of watchlist size.
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from edgar import get_filings, get_current_filings

import db

logger = logging.getLogger(__name__)

# IPO-lifecycle forms, grouped so status can be derived from the form alone.
_REGISTRATION_FORMS = ("S-1", "F-1")
_AMENDMENT_FORMS    = ("S-1/A", "F-1/A")
_PRICING_FORMS      = ("424B4", "424B1")
_WITHDRAW_FORMS     = ("RW",)
_IPO_FORMS          = _REGISTRATION_FORMS + _AMENDMENT_FORMS + _PRICING_FORMS + _WITHDRAW_FORMS

# Form prefixes for the real-time current-filings feed (today's filings, before they
# land in the quarterly index). A prefix match pulls amendments too — `get_current_filings`
# with "S-1" returns S-1 *and* S-1/A — so this short set covers every lifecycle form.
_CURRENT_PREFIXES   = ("S-1", "F-1", "424B4", "424B1", "RW")

# How far back the historical index scan reaches each run. This is only a SAFETY NET
# behind the real-time current-filings feed (1a) — the feed catches everything fresh,
# so the window just needs enough overlap to recover from pipeline downtime. Kept short
# to keep the per-run index pull light. Rows persist across runs (pruned at 120d), so a
# company's full lifecycle is retained even though each scan is shallow. Bump via
# IPO_WINDOW_DAYS for a one-off deep backfill on an empty table (e.g. 30).
_WINDOW_DAYS = int(os.environ.get("IPO_WINDOW_DAYS", "10"))


def _status_for(form: str) -> str:
    """Map an IPO-lifecycle form to its pipeline status."""
    if form in _WITHDRAW_FORMS:
        return "withdrawn"
    if form.startswith("424B"):
        return "priced"
    if form.endswith("/A"):
        return "updated"
    return "filed"


def _safe_float(v: Any) -> float | None:
    """Best-effort float coercion; None on failure."""
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _safe_str(v: Any) -> str | None:
    """Trim to a non-empty string, else None."""
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _clean_offering_type(v: Any) -> str | None:
    """Normalize edgartools' `OfferingType.FIRM_COMMITMENT` enum to 'Firm Commitment'.

    Drops the enum-class prefix and the noise value UNKNOWN (→ None).
    """
    s = _safe_str(v)
    if not s:
        return None
    s = s.split(".")[-1]
    if s.upper() in ("UNKNOWN", "NONE"):
        return None
    return s.replace("_", " ").title()


def _is_spac(name: str | None) -> bool:
    """Heuristic: blank-check / SPAC issuers self-identify as 'Acquisition Corp'."""
    if not name:
        return False
    low = name.lower()
    return "acquisition corp" in low or "acquisition co." in low


def _deal_terms(filing: Any) -> dict[str, Any]:
    """Parse a pricing prospectus for offering terms (price / shares / proceeds).

    Best-effort: the prospectus object exposes a `deal` (price, shares, gross) plus
    `ticker` / `offering_type`. Any parse failure yields empty terms — the row is
    still stored from its metadata.
    """
    terms: dict[str, Any] = {}
    try:
        obj = filing.obj()
        deal = getattr(obj, "deal", None)
        if deal is not None:
            price = _safe_float(getattr(deal, "price", None))
            shares = _safe_float(getattr(deal, "shares", None))
            # The attribute is `gross_proceeds` (the Deal repr labels it "gross");
            # fall back to price × shares when the field itself is unset.
            proceeds = _safe_float(getattr(deal, "gross_proceeds", None))
            if proceeds is None and price is not None and shares is not None:
                proceeds = price * shares
            terms["price"] = price
            terms["shares"] = shares
            terms["proceeds"] = proceeds
        terms["ticker"] = _safe_str(getattr(obj, "ticker", None))
        terms["offering_type"] = _clean_offering_type(getattr(obj, "offering_type", None))
    except Exception:
        logger.debug("IPO deal parse failed for %s", getattr(filing, "accession_no", "?"))
    return terms


def ingest_ipos_global() -> int:
    """Scan the EDGAR index for recent IPO-lifecycle filings and upsert `ipos`.

    Returns the number of rows written. New pricing filings are enriched with deal
    terms; already-stored accessions are skipped (no re-parse).
    """
    found: dict[str, Any] = {}   # accession -> Filing (deduped; first writer wins)

    def _add(f: Any) -> None:
        acc = _safe_str(getattr(f, "accession_no", None))
        if acc:
            found.setdefault(acc, f)

    # 1a. Real-time feed FIRST so the pipeline is never a day behind: today's IPO
    # filings land here before they appear in EDGAR's quarterly index. This is what
    # makes a same-day pricing (e.g. a 424B4 filed this morning) show immediately.
    for prefix in _CURRENT_PREFIXES:
        try:
            for f in get_current_filings(form=prefix):
                _add(f)
        except Exception:
            logger.exception("  IPO current-filings pull failed for %s", prefix)

    # 1b. Historical window (yesterday back _WINDOW_DAYS) fills in the lifecycle
    # backlog. End at yesterday — today is already covered by 1a, and querying
    # through "today" trips edgartools' current-filings warning. Metadata only here.
    today = datetime.now(timezone.utc).date()
    end = today - timedelta(days=1)
    date_range = f"{(today - timedelta(days=_WINDOW_DAYS)).isoformat()}:{end.isoformat()}"
    for form in _IPO_FORMS:
        try:
            filings = get_filings(form=form, filing_date=date_range)
        except Exception:
            logger.exception("  IPO index pull failed for form %s", form)
            continue
        for f in filings:
            _add(f)

    if not found:
        logger.info("  IPOs: no lifecycle filings found (today + last %dd)", _WINDOW_DAYS)
        return 0

    # 2. Only parse/insert accessions we have not stored yet (incremental).
    seen = db.get_seen_accessions("ipos", list(found.keys()))
    new = {acc: f for acc, f in found.items() if acc not in seen}
    if not new:
        logger.info("  IPOs: %d lifecycle filings found, all already stored", len(found))
        return 0

    # 3. Build rows; enrich pricing filings with deal terms (the only .obj() parse).
    rows: list[dict[str, Any]] = []
    for acc, f in new.items():
        form = _safe_str(getattr(f, "form", None)) or ""
        name = _safe_str(getattr(f, "company", None))
        cik = str(getattr(f, "cik", "") or "").strip()
        row: dict[str, Any] = {
            "accession_number": acc,
            "cik": cik.zfill(10) if cik.isdigit() else cik,
            "company_name": name,
            "ticker": None,
            "form": form,
            "status": _status_for(form),
            "is_spac": _is_spac(name),
            "price": None,
            "shares": None,
            "proceeds": None,
            "offering_type": None,
            "filing_url": _safe_str(getattr(f, "filing_url", None)),
            "filed_at": str(getattr(f, "filing_date", "") or "") or None,
        }
        if form.startswith("424B"):
            row.update({k: v for k, v in _deal_terms(f).items() if v is not None})
        rows.append(row)

    written = db.upsert_ipos(rows)
    logger.info("  IPOs: %d new lifecycle filings (of %d in window)", written, len(found))
    return written
