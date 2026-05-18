"""
Supabase demo — insert, read, and delete a test filing row.
Run from the scraper/ directory with the venv active:
    python demo_supabase.py
"""

import os
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

URL: str = os.environ["SUPABASE_URL"].strip().rstrip("/").removesuffix("/rest/v1")
KEY: str = os.environ["SUPABASE_KEY"].strip()

db: Client = create_client(URL, KEY)

print("\n=== Supabase Demo ===\n")

# Clean up any leftover test row from a previous failed run
db.table("filings").delete().eq("accession_number", "TEST-0000000000-00-000001").execute()

# ------------------------------------------------------------------
# 1. INSERT a fake filing row
# ------------------------------------------------------------------
print("[1] Inserting test filing...")

test_row = {
    "accession_number": "TEST-0000000000-00-000001",
    "cik": "0000320193",
    "ticker": "AAPL",
    "company_name": "Apple Inc.",
    "form_type": "10-K",
    "filed_at": "2024-11-01T16:05:00+00:00",
    "period_of_report": "2024-09-28",
    "filing_url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193",
    "section_mda": "Revenue grew 6% year-over-year driven by services.",
    "signals_flagged": False,
    "gemini_ran": False,
}

insert_result = db.table("filings").upsert(test_row, on_conflict="accession_number").execute()
inserted_id = insert_result.data[0]["id"]
print(f"    Inserted row id: {inserted_id}")

# ------------------------------------------------------------------
# 2. READ it back
# ------------------------------------------------------------------
print("\n[2] Reading it back...")

select_result = (
    db.table("filings")
    .select("id, ticker, company_name, form_type, filed_at, signals_flagged")
    .eq("accession_number", "TEST-0000000000-00-000001")
    .single()
    .execute()
)
row = select_result.data
print(f"    id            : {row['id']}")
print(f"    ticker        : {row['ticker']}")
print(f"    company_name  : {row['company_name']}")
print(f"    form_type     : {row['form_type']}")
print(f"    filed_at      : {row['filed_at']}")
print(f"    signals_flagged: {row['signals_flagged']}")

# ------------------------------------------------------------------
# 3. UPDATE — flag a signal
# ------------------------------------------------------------------
print("\n[3] Updating signals_flagged to True...")

db.table("filings").update({"signals_flagged": True}).eq("id", inserted_id).execute()

updated = db.table("filings").select("signals_flagged").eq("id", inserted_id).single().execute()
print(f"    signals_flagged is now: {updated.data['signals_flagged']}")

# ------------------------------------------------------------------
# 4. DELETE — clean up test data
# ------------------------------------------------------------------
print("\n[4] Cleaning up test row...")

db.table("filings").delete().eq("id", inserted_id).execute()

# Confirm it's gone
confirm = db.table("filings").select("id").eq("id", inserted_id).execute()
print(f"    Rows remaining with that id: {len(confirm.data)}")

print("\n=== All Supabase operations working correctly ===\n")
