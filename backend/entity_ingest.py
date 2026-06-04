"""Entity-context ingest — seeds the global `entities` registry.

Phase A: loads the curated seeds/entities.yaml into the `entities` table. Each
seed entry may carry several `match` substrings; we write one row per substring
(match_key is the primary key) so the frontend can do a flat client-side lookup.

Phase C (later): batch-classify unknown manager/filer names seen in the holdings
tables via the LLM. Not implemented here.

This runs once per pipeline pass, not per company.
"""

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

import db

logger = logging.getLogger(__name__)

_SEED_PATH = Path(__file__).resolve().parent / "seeds" / "entities.yaml"


@lru_cache(maxsize=1)
def _seed_entities() -> list[dict[str, Any]]:
    try:
        with _SEED_PATH.open(encoding="utf-8") as fh:
            return yaml.safe_load(fh) or []
    except FileNotFoundError:
        logger.warning("seed entities not found at %s", _SEED_PATH)
        return []
    except Exception:
        logger.exception("failed to load seed entities")
        return []


def ingest_entities() -> None:
    """Upsert all seed entity rows into the `entities` table."""
    rows: list[dict[str, Any]] = []
    for entry in _seed_entities():
        kind = str(entry.get("kind", "")).strip()
        note = str(entry.get("note", "")).strip()
        for m in entry.get("match", []) or []:
            key = str(m).strip().lower()
            if key:
                rows.append({"match_key": key, "kind": kind, "note": note, "source": "seed"})
    n = db.upsert_entities(rows)
    logger.info("entities registry: %d match keys seeded", n)
