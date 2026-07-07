"""Reference-data ingest — populates `company_profiles` and `company_themes`.

Phase A (no LLM): industry/sector come from the SEC SIC code (already available
on the edgartools Company object), merged over curated seeds in
seeds/profiles.yaml. The seed supplies the specific `industry`, the strategic
`thesis`, and the forward-looking `themes` — SIC is too coarse for those. For a
company with no seed, SIC still yields a usable sector + industry, so the feature
works for any ticker, not just the curated watchlist.

See backend/docs/REFERENCE_DATA_SCOPE.md. LLM theme/thesis extraction is Phase B.
"""

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

import db
from ingest.sic_map import SIC_OVERRIDES as _SIC_OVERRIDES
from ingest.sic_map import sic_sector as _sic_sector

logger = logging.getLogger(__name__)

# This file lives in backend/ingest/; seeds/ is one level up under backend/.
_SEED_PATH = Path(__file__).resolve().parent.parent / "seeds" / "profiles.yaml"


@lru_cache(maxsize=1)
def _seed_profiles() -> dict[str, dict[str, Any]]:
    """Load and cache the curated seed profiles, keyed by upper-case ticker."""
    try:
        with _SEED_PATH.open(encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        return {str(k).upper(): v for k, v in data.items()}
    except FileNotFoundError:
        logger.warning("seed profiles not found at %s", _SEED_PATH)
        return {}
    except Exception:
        logger.exception("failed to load seed profiles")
        return {}


def _company_sic(cik: str) -> tuple[int | None, str | None]:
    """Best-effort SIC code + description from the edgartools Company object."""
    try:
        from edgar_cache import get_company  # noqa: PLC0415
        c = get_company(cik)
    except Exception:
        logger.debug("Company(%s) construction failed", cik)
        return None, None

    sic_raw = getattr(c, "sic", None)
    desc = getattr(c, "sic_description", None) or getattr(c, "industry", None)
    sic: int | None = None
    try:
        if sic_raw not in (None, ""):
            sic = int(str(sic_raw).strip())
    except (TypeError, ValueError):
        sic = None
    return sic, (str(desc).strip() if desc else None)


def ingest_profile(cik: str, ticker: str) -> None:
    """Build and upsert one company's profile + themes from SIC + seed."""
    seed = _seed_profiles().get(ticker.upper(), {})
    sic, sic_desc = _company_sic(cik)
    sic_sector, sic_industry = (None, None)
    if sic is not None:
        sic_sector, sic_industry = _SIC_OVERRIDES.get(sic, (_sic_sector(sic), sic_desc))

    # Prefer curated narrative; fall back to SIC for coverage of non-seed names.
    sector = seed.get("sector") or sic_sector or "—"
    industry = seed.get("industry") or sic_industry or sic_desc or "—"
    thesis = seed.get("thesis") or ""
    source = "seed" if seed else ("sic" if sic is not None else "seed")

    db.upsert_profile({
        "cik": cik, "sector": sector, "industry": industry,
        "thesis": thesis, "source": source,
    })

    themes = seed.get("themes") or []
    rows = [
        {"cik": cik, "name": str(t.get("name", "")).strip(),
         "note": str(t.get("note", "")).strip(), "rank": i, "source": "seed"}
        for i, t in enumerate(themes) if t.get("name")
    ]
    n = db.upsert_themes(rows, cik)
    logger.info("  %s profile: %s / %s · %d themes (%s)", ticker, sector, industry, n, source)
