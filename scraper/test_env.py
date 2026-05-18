"""
Environment diagnostic script.
Run from the scraper/ directory with the venv active:
    python test_env.py

Reads SUPABASE_URL and SUPABASE_KEY from environment variables or prompts for them.
"""

import sys
import os
from dotenv import load_dotenv

load_dotenv()


PASS = "✓"
FAIL = "✗"


def check(label: str, fn) -> bool:
    try:
        fn()
        print(f"  {PASS}  {label}")
        return True
    except Exception as e:
        print(f"  {FAIL}  {label}")
        print(f"       {e}")
        return False


print("\n=== Summa Environment Check ===\n")

# --- Package imports ---
print("[1] Package imports")

check("requests",          lambda: __import__("requests"))
check("beautifulsoup4",    lambda: __import__("bs4"))
check("lxml",              lambda: __import__("lxml"))
check("spacy",             lambda: __import__("spacy"))
check("google-generativeai", lambda: __import__("google.generativeai"))
check("upstash-redis",     lambda: __import__("upstash_redis"))
check("supabase",          lambda: __import__("supabase"))
check("pytest",            lambda: __import__("pytest"))
check("python-dotenv",     lambda: __import__("dotenv"))
check("networkx",          lambda: __import__("networkx"))
check("yfinance",          lambda: __import__("yfinance"))
check("mcp",               lambda: __import__("mcp"))

# --- spaCy model ---
print("\n[2] spaCy model (en_core_web_md)")

nlp = None
def load_spacy():
    global nlp
    import spacy
    nlp = spacy.load("en_core_web_md")

model_ok = check("en_core_web_md loads", load_spacy)

if model_ok and nlp is not None:
    def run_ner():
        doc = nlp("Apple is looking at buying U.K. startup for $1 billion")
        entities = [(ent.text, ent.label_) for ent in doc.ents]
        assert len(entities) > 0, "NER returned no entities"
        print(f"       sample NER: {entities}")
    check("NER pipeline works", run_ner)

# --- Supabase connection ---
print("\n[3] Supabase connection")

def _clean_url(raw: str) -> str:
    """Strip trailing slashes and any /rest/v1 suffix — supabase-py adds that itself."""
    return raw.strip().rstrip("/").removesuffix("/rest/v1")

url = _clean_url(os.environ.get("SUPABASE_URL", ""))
key = os.environ.get("SUPABASE_KEY", "").strip()

if not url:
    url = _clean_url(input("  Enter SUPABASE_URL: "))
if not key:
    key = input("  Enter SUPABASE_KEY (anon or service_role key): ").strip()

if url and key:
    print(f"       URL: {url}")
    def connect_supabase():
        from supabase import create_client
        client = create_client(url, key)
        result = client.table("filings").select("id").limit(1).execute()
        print(f"       filings table reachable, rows returned: {len(result.data)}")

    check("Supabase client connects + filings table exists", connect_supabase)
else:
    print(f"  -  Skipped (no credentia  ls provided)")

print("\n=== Done ===\n")
