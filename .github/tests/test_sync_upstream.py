"""Contract tests for sync-upstream.sh + sync-push.sh (and the shared Fixture).

Offline: every test builds tiny fixture git repos in a temp dir and runs the
REAL scripts against them. No network, no writes outside the temp dir.
Run: python3 -m unittest discover -s .github/tests -v
"""

import os
import subprocess
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPTS = os.path.join(REPO_ROOT, ".github", "scripts")
SYNC = os.path.join(SCRIPTS, "sync-upstream.sh")
PUSH = os.path.join(SCRIPTS, "sync-push.sh")


class Fixture:
    """upstream repo + origin(bare) + fork clone carrying a 2-commit fork stack.

    The fork runs the real scripts from REPO_ROOT; its gate is a stub (SYNC_GATE)
    so the real research suite never recurses into these fixtures.
    """

    def __init__(self, tmp):
        self.tmp = tmp
        self.upstream = os.path.join(tmp, "upstream")
        self.origin = os.path.join(tmp, "origin.git")
        self.fork = os.path.join(tmp, "fork")
        self.report = os.path.join(tmp, "report")
        self.gate_ran = os.path.join(tmp, "gate-ran")
        git("init", "-q", self.upstream, "-b", "main")
        self.commit(self.upstream, "README.md", "upstream readme v1\n", "upstream base")
        self.commit(self.upstream, "src/app.txt", "app v1\n", "upstream app")
        git("init", "-q", "--bare", self.origin, "-b", "main")
        git("clone", "-q", self.upstream, self.fork)
        git("-C", self.fork, "remote", "rename", "origin", "upstream")
        git("-C", self.fork, "remote", "add", "origin", self.origin)
        self.commit(self.fork, "research/tool.txt", "research layer\n", "research: add research layer")
        self.commit(self.fork, "src/app.txt", "app v1\nfork branding\n", "fork: branding")
        git("-C", self.fork, "push", "-q", "origin", "main")

    def commit(self, repo, path, content, msg):
        full = os.path.join(repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(content)
        git("-C", repo, "add", path)
        git("-C", repo, "commit", "-q", "-m", msg)
        return git("-C", repo, "rev-parse", "HEAD").strip()

    def env(self, *extra):
        env = dict(os.environ)
        env.pop("COMMAND_CODE_API_KEY", None)  # the developer's shell may export a real key
        env.update(
            IDENTITY,
            UPSTREAM_URL=self.upstream,
            SYNC_REPORT_DIR=self.report,
            SYNC_GATE=f"touch {self.gate_ran}",
        )
        for kv in extra:
            k, v = kv.split("=", 1)
            env[k] = v
        return env

    def run(self, script, *extra):
        return subprocess.run(
            ["bash", script], cwd=self.fork, env=self.env(*extra), capture_output=True, text=True, timeout=120
        )

    def sync(self, *extra):
        out = self.run(SYNC, *extra)
        assert out.returncode == 0, out.stdout + out.stderr
        return out

    def result(self):
        with open(os.path.join(self.report, "result.env")) as f:
            return dict(line.strip().split("=", 1) for line in f if "=" in line)

    def origin_ref(self, ref):
        out = subprocess.run(["git", "-C", self.origin, "rev-parse", "--verify", "-q", ref], capture_output=True, text=True)
        return out.stdout.strip() or None

    def origin_show(self, ref, path):
        return git("-C", self.origin, "show", f"{ref}:{path}")

    def stack_subjects(self, ref):
        up = git("-C", self.upstream, "rev-parse", "main").strip()
        return git("-C", self.origin, "log", "--format=%s", f"{up}..{ref}").split("\n")[:-1]


# Fresh CI runners have no global git identity; fixture commits need one.
IDENTITY = {
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def git(*args):
    env = {**os.environ, **IDENTITY}
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True, env=env).stdout


class SyncTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self._tmp.name)
        self.old = self.fx.origin_ref("main")

    def tearDown(self):
        self._tmp.cleanup()

    def test_up_to_date_changes_nothing(self):
        self.assertIn("UP-TO-DATE", self.fx.sync().stdout)
        self.assertIn("UP-TO-DATE", self.fx.run(PUSH).stdout)
        self.assertEqual(self.fx.origin_ref("main"), self.old)
        self.assertIsNone(self.fx.origin_ref("main-prev"))

    def test_clean_rebase_promotes_main_onto_upstream_tip(self):
        tip = self.fx.commit(self.fx.upstream, "src/other.txt", "new\n", "upstream other")
        self.fx.sync()
        self.assertEqual(self.fx.result()["STATUS"], "clean")
        self.assertTrue(os.path.exists(self.fx.gate_ran))
        out = self.fx.run(PUSH)
        self.assertIn("PROMOTED", out.stdout, out.stderr)
        main = self.fx.origin_ref("main")
        self.assertEqual(git("-C", self.fx.origin, "merge-base", main, tip).strip(), tip)
        self.assertEqual(self.fx.stack_subjects("main"), ["fork: branding", "research: add research layer"])
        self.assertEqual(self.fx.origin_ref("main-prev"), self.old)

    def test_failing_gate_stages_instead_of_promoting(self):
        self.fx.commit(self.fx.upstream, "src/other.txt", "new\n", "upstream other")
        self.fx.sync("SYNC_GATE=false")
        self.assertEqual(self.fx.result()["TESTS"], "fail")
        self.assertIn("STAGED", self.fx.run(PUSH).stdout)
        self.assertEqual(self.fx.origin_ref("main"), self.old)
        self.assertIsNotNone(self.fx.origin_ref("sync/rebase"))

    def test_conflict_without_ai_commits_markers_to_sync_branch(self):
        self.fx.commit(self.fx.upstream, "src/app.txt", "app v2\n", "upstream edits app")
        self.fx.sync()
        r = self.fx.result()
        self.assertEqual((r["STATUS"], r["K"], r["U"], r["TESTS"]), ("conflicts", "1", "1", "skipped"))
        self.assertIn("STAGED", self.fx.run(PUSH).stdout)
        self.assertEqual(self.fx.origin_ref("main"), self.old)
        self.assertIn("<<<<<<<", self.fx.origin_show("sync/rebase", "src/app.txt"))
        self.assertEqual(self.fx.stack_subjects("sync/rebase"), ["fork: branding", "research: add research layer"])

    def test_main_moved_mid_run_is_never_overwritten(self):
        self.fx.commit(self.fx.upstream, "src/other.txt", "new\n", "upstream other")
        self.fx.sync()
        # a human pushes to main between the rebase and the push
        human = os.path.join(self.fx.tmp, "human")
        git("clone", "-q", self.fx.origin, human)
        concurrent = self.fx.commit(human, "notes.txt", "mine\n", "human commit")
        git("-C", human, "push", "-q", "origin", "main")
        out = self.fx.run(PUSH)
        self.assertNotEqual(out.returncode, 0)
        self.assertEqual(self.fx.origin_ref("main"), concurrent)


if __name__ == "__main__":
    unittest.main()
