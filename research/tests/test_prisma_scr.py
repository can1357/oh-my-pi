"""prisma_scr.py: counts derived only from record states; all renderers."""
import json
import os
import re
import unittest
import xml.etree.ElementTree as ET

import helpers
import prisma_scr
import review

# Several seeded {state: count} distributions; the arithmetic invariant must
# hold for every one of them, not just a hand-picked happy path.
DISTS = {
    "mixed": {
        "identified": 3, "duplicate": 2, "screened_excluded": 4,
        "screened_included": 1, "fulltext_sought": 1, "fulltext_retrieved": 2,
        "fulltext_not_retrieved": 1, "fulltext_excluded": 2, "included": 5,
    },
    "all_pending": {"identified": 10},
    "all_included": {"included": 7},
    "no_duplicates": {"screened_excluded": 3, "included": 4},
    "empty": {},
}


class PrismaScrCase(helpers.ResearchCase):
    def seed(self, dist, sub="p"):
        pdir = os.path.join(self.dir, sub)
        con = review.connect(pdir)
        self.addCleanup(con.close)
        helpers.seed_review(pdir, dist, con=con)
        return pdir, con

    def derive(self, dist, sub="p"):
        _, con = self.seed(dist, sub)
        return prisma_scr.derive(con)


class DeriveTest(PrismaScrCase):
    def test_arithmetic_invariant_across_distributions(self):
        # identified - duplicates = screened; screened - excluded - pending =
        # sought; sought - not_retrieved - pending = assessed;
        # assessed - ft_excluded - pending = included. Derived from states only.
        for name, dist in DISTS.items():
            with self.subTest(dist=name):
                d = self.derive(dist, sub=name)
                self.assertEqual(d["identified"], sum(dist.values()))
                self.assertEqual(d["identified"] - d["duplicates"], d["screened"])
                self.assertEqual(
                    d["screened"] - d["ta_excluded"] - d["ta_pending"], d["sought"]
                )
                self.assertEqual(
                    d["sought"] - d["not_retrieved"] - d["retrieval_pending"],
                    d["assessed"],
                )
                self.assertEqual(
                    d["assessed"] - d["ft_excluded"] - d["ft_pending"], d["included"]
                )

    def test_counts_match_seeded_states_exactly(self):
        d = self.derive(DISTS["mixed"])
        self.assertEqual(d["duplicates"], 2)
        self.assertEqual(d["ta_excluded"], 4)
        self.assertEqual(d["not_retrieved"], 1)
        self.assertEqual(d["ft_excluded"], 2)
        self.assertEqual(d["included"], 5)
        # 21 total - 2 dupes = 19 screened; 19 - 4 - 3 pending = 12 sought.
        self.assertEqual(d["screened"], 19)
        self.assertEqual(d["sought"], 12)
        self.assertEqual(d["assessed"], 9)


class RenderTest(PrismaScrCase):
    def numbers(self, d):
        return [d["identified"], d["screened"], d["sought"], d["assessed"],
                d["included"]]

    def test_text_render_contains_real_numbers(self):
        d = self.derive(DISTS["mixed"])
        text = prisma_scr.render_text("proj", d)
        self.assertIn(f"Records identified (n={d['identified']})", text)
        self.assertIn(f"Records screened (n={d['screened']})", text)
        self.assertIn(f"Studies included in review (n={d['included']})", text)
        self.assertIn("arithmetic:", text)

    def test_mermaid_render_is_wellformed_flowchart(self):
        d = self.derive(DISTS["mixed"])
        lines = prisma_scr.render_mermaid("proj", d).splitlines()
        self.assertEqual(lines[0], "```mermaid")
        self.assertEqual(lines[1], "flowchart TD")
        self.assertEqual(lines[-1], "```")
        node_re = re.compile(r'^    (\w+)\["[^"]+"\]$')
        edge_re = re.compile(r"^    (\w+) (-->|-\.->) (\w+)$")
        nodes, edges = set(), []
        for line in lines[2:-1]:
            m = node_re.match(line)
            if m:
                nodes.add(m.group(1))
                continue
            m = edge_re.match(line)
            self.assertIsNotNone(m, f"malformed mermaid line: {line!r}")
            edges.append((m.group(1), m.group(3)))
        for a, b in edges:
            self.assertIn(a, nodes)
            self.assertIn(b, nodes)
        # The main flow is a chain through all five stages.
        self.assertTrue({"identified", "screened", "sought", "assessed",
                         "included"} <= nodes)
        body = "\n".join(lines)
        for n in self.numbers(d):
            self.assertIn(f"(n={n})", body)

    def test_svg_render_parses_and_contains_numbers(self):
        d = self.derive(DISTS["mixed"])
        svg = prisma_scr.render_svg("proj", d)
        ET.fromstring(svg)  # well-formed XML or the test fails
        for n in self.numbers(d):
            self.assertIn(f"(n={n})", svg)

    def test_empty_review_renders_zeros_not_crash(self):
        d = self.derive({})
        for fmt, render in (("text", prisma_scr.render_text),
                            ("mermaid", prisma_scr.render_mermaid),
                            ("svg", prisma_scr.render_svg)):
            with self.subTest(fmt=fmt):
                out = render("proj", d)
                self.assertIn("(n=0)", out)


class CliTest(PrismaScrCase):
    def test_cli_renders_each_format_from_db(self):
        pdir, _ = self.seed(DISTS["mixed"])
        for fmt, marker in (("text", "PRISMA-ScR flow"),
                            ("mermaid", "flowchart TD"),
                            ("svg", "<svg")):
            with self.subTest(fmt=fmt):
                code, out, err = helpers.run_cli(
                    prisma_scr, ["--project", pdir, "--format", fmt]
                )
                self.assertEqual(code, 0, f"stderr: {err}")
                self.assertIn(marker, out)
                self.assertIn("(n=21)", out)

    def test_cli_out_writes_file(self):
        pdir, _ = self.seed(DISTS["all_included"])
        path = os.path.join(self.dir, "flow.md")
        code, out, _ = helpers.run_cli(
            prisma_scr, ["--project", pdir, "--format", "mermaid", "--out", path]
        )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"written": path, "format": "mermaid"})
        with open(path, encoding="utf-8") as fh:
            self.assertIn("flowchart TD", fh.read())

    def test_cli_missing_db_fails_with_pointer_to_review(self):
        code, _, err = helpers.run_cli(
            prisma_scr, ["--project", self.dir, "--format", "text"]
        )
        self.assertEqual(code, 1)
        self.assertIn("no review.db", err)


if __name__ == "__main__":
    unittest.main()
