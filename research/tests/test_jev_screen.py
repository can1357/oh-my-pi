"""jev_screen: bands, verdicts through review.py, skips, no-key behavior.

Offline integration: a REAL temp project with a REAL review.db driven by the
REAL review.py CLI (subprocess), with only the network boundary
(jev_screen.jev_call) monkeypatched.
"""
import json
import os
import pathlib
import unittest
from unittest import mock

import helpers
import jev_client
import jev_screen
import review

RECORDS = [
    ("10.1000/a1", "Clear include paper about our population and concept",
     "We study EXACTLY the population described, applying the concept in the required"
     " context, with strong methods."),
    ("10.1000/e1", "Off-topic paper on soil bacteria",
     "This paper studies soil microbiomes; nothing related to the review question."),
    ("10.1000/m1", "Ambiguous middle-band paper",
     "It mentions adjacent topics and one cannot tell whether the population matches."),
    ("10.1000/n1", "No abstract paper", None),
]

CRITERIA = {"population": "Adults in emergency care", "concept": "LLM triage support"}


def make_project(root, name="proj1"):
    """Temp project with the four fixture records imported via review.py."""
    proj = os.path.join(root, name)
    os.makedirs(proj, exist_ok=True)
    entries = []
    for doi, title, abstract in RECORDS:
        lines = ["TY  - JOUR", f"TI  - {title}", f"DO  - {doi}"]
        if abstract:
            lines.append(f"AB  - {abstract}")
        lines.append("ER  - ")
        entries.append("\n".join(lines))
    ris = os.path.join(proj, "in.ris")
    with open(ris, "w", encoding="utf-8") as fh:
        fh.write("\n\n".join(entries) + "\n")
    code, out, err = helpers.run_cli(review, ["--project", proj, "import", "--path", ris])
    assert code == 0, err
    assert json.loads(out)["added"] == len(RECORDS), out
    with open(os.path.join(proj, "criteria.json"), "w", encoding="utf-8") as fh:
        json.dump(CRITERIA, fh)
    return proj


def patch_jev(probs_by_doi):
    """Stand-in for jev_screen.jev_call: scripted probabilities per record."""

    def fake_call(state, questions, api_key, model):
        doi = [l.split(":", 1)[1].strip() for l in state.splitlines() if l.startswith("doi:")][0]
        probs = probs_by_doi[doi]
        assert set(questions) == set(probs), f"asked {sorted(questions)} for {doi}"
        return {"model": "jev-1.13.0",
                "answers": {k: {"type": "noul", "noul": p} for k, p in probs.items()}}

    return fake_call


class JevScreenCase(helpers.ResearchCase):
    def setUp(self):
        super().setUp()
        # Never read the real ~/.research-harness/config.env from a test.
        patcher = mock.patch.object(jev_client, "CONFIG_ENV",
                                    pathlib.Path(self.dir) / "absent.env")
        patcher.start()
        self.addCleanup(patcher.stop)

    def screen(self, proj, probs, *extra):
        with mock.patch.dict(os.environ, {"TYPESAFE_API_KEY": "k1"}), \
                mock.patch.object(jev_screen, "jev_call", patch_jev(probs)), \
                helpers.captured() as (out, err):
            rc = jev_screen.main(["--project", proj, "--criteria",
                                  os.path.join(proj, "criteria.json"), *extra])
        return rc, out.getvalue(), err.getvalue()

    def record(self, proj, rec_id):
        con = review.connect(proj)
        self.addCleanup(con.close)
        return con.execute("SELECT * FROM records WHERE id = ?", (rec_id,)).fetchone()


class JevScreenTest(JevScreenCase):
    def setUp(self):
        super().setUp()
        self.proj = make_project(self.dir)
        self.probs = {
            "10.1000/a1": {"population": 0.97, "concept": 0.95},
            "10.1000/e1": {"population": 0.02, "concept": 0.03},
            "10.1000/m1": {"population": 0.55, "concept": 0.60},
        }

    def test_verdicts_landed_with_provenance(self):
        rc, out, _ = self.screen(self.proj, self.probs)
        self.assertEqual(rc, 0)
        inc = self.record(self.proj, "10.1000/a1")
        exc = self.record(self.proj, "10.1000/e1")
        self.assertEqual(inc["state"], "screened_included")
        self.assertIn("[jev-1.13.0 p=0.95]", inc["ta_rationale"])
        self.assertIn("concept=0.95", inc["ta_rationale"])
        self.assertEqual(inc["ta_confidence"], "HIGH")
        self.assertEqual(exc["state"], "screened_excluded")
        self.assertEqual(exc["exclusion_reason"], "population")
        # A near-zero criterion probability is a CONFIDENT exclusion.
        self.assertEqual(exc["ta_confidence"], "HIGH")
        self.assertIn("judged=2", out)

    def test_middle_band_untouched(self):
        self.screen(self.proj, self.probs)
        mid = self.record(self.proj, "10.1000/m1")
        self.assertEqual(mid["state"], "identified")
        self.assertIsNone(mid["ta_verdict"])

    def test_no_abstract_skipped_not_judged(self):
        _, out, err = self.screen(self.proj, self.probs)
        self.assertEqual(self.record(self.proj, "10.1000/n1")["state"], "identified")
        self.assertIn("no-abstract", out + err)

    def test_dry_run_writes_nothing(self):
        rc, out, _ = self.screen(self.proj, self.probs, "--dry-run")
        self.assertEqual(rc, 0)
        self.assertIn("dry-run", out)
        self.assertEqual(self.record(self.proj, "10.1000/a1")["state"], "identified")

    def test_regression_band_edges(self):
        # exactly at T_INCLUDE must include; exactly at T_EXCLUDE must exclude;
        # one step inside the middle band must stay untouched on both sides.
        cases = [("0.90", "screened_included"), ("0.10", "screened_excluded"),
                 ("0.899", "identified"), ("0.101", "identified")]
        for p, expected in cases:
            with self.subTest(min_p=p):
                proj = make_project(self.dir, f"edge-{p}")
                flat = {doi: {"population": float(p), "concept": float(p)}
                        for doi, _, abstract in RECORDS if abstract}
                rc, _, _ = self.screen(proj, flat)
                self.assertEqual(rc, 0)
                self.assertEqual(self.record(proj, "10.1000/a1")["state"], expected)

    def test_regression_exclude_names_argmin_reason(self):
        # lowest criterion probability must become the exclusion reason
        proj = make_project(self.dir, "argmin")
        probs = dict(self.probs)
        probs["10.1000/e1"] = {"population": 0.40, "concept": 0.01}
        self.screen(proj, probs)
        exc = self.record(proj, "10.1000/e1")
        self.assertEqual(exc["exclusion_reason"], "concept")
        self.assertIn("p=0.01", exc["ta_rationale"])

    def test_no_key_is_silent_success(self):
        env = {k: v for k, v in os.environ.items() if k != "TYPESAFE_API_KEY"}
        with mock.patch.dict(os.environ, env, clear=True), helpers.captured() as (out, err):
            rc = jev_screen.main(["--project", self.proj, "--criteria",
                                  os.path.join(self.proj, "criteria.json")])
        self.assertEqual(rc, 0)
        self.assertIn("OFF", err.getvalue())
        self.assertEqual(self.record(self.proj, "10.1000/a1")["state"], "identified")

    def test_limit_caps_records_judged(self):
        rc, out, _ = self.screen(self.proj, self.probs, "--limit", "1")
        self.assertEqual(rc, 0)
        self.assertIn("judged=1", out)
        self.assertEqual(self.record(self.proj, "10.1000/e1")["state"], "identified")


if __name__ == "__main__":
    unittest.main()
