#!/usr/bin/env python3
"""Fetch open-access PDFs, with an OA-first resolver cascade.

fetch:   download one known OA URL. Requires HTTP 200 and >10KB.
resolve: find a legal open-access copy for a DOI or a review.db record,
         trying in order: OpenAlex -> Unpaywall -> arXiv -> local corpus ->
         web search (last, and it only RETURNS a candidate URL for human
         review — it never downloads from an arbitrary host).

Policy: open-access sources only. With --id the outcome is written back to
the review store (state, pdf_path, oa_source, oa_status), so PRISMA
"not retrieved" counts stay honest.
"""
import argparse
import glob as globmod
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _http
import review

UA = "research-harness/0.1 (personal research tool)"
_MAILTO = os.environ.get("OPENALEX_MAILTO")
if _MAILTO:
    UA += f" mailto:{_MAILTO}"
MIN_BYTES = 10 * 1024


def norm_doi(doi):
    if not doi:
        return None
    d = re.sub(r"\s+", "", str(doi)).lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    d = re.sub(r"^doi:", "", d)
    return d or None


def get_json(url):
    """GET a JSON API endpoint; None on HTTP 404, raises on other failures."""
    try:
        return json.loads(_http.fetch(url, UA, timeout=30))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def download(url, out):
    """Download url to out; returns byte count. Raises ValueError/URLError on failure."""
    body = _http.fetch(url, UA, timeout=60)
    if len(body) <= MIN_BYTES:
        raise ValueError(f"response too small ({len(body)} bytes <= {MIN_BYTES}); "
                         "probably an HTML landing page, not a PDF")
    p = pathlib.Path(out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    return len(body)


# ---------------- cascade steps ----------------
# Each step returns {"pdf_url" or "pdf_path", "oa_status"?} or None.


def step_openalex(doi, title, url):
    if not doi:
        return None
    work = get_json("https://api.openalex.org/works/doi:" + urllib.parse.quote(doi, safe=""))
    if not work:
        return None
    best = work.get("best_oa_location") or {}
    oa = work.get("open_access") or {}
    pdf = best.get("pdf_url") or oa.get("oa_url")
    status = oa.get("oa_status")
    if not pdf:
        return {"oa_status": status} if status else None
    return {"pdf_url": pdf, "oa_status": status}


def step_unpaywall(doi, title, url):
    if not doi:
        return None
    email = os.environ.get("UNPAYWALL_EMAIL") or os.environ.get("OPENALEX_MAILTO")
    if not email:
        print("fetch_paper: skipping Unpaywall — set UNPAYWALL_EMAIL (or OPENALEX_MAILTO); "
              "their API requires a real contact email and this tool never sends a fake one",
              file=sys.stderr)
        return {"skipped": "no contact email configured"}
    data = get_json(f"https://api.unpaywall.org/v2/{urllib.parse.quote(doi, safe='/')}"
                    f"?email={urllib.parse.quote(email)}")
    if not data:
        return None
    best = data.get("best_oa_location") or {}
    pdf = best.get("url_for_pdf") or best.get("url")
    status = data.get("oa_status")
    if not pdf:
        return {"oa_status": status} if status else None
    return {"pdf_url": pdf, "oa_status": status}


ARXIV_DOI_RE = re.compile(r"10\.48550/arxiv\.(\S+)", re.I)
ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+?)(?:\.pdf)?$", re.I)


def step_arxiv(doi, title, url):
    for s in (doi, url):
        if not s:
            continue
        m = ARXIV_DOI_RE.search(s) or ARXIV_URL_RE.search(s)
        if m:
            # arXiv is a green OA repository by definition.
            return {"pdf_url": f"https://arxiv.org/pdf/{m.group(1)}", "oa_status": "green"}
    return None


def step_local(doi, title, url):
    corpus = os.environ.get("RESEARCH_CORPUS_DIR")
    if not corpus or not os.path.isdir(os.path.expanduser(corpus)):
        return None
    import local_library
    want_doi = norm_doi(doi)
    want_title = review.norm_title(title)
    for pdf in sorted(globmod.glob(os.path.join(os.path.expanduser(corpus), "*.pdf"))):
        rec = local_library.scan_one(pdf)
        if want_doi and norm_doi(rec.get("doi")) == want_doi:
            return {"pdf_path": pdf}
        if want_title and review.norm_title(rec.get("title")) == want_title:
            return {"pdf_path": pdf}
    return None


def step_web_search(doi, title, url):
    """LAST resort: emit search-page URLs for a human to review. Never downloads."""
    q = urllib.parse.quote(f'"{title}"' if title else doi)
    return {
        "candidate_url": f"https://scholar.google.com/scholar?q={q}",
        "needs_human_review": True,
    }


STEPS = [
    ("openalex", step_openalex),
    ("unpaywall", step_unpaywall),
    ("arxiv", step_arxiv),
    ("local", step_local),
    ("web_search", step_web_search),
]


def cmd_resolve(args):
    rec = con = pdir = None
    doi, title, url = norm_doi(args.doi), None, None
    if args.id:
        pdir = review.project_dir(args.project)
        con = review.connect(pdir)
        rec = review.get_record(con, args.id)
        doi = norm_doi(rec["doi"]) or doi
        title, url = rec["title"], rec["url"]
    if not doi and not title:
        print("fetch_paper: resolve needs --doi or --id", file=sys.stderr)
        sys.exit(2)

    # Idempotent: an already-retrieved record with its PDF on disk stays put.
    if rec and rec["state"] == "included" or (
        rec and rec["state"] == "fulltext_retrieved" and rec["pdf_path"]
        and os.path.exists(rec["pdf_path"])
    ):
        print(json.dumps({"record_id": rec["id"], "doi": doi, "resolved": True,
                          "oa_source": rec["oa_source"], "oa_status": rec["oa_status"],
                          "pdf_path": rec["pdf_path"], "already_retrieved": True}))
        con.close()
        return

    if rec and rec["state"] == "screened_included":
        rec = review.transition(con, rec, "fulltext_sought", note="retrieval cascade started")

    result = {"record_id": rec["id"] if rec else None, "doi": doi, "resolved": False,
              "oa_source": None, "oa_status": None, "pdf_url": None, "pdf_path": None,
              "candidate_url": None, "needs_human_review": False, "tried": []}

    for name, step in STEPS:
        try:
            hit = step(doi, title, url)
        except (urllib.error.URLError, OSError, ValueError) as e:
            result["tried"].append({"step": name, "outcome": f"error: {e}"})
            continue
        if not hit:
            result["tried"].append({"step": name, "outcome": "miss"})
            continue
        if hit.get("skipped"):
            result["tried"].append({"step": name, "outcome": f"skipped: {hit['skipped']}"})
            continue
        if hit.get("oa_status") and not result["oa_status"]:
            result["oa_status"] = hit["oa_status"]
        if hit.get("candidate_url"):
            result["candidate_url"] = hit["candidate_url"]
            result["needs_human_review"] = True
            result["tried"].append({"step": name, "outcome": "candidate for human review"})
            break
        if hit.get("pdf_path"):
            result.update(resolved=True, oa_source=name, pdf_path=hit["pdf_path"])
            result["tried"].append({"step": name, "outcome": "local PDF"})
            break
        pdf_url = hit.get("pdf_url")
        if not pdf_url:
            result["tried"].append({"step": name, "outcome": "no OA URL"})
            continue
        if not args.fetch:
            result.update(resolved=True, oa_source=name, pdf_url=pdf_url)
            result["tried"].append({"step": name, "outcome": "OA URL found (not fetched)"})
            break
        out = args.out or (os.path.join(pdir, "papers",
                           re.sub(r"[^\w.-]+", "-", rec["id"]) + ".pdf") if rec else None)
        if not out:
            print("fetch_paper: --fetch with --doi needs --out", file=sys.stderr)
            sys.exit(2)
        try:
            size = download(pdf_url, out)
        except (urllib.error.URLError, ValueError, OSError) as e:
            result["tried"].append({"step": name, "outcome": f"fetch failed: {e}"})
            continue
        result.update(resolved=True, oa_source=name, pdf_url=pdf_url, pdf_path=out)
        result["tried"].append({"step": name, "outcome": f"fetched {size} bytes"})
        break

    if rec:
        if result["resolved"]:
            rec = review.transition(con, rec, "fulltext_retrieved",
                                    note=f"retrieved via {result['oa_source']}",
                                    pdf_path=result["pdf_path"],
                                    oa_source=result["oa_source"],
                                    oa_status=result["oa_status"])
        else:
            reason = "no open-access copy found"
            if result["candidate_url"]:
                reason += " (web-search candidate pending human review)"
            rec = review.transition(con, rec, "fulltext_not_retrieved", note=reason,
                                    exclusion_reason=reason,
                                    oa_status=result["oa_status"])
        con.close()
    print(json.dumps(result, ensure_ascii=False))


def cmd_fetch(args):
    try:
        size = download(args.url, args.out)
    except urllib.error.HTTPError as e:
        print(f"fetch_paper: HTTP {e.code} after retries for {args.url}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"fetch_paper: {e}", file=sys.stderr)
        sys.exit(1)
    except (urllib.error.URLError, OSError) as e:
        print(f"fetch_paper: HTTP failure after retries: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"saved {args.out} ({size} bytes)")


def main():
    argv = sys.argv[1:]
    # Back-compat: `fetch_paper.py --url U --out O` still works.
    if argv and argv[0].startswith("--"):
        argv = ["fetch"] + argv

    ap = argparse.ArgumentParser(description="Fetch open-access paper PDFs (OA-first).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("fetch", help="download one known OA URL")
    p.add_argument("--url", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("resolve", help="OA-first cascade: OpenAlex -> Unpaywall -> arXiv "
                                       "-> local corpus -> web-search candidate")
    p.add_argument("--doi")
    p.add_argument("--id", help="review.db record id (writes the outcome back)")
    p.add_argument("--project", help="project slug or directory (with --id)")
    p.add_argument("--fetch", action="store_true", help="download the resolved PDF")
    p.add_argument("--out", help="output path for --fetch (default <project>/papers/<id>.pdf)")
    p.set_defaults(func=cmd_resolve)

    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
