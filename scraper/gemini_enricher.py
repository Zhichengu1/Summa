"""
Stage 2: Gemini 2.0 Flash enrichment — runs only when signals_flagged=True.

Free-tier limits (Gemini API):
  - 15 req/min  →  enforce ≥4.1 s between calls
  - 1,500 req/day → conservative 1,400/day in-process cap

Note: the daily cap resets on process restart. Each GitHub Actions run is a new
process, so the cap guards against runaway bugs within a single run rather than
tracking across all 48 daily runs. For 7 watchlist companies the realistic max is
~240 Gemini calls/day (every filing flagged), well under the 1,500 hard limit.
"""

import logging
import os
import time
import datetime

log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

_MIN_INTERVAL_S = 4.1      # 15 req/min → 1 req per 4.1 s minimum
_DAILY_CAP      = 1_400    # conservative below the 1,500 hard limit

# Module-level state — resets on each process start (i.e. each GitHub Actions run)
_last_call_ts: float = 0.0
_daily_count:  int   = 0
_count_date:   str   = ""  # "YYYY-MM-DD" of the current UTC counter window

# Lazy-initialised SDK objects — only created on the first actual call to enrich().
# This means GEMINI_API_KEY is only required when Gemini is actually used, not on import.
_model = None


def _get_model():
    """Return the Gemini model instance, initialising the SDK on first call."""
    global _model
    if _model is None:
        import google.generativeai as genai
        genai.configure(api_key=os.environ["GEMINI_API_KEY"])
        _model = genai.GenerativeModel("gemini-2.0-flash")
    return _model


def _reset_daily_counter_if_needed() -> None:
    global _daily_count, _count_date
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    if _count_date != today:
        _daily_count = 0
        _count_date  = today


def _throttle() -> None:
    """Block until at least _MIN_INTERVAL_S has elapsed since the last call."""
    global _last_call_ts
    elapsed = time.monotonic() - _last_call_ts
    if elapsed < _MIN_INTERVAL_S:
        time.sleep(_MIN_INTERVAL_S - elapsed)
    _last_call_ts = time.monotonic()


PROMPT_TEMPLATE = """\
You are a financial analyst reviewing an SEC filing excerpt.
Filing type: {form_type}
Company: {company_name} ({ticker})
Period: {period}

Excerpt from MD&A / Risk Factors:
\"\"\"
{text}
\"\"\"

In 2-3 sentences, summarise the single most important risk or development.
Then on a new line output: CONFIDENCE: <0.0-1.0>
""".strip()


def enrich(filing: dict) -> dict | None:
    """
    Call Gemini to enrich a flagged filing.  Returns a dict with keys:
      gemini_summary, gemini_confidence, gemini_ran
    Returns None if the daily cap is reached or an error occurs.
    """
    global _daily_count

    _reset_daily_counter_if_needed()

    if _daily_count >= _DAILY_CAP:
        log.warning("Gemini daily cap of %d reached — skipping enrichment", _DAILY_CAP)
        return None

    text = (filing.get("section_mda") or filing.get("section_risk_factors") or "")[:3_000]
    if not text.strip():
        return None

    prompt = PROMPT_TEMPLATE.format(
        form_type    = filing.get("form_type", ""),
        company_name = filing.get("company_name", ""),
        ticker       = filing.get("ticker", ""),
        period       = filing.get("period_of_report", ""),
        text         = text,
    )

    _throttle()

    try:
        model = _get_model()
        response = model.generate_content(prompt)
        raw = response.text.strip()
    except Exception as exc:
        log.error("Gemini API error for %s: %s", filing.get("accession_number"), exc)
        return None

    _daily_count += 1

    # Parse "CONFIDENCE: 0.85" from last line
    confidence = 0.0
    lines = raw.splitlines()
    for line in reversed(lines):
        if line.upper().startswith("CONFIDENCE:"):
            try:
                confidence = float(line.split(":", 1)[1].strip())
            except ValueError:
                pass
            break

    summary = "\n".join(
        l for l in lines if not l.upper().startswith("CONFIDENCE:")
    ).strip()

    return {
        "gemini_summary":    summary,
        "gemini_confidence": confidence,
        "gemini_ran":        True,
    }
