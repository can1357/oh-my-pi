#!/usr/bin/env python3
"""Search OpenAlex works (keyless). One JSON object per line."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _http

UA = "research-harness/0.1 (personal research tool)"
# OpenAlex "polite pool": include a mailto in the UA when the caller provides one.
_MAILTO = os.environ.get("OPENALEX_MAILTO")
if _MAILTO:
    UA += f" mailto:{_MAILTO}"


def reconstruct_abstract(inv_index):
    if not inv_index:
        return ""
    words = {}
    for word, positions in inv_index.items():
        for pos in positions:
            words[pos] = word
    return " ".join(words[i] for i in sorted(words))


def main():
    ap = argparse.ArgumentParser(description="Search OpenAlex, emit JSON lines.")
    ap.add_argument("--query", required=True)
    ap.add_argument("--max", type=int, default=15)
    ap.add_argument("--from-year", type=int, help="only works published from this year")
    args = ap.parse_args()

    params = {
        "search": args.query,
        "per-page": args.max,
        "sort": "relevance_score:desc",
    }
    if args.from_year:
        params["filter"] = f"from_publication_date:{args.from_year}-01-01"
    url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)

    try:
        data = json.loads(_http.fetch(url, UA, timeout=30))
    except urllib.error.HTTPError as e:
        print(f"openalex_search: HTTP {e.code} after retries: {e}", file=sys.stderr)
        sys.exit(1)
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"openalex_search: HTTP failure after retries: {e}", file=sys.stderr)
        sys.exit(1)

    for work in data.get("results", []):
        loc = work.get("primary_location") or {}
        src = loc.get("source") or {}
        best_oa = work.get("best_oa_location") or {}
        oa = work.get("open_access") or {}
        rec = {
            "source": "openalex",
            "id": work.get("id"),
            "doi": work.get("doi"),
            "title": work.get("title"),
            "authors": [
                (a.get("author") or {}).get("display_name")
                for a in work.get("authorships", [])
            ],
            "year": work.get("publication_year"),
            "venue": src.get("display_name"),
            "cited_by": work.get("cited_by_count"),
            "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
            "oa_pdf_url": best_oa.get("pdf_url") or oa.get("oa_url"),
        }
        print(json.dumps(rec, ensure_ascii=False))


if __name__ == "__main__":
    main()
