"""
Stage 2 — Gemini enrichment.

Called only when Stage 1 has flagged a filing. Receives a short excerpt
(~150–300 words) built from the flagged signal outputs — never the full filing.
Returns a structured dict {summary, confidence, tags}. All calls are gated on
GEMINI_API_KEY being present; without it, enrichment is a silent no-op so the
rest of the pipeline still writes complete signal data.
"""

import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

_MODEL_NAME = "gemini-2.0-flash-exp"
_MAX_EXCERPT_CHARS = 2_000  # hard cap — excerpt only, never a full section

# Human-readable labels for the signal columns, used to describe what fired.
_SIGNAL_LABELS: dict[str, str] = {
    "signal_supply_chain": "supply-chain keyword density",
    "signal_geopolitical":  "geopolitical keyword density",
    "signal_mgmt_changes":  "management-change keyword density",
    "signal_earnings":      "earnings-risk keyword density",
    "uli_flagged":          "uncertainty language elevated vs company baseline",
    "risk_factor_delta":    "risk factors materially rewritten",
    "filing_velocity_flag": "filed unusually late vs company median",
    "friday_dump":          "filed Friday after market close",
    "section_length_anomaly": "risk factors section expanded anomalously",
    "burst_8k_flag":        "burst of 8-K filings in 30 days",
}

_model: Any = None
_init_failed = False


def _get_model() -> Any:
    """Lazily configure the Gemini client; returns None when unavailable."""
    global _model, _init_failed
    if _model is not None or _init_failed:
        return _model
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        _init_failed = True
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        _model = genai.GenerativeModel(_MODEL_NAME)
    except Exception:
        logger.exception("Gemini client init failed — enrichment disabled")
        _init_failed = True
        return None
    return _model


def _build_excerpt(signals: dict[str, Any]) -> tuple[str, list[str]]:
    """
    Assemble a compact excerpt from the flagged signal outputs only.
    Returns (excerpt_text, list_of_fired_signal_labels).
    """
    fired: list[str] = []
    parts: list[str] = []

    for key in ("signal_supply_chain", "signal_geopolitical",
                "signal_mgmt_changes", "signal_earnings"):
        sig = signals.get(key)
        if isinstance(sig, dict) and sig.get("flagged"):
            fired.append(_SIGNAL_LABELS[key])
            excerpt = (sig.get("excerpt") or "").strip()
            if excerpt:
                parts.append(excerpt)

    for key in ("uli_flagged", "risk_factor_delta", "filing_velocity_flag",
                "friday_dump", "section_length_anomaly", "burst_8k_flag"):
        # risk_factor_delta is a float; treat >0.25 as fired, others are bools
        val = signals.get(key)
        fired_flag = (val > 0.25) if key == "risk_factor_delta" else bool(val)
        if fired_flag:
            fired.append(_SIGNAL_LABELS[key])

    excerpt_text = " ".join(parts)[:_MAX_EXCERPT_CHARS]
    return excerpt_text, fired


def _parse_json(raw: str) -> dict[str, Any] | None:
    """Extract the first JSON object from a model response (handles code fences)."""
    if not raw:
        return None
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def enrich(
    company_name: str,
    ticker: str,
    form_type: str,
    signals: dict[str, Any],
) -> dict[str, Any] | None:
    """
    Run Stage 2 enrichment on a flagged filing.

    Returns {"summary": str, "confidence": float, "tags": list[str]} or None
    when Gemini is unavailable or the response cannot be parsed.
    """
    model = _get_model()
    if model is None:
        return None

    excerpt, fired = _build_excerpt(signals)
    if not fired:
        return None  # nothing flagged — should not happen, but guard anyway

    prompt = (
        "You are an institutional equity analyst. A rule-based system flagged the "
        f"following SEC {form_type} from {company_name} ({ticker}).\n\n"
        f"SIGNALS THAT FIRED:\n- " + "\n- ".join(fired) + "\n\n"
        f"EXCERPT (pre-extracted, do not assume anything beyond it):\n{excerpt or '(no text excerpt; signals are structural)'}\n\n"
        "Respond with ONLY valid JSON matching this schema:\n"
        '{"summary": "2-3 sentence plain-English read for a portfolio manager", '
        '"confidence": 0.0-1.0, '
        '"tags": ["short", "lowercase", "theme", "tags"]}'
    )

    try:
        response = model.generate_content(prompt)
        parsed = _parse_json(getattr(response, "text", "") or "")
    except Exception:
        logger.exception("Gemini enrichment call failed for %s %s", ticker, form_type)
        return None

    if not parsed:
        return None

    summary = str(parsed.get("summary", "")).strip()
    if not summary:
        return None

    try:
        confidence = float(parsed.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    tags = parsed.get("tags", [])
    tags = [str(t).strip() for t in tags][:8] if isinstance(tags, list) else []

    return {"summary": summary, "confidence": confidence, "tags": tags}
