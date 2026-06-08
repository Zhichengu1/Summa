"""Standalone maintenance scripts run on their own schedules (not by main.py):
build_sec_index (weekly SEC index rebuild) and cleanup (monthly retention).
Run as modules from the backend/ dir, e.g. `python -m tools.cleanup`."""
