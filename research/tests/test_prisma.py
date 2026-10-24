"""prisma.py legacy ledger: identify/dedupe/exclude/include/show, reconciliation."""
import json
import os
import unittest

import helpers
import prisma


class PrismaCase(helpers.ResearchCase):
    def cli(self, *argv):
        return helpers.run_cli(prisma, ["--project", self.dir, *argv])

    def ledger(self):
        with open(os.path.join(self.dir, "prisma.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def show(self):
        code, out, err = self.cli("show")
        self.assertEqual(code, 0, f"stderr: {err}")
        lines = out.strip().splitlines()
        # Human block first, one machine-readable JSON line last.
        return "\n".join(lines[:-1]), json.loads(lines[-1])


class LedgerTest(PrismaCase):
    def test_identify_per_database_counts_sum(self):
        self.cli("identify", "--database", "openalex", "--count", "60")
        code, _, err = self.cli("identify", "--database", "arxiv", "--count", "40")
        self.assertEqual(code, 0, f"stderr: {err}")
        self.assertEqual(self.ledger()["identified"],
                         {"openalex": 60, "arxiv": 40})
        text, summary = self.show()
        self.assertEqual(summary["identified"], 100)
        self.assertIn("openalex: 60", text)

    def test_identify_updates_existing_database(self):
        self.cli("identify", "--database", "openalex", "--count", "60")
        self.cli("identify", "--database", "openalex", "--count", "55")
        self.assertEqual(self.ledger()["identified"], {"openalex": 55})

    def test_exclude_and_include_persist(self):
        self.cli("exclude", "--reason", "wrong population", "--count", "7")
        self.cli("include", "--count", "3")
        data = self.ledger()
        self.assertEqual(data["excluded"], {"wrong population": 7})
        self.assertEqual(data["included"], 3)

    def test_regression_dedupe_count_persists(self):
        # `dedupe --count N` used to be silently ignored: duplicates_removed
        # stayed 0 and screened never shrank.
        self.cli("identify", "--database", "openalex", "--count", "10")
        code, _, err = self.cli("dedupe", "--count", "4")
        self.assertEqual(code, 0, f"stderr: {err}")
        self.assertEqual(self.ledger()["duplicates_removed"], 4)
        _, summary = self.show()
        self.assertEqual(summary["duplicates_removed"], 4)
        self.assertEqual(summary["screened"], 6)


class ReconciliationTest(PrismaCase):
    def seed(self, included):
        self.cli("identify", "--database", "openalex", "--count", "10")
        self.cli("dedupe", "--count", "2")
        self.cli("exclude", "--reason", "off-topic", "--count", "5")
        self.cli("include", "--count", str(included))

    def test_warning_when_counts_do_not_add_up(self):
        self.seed(included=2)  # 2 + 5 != 8 screened
        text, _ = self.show()
        self.assertIn("WARNING", text)
        self.assertIn("screened = 8", text)

    def test_no_warning_when_counts_reconcile(self):
        self.seed(included=3)  # 3 + 5 == 8 screened
        text, _ = self.show()
        self.assertNotIn("WARNING", text)


class DedupeRecordsTest(PrismaCase):
    def test_jsonl_dedupe_by_doi_and_title_reports_bad_lines(self):
        path = os.path.join(self.dir, "records.jsonl")
        rows = [
            {"doi": "10.1/A", "title": "First Paper"},
            {"doi": "https://doi.org/10.1/a", "title": "First Paper Copy"},
            {"title": "Same   Title!"},
            {"title": "same title"},
            {"title": "Unique Paper"},
        ]
        with open(path, "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
            fh.write("{not json}\n")
        code, out, err = self.cli("dedupe", "--path", path)
        self.assertEqual(code, 0)
        kept = [json.loads(l) for l in out.splitlines() if l.startswith("{")
                and "duplicates_removed" not in l]
        self.assertEqual([r["title"] for r in kept],
                         ["First Paper", "Same   Title!", "Unique Paper"])
        self.assertIn("skipped bad JSON line", err)
        self.assertEqual(self.ledger()["duplicates_removed"], 2)

    def test_missing_path_fails_loudly(self):
        code, _, err = self.cli("dedupe", "--path", os.path.join(self.dir, "nope.jsonl"))
        self.assertEqual(code, 1)
        self.assertIn("cannot read", err)


if __name__ == "__main__":
    unittest.main()
