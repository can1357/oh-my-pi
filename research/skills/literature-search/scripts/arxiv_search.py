#!/usr/bin/env python3
"""Search the arXiv Atom export API (keyless). One JSON object per line."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _http

ATOM = "{http://www.w3.org/2005/Atom}"
UA = "research-harness/0.1 (personal research tool)"


def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip()


def main():
    ap = argparse.ArgumentParser(description="Search arXiv, emit JSON lines.")
    ap.add_argument("--query", required=True)
    ap.add_argument("--max", type=int, default=15)
    ap.add_argument("--category", help="arXiv category, e.g. cs.CL (ANDed as cat:<c>)")
    args = ap.parse_args()

    search_query = f"all:{args.query}"
    if args.category:
        search_query += f" AND cat:{args.category}"
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {
            "search_query": search_query,
            "start": 0,
            "max_results": args.max,
            "sortBy": "relevance",
        }
    )

    try:
        # arXiv asks for ~1 request per 3s; min_interval enforces it in-process.
        body = _http.fetch(url, UA, timeout=30, min_interval=3.0)
    except urllib.error.HTTPError as e:
        print(f"arxiv_search: HTTP {e.code} after retries: {e}", file=sys.stderr)
        sys.exit(1)
    except (urllib.error.URLError, OSError) as e:
        print(f"arxiv_search: HTTP failure after retries: {e}", file=sys.stderr)
        sys.exit(1)

    root = ET.fromstring(body)
    for entry in root.findall(f"{ATOM}entry"):
        full_id = entry.findtext(f"{ATOM}id") or ""
        arxiv_id = full_id.rsplit("/abs/", 1)[-1]
        pdf_url = ""
        for link in entry.findall(f"{ATOM}link"):
            if (
                link.get("rel") == "related"
                and link.get("type") == "application/pdf"
            ):
                pdf_url = link.get("href", "")
                break
        if not pdf_url and arxiv_id:
            pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
        rec = {
            "source": "arxiv",
            "id": arxiv_id,
            "title": norm_ws(entry.findtext(f"{ATOM}title")),
            "authors": [
                norm_ws(a.findtext(f"{ATOM}name"))
                for a in entry.findall(f"{ATOM}author")
            ],
            "abstract": norm_ws(entry.findtext(f"{ATOM}summary")),
            "published": norm_ws(entry.findtext(f"{ATOM}published")),
            "pdf_url": pdf_url,
        }
        print(json.dumps(rec, ensure_ascii=False))


if __name__ == "__main__":
    main()
