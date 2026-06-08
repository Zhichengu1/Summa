#!/usr/bin/env python3
"""Generate the bundled SEC company index for the frontend's universal search.

Fetches the SEC's official ticker->CIK->name mapping and writes a compact JSON
array to frontend/public/sec-companies.json. The frontend loads this once and
searches it entirely client-side, so name/ticker search across all ~10k public
companies costs zero Supabase reads.

Run:  python build_sec_index.py     # re-run whenever you want to refresh the list

Honors the SEC fair-access policy: a descriptive User-Agent on the request.
"""

import json
import logging
import os
import urllib.request
from pathlib import Path

try:  # optional: load EDGAR_IDENTITY from backend/.env for local runs
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # in CI the identity comes from the workflow env
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s | %(message)s")
logger = logging.getLogger("sec_index")

_SRC = "https://www.sec.gov/files/company_tickers.json"
# This file lives in backend/tools/, so the repo root is two parents up.
_OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "sec-companies.json"
_UA = os.environ.get("EDGAR_IDENTITY", "Summa/1.0 (contact@example.com)")


def build() -> int:
    """Fetch, normalize, and write the SEC company index. Returns the row count."""
    logger.info("Fetching %s", _SRC)
    req = urllib.request.Request(_SRC, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 — fixed https URL
        raw = json.loads(resp.read().decode("utf-8"))

    rows = []
    for entry in raw.values():
        cik_str = str(entry.get("cik_str", "")).strip()
        ticker = str(entry.get("ticker", "")).strip()
        name = str(entry.get("title", "")).strip()
        if not cik_str or not ticker or not name:
            continue
        rows.append({
            "cik": cik_str.zfill(10),   # match the warehouse's zero-padded CIK
            "ticker": ticker.upper(),
            "name": name,
        })

    # Stable order (by ticker) keeps diffs small across refreshes.
    rows.sort(key=lambda r: r["ticker"])

    _OUT.parent.mkdir(parents=True, exist_ok=True)
    with _OUT.open("w", encoding="utf-8") as fh:
        json.dump(rows, fh, separators=(",", ":"), ensure_ascii=False)

    size_kb = _OUT.stat().st_size / 1024
    logger.info("Wrote %d companies -> %s (%.0f KB)", len(rows), _OUT, size_kb)
    return len(rows)


if __name__ == "__main__":
    raise SystemExit(0 if build() else 1)
