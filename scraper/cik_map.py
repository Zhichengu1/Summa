import os
import requests
from dotenv import load_dotenv
load_dotenv()

# Tier 1: High-Priority High-Alpha Companies (Start here to avoid noise)
CORE_WATCHLIST: dict[str, dict[str, str]] = {
    "0000320193": {"ticker": "AAPL",  "name": "Apple Inc."},
    "0000789019": {"ticker": "MSFT",  "name": "Microsoft Corporation"},
    "0001018724": {"ticker": "AMZN",  "name": "Amazon.com Inc."},
    "0001652044": {"ticker": "GOOGL", "name": "Alphabet Inc."},
    "0001326801": {"ticker": "META",  "name": "Meta Platforms Inc."},
    "0001318605": {"ticker": "TSLA",  "name": "Tesla Inc."},
    "0001045810": {"ticker": "NVDA",  "name": "NVIDIA Corporation"},
}

def search_by_name(query: str, live: bool = False) -> list[dict[str, str]]:
    """Search for companies by name (case-insensitive substring match).

    Searches CORE_WATCHLIST first. If live=True, also searches the full SEC
    master ticker list (~10k companies) fetched from EDGAR — use this when
    a company is not in the watchlist and the user wants to add it.

    Returns a list of matches, each with keys: cik, ticker, name.
    An empty list means no match was found.
    """
    needle = query.strip().lower()
    results: list[dict[str, str]] = []

    # Always check the in-memory watchlist first (instant, no network call)
    for cik, info in CORE_WATCHLIST.items():
        if needle in info["name"].lower() or needle in info["ticker"].lower():
            results.append({"cik": cik, "ticker": info["ticker"], "name": info["name"]})

    if results:
        return results

    # Fall back to full SEC mapping only when live=True and watchlist has no match
    if live:
        for cik, info in fetch_live_sec_mappings().items():
            if needle in info["name"].lower() or needle in info["ticker"].lower():
                results.append({"cik": cik, "ticker": info["ticker"], "name": info["name"]})
    return results

def add_to_watchlist(cik: str, ticker: str, name: str) -> None:
    """Add a company to the in-memory watchlist for the current run.

    Typical flow:
        matches = search_by_name("Palantir", live=True)
        # user picks one match from the list
        add_to_watchlist(matches[0]["cik"], matches[0]["ticker"], matches[0]["name"])
    """
    padded = str(cik).lstrip("0").zfill(10)
    CORE_WATCHLIST[padded] = {"ticker": ticker.upper(), "name": name}

def fetch_live_sec_mappings() -> dict[str, dict]:
    """Downloads the master ticker-to-CIK mapping file directly from the SEC."""
    url = "https://www.sec.gov/files/company_tickers.json"

    user_agent = os.getenv("SEC_USER_AGENT")
    if not user_agent:
        raise ValueError("SEC_USER_AGENT is not set. Add it to scraper/.env")

    headers = {
        "User-Agent": user_agent,
        "Accept-Encoding": "gzip, deflate",
    }
    
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    
    sec_data = response.json()
    processed_map = {}
    
    # Re-map the structure so you can look companies up instantly by padded CIK string
    for item in sec_data.values():
        raw_cik = str(item["cik_str"])
        padded_cik = raw_cik.zfill(10)  # SEC requires 10-digit leading zeros
        
        processed_map[padded_cik] = {
            "ticker": item["ticker"],
            "name": item["title"]
        }
    return processed_map


def main() -> None:
    print("=== CIK Map Demo ===\n")

    # 1. Search watchlist (no network call)
    print("[1] Watchlist search for 'apple':")
    for match in search_by_name("apple"):
        print(f"    {match}")

    # 2. Search full SEC list for a company not in the watchlist
    print("\n[2] Live SEC search for 'palantir' (not in watchlist):")
    for match in search_by_name("palantir", live=True):
        print(f"    {match}")

    # 3. Add the first result to the watchlist and confirm
    print("\n[3] Adding Palantir to watchlist...")
    palantir_matches = search_by_name("palantir", live=True)
    if palantir_matches:
        m = palantir_matches[0]
        add_to_watchlist(m["cik"], m["ticker"], m["name"])
        print(f"    Added: {m}")
        print(f"    Watchlist now has {len(CORE_WATCHLIST)} companies")

    # 4. Confirm it's now found in watchlist without a live fetch
    print("\n[4] Watchlist search for 'palantir' (should hit local now):")
    for match in search_by_name("palantir"):
        print(f"    {match}")

if __name__ == "__main__":
    main()