"""
Phase 2 — shared Gemini client (google-genai SDK, Google AI Studio free tier ONLY).

One lazily-initialized singleton `genai.Client` gated on GEMINI_API_KEY, plus
`analyze_filing()` for structured filing summaries. Zero-cost invariant: the
Google AI Studio API key is the only auth path — never Vertex AI, never a GCP
project/billing reference, never a paid-tier fallback or retry-upgrade. A local
daily request counter and a conservative RPM throttle keep usage well under the
free tier's ~1,500 req/day Flash cap. On quota exhaustion (HTTP 429 /
RESOURCE_EXHAUSTED) calls log a warning, stop for the rest of the process, and
return None so callers degrade gracefully.

Callers in the pipeline must invoke this module through `main._run_optional()`
(and/or treat a None return as "no enrichment"), so a Gemini outage or an
exhausted quota can never abort the core ingest run.
"""

import json
import logging
import os
import re
import time
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

# One-line change to swap models later. "gemini-2.5-flash-lite" is the cheaper
# variant for high-volume / low-complexity calls. (gemini-2.0-flash was retired
# 2026-06-01 — do not reintroduce it.)
MODEL = "gemini-2.5-flash"

# Free-tier budget guards (Google AI Studio Flash: ~1,500 req/day).
_MAX_REQUESTS_PER_DAY = 1_200   # conservative headroom under the ~1,500 cap
_MIN_SECONDS_BETWEEN_CALLS = 8.0  # ~7.5 req/min — never hammer the endpoint

_MAX_INPUT_CHARS = 8_000  # section text is pre-cleaned and capped upstream

_ANALYSIS_KEYS = (
    "eps_signal",
    "supply_chain_risk",
    "geopolitics",
    "management_changes",
    "one_line_summary",
)

_client: Any = None
_init_failed = False
_quota_exhausted = False       # set on 429/RESOURCE_EXHAUSTED; sticky per process
_last_call_at: float = 0.0     # monotonic time of the last request
_count_day: date | None = None
_count_today = 0


def _get_client() -> Any:
    """Lazily build the singleton google-genai Client; None when unavailable."""
    global _client, _init_failed
    if _client is not None or _init_failed:
        return _client
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        _init_failed = True
        return None
    try:
        from google import genai
        _client = genai.Client(api_key=api_key)
    except Exception:
        logger.exception("Gemini client init failed — enrichment disabled")
        _init_failed = True
        return None
    return _client


def _budget_ok() -> bool:
    """Check the local daily counter and the sticky quota-exhausted flag."""
    global _count_day, _count_today
    if _quota_exhausted:
        return False
    today = date.today()
    if _count_day != today:
        _count_day, _count_today = today, 0
    if _count_today >= _MAX_REQUESTS_PER_DAY:
        logger.warning(
            "Gemini local daily budget reached (%d) — skipping further calls today",
            _MAX_REQUESTS_PER_DAY,
        )
        return False
    return True


def _throttle() -> None:
    """Sleep just enough to keep calls under the conservative RPM ceiling."""
    global _last_call_at
    wait = _MIN_SECONDS_BETWEEN_CALLS - (time.monotonic() - _last_call_at)
    if wait > 0:
        time.sleep(wait)
    _last_call_at = time.monotonic()


def _is_quota_error(exc: Exception) -> bool:
    """True when an exception is an HTTP 429 / quota / RESOURCE_EXHAUSTED error."""
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    text = str(exc)
    return code == 429 or "RESOURCE_EXHAUSTED" in text or "429" in text


def _parse_json(raw: str) -> dict[str, Any] | None:
    """Parse a model response into a dict; tolerant of stray fences/preamble."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def generate_json(prompt: str) -> dict[str, Any] | None:
    """Run one budgeted, throttled Gemini call and return its JSON body.

    Returns None (never raises) when the key is absent, the local budget is
    spent, the quota is exhausted (429/RESOURCE_EXHAUSTED — no retry, no tier
    fallback), the call fails, or the response is not parseable JSON.
    """
    global _quota_exhausted, _count_today
    client = _get_client()
    if client is None or not _budget_ok():
        return None

    _throttle()
    try:
        from google.genai import types
        response = client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )
    except Exception as exc:
        if _is_quota_error(exc):
            _quota_exhausted = True
            logger.warning(
                "Gemini quota exhausted (429/RESOURCE_EXHAUSTED) — "
                "disabling enrichment for the rest of this run: %s", exc,
            )
        else:
            logger.exception("Gemini call failed")
        return None

    _count_today += 1
    logger.info("Gemini usage: %d/%d requests today", _count_today, _MAX_REQUESTS_PER_DAY)

    parsed = _parse_json(getattr(response, "text", "") or "")
    if parsed is None:
        logger.warning("Gemini response was not valid JSON — discarding")
    return parsed


def analyze_filing(sections: dict[str, str]) -> dict[str, Any] | None:
    """Summarize cleaned SEC filing sections into a structured signal dict.

    `sections` maps section labels (e.g. "Item 1A", "Item 7") to pre-cleaned
    text; the combined input is capped at 8,000 chars. Returns a dict with
    exactly the keys eps_signal, supply_chain_risk, geopolitics,
    management_changes, one_line_summary — or None when Gemini is unavailable,
    over budget, or the response fails to parse/validate.
    """
    cleaned = {k: v.strip() for k, v in sections.items() if v and v.strip()}
    if not cleaned:
        return None

    budget = _MAX_INPUT_CHARS
    parts: list[str] = []
    for label, text in cleaned.items():
        if budget <= 0:
            break
        chunk = text[:budget]
        parts.append(f"## {label}\n{chunk}")
        budget -= len(chunk)
    body = "\n\n".join(parts)

    prompt = (
        "You are an institutional equity analyst. Analyze the following cleaned "
        "SEC filing sections.\n\n"
        f"{body}\n\n"
        "Respond with ONLY a valid JSON object — no markdown fences, no preamble "
        "— matching exactly this schema:\n"
        '{"eps_signal": "positive|negative|neutral|unclear + one clause of why", '
        '"supply_chain_risk": "none|low|elevated|high + one clause of why", '
        '"geopolitics": "none|low|elevated|high + one clause of why", '
        '"management_changes": "none, or a one-clause description of the change", '
        '"one_line_summary": "one plain-English sentence for a portfolio manager"}'
    )

    parsed = generate_json(prompt)
    if parsed is None:
        return None

    missing = [k for k in _ANALYSIS_KEYS if k not in parsed]
    if missing:
        logger.warning("Gemini analysis missing keys %s — discarding", missing)
        return None
    return {k: str(parsed[k]).strip() for k in _ANALYSIS_KEYS}
