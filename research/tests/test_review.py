"""review.py: import, dedupe, state machine, verdicts, confidence, next, stats."""
import argparse
import json
import os
import unittest

import helpers
import review

RIS = """TY  - JOUR
TI  - Alpha Study of Agents
AU  - Kim, Y.
PY  - 2024
DO  - 10.1/alpha
AB  - Alpha abstract.
ER  - 

TY  - JOUR
TI  - Beta Study of Systems
AU  - Aristotle
PY  - 2023
ER  - 
"""


def ns(**kw):
    return argparse.Namespace(**kw)


class ReviewCase(helpers.ResearchCase):
    def setUp(self):
        super().setUp()
        self.con = review.connect(self.dir)
        self.addCleanup(self.con.close)

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def do_import(self, path, database=None):
        with helpers.captured() as (out, err):
            review.cmd_import(self.con, ns(path=path, database=database))
        return json.loads(out.getvalue()), err.getvalue()

    def record(self, rec_id):
        return self.con.execute(
            "SELECT * FROM records WHERE id = ?", (rec_id,)
        ).fetchone()

    def history(self, rec_id):
        return [tuple(r) for r in self.con.execute(
            "SELECT from_state, to_state FROM history WHERE record_id = ? ORDER BY seq",
            (rec_id,),
        )]

    def insert(self, rec_id, state="identified", **fields):
        ts = review.now()
        cols = {"doi": None, "title": f"Title {rec_id}", "abstract": None}
        cols.update(fields)
        self.con.execute(
            "INSERT INTO records (id, import_key, source_db, title, doi, abstract,"
            " state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (rec_id, f"key-{rec_id}", "seed", cols["title"], cols["doi"],
             cols["abstract"], state, ts, ts),
        )
        self.con.commit()
        return self.record(rec_id)


class ImportTest(ReviewCase):
    def test_ris_import_creates_identified_records_with_history(self):
        summary, _ = self.do_import(self.write("s.ris", RIS), database="scopus")
        self.assertEqual(summary, {"source_db": "scopus", "added": 2,
                                   "already_present": 0, "skipped": 0})
        rows = self.con.execute("SELECT * FROM records ORDER BY rowid").fetchall()
        self.assertEqual([r["state"] for r in rows], ["identified", "identified"])
        self.assertEqual(rows[0]["doi"], "10.1/alpha")
        self.assertEqual(rows[0]["authors"], "Kim, Y.")
        for r in rows:
            self.assertEqual(self.history(r["id"]), [(None, "identified")])

    def test_reimport_is_idempotent(self):
        path = self.write("s.ris", RIS)
        self.do_import(path)
        summary, _ = self.do_import(path)
        self.assertEqual(summary["added"], 0)
        self.assertEqual(summary["already_present"], 2)
        total = self.con.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        self.assertEqual(total, 2)

    def test_malformed_entry_skipped_with_note(self):
        broken = RIS + "TY  - JOUR\nAU  - Nobody\nER  - \n"
        summary, err = self.do_import(self.write("b.ris", broken))
        self.assertEqual(summary["added"], 2)
        self.assertEqual(summary["skipped"], 1)
        self.assertIn("no title", err)

    def test_regression_string_authors_not_iterated_as_chars(self):
        # JSONL /find output may carry authors as ONE string; it must not be
        # iterated character by character into "n; e; g; u; l; .; d".
        jsonl = json.dumps({"title": "String Author Paper",
                            "authors": "Nguyen, L. D.", "year": 2025}) + "\n"
        summary, _ = self.do_import(self.write("find.jsonl", jsonl))
        self.assertEqual(summary["added"], 1)
        row = self.con.execute("SELECT * FROM records").fetchone()
        self.assertEqual(row["authors"], "Nguyen, L. D.")


class DedupeTest(ReviewCase):
    def dedupe(self):
        with helpers.captured() as (out, err):
            review.cmd_dedupe(self.con, ns())
        return helpers.json_lines(out.getvalue()), err.getvalue()

    def test_dedupe_by_doi(self):
        self.insert("a", doi="10.1/x", abstract="has one")
        self.insert("b", doi="10.1/x")
        merges, _ = self.dedupe()
        self.assertEqual(merges, [{"duplicate": "b", "survivor": "a", "via": "doi"}])
        self.assertEqual(self.record("b")["state"], "duplicate")
        self.assertEqual(self.record("b")["duplicate_of"], "a")
        self.assertEqual(self.record("a")["state"], "identified")

    def test_dedupe_by_normalized_title_case_and_whitespace(self):
        self.insert("a", title="A Study Of Things!")
        self.insert("b", title="  a study   of things ")
        merges, _ = self.dedupe()
        self.assertEqual(merges[0]["via"], "title")
        self.assertEqual(self.record("b")["state"], "duplicate")

    def test_dedupe_fills_survivor_missing_fields(self):
        # Survivor (already screened) lacks the abstract; the identified twin
        # has it — the merge must carry it over so no metadata is lost.
        self.insert("a", title="Same Title", state="screened_included")
        self.insert("b", title="Same Title", abstract="only the loser had this")
        self.dedupe()
        self.assertEqual(self.record("a")["abstract"], "only the loser had this")
        self.assertEqual(self.record("b")["state"], "duplicate")

    def test_dedupe_never_demotes_screened_records(self):
        self.insert("a", doi="10.1/x")
        self.insert("b", doi="10.1/x", state="screened_included")
        merges, _ = self.dedupe()
        # The screened record wins survivorship; the identified twin is the dup.
        self.assertEqual(merges[0]["survivor"], "b")
        self.assertEqual(merges[0]["duplicate"], "a")
        self.assertEqual(self.record("b")["state"], "screened_included")


class StateMachineTest(ReviewCase):
    def test_every_legal_transition(self):
        n = 0
        for from_state, targets in review.ALLOWED.items():
            for to_state in sorted(targets):
                n += 1
                rec = self.insert(f"r{n}", state=from_state)
                row = review.transition(self.con, rec, to_state, note="t")
                self.assertEqual(row["state"], to_state)
                self.assertEqual(self.history(row["id"]), [(from_state, to_state)])

    def test_illegal_transitions_rejected(self):
        cases = [
            ("identified", "included"),
            ("duplicate", "identified"),
            ("included", "screened_excluded"),
            ("screened_excluded", "fulltext_sought"),
            ("fulltext_not_retrieved", "included"),
        ]
        for i, (from_state, to_state) in enumerate(cases):
            with self.subTest(edge=f"{from_state}->{to_state}"):
                rec = self.insert(f"x{i}", state=from_state)
                with helpers.captured() as (out, err):
                    with self.assertRaises(SystemExit) as ctx:
                        review.transition(self.con, rec, to_state)
                self.assertEqual(ctx.exception.code, 1)
                self.assertIn("illegal transition", err.getvalue())
                self.assertEqual(self.record(rec["id"])["state"], from_state)
                self.assertEqual(self.history(rec["id"]), [])


class VerdictTest(ReviewCase):
    def verdict(self, rec_id, stage, verdict, rationale="because",
                confidence=None, reason=None):
        with helpers.captured() as (out, err):
            review.cmd_verdict(self.con, ns(
                id=rec_id, stage=stage, verdict=verdict, rationale=rationale,
                confidence=confidence, reason=reason,
            ))
        return json.loads(out.getvalue()), err.getvalue()

    def test_ta_maybe_records_verdict_without_moving_state(self):
        self.insert("a")
        row, _ = self.verdict("a", "ta", "maybe", confidence="LOW")
        self.assertEqual(row["state"], "identified")
        self.assertEqual(row["ta_verdict"], "maybe")
        self.assertEqual(row["ta_confidence"], "LOW")
        self.assertEqual(self.history("a"), [])

    def test_ta_include_and_exclude(self):
        self.insert("inc")
        self.insert("exc")
        row, _ = self.verdict("inc", "ta", "include", confidence="HIGH")
        self.assertEqual(row["state"], "screened_included")
        row, _ = self.verdict("exc", "ta", "exclude", reason="wrong population")
        self.assertEqual(row["state"], "screened_excluded")
        self.assertEqual(row["exclusion_reason"], "wrong population")

    def test_ft_maybe_banned(self):
        self.insert("a", state="fulltext_retrieved")
        with helpers.captured() as (out, err):
            with self.assertRaises(SystemExit) as ctx:
                review.cmd_verdict(self.con, ns(
                    id="a", stage="ft", verdict="maybe", rationale="?",
                    confidence=None, reason=None,
                ))
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("banned", err.getvalue())

    def test_ft_include_from_screened_included_leaves_honest_history(self):
        self.insert("a", state="screened_included")
        row, _ = self.verdict("a", "ft", "include")
        self.assertEqual(row["state"], "included")
        self.assertEqual(
            [h[1] for h in self.history("a")],
            ["fulltext_sought", "fulltext_retrieved", "included"],
        )

    def test_ft_exclude_records_reason(self):
        self.insert("a", state="fulltext_retrieved")
        row, _ = self.verdict("a", "ft", "exclude", reason="no outcomes reported")
        self.assertEqual(row["state"], "fulltext_excluded")
        self.assertEqual(row["ft_verdict"], "exclude")
        self.assertEqual(row["exclusion_reason"], "no outcomes reported")

    def test_ta_verdict_rejected_past_ta_stage(self):
        self.insert("a", state="fulltext_retrieved")
        with helpers.captured() as (out, err):
            with self.assertRaises(SystemExit):
                review.cmd_verdict(self.con, ns(
                    id="a", stage="ta", verdict="include", rationale="late",
                    confidence=None, reason=None,
                ))
        self.assertIn("past title/abstract stage", err.getvalue())


class ConfidenceTest(ReviewCase):
    def test_labels_case_insensitive(self):
        for raw, want in (("HIGH", "HIGH"), ("high", "HIGH"), ("Medium", "MEDIUM"),
                          ("low", "LOW")):
            self.assertEqual(review.parse_confidence(raw), want)

    def test_float_back_compat_maps_to_labels(self):
        for raw, want in (("0.9", "HIGH"), ("0.8", "HIGH"), ("0.5", "MEDIUM"),
                          ("0.2", "LOW")):
            self.assertEqual(review.parse_confidence(raw), want)

    def test_garbage_fails_loudly(self):
        for bad in ("banana", "very high", "1.5", "-0.1"):
            with self.assertRaises(argparse.ArgumentTypeError):
                review.parse_confidence(bad)

    def test_regression_confidence_accepts_labels(self):
        # argparse used to declare type=float, rejecting the documented
        # HIGH/MEDIUM/LOW labels from SCREENING.md. Must work end to end.
        self.insert("a")
        code, out, err = helpers.run_cli(review, [
            "--project", self.dir, "verdict", "--id", "a", "--stage", "ta",
            "--verdict", "include", "--rationale", "meets criteria",
            "--confidence", "HIGH",
        ])
        self.assertEqual(code, 0, f"stderr: {err}")
        self.assertEqual(self.record("a")["ta_confidence"], "HIGH")
        self.assertEqual(self.record("a")["state"], "screened_included")

    def test_cli_float_confidence_still_accepted(self):
        self.insert("a")
        code, _, err = helpers.run_cli(review, [
            "--project", self.dir, "verdict", "--id", "a", "--stage", "ta",
            "--verdict", "include", "--rationale", "ok", "--confidence", "0.9",
        ])
        self.assertEqual(code, 0, f"stderr: {err}")
        self.assertEqual(self.record("a")["ta_confidence"], "HIGH")

    def test_cli_garbage_confidence_exits_with_usage_error(self):
        self.insert("a")
        code, _, err = helpers.run_cli(review, [
            "--project", self.dir, "verdict", "--id", "a", "--stage", "ta",
            "--verdict", "include", "--rationale", "ok", "--confidence", "banana",
        ])
        self.assertEqual(code, 2)
        self.assertIn("invalid confidence", err)


class NextTest(ReviewCase):
    def next_ids(self, stage, n=10):
        with helpers.captured() as (out, err):
            review.cmd_next(self.con, ns(stage=stage, n=n))
        return [r["id"] for r in helpers.json_lines(out.getvalue())]

    def test_next_ta_returns_unscreened_only(self):
        self.insert("a")
        self.insert("b")
        self.insert("c", state="screened_included")
        self.assertEqual(self.next_ids("ta"), ["a", "b"])
        review.cmd_verdict(self.con, ns(id="a", stage="ta", verdict="maybe",
                                        rationale="?", confidence=None, reason=None))
        self.assertEqual(self.next_ids("ta"), ["b"])

    def test_next_ft_returns_screened_in_without_ft_verdict(self):
        self.insert("a", state="screened_included")
        self.insert("b", state="fulltext_retrieved")
        self.insert("c")
        self.assertEqual(self.next_ids("ft"), ["a", "b"])

    def test_next_respects_limit(self):
        for i in range(5):
            self.insert(f"r{i}")
        self.assertEqual(len(self.next_ids("ta", n=3)), 3)


class StatsTest(ReviewCase):
    def test_stats_shape_and_counts(self):
        helpers.seed_review(self.dir, {
            "identified": 2, "duplicate": 1, "screened_excluded": 1, "included": 1,
        }, con=self.con)
        with helpers.captured() as (out, err):
            review.cmd_stats(self.con, ns())
        stats = json.loads(out.getvalue())
        self.assertEqual(
            sorted(stats),
            ["by_source", "by_state", "ft_exclusion_reasons", "not_retrieved_reasons",
             "ta_exclusion_reasons", "ta_maybe", "total"],
        )
        self.assertEqual(stats["total"], 5)
        self.assertEqual(sorted(stats["by_state"]), sorted(review.STATES))
        self.assertEqual(stats["by_state"]["identified"], 2)
        self.assertEqual(stats["by_state"]["duplicate"], 1)
        self.assertEqual(stats["by_source"], {"seed": 5})
        self.assertEqual(stats["ta_maybe"], 0)


if __name__ == "__main__":
    unittest.main()
