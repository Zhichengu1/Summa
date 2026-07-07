"""Shared SIC-code → (sector, industry) mapping — stdlib only.

Extracted from reference_ingest so the edgar-free paths (requirements-news.txt,
e.g. the Reddit-trends industry labeller) can label any ticker without pulling
in yaml/edgartools. reference_ingest imports from here; keep the two callers'
behavior identical when editing.
"""

# Coarse SIC → (sector, generic industry) map. SIC is grouped into ranges; a few
# tech-relevant codes are pinned explicitly. Used as the fallback when no seed
# exists, and to supply `sector` when the seed omits it.
SIC_OVERRIDES: dict[int, tuple[str, str]] = {
    3571: ("Technology", "Computer Hardware"),
    3572: ("Technology", "Computer Storage Devices"),
    3661: ("Technology", "Telephone & Telegraph Apparatus"),
    3674: ("Technology", "Semiconductors"),
    3711: ("Consumer Discretionary", "Motor Vehicles"),
    5961: ("Consumer Discretionary", "Catalog & Mail-Order Retail"),
    7370: ("Technology", "Computer Services"),
    7372: ("Technology", "Prepackaged Software"),
    7379: ("Technology", "Computer Services"),
    8742: ("Industrials", "Management Consulting"),
}


def sic_sector(sic: int) -> str:
    """Map a 4-digit SIC code to a broad, GICS-like sector bucket."""
    if 100 <= sic <= 999:
        return "Agriculture"
    if 1000 <= sic <= 1499:
        return "Materials"
    if 1500 <= sic <= 1799:
        return "Industrials"
    if 2000 <= sic <= 2199 or 2700 <= sic <= 2799 or 2300 <= sic <= 2399:
        return "Consumer Staples"
    if 2800 <= sic <= 2899 or 2900 <= sic <= 2999:
        return "Energy" if sic >= 2900 else "Materials"
    if 3570 <= sic <= 3579 or 3670 <= sic <= 3679 or 7370 <= sic <= 7379:
        return "Technology"
    if 3700 <= sic <= 3799:
        return "Consumer Discretionary"
    if 2000 <= sic <= 3999:
        return "Industrials"
    if 4000 <= sic <= 4799:
        return "Industrials"
    if 4800 <= sic <= 4899:
        return "Communication Services"
    if 4900 <= sic <= 4999:
        return "Utilities"
    if 5200 <= sic <= 5999:
        return "Consumer Discretionary"
    if 5000 <= sic <= 5199:
        return "Industrials"
    if 6000 <= sic <= 6799:
        return "Financials"
    if 8000 <= sic <= 8099:
        return "Health Care"
    if 7000 <= sic <= 8999:
        return "Communication Services"
    return "—"


def sic_label(sic: int | None, description: str | None) -> tuple[str | None, str | None]:
    """Best (sector, industry) for a SIC code + its EDGAR description, or (None, None)."""
    if sic is None:
        return None, (description or None)
    if sic in SIC_OVERRIDES:
        return SIC_OVERRIDES[sic]
    return sic_sector(sic), (description or None)
