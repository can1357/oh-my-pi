import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HEAVY_GATE = "needs.changes.outputs.rust != 'false'"
LIGHT_GATE = "needs.changes.outputs.ci != 'false'"


class CheckCiPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        shutil.copytree(ROOT / ".github", self.tmp / ".github")
        (self.tmp / "scripts").mkdir()
        shutil.copy(ROOT / "scripts/check-ci-paths.py", self.tmp / "scripts/check-ci-paths.py")
        shutil.copy(ROOT / "scripts/ci-macos-objective.sh", self.tmp / "scripts/ci-macos-objective.sh")
        self.ci = self.tmp / ".github/workflows/ci.yml"

    def run_check(self):
        done = subprocess.run(
            [sys.executable, "scripts/check-ci-paths.py"], cwd=self.tmp, capture_output=True, text=True
        )
        return done.returncode, done.stdout + done.stderr

    def mutate_ci(self, old, new, count=1):
        text = self.ci.read_text()
        self.assertEqual(text.count(old), count, old)
        self.ci.write_text(text.replace(old, new))

    def mutate_job_gate(self, name, old, new):
        text = self.ci.read_text()
        start = text.index(f"\n  {name}:\n") + 1
        nxt = text.find("\n  ", start + len(name) + 4)
        while nxt != -1 and text[nxt + 3 : nxt + 4] == " ":
            nxt = text.find("\n  ", nxt + 1)
        end = len(text) if nxt == -1 else nxt
        body = text[start:end]
        self.assertEqual(body.count(old), 1, f"{name}: {old}")
        self.ci.write_text(text[:start] + body.replace(old, new) + text[end:])

    def test_unmodified_tree_passes(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)

    def test_missing_merge_group_trigger_fails(self):
        self.mutate_ci("  merge_group:\n    types: [checks_requested]\n", "")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("merge_group", out)

    def test_merge_group_without_checks_requested_fails(self):
        self.mutate_ci("types: [checks_requested]", "types: [destroyed]")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("checks_requested", out)

    def test_changes_job_without_the_no_pull_request_branch_fails(self):
        self.mutate_ci('if [ -z "$PULL_REQUEST" ]; then', 'if [ -z "$NEVER_SET" ]; then')
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("no pull request number", out)

    def test_heavy_job_gated_on_ci_only_fails(self):
        self.mutate_job_gate("p7_linux", HEAVY_GATE, LIGHT_GATE)
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("p7_linux", out)

    def test_light_job_gated_on_rust_fails(self):
        self.mutate_job_gate("protobuf", LIGHT_GATE, HEAVY_GATE)
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("protobuf", out)

    def test_rust_path_missing_from_ci_paths_fails(self):
        with (self.tmp / ".github/ci-rust-paths.txt").open("a") as handle:
            handle.write("Unlisted/**\n")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("Unlisted/**", out)


    def test_affected_job_without_the_opt_in_variable_fails(self):
        self.mutate_ci("vars.CI_AFFECTED_ONLY == 'true' && ", "")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("CI_AFFECTED_ONLY", out)

    def test_proved_tree_recorded_for_a_narrowed_run_fails(self):
        objective = self.tmp / 'scripts/ci-macos-objective.sh'
        objective.write_text(objective.read_text().replace(' && [ "${AFFECTED_SCOPE:-full}" != subset ]', ''))
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("proved-tree", out)

    def test_affected_job_on_every_event_fails(self):
        self.mutate_ci("github.event_name == 'pull_request' && vars.CI_AFFECTED_ONLY", "vars.CI_AFFECTED_ONLY")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("pull-request only", out)


def step_script(step_name):
    script = (ROOT / 'scripts/ci-macos-objective.sh').read_text()
    return script.split(f'# {step_name}\n', 1)[1].split('\n# ', 1)[0]


class AffectedScopeFallback(unittest.TestCase):
    def run_step(self, step, scope, args=""):
        script = "cargo() { echo \"cargo $*\"; }\n" + step_script(step)
        done = subprocess.run(
            ["bash", "-c", script],
            env={"AFFECTED_SCOPE": scope, "AFFECTED_ARGS": args, "AFFECTED_DOC_ARGS": args, "PATH": "/usr/bin:/bin"},
            capture_output=True,
            text=True,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def test_workspace_tests_run_everything_when_the_job_did_not_run(self):
        for scope in ("", "all", "unexpected"):
            out = self.run_step("Test workspace", scope, "-p omp-x")
            self.assertEqual(out, "cargo nextest run --profile ci --workspace --exclude omp-e2e --locked", scope)

    def test_workspace_tests_run_only_the_selected_crates_for_a_subset(self):
        out = self.run_step("Test workspace", "subset", "-p omp-a -p omp-b")
        self.assertEqual(out, "cargo nextest run --profile ci -p omp-a -p omp-b --locked")

    def test_workspace_tests_run_everything_when_a_subset_has_no_arguments(self):
        out = self.run_step("Test workspace", "subset", "")
        self.assertEqual(out, "cargo nextest run --profile ci --workspace --exclude omp-e2e --locked")

    def test_doctests_skip_when_a_subset_has_no_library_crate(self):
        out = self.run_step("Test doctests", "subset", "")
        self.assertNotIn("cargo", out)
        self.assertIn("skipping", out)

    def test_workspace_tests_skip_when_nothing_is_affected(self):
        out = self.run_step("Test workspace", "none")
        self.assertNotIn("cargo", out)
        self.assertIn("skipping", out)

    def test_doctests_follow_the_same_scope(self):
        self.assertEqual(self.run_step("Test doctests", ""), "cargo test --doc --workspace --exclude omp-e2e --locked")
        self.assertEqual(self.run_step("Test doctests", "subset", "-p omp-a"), "cargo test --doc -p omp-a --locked")
        self.assertIn("skipping", self.run_step("Test doctests", "none"))


if __name__ == "__main__":
    unittest.main()
