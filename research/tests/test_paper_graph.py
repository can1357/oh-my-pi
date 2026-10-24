"""paper_graph.py: add/link/neighbors/stats/export round-trip, edge CHECK, view."""
import json
import os
import sqlite3
import unittest

import helpers
import paper_graph


class GraphCase(helpers.ResearchCase):
    """PAPER_GRAPH_DB points into the sandbox (helpers.ResearchCase.setUp)."""

    def cli(self, *argv):
        code, out, err = helpers.run_cli(paper_graph, list(argv))
        return code, out, err

    def seed_triangle(self):
        # a --cites--> b, b --related--> c
        self.cli("add", "--id", "a", "--title", "Alpha Paper on Graphs", "--year", "2023")
        self.cli("add", "--id", "b", "--title", "Beta Paper on Citations", "--year", "2024")
        self.cli("add", "--id", "c", "--title", "Gamma Survey")
        self.cli("link", "a", "b", "--type", "cites")
        self.cli("link", "b", "c", "--type", "related", "--weight", "0.5")


class RoundTripTest(GraphCase):
    def test_add_link_neighbors_stats_export_round_trip(self):
        self.seed_triangle()

        code, out, err = self.cli("stats")
        self.assertEqual(code, 0, f"stderr: {err}")
        self.assertEqual(json.loads(out), {
            "papers": 3,
            "edges": {"cites": 1, "related": 1, "same-topic": 0},
            "total_edges": 2,
        })

        # BFS: depth 1 from a reaches b only; depth 2 adds c via the related edge.
        code, out, _ = self.cli("neighbors", "a", "--depth", "1")
        rows = helpers.json_lines(out)
        self.assertEqual([r["id"] for r in rows], ["b"])
        self.assertEqual(rows[0]["_via"], {"src": "a", "dst": "b", "type": "cites"})

        code, out, _ = self.cli("neighbors", "a", "--depth", "2")
        rows = {r["id"]: r for r in helpers.json_lines(out)}
        self.assertEqual(set(rows), {"b", "c"})
        self.assertEqual(rows["c"]["_depth"], 2)

        path = os.path.join(self.dir, "graph.json")
        code, out, _ = self.cli("export", "--out", path)
        self.assertEqual(json.loads(out), {"exported": path, "format": "json"})
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual({p["id"] for p in data["papers"]}, {"a", "b", "c"})
        self.assertEqual(
            {(e["src"], e["dst"], e["type"]) for e in data["edges"]},
            {("a", "b", "cites"), ("b", "c", "related")},
        )

    def test_add_upserts_without_erasing_fields(self):
        self.cli("add", "--id", "a", "--title", "Alpha", "--year", "2023")
        code, out, _ = self.cli("add", "--id", "a", "--title", "Alpha v2")
        row = json.loads(out)
        self.assertEqual(row["title"], "Alpha v2")
        self.assertEqual(row["year"], 2023)  # COALESCE keeps the old year

    def test_link_auto_creates_stub_nodes(self):
        self.cli("link", "x", "y", "--type", "same-topic")
        code, out, _ = self.cli("get", "x")
        self.assertEqual(json.loads(out)["title"], "")


class EdgeTypeTest(GraphCase):
    def test_db_check_constraint_rejects_invalid_type(self):
        # The CHECK constraint is the last line of defense below argparse.
        conn = paper_graph.connect()
        self.addCleanup(conn.close)
        paper_graph.ensure_stub(conn, "a")
        paper_graph.ensure_stub(conn, "b")
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO edges (src, dst, type) VALUES ('a', 'b', 'contradicts')"
            )

    def test_cli_rejects_invalid_type_with_usage_error(self):
        code, _, err = self.cli("link", "a", "b", "--type", "contradicts")
        self.assertEqual(code, 2)
        self.assertIn("invalid choice", err)


class ViewTest(GraphCase):
    def test_view_renders_known_graph(self):
        self.seed_triangle()
        code, out, err = self.cli("view", "--id", "a", "--depth", "2")
        self.assertEqual(code, 0, f"stderr: {err}")
        lines = out.splitlines()
        self.assertEqual(lines[0], "paper graph: 3 papers, 2 edges (1 cites, 1 related)")
        self.assertIn("a  Alpha Paper on Graphs (2023)  [deg 1]", out)
        self.assertIn("[cites ->] b  Beta Paper on Citations (2024)  [deg 2]", out)
        self.assertIn("[related] c  Gamma Survey  [deg 1]", out)

    def test_view_empty_graph(self):
        code, out, _ = self.cli("view")
        self.assertEqual(code, 0)
        self.assertIn("paper graph: empty", out)


class ExportHtmlTest(GraphCase):
    def test_exported_html_is_self_contained(self):
        self.seed_triangle()
        path = os.path.join(self.dir, "graph.html")
        code, out, err = self.cli("export", "--format", "html", "--out", path)
        self.assertEqual(code, 0, f"stderr: {err}")
        self.assertEqual(json.loads(out), {"exported": path, "format": "html"})
        with open(path, encoding="utf-8") as fh:
            html = fh.read()
        # Viewer must work offline: zero external script/style/import sources.
        for marker in ('src="http', "src='http", 'href="http', "import(",
                       "https://cdn"):
            self.assertNotIn(marker, html)
        # The graph data really is embedded.
        self.assertIn("Alpha Paper on Graphs", html)


if __name__ == "__main__":
    unittest.main()
