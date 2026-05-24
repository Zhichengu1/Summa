"""
db.py — Supabase client singleton and filing persistence helpers.
"""

import logging
import os
from typing import Any

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

log = logging.getLogger(__name__)

_client: Client | None = None


def get_client() -> Client:
    """Return the shared Supabase client, creating it on first call."""
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"].strip().rstrip("/").removesuffix("/rest/v1")
        key = os.environ["SUPABASE_KEY"].strip()
        _client = create_client(url, key)
    return _client


def upsert_filing(row: dict[str, Any]) -> dict[str, Any]:
    """
    Insert or update a filing row keyed on accession_number.
    Returns the persisted row.
    """
    db     = get_client()
    result = db.table("filings").upsert(row, on_conflict="accession_number").execute()
    if result.data:
        log.debug("Upserted filing: %s", row.get("accession_number"))
        return result.data[0]
    return {}


def upsert_company_meta(row: dict[str, Any]) -> dict[str, Any]:
    """Insert or update a company_meta row keyed on cik."""
    db     = get_client()
    result = db.table("company_meta").upsert(row, on_conflict="cik").execute()
    return result.data[0] if result.data else {}


def insert_filing_event(cik: str, accession: str, filed_at: str) -> None:
    """Append an 8-K event row used for burst detection queries."""
    db = get_client()
    db.table("filing_events").insert({
        "cik":             cik,
        "form_type":       "8-K",
        "accession_number": accession,
        "filed_at":        filed_at,
    }).execute()


def get_company_meta(cik: str) -> dict[str, Any] | None:
    """Fetch the company_meta row for a given CIK, or None if not found."""
    db     = get_client()
    result = db.table("company_meta").select("*").eq("cik", cik).maybe_single().execute()
    return result.data


def count_recent_8k(cik: str, days: int = 30) -> int:
    """Count 8-K filings for a company in the past `days` days (burst detection)."""
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    db     = get_client()
    result = (
        db.table("filing_events")
        .select("id", count="exact")
        .eq("cik", cik)
        .gte("filed_at", cutoff)
        .execute()
    )
    return result.count or 0


def delete_old_filings(days: int = 30) -> int:
    """Delete filings with filed_at older than `days` days. Returns count deleted."""
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    db     = get_client()
    result = db.table("filings").delete().lt("filed_at", cutoff).execute()
    count  = len(result.data) if result.data else 0
    log.debug("Deleted %d filing(s) older than %d days", count, days)
    return count


def delete_old_filing_events(days: int = 30) -> int:
    """Delete filing_events with filed_at older than `days` days. Returns count deleted."""
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    db     = get_client()
    result = db.table("filing_events").delete().lt("filed_at", cutoff).execute()
    count  = len(result.data) if result.data else 0
    log.debug("Deleted %d filing_event(s) older than %d days", count, days)
    return count


def delete_superseded_filings(cik: str, form_type: str, keep_accession: str) -> int:
    """Delete all filings of (cik, form_type) except keep_accession.

    Used for 10-K and DEF 14A — only the most recent filing of each type matters.
    Not used for 8-Ks (distinct events) or 10-Qs (use prune_10q_history instead).
    """
    db     = get_client()
    result = (
        db.table("filings")
        .delete()
        .eq("cik", cik)
        .eq("form_type", form_type)
        .neq("accession_number", keep_accession)
        .execute()
    )
    count = len(result.data) if result.data else 0
    if count:
        log.debug("Deleted %d superseded %s filing(s) for CIK %s", count, form_type, cik)
    return count


def prune_filing_history(cik: str, form_type: str, keep: int) -> int:
    """Keep only the `keep` most recent filings of `form_type` for a company.

    Called after upserting a new periodic report so history stays bounded.
    Typical values: 10-Q → keep=10, 10-K → keep=3.
    """
    db = get_client()
    result = (
        db.table("filings")
        .select("accession_number")
        .eq("cik", cik)
        .eq("form_type", form_type)
        .order("filed_at", desc=True)
        .execute()
    )
    all_accs  = [r["accession_number"] for r in (result.data or [])]
    to_delete = all_accs[keep:]
    if not to_delete:
        return 0
    del_result = (
        db.table("filings")
        .delete()
        .in_("accession_number", to_delete)
        .execute()
    )
    count = len(del_result.data) if del_result.data else 0
    if count:
        log.debug("Pruned %d old %s(s) for CIK %s (keeping last %d)", count, form_type, cik, keep)
    return count
