"""Contract tests for ai-resolve.sh (mid-rebase), check-sync-markers.sh and sync-pr-body.sh.

Offline: fixture repos from test_sync_upstream.Fixture; `omp` is a stub on PATH
whose behavior is picked by STUB_MODE, so every guard branch runs for real inside
a real stopped rebase driven by sync-upstream.sh.
Run: python3 -m unittest discover -s .github/tests -v
"""

import os
import stat
import subprocess
import tempfile
import textwrap
import unittest

from test_sync_upstream import SCRIPTS, Fixture, git

CHECK_MARKERS = os.path.join(SCRIPTS, "check-sync-markers.sh")
PR_BODY = os.path.join(SCRIPTS, "sync-pr-body.sh")
KEY = "user_test_key_123"

# Stub agent. cwd = fork worktree, mid-rebase. Resolves every listed target.
STUB_OMP = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import os, subprocess, sys
    open(os.environ["STUB_LOG"], "a").write("called\\n")
    mode = os.environ["STUB_MODE"]
    report = os.environ["SYNC_REPORT_DIR"]
    files = [l.strip() for l in open(os.path.join(report, "ai-targets.txt")) if l.strip()]
    def put(path, text):
        with open(path, "w") as f:
            f.write(text)
    for p in files:
        if mode == "partial":
            put(p, "agent note\\n" + open(p).read())  # markers survive
        elif mode == "leak":
            put(p, "resolved " + os.environ["COMMAND_CODE_API_KEY"] + "\\n")
        else:
            put(p, "resolved " + p + "\\n")
    if mode == "stray":
        put("README.md", "agent was here\\n")
        put("scratch.txt", "tmp\\n")
    if mode == "commit":
        subprocess.run(["git", "add", "-A"], check=True)
        subprocess.run(["git", "commit", "-qm", "agent commit"], check=True)
    sys.exit(3 if mode == "fail" else 0)
    """
)


class AiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self._tmp.name)
        self.old = self.fx.origin_ref("main")
        self.bin = os.path.join(self._tmp.name, "bin")
        os.makedirs(self.bin)
        stub = os.path.join(self.bin, "omp")
        with open(stub, "w") as f:
            f.write(STUB_OMP)
        os.chmod(stub, os.stat(stub).st_mode | stat.S_IEXEC)
        self.log = os.path.join(self._tmp.name, "omp-calls")
        # upstream edits the line the fork's branding commit edits -> one conflict
        self.fx.commit(self.fx.upstream, "src/app.txt", "app v2\n", "upstream edits app")

    def tearDown(self):
        self._tmp.cleanup()

    def sync_ai(self, mode, key=KEY):
        return self.fx.sync(
            f"PATH={self.bin}:{os.environ['PATH']}",
            f"STUB_MODE={mode}",
            f"STUB_LOG={self.log}",
            "SYNC_AI_MODEL=commandcode/stub-model",
            f"COMMAND_CODE_API_KEY={key}",
        )

    def tip(self, path):
        return git("-C", self.fx.fork, "show", f"sync/rebase:{path}")

    def test_clean_resolution_lands_in_the_stack_commit_and_runs_gate(self):
        self.sync_ai("ok")
        r = self.fx.result()
        self.assertEqual((r["STATUS"], r["K"], r["U"]), ("conflicts", "1", "0"))
        self.assertEqual(self.tip("src/app.txt"), "resolved src/app.txt\n")
        self.assertTrue(os.path.exists(self.fx.gate_ran))
        subjects = git("-C", self.fx.fork, "log", "--format=%s", "upstream/main..sync/rebase").split("\n")[:-1]
        self.assertEqual(subjects, ["fork: branding", "research: add research layer"])

    def test_out_of_scope_edits_and_new_files_are_dropped(self):
        self.sync_ai("stray")
        self.assertEqual(self.tip("README.md"), "upstream readme v1\n")
        self.assertNotIn("scratch.txt", git("-C", self.fx.fork, "ls-tree", "-r", "--name-only", "sync/rebase"))
        self.assertEqual(self.fx.result()["U"], "0")

    def test_partial_resolution_keeps_original_markers(self):
        self.sync_ai("partial")
        self.assertEqual(self.fx.result()["U"], "1")
        content = self.tip("src/app.txt")
        self.assertIn("<<<<<<<", content)
        self.assertNotIn("agent note", content)

    def test_omp_failure_keeps_markers(self):
        self.sync_ai("fail")
        self.assertEqual(self.fx.result()["U"], "1")
        self.assertIn("<<<<<<<", self.tip("src/app.txt"))

    def test_leaked_key_never_committed(self):
        self.sync_ai("leak")
        self.assertEqual(self.fx.result()["U"], "1")
        self.assertNotIn(KEY, self.tip("src/app.txt"))

    def test_agent_commit_does_not_add_a_stack_commit(self):
        self.sync_ai("commit")
        subjects = git("-C", self.fx.fork, "log", "--format=%s", "upstream/main..sync/rebase").split("\n")[:-1]
        self.assertEqual(subjects, ["fork: branding", "research: add research layer"])
        self.assertEqual(self.tip("src/app.txt"), "resolved src/app.txt\n")

    def test_missing_key_skips_without_calling_omp(self):
        self.sync_ai("ok", key="")
        self.assertFalse(os.path.exists(self.log))
        self.assertEqual(self.fx.result()["U"], "1")

    def test_pr_body_carries_lease_sha_and_conflict_rows(self):
        self.sync_ai("partial")
        out = subprocess.run(["bash", PR_BODY], cwd=self.fx.fork, env=self.fx.env(), capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        with open(os.path.join(self.fx.report, "pr-body.md")) as f:
            body = f.read()
        self.assertIn(f"<!-- fork-sync-old: {self.old} -->", body.splitlines()[0])
        self.assertIn("| `src/app.txt` | fork: branding | **UNRESOLVED** |", body)
        self.assertIn("fork: branding", body.split("range-diff")[1])


class MarkerGuardTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self._tmp.name)
        git("-C", self.fx.fork, "fetch", "-q", "upstream")

    def tearDown(self):
        self._tmp.cleanup()

    def check(self):
        return subprocess.run(["bash", CHECK_MARKERS], cwd=self.fx.fork, capture_output=True, text=True)

    def test_markers_in_stack_file_fail(self):
        self.fx.commit(self.fx.fork, "src/app.txt", "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n", "fork: bad resolve")
        out = self.check()
        self.assertEqual(out.returncode, 1)
        self.assertIn("src/app.txt:1:", out.stdout)

    def test_markers_in_upstream_only_file_ignored(self):
        self.fx.commit(self.fx.upstream, "fixtures/conflict.txt", "<<<<<<< HEAD\na\n>>>>>>> x\n", "upstream fixture")
        git("-C", self.fx.fork, "pull", "-q", "--rebase", "upstream", "main")
        self.assertEqual(self.check().returncode, 0)


if __name__ == "__main__":
    unittest.main()
