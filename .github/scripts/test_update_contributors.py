"""Offline behaviour tests for update_contributors.py (stdlib unittest only)."""

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "update_contributors", os.path.join(HERE, "update_contributors.py")
)
uc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(uc)

BEGIN = uc.BEGIN_MARKER
END = uc.END_MARKER


class FakeApi:
    """Scripted (status, body, next_url) responses per path call order."""

    def __init__(self, responses, fail_after=None):
        self.responses = list(responses)
        self.calls = 0
        self.fail_after = fail_after

    def get_json(self, path):
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise uc.ApiError("simulated network failure after page %d" % self.fail_after)
        status, body, nxt = self.responses.pop(0)
        return status, body, nxt


def page(items, nxt=None):
    return 200, items, nxt


class CollectAuthorsTests(unittest.TestCase):
    def test_union_dedup_and_deterministic_order(self):
        contributors = [{"login": "Alice"}, {"login": "bob"}, {"login": "joshuaswarren"}]
        pr_authors = ["bob", "CAROL", "joshuaswarren"]
        out = uc.collect_authors(contributors, pr_authors, "joshuaswarren", set())
        self.assertEqual(out, ["Alice", "bob", "CAROL"])
        again = uc.collect_authors(contributors, pr_authors, "joshuaswarren", set())
        self.assertEqual(out, again)

    def test_bots_owner_and_extra_excluded(self):
        contributors = [
            {"login": "dependabot[bot]"},
            {"login": "github-actions[bot]"},
            {"login": "web-flow"},
            {"login": "joshuaswarren"},
            {"login": "realhuman"},
            {"login": "cursoragent"},
        ]
        pr_authors = ["somebot[bot]", "REALHUMAN", "excludedperson"]
        out = uc.collect_authors(contributors, pr_authors, "joshuaswarren",
                                 {"excludedperson", "cursoragent"})
        self.assertEqual(out, ["realhuman"])

    def test_bot_suffix_case_insensitive(self):
        out = uc.collect_authors([{"login": "Renovate[Bot]"}], ["Web-FLOW"], "joshuaswarren", set())
        self.assertEqual(out, [])


class FetchAllTests(unittest.TestCase):
    def test_multi_page_union(self):
        api = FakeApi([
            page([{"login": "a"}] * 100, "https://x?page=2"),
            page([{"login": "b"}] * 100, "https://x?page=3"),
            page([{"login": "c"}]),
        ])
        items = uc.fetch_all(api.get_json, "repos/o/r/x")
        self.assertEqual(len(items), 201)
        self.assertEqual(items.count({"login": "c"}), 1)

    def test_full_page_without_next_link_is_complete(self):
        api = FakeApi([page([{"login": "a"}] * 100)])
        items = uc.fetch_all(api.get_json, "repos/o/r/x")
        self.assertEqual(len(items), 100)

    def test_http_error_fails_closed(self):
        api = FakeApi([(403, {"message": "rate limited"}, None)])
        with self.assertRaises(uc.ApiError):
            uc.fetch_all(api.get_json, "repos/o/r/x")

    def test_short_page_with_stray_next_link_fails_closed(self):
        api = FakeApi([page([{"login": "a"}], "https://x?page=2")])
        with self.assertRaises(uc.ApiError):
            uc.fetch_all(api.get_json, "repos/o/r/x")


class FileUpdateTests(unittest.TestCase):
    DONOR_FILE = (
        "# Contributors\n\n## Hardware donors\n\n- Alice Mac (donated an M1)\n\n"
        "## Manual credits\n\n- [@someone](https://github.com/someone) for the cable\n\n"
        + BEGIN + "\n\nold\n- [@stale](https://github.com/stale)\n\n" + END + "\n"
    )

    def test_replaces_only_generated_region(self):
        registry = uc.render_registry(["freshface"])
        new_text, changed = uc.update_contributors_md(self.DONOR_FILE, registry)
        self.assertTrue(changed)
        self.assertIn("- Alice Mac (donated an M1)", new_text)
        self.assertIn("- [@someone](https://github.com/someone) for the cable", new_text)
        self.assertNotIn("stale", new_text)
        self.assertIn("freshface", new_text)
        # donor/manual text byte-identical outside the markers
        head_before, _, rest_before = self.DONOR_FILE.partition(BEGIN)
        _, _, tail_before = rest_before.partition(END)
        head_after, _, rest_after = new_text.partition(BEGIN)
        _, _, tail_after = rest_after.partition(END)
        self.assertEqual(head_before, head_after)
        self.assertEqual(tail_before, tail_after)

    def test_second_run_no_change(self):
        block = uc.render_registry(["alice", "Bob"])
        once, changed1 = uc.update_contributors_md(self.DONOR_FILE, block)
        twice, changed2 = uc.update_contributors_md(once, block)
        self.assertTrue(changed1)
        self.assertFalse(changed2)
        self.assertEqual(once, twice)

    def test_deterministic_render(self):
        a = uc.render_registry(["zeta", "Alpha"])
        b = uc.render_registry(["zeta", "Alpha"])
        self.assertEqual(a, b)
        self.assertIn("https://github.com/zeta", a)

    def test_missing_file_creates_full_document(self):
        block = uc.render_registry(["alice"])
        text, changed = uc.update_contributors_md(None, block)
        self.assertTrue(changed)
        self.assertTrue(text.startswith("# Contributors"))
        self.assertIn(BEGIN, text)

    def test_begin_without_end_refuses(self):
        with self.assertRaises(ValueError):
            uc.update_contributors_md("x\n" + BEGIN + "\nno end", "block")

    def test_file_without_markers_is_left_alone(self):
        human = "# Contributors\n\n- [@human](https://github.com/human) curated prose\n"
        text, changed = uc.update_contributors_md(human, "block")
        self.assertFalse(changed)
        self.assertEqual(text, human)


class EndToEndTests(unittest.TestCase):
    def test_main_check_mode_reports_change_without_writing(self):
        api = FakeApi([
            page([{"login": "alice"}]),
            page([{"user": {"login": "joshuaswarren"}, "merged_at": "2026-01-01T00:00:00Z"}]),
            page([{"login": "alice"}]),
            page([{"login": "bob"}]),
        ])
        existing = "x\n" + BEGIN + "\nold\n" + END + "\n"
        rc, _, changed = uc.main(["prog", "--check"], api.get_json, existing_text=existing,
                                 repo="r", owner="joshuaswarren")
        self.assertEqual((rc, changed), (1, True))
        self.assertEqual(api.calls, 2)

    def test_main_failure_exits_nonzero(self):
        api = FakeApi([], fail_after=0)
        with self.assertRaises(uc.ApiError):
            uc.main(["prog"], api.get_json, existing_text=None, repo="r", owner="joshuaswarren")

    def test_main_updates_file(self):
        api = FakeApi([
            page([{"login": "alice"}]),
            page([{"user": {"login": "bob"}, "merged_at": "2026-01-01T00:00:00Z"}]),
        ])
        target = os.path.join(tempfile.mkdtemp(), "CONTRIBUTORS.md")
        rc, text, changed = uc.main(["prog"], api.get_json,
                                    repo="r", owner="joshuaswarren",
                                    contributors_path=target, write_to=target)
        self.assertEqual((rc, changed), (0, True))
        self.assertIn("alice", text)
        self.assertIn("bob", text)
        import contextlib, io
        os.remove(target)




class EnvModeTests(unittest.TestCase):
    """Exercise the real env-driven path (settings, token, emit) offline."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self._old_env = os.environ.copy()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._old_env)

    def test_env_mode_end_to_end(self):
        os.environ["GITHUB_REPOSITORY"] = "joshuaswarren/envrepo"
        os.environ["GITHUB_TOKEN"] = "t0ken"
        os.environ["EXTRA_EXCLUDE"] = "DropIn, "
        os.environ["CONTRIBUTORS_PATH"] = os.path.join(self.dir, "CONTRIBUTORS.md")
        seen_urls = []
        token_seen = []

        def fake_http(url, token):
            seen_urls.append(url)
            token_seen.append(token)
            return 200, [{"login": "envuser"}, {"login": "dropin"}], None

        orig = uc.http_get_json
        uc.http_get_json = fake_http
        try:
            rc, text, changed = uc.main()
        finally:
            uc.http_get_json = orig
        self.assertEqual((rc, changed), (0, True))
        self.assertEqual(len(seen_urls), 2)
        self.assertIn("anon=false", seen_urls[0])
        self.assertIn("state=closed", seen_urls[1])
        self.assertEqual(set(token_seen), {"t0ken"})
        self.assertIn("envuser", text)
        self.assertNotIn("dropin", text)
        with open(os.environ["CONTRIBUTORS_PATH"], encoding="utf-8") as fh:
            self.assertIn("envuser", fh.read())

    def test_env_mode_missing_repository_fails(self):
        os.environ.pop("GITHUB_REPOSITORY", None)
        with self.assertRaises(SystemExit):
            uc.main()

    def test_env_mode_missing_token_fails(self):
        os.environ["GITHUB_REPOSITORY"] = "joshuaswarren/envrepo"
        os.environ.pop("GITHUB_TOKEN", None)
        with self.assertRaises(SystemExit):
            uc.main()

    def test_emit_writes_file_and_reports_change(self):
        import contextlib
        import io
        target = os.path.join(self.dir, "CONTRIBUTORS.md")
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = uc._emit("body", True, target)
        self.assertEqual(rc, 0)
        self.assertIn("CHANGED=true", buffer.getvalue())
        with open(target, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "body")

    def test_emit_without_destination_writes_nothing(self):
        import contextlib
        import io
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = uc._emit("body", False, None)
        self.assertEqual((rc, "CHANGED=false" in buffer.getvalue()), (0, True))

    def test_failed_write_leaves_original_intact(self):
        target = os.path.join(tempfile.mkdtemp(), "CONTRIBUTORS.md")
        original = "donor bytes \r\n- [@keep](https://github.com/keep)\r\n"
        with open(target, "w", encoding="utf-8", newline="") as fh:
            fh.write(original)
        import contextlib, io
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            try:
                uc._emit("replacement", True, os.path.join(target, "not-a-dir"))
            except (OSError, NotADirectoryError):
                pass
            else:
                self.fail("expected the failed write to raise")
        with open(target, "r", encoding="utf-8", newline="") as fh:
            self.assertEqual(fh.read(), original)

    def test_crlf_donor_bytes_survive_regen(self):
        donor_file = (
            "# Contributors\r\n\r\n"
            "## Hardware donors\r\n\r\n"
            "- Alice Mac (donated an M1)\r\n\r\n"
            + BEGIN + "\r\nold-crlf\r\n" + END + "\r\n"
        )
        registry = uc.render_registry(["alice"])
        new_text, changed = uc.update_contributors_md(donor_file, registry)
        self.assertTrue(changed)
        head = new_text.partition(BEGIN)[0]
        tail = new_text.rpartition(END)[2]
        self.assertEqual(head, "# Contributors\r\n\r\n## Hardware donors\r\n\r\n- Alice Mac (donated an M1)\r\n\r\n")
        self.assertEqual(tail, "\r\n")
        self.assertNotIn("old-crlf", new_text)


class RefinementTests(unittest.TestCase):
    def test_http_200_with_non_list_body_fails_closed(self):
        api = FakeApi([(200, {"message": "unexpected object"}, None)])
        with self.assertRaises(uc.ApiError):
            uc.fetch_all(api.get_json, "repos/o/r/x")

    def test_duplicated_begin_marker_refuses(self):
        text = "a\n" + BEGIN + "\n" + BEGIN + "\nmid\n" + END + "\n"
        with self.assertRaises(ValueError):
            uc.update_contributors_md(text, uc.render_registry(["x"]))

    def test_partial_repository_env_fails(self):
        old = os.environ.copy()
        os.environ["GITHUB_REPOSITORY"] = "joshuaswarren/"
        os.environ.pop("GITHUB_TOKEN", None)

        def forbidden(*_args, **_kwargs):
            raise AssertionError("fetch_all must not run for an invalid repository")

        orig = uc.fetch_all
        uc.fetch_all = forbidden
        try:
            with self.assertRaises(SystemExit):
                uc.main()
        finally:
            uc.fetch_all = orig
            os.environ.clear()
            os.environ.update(old)

    def test_cli_check_flag_via_sys_argv(self):
        api = FakeApi([
            page([{"login": "alice"}]),
            page([{"login": "bob"}]),
        ])
        existing = "x\n" + BEGIN + "\nold\n" + END + "\n"
        orig_argv = sys.argv
        sys.argv = ["prog", "--check"]
        try:
            rc, _, _ = uc.main(get_json=api.get_json, existing_text=existing,
                               repo="r", owner="joshuaswarren")
        finally:
            sys.argv = orig_argv
        self.assertEqual(rc, 1)

    def test_check_mode_message_and_zero_rc_when_current(self):
        import contextlib
        import io
        api = FakeApi([
            page([{"login": "alice"}]),
            page([{"user": {"login": "bob"}, "merged_at": "2026-01-01T00:00:00Z"}]),
        ])
        existing = "x\n" + uc.render_registry(["alice", "bob"]) + "\n"
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc, _, changed = uc.main(["prog", "--check"], api.get_json,
                                     existing_text=existing, repo="r", owner="joshuaswarren")
        self.assertEqual((rc, changed), (0, False))
        self.assertIn("registry up to date", buffer.getvalue())

    def test_check_mode_message_reports_drift(self):
        import contextlib
        import io
        api = FakeApi([
            page([{"login": "alice"}]),
            page([{"login": "bob"}]),
        ])
        existing = "x\n" + BEGIN + "\nold\n" + END + "\n"
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc, _, changed = uc.main(["prog", "--check"], api.get_json,
                                     existing_text=existing, repo="r", owner="joshuaswarren")
        self.assertEqual((rc, changed), (1, True))
        self.assertIn("registry drift detected", buffer.getvalue())


class LinkHeaderTests(unittest.TestCase):
    def test_next_link_parsed_from_github_header_format(self):
        header = '<https://api.github.com/repositories/1/contributors?anon=false&per_page=100&page=2>; rel="next", ' \
                 '<https://api.github.com/repositories/1/contributors?anon=false&per_page=100&page=5>; rel="last"'
        self.assertEqual(
            uc._next_link(header),
            "https://api.github.com/repositories/1/contributors?anon=false&per_page=100&page=2",
        )

    def test_next_link_absent(self):
        self.assertIsNone(uc._next_link(None))
        self.assertIsNone(uc._next_link('<https://x?page=1>; rel="prev"'))


class GhostIdentityTests(unittest.TestCase):
    def test_ghost_pr_author_and_blank_login_skipped(self):
        pulls = [
            {"user": {"login": "realone"}, "merged_at": "2026-01-01T00:00:00Z"},
            {"user": None, "merged_at": "2026-01-01T00:00:00Z"},
            {"body": "no user", "merged_at": "2026-01-01T00:00:00Z"},
        ]
        contributors = [{"contributions": 5}, {"login": "realone"}]
        out = uc.collect_authors(contributors, uc._pr_author_logins(pulls), "o", set())
        self.assertEqual(out, ["realone"])

    def test_closed_unmerged_pr_authors_excluded(self):
        pulls = [
            {"user": {"login": "rejected"}, "merged_at": None},
            {"user": {"login": "accepted"}, "merged_at": "2026-01-01T00:00:00Z"},
        ]
        self.assertEqual(uc._pr_author_logins(pulls), [{"login": "accepted"}])

    def test_merged_pr_bot_author_excluded_via_type_field(self):
        pulls = [
            {"user": {"login": "PureBot", "type": "Bot"}, "merged_at": "2026-01-01T00:00:00Z"},
            {"user": {"login": "humanperson"}, "merged_at": "2026-01-02T00:00:00Z"},
        ]
        out = uc.collect_authors([], uc._pr_author_logins(pulls), "o", set())
        self.assertEqual(out, ["humanperson"])


class BotTypeTests(unittest.TestCase):
    def test_api_type_bot_field_excluded(self):
        contributors = [{"login": "ServoBot", "type": "Bot"}, {"login": "NotBot", "type": "User"}]
        out = uc.collect_authors(contributors, [], "o", set())
        self.assertEqual(out, ["NotBot"])

    def test_suffixed_login_without_type_field_excluded(self):
        out = uc.collect_authors([{"login": "someapp[bot]"}], [], "o", set())
        self.assertEqual(out, [])

    def test_registry_states_anonymous_boundary_truthfully(self):
        registry = uc.render_registry(["alice"])
        self.assertIn("enumerable through the API (anon=true)", registry)
        self.assertIn("does not publish", registry)

    def test_real_human_named_claude_not_excluded(self):
        # users/claude is a real person (type User); only actual bot
        # identities (API type or documented [bot] suffix) are excluded.
        out = uc.collect_authors([{"login": "claude", "type": "User"}], [], "o", set())
        self.assertEqual(out, ["claude"])

    def test_agent_account_with_user_type_excluded_only_when_configured(self):
        # agent accounts without bot markers are excluded via per-repo
        # EXTRA_EXCLUDE policy, never by guessing from names.
        out = uc.collect_authors([{"login": "cursoragent", "type": "User"}], [], "o", set())
        self.assertEqual(out, ["cursoragent"])
        out = uc.collect_authors([{"login": "cursoragent", "type": "User"}], [], "o", {"cursoragent"})
        self.assertEqual(out, [])



class MalformedLinkTests(unittest.TestCase):
    def test_malformed_next_segment_returns_none(self):
        self.assertIsNone(uc._next_link('<https://x?page=2; rel="next"'))
        self.assertIsNone(uc._next_link('https://x?page=2> ; rel="next"'))




if __name__ == "__main__":
    unittest.main()


if __name__ == "__main__":
    unittest.main()






if __name__ == "__main__":
    unittest.main()