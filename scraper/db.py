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
