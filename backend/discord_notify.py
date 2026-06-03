"""
Discord webhook alerts.

Posts a single rich embed per flagged filing: company, form type, signals
fired, composite severity, AI summary excerpt, and a direct EDGAR link.
A silent no-op when DISCORD_WEBHOOK_URL is unset, so the pipeline still runs
without notifications configured.
"""

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_TIMEOUT = 10  # seconds

# Severity → embed color (decimal RGB) and label, mirrors the frontend bands.
_SEVERITY_BANDS: list[tuple[int, int, str]] = [
    (75, 0xF0_52_52, "Critical"),   # red
    (50, 0xF5_A6_23, "Elevated"),   # amber
    (25, 0x4F_8D_D4, "Notable"),    # blue
    (0,  0x4F_D4_C2, "Routine"),    # teal
]

_SIGNAL_LABELS: dict[str, str] = {
    "signal_supply_chain":    "Supply chain",
    "signal_geopolitical":    "Geopolitical",
    "signal_mgmt_changes":    "Management change",
    "signal_earnings":        "Earnings risk",
    "uli_flagged":            "Uncertainty language ↑",
    "r_delta_flagged":        "Risk factors rewritten",
    "filing_velocity_flag":   "Late filing",
    "friday_dump":            "Friday dump",
    "section_length_anomaly": "Risk section expanded",
    "burst_8k_flag":          "8-K burst",
}


def _band(severity: float) -> tuple[int, str]:
    for floor, color, label in _SEVERITY_BANDS:
        if severity >= floor:
            return color, label
    return _SEVERITY_BANDS[-1][1], _SEVERITY_BANDS[-1][2]


def _fired_labels(signals: dict[str, Any]) -> list[str]:
    fired: list[str] = []
    for key in ("signal_supply_chain", "signal_geopolitical",
                "signal_mgmt_changes", "signal_earnings"):
        sig = signals.get(key)
        if isinstance(sig, dict) and sig.get("flagged"):
            fired.append(_SIGNAL_LABELS[key])
    if signals.get("risk_factor_delta", 0) > 0.25:
        fired.append(_SIGNAL_LABELS["r_delta_flagged"])
    for key in ("filing_velocity_flag", "friday_dump",
                "section_length_anomaly", "burst_8k_flag"):
        if signals.get(key):
            fired.append(_SIGNAL_LABELS[key])
    return fired


def send(
    company_name: str,
    ticker: str,
    form_type: str,
    filing_url: str | None,
    signals: dict[str, Any],
    enrichment: dict[str, Any] | None = None,
) -> None:
    """Post a rich embed for a flagged filing. No-op if no webhook configured."""
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook:
        return

    try:
        import requests
    except ImportError:
        logger.warning("requests not installed — skipping Discord notification")
        return

    severity = float(signals.get("severity_score") or 0)
    color, band_label = _band(severity)
    fired = _fired_labels(signals) or ["(structural signal)"]

    fields: list[dict[str, Any]] = [
        {"name": "Form",     "value": form_type, "inline": True},
        {"name": "Severity", "value": f"{int(severity)} · {band_label}", "inline": True},
        {"name": "Signals",  "value": ", ".join(fired), "inline": False},
    ]

    if enrichment and enrichment.get("summary"):
        summary = enrichment["summary"][:1_000]
        conf = enrichment.get("confidence")
        if conf is not None:
            summary += f"\n\n_confidence {float(conf):.0%}_"
        fields.append({"name": "AI summary", "value": summary, "inline": False})

    embed: dict[str, Any] = {
        "title": f"{company_name} ({ticker})",
        "color": color,
        "fields": fields,
    }
    if filing_url and filing_url.startswith(("http://", "https://")):
        embed["url"] = filing_url

    try:
        resp = requests.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
        if resp.status_code >= 400:
            logger.warning("Discord webhook returned %s: %s", resp.status_code, resp.text[:200])
    except requests.RequestException:
        logger.exception("Discord webhook post failed for %s %s", ticker, form_type)
