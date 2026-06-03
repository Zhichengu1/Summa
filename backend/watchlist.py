"""Watchlist of companies the Summa pipeline ingests, keyed by zero-padded CIK."""

from typing import TypedDict


class WatchedCompany(TypedDict):
    cik: str
    ticker: str
    name: str


WATCHLIST: list[WatchedCompany] = [
    {"cik": "0000320193", "ticker": "AAPL",  "name": "Apple Inc."},
    {"cik": "0000789019", "ticker": "MSFT",  "name": "Microsoft Corporation"},
    {"cik": "0001018724", "ticker": "AMZN",  "name": "Amazon.com Inc."},
    {"cik": "0001652044", "ticker": "GOOGL", "name": "Alphabet Inc."},
    {"cik": "0001326801", "ticker": "META",  "name": "Meta Platforms Inc."},
    {"cik": "0001318605", "ticker": "TSLA",  "name": "Tesla Inc."},
    {"cik": "0001045810", "ticker": "NVDA",  "name": "NVIDIA Corporation"},
]
