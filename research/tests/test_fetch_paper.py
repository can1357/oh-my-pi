"""fetch_paper.py resolve cascade: order, Unpaywall skip, closed access, OA fields."""
import argparse
import email.message
import io
import json
import os
import unittest
import urllib.error
from unittest import mock

import helpers
import _http
import fetch_paper
import local_library
import review


def ns(**kw):
    kw.setdefault("doi", None)
    kw.setdefault("id", None)
    kw.setdefault("project", None)
    kw.setdefault("fetch", False)
    kw.setdefault("out", None)
    return argparse.Namespace(**kw)


def http_404(url):
    return urllib.error.HTTPError(url, 404, "not found", email.message.Message(),
                                  io.BytesIO(b""))


class FakeFetch:
    """_http.fetch stand-in routed by URL substring.

    Any URL without a fixture raises AssertionError — NOT one of the error
    types cmd_resolve tolerates — so an unmocked network touch fails the test
    instead of being logged as a cascade miss.
    """

    def __init__(self, routes):
        self.routes = routes  # [(substring, dict payload | Exception)]
        self.urls = []

    def __call__(self, url, user_agent, timeout=30, min_interval=0.0):
        self.urls.append(url)
        for sub, payload in self.routes:
            if sub in url:
                if isinstance(payload, Exception):
                    raise payload
                return json.dumps(payload).encode()
        raise AssertionError(f"no fixture for fetched URL: {url}")


OPENALEX_MISS = ("api.openalex.org", http_404("https://api.openalex.org/works/x"))
CASCADE = ["openalex", "unpaywall", "arxiv", "local", "web_search"]


class FetchCase(helpers.ResearchCase):
    def resolve(self, routes, **kw):
        fake = FakeFetch(routes)
        with mock.patch.object(_http, "fetch", fake):
            with helpers.captured() as (out, err):
                fetch_paper.cmd_resolve(ns(**kw))
        return json.loads(out.getvalue()), err.getvalue(), fake


class CascadeOrderTest(FetchCase):
    def test_full_miss_walks_steps_in_order_web_search_last(self):
        result, err, fake = self.resolve([OPENALEX_MISS], doi="10.1234/closed.1")
        self.assertEqual([t["step"] for t in result["tried"]], CASCADE)
        self.assertEqual(result["tried"][-1]["step"], "web_search")
        # Web search only proposes a URL for a human; nothing was downloaded
        # and no OA URL was fabricated.
        self.assertFalse(result["resolved"])
        self.assertTrue(result["needs_human_review"])
        self.assertIn("scholar.google.com", result["candidate_url"])
        self.assertIsNone(result["pdf_url"])
        self.assertIsNone(result["pdf_path"])
        # Only the OpenAlex API was ever fetched: Unpaywall was skipped, arXiv
        # and local are offline matches, web search never downloads.
        self.assertEqual(len(fake.urls), 1)
        self.assertIn("api.openalex.org", fake.urls[0])

    def test_unpaywall_skipped_with_notice_when_no_email(self):
        result, err, fake = self.resolve([OPENALEX_MISS], doi="10.1234/closed.1")
        self.assertIn("skipping Unpaywall", err)
        self.assertIn("UNPAYWALL_EMAIL", err)
        up = [t for t in result["tried"] if t["step"] == "unpaywall"]
        self.assertEqual(up, [{"step": "unpaywall",
                               "outcome": "skipped: no contact email configured"}])
        self.assertFalse(any("unpaywall" in u for u in fake.urls))

    def test_openalex_hit_short_circuits_cascade(self):
        work = {"best_oa_location": {"pdf_url": "https://host.test/p.pdf"},
                "open_access": {"oa_status": "gold"}}
        result, _, fake = self.resolve([("api.openalex.org", work)],
                                       doi="10.1234/oa.1")
        self.assertTrue(result["resolved"])
        self.assertEqual(result["oa_source"], "openalex")
        self.assertEqual(result["oa_status"], "gold")
        self.assertEqual(result["pdf_url"], "https://host.test/p.pdf")
        self.assertEqual([t["step"] for t in result["tried"]], ["openalex"])

    def test_unpaywall_used_when_email_configured(self):
        os.environ["UNPAYWALL_EMAIL"] = "harness-test@folktale.io"
        data = {"best_oa_location": {"url_for_pdf": "https://host.test/u.pdf"},
                "oa_status": "green"}
        result, err, fake = self.resolve(
            [OPENALEX_MISS, ("api.unpaywall.org", data)], doi="10.1234/oa.2"
        )
        self.assertEqual(result["oa_source"], "unpaywall")
        self.assertEqual(result["pdf_url"], "https://host.test/u.pdf")
        self.assertEqual([t["step"] for t in result["tried"]],
                         ["openalex", "unpaywall"])
        self.assertNotIn("skipping Unpaywall", err)
        self.assertTrue(any("harness-test%40folktale.io" in u for u in fake.urls))

    def test_arxiv_doi_resolves_offline(self):
        result, _, fake = self.resolve([OPENALEX_MISS],
                                       doi="10.48550/arXiv.2401.12345")
        self.assertEqual(result["oa_source"], "arxiv")
        self.assertEqual(result["oa_status"], "green")
        self.assertEqual(result["pdf_url"], "https://arxiv.org/pdf/2401.12345")
        # arXiv resolution is pure string work; only OpenAlex hit the wire.
        self.assertEqual(len(fake.urls), 1)

    def test_local_corpus_checked_before_web_search(self):
        corpus = os.path.join(self.dir, "corpus")
        os.makedirs(corpus)
        pdf = os.path.join(corpus, "match.pdf")
        with open(pdf, "wb") as f:
            f.write(b"%PDF-1.4 stub")
        os.environ["RESEARCH_CORPUS_DIR"] = corpus
        with mock.patch.object(local_library, "scan_one",
                               return_value={"doi": "10.1234/local.1", "title": "X"}):
            result, _, _ = self.resolve([OPENALEX_MISS], doi="10.1234/local.1")
        self.assertTrue(result["resolved"])
        self.assertEqual(result["oa_source"], "local")
        self.assertEqual(result["pdf_path"], pdf)
        self.assertEqual([t["step"] for t in result["tried"]],
                         ["openalex", "unpaywall", "arxiv", "local"])


class RecordOutcomeTest(FetchCase):
    def insert(self, rec_id, state, doi, title):
        con = review.connect(self.dir)
        ts = review.now()
        con.execute(
            "INSERT INTO records (id, import_key, source_db, title, doi, state,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (rec_id, f"key-{rec_id}", "seed", title, doi, state, ts, ts),
        )
        con.commit()
        con.close()

    def record(self, rec_id):
        con = review.connect(self.dir)
        try:
            return con.execute(
                "SELECT * FROM records WHERE id = ?", (rec_id,)
            ).fetchone()
        finally:
            con.close()

    def test_closed_access_ends_not_retrieved_with_reason_no_fabricated_url(self):
        self.insert("r1", "screened_included", "10.1234/closed.9", "Closed Paper")
        work = {"open_access": {"oa_status": "closed"}}
        result, _, _ = self.resolve([("api.openalex.org", work)],
                                    id="r1", project=self.dir)
        self.assertFalse(result["resolved"])
        self.assertIsNone(result["pdf_url"])
        self.assertIsNone(result["pdf_path"])
        row = self.record("r1")
        self.assertEqual(row["state"], "fulltext_not_retrieved")
        self.assertEqual(row["oa_status"], "closed")
        self.assertIn("no open-access copy found", row["exclusion_reason"])
        self.assertIsNone(row["pdf_path"])

    def test_resolved_record_stores_oa_source_and_status(self):
        self.insert("r2", "screened_included", "10.48550/arXiv.2402.00001", "Arxiv Paper")
        result, _, _ = self.resolve([OPENALEX_MISS], id="r2", project=self.dir)
        self.assertTrue(result["resolved"])
        row = self.record("r2")
        self.assertEqual(row["state"], "fulltext_retrieved")
        self.assertEqual(row["oa_source"], "arxiv")
        self.assertEqual(row["oa_status"], "green")


if __name__ == "__main__":
    unittest.main()
